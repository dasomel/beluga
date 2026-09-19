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
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-300 font-medium">{t.pipelines.subtitle}</p>
      </div>

      {/* Main Pipeline Topology Canvas */}
      <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-6 shadow-xs backdrop-blur-sm">
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-2">
            <Layers className="h-5 w-5 text-cyan-700 dark:text-cyan-400" />
            <h2 className="text-lg font-bold text-slate-900 dark:text-white">{t.pipelines.topologyTitle}</h2>
          </div>
          <span className="rounded-full bg-emerald-50 dark:bg-emerald-950/80 px-2.5 py-1 text-xs font-bold text-emerald-700 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-800/80 flex items-center gap-1.5 shadow-xs">
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
                      ? 'border-cyan-500 bg-cyan-50/90 dark:border-cyan-400 dark:bg-cyan-950 dark:ring-2 dark:ring-cyan-400/50 shadow-md'
                      : 'border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 hover:border-slate-300 dark:hover:border-slate-600 hover:bg-slate-100/80 dark:hover:bg-slate-850'
                  }`}
                >
                  <div className="flex items-center justify-between mb-2">
                    <span className="rounded bg-slate-200 dark:bg-slate-800 px-1.5 py-0.5 text-[10px] font-mono text-slate-700 dark:text-slate-300 font-bold border border-slate-300 dark:border-slate-700">
                      STAGE 0{idx + 1}
                    </span>
                    <span className="inline-flex items-center rounded-full bg-emerald-100 dark:bg-emerald-500/20 px-1.5 py-0.5 text-[10px] font-bold text-emerald-800 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-500/40">
                      {step.status}
                    </span>
                  </div>

                  <div className="text-xs font-bold text-slate-900 dark:text-white group-hover:text-cyan-800 dark:group-hover:text-cyan-300 transition-colors line-clamp-1">
                    {step.name}
                  </div>
                  <div className="text-[11px] font-mono text-cyan-700 dark:text-cyan-400 mt-0.5 font-bold">
                    {step.component}
                  </div>

                  <div className="mt-4 pt-3 border-t border-slate-200 dark:border-slate-800 text-[11px] space-y-1">
                    <div className="flex justify-between text-slate-500 dark:text-slate-400 font-medium">
                      <span>Throughput:</span>
                      <span className="font-mono font-bold text-slate-900 dark:text-white">{step.metrics.throughput}</span>
                    </div>
                    <div className="flex justify-between text-slate-500 dark:text-slate-400 font-medium">
                      <span>Latency:</span>
                      <span className="font-mono font-bold text-slate-900 dark:text-white">{step.metrics.latency}</span>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* Selected Step Drill-Down Detail */}
      <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-6 shadow-xs backdrop-blur-sm">
        <div className="flex items-center justify-between mb-4 pb-4 border-b border-slate-200 dark:border-slate-800">
          <div>
            <span className="text-xs font-mono uppercase tracking-wider text-cyan-700 dark:text-cyan-400 font-bold">Selected Component Detail</span>
            <h3 className="text-xl font-bold text-slate-900 dark:text-white mt-0.5">{selectedStep.name}</h3>
            <p className="text-xs text-slate-600 dark:text-slate-300 mt-1 font-mono font-medium">{selectedStep.details}</p>
          </div>
          <div className="flex items-center gap-3">
            <div className="rounded-lg bg-slate-50 dark:bg-slate-950 px-3.5 py-2.5 border border-slate-200 dark:border-slate-800 text-right shadow-xs">
              <div className="text-[10px] text-slate-400 uppercase font-mono font-bold">Records Processed</div>
              <div className="text-base font-bold text-slate-900 dark:text-white font-mono">{selectedStep.metrics.recordsProcessed}</div>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="rounded-lg bg-slate-50 dark:bg-slate-950 p-4 border border-slate-200 dark:border-slate-800">
            <div className="flex items-center gap-2 text-slate-700 dark:text-slate-300 text-xs font-bold mb-1">
              <Activity className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
              컴포넌트 역할 및 기능
            </div>
            <div className="text-sm font-bold text-slate-900 dark:text-white">{selectedStep.component}</div>
            <p className="text-xs text-slate-500 dark:text-slate-300 mt-1 font-medium">
              플랫폼 아키텍처의 {selectedStep.type} 계층을 담당하며 무중단 실시간 이벤트 처리를 보장합니다.
            </p>
          </div>

          <div className="rounded-lg bg-slate-50 dark:bg-slate-950 p-4 border border-slate-200 dark:border-slate-800">
            <div className="flex items-center gap-2 text-slate-700 dark:text-slate-300 text-xs font-bold mb-1">
              <Zap className="h-4 w-4 text-cyan-700 dark:text-cyan-400" />
              실시간 I/O 메트릭
            </div>
            <div className="text-sm font-bold text-slate-900 dark:text-white">처리 속도: {selectedStep.metrics.throughput}</div>
            <p className="text-xs text-slate-500 dark:text-slate-300 mt-1 font-medium">
              측정된 단대단 레이턴시: <span className="font-mono text-cyan-800 dark:text-cyan-300 font-bold">{selectedStep.metrics.latency}</span>
            </p>
          </div>

          <div className="rounded-lg bg-slate-50 dark:bg-slate-950 p-4 border border-slate-200 dark:border-slate-800">
            <div className="flex items-center gap-2 text-slate-700 dark:text-slate-300 text-xs font-bold mb-1">
              <CheckCircle2 className="h-4 w-4 text-blue-600 dark:text-blue-400" />
              ArgoCD GitOps 상태
            </div>
            <div className="text-sm font-bold text-slate-900 dark:text-white">Synced & Healthy</div>
            <p className="text-xs text-slate-500 dark:text-slate-300 mt-1 font-mono text-[11px] font-medium">
              beluga-data app-of-apps 관리하에 동작 중
            </p>
          </div>
        </div>
      </div>
    </div>
  );
};
