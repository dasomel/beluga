// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { shouldRetryQuery } from './api/client';
import { AuthProvider } from './auth/AuthContext';
import type { AuthClient, AuthUser } from './auth/authClient';
import { ConfigProvider } from './config/ConfigContext';
import type { AppConfig } from './config/loadConfig';
import { getTranslations } from './i18n/getTranslations';

// The real OverviewView pulls many endpoints; this probe exercises the same fetch layer
// (useDomainApiHealth -> apiGet) and the real ErrorState, which is all the auth contract needs.
vi.mock('./views/OverviewView', async () => {
  const { useDomainApiHealth } = await import('./api/hooks');
  const { ErrorState } = await import('./components/QueryState');
  const { getTranslations: translations } = await import('./i18n/getTranslations');
  return {
    OverviewView: () => {
      const query = useDomainApiHealth();
      if (query.error) return <ErrorState t={translations('en-US')} error={query.error} />;
      return <div>{query.data ? 'api-ok' : 'api-pending'}</div>;
    },
  };
});

const t = getTranslations('en-US');
const user: AuthUser = { name: 'alice', groups: ['admins', 'analysts'], accessToken: 'tok-1' };
const oidcConfig: AppConfig = {
  apiBaseUrl: 'http://api.test',
  oidc: { issuer: 'https://sso.test/realms/beluga', clientId: 'beluga-manager', redirectPath: '/auth/callback' },
};

function fakeClient(overrides: Partial<AuthClient> = {}) {
  const client = {
    redirectPath: '/auth/callback',
    restore: vi.fn().mockResolvedValue(null),
    handleCallback: vi.fn().mockResolvedValue(user),
    login: vi.fn().mockResolvedValue(undefined),
    logout: vi.fn().mockResolvedValue(undefined),
    clear: vi.fn().mockResolvedValue(undefined),
    subscribe: vi.fn().mockReturnValue(() => undefined),
    ...overrides,
  };
  return client satisfies AuthClient;
}

function mount(config: AppConfig, client?: AuthClient) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: shouldRetryQuery } } });
  return render(
    <ConfigProvider config={config}>
      <QueryClientProvider client={queryClient}>
        <AuthProvider client={client}>
          <App />
        </AuthProvider>
      </QueryClientProvider>
    </ConfigProvider>,
  );
}

function stubFetch(status = 200) {
  const fetchMock = vi.fn().mockImplementation(async () =>
    status === 200 ? Response.json({ status: 'ok' }) : new Response('', { status }),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

beforeEach(() => window.history.replaceState(null, '', '/'));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('App login gate', () => {
  it('shows the sign-in screen and calls no API while signed out', async () => {
    const fetchMock = stubFetch();
    const client = fakeClient();
    mount(oidcConfig, client);

    const button = await screen.findByRole('button', { name: t.auth.loginButton });
    expect(screen.queryByText('api-pending')).toBeNull();
    fireEvent.click(button);
    expect(client.login).toHaveBeenCalledOnce();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('shows the user, groups and logout after sign-in and sends the bearer token', async () => {
    const fetchMock = stubFetch();
    const client = fakeClient({ restore: vi.fn().mockResolvedValue(user) });
    mount(oidcConfig, client);

    expect(await screen.findByText('alice')).toBeTruthy();
    expect(screen.getByText('admins, analysts')).toBeTruthy();
    await screen.findByText('api-ok');
    expect(fetchMock).toHaveBeenCalledWith('http://api.test/api/v1/health', {
      headers: { Authorization: 'Bearer tok-1' },
    });

    fireEvent.click(screen.getByRole('button', { name: t.auth.logout }));
    expect(client.logout).toHaveBeenCalledOnce();
  });

  it('returns to the sign-in screen with an expiry notice on HTTP 401', async () => {
    stubFetch(401);
    const client = fakeClient({ restore: vi.fn().mockResolvedValue(user) });
    mount(oidcConfig, client);

    expect(await screen.findByText(t.auth.sessionExpired)).toBeTruthy();
    expect(screen.getByRole('button', { name: t.auth.loginButton })).toBeTruthy();
    expect(client.clear).toHaveBeenCalled();
    expect(screen.queryByText('alice')).toBeNull();
  });

  it('shows an access-denied panel on HTTP 403 and keeps the session', async () => {
    const fetchMock = stubFetch(403);
    const client = fakeClient({ restore: vi.fn().mockResolvedValue(user) });
    mount(oidcConfig, client);

    expect(await screen.findByText(t.auth.forbiddenTitle)).toBeTruthy();
    expect(screen.getByText('alice')).toBeTruthy();
    expect(client.clear).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('completes the login on the callback path, then cleans the URL', async () => {
    stubFetch();
    window.history.replaceState(null, '', '/auth/callback?code=abc&state=xyz');
    const client = fakeClient();
    mount(oidcConfig, client);

    expect(await screen.findByText('alice')).toBeTruthy();
    expect(client.handleCallback).toHaveBeenCalledWith('http://localhost:3000/auth/callback?code=abc&state=xyz');
    expect(client.restore).not.toHaveBeenCalled();
    expect(window.location.pathname).toBe('/');
  });

  it('shows the failure on the sign-in screen when the callback is rejected', async () => {
    stubFetch();
    window.history.replaceState(null, '', '/auth/callback?error=access_denied');
    mount(oidcConfig, fakeClient({ handleCallback: vi.fn().mockRejectedValue(new Error('access_denied')) }));

    expect(await screen.findByText(`${t.auth.loginFailed}: access_denied`)).toBeTruthy();
    expect(window.location.pathname).toBe('/');
  });

  it('marks login disabled and sends no credentials when config has no oidc section', async () => {
    const fetchMock = stubFetch();
    mount({ apiBaseUrl: 'http://api.test' });

    expect(await screen.findByText(t.auth.loginDisabled)).toBeTruthy();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('http://api.test/api/v1/health'));
    expect(screen.queryByRole('button', { name: t.auth.loginButton })).toBeNull();
  });
});
