import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, apiGet } from './client';

afterEach(() => vi.unstubAllGlobals());

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
