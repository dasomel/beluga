import { beforeEach, describe, expect, it } from "vitest";
import { gitBlobSha } from "../src/adapters/sso/ssoAdapter.js";
import { ArgocdError, type ArgocdAppStatus, type ArgocdPort } from "../src/sso-change/argocdReader.js";
import { SsoChangeReconciler, SUBMITTED_GRACE_MS, type Timer } from "../src/sso-change/reconciler.js";
import type { ChangeRecord } from "../src/store/ssoChangeStore.js";
import { FakeAdapter, FakeGitWriter, FakeStore, KEY_A, PR_URL } from "./helpers/ssoChange.js";

const T0 = Date.parse("2026-10-18T10:00:00Z");
const BRANCH = "sso/flink-3f9a1c7e5b2d";
const MERGE = "e".repeat(40);
const APP_REV = "f".repeat(40);

let store: FakeStore;
let git: FakeGitWriter;
let argocd: FakeArgocd;
let adapter: FakeAdapter;
let logs: string[];
let clock: number;

class FakeArgocd implements ArgocdPort {
  apps: Record<string, ArgocdAppStatus | Error> = {
    "beluga-platform": { name: "beluga-platform", syncStatus: "Synced", revision: APP_REV },
    "beluga-data": { name: "beluga-data", syncStatus: "Synced", revision: APP_REV },
  };
  async getApplication(name: string) {
    const app = this.apps[name];
    if (app === undefined || app instanceof Error) throw app ?? new ArgocdError("http-404");
    return app;
  }
}

function reconciler(over: { argocd?: ArgocdPort | undefined; timer?: Timer; intervalMs?: number } = {}) {
  return new SsoChangeReconciler({
    store,
    git,
    argocd: "argocd" in over ? over.argocd : argocd,
    baseDomain: "local.beluga.internal",
    now: () => clock,
    log: (line) => logs.push(line),
    ...(over.timer ? { timer: over.timer } : {}),
    ...(over.intervalMs !== undefined ? { intervalMs: over.intervalMs } : {}),
  });
}

/** A request in `stage`, created `ageMs` ago, whose base is the fixture sso.yaml at adapter.commitSha. */
async function seed(stage: ChangeRecord["stage"], over: Partial<ChangeRecord> = {}, ageMs = SUBMITTED_GRACE_MS + 1000): Promise<ChangeRecord> {
  const { record } = await store.submit({
    filePath: "gitops/values/sso.yaml",
    endpoint: "flink",
    idempotencyKey: KEY_A,
    payloadSha256: "p".repeat(64),
    baseBlobSha: gitBlobSha(adapter.text),
    sourceCommitSha: adapter.commitSha,
    allowedGroups: ["admins", "analysts"],
    actorSub: "u-admin",
    actorUsername: "alice",
    branch: BRANCH,
  });
  const next = { ...record, stage, updatedAt: new Date(clock - ageMs).toISOString(), ...over };
  store.requests.set(record.id, next);
  store.events.length = 0;
  return next;
}
const stageOf = (r: ChangeRecord) => store.requests.get(r.id)!.stage;
const open = (number = 42, over: Partial<{ state: "open" | "closed"; merged: boolean; mergeCommitSha: string | null }> = {}) => ({
  number,
  url: PR_URL,
  state: "open" as const,
  merged: false,
  mergeCommitSha: null,
  ...over,
});

beforeEach(() => {
  clock = T0;
  store = new FakeStore();
  git = new FakeGitWriter();
  argocd = new FakeArgocd();
  adapter = new FakeAdapter();
  logs = [];
  git.files.set(`gitops/values/sso.yaml@${adapter.commitSha}`, { blobSha: gitBlobSha(adapter.text), text: adapter.text });
  git.files.set(`policies/groups.yaml@${adapter.commitSha}`, { blobSha: "1".repeat(40), text: adapter.groupsText });
});

