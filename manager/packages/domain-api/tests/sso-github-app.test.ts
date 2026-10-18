import crypto from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GithubAppClient, BRANCH_RE } from "../src/sso-change/githubApp.js";
import { CREATE_PR_DEADLINE_MS, GitWriteError, GithubUnavailableError, type CreateChangePrInput } from "../src/sso-change/gitWriter.js";
import { ghJson, githubMock, testKeyPem, testPublicKey } from "./helpers/githubMock.js";

const BASE_COMMIT = "a".repeat(40);
const BASE_BLOB = "b".repeat(40);
const BRANCH = "sso/flink-3f9a1c7e5b2d";
const CONTENT = "new file content\n";
const OLD = "old file content\n";
const PR_URL = "https://github.com/dasomel/beluga/pull/42";
const T0 = Date.parse("2026-10-18T10:00:00Z");

let gh: ReturnType<typeof githubMock>;
let clock: number;

function client() {
  return new GithubAppClient({ appId: "1234", installationId: "5678", privateKeyPem: testKeyPem, fetchImpl: gh.impl, now: () => clock, timeoutMs: 500 });
}
const input = (over: Partial<CreateChangePrInput> = {}): CreateChangePrInput => ({
  branch: BRANCH,
  baseCommitSha: BASE_COMMIT,
  baseBlobSha: BASE_BLOB,
  path: "gitops/values/sso.yaml",
  content: CONTENT,
  title: "title",
  body: "body",
  commitMessage: "chore(sso): flink allowedGroups via Manager\n\nRequested-by: alice (u)",
  ...over,
});
const contents = (text: string, sha: string) => ghJson({ type: "file", path: "gitops/values/sso.yaml", sha, content: Buffer.from(text).toString("base64"), encoding: "base64" });
const expiresAt = (offsetMs: number) => new Date(T0 + offsetMs).toISOString();

beforeEach(() => {
  clock = T0;
  gh = githubMock();
  gh.on("POST", /^\/app\/installations\/5678\/access_tokens$/, () => ghJson({ token: "ghs_SECRET_TOKEN", expires_at: expiresAt(3_600_000) }, 201));
  // Defaults for a fresh happy path; individual tests override.
  gh.on("POST", /\/git\/refs$/, () => ghJson({ ref: `refs/heads/${BRANCH}` }, 201));
  gh.on("GET", /\/contents\/gitops\/values\/sso\.yaml\?ref=/, () => contents(OLD, BASE_BLOB));
  gh.on("PUT", /\/contents\/gitops\/values\/sso\.yaml$/, () => ghJson({ content: {} }, 200));
  gh.on("POST", /\/pulls$/, () => ghJson({ number: 42, html_url: PR_URL, state: "open" }, 201));
});

const b64 = (s: string) => Buffer.from(s, "base64url");

describe("JWT (D-MSSO-15)", () => {
  it("is RS256 with iat = now-60, exp = now+540 (<= 600 s apart), iss = app id, and verifies with the public key", () => {
    const jwt = client().signJwt();
    const [h, p, s] = jwt.split(".") as [string, string, string];
    expect(JSON.parse(b64(h).toString())).toEqual({ alg: "RS256", typ: "JWT" });
    const payload = JSON.parse(b64(p).toString()) as { iat: number; exp: number; iss: string };
    expect(payload.iss).toBe("1234");
    expect(payload.iat).toBe(T0 / 1000 - 60);
    expect(payload.exp).toBe(T0 / 1000 + 540);
    expect(payload.exp - payload.iat).toBeLessThanOrEqual(600);
    expect(crypto.verify("RSA-SHA256", Buffer.from(`${h}.${p}`), testPublicKey, b64(s))).toBe(true);
  });

  it("rejects something that is not a private key at construction", () => {
    expect(() => new GithubAppClient({ appId: "1", installationId: "2", privateKeyPem: "not a key" })).toThrow();
  });
});

