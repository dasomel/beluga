import React from 'react';
import { FlaskConical } from 'lucide-react';
import { useDomainApiHealth } from '../api/hooks';
import type { Translations } from '../i18n/translations';

// D-MDEV-2: the API reports which adapters still serve built-in fixtures; the UI says so instead of letting
// fixture data pass as live state. Renders nothing until health answers or when no adapter is a stub.
export const FixtureDataBadge: React.FC<{ t: Translations }> = ({ t }) => {
  const { data } = useDomainApiHealth();
  const components = data?.components;
  const stubs = [
    components?.flink === 'stub' ? 'flink' : null,
    components?.lakekeeper === 'stub' ? 'lakekeeper' : null,
  ].filter((name): name is string => name !== null);
  if (stubs.length === 0) return null;
  return (
    <span
      title={`${t.auth.fixtureDataHint}${stubs.join(', ')}`}
      className="inline-flex items-center gap-1.5 text-xs font-semibold px-2.5 py-1 rounded bg-amber-50 dark:bg-amber-950/50 text-amber-800 dark:text-amber-300 border border-amber-200 dark:border-amber-700"
    >
      <FlaskConical className="h-3.5 w-3.5" aria-hidden="true" />
      {t.auth.fixtureData}
    </span>
  );
};
