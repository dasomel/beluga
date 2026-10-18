// D-MSSO-8: the server-enforced edit contract. Pure functions: base YAML text + patch -> edited text, or a
// ChangeRejection (HTTP 422). The client never supplies a document; it supplies {endpoint, allowedGroups} only.
import crypto from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { createTwoFilesPatch } from "diff";
import yaml, { isMap, isScalar, isSeq, Scalar, YAMLSeq } from "yaml";
import { allowedGroupSchema, rawSsoFileSchema, resolveSsoFile } from "../schema/sso.js";

// D-MSSO-8 invariant 4: the target path and the editable endpoints are server constants. Clients cannot choose
// either. Opening another endpoint is a design change (ADR-0009), not a configuration change.
export const SSO_FILE_PATH = "gitops/values/sso.yaml";
export const EDITABLE_ENDPOINTS: readonly string[] = ["flink", "filer"];
export const REQUIRED_GROUP = "admins";

export type RejectionCode = "PATCH_REJECTED" | "NO_EFFECTIVE_CHANGE";

export class ChangeRejection extends Error {
  constructor(
    public readonly code: RejectionCode,
    message: string,
  ) {
    super(message);
    this.name = "ChangeRejection";
  }
}

export interface Patch {
  endpoint: string;
  allowedGroups: unknown[];
}

export interface BuiltChange {
  endpoint: string;
  /** null = the field was absent (no group check). */
  before: string[] | null;
  after: string[];
  editedText: string;
  diff: string;
  payloadSha256: string;
}

// D-MSSO-9 payload identity: sha256 of canonical JSON {endpoint, allowedGroups} with the list order AS SUBMITTED.
// Order is kept because it is what lands in the file; so a replay with the same set in another order is a
// different payload (IDEMPOTENCY_MISMATCH), while the no-op check (below) compares SETS. Cost: a client that
// re-sorts between retries must also use a new key. Escape hatch: sort here, at the price of the file order
// no longer being the submitted one.
// `reason` is intentionally NOT part of the hash: it is free text for the PR body and the audit row, not the change.
// A replay with the same key and payload but a different reason therefore returns the original record unchanged.
export function payloadSha256(patch: { endpoint: string; allowedGroups: unknown[] }): string {
  return crypto.createHash("sha256").update(JSON.stringify({ endpoint: patch.endpoint, allowedGroups: patch.allowedGroups })).digest("hex");
}

function reject(message: string): never {
  throw new ChangeRejection("PATCH_REJECTED", message);
}

// D-MSSO-8 invariants 1-3 (the file-level invariant 4 is checked after the edit).
export function validatePatch(patch: Patch, knownGroups: readonly string[]): string[] {
  if (!EDITABLE_ENDPOINTS.includes(patch.endpoint)) {
    reject(`endpoint: "${patch.endpoint}" is not editable (allowed: ${EDITABLE_ENDPOINTS.join(", ")})`);
  }
  const list = patch.allowedGroups;
  if (!Array.isArray(list) || list.length === 0) reject("allowedGroups: must be a non-empty list");
  const groups: string[] = [];
  list.forEach((entry, i) => {
    if (typeof entry !== "string") reject(`allowedGroups[${i}]: must be a string`);
    if (!allowedGroupSchema.safeParse(entry).success) reject(`allowedGroups[${i}]: "${entry}" must match [a-z0-9-]+`);
    if (!knownGroups.includes(entry)) reject(`allowedGroups[${i}]: unknown group "${entry}" (not in policies/groups.yaml)`);
    groups.push(entry);
  });
  if (new Set(groups).size !== groups.length) reject("allowedGroups: must not contain duplicates");
  if (!groups.includes(REQUIRED_GROUP)) reject(`allowedGroups: must include "${REQUIRED_GROUP}" (anti lock-out)`);
  return groups;
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((x) => b.includes(x));
}

/**
 * Builds the edited file. Guarantees, each enforced by a check below (not by trust in the YAML library):
 *  - the base text round-trips unchanged through the Document API, so the diff contains only our edit;
 *  - base and edited both satisfy the raw sso.yaml schema and the resolved semantic schema;
 *  - the ONLY difference between the two parsed documents is allowedGroups of the one endpoint.
 */
