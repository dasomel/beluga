import type { Service } from '@beluga-manager/domain-api/schema';
import { describe, expect, it } from 'vitest';
import { getStageExternalUrl } from './pipelineStageLinks';

const service: Service = {
  id: 'svc-test', name: 'Test service', type: 'trino', version: '1', status: 'healthy',
  endpoint: 'https://service.example.test', capabilities: [], capabilityCategories: ['query'], dependencies: [],
  lastCheckedAt: '2026-09-21T05:50:00.000Z', staleAfterMs: 60_000,
};

describe('getStageExternalUrl', () => {
  it('maps a matching service endpoint to a safe URL', () => {
    expect(getStageExternalUrl('svc-test', [service])).toBe('https://service.example.test/');
  });

  it('returns null when no matching service or endpoint exists', () => {
    expect(getStageExternalUrl('other', [service])).toBeNull();
    expect(getStageExternalUrl('svc-test', [{ ...service, endpoint: null }])).toBeNull();
  });

  it('rejects endpoints outside HTTP and HTTPS', () => {
    expect(getStageExternalUrl('svc-test', [{ ...service, endpoint: 'javascript:alert(1)' }])).toBeNull();
  });
});
