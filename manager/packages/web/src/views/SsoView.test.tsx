import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SsoResponse } from '@beluga-manager/domain-api/schema';
import { getTranslations } from '../i18n/getTranslations';
import { SsoView } from './SsoView';

const mocks = vi.hoisted(() => ({
  ssoResponse: null as SsoResponse | null,
  isLoading: false,
  error: null as unknown,
}));

vi.mock('../api/hooks', () => ({
  useSsoConfig: () => ({
    data: mocks.ssoResponse,
    isLoading: mocks.isLoading,
    error: mocks.error,
  }),
}));

const tEn = getTranslations('en-US');
const tKo = getTranslations('ko-KR');

const testConfiguredResponse: SsoResponse = {
  status: 'configured',
  configured: true,
  source: {
    kind: 'git-file',
    path: 'gitops/values/sso.yaml',
    loadedAt: '2026-10-17T00:00:00.000Z',
  },
  config: {
    realm: 'beluga',
    issuerHost: 'sso.local.beluga.internal',
    issuer: 'https://sso.local.beluga.internal/realms/beluga',
    endpoints: [
      {
        name: 'flink',
        host: 'flink.local.beluga.internal',
        mode: 'gateway-oidc',
        clientId: 'apisix-gateway',
        protectedPathPrefixes: ['/*'],
        bypassPathPrefixes: [],
        redirectPath: '/.apisix/redirect',
        logoutPath: '/logout',
      },
      {
        name: 'argocd',
        host: 'argocd.local.beluga.internal',
        mode: 'app-oidc',
        clientId: 'argocd',
        protectedPathPrefixes: ['/'],
        bypassPathPrefixes: [],
        redirectPath: '/auth/callback',
      },
      {
        name: 's3',
        host: 's3.local.beluga.internal',
        mode: 'none',
        clientId: '',
        protectedPathPrefixes: [],
        bypassPathPrefixes: ['/'],
        redirectPath: '',
      },
    ],
  },
};

describe('SsoView', () => {
  beforeEach(() => {
    mocks.ssoResponse = testConfiguredResponse;
    mocks.isLoading = false;
    mocks.error = null;
  });

  it('renders configured SSO endpoints with realm, issuer, and mode badges', () => {
    const html = renderToStaticMarkup(<SsoView t={tEn} locale="en-US" />);

    // Realm and Issuer
    expect(html).toContain('beluga');
    expect(html).toContain('sso.local.beluga.internal');
    expect(html).toContain('https://sso.local.beluga.internal/realms/beluga');

    // Declared Git configuration notice
    expect(html).toContain(tEn.sso.declaredNoticeTitle);
    expect(html).toContain('gitops/values/sso.yaml');

    // Endpoints
    expect(html).toContain('flink');
    expect(html).toContain('argocd');
    expect(html).toContain('s3');

    // Mode badges & links
    expect(html).toContain('https://flink.local.beluga.internal');
    expect(html).toContain(tEn.sso.modeGatewayOidc);
    expect(html).toContain(tEn.sso.modeAppOidc);
    expect(html).toContain(tEn.sso.modeNone);

    // Path chips
    expect(html).toContain('/*');
    expect(html).toContain('/.apisix/redirect');
    expect(html).toContain('/logout');
  });

  it('renders in Korean locale correctly', () => {
    const html = renderToStaticMarkup(<SsoView t={tKo} locale="ko-KR" />);

    expect(html).toContain(tKo.sso.title);
    expect(html).toContain(tKo.sso.declaredNoticeTitle);
    expect(html).toContain(tKo.sso.modeGatewayOidc);
    expect(html).toContain(tKo.sso.modeAppOidc);
    expect(html).toContain(tKo.sso.modeNone);
  });

  it('renders not-configured state when configuration file is absent', () => {
    mocks.ssoResponse = {
      status: 'not-configured',
      configured: false,
      message: 'SSO configuration file is not configured',
    };

    const html = renderToStaticMarkup(<SsoView t={tEn} locale="en-US" />);
    expect(html).toContain(tEn.sso.notConfiguredTitle);
    expect(html).toContain(tEn.sso.notConfiguredMessage);
    expect(html).toContain('<details');
    expect(html).toContain('SSO configuration file is not configured');
    expect(html).not.toContain('flink.local.beluga.internal');
  });

  it('renders loading state when query is loading', () => {
    mocks.isLoading = true;
    const html = renderToStaticMarkup(<SsoView t={tEn} locale="en-US" />);
    expect(html).toContain('Loading...');
  });

  it('renders error state on query failure', () => {
    mocks.error = new Error('503 Service Unavailable');
    const html = renderToStaticMarkup(<SsoView t={tEn} locale="en-US" />);
    expect(html).toContain('503 Service Unavailable');
  });
});
