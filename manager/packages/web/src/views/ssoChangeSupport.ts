import { ApiError } from '../api/client';
import type { SsoChangeDraft, SsoChangeStage } from '../api/types';
import type { Translations } from '../i18n/translations';

// D-MSSO-13: pure helpers for the SSO change UI. None of them decides whether a change is valid.

const ADMIN_GROUP = 'admins';

// Keycloak group paths arrive as `/admins` or `admins` depending on the mapper (D-MSSO-14 note).
export function isSsoAdmin(groups: readonly string[] | undefined): boolean {
  return (groups ?? []).some((group) => group.replace(/^\/+/, '') === ADMIN_GROUP);
}

// 32 lowercase hex characters, the server's Idempotency-Key format.
export function newIdempotencyKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

// Identity of a draft for key reuse: the same fingerprint is a retry (same key), a different one is a new
// request (new key). baseBlobSha is included because it is part of the submitted payload.
export function draftFingerprint(draft: SsoChangeDraft, baseBlobSha: string): string {
  return JSON.stringify([draft.endpoint, [...draft.allowedGroups].sort(), draft.reason ?? '', baseBlobSha]);
}

export function stageLabel(t: Translations, stage: SsoChangeStage): string {
  const c = t.sso.change;
  switch (stage) {
    case 'submitted':
      return c.stageSubmitted;
    case 'pr_open':
      return c.stagePrOpen;
    case 'unknown_recovering':
      return c.stageUnknownRecovering;
    case 'merged':
      return c.stageMerged;
    case 'applied':
      return c.stageApplied;
    case 'rejected':
      return c.stageRejected;
    case 'failed':
      return c.stageFailed;
  }
}

export interface DisplayedError {
  message: string;
  /** Server-provided text for the same error, when it differs from our message. */
  detail?: string;
}

export function describeSsoError(t: Translations, error: unknown): DisplayedError {
  const c = t.sso.change;
  if (!(error instanceof ApiError)) {
    return { message: c.errGeneric, detail: error instanceof Error ? error.message : undefined };
  }
  const byCode: Record<string, string> = {
    STALE_BASE: c.errStaleBase,
    OPEN_REQUEST_EXISTS: c.errOpenRequestExists,
    GIT_WRITER_UNCONFIGURED: c.errGitWriterUnconfigured,
    AUDIT_UNAVAILABLE: c.errAuditUnavailable,
    CONSUMER_NOT_DEPLOYED: c.errConsumerNotDeployed,
    NO_EFFECTIVE_CHANGE: c.errNoEffectiveChange,
    PATCH_REJECTED: c.errPatchRejected,
    REQUEST_NOT_ACTIVE: c.errRequestNotActive,
    GITHUB_UNAVAILABLE: c.errGithubUnavailable,
    FORBIDDEN: c.errForbidden,
    IDEMPOTENCY_MISMATCH: c.errIdempotencyMismatch,
    IDEMPOTENCY_KEY_COLLISION: c.errIdempotencyKeyCollision,
    REQUEST_IN_FLIGHT: c.errRequestInFlight,
  };
  const message = (error.code !== undefined ? byCode[error.code] : undefined) ?? (error.status === 403 ? c.errForbidden : c.errGeneric);
  return { message, detail: error.detail };
}
