import { describe, expect, it } from 'vitest';
import { baseDomainFromIssuer, DEFAULT_BASE_DOMAIN } from './ConfigContext';

describe('baseDomainFromIssuer (D-DOM-2/3)', () => {
  it('strips the sso label from the issuer host', () => {
    expect(baseDomainFromIssuer('https://sso.kakao.beluga.internal/realms/beluga')).toBe('kakao.beluga.internal');
    expect(baseDomainFromIssuer('https://sso.local.beluga.internal/realms/beluga')).toBe('local.beluga.internal');
  });

  it('falls back to the Vagrant domain without a usable issuer', () => {
    expect(baseDomainFromIssuer(undefined)).toBe(DEFAULT_BASE_DOMAIN);
    expect(baseDomainFromIssuer('not a url')).toBe(DEFAULT_BASE_DOMAIN);
    expect(baseDomainFromIssuer('https://localhost/realms/x')).toBe(DEFAULT_BASE_DOMAIN);
  });
});
