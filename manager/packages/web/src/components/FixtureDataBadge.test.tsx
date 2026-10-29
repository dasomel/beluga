import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getTranslations } from '../i18n/getTranslations';
import { FixtureDataBadge, stubComponents } from './FixtureDataBadge';

const mocks = vi.hoisted(() => ({ health: undefined as unknown }));

vi.mock('../api/hooks', () => ({
  useDomainApiHealth: () => ({ data: mocks.health }),
}));

const render = (locale: 'en-US' | 'ko-KR') => renderToStaticMarkup(<FixtureDataBadge t={getTranslations(locale)} />);

describe('FixtureDataBadge', () => {
  beforeEach(() => {
    mocks.health = undefined;
  });

  it('renders nothing before health answers or when the API reports no components', () => {
    expect(render('en-US')).toBe('');
    mocks.health = { status: 'healthy', version: '1' };
    expect(render('en-US')).toBe('');
  });

  it('shows the localized badge and names the stub adapters', () => {
    mocks.health = { status: 'healthy', version: '1', components: { flink: 'stub', trinoQueryHistory: 'disabled', lakekeeper: 'live', fixtures: 'live' } };
    const en = render('en-US');
    expect(en).toContain('Fixture data');
    expect(en).toContain('flink');
    expect(en).not.toContain('lakekeeper');
    expect(en).not.toContain('fixtures');
    expect(render('ko-KR')).toContain('픽스처 데이터');
  });

  it('still shows the badge when Flink and Lakekeeper are live but fixtures remain', () => {
    mocks.health = { status: 'healthy', version: '1', components: { flink: 'live', trinoQueryHistory: 'live', lakekeeper: 'live', fixtures: 'stub' } };
    expect(render('en-US')).toContain('fixtures');
  });

  it('is hidden only when every component is live', () => {
    const live = { flink: 'live', trinoQueryHistory: 'live', lakekeeper: 'live', fixtures: 'live' } as const;
    expect(stubComponents(live)).toEqual([]);
    expect(stubComponents({ ...live, fixtures: 'stub' })).toEqual(['fixtures']);
    expect(stubComponents(undefined)).toEqual([]);
    mocks.health = { status: 'healthy', version: '1', components: live };
    expect(render('en-US')).toBe('');
  });
});
