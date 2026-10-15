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
