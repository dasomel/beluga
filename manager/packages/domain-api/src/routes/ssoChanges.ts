import { createRoute, z, type OpenAPIHono } from "@hono/zod-openapi";
import type { Context, MiddlewareHandler } from "hono";
import { SsoConfigError, type SsoAdapter, type SsoBase } from "../adapters/sso/ssoAdapter.js";
import { internalErrorResponse, unauthenticatedResponse } from "../lib/errorResponses.js";
import { errorResponseSchema, type ErrorCode } from "../schema/envelope.js";
import {
  IDEMPOTENCY_KEY_RE,
  ssoChangeCancelBodySchema,
  ssoChangeContractSchema,
  ssoChangeListSchema,
  ssoChangePreviewSchema,
  ssoChangeRecordSchema,
  ssoChangeRequestBodySchema,
  type SsoChangeRecordView,
} from "../schema/ssoChange.js";
import type { ArgocdPort } from "../sso-change/argocdReader.js";
import { buildChange, ChangeRejection, EDITABLE_ENDPOINTS, SSO_FILE_PATH, payloadSha256 } from "../sso-change/editEngine.js";
import { GitWriteError, GithubUnavailableError, type GitChangeOps, type PrInfo } from "../sso-change/gitWriter.js";
import { closeOrphanPr, isTerminalLoss } from "../sso-change/compensation.js";
import { commitMessage, prBody, prTitle } from "../sso-change/prText.js";
import { PR_ADOPT_SKEW_MS, SUBMITTED_GRACE_MS } from "../sso-change/reconciler.js";
import { StoreError, type ChangeRecord, type SsoChangeStore } from "../store/ssoChangeStore.js";

// D-MSSO-7/8/9/11: write side of the SSO change request. Order of checks on every route (first failure wins):
// auth 401 (middleware) -> group admins 403 -> SSO_WRITE_ENABLED 503 -> audit store ready 503 -> body 400/422.
// All gates are route middleware so they run BEFORE body validation: a non-admin never learns whether a body was
// valid, and a dead database never turns a 403 into a 503.

export interface SsoChangeDeps {
  store?: SsoChangeStore | undefined;
  /** D-MSSO-15: undefined until the owner creates the GitHub App Secret: submit/cancel then answer 503 GIT_WRITER_UNCONFIGURED. */
  gitWriter?: GitChangeOps | undefined;
  /** D-MSSO-16: only its presence is used here (health); the reconciler owns the reads. */
  argocdReader?: ArgocdPort | undefined;
  /** D-MSSO-8: SSO_WRITE_ENABLED, default off. */
  writeEnabled?: boolean | undefined;
}

const REQUIRED_GROUP = "admins";
const LIST_LIMIT = 20;
const ACTIVE_STAGES: ChangeRecord["stage"][] = ["submitted", "pr_open", "unknown_recovering"];
// Throttle for `denied` audit rows: any authenticated non-admin could otherwise append rows at request rate.
const DENIED_AUDIT_INTERVAL_MS = 10_000;
const DENIED_AUDIT_MAX_SUBJECTS = 1000;

const idParam = z.object({ id: z.string().uuid().openapi({ param: { name: "id", in: "path" } }) });
const postQuery = z.object({
  dryRun: z.enum(["true", "false"]).optional().openapi({ param: { name: "dryRun", in: "query" }, description: "true = preview only" }),
});
const postHeaders = z.object({
  "idempotency-key": z
    .string()
    .regex(IDEMPOTENCY_KEY_RE, { message: "Idempotency-Key must be 32 lowercase hex characters" })
    .optional()
    .openapi({ description: "Idempotency-Key header (case-insensitive). Required unless dryRun=true." }),
});

const err = (description: string) => ({ description, content: { "application/json": { schema: errorResponseSchema } } });

function failure<S extends 400 | 401 | 403 | 404 | 409 | 422 | 502 | 503>(c: Context, status: S, code: ErrorCode, message: string) {
  return c.json({ error: { code, message } }, status);
}

