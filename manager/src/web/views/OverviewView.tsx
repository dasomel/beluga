import React from 'react';
import { 
  Activity, 
  Server, 
  Database, 
  GitFork, 
  ExternalLink, 
  CheckCircle2, 
  ArrowRight,
  ShieldCheck
} from 'lucide-react';
import { Translations } from '../i18n/translations';
import { servicesData, pipelineSteps } from '../data/mockData';

interface OverviewViewProps {
  t: Translations;
  onNavigate: (tab: string) => void;
}

export const OverviewView: React.FC<OverviewViewProps> = ({ t, onNavigate }) => {
  const quickLinks = servicesData.filter(s => s.externalUrl);

  return (
    <div className="space-y-8">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-white">{t.overview.title}</h1>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">{t.overview.subtitle}</p>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="rounded-xl border border-slate-200/90 dark:border-slate-800 bg-white dark:bg-slate-900/60 p-5 shadow-xs dark:shadow-none backdrop-blur-sm">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">{t.overview.totalServices}</span>
            <div className="rounded-lg bg-cyan-50 dark:bg-cyan-500/10 p-2 text-cyan-700 dark:text-cyan-400 border border-cyan-100 dark:border-transparent">
              <Server className="h-5 w-5" />
            </div>
          </div>
          <div className="mt-4 flex items-baseline gap-2">
            <span className="text-3xl font-bold text-slate-900 dark:text-white">{servicesData.length}</span>
            <span className="text-xs text-emerald-600 dark:text-emerald-400 flex items-center gap-1 font-semibold">
              <CheckCircle2 className="h-3.5 w-3.5" /> 100% 정상
            </span>
          </div>
        </div>

        <div className="rounded-xl border border-slate-200/90 dark:border-slate-800 bg-white dark:bg-slate-900/60 p-5 shadow-xs dark:shadow-none backdrop-blur-sm">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">{t.overview.activePipelines}</span>
            <div className="rounded-lg bg-blue-50 dark:bg-blue-500/10 p-2 text-blue-700 dark:text-blue-400 border border-blue-100 dark:border-transparent">
              <GitFork className="h-5 w-5" />
            </div>
          </div>
          <div className="mt-4 flex items-baseline gap-2">
            <span className="text-3xl font-bold text-slate-900 dark:text-white">2</span>
            <span className="text-xs text-slate-500 dark:text-slate-400 font-medium">CDC Mirroring & Session</span>
          </div>
        </div>

        <div className="rounded-xl border border-slate-200/90 dark:border-slate-800 bg-white dark:bg-slate-900/60 p-5 shadow-xs dark:shadow-none backdrop-blur-sm">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">{t.overview.catalogTables}</span>
            <div className="rounded-lg bg-indigo-50 dark:bg-indigo-500/10 p-2 text-indigo-700 dark:text-indigo-400 border border-indigo-100 dark:border-transparent">
              <Database className="h-5 w-5" />
            </div>
          </div>
          <div className="mt-4 flex items-baseline gap-2">
            <span className="text-3xl font-bold text-slate-900 dark:text-white">3</span>
            <span className="text-xs text-slate-500 dark:text-slate-400 font-medium">Iceberg Parquet v2</span>
          </div>
        </div>

        <div className="rounded-xl border border-slate-200/90 dark:border-slate-800 bg-white dark:bg-slate-900/60 p-5 shadow-xs dark:shadow-none backdrop-blur-sm">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">{t.overview.clusterHealth}</span>
            <div className="rounded-lg bg-emerald-50 dark:bg-emerald-500/10 p-2 text-emerald-700 dark:text-emerald-400 border border-emerald-100 dark:border-transparent">
              <Activity className="h-5 w-5" />
            </div>
          </div>
          <div className="mt-4 flex items-baseline gap-2">
            <span className="text-3xl font-bold text-emerald-600 dark:text-emerald-400">HEALTHY</span>
            <span className="text-xs text-slate-500 dark:text-slate-400 font-medium">k3s 4-Nodes</span>
          </div>
        </div>
      </div>

      {/* Pipeline Snapshot */}
      <div className="rounded-xl border border-slate-200/90 dark:border-slate-800 bg-white dark:bg-slate-900/60 p-6 shadow-xs dark:shadow-none backdrop-blur-sm">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="text-lg font-semibold text-slate-900 dark:text-white">{t.overview.pipelineFlow}</h2>
            <p className="text-xs text-slate-500 dark:text-slate-400">PostgreSQL (shop) &rarr; Debezium &rarr; Kafka &rarr; Flink &rarr; Lakekeeper &rarr; Trino</p>
          </div>
          <button 
            onClick={() => onNavigate('pipelines')}
            className="flex items-center gap-1.5 text-xs font-semibold text-cyan-700 dark:text-cyan-400 hover:text-cyan-800 dark:hover:text-cyan-300 transition-colors"
          >
            상세 토폴로지 보기 <ArrowRight className="h-3.5 w-3.5" />
          </button>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 lg:grid-cols-6 gap-3">
          {pipelineSteps.map((step, idx) => (
            <div key={step.id} className="relative rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-950/60 p-3.5 flex flex-col justify-between">
              <div>
                <div className="flex items-center justify-between text-[11px] font-semibold uppercase tracking-wider text-slate-400 dark:text-slate-500 mb-1">
                  <span>STEP 0{idx + 1}</span>
                  <span className="inline-flex items-center rounded-full bg-emerald-100 dark:bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-medium text-emerald-800 dark:text-emerald-400 border border-emerald-200 dark:border-transparent">
                    {step.status}
                  </span>
                </div>
                <div className="font-semibold text-xs text-slate-900 dark:text-slate-200 truncate">{step.name}</div>
                <div className="text-[11px] text-cyan-700 dark:text-cyan-400 font-mono mt-0.5 font-medium">{step.component}</div>
              </div>
              <div className="mt-3 pt-2 border-t border-slate-200 dark:border-slate-800/80 text-[11px] text-slate-500 dark:text-slate-400 flex justify-between">
                <span>처리율:</span>
                <span className="font-mono font-semibold text-slate-800 dark:text-slate-200">{step.metrics.throughput}</span>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Quick Launch & System Info */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Quick Launch */}
        <div className="lg:col-span-2 rounded-xl border border-slate-200/90 dark:border-slate-800 bg-white dark:bg-slate-900/60 p-6 shadow-xs dark:shadow-none backdrop-blur-sm">
          <h2 className="text-lg font-semibold text-slate-900 dark:text-white mb-1">{t.overview.quickLaunch}</h2>
          <p className="text-xs text-slate-500 dark:text-slate-400 mb-4">APISIX Unified Gateway (Port 80)를 통해 즉시 접근 가능한 OSS 관리 콘솔</p>
          
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {quickLinks.map((svc) => (
              <a
                key={svc.id}
                href={svc.externalUrl}
                target="_blank"
                rel="noreferrer"
                className="group flex items-center justify-between rounded-lg border border-slate-200 dark:border-slate-800/80 bg-slate-50/50 dark:bg-slate-950/40 p-3.5 hover:border-cyan-500/50 hover:bg-cyan-50/30 dark:hover:bg-slate-800/40 transition-all shadow-xs"
              >
                <div>
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-sm text-slate-800 dark:text-slate-200 group-hover:text-cyan-700 dark:group-hover:text-cyan-300 transition-colors">{svc.name}</span>
                    <span className="text-[10px] rounded bg-slate-200 dark:bg-slate-800 px-1.5 py-0.5 font-mono text-slate-700 dark:text-slate-400 font-medium">v{svc.version}</span>
                  </div>
                  <div className="text-xs text-slate-500 dark:text-slate-400 truncate mt-1 max-w-[220px] font-mono">{svc.endpoint}</div>
                </div>
                <ExternalLink className="h-4 w-4 text-slate-400 group-hover:text-cyan-600 dark:group-hover:text-cyan-400 transition-colors flex-shrink-0" />
              </a>
            ))}
          </div>
        </div>

        {/* Security & Seam Info */}
        <div className="rounded-xl border border-slate-200/90 dark:border-slate-800 bg-white dark:bg-slate-900/60 p-6 shadow-xs dark:shadow-none backdrop-blur-sm flex flex-col justify-between">
          <div>
            <div className="flex items-center gap-2 text-cyan-700 dark:text-cyan-400 mb-2">
              <ShieldCheck className="h-5 w-5" />
              <h2 className="text-base font-semibold text-slate-900 dark:text-white">플랫폼 보안 & Seam 정합성</h2>
            </div>
            <p className="text-xs text-slate-600 dark:text-slate-400 leading-relaxed">
              Beluga Modern Data Platform의 단일 Identity 원천(Keycloak + OpenLDAP)과 중앙 인가 컴파일러(policyctl)가 동기화 상태를 유지하고 있습니다.
            </p>

            <div className="mt-4 space-y-2.5">
              <div className="rounded-lg bg-slate-50 dark:bg-slate-950/60 p-3 border border-slate-200 dark:border-slate-800/80 text-xs">
                <div className="font-semibold text-slate-800 dark:text-slate-300">Identity & Role Provider</div>
                <div className="text-slate-500 dark:text-slate-400 mt-0.5 font-mono text-[11px]">Keycloak SSO 26.7.1 + OpenLDAP</div>
              </div>
              <div className="rounded-lg bg-slate-50 dark:bg-slate-950/60 p-3 border border-slate-200 dark:border-slate-800/80 text-xs">
                <div className="font-semibold text-slate-800 dark:text-slate-300">Central Authz Engine</div>
                <div className="text-slate-500 dark:text-slate-400 mt-0.5 font-mono text-[11px]">Trino OPA 1.19.0 Rego + Postgres DDL</div>
              </div>
              <div className="rounded-lg bg-slate-50 dark:bg-slate-950/60 p-3 border border-slate-200 dark:border-slate-800/80 text-xs">
                <div className="font-semibold text-slate-800 dark:text-slate-300">Gateway Boundary</div>
                <div className="text-slate-500 dark:text-slate-400 mt-0.5 font-mono text-[11px]">APISIX 3.17.0 (192.168.77.200:80)</div>
              </div>
            </div>
          </div>

          <div className="mt-4 pt-4 border-t border-slate-200 dark:border-slate-800">
            <button
              onClick={() => onNavigate('policy')}
              className="w-full py-2 px-3 rounded-lg bg-cyan-50 hover:bg-cyan-100 dark:bg-cyan-600/20 dark:hover:bg-cyan-600/30 text-cyan-800 dark:text-cyan-300 border border-cyan-200 dark:border-cyan-500/30 text-xs font-semibold transition-colors"
            >
              보안 및 인가 정책 관리
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
