import React from 'react';
import { AlertTriangle, CheckCircle2, Clock, HelpCircle, XCircle, type LucideIcon } from 'lucide-react';
import type { HealthStatus } from '@beluga-manager/domain-api/schema';
import { Translations } from '../i18n/translations';

interface StatusBadgeProps {
  status: HealthStatus;
  t: Translations;
}

const STATUS_ICON: Record<HealthStatus, LucideIcon> = {
  healthy: CheckCircle2,
  degraded: AlertTriangle,
  stale: Clock,
  unknown: HelpCircle,
  unavailable: XCircle,
};

// ADR-0003: 색상만으로 상태를 구분하지 않는다 -- 아이콘과 라벨을 항상 함께 그린다.
const STATUS_CLASSNAME: Record<HealthStatus, string> = {
  healthy:
    'bg-emerald-50 dark:bg-emerald-500/20 text-emerald-800 dark:text-emerald-300 border-emerald-200 dark:border-emerald-500/40',
  degraded:
    'bg-amber-50 dark:bg-amber-500/20 text-amber-800 dark:text-amber-300 border-amber-200 dark:border-amber-500/40',
  stale:
    'bg-orange-50 dark:bg-orange-500/20 text-orange-800 dark:text-orange-300 border-orange-200 dark:border-orange-500/40',
  unknown:
    'bg-slate-100 dark:bg-slate-500/20 text-slate-700 dark:text-slate-300 border-slate-200 dark:border-slate-500/40',
  unavailable: 'bg-red-50 dark:bg-red-500/20 text-red-800 dark:text-red-300 border-red-200 dark:border-red-500/40',
};

export const StatusBadge: React.FC<StatusBadgeProps> = ({ status, t }) => {
  const Icon = STATUS_ICON[status];
  const label = t.status[status];

  return (
    <span
      role="status"
      aria-label={label}
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-bold border whitespace-nowrap ${STATUS_CLASSNAME[status]}`}
    >
      <Icon className="h-3.5 w-3.5" aria-hidden="true" />
      {label}
    </span>
  );
};
