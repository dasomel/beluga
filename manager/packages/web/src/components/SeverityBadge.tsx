import React from 'react';
import { AlertOctagon, AlertTriangle, Info, type LucideIcon } from 'lucide-react';
import type { EventSeverity } from '@beluga-manager/domain-api/schema';
import { Translations } from '../i18n/translations';

interface SeverityBadgeProps {
  severity: EventSeverity;
  t: Translations;
}

const SEVERITY_ICON: Record<EventSeverity, LucideIcon> = {
  info: Info,
  warning: AlertTriangle,
  error: AlertOctagon,
};

// ADR-0003과 동일한 원칙(색상 단독 금지, 아이콘+라벨 병행)을 severity에도 적용한다 -- 다만
// StatusBadge의 5-value health status와는 다른 어휘라 별도 컴포넌트로 둔다.
const SEVERITY_CLASSNAME: Record<EventSeverity, string> = {
  info: 'bg-sky-50 dark:bg-sky-500/20 text-sky-800 dark:text-sky-300 border-sky-200 dark:border-sky-500/40',
  warning:
    'bg-amber-50 dark:bg-amber-500/20 text-amber-800 dark:text-amber-300 border-amber-200 dark:border-amber-500/40',
  error: 'bg-red-50 dark:bg-red-500/20 text-red-800 dark:text-red-300 border-red-200 dark:border-red-500/40',
};

export const SeverityBadge: React.FC<SeverityBadgeProps> = ({ severity, t }) => {
  const Icon = SEVERITY_ICON[severity];
  const label = t.severity[severity];

  return (
    <span
      role="status"
      aria-label={label}
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-bold border whitespace-nowrap ${SEVERITY_CLASSNAME[severity]}`}
    >
      <Icon className="h-3.5 w-3.5" aria-hidden="true" />
      {label}
    </span>
  );
};
