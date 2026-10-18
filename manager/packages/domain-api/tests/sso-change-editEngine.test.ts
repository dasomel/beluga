import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildChange, ChangeRejection, payloadSha256 } from "../src/sso-change/editEngine.js";

const BASE = fs.readFileSync(path.resolve(__dirname, "fixtures/sso-change.yaml"), "utf8");
const GROUPS = ["analysts", "engineers", "admins"];
const DOMAIN = "local.beluga.internal";

function build(endpoint: string, allowedGroups: unknown[], baseText = BASE, groupNames = GROUPS) {
  return buildChange({ baseText, baseDomain: DOMAIN, groupNames, patch: { endpoint, allowedGroups } });
}
function rejection(fn: () => unknown): ChangeRejection {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ChangeRejection);
    return error as ChangeRejection;
  }
  throw new Error("expected a ChangeRejection");
}

describe("buildChange (D-MSSO-8)", () => {
  it("changes only the allowedGroups lines and keeps every other byte and comment", () => {
    const r = build("flink", ["admins", "analysts"]);
    expect(r.before).toEqual(["admins", "engineers"]);
    expect(r.after).toEqual(["admins", "analysts"]);
    const lines = r.editedText.split("\n");
    const baseLines = BASE.split("\n");
    expect(lines.length).toBe(baseLines.length);
    const changed = lines.map((l, i) => [baseLines[i], l] as const).filter(([a, b]) => a !== b);
    expect(changed).toEqual([['        - "engineers"', '        - "analysts"']]);
    expect(r.editedText).toContain('- "admins" # keep me');
    expect(r.editedText).toContain("# filer has no allowedGroups yet.");
    expect(r.diff).toMatch(/^--- a\/gitops\/values\/sso\.yaml\n\+\+\+ b\/gitops\/values\/sso\.yaml\n@@/);
    expect(r.diff).toContain('-        - "engineers"');
    expect(r.diff).toContain('+        - "analysts"');
  });

  it("adds the field to an endpoint that has none (before = null), as double-quoted entries", () => {
    const r = build("filer", ["admins", "engineers"]);
    expect(r.before).toBeNull();
    expect(r.editedText).toContain('      allowedGroups:\n        - "admins"\n        - "engineers"\n');
    const removed = r.diff.split("\n").filter((l) => l.startsWith("-") && !l.startsWith("---"));
    expect(removed).toEqual([]);
  });

  it("appends an entry to the set", () => {
    const r = build("flink", ["admins", "engineers", "analysts"]);
    expect(r.after).toEqual(["admins", "engineers", "analysts"]);
  });

  it("rejects the same set (also reordered) with NO_EFFECTIVE_CHANGE", () => {
    for (const list of [["admins", "engineers"], ["engineers", "admins"]]) {
      const e = rejection(() => build("flink", list));
      expect(e.code).toBe("NO_EFFECTIVE_CHANGE");
    }
  });

  it("rejects endpoints that are not editable or do not exist", () => {
    for (const name of ["argocd", "catalog-ui", "nope", ""]) {
      expect(rejection(() => build(name, ["admins"])).code, name).toBe("PATCH_REJECTED");
    }
  });

  it("rejects empty, non-string, duplicate, badly named, unknown and admins-less lists", () => {
    const cases: [unknown[], RegExp][] = [
      [[], /non-empty/],
      [["admins", 7], /must be a string/],
      [["admins", "admins"], /duplicates/],
      [["admins", "Engineers"], /\[a-z0-9-\]\+/],
      [["admins", "nope"], /unknown group "nope"/],
      [["engineers"], /must include "admins"/],
    ];
    for (const [list, message] of cases) {
      const e = rejection(() => build("flink", list));
      expect(e.code).toBe("PATCH_REJECTED");
      expect(e.message).toMatch(message);
    }
    expect(rejection(() => buildChange({ baseText: BASE, baseDomain: DOMAIN, groupNames: GROUPS, patch: { endpoint: "flink", allowedGroups: "admins" as never } })).code).toBe("PATCH_REJECTED");
  });

  it("refuses a base whose formatting the editor cannot reproduce", () => {
    const odd = BASE.replace('realm: "beluga"', "realm:   'beluga'   ");
    // single quotes + padding round-trip differently
    const e = rejection(() => build("flink", ["admins", "analysts"], odd));
    expect(e.message).toMatch(/formatting cannot be preserved|SSO schema/);
  });

  it("rejects a base that is not valid for the SSO schema", () => {
    expect(rejection(() => build("flink", ["admins", "analysts"], "sso:\n  realm: x\n")).code).toBe("PATCH_REJECTED");
  });

  it("refuses to add allowedGroups to an endpoint whose mode forbids it", () => {
    const base = BASE.replace(/(name: flink[\s\S]*?mode: )"gateway-oidc"/, '$1"app-oidc"');
    const e = rejection(() => build("flink", ["admins", "analysts"], base));
    expect(e.code).toBe("PATCH_REJECTED");
  });

  it("round-trips the real gitops/values/sso.yaml and edits only flink", () => {
    const real = fs.readFileSync(path.resolve(__dirname, "../../../../gitops/values/sso.yaml"), "utf8");
    const r = build("flink", ["admins", "analysts"], real);
    const changedLines = r.diff.split("\n").filter((l) => /^[-+]/.test(l) && !/^(---|\+\+\+)/.test(l));
    expect(changedLines).toEqual(['-        - "engineers"', '+        - "analysts"']);
  });
});

describe("payloadSha256 (D-MSSO-9)", () => {
  it("is stable for the same payload and differs by order and endpoint", () => {
    const a = payloadSha256({ endpoint: "flink", allowedGroups: ["admins", "engineers"] });
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).toBe(payloadSha256({ endpoint: "flink", allowedGroups: ["admins", "engineers"] }));
    expect(a).not.toBe(payloadSha256({ endpoint: "flink", allowedGroups: ["engineers", "admins"] }));
    expect(a).not.toBe(payloadSha256({ endpoint: "filer", allowedGroups: ["admins", "engineers"] }));
  });
});
