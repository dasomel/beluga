import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from './loadConfig';

afterEach(() => vi.unstubAllGlobals());

describe('loadConfig', () => {
  it('loads the API base URL from the deployment runtime config', async () => {
    const config = { apiBaseUrl: 'https://manager.example/domain' };
    const fetchMock = vi.fn().mockResolvedValue(Response.json(config));
    vi.stubGlobal('fetch', fetchMock);

    await expect(loadConfig()).resolves.toEqual(config);
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith('/config.json');
  });

  it('reports a missing config before parsing the response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('not JSON', { status: 404 })));

    await expect(loadConfig()).rejects.toThrow('Failed to load /config.json: 404');
  });

  it('rejects malformed JSON', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('not JSON')));

    await expect(loadConfig()).rejects.toBeInstanceOf(SyntaxError);
  });

  it('preserves network failures', async () => {
    const error = new TypeError('Network unavailable');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(error));

    await expect(loadConfig()).rejects.toBe(error);
  });
});

describe('loadConfig oidc validation', () => {
  const load = (config: unknown) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(config)));
    return loadConfig();
  };
  const issuer = 'https://sso.local.beluga.internal/realms/beluga';

  it('accepts a missing oidc section and a valid one', async () => {
    await expect(load({ apiBaseUrl: '/api' })).resolves.toEqual({ apiBaseUrl: '/api' });
    const oidc = { issuer, clientId: 'beluga-manager', redirectPath: '/auth/callback', scope: 'openid' };
    await expect(load({ apiBaseUrl: '/api', oidc })).resolves.toEqual({ apiBaseUrl: '/api', oidc });
    await expect(load({ apiBaseUrl: '/api', oidc: { issuer } })).resolves.toBeDefined();
  });

  it.each([
    ['a null section', null, 'oidc must be an object'],
    ['a missing issuer', {}, 'oidc.issuer'],
    ['a misspelled issuer key', { issur: issuer }, 'oidc.issuer'],
    ['an http issuer', { issuer: 'http://sso.test/realms/beluga' }, 'oidc.issuer'],
    ['a non-URL issuer', { issuer: 'sso.test' }, 'oidc.issuer'],
    ['an empty clientId', { issuer, clientId: ' ' }, 'oidc.clientId'],
    ['a non-string clientId', { issuer, clientId: 7 }, 'oidc.clientId'],
    ['a redirectPath without a leading slash', { issuer, redirectPath: 'auth/callback' }, 'oidc.redirectPath'],
    ['an empty scope', { issuer, scope: '' }, 'oidc.scope'],
  ])('rejects %s', async (_name, oidc, message) => {
    await expect(load({ apiBaseUrl: '/api', oidc })).rejects.toThrow(message);
  });
});

