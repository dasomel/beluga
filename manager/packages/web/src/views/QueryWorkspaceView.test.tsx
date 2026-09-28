import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { getTranslations } from '../i18n/getTranslations';
import { QueryWorkspaceView } from './QueryWorkspaceView';

const tEn = getTranslations('en-US');
const tKo = getTranslations('ko-KR');

describe('QueryWorkspaceView', () => {
  it('defaults to the first preset query and its results when no initial SQL is provided', () => {
    const html = renderToStaticMarkup(<QueryWorkspaceView t={tEn} />);
    expect(html).toContain(tEn.query.title);
    expect(html).toContain(tEn.query.presetRevenue);
    expect(html).toContain('FROM beluga_lake.default.orders');
    expect(html).toContain(tEn.query.querySucceeded);
    expect(html).not.toContain(tEn.query.catalogSource);
  });

  it('renders a caller-provided initialSql instead of the default preset', () => {
    const html = renderToStaticMarkup(
      <QueryWorkspaceView t={tEn} initialSql={'SELECT 1 FROM beluga_lake.analytics.orders LIMIT 1;'} />,
    );
    expect(html).toContain('SELECT 1 FROM beluga_lake.analytics.orders LIMIT 1;');
  });

  it('shows the catalog source breadcrumb when a catalogSource is provided (catalog -> query handoff)', () => {
    const html = renderToStaticMarkup(
      <QueryWorkspaceView
        t={tEn}
        initialSql={'SELECT order_id FROM beluga_lake.analytics.orders LIMIT 20;'}
        catalogSource={{ catalog: 'beluga_lake', schema: 'analytics', table: 'orders' }}
      />,
    );
    expect(html).toContain('SELECT order_id FROM beluga_lake.analytics.orders LIMIT 20;');
    expect(html).toContain(tEn.query.catalogSource);
    expect(html).toContain('beluga_lake.analytics.orders');
  });

  it('renders preset pills and Korean translations correctly', () => {
    const html = renderToStaticMarkup(<QueryWorkspaceView t={tKo} locale="ko-KR" />);
    expect(html).toContain(tKo.query.title);
    expect(html).toContain(tKo.query.presetQueries);
    expect(html).toContain(tKo.query.runQuery);
  });
});