describe("submitted / unknown_recovering recovery (D-MSSO-18)", () => {
  it("a submitted row younger than 120 s is left alone (the submit call may still be running)", async () => {
    const r = await seed("submitted", {}, SUBMITTED_GRACE_MS - 1000);
    git.prs.set(BRANCH, open());
    await reconciler().tick();
    expect(stageOf(r)).toBe("submitted");
    expect(store.events).toHaveLength(0);
  });

  it.each(["submitted", "unknown_recovering"] as const)("%s + PR found -> pr_open with number and url", async (stage) => {
    const r = await seed(stage);
    git.prs.set(BRANCH, open(17));
    await reconciler().tick();
    expect(store.requests.get(r.id)).toMatchObject({ stage: "pr_open", prNumber: 17, prUrl: PR_URL });
    expect(store.events).toMatchObject([{ stage: "pr_open", requestId: r.id }]);
    expect(git.calls).toHaveLength(0);
  });

  it("branch but no PR -> the idempotent writer is re-run with the rebuilt change -> pr_open", async () => {
    const r = await seed("unknown_recovering");
    git.branches.add(BRANCH);
    await reconciler().tick();
    expect(stageOf(r)).toBe("pr_open");
    expect(git.calls).toHaveLength(1);
    const sent = git.calls[0]!;
    expect(sent).toMatchObject({ branch: BRANCH, baseCommitSha: adapter.commitSha, baseBlobSha: r.baseBlobSha, path: "gitops/values/sso.yaml" });
    expect(sent.content).toContain('- "analysts"');
    expect(sent.commitMessage).toBe("chore(sso): flink allowedGroups via Manager\n\nRequested-by: alice (u-admin)");
    expect(sent.body).toContain("recreated by the recovery pass");
  });

  it("branch but no PR, writer reports conflict or rejection -> failed; unknown -> unchanged", async () => {
    for (const [outcome, expected] of [["conflict", "failed"], ["rejected", "failed"], ["unknown", "unknown_recovering"], ["throw", "unknown_recovering"]] as const) {
      store = new FakeStore();
      git.outcome = outcome;
      git.branches.add(BRANCH);
      const r = await seed("unknown_recovering");
      await reconciler().tick();
      expect(stageOf(r), outcome).toBe(expected);
    }
  });

  it("neither branch nor PR -> failed with reason 'not found on GitHub'", async () => {
    const r = await seed("unknown_recovering");
    await reconciler().tick();
    expect(stageOf(r)).toBe("failed");
    expect(store.events[0]).toMatchObject({ stage: "failed", reason: "not found on GitHub", detail: { reason: "not found on GitHub", source: "reconciler" } });
  });

  it("a base blob that no longer matches the record is never rebuilt into a PR", async () => {
    const r = await seed("unknown_recovering", { baseBlobSha: "9".repeat(40) });
    git.branches.add(BRANCH);
    await reconciler().tick();
    expect(stageOf(r)).toBe("unknown_recovering");
    expect(git.calls).toHaveLength(0);
    expect(logs.join("\n")).toContain("does not match");
  });

  it("GitHub errors keep the stage and are retried next tick", async () => {
    const r = await seed("unknown_recovering");
    git.failing.add("findPrByBranch");
    await reconciler().tick();
    expect(stageOf(r)).toBe("unknown_recovering");
    expect(logs.join("\n")).toContain(r.id);
    git.failing.clear();
    git.prs.set(BRANCH, open());
    await reconciler().tick();
    expect(stageOf(r)).toBe("pr_open");
  });
});

