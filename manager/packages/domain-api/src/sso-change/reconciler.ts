import { gitBlobSha, parseGroupNames } from "../adapters/sso/ssoAdapter.js";
import { GROUPS_FILE_PATH } from "../adapters/sso/githubSsoAdapter.js";
import type { ChangeRecord, SsoChangeStore, TransitionFields } from "../store/ssoChangeStore.js";
import { ARGOCD_APPS, type ArgocdPort } from "./argocdReader.js";
import { closeOrphanPr, isTerminalLoss } from "./compensation.js";
import { buildChange, SSO_FILE_PATH } from "./editEngine.js";
import { GitWriteError, type GitChangeOps } from "./gitWriter.js";
import { commitMessage, prBody, prTitle } from "./prText.js";

// D-MSSO-18: the in-process reconciler. Moves requests along submitted/unknown_recovering -> pr_open -> merged ->
// applied by asking GitHub (and ArgoCD, D-MSSO-16/17). Every transition is a compare-and-set on the stage it
// read, so a second replica or a racing cancel cannot double-transition (a lost CAS is a silent no-op). Errors in
// a tick are logged and retried next tick; they never change a stage except through the rules below.

export const DEFAULT_RECONCILE_INTERVAL_MS = 30_000;
export const MIN_RECONCILE_INTERVAL_MS = 5_000;
/** A `submitted` row younger than this may still be inside the submit route's own GitHub call. */
export const SUBMITTED_GRACE_MS = 120_000;
const LIST_LIMIT = 100;
/** D-MSSO-19a: a PR found by branch must have been created no earlier than the request minus this skew. */
export const PR_ADOPT_SKEW_MS = 5 * 60_000;
/** D-MSSO-18d: shutdown waits at most this long for the tick in flight. */
export const SHUTDOWN_DRAIN_MS = 10_000;

export interface Timer {
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export interface ReconcilerOptions {
  store: SsoChangeStore;
  git: GitChangeOps;
  /** Undefined = D-MSSO-16 reader not configured: `merged` requests simply stay `merged`. */
  argocd?: ArgocdPort | undefined;
  baseDomain: string;
  intervalMs?: number;
  now?: () => number;
  timer?: Timer;
  log?: (message: string) => void;
}

const realTimer: Timer = {
  setInterval: (fn, ms) => {
    const handle = setInterval(fn, ms);
    handle.unref(); // never keep the process alive for the reconciler
    return handle;
  },
  clearInterval: (handle) => clearInterval(handle as NodeJS.Timeout),
};

const message = (error: unknown): string => (error instanceof Error ? error.message : "unexpected error");

export class SsoChangeReconciler {
  private readonly store: SsoChangeStore;
  private readonly git: GitChangeOps;
  private readonly argocd: ArgocdPort | undefined;
  private readonly baseDomain: string;
  private readonly intervalMs: number;
  private readonly now: () => number;
  private readonly timer: Timer;
  private readonly log: (message: string) => void;
  private handle: unknown;
  private running = false;
  private inflight: Promise<void> | undefined;
  private readonly loggedOrphans = new Set<number>();

  constructor(options: ReconcilerOptions) {
    this.store = options.store;
    this.git = options.git;
    this.argocd = options.argocd;
    this.baseDomain = options.baseDomain;
    this.intervalMs = Math.max(options.intervalMs ?? DEFAULT_RECONCILE_INTERVAL_MS, MIN_RECONCILE_INTERVAL_MS);
    this.now = options.now ?? Date.now;
    this.timer = options.timer ?? realTimer;
    this.log = options.log ?? ((line) => console.error(`[sso-reconciler] ${line}`));
  }

  start(): void {
    if (this.handle !== undefined) return;
    this.handle = this.timer.setInterval(() => void this.tick(), this.intervalMs);
  }

  stop(): void {
    if (this.handle === undefined) return;
    this.timer.clearInterval(this.handle);
    this.handle = undefined;
  }

  /**
   * D-MSSO-18d: stop the timer, then wait (at most `timeoutMs`) for the tick in flight, so a SIGTERM does not cut a
   * GitHub write + CAS in half. Cost: up to `timeoutMs` of delay before exit. Whatever is left is repaired by the
   * next replica's tick (D-MSSO-18 recovery).
   */
  async stopAndDrain(timeoutMs: number = SHUTDOWN_DRAIN_MS): Promise<void> {
    this.stop();
    if (this.inflight === undefined) return;
    let timer: NodeJS.Timeout | undefined;
    const limit = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
    });
    try {
      await Promise.race([this.inflight, limit]);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Single-flight inside the process (a tick that starts while the previous one runs is skipped) AND across
   * replicas (D-MSSO-18b): the tick body runs under the store's DB lease; not acquired = skipped.
   */
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.inflight = this.guardedTick().finally(() => {
      this.running = false;
      this.inflight = undefined;
    });
    return this.inflight;
  }

