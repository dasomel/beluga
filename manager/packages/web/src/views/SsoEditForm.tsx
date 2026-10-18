import React, { useMemo, useRef, useState } from 'react';
import { ExternalLink } from 'lucide-react';
import type { Translations, Locale } from '../i18n/translations';
import { interpolate } from '../i18n/interpolate';
import { ApiError } from '../api/client';
import { usePreviewSsoChange, useSubmitSsoChange } from '../api/hooks';
import type { SsoChangeContract, SsoChangeDraft, SsoChangePreview } from '../api/types';
import { getSafeExternalUrl } from './safeExternalUrl';
import { describeSsoError, draftFingerprint, newIdempotencyKey, stageLabel } from './ssoChangeSupport';

// D-MSSO-13: the form is rendered from the server's edit contract; the server decides validity and its
// errors are shown. Idempotency-Key: one per draft, reused on retry of the same draft, new when it changes.

interface SsoEditFormProps {
  t: Translations;
  locale: Locale;
  endpoint: string;
  contract: SsoChangeContract;
  onClose: () => void;
}

const MAX_REASON = 500;

const diffLineClass = (line: string): string => {
  if (line.startsWith('+') && !line.startsWith('+++')) return 'bg-emerald-100/70 dark:bg-emerald-950/60 text-emerald-900 dark:text-emerald-200';
  if (line.startsWith('-') && !line.startsWith('---')) return 'bg-rose-100/70 dark:bg-rose-950/60 text-rose-900 dark:text-rose-200';
  return 'text-slate-600 dark:text-slate-300';
};

