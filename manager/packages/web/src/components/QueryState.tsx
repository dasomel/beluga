import React from 'react';
import { AlertOctagon, Loader2, ShieldAlert } from 'lucide-react';
import { ApiError } from '../api/client';
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

export const ErrorState: React.FC<ErrorStateProps> = ({ t, error }) => {
  // D-MSSO-7: 403 means signed in but not in an allowed group; say so instead of a generic failure.
  if (error instanceof ApiError && error.status === 403) {
    return (
      <div role="alert" className="rounded-xl border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/40 p-8 text-sm text-amber-900 dark:text-amber-200">
        <div className="flex items-center gap-2.5 font-bold">
          <ShieldAlert className="h-4 w-4 flex-shrink-0" aria-hidden="true" />
          {t.auth.forbiddenTitle}
        </div>
        <p className="mt-2 font-medium">{t.auth.forbiddenDescription}</p>
      </div>
    );
  }
  return (
    <div className="rounded-xl border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-950/40 p-8 flex items-center gap-2.5 text-sm text-red-800 dark:text-red-300 font-medium">
      <AlertOctagon className="h-4 w-4 flex-shrink-0" aria-hidden="true" />
      <span>
        {t.common.loadError}
        {error instanceof Error ? `: ${error.message}` : null}
      </span>
    </div>
  );
};
