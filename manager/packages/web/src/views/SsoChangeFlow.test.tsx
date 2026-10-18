// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SsoResponse } from '@beluga-manager/domain-api/schema';
import type { SsoChangeContract, SsoChangePreview, SsoChangeRecord } from '../api/types';
import { ConfigProvider } from '../config/ConfigContext';
import { getTranslations } from '../i18n/getTranslations';
import { SsoView } from './SsoView';

const auth = vi.hoisted(() => ({ groups: [] as string[] }));
vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({ user: { name: 'tester', groups: auth.groups, accessToken: 'tok' } }),
}));

const t = getTranslations('en-US');
const HEX32 = /^[0-9a-f]{32}$/;
const BLOB = 'a'.repeat(40);

const sso: SsoResponse = {
  status: 'configured',
  configured: true,
  source: { kind: 'git-file', path: 'gitops/values/sso.yaml', loadedAt: '2026-10-17T00:00:00.000Z' },
  config: {
    realm: 'beluga',
    issuerHost: 'sso.local.beluga.internal',
    issuer: 'https://sso.local.beluga.internal/realms/beluga',
    endpoints: [
      { name: 'flink', host: 'flink.local.beluga.internal', mode: 'gateway-oidc', clientId: 'apisix-gateway', protectedPathPrefixes: ['/*'], bypassPathPrefixes: [], redirectPath: '/r', logoutPath: '/logout' },
      { name: 'argocd', host: 'argocd.local.beluga.internal', mode: 'app-oidc', clientId: 'argocd', protectedPathPrefixes: ['/'], bypassPathPrefixes: [], redirectPath: '/c' },
    ],
  },
};

const contract: SsoChangeContract = {
  editableEndpoints: ['flink', 'filer'],
  field: 'allowedGroups',
  requiredGroups: ['admins'],
  availableGroups: ['admins', 'engineers', 'analysts'],
  current: { flink: ['admins', 'engineers'], filer: null },
  sourceCommitSha: 'b'.repeat(40),
  baseBlobSha: BLOB,
  gitWriterConfigured: true,
};

const preview = (blob = BLOB, after = ['admins', 'engineers']): SsoChangePreview => ({
  endpoint: 'flink',
  patch: { allowedGroups: after },
  before: ['admins', 'engineers'],
  after,
  baseBlobSha: blob,
  sourceCommitSha: 'b'.repeat(40),
  diff: '--- a/sso.yaml\n+++ b/sso.yaml\n-    allowedGroups: [admins, engineers]\n+    allowedGroups: [admins, analysts, engineers]',
});

const record = (over: Partial<SsoChangeRecord> = {}): SsoChangeRecord => ({
  id: '0b6f6f0e-2a3c-4a53-9f1d-0d0c2f4e9a11',
  stage: 'pr_open',
  endpoint: 'flink',
  patch: { allowedGroups: ['admins', 'engineers'] },
  baseBlobSha: BLOB,
  sourceCommitSha: 'b'.repeat(40),
  branch: 'sso/flink-3f9a1c7e5b2d',
  pr: { number: 42, url: 'https://github.com/dasomel/beluga/pull/42' },
  mergeCommitSha: null,
  createdAt: '2026-10-18T01:00:00.000Z',
  updatedAt: '2026-10-18T01:00:00.000Z',
  ...over,
});

interface Call { method: string; url: string; headers: Record<string, string>; body: unknown }
let calls: Call[];
let open: SsoChangeRecord[];
let submitResponses: Array<() => Response>;
let cancelResponse: () => Response;
let listResponse: (() => Response) | null;

const errorBody = (status: number, code: string) => () =>
  Response.json({ error: { code, message: `server says ${code}` } }, { status });

function installFetch() {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      calls.push({
        method,
        url,
        headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)),
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      const path = url.replace('http://api.test', '');
      if (path === '/api/v1/sso') return Response.json(sso);
      if (path === '/api/v1/sso/change-requests/contract') return Response.json(contract);
      if (path === '/api/v1/sso/change-requests?status=open') return listResponse ? listResponse() : Response.json({ items: open });
      if (path === '/api/v1/sso/change-requests?dryRun=true') return Response.json(preview());
      if (path === '/api/v1/sso/change-requests') return (submitResponses.shift() ?? (() => Response.json(record(), { status: 201 })))();
      if (path.endsWith('/cancel')) return cancelResponse();
      return new Response('not found', { status: 404 });
    }),
  );
}

