import React from 'react';
import { KeyRound, Loader2, AlertOctagon } from 'lucide-react';
import type { Translations } from '../i18n/translations';
import { useAuth } from './AuthContext';

export const LoginScreen: React.FC<{ t: Translations }> = ({ t }) => {
  const auth = useAuth();
  const busy = auth.status === 'loading';
  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50 dark:bg-slate-950 p-6">
      <div className="w-full max-w-sm rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-8 shadow-xs space-y-5">
        <div className="flex items-center gap-2.5">
          <KeyRound className="h-5 w-5 text-cyan-700 dark:text-cyan-400" aria-hidden="true" />
          <h1 className="text-lg font-bold tracking-tight text-slate-900 dark:text-white">{t.auth.loginTitle}</h1>
        </div>
        <p className="text-sm text-slate-600 dark:text-slate-300">{t.auth.loginDescription}</p>
        {auth.expired && (
          <p role="alert" className="text-sm font-medium text-amber-800 dark:text-amber-300">{t.auth.sessionExpired}</p>
        )}
        {auth.status === 'error' && (
          <p role="alert" className="flex items-start gap-2 text-sm font-medium text-red-800 dark:text-red-300">
            <AlertOctagon className="h-4 w-4 flex-shrink-0 mt-0.5" aria-hidden="true" />
            <span>{t.auth.loginFailed}{auth.errorMessage ? `: ${auth.errorMessage}` : null}</span>
          </p>
        )}
        <button
          type="button"
          onClick={auth.login}
          disabled={busy}
          className="w-full flex items-center justify-center gap-2 py-2.5 rounded-lg bg-cyan-700 hover:bg-cyan-600 disabled:opacity-60 text-white text-sm font-bold transition-colors"
        >
          {busy && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
          {busy ? t.auth.signingIn : t.auth.loginButton}
        </button>
      </div>
    </div>
  );
};
