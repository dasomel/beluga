import type { ChangeRecord, SsoChangeStore } from "../store/ssoChangeStore.js";
import type { GitChangeOps } from "./gitWriter.js";

// D-MSSO-18c: a PR was created (or found) for a request, but the CAS to pr_open lost and the request is already
// terminal (cancelled -> failed, or rejected). Nobody tracks that PR any more and it could still be merged by
// mistake, so close it. Best effort: a failure is logged (the audit trail then shows the orphan) and the next
// reconciler tick logs the still-open sso/* PR as an orphan. Never throws. Cost: one extra GitHub call and one
// audit row in a rare race. Escape hatch: close the PR by hand; nothing else depends on it.

export function isTerminalLoss(stage: ChangeRecord["stage"]): boolean {
  return stage === "failed" || stage === "rejected";
}

export async function closeOrphanPr(
  store: SsoChangeStore,
  git: GitChangeOps,
  current: ChangeRecord,
  prNumber: number,
  actor: { sub: string; username?: string | null },
  log: (line: string) => void,
): Promise<void> {
  let closed = true;
  try {
    await git.closePr(prNumber);
  } catch (error) {
    closed = false;
    log(`could not close orphan pull request #${prNumber} of request ${current.id}: ${error instanceof Error ? error.message : "unexpected error"}`);
  }
  try {
    await store.recordEvent({
      requestId: current.id,
      stage: current.stage,
      actorSub: actor.sub,
      actorUsername: actor.username ?? null,
      endpoint: current.endpoint,
      prNumber,
      detail: { compensation: closed ? "closed_orphan_pr" : "close_orphan_pr_failed", prNumber },
    });
  } catch (error) {
    log(`could not record closed_orphan_pr for request ${current.id}: ${error instanceof Error ? error.message : "unexpected error"}`);
  }
}
