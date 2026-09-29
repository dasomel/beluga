import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ListWarning, Service } from '@beluga-manager/domain-api/schema';
import { getTranslations } from '../i18n/getTranslations';
import { ServicesView } from './ServicesView';

const mocks = vi.hoisted(() => ({
  services: [] as Service[],
  warnings: [] as ListWarning[],
  isLoading: false,
  isError: false,
  errorObj: null as unknown,
}));

vi.mock('../api/hooks', () => ({
  useServices: () => ({
    data: mocks.isError ? undefined : { data: mocks.services, warnings: mocks.warnings, meta: { total: mocks.services.length } },
    isLoading: mocks.isLoading,
    isError: mocks.isError,
    error: mocks.errorObj,
  }),
}));

const tEn = getTranslations('en-US');
const tKo = getTranslations('ko-KR');

const testServices: Service[] = [
  {
    id: 'svc-trino',
    name: 'Trino',
    type: 'trino',
    version: '483',
    status: 'healthy',
    endpoint: 'https://trino.local.beluga.internal',
    capabilities: ['query.execute', 'catalog.list', 'schema.browse'],
    capabilityCategories: ['query'],
    dependencies: ['svc-iceberg'],
    lastCheckedAt: '2026-09-21T05:50:00.000Z',
    staleAfterMs: 120_000,
  },
  {
    id: 'svc-kubernetes',
    name: 'Kubernetes',
    type: 'kubernetes',
    version: null,
    status: 'unknown',
    endpoint: null,
    capabilities: ['cluster.status'],
    capabilityCategories: [],
    dependencies: [],
    lastCheckedAt: '2026-09-21T05:49:00.000Z',
    staleAfterMs: 300_000,
  },
];

describe('ServicesView', () => {
  beforeEach(() => {
    mocks.services = [...testServices];
    mocks.warnings = [];
    mocks.isLoading = false;
    mocks.isError = false;
    mocks.errorObj = null;
  });

  it('renders loading state when services are loading', () => {
    mocks.isLoading = true;
    const html = renderToStaticMarkup(<ServicesView t={tEn} />);
    expect(html).toContain(tEn.common.loading);
  });

  it('renders error state when services fail to load', () => {
    mocks.isError = true;
    mocks.errorObj = new Error('Service directory unavailable');
    const html = renderToStaticMarkup(<ServicesView t={tEn} />);
    expect(html).toContain(tEn.common.loadError);
    expect(html).toContain('Service directory unavailable');
  });

  it('renders empty state when no services match', () => {
    mocks.services = [];
    const html = renderToStaticMarkup(<ServicesView t={tEn} />);
    expect(html).toContain(tEn.services.emptyState);
  });

  it('renders the service table with an external open-ui link for a safe https endpoint', () => {
    const html = renderToStaticMarkup(<ServicesView t={tEn} />);
    expect(html).toContain('Trino');
    expect(html).toContain('svc-trino');
    expect(html).toContain('query.execute');
    expect(html).toContain(tEn.services.capabilityCategories.query);
    expect(html).toContain('483');
    expect(html).toContain(tEn.services.openUi);
    expect(html).toContain('https://trino.local.beluga.internal');
  });

  it('renders internal-only label instead of a link when a service has no endpoint', () => {
    const html = renderToStaticMarkup(<ServicesView t={tEn} />);
    expect(html).toContain('Kubernetes');
    expect(html).toContain(tEn.services.internalOnly);
  });

  it('surfaces a warnings badge when the services envelope reports warnings', () => {
    mocks.warnings = [{ code: 'TRUNCATED', message: 'showing 2 of 5 items', serviceId: null }];
    const html = renderToStaticMarkup(<ServicesView t={tEn} />);
    expect(html).toContain('showing 2 of 5 items');
  });

  it('renders Korean translations correctly', () => {
    const html = renderToStaticMarkup(<ServicesView t={tKo} />);
    expect(html).toContain(tKo.services.title);
    expect(html).toContain(tKo.services.columns.name);
    expect(html).toContain(tKo.services.openUi);
    expect(html).toContain(tKo.services.capabilityCategories.query);
  });
});