describe("installation token", () => {
  it("is minted with the JWT, cached until 5 minutes before expiry, then minted again", async () => {
    gh.on("GET", /\/git\/ref\/heads\//, () => ghJson({ object: { sha: BASE_COMMIT } }));
    const c = client();
    await c.findBranch(BRANCH);
    await c.findBranch(BRANCH);
    const mints = () => gh.calls.filter((x) => x.path.endsWith("/access_tokens"));
    expect(mints()).toHaveLength(1);
    const auth = mints()[0]!.headers.get("authorization")!;
    expect(auth.startsWith("Bearer ")).toBe(true);
    const [h, p, s] = auth.slice(7).split(".") as [string, string, string];
    expect(crypto.verify("RSA-SHA256", Buffer.from(`${h}.${p}`), testPublicKey, b64(s))).toBe(true);
    const api = gh.calls.find((x) => x.path.includes("/git/ref/heads/"))!;
    expect(api.headers.get("authorization")).toBe("Bearer ghs_SECRET_TOKEN");

    clock = T0 + 3_600_000 - 5 * 60_000 - 1; // still inside the cache window
    await c.findBranch(BRANCH);
    expect(mints()).toHaveLength(1);
    clock = T0 + 3_600_000 - 5 * 60_000; // refresh margin reached
    await c.findBranch(BRANCH);
    expect(mints()).toHaveLength(2);
  });

  it("concurrent first calls share one mint", async () => {
    gh.on("GET", /\/git\/ref\/heads\//, () => ghJson({ object: { sha: BASE_COMMIT } }));
    const c = client();
    await Promise.all([c.findBranch(BRANCH), c.findBranch(BRANCH), c.findBranch(BRANCH)]);
    expect(gh.calls.filter((x) => x.path.endsWith("/access_tokens"))).toHaveLength(1);
  });

  it("a 401 on an API call drops the cached token and retries once with a new one", async () => {
    let n = 0;
    gh.on("GET", /\/git\/ref\/heads\//, () => (n++ === 0 ? ghJson({ message: "Bad credentials" }, 401) : ghJson({ object: { sha: BASE_COMMIT } })));
    const c = client();
    expect(await c.findBranch(BRANCH)).toEqual({ sha: BASE_COMMIT });
    expect(gh.calls.filter((x) => x.path.endsWith("/access_tokens"))).toHaveLength(2);
  });

  it("never leaks the token or the JWT into an error", async () => {
    gh.on("GET", /\/git\/ref\/heads\//, () => ghJson({ message: "boom" }, 500));
    const error = await client().findBranch(BRANCH).catch((e: Error) => e);
    expect(error).toBeInstanceOf(GithubUnavailableError);
    expect(String((error as Error).message)).not.toMatch(/ghs_|eyJ/);
  });

  it("an unusable token response is GithubUnavailable", async () => {
    gh.on("POST", /\/access_tokens$/, () => ghJson({ message: "Not Found" }, 404));
    await expect(client().findBranch(BRANCH)).rejects.toBeInstanceOf(GithubUnavailableError);
  });
});

describe("createChangePr (D-MSSO-19)", () => {
  it("happy path: ref, branch file read, PUT with the branch blob sha, PR head=branch base=main; no merge", async () => {
    const pr = await client().createChangePr(input());
    expect(pr).toEqual({ prNumber: 42, prUrl: PR_URL });
    const steps = gh.calls.filter((c) => !c.path.endsWith("/access_tokens")).map((c) => `${c.method} ${c.path.replace("/repos/dasomel/beluga", "")}`);
    expect(steps).toEqual([
      "POST /git/refs",
      "GET /contents/gitops/values/sso.yaml?ref=sso%2Fflink-3f9a1c7e5b2d",
      "PUT /contents/gitops/values/sso.yaml",
      "POST /pulls",
    ]);
    const [ref, , put, pull] = gh.calls.filter((c) => !c.path.endsWith("/access_tokens"));
    expect(ref!.body).toEqual({ ref: `refs/heads/${BRANCH}`, sha: BASE_COMMIT });
    expect(put!.body).toEqual({
      message: input().commitMessage,
      content: Buffer.from(CONTENT).toString("base64"),
      sha: BASE_BLOB,
      branch: BRANCH,
    });
    expect(pull!.body).toMatchObject({ title: "title", head: BRANCH, base: "main", body: "body" });
    expect(gh.calls.some((c) => /merge/i.test(c.path))).toBe(false);
    expect(gh.unmatched).toHaveLength(0);
  });

  it("ref already exists (422) and the branch is there: continues with the file and the PR", async () => {
    gh.on("POST", /\/git\/refs$/, () => ghJson({ message: "Reference already exists" }, 422));
    gh.on("GET", /\/git\/ref\/heads\//, () => ghJson({ object: { sha: BASE_COMMIT } }));
    expect(await client().createChangePr(input())).toEqual({ prNumber: 42, prUrl: PR_URL });
  });

  it("ref reported as existing but the branch cannot be read: rejected", async () => {
    gh.on("POST", /\/git\/refs$/, () => ghJson({ message: "Reference already exists" }, 422));
    gh.on("GET", /\/git\/ref\/heads\//, () => ghJson({ message: "Not Found" }, 404));
    await expect(client().createChangePr(input())).rejects.toMatchObject({ kind: "rejected" });
  });

  it("content already equal on the branch: no PUT (replay after the write succeeded)", async () => {
    gh.on("GET", /\/contents\/gitops\/values\/sso\.yaml\?ref=/, () => contents(CONTENT, "c".repeat(40)));
    expect(await client().createChangePr(input())).toEqual({ prNumber: 42, prUrl: PR_URL });
    expect(gh.calls.some((c) => c.method === "PUT")).toBe(false);
  });

  it("the branch holds something that is neither the base nor the target: conflict, nothing overwritten", async () => {
    gh.on("GET", /\/contents\/gitops\/values\/sso\.yaml\?ref=/, () => contents("someone else\n", "d".repeat(40)));
    await expect(client().createChangePr(input())).rejects.toMatchObject({ kind: "conflict" });
    expect(gh.calls.some((c) => c.method === "PUT")).toBe(false);
  });

  it("PR already exists (422, GitHub's errors[] shape): returns the existing one", async () => {
    gh.on("POST", /\/pulls$/, () =>
      ghJson({ message: "Validation Failed", errors: [{ resource: "PullRequest", code: "custom", message: `A pull request already exists for dasomel:${BRANCH}.` }] }, 422),
    );
    gh.on("GET", /\/pulls\?head=/, (call) => {
      expect(decodeURIComponent(call.path)).toContain(`head=dasomel:${BRANCH}`);
      return ghJson([{ number: 7, html_url: "https://github.com/dasomel/beluga/pull/7", state: "open", merged_at: null }]);
    });
    expect(await client().createChangePr(input())).toEqual({ prNumber: 7, prUrl: "https://github.com/dasomel/beluga/pull/7" });
  });

  it("every step replayed (ref, file, PR all exist): still the same PR, no writes besides the failing creates", async () => {
    gh.on("POST", /\/git\/refs$/, () => ghJson({ message: "Reference already exists" }, 422));
    gh.on("GET", /\/git\/ref\/heads\//, () => ghJson({ object: { sha: BASE_COMMIT } }));
    gh.on("GET", /\/contents\/gitops\/values\/sso\.yaml\?ref=/, () => contents(CONTENT, "c".repeat(40)));
    gh.on("POST", /\/pulls$/, () => ghJson({ message: "Validation Failed", errors: [{ message: "A pull request already exists for x." }] }, 422));
    gh.on("GET", /\/pulls\?head=/, () => ghJson([{ number: 9, html_url: PR_URL, state: "open" }]));
    expect(await client().createChangePr(input())).toEqual({ prNumber: 9, prUrl: PR_URL });
    expect(gh.calls.some((c) => c.method === "PUT")).toBe(false);
  });

  it.each([
    ["content write 409", "PUT", /\/contents\//, 409, "conflict"],
    ["content write 422", "PUT", /\/contents\//, 422, "conflict"],
    ["content write 403", "PUT", /\/contents\//, 403, "rejected"],
    ["ref create 403", "POST", /\/git\/refs$/, 403, "rejected"],
    ["ref create 404", "POST", /\/git\/refs$/, 404, "rejected"],
    ["ref create 422 (not 'exists')", "POST", /\/git\/refs$/, 422, "rejected"],
    ["PR create 422 (other)", "POST", /\/pulls$/, 422, "rejected"],
    ["PR create 401", "POST", /\/pulls$/, 401, "rejected"],
    ["ref create 502", "POST", /\/git\/refs$/, 502, "unknown"],
    ["content write 500", "PUT", /\/contents\//, 500, "unknown"],
    ["PR create 503", "POST", /\/pulls$/, 503, "unknown"],
  ] as const)("error mapping: %s -> %s", async (_name, method, re, status, kind) => {
    gh.on(method, re, () => ghJson({ message: "nope" }, status));
    const error = await client().createChangePr(input()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GitWriteError);
    expect((error as GitWriteError).kind).toBe(kind);
  });

  it("timeout and transport errors are unknown", async () => {
    const slow = new GithubAppClient({
      appId: "1234",
      installationId: "5678",
      privateKeyPem: testKeyPem,
      now: () => clock,
      fetchImpl: (async () => {
        throw Object.assign(new Error("t"), { name: "TimeoutError" });
      }) as typeof fetch,
    });
    await expect(slow.createChangePr(input())).rejects.toMatchObject({ kind: "unknown", message: "timeout" });
    const down = new GithubAppClient({
      appId: "1234",
      installationId: "5678",
      privateKeyPem: testKeyPem,
      now: () => clock,
      fetchImpl: (async () => {
        throw new TypeError("fetch failed");
      }) as typeof fetch,
    });
    await expect(down.createChangePr(input())).rejects.toMatchObject({ kind: "unknown" });
  });

  it("rate limit: unknown, and the client then fails fast without calling GitHub until the reset", async () => {
    gh.on("POST", /\/git\/refs$/, () => ghJson({ message: "rate limited" }, 403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String((T0 + 120_000) / 1000) }));
    const c = client();
    await expect(c.createChangePr(input())).rejects.toMatchObject({ kind: "unknown", message: "rate-limited" });
    const before = gh.calls.length;
    await expect(c.createChangePr(input())).rejects.toMatchObject({ kind: "unknown" });
    expect(gh.calls.length).toBe(before);
    clock = T0 + 121_000;
    gh.on("POST", /\/git\/refs$/, () => ghJson({}, 201));
    expect(await c.createChangePr(input())).toEqual({ prNumber: 42, prUrl: PR_URL });
  });
});

describe("hard guards", () => {
  it("BRANCH_RE accepts only sso/(flink|filer)-<12 hex>", () => {
    for (const ok of ["sso/flink-3f9a1c7e5b2d", "sso/filer-000000000000"]) expect(BRANCH_RE.test(ok)).toBe(true);
    for (const bad of ["main", "sso/argocd-3f9a1c7e5b2d", "sso/flink-3f9a1c7e5b2", "sso/flink-3f9a1c7e5b2dd", "sso/flink-3F9A1C7E5B2D", "x/sso/flink-3f9a1c7e5b2d", "sso/flink-3f9a1c7e5b2d/x", "sso/flink-3f9a1c7e5b2d\n"]) {
      expect(BRANCH_RE.test(bad), bad).toBe(false);
    }
  });

  it("createChangePr refuses a foreign branch or path before any network call", async () => {
    await expect(client().createChangePr(input({ branch: "main" }))).rejects.toMatchObject({ kind: "rejected" });
    await expect(client().createChangePr(input({ path: "gitops/values/other.yaml" }))).rejects.toMatchObject({ kind: "rejected" });
    await expect(client().createChangePr(input({ baseCommitSha: "HEAD" }))).rejects.toMatchObject({ kind: "rejected" });
    expect(gh.calls).toHaveLength(0);
  });

  it("find/read helpers refuse foreign branches and paths without a network call", async () => {
    const c = client();
    await expect(c.findBranch("main")).rejects.toBeInstanceOf(GitWriteError);
    await expect(c.findPrByBranch("main")).rejects.toBeInstanceOf(GitWriteError);
    await expect(c.readFile("README.md", BASE_COMMIT)).rejects.toBeInstanceOf(GithubUnavailableError);
    await expect(c.compare("main", BASE_COMMIT)).rejects.toBeInstanceOf(GithubUnavailableError);
    expect(gh.calls).toHaveLength(0);
  });

  it("the client exposes no merge operation", () => {
    const names = Object.getOwnPropertyNames(GithubAppClient.prototype);
    expect(names.filter((n) => /merge|delete|update/i.test(n))).toEqual([]);
  });
});

describe("read and close helpers", () => {
  it("findBranch: sha or undefined on 404", async () => {
    gh.on("GET", /\/git\/ref\/heads\/sso\/flink-3f9a1c7e5b2d$/, () => ghJson({ object: { sha: BASE_COMMIT } }));
    expect(await client().findBranch(BRANCH)).toEqual({ sha: BASE_COMMIT });
    gh.on("GET", /\/git\/ref\/heads\//, () => ghJson({ message: "Not Found" }, 404));
    expect(await client().findBranch(BRANCH)).toBeUndefined();
  });

  it("findPrByBranch / getPr map merged state and the merge commit", async () => {
    const merged = { number: 5, html_url: PR_URL, state: "closed", merged_at: "2026-10-18T10:00:00Z", merge_commit_sha: "e".repeat(40) };
    gh.on("GET", /\/pulls\?head=/, () => ghJson([merged]));
    gh.on("GET", /\/pulls\/5$/, () => ghJson(merged));
    const expected = { number: 5, url: PR_URL, state: "closed", merged: true, mergeCommitSha: "e".repeat(40) };
    expect(await client().findPrByBranch(BRANCH)).toEqual(expected);
    expect(await client().getPr(5)).toEqual(expected);
    gh.on("GET", /\/pulls\?head=/, () => ghJson([{ number: 6, html_url: PR_URL, state: "closed", merged_at: null, merge_commit_sha: "f".repeat(40) }]));
    expect(await client().findPrByBranch(BRANCH)).toMatchObject({ merged: false, mergeCommitSha: null });
    gh.on("GET", /\/pulls\?head=/, () => ghJson([]));
    expect(await client().findPrByBranch(BRANCH)).toBeUndefined();
    gh.on("GET", /\/pulls\/9$/, () => ghJson({ message: "Not Found" }, 404));
    expect(await client().getPr(9)).toBeUndefined();
  });

  it("closePr PATCHes state=closed", async () => {
    gh.on("PATCH", /\/pulls\/42$/, () => ghJson({ number: 42, html_url: PR_URL, state: "closed", merged_at: null }));
    expect(await client().closePr(42)).toMatchObject({ number: 42, state: "closed" });
    expect(gh.calls.find((c) => c.method === "PATCH")!.body).toEqual({ state: "closed" });
    gh.on("PATCH", /\/pulls\/42$/, () => ghJson({ message: "Forbidden" }, 403));
    await expect(client().closePr(42)).rejects.toBeInstanceOf(GithubUnavailableError);
  });

  it("compare returns the status and rejects malformed answers", async () => {
    gh.on("GET", /\/compare\//, (call) => {
      expect(call.path).toContain(`/compare/${"e".repeat(40)}...${"f".repeat(40)}`);
      return ghJson({ status: "ahead" });
    });
    expect(await client().compare("e".repeat(40), "f".repeat(40))).toBe("ahead");
    gh.on("GET", /\/compare\//, () => ghJson({ status: "weird" }));
    await expect(client().compare("e".repeat(40), "f".repeat(40))).rejects.toBeInstanceOf(GithubUnavailableError);
  });

  it("listOpenSsoPrs keeps only sso/* heads", async () => {
    gh.on("GET", /\/pulls\?state=open/, () =>
      ghJson([
        { number: 1, head: { ref: "sso/flink-aaaaaaaaaaaa" } },
        { number: 2, head: { ref: "feat/x" } },
        { number: 3, head: { ref: "sso/filer-bbbbbbbbbbbb" } },
      ]),
    );
    expect(await client().listOpenSsoPrs()).toEqual([
      { number: 1, branch: "sso/flink-aaaaaaaaaaaa" },
      { number: 3, branch: "sso/filer-bbbbbbbbbbbb" },
    ]);
  });

  it("readFile decodes the contents API answer", async () => {
    gh.on("GET", /\/contents\/gitops\/values\/sso\.yaml\?ref=/, () => contents("hello\n", BASE_BLOB));
    expect(await client().readFile("gitops/values/sso.yaml", BASE_COMMIT)).toEqual({ blobSha: BASE_BLOB, text: "hello\n" });
  });
});

describe("review fixes", () => {
  // F2a (D-MSSO-19d): two instances recovering the same request race on the content write.
  it("a 422 on the content PUT is not a conflict when the branch now holds exactly the target content", async () => {
    let reads = 0;
    gh.on("GET", /\/contents\/gitops\/values\/sso\.yaml\?ref=/, () => (reads++ === 0 ? contents(OLD, BASE_BLOB) : contents(CONTENT, "c".repeat(40))));
    gh.on("PUT", /\/contents\/gitops\/values\/sso\.yaml$/, () => ghJson({ message: "sha does not match" }, 422));
    expect(await client().createChangePr(input())).toEqual({ prNumber: 42, prUrl: PR_URL });
    expect(gh.calls.some((c) => c.method === "POST" && c.path.endsWith("/pulls"))).toBe(true);
  });

  it("a 409 on the content PUT stays a conflict when the branch holds something else", async () => {
    gh.on("PUT", /\/contents\/gitops\/values\/sso\.yaml$/, () => ghJson({ message: "conflict" }, 409));
    await expect(client().createChangePr(input())).rejects.toMatchObject({ kind: "conflict" });
    expect(gh.calls.some((c) => c.path.endsWith("/pulls") && c.method === "POST")).toBe(false);
  });

  // F6 (D-MSSO-19b): one createChangePr has an overall budget, including token refresh.
  it("exceeding the overall deadline is an unknown GitWriteError and stops further GitHub calls", async () => {
    expect(CREATE_PR_DEADLINE_MS).toBe(60_000);
    gh.on("POST", /\/git\/refs$/, () => {
      clock += 40_000;
      return ghJson({ ref: "x" }, 201);
    });
    gh.on("GET", /\/contents\/gitops\/values\/sso\.yaml\?ref=/, () => {
      clock += 40_000; // 80 s in: past the 60 s budget before the PUT
      return contents(OLD, BASE_BLOB);
    });
    const error = await client().createChangePr(input()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GitWriteError);
    expect(error).toMatchObject({ kind: "unknown", message: "deadline-exceeded" });
    expect(gh.calls.some((c) => c.method === "PUT")).toBe(false);
  });

  it("a fresh createChangePr after a slow one gets its own budget", async () => {
    const c = client();
    clock += 59_000;
    await expect(c.createChangePr(input())).resolves.toMatchObject({ prNumber: 42 });
  });

  // F10: more than one page of open PRs.
  it("listOpenSsoPrs follows the Link header, at most 5 pages", async () => {
    const pages: string[] = [];
    gh.on("GET", /\/pulls\?state=open/, (call) => {
      const page = Number(new URL(`https://x${call.path}`).searchParams.get("page"));
      pages.push(String(page));
      return ghJson([{ number: page, head: { ref: `sso/flink-${String(page).padStart(12, "0")}` } }], 200, {
        link: `<https://api.github.com/repositories/1/pulls?page=${page + 1}>; rel="next"`, // never ends
      });
    });
    const found = await client().listOpenSsoPrs();
    expect(pages).toEqual(["1", "2", "3", "4", "5"]);
    expect(found.map((f) => f.number)).toEqual([1, 2, 3, 4, 5]);
  });

  it("listOpenSsoPrs stops when there is no rel=next", async () => {
    gh.on("GET", /\/pulls\?state=open/, () => ghJson([{ number: 1, head: { ref: "sso/flink-aaaaaaaaaaaa" } }]));
    expect(await client().listOpenSsoPrs()).toHaveLength(1);
    expect(gh.calls.filter((c) => c.path.includes("/pulls?state=open"))).toHaveLength(1);
  });

  // F4 (D-MSSO-19a)
  it("findPrByBranch with notBefore ignores PRs created earlier or without created_at", async () => {
    const pr = (n: number, created: string | undefined) => ({ number: n, html_url: PR_URL, state: "open", ...(created ? { created_at: created } : {}) });
    gh.on("GET", /\/pulls\?head=/, () => ghJson([pr(1, "2026-10-18T09:00:00Z"), pr(2, undefined), pr(3, "2026-10-18T09:56:00Z")]));
    const found = await client().findPrByBranch(BRANCH, Date.parse("2026-10-18T09:55:00Z"));
    expect(found?.number).toBe(3);
    expect(await client().findPrByBranch(BRANCH, Date.parse("2026-10-18T09:57:00Z"))).toBeUndefined();
    expect((await client().findPrByBranch(BRANCH))?.number).toBe(1); // no bound: unchanged behaviour
  });

  // D-MSSO-19a: the writer's own 422 fallback honours notBefore too (it used to re-adopt a stale PR).
  it("PR already exists (422): a PR older than input.notBefore is not adopted", async () => {
    gh.on("POST", /\/pulls$/, () => ghJson({ message: "Validation Failed", errors: [{ message: "A pull request already exists for x." }] }, 422));
    gh.on("GET", /\/pulls\?head=/, () => ghJson([{ number: 42, html_url: PR_URL, state: "open", created_at: new Date(T0 - 86_400_000).toISOString() }]));
    await expect(client().createChangePr(input({ notBefore: T0 - 300_000 }))).rejects.toMatchObject({ kind: "rejected" });
    gh.on("GET", /\/pulls\?head=/, () => ghJson([{ number: 43, html_url: PR_URL, state: "open", created_at: new Date(T0 - 1000).toISOString() }]));
    expect(await client().createChangePr(input({ notBefore: T0 - 300_000 }))).toEqual({ prNumber: 43, prUrl: PR_URL });
  });

  it("listOpenSsoPrs logs one warning when the page cap truncates", async () => {
    gh.on("GET", /\/pulls\?state=open/, () => ghJson([{ number: 1, head: { ref: "sso/flink-aaaaaaaaaaaa" } }], 200, { link: '<https://x/?page=9>; rel="next"' }));
    const warn = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await client().listOpenSsoPrs();
      expect(warn.mock.calls.filter((c) => String(c[0]).includes("truncated"))).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
  });
});
