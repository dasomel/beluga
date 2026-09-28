import React, { useEffect, useState } from 'react';
import { Boxes, ExternalLink, FileText, History, Server, Workflow } from 'lucide-react';
import type { DecisionRecord, Event, Resource } from '@beluga-manager/domain-api/schema';
import { Translations, type Locale } from '../i18n/translations';
import { formatDateTime } from '../i18n/format';
import { useDecisions, useEvents, useResources } from '../api/hooks';
import { SeverityBadge } from '../components/SeverityBadge';
import { StatusBadge } from '../components/StatusBadge';
import { LoadingState, ErrorState } from '../components/QueryState';
import { getDecisionNavigationTargets, getEventNavigationTargets, getResourceNavigationTargets, type EventNavigationTarget } from './eventNavigation';
import { getSafeExternalUrl } from './safeExternalUrl';
import { getAbstainLabel, getDecisionLabel } from './decisionLabels';

interface OperationsViewProps {
  t: Translations;
  locale?: Locale;
  onNavigate: (target: EventNavigationTarget) => void;
  initialResourceId?: string;
  initialEventId?: string;
}

function sortByTimestampDesc(events: Event[]): Event[] {
  return [...events].sort((a, b) => b.timestamp.localeCompare(a.timestamp));
}

function sortDecisions(records: DecisionRecord[]): DecisionRecord[] {
  return [...records].sort((a, b) => b.evaluatedAt.localeCompare(a.evaluatedAt));
}