export const SsoEditForm: React.FC<SsoEditFormProps> = ({ t, locale, endpoint, contract, onClose }) => {
  const c = t.sso.change;
  const current = contract.current[endpoint] ?? null;
  const options = useMemo(
    () => [...new Set([...contract.requiredGroups, ...contract.availableGroups, ...(current ?? [])])],
    [contract, current],
  );
  const [selected, setSelected] = useState<Set<string>>(() => new Set([...(current ?? []), ...contract.requiredGroups]));
  const [reason, setReason] = useState('');
  const [preview, setPreview] = useState<{ value: SsoChangePreview; fingerprint: string } | null>(null);
  const keyRef = useRef<{ fingerprint: string; key: string } | null>(null);
  const previewMutation = usePreviewSsoChange();
  const submitMutation = useSubmitSsoChange();

  const draft: SsoChangeDraft = {
    endpoint,
    allowedGroups: options.filter((g) => selected.has(g)),
    ...(reason.trim() ? { reason: reason.trim() } : {}),
  };
  const previewStale = preview !== null && preview.fingerprint !== draftFingerprint(draft, preview.value.baseBlobSha);
  const submitted = submitMutation.data ?? null;
  // F3: a 200/201 answer is not always success. A replay of a key whose request ended answers 200 with the final
  // stage, so the outcome is decided by the stage, never by the HTTP status.
  const ended = submitted !== null && (submitted.stage === 'failed' || submitted.stage === 'rejected');
  const inProgress = submitted !== null && (submitted.stage === 'submitted' || submitted.stage === 'unknown_recovering');
  const opened = submitted !== null && !ended && !inProgress;
  const locked = submitted !== null && !ended; // an ended request frees the form for a NEW draft with a NEW key
  const prUrl = getSafeExternalUrl(submitted?.pr?.url);
  const error = submitMutation.error ?? previewMutation.error;
  const failure = error ? describeSsoError(t, error) : null;

  const toggle = (group: string) => {
    if (contract.requiredGroups.includes(group)) return;
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(group)) next.delete(group);
      else next.add(group);
      return next;
    });
  };

  const runPreview = () => {
    submitMutation.reset();
    previewMutation.mutate(draft, {
      onSuccess: (value) => setPreview({ value, fingerprint: draftFingerprint(draft, value.baseBlobSha) }),
    });
  };

  const runSubmit = () => {
    if (!preview || previewStale) return;
    const fingerprint = draftFingerprint(draft, preview.value.baseBlobSha);
    if (keyRef.current?.fingerprint !== fingerprint) keyRef.current = { fingerprint, key: newIdempotencyKey() };
    submitMutation.mutate(
      { draft, baseBlobSha: preview.value.baseBlobSha, idempotencyKey: keyRef.current.key },
      {
        onSuccess: (record) => {
          if (record.stage === 'failed' || record.stage === 'rejected') keyRef.current = null; // never replay a finished key
        },
        onError: (e) => {
          // D-MSSO-19a: the key's branch belongs to an earlier request; only a different key can succeed.
          if (e instanceof ApiError && e.code === 'IDEMPOTENCY_KEY_COLLISION') keyRef.current = null;
        },
      },
    );
  };

  return (
    <section
      aria-label={interpolate(c.editTitle, { endpoint }, locale)}
      className="rounded-xl border border-cyan-300 dark:border-cyan-700 bg-white dark:bg-slate-900 p-5 shadow-xs space-y-4"
    >
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-lg font-bold text-slate-900 dark:text-white">{interpolate(c.editTitle, { endpoint }, locale)}</h2>
        <button type="button" onClick={onClose} className="text-xs font-bold text-slate-500 hover:underline">
          {c.close}
        </button>
      </div>

      {!contract.gitWriterConfigured && <p className="text-xs text-amber-700 dark:text-amber-300">{c.writerUnconfigured}</p>}
      {current === null && <p className="text-xs text-amber-700 dark:text-amber-300">{c.currentUnrestricted}</p>}

      <fieldset className="space-y-1.5">
        <legend className="text-xs font-bold text-slate-600 dark:text-slate-300 mb-1">{c.groupsLegend}</legend>
        {options.map((group) => {
          const required = contract.requiredGroups.includes(group);
          return (
            <label key={group} className="flex items-center gap-2 text-sm font-mono">
              <input type="checkbox" checked={selected.has(group)} disabled={required} onChange={() => toggle(group)} />
              <span>{group}</span>
              {required && <span className="font-sans text-[11px] text-slate-500">{c.requiredHint}</span>}
            </label>
          );
        })}
      </fieldset>

      <label className="block text-xs font-bold text-slate-600 dark:text-slate-300">
        {c.reasonLabel}
        <textarea
          value={reason}
          maxLength={MAX_REASON}
          placeholder={c.reasonPlaceholder}
          onChange={(e) => setReason(e.target.value)}
          rows={2}
          className="mt-1 block w-full rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-2 py-1 text-xs font-normal"
        />
      </label>

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={runPreview}
          disabled={previewMutation.isPending || submitMutation.isPending || locked}
          className="px-3 py-1.5 rounded-md border border-cyan-600 text-cyan-800 dark:text-cyan-300 text-xs font-bold hover:bg-cyan-50 dark:hover:bg-cyan-950 disabled:opacity-50"
        >
          {previewMutation.isPending ? c.previewing : c.preview}
        </button>
        {preview && !locked && (
          <button
            type="button"
            onClick={runSubmit}
            disabled={previewStale || submitMutation.isPending}
            className="px-3 py-1.5 rounded-md bg-cyan-700 text-white text-xs font-bold hover:bg-cyan-800 disabled:opacity-50"
          >
            {submitMutation.isPending ? c.submitting : c.submit}
          </button>
        )}
      </div>

      {preview && (
        <div className="space-y-2" aria-label={c.previewTitle} role="group">
          <h3 className="text-sm font-bold text-slate-900 dark:text-white">{c.previewTitle}</h3>
          <div className="text-xs text-slate-600 dark:text-slate-300 space-y-0.5">
            <div>
              {c.beforeLabel}: <span className="font-mono">{preview.value.before ? preview.value.before.join(', ') : c.unrestricted}</span>
            </div>
            <div>
              {c.afterLabel}: <span className="font-mono">{preview.value.after.join(', ')}</span>
            </div>
            <div className="text-[11px] text-slate-500">
              {c.sourceCommit}: <span className="font-mono">{preview.value.sourceCommitSha.slice(0, 12)}</span>
            </div>
          </div>
          <pre className="overflow-x-auto rounded border border-slate-200 dark:border-slate-800 text-[11px] leading-5 font-mono">
            {preview.value.diff.split('\n').map((line, i) => (
              <div key={i} className={`px-2 ${diffLineClass(line)}`}>
                {line || ' '}
              </div>
            ))}
          </pre>
          {previewStale && <p className="text-xs text-amber-700 dark:text-amber-300">{c.previewStale}</p>}
        </div>
      )}

      {inProgress && (
        <p role="status" className="text-xs font-bold text-amber-700 dark:text-amber-300">
          {c.submitInProgress}
        </p>
      )}

      {ended && submitted && (
        <p role="alert" className="text-xs font-bold text-rose-700 dark:text-rose-300">
          {interpolate(c.submitEnded, { stage: stageLabel(t, submitted.stage) }, locale)}
        </p>
      )}

      {opened && submitted && (
        <p role="status" className="text-xs font-bold text-emerald-700 dark:text-emerald-300">
          {c.submitted}{' '}
          {submitted.pr && prUrl && (
            <a href={prUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 underline">
              {interpolate(c.openPr, { number: submitted.pr.number }, locale)}
              <ExternalLink className="h-3 w-3" aria-hidden="true" />
            </a>
          )}
        </p>
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
    </section>
  );
};
