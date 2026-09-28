import React from 'react';
import {
  Activity,
  AlertOctagon,
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  ChevronRight,
  Database,
  ExternalLink,
  GitFork,
  History,
  Server,
  ShieldCheck,
} from 'lucide-react';
import { formatDateTime } from '../i18n/format';
import { interpolateCount } from '../i18n/interpolate';
import type { Locale, Translations } from '../i18n/translations';
import { useDataAssetsCount, useDomainApiHealth, useEvents, usePipelines, useServices } from '../api/hooks';
import { ErrorState, LoadingState } from '../components/QueryState';
import { SeverityBadge } from '../components/SeverityBadge';
import { StatusBadge } from '../components/StatusBadge';
import { WarningsBadge } from '../components/WarningsBadge';
import type { EventNavigationTarget } from './eventNavigation';
import { countEventSeverities, createEventFocusTarget, selectRecentEvents } from './recentEvents';
import { getSafeExternalUrl } from './safeExternalUrl';

interface OverviewViewProps {
  t: Translations;
  locale?: Locale;
  onNavigate: (tab: string) => void;
  onNavigateToEventTarget?: (target: EventNavigationTarget) => void;
}

export const OverviewView: React.FC<OverviewViewProps> = ({ t, locale = 'en-US', onNavigate, onNavigateToEventTarget }) => {
  const healthQuery = useDomainApiHealth();
  const servicesQuery = useServices();
  const pipelinesQuery = usePipelines();
  const eventsQuery = useEvents();
  // Counts, not lists: `meta.total` on a `pageSize=1` request is exact regardless of how many
  // pages of assets exist, so the KPI/caption below stay correct past LIST_PAGE_SIZE. This card
  // is intentionally isolated from the page-level isLoading/isError gate below (like Recent
  // Events) so a data-assets outage doesn't blank the rest of Overview -- see its own
  // loading/error rendering further down.
  const tableAssetsCountQuery = useDataAssetsCount('table');
  const totalAssetsCountQuery = useDataAssetsCount();

  const isLoading = healthQuery.isLoading || servicesQuery.isLoading || pipelinesQuery.isLoading;
  const isError = healthQuery.isError || servicesQuery.isError || pipelinesQuery.isError;
  const loadError = healthQuery.error ?? servicesQuery.error ?? pipelinesQuery.error;

  const services = servicesQuery.data?.data ?? [];
  const pipelines = pipelinesQuery.data?.data ?? [];
  const events = eventsQuery.data?.data ?? [];
  const quickLinks = services.filter((svc) => svc.endpoint);
  const warnings = [
    ...(servicesQuery.data?.warnings ?? []),
    ...(pipelinesQuery.data?.warnings ?? []),
    ...(eventsQuery.data?.warnings ?? []),
  ];

  const recentEvents = selectRecentEvents(events, 5);
  const severityCounts = countEventSeverities(events);

  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-white">{t.overview.title}</h1>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-300 font-medium">{t.overview.subtitle}</p>
        </div>
        <WarningsBadge warnings={warnings} t={t} />
      </div>

      {isLoading && <LoadingState t={t} />}
      {!isLoading && isError && <ErrorState t={t} error={loadError} />}

      {!isLoading && !isError && (
        <>
          {/* KPI Cards */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 shadow-xs backdrop-blur-sm">
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">{t.overview.totalServices}</span>
                <div className="rounded-lg bg-cyan-50 dark:bg-cyan-950/80 p-2 text-cyan-700 dark:text-cyan-300 border border-cyan-100 dark:border-cyan-800/50">
                  <Server className="h-5 w-5" />
                </div>
              </div>
              <div className="mt-4 flex items-baseline gap-2">
                <span className="text-3xl font-bold text-slate-900 dark:text-white">{servicesQuery.data?.meta.total ?? services.length}</span>
                <span className="text-xs text-emerald-700 dark:text-emerald-400 flex items-center gap-1 font-bold">
                  <CheckCircle2 className="h-3.5 w-3.5" />
                  {services.filter((svc) => svc.status === 'healthy').length}/{services.length} {t.status.healthy.toLowerCase()}
                </span>
              </div>
            </div>

            <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 shadow-xs backdrop-blur-sm">
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">{t.overview.activePipelines}</span>
                <div className="rounded-lg bg-blue-50 dark:bg-blue-950/80 p-2 text-blue-700 dark:text-blue-300 border border-blue-100 dark:border-blue-800/50">
                  <GitFork className="h-5 w-5" />
                </div>
              </div>
              <div className="mt-4 flex items-baseline gap-2">
                <span className="text-3xl font-bold text-slate-900 dark:text-white">{pipelinesQuery.data?.meta.total ?? pipelines.length}</span>
                <span className="text-xs text-slate-500 dark:text-slate-300 font-semibold">
                  {pipelines.filter((pipeline) => pipeline.status === 'healthy').length}/{pipelines.length} {t.status.healthy.toLowerCase()}
                </span>
              </div>
            </div>

            <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 shadow-xs backdrop-blur-sm">
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">{t.overview.catalogTables}</span>
                <div className="rounded-lg bg-indigo-50 dark:bg-indigo-950/80 p-2 text-indigo-700 dark:text-indigo-300 border border-indigo-100 dark:border-indigo-800/50">
                  <Database className="h-5 w-5" />
                </div>
              </div>
              {(tableAssetsCountQuery.isLoading || totalAssetsCountQuery.isLoading) && (
                <div className="mt-4 h-9 w-24 rounded-lg bg-slate-100 dark:bg-slate-800 animate-pulse" aria-hidden="true" />
              )}
              {!tableAssetsCountQuery.isLoading &&
                !totalAssetsCountQuery.isLoading &&
                (tableAssetsCountQuery.isError || totalAssetsCountQuery.isError) && (
                  <div className="mt-4 flex items-center gap-1.5 text-xs font-bold text-amber-700 dark:text-amber-400">
                    <AlertTriangle className="h-4 w-4" aria-hidden="true" />
                    {t.overview.catalogTablesUnavailable}
                  </div>
                )}
              {!tableAssetsCountQuery.isLoading &&
                !totalAssetsCountQuery.isLoading &&
                !tableAssetsCountQuery.isError &&
                !totalAssetsCountQuery.isError && (
                  <div className="mt-4 flex items-baseline gap-2">
                    <span className="text-3xl font-bold text-slate-900 dark:text-white">
                      {tableAssetsCountQuery.data?.meta.total ?? 0}
                    </span>
                    <span className="text-xs text-slate-500 dark:text-slate-300 font-semibold">
                      {interpolateCount(t.overview.catalogTablesCaption, totalAssetsCountQuery.data?.meta.total ?? 0, locale)}
                    </span>
                  </div>
                )}
            </div>

            <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 shadow-xs backdrop-blur-sm">
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">{t.overview.clusterHealth}</span>
                <div className="rounded-lg bg-emerald-50 dark:bg-emerald-950/80 p-2 text-emerald-700 dark:text-emerald-300 border border-emerald-100 dark:border-emerald-800/50">
                  <Activity className="h-5 w-5" />
                </div>
              </div>
              <div className="mt-4 flex items-center gap-2">
                {healthQuery.data && <StatusBadge status={healthQuery.data.status} t={t} />}
                {healthQuery.data && (
                  <span className="text-xs text-slate-500 dark:text-slate-300 font-semibold font-mono">v{healthQuery.data.version}</span>
                )}
              </div>
            </div>
          </div>

          {/* Pipeline Snapshot */}
          <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-6 shadow-xs backdrop-blur-sm">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-bold text-slate-900 dark:text-white">{t.overview.pipelineFlow}</h2>
              <div className="flex items-center gap-4">
                <button
                  onClick={() => onNavigate('pipelines')}
                  className="flex items-center gap-1.5 text-xs font-bold text-cyan-700 dark:text-cyan-400 hover:text-cyan-900 dark:hover:text-cyan-300 transition-colors"
                >
                  {t.overview.viewTopology} <ArrowRight className="h-3.5 w-3.5" />
                </button>
                <button
                  onClick={() => onNavigate('architecture')}
                  className="flex items-center gap-1.5 text-xs font-bold text-cyan-700 dark:text-cyan-400 hover:text-cyan-900 dark:hover:text-cyan-300 transition-colors"
                >
                  {t.overview.viewArchitecture} <ArrowRight className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              {pipelines.map((pipeline) => (
                <div
                  key={pipeline.id}
                  className="relative rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 p-3.5 flex flex-col gap-2.5"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-bold text-xs text-slate-900 dark:text-white truncate">{pipeline.name}</span>
                    <StatusBadge status={pipeline.status} t={t} />
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {pipeline.stages.map((stage) => (
                      <span
                        key={stage.serviceId}
                        className="inline-flex items-center gap-1 rounded bg-slate-200/70 dark:bg-slate-800 px-1.5 py-0.5 text-[10px] font-mono font-bold text-slate-700 dark:text-slate-300 border border-slate-300 dark:border-slate-700"
                      >
                        {stage.serviceType}
                      </span>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Recent Events */}
          {eventsQuery.isLoading && <LoadingState t={t} />}
          {!eventsQuery.isLoading && eventsQuery.isError && <ErrorState t={t} error={eventsQuery.error} />}
          {!eventsQuery.isLoading && !eventsQuery.isError && (
            <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-6 shadow-xs backdrop-blur-sm">
              <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
                <div className="flex flex-wrap items-center gap-2.5">
                  <div className="flex items-center gap-2">
                    <History className="h-5 w-5 text-cyan-700 dark:text-cyan-400" />
                    <h2 className="text-lg font-bold text-slate-900 dark:text-white">{t.overview.recentEvents}</h2>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <span
                      role="status"
                      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-bold border ${
                        severityCounts.error > 0
                          ? 'bg-red-50 text-red-700 dark:bg-red-500/20 dark:text-red-300 border-red-200 dark:border-red-500/40'
                          : 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400 border-slate-200 dark:border-slate-700'
                      }`}
                    >
                      <AlertOctagon className="h-3 w-3" aria-hidden="true" />
                      {interpolateCount(t.common.errorsCount, severityCounts.error, locale)}
                    </span>
                    <span
                      role="status"
                      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-bold border ${
                        severityCounts.warning > 0
                          ? 'bg-amber-50 text-amber-700 dark:bg-amber-500/20 dark:text-amber-300 border-amber-200 dark:border-amber-500/40'
                          : 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400 border-slate-200 dark:border-slate-700'
                      }`}
                    >
                      <AlertTriangle className="h-3 w-3" aria-hidden="true" />
                      {interpolateCount(t.common.warningsCount, severityCounts.warning, locale)}
                    </span>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => onNavigate('operations')}
                  className="flex items-center gap-1.5 text-xs font-bold text-cyan-700 dark:text-cyan-400 hover:text-cyan-900 dark:hover:text-cyan-300 transition-colors"
                >
                  {t.overview.viewAllInOperations} <ArrowRight className="h-3.5 w-3.5" />
                </button>
              </div>

              {recentEvents.length === 0 ? (
                <p className="p-6 text-center text-xs text-slate-500 dark:text-slate-400">{t.overview.emptyEvents}</p>
              ) : (
                <ul className="divide-y divide-slate-200 dark:divide-slate-800/80">
                  {recentEvents.map((event) => (
                    <li key={event.id}>
                      <button
                        type="button"
                        onClick={() => {
                          if (onNavigateToEventTarget) {
                            onNavigateToEventTarget(createEventFocusTarget(event.id));
                          } else {
                            onNavigate('operations');
                          }
                        }}
                        className="w-full text-left py-2.5 px-3 rounded-lg hover:bg-slate-50 dark:hover:bg-slate-800/60 transition-colors flex items-center justify-between gap-3 group"
                      >
                        <div className="flex items-center gap-3 min-w-0">
                          <SeverityBadge severity={event.severity} t={t} />
                          <div className="min-w-0">
                            <p className="text-xs font-semibold text-slate-900 dark:text-white truncate group-hover:text-cyan-700 dark:group-hover:text-cyan-300 transition-colors">
                              {event.message}
                            </p>
                            <p className="text-[11px] font-mono text-slate-500 dark:text-slate-400 mt-0.5">
                              {formatDateTime(event.timestamp, locale)}
                            </p>
                          </div>
                        </div>
                        <ChevronRight className="h-4 w-4 text-slate-400 group-hover:text-cyan-600 dark:group-hover:text-cyan-400 transition-colors flex-shrink-0" />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {/* Quick Launch & System Info */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            {/* Quick Launch */}
            <div className="lg:col-span-2 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-6 shadow-xs backdrop-blur-sm">
              <div className="flex items-start justify-between gap-4 mb-1">
                <h2 className="text-lg font-bold text-slate-900 dark:text-white">{t.overview.quickLaunch}</h2>
                <button
                  onClick={() => onNavigate('services')}
                  className="flex items-center gap-1.5 text-xs font-bold text-cyan-700 dark:text-cyan-400 hover:text-cyan-900 dark:hover:text-cyan-300 transition-colors flex-shrink-0"
                >
                  {t.overview.viewServices} <ArrowRight className="h-3.5 w-3.5" />
                </button>
              </div>
              <p className="text-xs text-slate-500 dark:text-slate-300 mb-4">{t.overview.quickLaunchSubtitle}</p>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {quickLinks.map((svc) => {
                  const safeEndpoint = getSafeExternalUrl(svc.endpoint);
                  const content = (
                    <>
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="font-bold text-sm text-slate-900 dark:text-white group-hover:text-cyan-700 dark:group-hover:text-cyan-300 transition-colors">
                            {svc.name}
                          </span>
                          <span className="text-[10px] rounded bg-slate-200 dark:bg-slate-800 px-1.5 py-0.5 font-mono text-slate-800 dark:text-slate-300 font-bold border border-slate-300 dark:border-slate-700">
                            v{svc.version ?? '—'}
                          </span>
                        </div>
                        <div className="text-xs text-slate-600 dark:text-slate-400 truncate mt-1 max-w-[220px] font-mono">{svc.endpoint}</div>
                      </div>
                      {safeEndpoint && (
                        <ExternalLink className="h-4 w-4 text-slate-400 group-hover:text-cyan-600 dark:group-hover:text-cyan-400 transition-colors flex-shrink-0" />
                      )}
                    </>
                  );
                  const className =
                    'group flex items-center justify-between rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 p-3.5 hover:border-cyan-500 dark:hover:border-cyan-400 hover:bg-cyan-50/40 dark:hover:bg-slate-800/80 transition-all shadow-xs';
                  return safeEndpoint ? (
                    <a key={svc.id} href={safeEndpoint} target="_blank" rel="noreferrer" className={className}>
                      {content}
                    </a>
                  ) : (
                    <div key={svc.id} className={className}>
                      {content}
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Security & Seam Info */}
            <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-6 shadow-xs backdrop-blur-sm flex flex-col justify-between">
              <div>
                <div className="flex items-center gap-2 text-cyan-700 dark:text-cyan-400 mb-2">
                  <ShieldCheck className="h-5 w-5" />
                  <h2 className="text-base font-bold text-slate-900 dark:text-white">{t.overview.securityTitle}</h2>
                </div>
                <p className="text-xs text-slate-600 dark:text-slate-300 leading-relaxed font-medium">
                  {t.overview.securitySubtitle}
                </p>

                <div className="mt-4 space-y-2.5">
                  <div className="rounded-lg bg-slate-50 dark:bg-slate-950 p-3 border border-slate-200 dark:border-slate-800 text-xs">
                    <div className="font-bold text-slate-800 dark:text-slate-200">{t.overview.identityProvider}</div>
                    <div className="text-slate-600 dark:text-slate-400 mt-0.5 font-mono text-[11px] font-medium">Keycloak SSO 26.7.1 + OpenLDAP</div>
                  </div>
                  <div className="rounded-lg bg-slate-50 dark:bg-slate-950 p-3 border border-slate-200 dark:border-slate-800 text-xs">
                    <div className="font-bold text-slate-800 dark:text-slate-200">{t.overview.authzEngine}</div>
                    <div className="text-slate-600 dark:text-slate-400 mt-0.5 font-mono text-[11px] font-medium">Trino OPA 1.19.0 Rego + Postgres DDL</div>
                  </div>
                  <div className="rounded-lg bg-slate-50 dark:bg-slate-950 p-3 border border-slate-200 dark:border-slate-800 text-xs">
                    <div className="font-bold text-slate-800 dark:text-slate-200">{t.overview.gatewayBoundary}</div>
                    <div className="text-slate-600 dark:text-slate-400 mt-0.5 font-mono text-[11px] font-medium">APISIX 3.17.0 (192.168.77.200:80)</div>
                  </div>
                </div>
              </div>

              <div className="mt-4 pt-4 border-t border-slate-200 dark:border-slate-800">
                <button
                  onClick={() => onNavigate('policy')}
                  className="w-full py-2 px-3 rounded-lg bg-cyan-50 hover:bg-cyan-100 dark:bg-cyan-950/60 dark:hover:bg-cyan-900/60 text-cyan-800 dark:text-cyan-300 border border-cyan-200 dark:border-cyan-700/60 text-xs font-bold transition-colors shadow-xs"
                >
                  {t.overview.managePolicies}
                </button>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
};
