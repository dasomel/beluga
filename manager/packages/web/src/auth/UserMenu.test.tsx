import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getTranslations } from '../i18n/getTranslations';
import { UserMenu } from './UserMenu';

const mocks = vi.hoisted(() => ({ groups: ['token-fallback'], status: 'success' as 'success' | 'empty' | 'error' }));

vi.mock('./AuthContext', () => ({
  useAuth: () => ({ status: 'authenticated', user: { name: 'beluga-admin', groups: ['token-fallback'] }, logout: vi.fn() }),
}));
vi.mock('../api/hooks', () => ({
  useMe: () => ({ data: mocks.status === 'success' ? { sub: 'user-1', name: 'beluga-admin', groups: mocks.groups } : mocks.status === 'empty' ? { sub: 'user-1', groups: [] } : undefined, isError: mocks.status === 'error' }),
}));

describe('UserMenu groups', () => {
  beforeEach(() => { mocks.groups = ['admins']; mocks.status = 'success'; });

  it('renders groups from /me', () => {
    const html = renderToStaticMarkup(<UserMenu t={getTranslations('ko-KR')} />);
    expect(html).toContain('admins');
    expect(html).not.toContain('token-fallback');
  });

  it("shows '그룹 없음' when /me has no groups", () => {
    mocks.status = 'empty';
    const html = renderToStaticMarkup(<UserMenu t={getTranslations('ko-KR')} />);
    expect(html).toContain('그룹 없음');
  });

  it("shows '그룹 없음' on /me error, matching the existing empty fallback", () => {
    mocks.status = 'error';
    const html = renderToStaticMarkup(<UserMenu t={getTranslations('ko-KR')} />);
    expect(html).toContain('그룹 없음');
  });
});
