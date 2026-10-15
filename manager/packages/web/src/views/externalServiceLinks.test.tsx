import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Service } from '@beluga-manager/domain-api/schema';
import { getTranslations } from '../i18n/getTranslations';
import { OverviewView } from './OverviewView';
import { ServicesView } from './ServicesView';

const mocks = vi.hoisted(() => ({ services: [] as Service[] }));

vi.mock('../api/hooks', () => ({
  useServices: () => ({ data: { data: mocks.services, warnings: [], meta: { total: mocks.services.length } }, isLoading: false, isError: false }),
  usePipelines: () => ({ data: { data: [], warnings: [], meta: { total: 0 } }, isLoading: false, isError: false }),
  useDomainApiHealth: () => ({ data: { status: 'healthy', version: '1' }, isLoading: false, isError: false }),
  useEvents: () => ({ data: { data: [], warnings: [], meta: { total: 0 } }, isLoading: false, isError: false }),
  useDataAssetsCount: () => ({ data: { data: [], warnings: [], meta: { total: 0 } }, isLoading: false, isError: false }),
  useResources: () => ({ data: { data: [], warnings: [], meta: { total: 0 } }, isLoading: false, isPending: false, isError: false }),
}));

const t = getTranslations('en-US');
const service: Service = {
  id: 'svc-test', name: 'Test service', type: 'trino', version: '1', status: 'healthy',
  endpoint: 'https://service.example.test', capabilities: [], capabilityCategories: ['query'], dependencies: [],
  namespace: null, workloadRef: null, keyMetrics: [],
  lastCheckedAt: '2026-09-21T05:50:00.000Z', staleAfterMs: 60_000,
};

describe('external service links', () => {
  beforeEach(() => {
    mocks.services = [{ ...service }];
  });

  it.each([
    ['ServicesView', () => renderToStaticMarkup(<ServicesView t={t} />)],
    ['OverviewView', () => renderToStaticMarkup(<OverviewView t={t} onNavigate={() => undefined} />)],
  ])('%s renders unsafe endpoints without an anchor', (_view, render) => {
    mocks.services = [{ ...service, endpoint: 'javascript:alert(1)' }];
    expect(render()).not.toContain('<a ');
  });

  it.each([
    ['ServicesView', () => renderToStaticMarkup(<ServicesView t={t} />)],
    ['OverviewView', () => renderToStaticMarkup(<OverviewView t={t} onNavigate={() => undefined} />)],
  ])('%s links to a valid HTTP(S) endpoint', (_view, render) => {
    const markup = render();
    expect(markup).toMatch(/href="https:\/\/service\.example\.test\/?"/);
  });
});