  private async guardedTick(): Promise<void> {
    try {
      await this.store.withReconcilerLease(() => this.tickBody());
    } catch (error) {
      this.log(`tick failed: ${message(error)}`);
    }
  }

  private async tickBody(): Promise<void> {
    let records: ChangeRecord[];
    try {
      records = await this.store.listOpen(LIST_LIMIT);
    } catch (error) {
      this.log(`could not list open requests: ${message(error)}`);
      return;
    }
    for (const record of records) {
      try {
        await this.reconcile(record);
      } catch (error) {
        this.log(`request ${record.id} (${record.stage}): ${message(error)}`);
      }
    }
    await this.logOrphans(records);
  }

  private async reconcile(record: ChangeRecord): Promise<void> {
    switch (record.stage) {
      case "submitted":
        if (this.now() - Date.parse(record.updatedAt) < SUBMITTED_GRACE_MS) return;
        return this.recover(record);
      case "unknown_recovering":
        return this.recover(record);
      case "pr_open":
        return this.checkPr(record);
      case "merged":
        return this.checkApplied(record);
      default:
        return;
    }
  }

  private async move(record: ChangeRecord, stage: ChangeRecord["stage"], fields: TransitionFields, reason: string, detail?: unknown) {
    // undefined = lost CAS: somebody else moved it; nothing to do, and the store wrote no event.
    return this.store.transition(record.id, record.stage, stage, fields, { reason, detail: { source: "reconciler", ...(detail as object) } });
  }

  // D-MSSO-18c: move to pr_open; if the CAS is lost and the request meanwhile ended failed/rejected (cancel, or
  // another replica), the PR we hold is an orphan nobody tracks: close it (best effort) and audit that.
  private async openPr(record: ChangeRecord, pr: { number: number; url: string }, reason: string, closeIfOrphan: boolean): Promise<void> {
    const moved = await this.move(record, "pr_open", { prNumber: pr.number, prUrl: pr.url }, reason);
    if (moved !== undefined || !closeIfOrphan) return;
    const current = await this.store.get(record.id);
    if (current !== undefined && isTerminalLoss(current.stage)) {
      await closeOrphanPr(this.store, this.git, current, pr.number, { sub: "system:reconciler" }, this.log);
    }
  }

  // submitted (process died mid-call) and unknown_recovering: find out what GitHub actually has.
  private async recover(record: ChangeRecord): Promise<void> {
    // D-MSSO-19a: only a PR created after the request (minus clock skew) can be this request's PR.
    const pr = await this.git.findPrByBranch(record.branch, Date.parse(record.createdAt) - PR_ADOPT_SKEW_MS);
    if (pr !== undefined) {
      await this.openPr(record, pr, "pull request found on GitHub", pr.state === "open");
      return;
    }
    if ((await this.git.findBranch(record.branch)) === undefined) {
      await this.move(record, "failed", {}, "not found on GitHub", { reason: "not found on GitHub" });
      return;
    }
    // Branch only: re-run the idempotent writer. D-MSSO-18e: the ADR state diagram is unknown_recovering ->
    // submitted -> pr_open, so the first hop is its own audited CAS (it also refreshes updated_at, which keeps
    // a concurrent cancel out via REQUEST_IN_FLIGHT while we write). Cost: one extra audit row per recovery.
    const rebuilt = await this.rebuild(record); // before the hop: a request that cannot be rebuilt stays as it is
    let current = record;
    if (record.stage === "unknown_recovering") {
      const resubmitted = await this.move(record, "submitted", {}, "re-running the idempotent writer");
      if (resubmitted === undefined) return;
      current = resubmitted;
    } else {
      // D-MSSO-18h: a stale `submitted` row gets the same protection: a CAS submitted -> submitted refreshes
      // updated_at, so cancel answers REQUEST_IN_FLIGHT for the whole bounded write (createChangePr <= 60 s <
      // 120 s grace) and cannot turn the row `failed` under a PR we are about to create. One audit event
      // ({recovery:"started"}) per recovery, same cost as the hop above. A lost CAS = somebody else moved it: skip.
      const touched = await this.move(record, "submitted", {}, "re-running the idempotent writer", { recovery: "started" });
      if (touched === undefined) return;
      current = touched;
    }
    let created;
    try {
      created = await this.git.createChangePr(rebuilt);
    } catch (error) {
      if (error instanceof GitWriteError && error.kind !== "unknown") {
        await this.move(current, "failed", {}, error.kind === "conflict" ? "git conflict" : "git write rejected");
        return;
      }
      throw error;
    }
    await this.openPr(current, { number: created.prNumber, url: created.prUrl }, "pull request recreated", true);
  }

