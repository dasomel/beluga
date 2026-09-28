// @vitest-environment node
import { expect, test } from 'vitest';
import { translations } from '../i18n/translations';
import type { DecisionRecord } from '@beluga-manager/domain-api/schema';
import { getAbstainLabel, getDecisionLabel } from './decisionLabels';

const base = {
  id: 'test', snapshotId: 'snapshot', correlationId: 'correlation', evaluatedAt: '2026-09-28T09:00:00.000Z',
  freshnessPolicy: { maxAgeMs: 60_000 }, inputSignals: [],
  relatedResourceId: null, relatedServiceId: null, relatedPipelineId: null,
  result: { decision: 'NORMAL', confidence: 1, abstained: false, provider: 'rules', providerVersion: '1', policyVersion: '1', decidedAt: '2026-09-28T09:00:00.000Z', evidenceRefs: [] },
} satisfies DecisionRecord;

test('decision labels localize enums and abstain codes without exposing enum strings', () => {
  expect(getDecisionLabel(base, translations['en-US'])).toBe('Normal');
  expect(getAbstainLabel(base, translations['en-US'])).toBeUndefined();
  const abstained: DecisionRecord = { ...base, result: { ...base.result, decision: 'ABSTAIN', abstained: true, abstainCode: 'NO_TELEMETRY' } };
  expect(getDecisionLabel(abstained, translations['en-US'])).toBe('Abstained');
  expect(getAbstainLabel(abstained, translations['en-US'])).toBe('No telemetry');
});
