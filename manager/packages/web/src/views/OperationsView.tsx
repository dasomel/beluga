import React from 'react';
import { Boxes, Construction, FileText, History, Link as LinkIcon, Server, Workflow } from 'lucide-react';
import type { Event } from '@beluga-manager/domain-api/schema';
import { Translations } from '../i18n/translations';
import { useEvents } from '../api/hooks';
import { SeverityBadge } from '../components/SeverityBadge';
import { LoadingState, ErrorState } from '../components/QueryState';

interface OperationsViewProps {
  t: Translations;
}

function sortByTimestampDesc(events: Event[]): Event[] {
  // GET /api/v1/events는 이미 최신순으로 정렬해 반환하지만(routes/events.ts), API가 순서를
  // 보장한다고 프론트엔드가 암묵적으로 가정하지 않도록 여기서도 방어적으로 재정렬한다.
  return [...events].sort((a, b) => b.timestamp.localeCompare(a.timestamp));
}

interface ReferencePillProps {
  icon: typeof Server;
  label: string;
  value: string;
}

// 상관관계 참조는 정보 제공용 표시일 뿐 클릭 가능한 링크가 아니다 -- Operations view 리포트의
// drill-down 판단 참고.
const ReferencePill: React.FC<ReferencePillProps> = ({ icon: Icon, label, value }) => (
  <span
    title={`${label}: ${value}`}
    className="inline-flex items-center gap-1.5 rounded-full bg-slate-100 dark:bg-slate-800 px-2.5 py-0.5 text-[11px] font-mono font-bold text-slate-700 dark:text-slate-300 border border-slate-200 dark:border-slate-700 whitespace-nowrap"
  >
    <Icon className="h-3 w-3 flex-shrink-0" aria-hidden="true" />
    {value}
  </span>
);

export const OperationsView: React.FC<OperationsViewProps> = ({ t }) => {
  const eventsQuery = useEvents();
  const events = sortByTimestampDesc(eventsQuery.data?.data ?? []);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-white">{t.operations.title}</h1>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-300 font-medium">{t.operations.subtitle}</p>
      </div>

      {/* Section Switcher -- same pattern as ArchitectureView's perspective switcher: only
          Events is functional for this MVP slice, Resources/Logs are disabled placeholders. */}
      <div className="inline-flex flex-wrap items-center gap-1.5 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-1.5 shadow-xs">
        <span className="flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-bold bg-cyan-50 dark:bg-cyan-950/60 text-cyan-900 dark:text-cyan-200 border border-cyan-300 dark:border-cyan-500/50">
          <History className="h-4 w-4" />
          {t.operations.eventsTab}
        </span>
        {/* TODO(#19): Resources (K8s Namespace/Workload/Pod/Service/Endpoint/PVC + CPU/Memory
            status) plugs in here once domain-api exposes those concepts -- out of scope for
            this MVP slice. */}
        <button
          type="button"
          disabled
          aria-disabled="true"
          title={t.operations.resourcesHint}
          className="flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-bold text-slate-400 dark:text-slate-500 cursor-not-allowed"
        >
          <Boxes className="h-4 w-4" />
          {t.operations.resourcesTab}
          <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 px-2 py-0.5 text-[10px] font-bold text-slate-500 dark:text-slate-400">
            <Construction className="h-2.5 w-2.5" />
            {t.operations.comingSoon}
          </span>
        </button>
        {/* TODO(#19): Logs will drill down into the platform's existing observability backend
            (e.g. Loki) -- no real instance/URL exists in this environment yet, and per the
            issue's own principle Manager provides navigation UX rather than hosting logs itself. */}
        <button
          type="button"
          disabled
          aria-disabled="true"
          title={t.operations.logsHint}
          className="flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-bold text-slate-400 dark:text-slate-500 cursor-not-allowed"
        >
          <FileText className="h-4 w-4" />
          {t.operations.logsTab}
          <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 px-2 py-0.5 text-[10px] font-bold text-slate-500 dark:text-slate-400">
            <Construction className="h-2.5 w-2.5" />
            {t.operations.comingSoon}
          </span>
        </button>
      </div>

      {eventsQuery.isLoading && <LoadingState t={t} />}
      {!eventsQuery.isLoading && eventsQuery.isError && <ErrorState t={t} error={eventsQuery.error} />}

      {!eventsQuery.isLoading && !eventsQuery.isError && (
        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-xs backdrop-blur-sm overflow-hidden">
          <div className="flex items-center gap-1.5 text-[11px] text-slate-500 dark:text-slate-400 font-medium px-5 pt-4">
            <LinkIcon className="h-3.5 w-3.5" />
            {t.operations.deepLinkNote}
          </div>

          {events.length === 0 ? (
            <p className="p-8 text-center text-sm text-slate-500 dark:text-slate-400 font-medium">
              {t.operations.emptyState}
            </p>
          ) : (
            <ul className="divide-y divide-slate-200 dark:divide-slate-800/80 mt-3">
              {events.map((event) => (
                <li key={event.id} className="p-5 flex flex-col gap-2.5 sm:flex-row sm:items-start sm:justify-between">
                  <div className="flex items-start gap-3 min-w-0">
                    <SeverityBadge severity={event.severity} t={t} />
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-slate-900 dark:text-white">{event.message}</p>
                      <p className="text-xs font-mono text-slate-500 dark:text-slate-400 mt-1">
                        {new Date(event.timestamp).toLocaleString()}
                      </p>
                    </div>
                  </div>

                  {(event.relatedServiceId || event.relatedPipelineId) && (
                    <div className="flex flex-wrap gap-1.5 sm:flex-shrink-0">
                      {event.relatedServiceId && (
                        <ReferencePill
                          icon={Server}
                          label={t.operations.relatedServiceLabel}
                          value={event.relatedServiceId}
                        />
                      )}
                      {event.relatedPipelineId && (
                        <ReferencePill
                          icon={Workflow}
                          label={t.operations.relatedPipelineLabel}
                          value={event.relatedPipelineId}
                        />
                      )}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
};
