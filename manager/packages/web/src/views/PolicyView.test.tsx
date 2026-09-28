import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PolicyProjection } from '@beluga-manager/domain-api/schema';
import { getTranslations } from '../i18n/getTranslations';
import { PolicyView } from './PolicyView';

const mocks = vi.hoisted(() => ({
  policies: [] as PolicyProjection[],
  isLoading: false,
  error: null as unknown,
}));

vi.mock('../api/hooks', () => ({
  usePolicies: () => ({
    data: mocks.policies.length > 0 ? { data: mocks.policies, meta: { total: mocks.policies.length, page: 1, pageSize: 20 } } : undefined,
    isLoading: mocks.isLoading,
    error: mocks.error,
  }),
}));

const tEn = getTranslations('en-US');
const tKo = getTranslations('ko-KR');

const testPolicy: PolicyProjection = {
  id: 'beluga-platform-policy',
  name: 'Beluga Platform Policy',
  version: '0.1.0',
  description: 'Fixture-backed policy summary; not a live Keycloak or OPA integration.',
  sourceFile: 'packages/domain-api/tests/fixtures/platform-policy.yaml',
  evaluatedAt: '2026-09-28T09:00:00.000Z',
  roles: [
    {
      name: 'admins',
      includes: ['engineers'],
      permissions: [
        {
          resource: 'lake.customers',
          catalog: 'iceberg',
          engine: 'trino',
          operation: 'select',
          accessType: 'read-only',
        },
        {
          resource: 'lake.customers',
          catalog: 'iceberg',
          engine: 'trino',
          operation: 'insert',
          accessType: 'mutating',
        },
      ],
    },
    {
      name: 'analysts',
      includes: [],
      permissions: [
        {
          resource: 'lake.customers',
          catalog: 'iceberg',
          engine: 'trino',
          operation: 'select',
          accessType: 'read-only',
          columnMask: { email: 'hash' },
          rowFilter: "region = 'KR'",
        },
      ],
    },
  ],
  groups: [
    {
      name: 'analysts',
      roles: ['analysts'],
    },
  ],
  artefacts: [
    {
      target: 'trino-rego',
      contentHash: 'sha256:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789',
      lineCount: 281,
    },
    {
      target: 'postgres-grant',
      contentHash: 'sha256:1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
      lineCount: 33,
    },
    {
      target: 'keycloak-mapper',
      contentHash: 'sha256:fe9876543210fedcba9876543210fedcba9876543210fedcba9876543210fedc',
      lineCount: 45,
    },
  ],
};

describe('PolicyView', () => {
  beforeEach(() => {
    mocks.policies = [testPolicy];
    mocks.isLoading = false;
    mocks.error = null;
  });

  it('renders loading state when query is loading', () => {
    mocks.isLoading = true;
    const html = renderToStaticMarkup(<PolicyView t={tEn} />);
    expect(html).toContain(tEn.common.loading);
  });

  it('renders error state when query errors', () => {
    mocks.error = new Error('Network error');
    const html = renderToStaticMarkup(<PolicyView t={tEn} />);
    expect(html).toContain(tEn.common.loadError);
    expect(html).toContain('Network error');
  });

  it('renders empty state when no policies returned', () => {
    mocks.policies = [];
    const html = renderToStaticMarkup(<PolicyView t={tEn} />);
    expect(html).toContain(tEn.policy.emptyState);
  });

  it('renders roles and separates read-only and mutating permissions', () => {
    const htmlEn = renderToStaticMarkup(<PolicyView t={tEn} />);

    // Header and banner
    expect(htmlEn).toContain('Security');
    expect(htmlEn).toContain('Policy');
    expect(htmlEn).toContain('policyctl v0.1.0');
    expect(htmlEn).toContain('packages/domain-api/tests/fixtures/platform-policy.yaml');
    expect(htmlEn).toContain(testPolicy.description);

    // Roles
    expect(htmlEn).toContain('ROLE: admins');
    expect(htmlEn).toContain(`${tEn.policy.ldapGroupNameLabel}: admins`);
    expect(htmlEn).toContain('ROLE: analysts');
    expect(htmlEn).toContain(`${tEn.policy.ldapGroupNameLabel}: analysts`);

    // Read-only vs mutating split
    expect(htmlEn).toContain(tEn.policy.readOnlySection);
    expect(htmlEn).toContain(tEn.policy.mutatingSection);
    expect(htmlEn).toContain(tEn.policy.readOnlyBadge);
    expect(htmlEn).toContain(tEn.policy.mutatingBadge);

    // Operation classification rendered
    expect(htmlEn).toContain('iceberg:lake.customers [select]');
    expect(htmlEn).toContain('iceberg:lake.customers [insert]');
  });

  it('renders correctly in Korean locale', () => {
    const htmlKo = renderToStaticMarkup(<PolicyView t={tKo} />);

    expect(htmlKo).toContain(tKo.policy.title.replace('&', '&amp;'));
    expect(htmlKo).toContain(tKo.policy.compilerTitle);
    expect(htmlKo).toContain(tKo.policy.rolesTab);
    expect(htmlKo).toContain(tKo.policy.artefactsTab);
    expect(htmlKo).toContain(tKo.policy.readOnlySection);
    expect(htmlKo).toContain(tKo.policy.mutatingSection);
    expect(htmlKo).toContain(tKo.policy.readOnlyBadge);
    expect(htmlKo).toContain(tKo.policy.mutatingBadge);
  });
});