  // The request row does not keep the edited file, so rebuild it exactly as the submit did: same base commit, same
  // patch, same engine. A base blob that does not match the record means the rebuild would not be the reviewed change.
  private async rebuild(record: ChangeRecord) {
    const [sso, groups] = await Promise.all([
      this.git.readFile(SSO_FILE_PATH, record.sourceCommitSha),
      this.git.readFile(GROUPS_FILE_PATH, record.sourceCommitSha),
    ]);
    if (sso.blobSha !== record.baseBlobSha || gitBlobSha(sso.text) !== record.baseBlobSha) {
      throw new Error("base blob at the recorded commit does not match the request");
    }
    const change = buildChange({
      baseText: sso.text,
      baseDomain: this.baseDomain,
      groupNames: parseGroupNames(groups.text, `${GROUPS_FILE_PATH} at ${record.sourceCommitSha}`),
      patch: { endpoint: record.endpoint, allowedGroups: record.patch.allowedGroups },
    });
    return {
      branch: record.branch,
      baseCommitSha: record.sourceCommitSha,
      baseBlobSha: record.baseBlobSha,
      path: SSO_FILE_PATH,
      content: change.editedText,
      notBefore: Date.parse(record.createdAt) - PR_ADOPT_SKEW_MS,
      title: prTitle(record.endpoint),
      commitMessage: commitMessage({ endpoint: record.endpoint, username: record.actorUsername ?? undefined, sub: record.actorSub }),
      body: prBody({
        username: record.actorUsername ?? undefined,
        sub: record.actorSub,
        reason: "(not available: the pull request was recreated by the recovery pass)",
        baseBlobSha: record.baseBlobSha,
        sourceCommitSha: record.sourceCommitSha,
        diff: change.diff,
      }),
    };
  }

  private async checkPr(record: ChangeRecord): Promise<void> {
    const pr =
      record.prNumber !== null
        ? await this.git.getPr(record.prNumber)
        : await this.git.findPrByBranch(record.branch, Date.parse(record.createdAt) - PR_ADOPT_SKEW_MS);
    if (pr === undefined || pr.state === "open") return;
    if (pr.merged && pr.mergeCommitSha !== null) {
      await this.move(record, "merged", { mergeCommitSha: pr.mergeCommitSha }, "pull request merged");
    } else if (!pr.merged) {
      await this.move(record, "rejected", {}, "pull request closed without merge");
    }
  }

  // D-MSSO-17: BOTH Applications Synced AND their synced revision is the merge commit or a descendant of it.
  private async checkApplied(record: ChangeRecord): Promise<void> {
    if (this.argocd === undefined || record.mergeCommitSha === null) return;
    for (const name of ARGOCD_APPS) {
      const app = await this.argocd.getApplication(name);
      if (app.syncStatus !== "Synced" || app.revision === undefined) return;
      const relation = await this.git.compare(record.mergeCommitSha, app.revision);
      if (relation !== "identical" && relation !== "ahead") return;
    }
    await this.move(record, "applied", {}, "both Applications synced at or after the merge commit");
  }

  // Open sso/* PRs that no active request owns are logged once per PR number and never adopted.
  private async logOrphans(records: ChangeRecord[]): Promise<void> {
    try {
      const owned = new Set(records.map((r) => r.branch));
      for (const pr of await this.git.listOpenSsoPrs()) {
        if (owned.has(pr.branch) || this.loggedOrphans.has(pr.number)) continue;
        this.loggedOrphans.add(pr.number);
        this.log(`orphan pull request #${pr.number} (${pr.branch}) has no change request; not adopting it`);
      }
    } catch (error) {
      this.log(`could not list open sso/* pull requests: ${message(error)}`);
    }
  }
}
