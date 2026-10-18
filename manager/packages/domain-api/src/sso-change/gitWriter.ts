// D-MSSO-10: the Git write side of a change request. In rollout 3 no production implementation is wired (submit
// answers 503 GIT_WRITER_UNCONFIGURED before touching the database); rollout 4 plugs in the GitHub App writer.
// The contract is deliberately narrow: create ONE branch from a fixed commit and open ONE pull request. There is
// no merge operation on this interface and none may be added (the owner merges after independent review).

export interface CreateChangePrInput {
  /** sso/<endpoint>-<first 12 chars of the idempotency key>. */
  branch: string;
  /** The branch is created from this commit, the same commit whose blob was checked (D-MSSO-9). */
  baseCommitSha: string;
  /** Passed as `sha` of the file write; a mismatch on the git side is a conflict. */
  baseBlobSha: string;
  /** Server constant gitops/values/sso.yaml. */
  path: string;
  content: string;
  title: string;
  body: string;
  /** D-MSSO-19: full commit message (subject, blank line, Requested-by trailer). */
  commitMessage: string;
}

export interface CreatedPr {
  prNumber: number;
  prUrl: string;
}

/**
 * conflict: git refused the write because main/the blob moved (HTTP 409/422 from GitHub) -> request `failed`, 409.
 * rejected: git definitively refused for another reason -> request `failed`, 502.
 * unknown: timeout/transport; the PR may or may not exist -> `unknown_recovering`, 502 (rollout 4 recovers).
 * Any other thrown error is treated as `unknown` (never assume the PR was not created).
 */
/**
 * D-MSSO-19b: overall budget of ONE createChangePr (every GitHub call, retry and token refresh inside it). Must stay
 * below the reconciler's SUBMITTED_GRACE_MS (120 s), after which a `submitted` row is presumed orphaned and recovered:
 * a still-running writer must have given up by then. Cost: a very slow GitHub turns into `unknown_recovering` after
 * 60 s instead of hanging. Escape hatch: GithubAppOptions.createDeadlineMs.
 */
export const CREATE_PR_DEADLINE_MS = 60_000;

export class GitWriteError extends Error {
  constructor(
    public readonly kind: "conflict" | "rejected" | "unknown",
    message: string,
  ) {
    super(message);
    this.name = "GitWriteError";
  }
}

export interface GitWriter {
  createChangePr(input: CreateChangePrInput): Promise<CreatedPr>;
}

// D-MSSO-18/19: what the rest of the change-request flow needs from GitHub beyond creating the PR. Still no merge.
export interface PrInfo {
  number: number;
  url: string;
  /** ISO time GitHub created the PR; used by D-MSSO-19a to refuse a PR that predates the request. */
  createdAt?: string | undefined;
  state: "open" | "closed";
  merged: boolean;
  mergeCommitSha: string | null;
}

export type CompareStatus = "identical" | "ahead" | "behind" | "diverged";

/** GitHub could not be asked (timeout, transport, 5xx, rate limit) or answered something unusable. Never a verdict. */
export class GithubUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GithubUnavailableError";
  }
}

export interface GitChangeOps extends GitWriter {
  findBranch(branch: string): Promise<{ sha: string } | undefined>;
  /**
   * D-MSSO-19a: when `notBefore` (epoch ms) is given, a PR created earlier is NOT returned (it belongs to an older
   * request that used the same branch name). A PR without a parseable created_at is not returned either.
   */
  findPrByBranch(branch: string, notBefore?: number): Promise<PrInfo | undefined>;
  getPr(number: number): Promise<PrInfo | undefined>;
  closePr(number: number): Promise<PrInfo>;
  /** GET compare/{base}...{head}: is `head` identical to / ahead of `base`? */
  compare(base: string, head: string): Promise<CompareStatus>;
  /** Open pull requests whose head branch starts with sso/ (orphan logging only). */
  listOpenSsoPrs(): Promise<{ number: number; branch: string }[]>;
  /** Only sso.yaml and policies/groups.yaml may be read. */
  readFile(path: string, ref: string): Promise<{ blobSha: string; text: string }>;
}