export function buildChange(input: { baseText: string; baseDomain: string; groupNames: readonly string[]; patch: Patch }): BuiltChange {
  const { baseText, baseDomain, patch } = input;
  const after = validatePatch(patch, input.groupNames);

  const doc = yaml.parseDocument(baseText);
  if (doc.errors.length > 0) reject("base sso.yaml is not valid YAML");
  const baseObj: unknown = doc.toJS();
  const baseParsed = rawSsoFileSchema.safeParse(baseObj);
  if (!baseParsed.success) reject("base sso.yaml does not satisfy the SSO schema");

  const endpointObj = baseParsed.data.sso.endpoints.find((e) => e.name === patch.endpoint);
  if (endpointObj === undefined) reject(`endpoint: "${patch.endpoint}" does not exist in sso.yaml`);
  const before = endpointObj.allowedGroups ?? null;
  if (before !== null && sameSet(before, after)) {
    throw new ChangeRejection("NO_EFFECTIVE_CHANGE", "allowedGroups is unchanged (same set of groups)");
  }

  // lineWidth 0: never re-wrap lines. Round trip must be byte-identical or we refuse (we cannot promise a minimal diff).
  const render = (d: yaml.Document): string => d.toString({ lineWidth: 0 });
  if (render(yaml.parseDocument(baseText)) !== baseText) {
    reject("sso.yaml formatting cannot be preserved by the editor; refusing to rewrite it");
  }

  const endpoints = doc.getIn(["sso", "endpoints"]);
  if (!isSeq(endpoints)) reject("sso.endpoints is not a list");
  const node = endpoints.items.find((item) => isMap(item) && item.get("name") === patch.endpoint);
  if (!isMap(node)) reject(`endpoint: "${patch.endpoint}" does not exist in sso.yaml`);
  const current = node.get("allowedGroups", true);
  if (isSeq(current)) {
    // Reuse the scalar nodes of unchanged entries so their comments and quoting survive.
    const byValue = new Map(current.items.filter(isScalar).map((n) => [n.value, n] as const));
    current.items = after.map((g) => byValue.get(g) ?? newScalar(g, current.items.find(isScalar)));
  } else {
    const seq = new YAMLSeq();
    seq.items = after.map((g) => newScalar(g, undefined));
    node.set("allowedGroups", seq);
  }
  const editedText = render(doc);

  // Invariant 4: parse again from TEXT (not from the in-memory document) and compare structurally.
  const editedObj: unknown = yaml.parse(editedText);
  const editedParsed = rawSsoFileSchema.safeParse(editedObj);
  if (!editedParsed.success) reject("edited sso.yaml does not satisfy the SSO schema");
  const expected = structuredClone(baseParsed.data);
  const target = expected.sso.endpoints.find((e) => e.name === patch.endpoint);
  if (target === undefined) reject(`endpoint: "${patch.endpoint}" does not exist in sso.yaml`);
  target.allowedGroups = after;
  if (!isDeepStrictEqual(expected, editedParsed.data)) {
    reject(`the edit changed something other than allowedGroups of "${patch.endpoint}"`);
  }
  const resolved = resolveSsoFile(editedObj, baseDomain);
  if (!resolved.ok) reject(`edited sso.yaml violates the SSO rules: ${resolved.summary}`);

  // createTwoFilesPatch starts with a "====" separator line that `git apply` style readers do not expect.
  const diff = createTwoFilesPatch(`a/${SSO_FILE_PATH}`, `b/${SSO_FILE_PATH}`, baseText, editedText, "", "", { context: 3 }).replace(/^=+\n/, "");
  return { endpoint: patch.endpoint, before, after, editedText, diff, payloadSha256: payloadSha256({ endpoint: patch.endpoint, allowedGroups: after }) };
}

// New entries copy the quoting of an existing one (the file quotes its strings), else double-quote.
function newScalar(value: string, like: Scalar | undefined): Scalar {
  const scalar = new Scalar(value);
  scalar.type = like?.type ?? "QUOTE_DOUBLE";
  return scalar;
}
