// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { buildUserManagerSettings, createOidcAuthClient } from './authClient';

describe('buildUserManagerSettings', () => {
  const settings = buildUserManagerSettings(
    { issuer: 'https://sso.test/realms/beluga' },
    window,
  );

  it('uses the public client with the authorization code flow and exact redirect URIs', () => {
    expect(settings).toMatchObject({
      authority: 'https://sso.test/realms/beluga',
      client_id: 'beluga-manager',
      response_type: 'code',
      scope: 'openid profile email groups',
      redirect_uri: `${window.location.origin}/auth/callback`,
      post_logout_redirect_uri: `${window.location.origin}/`,
    });
    expect(settings.client_secret).toBeUndefined();
    // PKCE (S256) stays on: the library only drops it when disablePKCE is set.
    expect(settings.disablePKCE).toBeUndefined();
  });

  it('honors runtime overrides', () => {
    const custom = buildUserManagerSettings(
      { issuer: 'https://i', clientId: 'c', redirectPath: '/cb', scope: 'openid' },
      window,
    );
    expect(custom).toMatchObject({ client_id: 'c', scope: 'openid', redirect_uri: `${window.location.origin}/cb` });
  });

  it('keeps tokens in memory and PKCE state in sessionStorage, never localStorage', async () => {
    window.sessionStorage.clear();
    window.localStorage.clear();

    await settings.userStore?.set('user-key', 'access-token-value');
    expect(window.sessionStorage.length).toBe(0);
    expect(window.localStorage.length).toBe(0);
    expect(await settings.userStore?.get('user-key')).toBe('access-token-value');

    await settings.stateStore?.set('state-key', 'pkce-verifier');
    expect(Object.values(window.sessionStorage)).toContain('pkce-verifier');
    expect(window.localStorage.length).toBe(0);
  });

  it('does not use the iframe-based automatic renew', () => {
    expect(settings.automaticSilentRenew).toBe(false);
  });
});

describe('createOidcAuthClient', () => {
  it('drops stale PKCE state at start but keeps fresh in-flight state', async () => {
    window.sessionStorage.clear();
    const entry = (id: string, ageSeconds: number) =>
      JSON.stringify({ id, created: Math.floor(Date.now() / 1000) - ageSeconds, request_type: 'si:r' });
    window.sessionStorage.setItem('oidc.stale', entry('stale', 3600));
    window.sessionStorage.setItem('oidc.fresh', entry('fresh', 10));

    createOidcAuthClient({ issuer: 'https://sso.test/realms/beluga' }, window);

    await vi.waitFor(() => expect(window.sessionStorage.getItem('oidc.stale')).toBeNull());
    expect(window.sessionStorage.getItem('oidc.fresh')).not.toBeNull();
  });
});
