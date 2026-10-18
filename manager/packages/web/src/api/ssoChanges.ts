import { apiGet, apiSend } from './client';
import type { SsoChangeContract, SsoChangeDraft, SsoChangePreview, SsoChangeRecord } from './types';

// D-MSSO-9/13: thin client for the SSO change-request routes. No validity logic lives here.
const BASE = '/api/v1/sso/change-requests';

export const getSsoChangeContract = (baseUrl: string) => apiGet<SsoChangeContract>(baseUrl, `${BASE}/contract`);

export const listOpenSsoChanges = (baseUrl: string) =>
  apiGet<{ items: SsoChangeRecord[] }>(baseUrl, `${BASE}?status=open`);

export const getSsoChange = (baseUrl: string, id: string) =>
  apiGet<SsoChangeRecord>(baseUrl, `${BASE}/${encodeURIComponent(id)}`);

export const previewSsoChange = (baseUrl: string, draft: SsoChangeDraft) =>
  apiSend<SsoChangePreview>(baseUrl, 'POST', `${BASE}?dryRun=true`, draft);

export const submitSsoChange = (baseUrl: string, draft: SsoChangeDraft, baseBlobSha: string, idempotencyKey: string) =>
  apiSend<SsoChangeRecord>(baseUrl, 'POST', BASE, { ...draft, baseBlobSha }, { 'Idempotency-Key': idempotencyKey });

export const cancelSsoChange = (baseUrl: string, id: string, reason?: string) =>
  apiSend<SsoChangeRecord>(baseUrl, 'POST', `${BASE}/${encodeURIComponent(id)}/cancel`, reason ? { reason } : {});
