import React from 'react';
import { AlertTriangle } from 'lucide-react';
import type { ListWarning } from '@beluga-manager/domain-api/schema';
import { Translations } from '../i18n/translations';

interface WarningsBadgeProps {
  warnings: ListWarning[];
  t: Translations;
}

// ADR-0002의 partial-failure 설계 원칙: 리스트 envelope의 warnings를 조용히 버리지 않고
// 항상 눈에 보이는 곳에 개수로라도 드러낸다. 메시지 전문은 title(hover) 툴팁으로 제공한다.
export const WarningsBadge: React.FC<WarningsBadgeProps> = ({ warnings, t }) => {
  if (warnings.length === 0) {
    return null;
  }

  return (
    <span
      title={warnings.map((warning) => warning.message).join('\n')}
      className="inline-flex items-center gap-1.5 rounded-full bg-amber-50 dark:bg-amber-500/20 px-2.5 py-1 text-xs font-bold text-amber-800 dark:text-amber-300 border border-amber-200 dark:border-amber-500/40 whitespace-nowrap"
    >
      <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />
      {warnings.length} {t.common.warningsCount}
    </span>
  );
};