function view(record: ChangeRecord, diff?: string): SsoChangeRecordView {
  return {
    id: record.id,
    stage: record.stage,
    endpoint: record.endpoint,
    patch: record.patch,
    baseBlobSha: record.baseBlobSha,
    sourceCommitSha: record.sourceCommitSha,
    branch: record.branch,
    pr: record.prNumber !== null && record.prUrl !== null ? { number: record.prNumber, url: record.prUrl } : null,
    mergeCommitSha: record.mergeCommitSha,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    ...(diff !== undefined ? { diff } : {}),
  };
}

const postRoute = (middleware: MiddlewareHandler[]) =>
  createRoute({
    method: "post",
    path: "/api/v1/sso/change-requests",
    tags: ["SSO"],
    summary: "Preview (dryRun=true) or submit a change of allowedGroups for one SSO endpoint",
    description:
      "Admins only. The server edits gitops/values/sso.yaml itself from the patch; the client never sends a document. " +
      "Submit opens a pull request and never merges it.",
    middleware,
    request: {
      query: postQuery,
      headers: postHeaders,
      body: { required: true, content: { "application/json": { schema: ssoChangeRequestBodySchema } } },
    },
    responses: {
      200: {
        description: "Preview (dryRun=true) or the existing record of a replayed Idempotency-Key.",
        content: { "application/json": { schema: z.union([ssoChangePreviewSchema, ssoChangeRecordSchema]) } },
      },
      201: { description: "Change request created and pull request opened.", content: { "application/json": { schema: ssoChangeRecordSchema } } },
      400: err("Invalid body, query or Idempotency-Key."),
      401: unauthenticatedResponse,
      403: err("Not a member of group admins."),
      409: err("STALE_BASE (sso.yaml changed since the preview), OPEN_REQUEST_EXISTS, IDEMPOTENCY_KEY_COLLISION (retry with a new key), REQUEST_NOT_ACTIVE (cancelled while the pull request was created) or a git conflict."),
      422: err("PATCH_REJECTED (invariant violation), NO_EFFECTIVE_CHANGE or IDEMPOTENCY_MISMATCH."),
      502: err("GitHub failed after the audit row was written (GIT_WRITE_FAILED / GIT_WRITE_UNKNOWN)."),
      503: err("CONSUMER_NOT_DEPLOYED, AUDIT_UNAVAILABLE, GIT_WRITER_UNCONFIGURED or SSO source unavailable."),
      500: internalErrorResponse,
    },
  });

const contractRoute = (middleware: MiddlewareHandler[]) =>
  createRoute({
    method: "get",
    path: "/api/v1/sso/change-requests/contract",
    tags: ["SSO"],
    summary: "What the edit form may offer: editable endpoints, available groups, current values",
    description: "Admins only, not audited. Read from main at sourceCommitSha; the server still validates every submit.",
    middleware,
    responses: {
      200: { description: "The edit contract.", content: { "application/json": { schema: ssoChangeContractSchema } } },
      401: unauthenticatedResponse,
      403: err("Not a member of group admins."),
      503: err("CONSUMER_NOT_DEPLOYED, AUDIT_UNAVAILABLE or SSO source unavailable."),
      500: internalErrorResponse,
    },
  });

const listRoute = (middleware: MiddlewareHandler[]) =>
  createRoute({
    method: "get",
    path: "/api/v1/sso/change-requests",
    tags: ["SSO"],
    summary: "Open SSO change requests (submitted, pr_open, unknown_recovering, merged), newest first, at most 20",
    middleware,
    request: { query: z.object({ status: z.enum(["open"]).openapi({ param: { name: "status", in: "query" }, description: "Required; only `open` exists." }) }) },
    responses: {
      200: { description: "Open requests.", content: { "application/json": { schema: ssoChangeListSchema } } },
      400: err("status is missing or not `open`."),
      401: unauthenticatedResponse,
      403: err("Not a member of group admins."),
      503: err("CONSUMER_NOT_DEPLOYED or AUDIT_UNAVAILABLE."),
      500: internalErrorResponse,
    },
  });

