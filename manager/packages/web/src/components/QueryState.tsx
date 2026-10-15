import React from 'react';
import { AlertOctagon, Loader2 } from 'lucide-react';
import { Translations } from '../i18n/translations';

interface QueryStateProps {
  t: Translations;
}

export const LoadingState: React.FC<QueryStateProps> = ({ t }) => (
  <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-8 shadow-xs flex items-center justify-center gap-2.5 text-sm text-slate-500 dark:text-slate-400 font-medium">
    <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
    {t.common.loading}
  </div>
);

interface ErrorStateProps extends QueryStateProps {
  error: unknown;
}

export const ErrorState: React.FC<ErrorStateProps> = ({ t, error }) => (
  <div className="rounded-xl border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-950/40 p-8 flex items-center gap-2.5 text-sm text-red-800 dark:text-red-300 font-medium">
    <AlertOctagon className="h-4 w-4 flex-shrink-0" aria-hidden="true" />
    <span>
      {t.common.loadError}
      {error instanceof Error ? `: ${error.message}` : null}
    </span>
  </div>
);
