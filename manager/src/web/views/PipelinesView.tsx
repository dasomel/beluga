import React, { useState } from 'react';
import { 
  Layers, 
  Activity, 
  Zap, 
  CheckCircle2, 
} from 'lucide-react';
import { Translations } from '../i18n/translations';
import { pipelineSteps, PipelineStep } from '../data/mockData';

interface PipelinesViewProps {
  t: Translations;
}

export const PipelinesView: React.FC<PipelinesViewProps> = ({ t }) => {
  const [selectedStep, setSelectedStep] = useState<PipelineStep>(pipelineSteps[0]!);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-white">{t.pipelines.title}</h1>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">{t.pipelines.subtitle}</p>
      </div>

      {/* Main Pipeline Topology Canvas */}
      <div className="rounded-xl border border-slate-200/90 dark:border-slate-800 bg-white dark:bg-slate-900/60 p-6 shadow-xs dark:shadow-xl backdrop-blur-sm">
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-2">
            <Layers className="h-5 w-5 text-cyan-700 dark:text-cyan-400" />
            <h2 className="text-lg font-semibold text-slate-900 dark:text-white">{t.pipelines.topologyTitle}</h2>
          </div>
          <span className="rounded-full bg-emerald-50 dark:bg-emerald-500/10 px-2.5 py-1 text-xs font-semibold text-emerald-700 dark:text-emerald-400 border border-emerald-200 dark:border-emerald-500/20 flex items-center gap-1.5 shadow-xs">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 dark:bg-emerald-400 animate-pulse"></span>
            End-to-End Live Syncing
          </span>
        </div>

        {/* Visual Graph Nodes */}
        <div className="relative">
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-6 gap-4">
            {pipelineSteps.map((step, idx) => {
              const isSelected = selectedStep.id === step.id;
              return (
                <div
                  key={step.id}
                  onClick={() => setSelectedStep(step)}
                  className={`group relative cursor-pointer rounded-xl border p-4 transition-all ${
                    isSelected
                      ? 'border-cyan-500 bg-cyan-50/70 dark:bg-cyan-950/30 shadow-md ring-1 ring-cyan-500/30 dark:shadow-cyan-500/10'
                      : 'border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-950/70 hover:border-slate-300 dark:hover:border-slate-700 hover:bg-slate-100/80 dark:hover:bg-slate-900/60'
                  }`}
                >
                  <div className="flex items-center justify-between mb-2">
                    <span className="rounded bg-slate-200/80 dark:bg-slate-800 px-1.5 py-0.5 text-[10px] font-mono text-slate-600 dark:text-slate-400 font-semibold">
                      STAGE 0{idx + 1}
                    </span>
                    <span className="inline-flex items-center rounded-full bg-emerald-100 dark:bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-800 dark:text-emerald-400 border border-emerald-200 dark:border-transparent">
                      {step.status}
                    </span>
                  </div>

                  <div className="text-xs font-bold text-slate-900 dark:text-white group-hover:text-cyan-800 dark:group-hover:text-cyan-300 transition-colors line-clamp-1">
                    {step.name}
                  </div>
                  <div className="text-[11px] font-mono text-cyan-700 dark:text-cyan-400 mt-0.5 font-medium">
                    {step.component}
                  </div>

                  <div className="mt-4 pt-3 border-t border-slate-200 dark:border-slate-800 text-[11px] space-y-1">
                    <div className="flex justify-between text-slate-500 dark:text-slate-400">
                      <span>Throughput:</span>
                      <span className="font-mono font-semibold text-slate-800 dark:text-slate-200">{step.metrics.throughput}</span>
                    </div>
                    <div className="flex justify-between text-slate-500 dark:text-slate-400">
                      <span>Latency:</span>
                      <span className="font-mono font-semibold text-slate-800 dark:text-slate-200">{step.metrics.latency}</span>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* Selected Step Drill-Down Detail */}
      <div className="rounded-xl border border-slate-200/90 dark:border-slate-800 bg-white dark:bg-slate-900/60 p-6 shadow-xs dark:shadow-none backdrop-blur-sm">
        <div className="flex items-center justify-between mb-4 pb-4 border-b border-slate-200 dark:border-slate-800">
          <div>
            <span className="text-xs font-mono uppercase tracking-wider text-cyan-700 dark:text-cyan-400 font-bold">Selected Component Detail</span>
            <h3 className="text-xl font-bold text-slate-900 dark:text-white mt-0.5">{selectedStep.name}</h3>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-1 font-mono">{selectedStep.details}</p>
          </div>
          <div className="flex items-center gap-3">
            <div className="rounded-lg bg-slate-50 dark:bg-slate-950 px-3 py-2 border border-slate-200 dark:border-slate-800 text-right shadow-xs">
              <div className="text-[10px] text-slate-400 uppercase font-mono font-semibold">Records Processed</div>
              <div className="text-base font-bold text-slate-900 dark:text-white font-mono">{selectedStep.metrics.recordsProcessed}</div>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="rounded-lg bg-slate-50/80 dark:bg-slate-950/70 p-4 border border-slate-200 dark:border-slate-800/80">
            <div className="flex items-center gap-2 text-slate-600 dark:text-slate-400 text-xs font-semibold mb-1">
              <Activity className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
              컴포넌트 역할 및 기능
            </div>
            <div className="text-sm font-bold text-slate-900 dark:text-slate-200">{selectedStep.component}</div>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
              플랫폼 아키텍처의 {selectedStep.type} 계층을 담당하며 무중단 실시간 이벤트 처리를 보장합니다.
            </p>
          </div>

          <div className="rounded-lg bg-slate-50/80 dark:bg-slate-950/70 p-4 border border-slate-200 dark:border-slate-800/80">
            <div className="flex items-center gap-2 text-slate-600 dark:text-slate-400 text-xs font-semibold mb-1">
              <Zap className="h-4 w-4 text-cyan-700 dark:text-cyan-400" />
              실시간 I/O 메트릭
            </div>
            <div className="text-sm font-bold text-slate-900 dark:text-slate-200">처리 속도: {selectedStep.metrics.throughput}</div>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
              측정된 단대단 레이턴시: <span className="font-mono text-cyan-800 dark:text-cyan-300 font-semibold">{selectedStep.metrics.latency}</span>
            </p>
          </div>

          <div className="rounded-lg bg-slate-50/80 dark:bg-slate-950/70 p-4 border border-slate-200 dark:border-slate-800/80">
            <div className="flex items-center gap-2 text-slate-600 dark:text-slate-400 text-xs font-semibold mb-1">
              <CheckCircle2 className="h-4 w-4 text-blue-600 dark:text-blue-400" />
              ArgoCD GitOps 상태
            </div>
            <div className="text-sm font-bold text-slate-900 dark:text-slate-200">Synced & Healthy</div>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-1 font-mono text-[11px]">
              beluga-data app-of-apps 관리하에 동작 중
            </p>
          </div>
        </div>
      </div>
    </div>
  );
};