const cancelRoute = (middleware: MiddlewareHandler[]) =>
  createRoute({
    method: "post",
    path: "/api/v1/sso/change-requests/{id}/cancel",
    tags: ["SSO"],
    summary: "Close the open pull request of an active request and release the lock",
    description: "Admins only. The branch is left in place. If GitHub cannot close the pull request the lock is kept (502).",
    middleware,
    request: { params: idParam, body: { required: false, content: { "application/json": { schema: ssoChangeCancelBodySchema } } } },
    responses: {
      200: { description: "The request, now failed.", content: { "application/json": { schema: ssoChangeRecordSchema } } },
      400: err("Invalid id or body."),
      401: unauthenticatedResponse,
      403: err("Not a member of group admins."),
      404: err("No such request."),
      409: err("REQUEST_NOT_ACTIVE (not submitted, pr_open or unknown_recovering, or changed meanwhile) or REQUEST_IN_FLIGHT (submitted less than 120 s ago: the submit may still be creating the pull request)."),
      502: err("GITHUB_UNAVAILABLE: the pull request could not be closed; the request stays active."),
      503: err("CONSUMER_NOT_DEPLOYED, AUDIT_UNAVAILABLE (also when the cancel attempt could not be audited first) or GIT_WRITER_UNCONFIGURED."),
      500: internalErrorResponse,
    },
  });

const getRoute = (middleware: MiddlewareHandler[]) =>
  createRoute({
    method: "get",
    path: "/api/v1/sso/change-requests/{id}",
    tags: ["SSO"],
    summary: "Current state of one SSO change request",
    middleware,
    request: { params: idParam },
    responses: {
      200: { description: "The request.", content: { "application/json": { schema: ssoChangeRecordSchema } } },
      400: err("Invalid id."),
      401: unauthenticatedResponse,
      403: err("Not a member of group admins."),
      404: err("No such request."),
      503: err("AUDIT_UNAVAILABLE."),
      500: internalErrorResponse,
    },
  });