describe("pr_open", () => {
  it("merged -> merged with the merge commit; closed without merge -> rejected; still open -> unchanged", async () => {
    const r = await seed("pr_open", { prNumber: 42, prUrl: PR_URL });
    git.prs.set(BRANCH, open(42));
    await reconciler().tick();
    expect(stageOf(r)).toBe("pr_open");
    expect(store.events).toHaveLength(0);

    git.prs.set(BRANCH, open(42, { state: "closed", merged: true, mergeCommitSha: MERGE }));
    await reconciler().tick();
    expect(store.requests.get(r.id)).toMatchObject({ stage: "merged", mergeCommitSha: MERGE });
  });

  it("closed without merge -> rejected", async () => {
    const r = await seed("pr_open", { prNumber: 43 });
    git.prs.set(BRANCH, open(43, { state: "closed", merged: false }));
    await reconciler().tick();
    expect(stageOf(r)).toBe("rejected");
  });

  it("a merged PR whose merge commit is unknown is not moved", async () => {
    const r = await seed("pr_open", { prNumber: 42 });
    git.prs.set(BRANCH, open(42, { state: "closed", merged: true, mergeCommitSha: null }));
    await reconciler().tick();
    expect(stageOf(r)).toBe("pr_open");
  });

  it("a GitHub error keeps pr_open", async () => {
    const r = await seed("pr_open", { prNumber: 42 });
    git.failing.add("getPr");
    await reconciler().tick();
    expect(stageOf(r)).toBe("pr_open");
  });
});

describe("merged -> applied (D-MSSO-17)", () => {
  const seedMerged = () => seed("merged", { prNumber: 42, mergeCommitSha: MERGE });
  const relation = (status: "identical" | "ahead" | "behind" | "diverged") => git.compareResults.set(`${MERGE}...${APP_REV}`, status);

  it.each(["identical", "ahead"] as const)("both Applications Synced and revision %s -> applied", async (status) => {
    const r = await seedMerged();
    relation(status);
    await reconciler().tick();
    expect(stageOf(r)).toBe("applied");
  });

  it.each(["behind", "diverged"] as const)("revision %s -> stays merged", async (status) => {
    const r = await seedMerged();
    relation(status);
    await reconciler().tick();
    expect(stageOf(r)).toBe("merged");
  });

  it("one Application OutOfSync (even if the other is fine) -> stays merged", async () => {
    const r = await seedMerged();
    relation("ahead");
    argocd.apps["beluga-data"] = { name: "beluga-data", syncStatus: "OutOfSync", revision: APP_REV };
    await reconciler().tick();
    expect(stageOf(r)).toBe("merged");
  });

  it("one Application missing / erroring / without revision -> stays merged", async () => {
    const r = await seedMerged();
    relation("identical");
    argocd.apps["beluga-platform"] = new ArgocdError("http-404");
    await reconciler().tick();
    expect(stageOf(r)).toBe("merged");
    argocd.apps["beluga-platform"] = { name: "beluga-platform", syncStatus: "Synced", revision: undefined };
    await reconciler().tick();
    expect(stageOf(r)).toBe("merged");
    expect(logs.length).toBeGreaterThan(0);
  });

  it("a compare failure keeps merged; no ArgoCD reader keeps merged", async () => {
    const r = await seedMerged();
    relation("identical");
    git.failing.add("compare");
    await reconciler().tick();
    expect(stageOf(r)).toBe("merged");
    git.failing.clear();
    await reconciler({ argocd: undefined }).tick();
    expect(stageOf(r)).toBe("merged");
    await reconciler().tick();
    expect(stageOf(r)).toBe("applied");
  });
});

