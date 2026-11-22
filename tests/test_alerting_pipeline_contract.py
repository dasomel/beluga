"""Offline contract tests: the alerting checker and its contracts reject removed or drifted rules and inhibition."""
import copy
import importlib.util
import os
from pathlib import Path
import sys
import subprocess
import unittest

import yaml

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts/ci'))
from alerting_rule_contract import live_selectors, validate_memory_inhibition, validate_rule_inputs

SPEC = importlib.util.spec_from_file_location('alerting_checker', ROOT / 'scripts/ci/check-alerting-pipeline.py')
CHECKER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(CHECKER)


class AlertingPipelineContractTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        env = {**os.environ, 'KUBECONFIG': os.devnull}
        rendered = subprocess.check_output(['helm', 'template', 'beluga-platform',
                                           str(ROOT / 'gitops/charts/beluga-platform')], text=True, env=env)
        data = subprocess.check_output(['helm', 'template', 'beluga-data',
                                       str(ROOT / 'gitops/charts/beluga-data')], text=True, env=env)
        cls.docs = [d for d in yaml.safe_load_all(rendered + '\n---\n' + data) if d]
        cls.scrape = CHECKER.parsed(cls.docs, 'victoria-metrics-scrape', 'scrape.yml')

    def setUp(self):
        chart = ROOT / 'gitops/charts/beluga-platform'
        self.data = {p.name: p.read_text() for p in (chart / 'files/observability/rules').glob('*.yml')}
        self.jobs = {j['job_name']: j for j in self.scrape['scrape_configs']}
        self.config = yaml.safe_load((chart / 'values.yaml').read_text())['observability']['alertmanager']['config']

    def validate(self):
        validate_rule_inputs(self.data, live_selectors(ROOT), self.jobs)

    def test_shipped_contract(self):
        self.validate()
        validate_memory_inhibition(self.config)

    def test_checker_rejects_removed_rules(self):
        for alert in ('NodeMemoryLow', 'NodeMemoryMetricsMissing', 'ContainerRestartingFrequently'):
            with self.subTest(alert=alert):
                bad = copy.deepcopy(self.docs)
                data = CHECKER.find(bad, 'ConfigMap', 'vmalert-rules')['data']
                pipeline = yaml.safe_load(data['pipeline.yml'])
                pipeline['groups'][0]['rules'] = [r for r in pipeline['groups'][0]['rules'] if r['alert'] != alert]
                data['pipeline.yml'] = yaml.safe_dump(pipeline)
                with self.assertRaises(ValueError):
                    CHECKER.validate(bad, self.config)

    def test_checker_rejects_inhibition_removed_from_values_and_render(self):
        bad = copy.deepcopy(self.docs)
        config = copy.deepcopy(self.config)
        config.pop('inhibit_rules')
        CHECKER.find(bad, 'ConfigMap', 'alertmanager-config')['data']['alertmanager.yml'] = yaml.safe_dump(config)
        with self.assertRaisesRegex(ValueError, 'node memory inhibition'):
            CHECKER.validate(bad, config)

    def test_memory_absence_rule_drift_rejected(self):
        original = yaml.safe_load(self.data['pipeline.yml'])
        for field, value in (('expr', 'vector(1)'), ('for', '1m'), ('labels', {'severity': 'critical'})):
            with self.subTest(field=field):
                bad = copy.deepcopy(original)
                next(r for r in bad['groups'][0]['rules'] if r['alert'] == 'NodeMemoryMetricsMissing')[field] = value
                self.data['pipeline.yml'] = yaml.safe_dump(bad)
                with self.assertRaises(ValueError):
                    self.validate()

    def test_inhibition_required_even_with_matching_values_override(self):
        # D-ALERT-28: check semantics separately from values equality; cost: fixed
        # memory contract; escape: review together with a future aggregation change.
        for field, value in (('equal', ['instance']), ('equal', []),
                             ('source_matchers', ['severity="critical"']),
                             ('target_matchers', ['alertname="NodeMemoryLow"', 'severity="critical"'])):
            with self.subTest(field=field):
                bad = copy.deepcopy(self.config)
                bad['inhibit_rules'][0][field] = value
                with self.assertRaises(ValueError):
                    validate_memory_inhibition(bad)
        for remove in (lambda c: c.pop('inhibit_rules'), lambda c: c.update(inhibit_rules=[])):
            bad = copy.deepcopy(self.config)
            remove(bad)
            with self.assertRaises(ValueError):
                validate_memory_inhibition(bad)


if __name__ == '__main__':
    unittest.main()
