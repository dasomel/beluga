import React from 'react';
import { LogOut, ShieldOff } from 'lucide-react';
import type { Translations } from '../i18n/translations';
import { useAuth } from './AuthContext';

export const UserMenu: React.FC<{ t: Translations }> = ({ t }) => {
  const auth = useAuth();
  if (auth.status === 'disabled') {
    return (
      <span
        title={t.auth.loginDisabledHint}
        className="inline-flex items-center gap-1.5 text-xs font-semibold px-2.5 py-1 rounded bg-amber-50 dark:bg-amber-950/50 text-amber-800 dark:text-amber-300 border border-amber-200 dark:border-amber-700"
      >
        <ShieldOff className="h-3.5 w-3.5" aria-hidden="true" />
        {t.auth.loginDisabled}
      </span>
    );
  }
  if (auth.status !== 'authenticated' || !auth.user) return null;
  return (
    <div className="flex items-center gap-3 text-xs">
      <div className="text-right">
        <div className="font-bold text-slate-900 dark:text-white" aria-label={t.auth.userLabel}>{auth.user.name}</div>
        <div className="text-[11px] text-slate-500 dark:text-slate-400 font-mono" aria-label={t.auth.groupsLabel}>
          {auth.user.groups.length > 0 ? auth.user.groups.join(', ') : t.auth.noGroups}
        </div>
      </div>
      <button
        type="button"
        onClick={auth.logout}
        className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 hover:bg-slate-100 dark:hover:bg-slate-700 text-slate-800 dark:text-slate-100 font-bold transition-colors"
      >
        <LogOut className="h-3.5 w-3.5" aria-hidden="true" />
        {t.auth.logout}
      </button>
    </div>
  );
};
