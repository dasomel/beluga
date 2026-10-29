import React from 'react';
import { FlaskConical } from 'lucide-react';
import { useDomainApiHealth } from '../api/hooks';
import type { DomainApiHealthResponse } from '../api/types';
import type { Translations } from '../i18n/translations';

// Names of the health components that report 'stub' (built-in fixture data).
export function stubComponents(components: DomainApiHealthResponse['components']): string[] {
  return Object.entries(components ?? {})
    .filter(([, mode]) => mode === 'stub')
    .map(([name]) => name);
}

// D-MDEV-2: the API reports which parts still serve built-in fixtures; the UI says so instead of letting
// fixture data pass as live state. Hidden only when every reported component is live (or none are reported).
export const FixtureDataBadge: React.FC<{ t: Translations }> = ({ t }) => {
  const { data } = useDomainApiHealth();
  const stubs = stubComponents(data?.components);
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
