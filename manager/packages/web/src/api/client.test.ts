import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, apiGet, setApiAuthHooks, shouldRetryQuery } from './client';

afterEach(() => {
  vi.unstubAllGlobals();
  setApiAuthHooks(null);
});

describe('apiGet', () => {
  it('requests the domain API and preserves resource names, metadata, and warnings', async () => {
    const payload = {
      data: [{ id: 'orders-cdc', name: '주문-events', status: 'stale' }],
      meta: { page: 1, pageSize: 100, total: 1 },
      warnings: [{ code: 'STALE_DATA', message: 'Cached result' }],
    };
    const fetchMock = vi.fn().mockResolvedValue(Response.json(payload));
    vi.stubGlobal('fetch', fetchMock);

    await expect(apiGet('https://manager.example', '/api/v1/services?pageSize=100'))
      .resolves.toEqual(payload);
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
      'https://manager.example/api/v1/services?pageSize=100',
    );
  });

  it.each([401, 503])('reports HTTP %s without trying to parse the error body', async (status) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('not JSON', { status })));

    const result = apiGet('', '/api/v1/services');

    await expect(result).rejects.toBeInstanceOf(ApiError);
    await expect(result).rejects.toMatchObject({
      name: 'ApiError',
      status,
      message: `/api/v1/services responded with ${status}`,
    });
  });

  it('rejects malformed JSON in a successful response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('not JSON')));

    await expect(apiGet('', '/api/v1/services')).rejects.toBeInstanceOf(SyntaxError);
  });

  it('preserves network failures for callers', async () => {
    const error = new TypeError('Network unavailable');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(error));

    await expect(apiGet('', '/api/v1/services')).rejects.toBe(error);
  });
});

describe('apiGet authentication', () => {
  it('attaches the bearer token when the auth hooks hold one', async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);
    setApiAuthHooks({ getAccessToken: () => 'abc', onUnauthorized: vi.fn() });

    await apiGet('https://manager.example', '/api/v1/services');

    expect(fetchMock).toHaveBeenCalledExactlyOnceWith('https://manager.example/api/v1/services', {
      headers: { Authorization: 'Bearer abc' },
    });
  });

  it('notifies on 401 only, and 403 does not', async () => {
    const onUnauthorized = vi.fn();
    setApiAuthHooks({ getAccessToken: () => 'abc', onUnauthorized });

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 403 })));
    await expect(apiGet('', '/x')).rejects.toMatchObject({ status: 403 });
    expect(onUnauthorized).not.toHaveBeenCalled();

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 401 })));
    await expect(apiGet('', '/x')).rejects.toMatchObject({ status: 401 });
    expect(onUnauthorized).toHaveBeenCalledOnce();
  });
});

describe('shouldRetryQuery', () => {
  it('never retries 401/403 and caps other failures at three retries', () => {
    expect(shouldRetryQuery(0, new ApiError(401, 'x'))).toBe(false);
    expect(shouldRetryQuery(0, new ApiError(403, 'x'))).toBe(false);
    expect(shouldRetryQuery(2, new ApiError(503, 'x'))).toBe(true);
    expect(shouldRetryQuery(3, new ApiError(503, 'x'))).toBe(false);
  });
});
