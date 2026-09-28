import type { DecisionRecord } from '@beluga-manager/domain-api/schema';
import type { Translations } from '../i18n/translations';

export function getDecisionLabel(record: Pick<DecisionRecord, 'result'>, t: Translations): string {
  return record.result.abstained ? t.operations.abstained : t.operations.decisionLabels[record.result.decision];
}

export function getAbstainLabel(record: Pick<DecisionRecord, 'result'>, t: Translations): string | undefined {
  const code = record.result.abstainCode;
  return record.result.abstained && code ? t.operations.abstainCodes[code] : undefined;
}
