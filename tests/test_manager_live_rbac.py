"""Regression checks for the chart-owned Manager live read permissions."""
import pathlib
import re
import subprocess
import unittest

import yaml

ROOT = pathlib.Path(__file__).resolve().parents[1]
WORKLOAD_SOURCE = ROOT / 'manager/packages/domain-api/src/adapters/kubeWorkload.ts'


class ManagerLiveRbacTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        rendered = subprocess.check_output(
            ['helm', 'template', 'gitops/charts/beluga-platform'], cwd=ROOT, text=True)
        cls.docs = [doc for doc in yaml.safe_load_all(rendered) if doc]

    def test_exact_permissions_and_subjects(self):
        source = WORKLOAD_SOURCE.read_text()
        workload_map = re.search(r'export const WORKLOADS: Record<string, WorkloadTarget> = \{(.*?)\n\};', source, re.S)
        self.assertIsNotNone(workload_map, 'WORKLOADS literal map must remain parseable')
        targets = {}
        for entry in re.finditer(r'"([^"]+)": \{\s*namespace: "([^"]+)",\s*resource: "([^"]+)",\s*names: \[([^\]]*)\]', workload_map.group(1)):
            _, namespace, resource, names = entry.groups()
            targets.setdefault(namespace, {'resources': set(), 'names': []})
            targets[namespace]['resources'].add(resource)
            targets[namespace]['names'].extend(re.findall(r'"([^"]+)"', names))
        self.assertTrue(targets)
        roles = [d for d in self.docs if d['kind'] == 'Role' and d['metadata']['name'] == 'manager-live-reader']
        self.assertEqual({r['metadata']['namespace'] for r in roles}, set(targets))
        self.assertEqual(len(roles), 4)
        for role in roles:
            ns = role['metadata']['namespace']
            resources = targets[ns]['resources']
            self.assertEqual(len(resources), 1, f'one workload resource type expected in {ns}')
            resource = next(iter(resources))
            group = 'kafka.strimzi.io' if resource == 'kafkas' else 'apps'
            self.assertEqual(role['rules'], [
                {'apiGroups': [''], 'resources': ['events'], 'verbs': ['list']},
                {'apiGroups': [group], 'resources': [resource], 'resourceNames': targets[ns]['names'], 'verbs': ['get']}])
        bindings = [d for d in self.docs if d['kind'] == 'RoleBinding' and d['metadata']['name'] == 'manager-live-reader']
        self.assertEqual({b['metadata']['namespace'] for b in bindings}, set(targets))
        for binding in bindings:
            self.assertEqual(binding['subjects'], [{'kind': 'ServiceAccount', 'name': 'manager-domain-api', 'namespace': 'platform-system'}])
            self.assertEqual(binding['roleRef'], {'apiGroup': 'rbac.authorization.k8s.io', 'kind': 'Role', 'name': 'manager-live-reader'})
        probe = next(d for d in self.docs if d['kind'] == 'ClusterRole' and d['metadata']['name'] == 'manager-readyz-reader')
        self.assertEqual(probe['rules'], [{'nonResourceURLs': ['/readyz'], 'verbs': ['get']}])

    def test_namespaces_precreated_before_argocd_bootstrap(self):
        script = (ROOT / 'scripts/gitops/01-argocd-bootstrap.sh').read_text()
        loop = re.search(r'for ns in ([^;]+); do\n  kubectl create namespace.*?\ndone', script, re.S)
        self.assertIsNotNone(loop)
        self.assertTrue({'analytics', 'orchestration', 'lakehouse', 'streaming'} <= set(loop.group(1).split()))
        self.assertLess(loop.start(), script.index('if [[ -d "${APP_OF_APPS}" ]]'))
        chart = (ROOT / 'gitops/charts/beluga-platform/templates/manager-live-reader.yaml').read_text()
        self.assertIn('direct chart installs must precreate these namespaces', chart)


if __name__ == '__main__':
    unittest.main()
