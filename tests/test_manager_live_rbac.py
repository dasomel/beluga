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

    def test_observability_role_is_conditional(self):
        rendered = subprocess.check_output(
            ['helm', 'template', 'gitops/charts/beluga-platform', '--set', 'observability.enabled=false'],
            cwd=ROOT, text=True)
        docs = [doc for doc in yaml.safe_load_all(rendered) if doc]
        platform_roles = [d for d in docs if d['kind'] == 'Role' and d['metadata'].get('name') == 'manager-live-reader' and d['metadata'].get('namespace') == 'platform-system']
        platform_bindings = [d for d in docs if d['kind'] == 'RoleBinding' and d['metadata'].get('name') == 'manager-live-reader' and d['metadata'].get('namespace') == 'platform-system']
        self.assertEqual(platform_roles, [])
        self.assertEqual(platform_bindings, [])

        default_roles = [d for d in self.docs if d['kind'] == 'Role' and d['metadata'].get('name') == 'manager-live-reader' and d['metadata'].get('namespace') == 'platform-system']
        default_bindings = [d for d in self.docs if d['kind'] == 'RoleBinding' and d['metadata'].get('name') == 'manager-live-reader' and d['metadata'].get('namespace') == 'platform-system']
        self.assertEqual(len(default_roles), 1)
        self.assertEqual(len(default_bindings), 1)

    def test_exact_permissions_and_subjects(self):
        source = WORKLOAD_SOURCE.read_text()
        workload_map = re.search(r'export const WORKLOADS: Record<string, WorkloadTarget> = \{(.*?)\n\};', source, re.S)
        self.assertIsNotNone(workload_map, 'WORKLOADS literal map must remain parseable')
        targets = {}
        for entry in re.finditer(r'"([^"]+)": \{\s*namespace: "([^"]+)",\s*resource: "([^"]+)",\s*names: \[([^\]]*)\]', workload_map.group(1)):
            _, namespace, resource, names = entry.groups()
            targets.setdefault(namespace, {'resources': {}})
            targets[namespace]['resources'].setdefault(resource, []).extend(re.findall(r'"([^"]+)"', names))
        observability = re.search(r'"svc-observability": \{.*?workloads: \[(.*?)\]', workload_map.group(1), re.S)
        self.assertIsNotNone(observability)
        for resource, name in re.findall(r'resource: "(deployments|statefulsets)", name: "([^"]+)"', observability.group(1)):
            targets.setdefault('platform-system', {'resources': {}})['resources'].setdefault(resource, []).append(name)
        for target in targets.values():
            for resource, names in target['resources'].items():
                target['resources'][resource] = list(dict.fromkeys(names))
        self.assertTrue(targets)
        roles = [d for d in self.docs if d['kind'] == 'Role' and d['metadata']['name'] == 'manager-live-reader']
        self.assertEqual({r['metadata']['namespace'] for r in roles}, set(targets))
        self.assertEqual(len(roles), len(targets))
        for role in roles:
            ns = role['metadata']['namespace']
            workload_rules = []
            for resource, names in targets[ns]['resources'].items():
                group = 'kafka.strimzi.io' if resource == 'kafkas' else 'apps'
                workload_rules.append({'apiGroups': [group], 'resources': [resource], 'resourceNames': names, 'verbs': ['get']})
            inventory_rules = [] if ns == 'platform-system' else [
                {'apiGroups': ['apps'], 'resources': ['deployments', 'statefulsets'], 'verbs': ['list']},
                {'apiGroups': ['batch'], 'resources': ['jobs'], 'verbs': ['list']},
                {'apiGroups': [''], 'resources': ['events'], 'verbs': ['list']},
            ]
            self.assertEqual(role['rules'], inventory_rules + workload_rules)
        bindings = [d for d in self.docs if d['kind'] == 'RoleBinding' and d['metadata']['name'] == 'manager-live-reader']
        self.assertEqual({b['metadata']['namespace'] for b in bindings}, set(targets))
        for binding in bindings:
            self.assertEqual(binding['subjects'], [{'kind': 'ServiceAccount', 'name': 'manager-domain-api', 'namespace': 'platform-system'}])
            self.assertEqual(binding['roleRef'], {'apiGroup': 'rbac.authorization.k8s.io', 'kind': 'Role', 'name': 'manager-live-reader'})
        probe = next(d for d in self.docs if d['kind'] == 'ClusterRole' and d['metadata']['name'] == 'manager-readyz-reader')
        self.assertEqual(probe['rules'], [{'nonResourceURLs': ['/readyz'], 'verbs': ['get']}])

    def test_inventory_source_matches_list_grants(self):
        source = (ROOT / 'manager/packages/domain-api/src/adapters/kubeResources.ts').read_text()
        collections = re.findall(r'group: "([^"]+)", collection: "([^"]+)", kind: "([^"]+)"', source)
        self.assertEqual(collections, [('apps/v1', 'deployments', 'Deployment'),
                                       ('apps/v1', 'statefulsets', 'StatefulSet'),
                                       ('batch/v1', 'jobs', 'Job')])
        self.assertIn('PLATFORM_NAMESPACES.flatMap', source)
        self.assertIn('from "./kubeWorkload.js"', source)

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