export const OperationsView: React.FC<OperationsViewProps> = ({ t, locale = 'en-US', onNavigate, initialResourceId, initialEventId }) => {
  const [section, setSection] = useState<'events' | 'resources' | 'decisions'>(initialResourceId ? 'resources' : 'events');
  const [eventFocusId, setEventFocusId] = useState<string | null>(initialEventId ?? null);
  const eventsQuery = useEvents();
  const resourcesQuery = useResources();
  const decisionsQuery = useDecisions();
  const events = sortByTimestampDesc(eventsQuery.data?.data ?? []).filter((event) => !eventFocusId || event.id === eventFocusId);
  const resources = resourcesQuery.data?.data ?? [];
  const decisions = sortDecisions(decisionsQuery.data?.data ?? []);

  useEffect(() => {
    if (initialResourceId) setSection('resources');
    if (initialEventId) { setEventFocusId(initialEventId); setSection('events'); }
  }, [initialResourceId, initialEventId]);

  const openLogs = (resource: Resource) => {
    const url = getSafeExternalUrl(resource.logsUrl);
    if (url) window.open(url, '_blank', 'noopener,noreferrer');
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-white">{t.operations.title}</h1>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-300 font-medium">{t.operations.subtitle}</p>
      </div>
      <div className="inline-flex flex-wrap items-center gap-1.5 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-1.5 shadow-xs">
        <button type="button" onClick={() => { setEventFocusId(null); setSection('events'); }} className={`flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-bold ${section === 'events' ? 'bg-cyan-50 dark:bg-cyan-950/60 text-cyan-900 dark:text-cyan-200' : 'text-slate-500'}`}><History className="h-4 w-4" />{t.operations.eventsTab}</button>
        <button type="button" onClick={() => setSection('resources')} className={`flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-bold ${section === 'resources' ? 'bg-cyan-50 dark:bg-cyan-950/60 text-cyan-900 dark:text-cyan-200' : 'text-slate-500'}`}><Boxes className="h-4 w-4" />{t.operations.resourcesTab}</button>
        <button type="button" onClick={() => setSection('decisions')} className={`flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-bold ${section === 'decisions' ? 'bg-cyan-50 dark:bg-cyan-950/60 text-cyan-900 dark:text-cyan-200' : 'text-slate-500'}`}><History className="h-4 w-4" />{t.operations.decisionsTab}</button>
      </div>

      {section === 'decisions' && <section aria-labelledby="decisions-title" className="space-y-3">
        <div><h2 id="decisions-title" className="text-lg font-bold text-slate-900 dark:text-white">{t.operations.decisionsTitle}</h2><p className="mt-1 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm font-semibold text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">{t.operations.decisionsNotice}</p></div>
        {decisionsQuery.isLoading && <LoadingState t={t} />}
        {!decisionsQuery.isLoading && decisionsQuery.isError && <ErrorState t={t} error={decisionsQuery.error} />}
        {!decisionsQuery.isLoading && !decisionsQuery.isError && (decisions.length === 0 ? <p className="rounded-xl border border-slate-200 p-8 text-center text-sm text-slate-500">{t.operations.emptyDecisionsState}</p> : <ul className="space-y-3">{decisions.map((record) => {
          const targets = getDecisionNavigationTargets(record);
          return <li key={record.id} className="rounded-xl border border-slate-200 bg-white p-5 shadow-xs dark:border-slate-800 dark:bg-slate-900">
            <div className="flex flex-wrap items-center gap-2"><span className={`rounded-full px-2.5 py-1 text-xs font-bold ${record.result.abstained ? 'bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200' : 'bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200'}`}>{getDecisionLabel(record, t)}</span><span className="text-xs text-slate-500">{formatDateTime(record.evaluatedAt, locale)}</span></div>
            <p className="mt-2 text-sm text-slate-600 dark:text-slate-300">{t.operations.advisoryConfidence}: {record.result.confidence}</p>
            {getAbstainLabel(record, t) && <p className="mt-1 text-sm text-amber-800 dark:text-amber-200">{getAbstainLabel(record, t)}</p>}
            <dl className="mt-3 grid gap-2 text-xs sm:grid-cols-2"><div><dt className="inline font-semibold">{t.operations.providerLabel}: </dt><dd className="inline font-mono">{record.result.provider} {record.result.providerVersion}</dd></div><div><dt className="inline font-semibold">{t.operations.policyLabel}: </dt><dd className="inline font-mono">{record.result.policyVersion}</dd></div><div><dt className="inline font-semibold">{t.operations.correlationLabel}: </dt><dd className="inline font-mono">{record.correlationId}</dd></div><div><dt className="inline font-semibold">{t.operations.evidenceLabel}: </dt><dd className="inline">{record.result.evidenceRefs.length ? record.result.evidenceRefs.map((ref) => `${ref.source} (${formatDateTime(ref.observedAt, locale)})`).join(', ') : t.operations.emptyEvidenceLabel}</dd></div><div><dt className="inline font-semibold">{t.operations.inputsEvaluatedLabel}: </dt><dd className="inline">{record.inputSignals.map((signal) => `${signal.name} (${formatDateTime(signal.observedAt, locale)} · ${signal.freshAtEvaluation ? t.operations.freshLabel : t.operations.staleLabel})`).join(', ') || t.operations.noInputsEvaluatedLabel}</dd></div></dl>
            {targets.length > 0 && <div className="mt-3 flex flex-wrap gap-2">{targets.map((target) => { const label = target.resource ? t.operations.relatedResourceLabel : target.tab === 'services' ? t.operations.relatedServiceLabel : t.operations.relatedPipelineLabel; const Icon = target.resource ? Boxes : target.tab === 'services' ? Server : Workflow; return <button key={`${target.tab}-${target.id}`} type="button" onClick={() => onNavigate(target)} aria-label={`${label}: ${target.id}`} className="inline-flex items-center gap-1.5 rounded-full border border-cyan-200 bg-cyan-50 px-2.5 py-1 text-[11px] font-mono font-bold text-cyan-800 dark:border-cyan-700 dark:bg-cyan-950 dark:text-cyan-200"><Icon className="h-3 w-3" aria-hidden="true" />{target.id}</button>; })}</div>}
          </li>;
        })}</ul>)}
      </section>}

      {section === 'events' && <>
        {eventsQuery.isLoading && <LoadingState t={t} />}
        {!eventsQuery.isLoading && eventsQuery.isError && <ErrorState t={t} error={eventsQuery.error} />}
        {!eventsQuery.isLoading && !eventsQuery.isError && <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-xs overflow-hidden">
          <div className="flex items-center gap-1.5 text-[11px] text-slate-500 dark:text-slate-400 font-medium px-5 pt-4"><History className="h-3.5 w-3.5" />{t.operations.deepLinkNote}</div>
          {events.length === 0 ? <p className="p-8 text-center text-sm text-slate-500">{t.operations.emptyState}</p> : <ul className="divide-y divide-slate-200 dark:divide-slate-800/80 mt-3">
            {events.map((event) => <li key={event.id} className="p-5 flex flex-col gap-2.5 sm:flex-row sm:items-start sm:justify-between">
              <div className="flex items-start gap-3 min-w-0"><SeverityBadge severity={event.severity} t={t} /><div className="min-w-0"><p className="text-sm font-semibold text-slate-900 dark:text-white">{event.message}</p><p className="text-xs font-mono text-slate-500 mt-1">{formatDateTime(event.timestamp, locale)}</p></div></div>
              {(event.relatedServiceId || event.relatedPipelineId || event.relatedResourceId) && <div className="flex flex-wrap gap-1.5 sm:flex-shrink-0">{getEventNavigationTargets(event).map((target) => {
                const label = target.resource ? t.operations.relatedResourceLabel : target.tab === 'services' ? t.operations.relatedServiceLabel : t.operations.relatedPipelineLabel;
                const Icon = target.resource ? Boxes : target.tab === 'services' ? Server : Workflow;
                return <button key={`${target.tab}-${target.id}`} type="button" onClick={() => onNavigate(target)} aria-label={`${label}: ${target.id}`} className="inline-flex items-center gap-1.5 rounded-full bg-cyan-50 dark:bg-cyan-950 px-2.5 py-0.5 text-[11px] font-mono font-bold text-cyan-800 dark:text-cyan-200 border border-cyan-200 dark:border-cyan-700"><Icon className="h-3 w-3" aria-hidden="true" />{target.id}</button>;
              })}</div>}
            </li>)}
          </ul>}
        </div>}
      </>}

      {section === 'resources' && <>
        {resourcesQuery.isLoading && <LoadingState t={t} />}
        {!resourcesQuery.isLoading && resourcesQuery.isError && <ErrorState t={t} error={resourcesQuery.error} />}
        {!resourcesQuery.isLoading && !resourcesQuery.isError && <div className="overflow-x-auto rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-xs">
          <table className="w-full text-left text-sm">
            <thead className="bg-slate-50 dark:bg-slate-950 text-xs text-slate-500">
              <tr>
                <th className="p-4">{t.operations.kindLabel} / {t.services.columns.name}</th>
                <th className="p-4">{t.operations.namespaceLabel}</th>
                <th className="p-4">{t.common.status}</th>
                <th className="p-4">{t.operations.cpuLabel} / {t.operations.memoryLabel}</th>
                <th className="p-4">{t.operations.relatedServiceLabel} / {t.operations.relatedPipelineLabel}</th>
                <th className="p-4">{t.operations.logsTab}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 dark:divide-slate-800">
              {resources.map((resource) => {
                const relatedTargets = getResourceNavigationTargets(resource).filter((target) => !target.event);
                return <tr key={resource.id} className={resource.id === initialResourceId ? 'bg-cyan-50 dark:bg-cyan-950/30' : ''}>
                  <td className="p-4">
                    <div className="font-semibold text-slate-900 dark:text-white">{resource.name}</div>
                    <div className="text-xs font-mono text-slate-500">{resource.kind} · {resource.id}</div>
                    {resource.relatedEventIds.length > 0 && <div className="mt-1 flex gap-1">
                      {getResourceNavigationTargets(resource).filter((target) => target.event).map((target) => <button key={target.id} type="button" onClick={() => onNavigate(target)} className="text-[11px] text-cyan-700 dark:text-cyan-300 underline">{t.operations.relatedEventLabel}: {target.id}</button>)}
                    </div>}
                  </td>
                  <td className="p-4 font-mono text-xs">{resource.namespace ?? '—'}</td>
                  <td className="p-4"><StatusBadge status={resource.status} t={t} /></td>
                  <td className="p-4 font-mono text-xs">{resource.cpuUsage ?? '—'} / {resource.memoryUsage ?? '—'}</td>
                  <td className="p-4">
                    {relatedTargets.length > 0 ? <div className="flex flex-col gap-1">
                      {relatedTargets.map((target) => {
                        const Icon = target.tab === 'services' ? Server : Workflow;
                        return <button key={target.tab} type="button" onClick={() => onNavigate(target)} className="text-left text-xs text-cyan-700 dark:text-cyan-300"><Icon className="inline h-3 w-3 mr-1" />{target.id}</button>;
                      })}
                    </div> : <span className="text-slate-400">—</span>}
                  </td>
                  <td className="p-4">{resource.logsUrl ? <button type="button" onClick={() => openLogs(resource)} className="inline-flex items-center gap-1 text-xs text-cyan-700 dark:text-cyan-300"><FileText className="h-3 w-3" />{t.operations.viewLogs}<ExternalLink className="h-3 w-3" /></button> : <span title={t.operations.noLogsLink} className="text-slate-400">—</span>}</td>
                </tr>;
              })}
            </tbody>
          </table>
          {resources.length === 0 && <p className="p-8 text-center text-sm text-slate-500">{t.operations.emptyResourcesState}</p>}
        </div>}
      </>}
    </div>
  );
};