export function registerSsoChangeRoutes(app: OpenAPIHono, ssoAdapter: SsoAdapter | undefined, deps: SsoChangeDeps = {}): void {
  const { store, gitWriter } = deps;
  const deniedAt = new Map<string, number>();

  // D-MSSO-7: deny by default, groups from the verified token only. Missing principal (auth disabled) is 401: a
  // write needs an identity to audit.
  const adminGate: MiddlewareHandler = async (c, next) => {
    const principal = c.get("principal");
    if (principal === undefined) return failure(c, 401, "UNAUTHENTICATED", "Authentication required");
    if (!principal.groups.includes(REQUIRED_GROUP)) {
      auditDenied(principal.sub, principal.username, c.req.method, c.req.path);
      return failure(c, 403, "FORBIDDEN", `Membership of group '${REQUIRED_GROUP}' is required`);
    }
    return next();
  };

  // Best effort and never awaited: a dead audit store must not turn a 403 into a 503 or a slow response.
  function auditDenied(sub: string, username: string | undefined, method: string, path: string): void {
    if (store === undefined) return;
    const now = Date.now();
    if (now - (deniedAt.get(sub) ?? 0) < DENIED_AUDIT_INTERVAL_MS) return;
    if (deniedAt.size >= DENIED_AUDIT_MAX_SUBJECTS) deniedAt.clear();
    deniedAt.set(sub, now);
    void store.recordEvent({ stage: "denied", actorSub: sub, actorUsername: username ?? null, detail: { method, path } }).catch((error) => {
      console.error("[audit] could not record denied event:", error instanceof Error ? error.message : error);
    });
  }

  const writeEnabledGate: MiddlewareHandler = async (c, next) =>
    deps.writeEnabled === true ? next() : failure(c, 503, "CONSUMER_NOT_DEPLOYED", "SSO changes are not enabled on this deployment");

  const storeGate: MiddlewareHandler = async (c, next) =>
    store !== undefined && (await store.ready()) ? next() : failure(c, 503, "AUDIT_UNAVAILABLE", "Audit store is unavailable; no change was made");

  app.openapi(postRoute([adminGate, writeEnabledGate, storeGate]), async (c) => {
    const principal = c.get("principal");
    if (principal === undefined || store === undefined) return failure(c, 503, "AUDIT_UNAVAILABLE", "Audit store is unavailable; no change was made");
    const body = c.req.valid("json");
    const dryRun = c.req.valid("query").dryRun === "true";
    const key = c.req.valid("header")["idempotency-key"];
    const actor = { actorSub: principal.sub, actorUsername: principal.username ?? null };

    if (!dryRun) {
      // Before any database write or GitHub call (rollout 3 has no writer in production).
      if (gitWriter === undefined) return failure(c, 503, "GIT_WRITER_UNCONFIGURED", "Git write path is not configured");
      if (key === undefined) return failure(c, 400, "VALIDATION_ERROR", "Idempotency-Key header is required");
      if (body.baseBlobSha === undefined) return failure(c, 400, "VALIDATION_ERROR", "baseBlobSha (from the preview) is required");

      // A replay answers from the record even if main has moved on since (the PR may be merged by now, which
      // would otherwise read as STALE_BASE / NO_EFFECTIVE_CHANGE).
      try {
        const existing = await store.findByKey(key);
        if (existing !== undefined) {
          if (existing.payloadSha256 !== payloadSha256(body)) {
            return failure(c, 422, "IDEMPOTENCY_MISMATCH", "Idempotency-Key was used with a different payload");
          }
          return c.json(view(existing), 200);
        }
      } catch (error) {
        return storeFailure(c, error);
      }
    }

    // D-MSSO-11: GitHub READS (resolving the base commit/blob and groups.yaml that the audit row records) precede
    // the audit insert by design. The fail-closed rule covers GitHub WRITES: none happens before the audited,
    // committed row exists (store.submit below), so an unavailable audit store still means zero GitHub writes.
    let base: SsoBase;
    try {
      if (ssoAdapter?.readBase === undefined) throw new SsoConfigError("SSO source does not support change requests");
      base = await ssoAdapter.readBase({ fresh: !dryRun });
    } catch (error) {
      if (error instanceof SsoConfigError) return failure(c, 503, "SERVICE_UNAVAILABLE", error.message);
      throw error;
    }

    // D-MSSO-9: stale = the blob of sso.yaml on current main differs from the one the preview showed. Unrelated
    // commits do not count. No database row is written for a stale submit.
    if (!dryRun && body.baseBlobSha !== base.blobSha) {
      return failure(c, 409, "STALE_BASE", "gitops/values/sso.yaml changed since the preview; preview again");
    }

    let change;
    try {
      change = buildChange({
        baseText: base.text,
        baseDomain: base.baseDomain,
        groupNames: base.groupNames,
        patch: { endpoint: body.endpoint, allowedGroups: body.allowedGroups },
      });
    } catch (error) {
      if (error instanceof ChangeRejection) return failure(c, 422, error.code, error.message);
      throw error;
    }

    if (dryRun) {
      // D-MSSO-11 fail-closed: the audit row exists before the answer is sent.
      try {
        await store.recordEvent({
          stage: "previewed",
          ...actor,
          endpoint: change.endpoint,
          baseBlobSha: base.blobSha,
          payloadSha256: change.payloadSha256,
          reason: body.reason ?? null,
          detail: { sourceCommitSha: base.commitSha, before: change.before, after: change.after },
        });
      } catch (error) {
        return storeFailure(c, error);
      }
      return c.json(
        {
          endpoint: change.endpoint,
          patch: { allowedGroups: change.after },
          before: change.before,
          after: change.after,
          baseBlobSha: base.blobSha,
          sourceCommitSha: base.commitSha,
          diff: change.diff,
        },
        200,
      );
    }

    if (key === undefined || gitWriter === undefined) return failure(c, 400, "VALIDATION_ERROR", "Idempotency-Key header is required");
    const branch = `sso/${change.endpoint}-${key.slice(0, 12)}`;

    // The 'submitted' row (request + event) is committed BEFORE any GitHub call (D-MSSO-11).
    let created: { record: ChangeRecord; replay: boolean };
    try {
      created = await store.submit({
        filePath: SSO_FILE_PATH,
        endpoint: change.endpoint,
        idempotencyKey: key,
        payloadSha256: change.payloadSha256,
        baseBlobSha: base.blobSha,
        sourceCommitSha: base.commitSha,
        allowedGroups: change.after,
        actorSub: principal.sub,
        actorUsername: principal.username,
        branch,
        reason: body.reason,
      });
    } catch (error) {
      return storeFailure(c, error);
    }
    if (created.replay) return c.json(view(created.record), 200);

    const requestId = created.record.id;
    try {
      const pr = await gitWriter.createChangePr({
        branch,
        baseCommitSha: base.commitSha,
        baseBlobSha: base.blobSha,
        path: SSO_FILE_PATH,
        content: change.editedText,
        notBefore: Date.parse(created.record.createdAt) - PR_ADOPT_SKEW_MS,
        title: prTitle(change.endpoint),
        commitMessage: commitMessage({ endpoint: change.endpoint, username: principal.username, sub: principal.sub }),
        body: prBody({
          username: principal.username,
          sub: principal.sub,
          reason: body.reason,
          baseBlobSha: base.blobSha,
          sourceCommitSha: base.commitSha,
          diff: change.diff,
        }),
      });
      const record = await transitionOrLocal(store, created.record, "pr_open", { prNumber: pr.prNumber, prUrl: pr.prUrl });
      if (isTerminalLoss(record.stage)) {
        // D-MSSO-18c: the request was cancelled/rejected while we created the PR; do not leave it open and untracked.
        await closeOrphanPr(store, gitWriter, record, pr.prNumber, { sub: actor.actorSub, username: actor.actorUsername }, (line) =>
          console.error(`[sso-change] ${line}`),
        );
        return failure(c, 409, "REQUEST_NOT_ACTIVE", `Request ${requestId} was ${record.stage} while the pull request was created; the pull request was closed`);
      }
      return c.json(view(record, change.diff), 201);
    } catch (error) {
      const kind = error instanceof GitWriteError ? error.kind : "unknown"; // never assume the PR was not created
      if (kind === "unknown") {
        await transitionOrLocal(store, created.record, "unknown_recovering", {}, { reason: "git write outcome unknown" });
        return failure(c, 502, "GIT_WRITE_UNKNOWN", `GitHub did not confirm the pull request; request ${requestId} is recovering`);
      }
      await transitionOrLocal(store, created.record, "failed", {}, { reason: kind === "conflict" ? "git conflict" : "git write rejected" });
      return kind === "conflict"
        ? failure(c, 409, "STALE_BASE", "GitHub reported a conflict; preview again")
        : failure(c, 502, "GIT_WRITE_FAILED", `GitHub refused the change; request ${requestId} failed`);
    }
  });

  // D-MSSO-13: registered BEFORE /{id} so "contract" is never parsed as an id.
  app.openapi(contractRoute([adminGate, writeEnabledGate, storeGate]), async (c) => {
    let base: SsoBase;
    try {
      if (ssoAdapter?.readBase === undefined) throw new SsoConfigError("SSO source does not support change requests");
      base = await ssoAdapter.readBase();
    } catch (error) {
      if (error instanceof SsoConfigError) return failure(c, 503, "SERVICE_UNAVAILABLE", error.message);
      throw error;
    }
    const current: Record<string, string[] | null> = {};
    for (const name of EDITABLE_ENDPOINTS) current[name] = base.config.endpoints.find((e) => e.name === name)?.allowedGroups ?? null;
    return c.json(
      {
        editableEndpoints: [...EDITABLE_ENDPOINTS],
        field: "allowedGroups" as const,
        requiredGroups: [REQUIRED_GROUP],
        availableGroups: base.groupNames,
        current,
        sourceCommitSha: base.commitSha,
        baseBlobSha: base.blobSha,
        gitWriterConfigured: gitWriter !== undefined,
      },
      200,
    );
  });

  app.openapi(listRoute([adminGate, writeEnabledGate, storeGate]), async (c) => {
    if (store === undefined) return failure(c, 503, "AUDIT_UNAVAILABLE", "Audit store is unavailable");
    try {
      return c.json({ items: (await store.listOpen(LIST_LIMIT)).map((record) => view(record)) }, 200);
    } catch (error) {
      return auditUnavailable(c, error);
    }
  });

  app.openapi(cancelRoute([adminGate, writeEnabledGate, storeGate]), async (c) => {
    const principal = c.get("principal");
    if (principal === undefined || store === undefined) return failure(c, 503, "AUDIT_UNAVAILABLE", "Audit store is unavailable");
    if (gitWriter === undefined) return failure(c, 503, "GIT_WRITER_UNCONFIGURED", "Git write path is not configured");
    const { id } = c.req.valid("param");
    const reason = c.req.valid("json")?.reason;
    const actor = { actorSub: principal.sub, actorUsername: principal.username ?? null };

    let record: ChangeRecord | undefined;
    try {
      record = await store.get(id);
    } catch (error) {
      return auditUnavailable(c, error);
    }
    if (record === undefined) return failure(c, 404, "NOT_FOUND", "No such change request");
    if (!ACTIVE_STAGES.includes(record.stage)) return failure(c, 409, "REQUEST_NOT_ACTIVE", `Request is ${record.stage}, not active`);
    // D-MSSO-18f: a young `submitted` row may still be inside the submit route's own GitHub call; cancelling now
    // would race the PR creation. The window equals the reconciler's presumption that the submitter died. Cost: an
    // admin waits up to 120 s to cancel a request that really is stuck. Escape hatch: none needed, it expires.
    if (record.stage === "submitted" && Date.now() - Date.parse(record.updatedAt) < SUBMITTED_GRACE_MS) {
      return failure(c, 409, "REQUEST_IN_FLIGHT", "The request was submitted moments ago and may still be creating its pull request; retry shortly");
    }

    // D-MSSO-11 (fail-closed) for cancel, D-MSSO-18g: the intent is on the record BEFORE any GitHub call. No audit
    // row = no close. Cost: one more audit row per cancel (also when the close then fails).
    try {
      await store.recordEvent({
        requestId: record.id,
        stage: record.stage,
        ...actor,
        endpoint: record.endpoint,
        detail: { cancel: "requested", by: principal.sub },
      });
    } catch (error) {
      return auditUnavailable(c, error);
    }

    // Find the PR (the number if we have it, else by the deterministic branch) and close it if it is open.
    try {
      const pr: PrInfo | undefined =
        record.prNumber !== null
          ? await gitWriter.getPr(record.prNumber)
          : await gitWriter.findPrByBranch(record.branch, Date.parse(record.createdAt) - PR_ADOPT_SKEW_MS);
      if (pr?.merged === true) return failure(c, 409, "REQUEST_NOT_ACTIVE", "The pull request is already merged");
      if (pr?.state === "open") await gitWriter.closePr(pr.number);
    } catch (error) {
      // The lock stays: no transition, but the attempt is on the record, with the stage the request still has.
      const text = error instanceof GithubUnavailableError ? error.message : "unexpected error";
      await store
        .recordEvent({
          requestId: record.id,
          stage: record.stage,
          ...actor,
          endpoint: record.endpoint,
          detail: { cancel: "close_failed", error: text },
        })
        .catch((e) => console.error("[audit] could not record close_failed event:", e instanceof Error ? e.message : e));
      return failure(c, 502, "GITHUB_UNAVAILABLE", `GitHub could not close the pull request; request ${record.id} is still active`);
    }

    // D-MSSO-18: compare-and-set on the stage we read; a lost CAS means the reconciler or another cancel won.
    // D-MSSO-18i: ...and on the row VERSION we read (the one whose grace we checked). Stage alone is not enough: the
    // reconciler's submitted -> submitted touch (D-MSSO-18h) keeps the stage but starts a write, and a cancel that
    // read the row before the touch would otherwise still win and strand the PR that write creates. Reason: close
    // the check-then-act gap. Cost: a cancel racing any update of the row answers 409 and the admin retries (if the
    // PR was already closed above, it stays closed; the request then follows the reconciler's own outcome).
    // Escape hatch: drop the 7th argument to fall back to stage-only CAS.
    try {
      const done = await store.transition(
        record.id,
        record.stage,
        "failed",
        {},
        { reason: reason ?? "cancelled by admin", detail: { cancelledBy: principal.sub }, ...actor },
        record.version,
      );
      if (done === undefined) return failure(c, 409, "REQUEST_NOT_ACTIVE", "Request changed state meanwhile");
      return c.json(view(done), 200);
    } catch (error) {
      return auditUnavailable(c, error);
    }
  });

  app.openapi(getRoute([adminGate, storeGate]), async (c) => {
    if (store === undefined) return failure(c, 503, "AUDIT_UNAVAILABLE", "Audit store is unavailable");
    try {
      const record = await store.get(c.req.valid("param").id);
      return record === undefined ? failure(c, 404, "NOT_FOUND", "No such change request") : c.json(view(record), 200);
    } catch (error) {
      if (!(error instanceof StoreError)) throw error;
      console.error("[audit] store error:", error.cause instanceof Error ? error.cause.message : error.message);
      return failure(c, 503, "AUDIT_UNAVAILABLE", "Audit store is unavailable");
    }
  });
}