describe("compare-and-set", () => {
  it("a lost CAS (a racing cancel moved the row) is a silent no-op: no event, no overwrite", async () => {
    const r = await seed("pr_open", { prNumber: 42 });
    git.prs.set(BRANCH, open(42, { state: "closed", merged: true, mergeCommitSha: MERGE }));
    const getPr = git.getPr.bind(git);
    git.getPr = async (n: number) => {
      const pr = await getPr(n);
      store.requests.set(r.id, { ...store.requests.get(r.id)!, stage: "failed" }); // cancel wins between read and write
      return pr;
    };
    await reconciler().tick();
    expect(stageOf(r)).toBe("failed");
    expect(store.events).toHaveLength(0);
  });

  it("two reconcilers on the same row produce exactly one transition event", async () => {
    const r = await seed("pr_open", { prNumber: 42 });
    git.prs.set(BRANCH, open(42, { state: "closed", merged: true, mergeCommitSha: MERGE }));
    await Promise.all([reconciler().tick(), reconciler().tick()]);
    expect(stageOf(r)).toBe("merged");
    expect(store.events.filter((e) => e.stage === "merged")).toHaveLength(1);
  });

  it("a database error while transitioning is logged and does not stop other requests' reconciliation", async () => {
    const r = await seed("unknown_recovering");
    git.prs.set(BRANCH, open());
    store.failTransitions = true;
    await reconciler().tick();
    expect(stageOf(r)).toBe("unknown_recovering");
    expect(logs.join("\n")).toContain(r.id);
  });
});

describe("orphans", () => {
  it("an open sso/* PR with no request is logged once per PR number and never adopted", async () => {
    await seed("pr_open", { prNumber: 42 });
    git.prs.set(BRANCH, open(42));
    git.openSsoPrs = [
      { number: 42, branch: BRANCH }, // owned
      { number: 99, branch: "sso/filer-aaaaaaaaaaaa" }, // orphan
    ];
    const rec = reconciler();
    await rec.tick();
    await rec.tick();
    await rec.tick();
    const orphanLines = logs.filter((l) => l.includes("orphan"));
    expect(orphanLines).toHaveLength(1);
    expect(orphanLines[0]).toContain("#99");
    expect(store.requests.size).toBe(1);
    git.openSsoPrs.push({ number: 100, branch: "sso/filer-bbbbbbbbbbbb" });
    await rec.tick();
    expect(logs.filter((l) => l.includes("orphan"))).toHaveLength(2);
  });

  it("a failing orphan scan is logged and harmless", async () => {
    const r = await seed("pr_open", { prNumber: 42 });
    git.prs.set(BRANCH, open(42, { state: "closed", merged: true, mergeCommitSha: MERGE }));
    git.failing.add("listOpenSsoPrs");
    await reconciler().tick();
    expect(stageOf(r)).toBe("merged");
    expect(logs.join("\n")).toContain("could not list open sso/* pull requests");
  });
});

describe("scheduling", () => {
  it("is single-flight: a tick that starts while another is running is skipped", async () => {
    await seed("pr_open", { prNumber: 42 });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let getPrCalls = 0;
    git.getPr = async () => {
      getPrCalls++;
      await gate;
      return open(42);
    };
    const rec = reconciler();
    const first = rec.tick();
    await rec.tick(); // returns immediately
    expect(getPrCalls).toBe(1);
    release();
    await first;
    await rec.tick();
    expect(getPrCalls).toBe(2);
  });

  it("start/stop use the injected timer; the interval is clamped to 5 s; start is idempotent", () => {
    const calls: { ms: number }[] = [];
    const cleared: unknown[] = [];
    const timer: Timer = {
      setInterval: (_fn, ms) => {
        calls.push({ ms });
        return `h${calls.length}`;
      },
      clearInterval: (h) => cleared.push(h),
    };
    const rec = reconciler({ timer, intervalMs: 1000 });
    rec.start();
    rec.start();
    expect(calls).toEqual([{ ms: 5000 }]);
    rec.stop();
    rec.stop();
    expect(cleared).toEqual(["h1"]);
  });

  it("a store outage on listing is logged; the next tick works", async () => {
    const r = await seed("pr_open", { prNumber: 42 });
    git.prs.set(BRANCH, open(42, { state: "closed", merged: true, mergeCommitSha: MERGE }));
    store.down = true;
    const rec = reconciler();
    await rec.tick();
    expect(logs.join("\n")).toContain("could not list open requests");
    store.down = false;
    await rec.tick();
    expect(stageOf(r)).toBe("merged");
  });
});
