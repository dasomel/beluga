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
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-300 font-medium">{t.overview.subtitle}</p>
      </div>

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
            <span className="text-3xl font-bold text-slate-900 dark:text-white">{servicesData.length}</span>
            <span className="text-xs text-emerald-700 dark:text-emerald-400 flex items-center gap-1 font-bold">
              <CheckCircle2 className="h-3.5 w-3.5" /> 100% 정상
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
            <span className="text-3xl font-bold text-slate-900 dark:text-white">2</span>
            <span className="text-xs text-slate-500 dark:text-slate-300 font-semibold">CDC Mirroring & Session</span>
          </div>
        </div>

        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 shadow-xs backdrop-blur-sm">
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">{t.overview.catalogTables}</span>
            <div className="rounded-lg bg-indigo-50 dark:bg-indigo-950/80 p-2 text-indigo-700 dark:text-indigo-300 border border-indigo-100 dark:border-indigo-800/50">
              <Database className="h-5 w-5" />
            </div>
          </div>
          <div className="mt-4 flex items-baseline gap-2">
            <span className="text-3xl font-bold text-slate-900 dark:text-white">3</span>
            <span className="text-xs text-slate-500 dark:text-slate-300 font-semibold">Iceberg Parquet v2</span>
          </div>
        </div>

        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 shadow-xs backdrop-blur-sm">
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">{t.overview.clusterHealth}</span>
            <div className="rounded-lg bg-emerald-50 dark:bg-emerald-950/80 p-2 text-emerald-700 dark:text-emerald-300 border border-emerald-100 dark:border-emerald-800/50">
              <Activity className="h-5 w-5" />
            </div>
          </div>
          <div className="mt-4 flex items-baseline gap-2">
            <span className="text-3xl font-bold text-emerald-600 dark:text-emerald-400">HEALTHY</span>
            <span className="text-xs text-slate-500 dark:text-slate-300 font-semibold">k3s 4-Nodes</span>
          </div>
        </div>
      </div>

      {/* Pipeline Snapshot */}
      <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-6 shadow-xs backdrop-blur-sm">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="text-lg font-bold text-slate-900 dark:text-white">{t.overview.pipelineFlow}</h2>
            <p className="text-xs text-slate-500 dark:text-slate-300">PostgreSQL (shop) &rarr; Debezium &rarr; Kafka &rarr; Flink &rarr; Lakekeeper &rarr; Trino</p>
          </div>
          <button 
            onClick={() => onNavigate('pipelines')}
            className="flex items-center gap-1.5 text-xs font-bold text-cyan-700 dark:text-cyan-400 hover:text-cyan-900 dark:hover:text-cyan-300 transition-colors"
          >
            상세 토폴로지 보기 <ArrowRight className="h-3.5 w-3.5" />
          </button>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 lg:grid-cols-6 gap-3">
          {pipelineSteps.map((step, idx) => (
            <div key={step.id} className="relative rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 p-3.5 flex flex-col justify-between">
              <div>
                <div className="flex items-center justify-between text-[11px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-1">
                  <span>STEP 0{idx + 1}</span>
                  <span className="inline-flex items-center rounded-full bg-emerald-100 dark:bg-emerald-500/20 px-1.5 py-0.5 text-[10px] font-bold text-emerald-800 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-500/40">
                    {step.status}
                  </span>
                </div>
                <div className="font-bold text-xs text-slate-900 dark:text-white truncate">{step.name}</div>
                <div className="text-[11px] text-cyan-700 dark:text-cyan-400 font-mono mt-0.5 font-bold">{step.component}</div>
              </div>
              <div className="mt-3 pt-2 border-t border-slate-200 dark:border-slate-800 text-[11px] text-slate-500 dark:text-slate-400 flex justify-between font-medium">
                <span>처리율:</span>
                <span className="font-mono font-bold text-slate-900 dark:text-white">{step.metrics.throughput}</span>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Quick Launch & System Info */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Quick Launch */}
        <div className="lg:col-span-2 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-6 shadow-xs backdrop-blur-sm">
          <h2 className="text-lg font-bold text-slate-900 dark:text-white mb-1">{t.overview.quickLaunch}</h2>
          <p className="text-xs text-slate-500 dark:text-slate-300 mb-4">APISIX Unified Gateway (Port 80)를 통해 즉시 접근 가능한 OSS 관리 콘솔</p>
          
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {quickLinks.map((svc) => (
              <a
                key={svc.id}
                href={svc.externalUrl}
                target="_blank"
                rel="noreferrer"
                className="group flex items-center justify-between rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 p-3.5 hover:border-cyan-500 dark:hover:border-cyan-400 hover:bg-cyan-50/40 dark:hover:bg-slate-800/80 transition-all shadow-xs"
              >
                <div>
                  <div className="flex items-center gap-2">
                    <span className="font-bold text-sm text-slate-900 dark:text-white group-hover:text-cyan-700 dark:group-hover:text-cyan-300 transition-colors">{svc.name}</span>
                    <span className="text-[10px] rounded bg-slate-200 dark:bg-slate-800 px-1.5 py-0.5 font-mono text-slate-800 dark:text-slate-300 font-bold border border-slate-300 dark:border-slate-700">v{svc.version}</span>
                  </div>
                  <div className="text-xs text-slate-600 dark:text-slate-400 truncate mt-1 max-w-[220px] font-mono">{svc.endpoint}</div>
                </div>
                <ExternalLink className="h-4 w-4 text-slate-400 group-hover:text-cyan-600 dark:group-hover:text-cyan-400 transition-colors flex-shrink-0" />
              </a>
            ))}
          </div>
        </div>

        {/* Security & Seam Info */}
        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-6 shadow-xs backdrop-blur-sm flex flex-col justify-between">
          <div>
            <div className="flex items-center gap-2 text-cyan-700 dark:text-cyan-400 mb-2">
              <ShieldCheck className="h-5 w-5" />
              <h2 className="text-base font-bold text-slate-900 dark:text-white">플랫폼 보안 & Seam 정합성</h2>
            </div>
            <p className="text-xs text-slate-600 dark:text-slate-300 leading-relaxed font-medium">
              Beluga Modern Data Platform의 단일 Identity 원천(Keycloak + OpenLDAP)과 중앙 인가 컴파일러(policyctl)가 동기화 상태를 유지하고 있습니다.
            </p>

            <div className="mt-4 space-y-2.5">
              <div className="rounded-lg bg-slate-50 dark:bg-slate-950 p-3 border border-slate-200 dark:border-slate-800 text-xs">
                <div className="font-bold text-slate-800 dark:text-slate-200">Identity & Role Provider</div>
                <div className="text-slate-600 dark:text-slate-400 mt-0.5 font-mono text-[11px] font-medium">Keycloak SSO 26.7.1 + OpenLDAP</div>
              </div>
              <div className="rounded-lg bg-slate-50 dark:bg-slate-950 p-3 border border-slate-200 dark:border-slate-800 text-xs">
                <div className="font-bold text-slate-800 dark:text-slate-200">Central Authz Engine</div>
                <div className="text-slate-600 dark:text-slate-400 mt-0.5 font-mono text-[11px] font-medium">Trino OPA 1.19.0 Rego + Postgres DDL</div>
              </div>
              <div className="rounded-lg bg-slate-50 dark:bg-slate-950 p-3 border border-slate-200 dark:border-slate-800 text-xs">
                <div className="font-bold text-slate-800 dark:text-slate-200">Gateway Boundary</div>
                <div className="text-slate-600 dark:text-slate-400 mt-0.5 font-mono text-[11px] font-medium">APISIX 3.17.0 (192.168.77.200:80)</div>
              </div>
            </div>
          </div>

          <div className="mt-4 pt-4 border-t border-slate-200 dark:border-slate-800">
            <button
              onClick={() => onNavigate('policy')}
              className="w-full py-2 px-3 rounded-lg bg-cyan-50 hover:bg-cyan-100 dark:bg-cyan-950/60 dark:hover:bg-cyan-900/60 text-cyan-800 dark:text-cyan-300 border border-cyan-200 dark:border-cyan-700/60 text-xs font-bold transition-colors shadow-xs"
            >
              보안 및 인가 정책 관리
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