function auditUnavailable(c: Context, error: unknown) {
  if (!(error instanceof StoreError)) throw error;
  console.error("[audit] store error:", error.cause instanceof Error ? error.cause.message : error.message);
  return failure(c, 503, "AUDIT_UNAVAILABLE", "Audit store is unavailable");
}

function storeFailure(c: Context, error: unknown) {
  if (error instanceof StoreError) {
    if (error.code === "OPEN_REQUEST_EXISTS") return failure(c, 409, "OPEN_REQUEST_EXISTS", "An SSO change request is already open");
    if (error.code === "IDEMPOTENCY_KEY_COLLISION") return failure(c, 409, "IDEMPOTENCY_KEY_COLLISION", "Idempotency-Key collides with an earlier request; retry with a new key");
    if (error.code === "IDEMPOTENCY_MISMATCH") return failure(c, 422, "IDEMPOTENCY_MISMATCH", "Idempotency-Key was used with a different payload");
    console.error("[audit] store error:", error.cause instanceof Error ? error.cause.message : error.message);
    return failure(c, 503, "AUDIT_UNAVAILABLE", "Audit store is unavailable; no change was made");
  }
  throw error;
}

// D-MSSO-11: later transitions never alter Git state. If the database fails after GitHub answered, the caller still
// gets the truth about GitHub; the stale row is logged and the reconciler (D-MSSO-18) repairs it. The transition is
// a compare-and-set from `submitted`: if the reconciler already moved the row, `get` returns what it did.
async function transitionOrLocal(
  store: SsoChangeStore,
  record: ChangeRecord,
  stage: ChangeRecord["stage"],
  fields: { prNumber?: number; prUrl?: string },
  event?: { reason?: string },
): Promise<ChangeRecord> {
  try {
    const moved = await store.transition(record.id, record.stage, stage, fields, event);
    if (moved !== undefined) return moved;
    const current = await store.get(record.id);
    if (current !== undefined) return current;
  } catch (error) {
    console.error(`[audit] transition of ${record.id} to ${stage} failed:`, error instanceof Error ? error.message : error);
  }
  return { ...record, stage, prNumber: fields.prNumber ?? record.prNumber, prUrl: fields.prUrl ?? record.prUrl };
}
