import type { DecisionRecord } from '@beluga-manager/domain-api/schema';
import type { Translations } from '../i18n/translations';

export function getDecisionLabel(record: Pick<DecisionRecord, 'result' | 'audit'>, t: Translations): string {
  if (record.audit) return t.operations.auditRecordLabel;
  return record.result.abstained ? t.operations.abstained : t.operations.decisionLabels[record.result.decision];
}

export function getAbstainLabel(record: Pick<DecisionRecord, 'result' | 'audit'>, t: Translations): string | undefined {
  if (record.audit) return undefined;
  const code = record.result.abstainCode;
  return record.result.abstained && code ? t.operations.abstainCodes[code] : undefined;
}