function mount() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <ConfigProvider config={{ apiBaseUrl: 'http://api.test' }}>
      <QueryClientProvider client={queryClient}>
        <SsoView t={t} locale="en-US" />
      </QueryClientProvider>
    </ConfigProvider>,
  );
}

const submitCalls = () => calls.filter((c) => c.method === 'POST' && c.url.endsWith('/api/v1/sso/change-requests'));

beforeEach(() => {
  auth.groups = ['/admins'];
  open = [];
  submitResponses = [];
  listResponse = null;
  cancelResponse = () => Response.json(record({ stage: 'failed' }));
  installFetch();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function openFlinkForm() {
  mount();
  fireEvent.click(await screen.findByRole('button', { name: 'Edit flink' }));
  await screen.findByText(t.sso.change.groupsLegend);
}

async function previewDraft() {
  fireEvent.click(screen.getByRole('button', { name: t.sso.change.preview }));
  await screen.findByText(t.sso.change.previewTitle);
}

describe('SsoView change flow: access', () => {
  it('shows no edit or cancel and calls no change route for a non-admin', async () => {
    auth.groups = ['engineers'];
    open = [record()];
    mount();
    await screen.findByText('flink');
    expect(screen.queryByText(t.sso.change.edit)).toBeNull();
    expect(screen.queryByText(t.sso.change.cancelRequest)).toBeNull();
    expect(screen.queryByText(t.sso.change.openTitle)).toBeNull();
    expect(calls.some((c) => c.url.includes('change-requests'))).toBe(false);
  });

  it('treats /admins as admin and offers edit only for endpoints the contract lists', async () => {
    mount();
    await screen.findByRole('button', { name: 'Edit flink' });
    expect(screen.queryByRole('button', { name: 'Edit argocd' })).toBeNull();
  });
});

describe('SsoView change flow: form and preview', () => {
  it('renders checkboxes from the contract with the required group checked and disabled', async () => {
    await openFlinkForm();
    const admins = screen.getByRole('checkbox', { name: /admins/ }) as HTMLInputElement;
    const analysts = screen.getByRole('checkbox', { name: /analysts/ }) as HTMLInputElement;
    expect(admins.checked).toBe(true);
    expect(admins.disabled).toBe(true);
    expect(analysts.checked).toBe(false);
    expect(analysts.disabled).toBe(false);
  });

  it('previews with dryRun and shows the server diff', async () => {
    await openFlinkForm();
    fireEvent.click(screen.getByRole('checkbox', { name: /analysts/ }));
    await previewDraft();
    const call = calls.find((c) => c.url.endsWith('dryRun=true'));
    expect(call?.body).toEqual({ endpoint: 'flink', allowedGroups: ['admins', 'engineers', 'analysts'] });
    expect(screen.getByText(/\+\s+allowedGroups: \[admins, analysts, engineers\]/)).toBeTruthy();
  });

  it('invalidates the preview when the selection changes afterwards', async () => {
    await openFlinkForm();
    await previewDraft();
    fireEvent.click(screen.getByRole('checkbox', { name: /analysts/ }));
    expect(screen.getByText(t.sso.change.previewStale)).toBeTruthy();
    expect((screen.getByRole('button', { name: t.sso.change.submit }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('SsoView change flow: submit', () => {
  it('reuses the Idempotency-Key on retry of the same draft and renews it after the draft changes', async () => {
    submitResponses = [errorBody(502, 'GITHUB_UNAVAILABLE'), errorBody(502, 'GITHUB_UNAVAILABLE'), errorBody(502, 'GITHUB_UNAVAILABLE')];
    await openFlinkForm();
    await previewDraft();

    const submit = () => screen.getByRole('button', { name: t.sso.change.submit });
    fireEvent.click(submit());
    await waitFor(() => expect(submitCalls()).toHaveLength(1));
    await screen.findByRole('alert');
    fireEvent.click(submit());
    await waitFor(() => expect(submitCalls()).toHaveLength(2));

    const [first, second] = submitCalls();
    expect(first?.headers['Idempotency-Key']).toMatch(HEX32);
    expect(second?.headers['Idempotency-Key']).toBe(first?.headers['Idempotency-Key']);
    expect(first?.body).toMatchObject({ endpoint: 'flink', allowedGroups: ['admins', 'engineers'], baseBlobSha: BLOB });

    fireEvent.click(screen.getByRole('checkbox', { name: /analysts/ }));
    await previewDraft();
    await waitFor(() => expect((submit() as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(submit());
    await waitFor(() => expect(submitCalls()).toHaveLength(3));
    const third = submitCalls()[2];
    expect(third?.headers['Idempotency-Key']).toMatch(HEX32);
    expect(third?.headers['Idempotency-Key']).not.toBe(first?.headers['Idempotency-Key']);
  });

  it('shows the PR link after a successful submit', async () => {
    await openFlinkForm();
    await previewDraft();
    fireEvent.click(screen.getByRole('button', { name: t.sso.change.submit }));
    const status = await screen.findByRole('status');
    expect(within(status).getByRole('link').getAttribute('href')).toBe('https://github.com/dasomel/beluga/pull/42');
  });

  it.each([
    [409, 'STALE_BASE', t.sso.change.errStaleBase],
    [409, 'OPEN_REQUEST_EXISTS', t.sso.change.errOpenRequestExists],
    [503, 'GIT_WRITER_UNCONFIGURED', t.sso.change.errGitWriterUnconfigured],
    [503, 'AUDIT_UNAVAILABLE', t.sso.change.errAuditUnavailable],
    [503, 'CONSUMER_NOT_DEPLOYED', t.sso.change.errConsumerNotDeployed],
    [422, 'NO_EFFECTIVE_CHANGE', t.sso.change.errNoEffectiveChange],
    [422, 'PATCH_REJECTED', t.sso.change.errPatchRejected],
  ])('maps %s %s to its message and also shows the server text', async (status, code, message) => {
    submitResponses = [errorBody(status, code)];
    await openFlinkForm();
    await previewDraft();
    fireEvent.click(screen.getByRole('button', { name: t.sso.change.submit }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain(message);
    expect(alert.textContent).toContain(`server says ${code}`);
  });
});

describe('SsoView change flow: banner and cancel', () => {
  it('renders open requests with stage and a safe PR link, and ignores unsafe URLs', async () => {
    open = [
      record(),
      record({ id: '1b6f6f0e-2a3c-4a53-9f1d-0d0c2f4e9a11', endpoint: 'filer', stage: 'merged', pr: { number: 7, url: 'javascript:alert(1)' } }),
    ];
    mount();
    const link = await screen.findByRole('link', { name: /Pull request #42/ });
    expect(link.getAttribute('href')).toBe('https://github.com/dasomel/beluga/pull/42');
    expect(screen.getByText(t.sso.change.stagePrOpen)).toBeTruthy();
    expect(screen.getByText(t.sso.change.stageMerged)).toBeTruthy();
    expect(screen.getByText('Pull request #7').closest('a')).toBeNull();
  });

  it('polls every 30 s while mounted and stops after unmount', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
    const { unmount } = mount();
    const listCalls = () => calls.filter((c) => c.url.endsWith('change-requests?status=open')).length;
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(listCalls()).toBe(1);
    await act(() => vi.advanceTimersByTimeAsync(30_000));
    expect(listCalls()).toBe(2);
    await act(() => vi.advanceTimersByTimeAsync(30_000));
    expect(listCalls()).toBe(3);
    unmount();
    await act(() => vi.advanceTimersByTimeAsync(120_000));
    expect(listCalls()).toBe(3);
  });

  it('requires an in-page confirm before cancelling, and keeping it sends nothing', async () => {
    open = [record()];
    mount();
    fireEvent.click(await screen.findByRole('button', { name: t.sso.change.cancelRequest }));
    expect(calls.some((c) => c.url.endsWith('/cancel'))).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: t.sso.change.cancelKeep }));
    expect(calls.some((c) => c.url.endsWith('/cancel'))).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: t.sso.change.cancelRequest }));
    fireEvent.click(screen.getByRole('button', { name: t.sso.change.cancelConfirm }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.url.endsWith(`${record().id}/cancel`))).toBe(true));
  });

  it('shows the mapped message when cancel fails', async () => {
    open = [record()];
    cancelResponse = errorBody(502, 'GITHUB_UNAVAILABLE');
    mount();
    fireEvent.click(await screen.findByRole('button', { name: t.sso.change.cancelRequest }));
    fireEvent.click(screen.getByRole('button', { name: t.sso.change.cancelConfirm }));
    expect((await screen.findByRole('alert')).textContent).toContain(t.sso.change.errGithubUnavailable);
  });
});

describe('SsoView change flow: review fixes', () => {
  const submit = () => screen.getByRole('button', { name: t.sso.change.submit });

  // F3: a replayed key answers 200 with the request's FINAL stage.
  it('renders a failed/rejected replay as an error, not as success, and allows a new draft with a NEW key', async () => {
    submitResponses = [() => Response.json(record({ stage: 'failed', pr: null }), { status: 200 })];
    await openFlinkForm();
    await previewDraft();
    fireEvent.click(submit());
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain(t.sso.change.stageFailed);
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.queryByText(t.sso.change.submitted, { exact: false })).toBeNull();

    // the form is free again: submit the same draft once more, it must carry a different key
    await waitFor(() => expect((submit() as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(submit());
    await waitFor(() => expect(submitCalls()).toHaveLength(2));
    const [first, second] = submitCalls();
    expect(first?.headers['Idempotency-Key']).toMatch(HEX32);
    expect(second?.headers['Idempotency-Key']).toMatch(HEX32);
    expect(second?.headers['Idempotency-Key']).not.toBe(first?.headers['Idempotency-Key']);
  });

  it('shows rejected like failed', async () => {
    submitResponses = [() => Response.json(record({ stage: 'rejected', pr: null }), { status: 200 })];
    await openFlinkForm();
    await previewDraft();
    fireEvent.click(submit());
    expect((await screen.findByRole('alert')).textContent).toContain(t.sso.change.stageRejected);
  });

  it.each(['submitted', 'unknown_recovering'] as const)('shows %s as in progress without a success message', async (stage) => {
    submitResponses = [() => Response.json(record({ stage, pr: null }), { status: 200 })];
    await openFlinkForm();
    await previewDraft();
    fireEvent.click(submit());
    const status = await screen.findByRole('status');
    expect(status.textContent).toContain(t.sso.change.submitInProgress);
    expect(screen.queryByText(t.sso.change.submitted, { exact: true })).toBeNull();
    expect(screen.queryByRole('link', { name: /Pull request/ })).toBeNull();
  });

  it('renews the Idempotency-Key after IDEMPOTENCY_KEY_COLLISION', async () => {
    submitResponses = [errorBody(409, 'IDEMPOTENCY_KEY_COLLISION')];
    await openFlinkForm();
    await previewDraft();
    fireEvent.click(submit());
    expect((await screen.findByRole('alert')).textContent).toContain(t.sso.change.errIdempotencyKeyCollision);
    fireEvent.click(submit());
    await waitFor(() => expect(submitCalls()).toHaveLength(2));
    const [first, second] = submitCalls();
    expect(second?.headers['Idempotency-Key']).not.toBe(first?.headers['Idempotency-Key']);
  });

  it('maps REQUEST_IN_FLIGHT on cancel', async () => {
    open = [record()];
    cancelResponse = errorBody(409, 'REQUEST_IN_FLIGHT');
    mount();
    fireEvent.click(await screen.findByRole('button', { name: t.sso.change.cancelRequest }));
    fireEvent.click(screen.getByRole('button', { name: t.sso.change.cancelConfirm }));
    expect((await screen.findByRole('alert')).textContent).toContain(t.sso.change.errRequestInFlight);
  });

  // F7
  it('hides the banner (no error) when the list answers 503 CONSUMER_NOT_DEPLOYED', async () => {
    listResponse = errorBody(503, 'CONSUMER_NOT_DEPLOYED');
    mount();
    await screen.findByRole('button', { name: 'Edit flink' });
    await waitFor(() => expect(calls.some((c) => c.url.endsWith('change-requests?status=open'))).toBe(true));
    expect(screen.queryByText(t.sso.change.openTitle)).toBeNull();
    expect(screen.queryByText(t.sso.change.errConsumerNotDeployed)).toBeNull();
  });

  it('still shows other list failures', async () => {
    listResponse = errorBody(503, 'AUDIT_UNAVAILABLE');
    mount();
    expect((await screen.findByText(t.sso.change.errAuditUnavailable))).toBeTruthy();
  });
});
