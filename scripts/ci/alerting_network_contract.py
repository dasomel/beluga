"""Offline alerting network paths and Cilium identity regression fixtures."""
from __future__ import annotations

import copy

CNP_NAME = 'victoria-metrics-entity-egress'
ENTITY_SPEC = {
    'endpointSelector': {'matchLabels': {'app': 'victoria-metrics'}},
    'egress': [
        {'toEntities': ['kube-apiserver'], 'toPorts': [{'ports': [
            {'port': '6443', 'protocol': 'TCP'}, {'port': '443', 'protocol': 'TCP'}]}]},
        {'toEntities': ['host', 'remote-node'], 'toPorts': [{'ports': [
            {'port': '10250', 'protocol': 'TCP'}]}]},
    ],
}


def require(ok, message):
    if not ok:
        raise ValueError(message)


def policy(docs, name):
    matches = [d for d in docs if d['kind'] == 'NetworkPolicy'
               and d['metadata']['name'] == name
               and d['metadata'].get('namespace') == 'platform-system']
    require(len(matches) == 1, f'NetworkPolicy/{name}: expected one policy')
    return matches[0]['spec']


def peer(app):
    return {'podSelector': {'matchLabels': {'app': app}}}


def validate_network(docs, cilium_enabled=True):
    # D-ALERT-14: disallow CIDR shortcuts for node/API ports across both charts.
    # Cost: CIDR-based HTTPS needs review; escape: use identity-aware Cilium rules.
    for doc in docs:
        if doc['kind'] != 'NetworkPolicy':
            continue
        for rule in doc['spec'].get('egress', []):
            if not any('ipBlock' in dest for dest in rule.get('to', [])):
                continue
            ports = rule.get('ports', [])
            for port in (443, 6443, 10250):
                hits = not ports or any(
                    p.get('protocol', 'TCP') == 'TCP' and
                    (p.get('port') is None or (str(p['port']).isdigit() and
                     int(p['port']) <= port <= int(p.get('endPort', p['port']))))
                    for p in ports)
                require(not hits, f"{doc['metadata']['name']}: ipBlock cannot select node/API identities on {port}")
    cnps = [d for d in docs if d['kind'] == 'CiliumNetworkPolicy'
            and d['metadata']['name'] == CNP_NAME]
    require(len(cnps) == int(cilium_enabled), 'Cilium entity egress flag/render drift')
    if cilium_enabled:
        cnp = cnps[0]
        require(cnp['apiVersion'] == 'cilium.io/v2' and
                cnp['metadata'].get('namespace') == 'platform-system' and
                cnp.get('spec') == ENTITY_SPEC and 'specs' not in cnp,
                'Cilium entity rules/VM-only selector drift')

    paths = [
        ('grafana', 'alertmanager', 9093),
        ('grafana', 'victoria-metrics', 8428),
        ('vmalert', 'victoria-metrics', 8428),
        ('victoria-metrics', 'vmalert', 8880),
        ('vmalert', 'alertmanager', 9093),
        ('victoria-metrics', 'grafana', 3000),
    ]
    for source, target, port in paths:
        for name, direction, key, app, selected in (
            (source + '-egress', 'egress', 'to', target, source),
            (target + '-ingress', 'ingress', 'from', source, target),
        ):
            spec = policy(docs, name)
            require(spec['podSelector'] == {'matchLabels': {'app': selected}}, f'{name}: selector drift')
            require(any(peer(app) in rule.get(key, []) and
                        {'protocol': 'TCP', 'port': port} in rule.get('ports', [])
                        for rule in spec.get(direction, [])), f'{source} -> {target}:{port}: missing {name}')
    metrics_rule = {'from': [peer('victoria-metrics')], 'ports': [{'protocol': 'TCP', 'port': 9187}]}
    db = policy(docs, 'manager-db-ingress')
    require(db['podSelector'] == {'matchLabels': {'cnpg.io/cluster': 'manager-db'}} and
            [r for r in db['ingress'] if peer('victoria-metrics') in r.get('from', [])] == [metrics_rule],
            'manager-db-ingress: expected VM-only 9187 rule')
    vm = policy(docs, 'victoria-metrics-egress')
    destinations = [
        {'namespaceSelector': {'matchLabels': {'kubernetes.io/metadata.name': 'database'}},
         'podSelector': {'matchLabels': {'cnpg.io/cluster': 'postgres-main'}}},
        {'podSelector': {'matchLabels': {'cnpg.io/cluster': 'manager-db'}}},
    ]
    require(any(r.get('to') == destinations and r.get('ports') == [{'protocol': 'TCP', 'port': 9187}]
                for r in vm['egress']), 'VM -> both CNPG exporters:9187 egress missing')


def self_test_network(docs):
    mutations = [
        lambda d: d.remove(next(r for r in d if r['kind'] == 'CiliumNetworkPolicy'
                               and r['metadata']['name'] == CNP_NAME)),
        lambda d: next(r for r in d if r['kind'] == 'CiliumNetworkPolicy'
                       and r['metadata']['name'] == CNP_NAME)['spec'].update(endpointSelector={}),
        lambda d: next(r for r in d if r['kind'] == 'CiliumNetworkPolicy'
                       and r['metadata']['name'] == CNP_NAME)['spec']['egress'][0].update(toEntities=['world']),
        lambda d: next(r for r in d if r['kind'] == 'CiliumNetworkPolicy'
                       and r['metadata']['name'] == CNP_NAME)['spec']['egress'][1]['toPorts'][0]['ports'].append(
                           {'port': '5432', 'protocol': 'TCP'}),
    ]
    for port in (443, 6443, 10250):
        mutations.append(lambda d, p=port: d.append({
            'kind': 'NetworkPolicy', 'metadata': {'name': 'regression', 'namespace': 'database'},
            'spec': {'egress': [{'to': [{'ipBlock': {'cidr': '10.0.0.0/8'}}],
                                 'ports': [{'port': p}]}]}}))
    for name, direction, app in (
        ('grafana-egress', 'egress', 'alertmanager'),
        ('alertmanager-ingress', 'ingress', 'grafana'),
        ('vmalert-egress', 'egress', 'victoria-metrics'),
        ('victoria-metrics-ingress', 'ingress', 'vmalert'),
        ('victoria-metrics-egress', 'egress', 'vmalert'),
        ('vmalert-ingress', 'ingress', 'victoria-metrics'),
        ('manager-db-ingress', 'ingress', 'victoria-metrics'),
    ):
        def remove_path(d, n=name, direction=direction, app=app):
            spec = policy(d, n)
            key = 'to' if direction == 'egress' else 'from'
            spec[direction] = [r for r in spec[direction] if peer(app) not in r.get(key, [])]
        mutations.append(remove_path)
    for mutate in mutations:
        bad = copy.deepcopy(docs)
        mutate(bad)
        try:
            validate_network(bad)
        except ValueError:
            continue
        raise ValueError('network negative fixture unexpectedly passed')
    print(f'PASS: {len(mutations)} network negative fixtures rejected (CIDR, entities, selectors, both policy directions)')
