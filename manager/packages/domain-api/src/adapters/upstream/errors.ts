// Upstream failure taxonomy shared by the read-only upstream adapters (issues #17/#36).
// Adapters never throw anything else past their boundary, and an UpstreamError never carries
// a response body, a URL query string or a credential: message = upstream label + kind + status.
export type UpstreamErrorKind =
  | "unreachable" // DNS/connect/TLS failure
  | "timeout"
  | "unauthenticated" // 401 (or no credential available) -> Manager's credential is missing/expired
  | "forbidden" // 403 -> Manager's credential is not allowed; never expose partial data
  | "not_found" // 404
  | "upstream_error" // 5xx or any other unexpected status
  | "overloaded" // local concurrency cap / queue full: request shed without calling the upstream
  | "malformed"; // body is not the JSON shape the spec promises

export class UpstreamError extends Error {
  constructor(
    readonly kind: UpstreamErrorKind,
    readonly upstream: string,
    readonly status?: number,
  ) {
    super(`Upstream '${upstream}' request failed: ${kind}${status === undefined ? "" : ` (HTTP ${status})`}`);
    this.name = "UpstreamError";
  }
}

export const isUpstreamError = (error: unknown): error is UpstreamError => error instanceof UpstreamError;

// Coarse, caller-safe description for routes (no upstream detail beyond the failure class).
export function describeUpstreamFailure(error: unknown, subject: string): string {
  if (isUpstreamError(error) && (error.kind === "forbidden" || error.kind === "unauthenticated")) {
    return `${subject} is unavailable: the upstream did not accept Manager's service credential`;
  }
  return `${subject} is currently unavailable`;
}
