import React, { useState } from 'react';
import { ExternalLink, GitPullRequest } from 'lucide-react';
import type { Translations, Locale } from '../i18n/translations';
import { formatDateTime } from '../i18n/format';
import { interpolate } from '../i18n/interpolate';
import { useCancelSsoChange, useOpenSsoChanges } from '../api/hooks';
import type { SsoChangeRecord } from '../api/types';
import { getSafeExternalUrl } from './safeExternalUrl';
import { describeSsoError, stageLabel } from './ssoChangeSupport';

// D-MSSO-13: open requests with stage and PR link; polled while this component is mounted.
// Admin-only (the list route is admin-gated); the parent mounts it only for admins.

interface SsoChangeBannerProps {
  t: Translations;
  locale: Locale;
}

const MAX_REASON = 500;

const ChangeItem: React.FC<SsoChangeBannerProps & { record: SsoChangeRecord }> = ({ t, locale, record }) => {
  const c = t.sso.change;
  const cancel = useCancelSsoChange();
  const [confirming, setConfirming] = useState(false);
  const [reason, setReason] = useState('');
  const prUrl = getSafeExternalUrl(record.pr?.url);
  const cancellable = record.stage === 'submitted' || record.stage === 'pr_open' || record.stage === 'unknown_recovering';
  const failure = cancel.error ? describeSsoError(t, cancel.error) : null;

  return (
    <li className="py-3 space-y-2" data-testid={`sso-open-${record.id}`}>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
        <span className="px-2 py-0.5 rounded-full font-bold bg-cyan-100 dark:bg-cyan-900 text-cyan-900 dark:text-cyan-200 border border-cyan-300 dark:border-cyan-700">
          {stageLabel(t, record.stage)}
        </span>
        <span className="text-slate-500 dark:text-slate-400">
          {c.endpointLabel}: <span className="font-mono font-bold text-slate-800 dark:text-slate-100">{record.endpoint}</span>
        </span>
        <span className="text-slate-500 dark:text-slate-400">
          {c.createdLabel}: <span className="font-mono">{formatDateTime(record.createdAt, locale)}</span>
        </span>
        {record.pr ? (
          prUrl ? (
            <a
              href={prUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 font-bold text-cyan-700 dark:text-cyan-400 hover:underline"
            >
              <GitPullRequest className="h-3.5 w-3.5" aria-hidden="true" />
              <span>{interpolate(c.openPr, { number: record.pr.number }, locale)}</span>
              <ExternalLink className="h-3 w-3" aria-hidden="true" />
            </a>
          ) : (
            <span className="font-bold text-slate-700 dark:text-slate-200">
              {interpolate(c.openPr, { number: record.pr.number }, locale)}
            </span>
          )
        ) : (
          <span className="italic text-slate-400">{c.noPr}</span>
        )}
        {cancellable && !confirming && (
          <button
            type="button"
            onClick={() => setConfirming(true)}
            className="ml-auto px-2.5 py-1 rounded-md border border-rose-300 dark:border-rose-700 text-rose-700 dark:text-rose-300 font-bold hover:bg-rose-50 dark:hover:bg-rose-950"
          >
            {c.cancelRequest}
          </button>
        )}
      </div>
      {record.stage === 'merged' && <p className="text-[11px] text-slate-500 dark:text-slate-400">{c.mergedNote}</p>}
      {confirming && (
        <div role="alertdialog" aria-label={c.cancelConfirmTitle} className="rounded-lg border border-rose-300 dark:border-rose-800 bg-rose-50 dark:bg-rose-950/40 p-3 space-y-2">
          <p className="text-xs font-bold text-rose-900 dark:text-rose-200">{c.cancelConfirmTitle}</p>
          <label className="block text-[11px] text-slate-600 dark:text-slate-300">
            {c.cancelReasonLabel}
            <input
              type="text"
              maxLength={MAX_REASON}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              className="mt-1 block w-full rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1 text-xs"
            />
          </label>
          <div className="flex gap-2">
            <button
              type="button"
              disabled={cancel.isPending}
              onClick={() =>
                cancel.mutate(
                  { id: record.id, reason: reason.trim() || undefined },
                  { onSuccess: () => setConfirming(false) },
                )
              }
              className="px-2.5 py-1 rounded-md bg-rose-600 text-white text-xs font-bold hover:bg-rose-700 disabled:opacity-50"
            >
              {cancel.isPending ? c.cancelling : c.cancelConfirm}
            </button>
            <button
              type="button"
              disabled={cancel.isPending}
              onClick={() => setConfirming(false)}
              className="px-2.5 py-1 rounded-md border border-slate-300 dark:border-slate-700 text-xs font-bold"
            >
              {c.cancelKeep}
            </button>
          </div>
        </div>
      )}
      {failure && (
        <p role="alert" className="text-xs text-rose-700 dark:text-rose-300">
          {failure.message}
          {failure.detail && failure.detail !== failure.message && (
            <span className="block font-mono text-[11px] text-slate-500">
              {c.serverMessage}: {failure.detail}
            </span>
          )}
        </p>
      )}
    </li>
  );
};

export const SsoChangeBanner: React.FC<SsoChangeBannerProps> = ({ t, locale }) => {
  const { data, error } = useOpenSsoChanges(true);
  const items = data?.items ?? [];
  const failure = error ? describeSsoError(t, error) : null;

  if (items.length === 0 && !failure) return null;

  return (
    <section
      aria-label={t.sso.change.openTitle}
      className="rounded-xl border border-amber-200 dark:border-amber-800 bg-amber-50/70 dark:bg-amber-950/30 p-4 shadow-xs"
    >
      <h2 className="text-sm font-bold text-slate-900 dark:text-white">{t.sso.change.openTitle}</h2>
      <p className="text-[11px] text-slate-500 dark:text-slate-400">{t.sso.change.openSubtitle}</p>
      {failure && (
        <p role="alert" className="mt-2 text-xs text-rose-700 dark:text-rose-300">
          {failure.message}
        </p>
      )}
      <ul className="mt-1 divide-y divide-amber-200/70 dark:divide-amber-900">
        {items.map((record) => (
          <ChangeItem key={record.id} t={t} locale={locale} record={record} />
        ))}
      </ul>
    </section>
  );
};
