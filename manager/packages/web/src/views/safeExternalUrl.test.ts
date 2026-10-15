import { describe, expect, it } from 'vitest';
import { getSafeExternalUrl } from './safeExternalUrl';

describe('getSafeExternalUrl', () => {
  it('allows absolute HTTP and HTTPS URLs', () => {
    expect(getSafeExternalUrl('http://logs.example.test/pod')).toBe('http://logs.example.test/pod');
    expect(getSafeExternalUrl('https://logs.example.test/pod')).toBe('https://logs.example.test/pod');
  });

  it('rejects unsafe or relative URLs', () => {
    expect(getSafeExternalUrl('javascript:alert(1)')).toBeNull();
    expect(getSafeExternalUrl('//evil.example.test/path')).toBeNull();
    expect(getSafeExternalUrl('mailto:user@example.test')).toBeNull();
    expect(getSafeExternalUrl('data:text/plain,hello')).toBeNull();
    expect(getSafeExternalUrl('/relative/path')).toBeNull();
    expect(getSafeExternalUrl(null)).toBeNull();
  });
});
