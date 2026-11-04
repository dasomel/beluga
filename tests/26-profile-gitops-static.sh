#!/usr/bin/env bash
# Issue #333: static/render evidence only; no cluster access.
set -euo pipefail
export KUBECONFIG=/dev/null
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
kubectl kustomize gitops/apps > "${TMP}/default.yaml"
kubectl kustomize gitops/profiles/full > "${TMP}/full.yaml"
helm template beluga-data gitops/charts/beluga-data -f gitops/values/sso.yaml --namespace storage --set openmetadata.enabled=true --set trino.workerEnabled=true > "${TMP}/old.yaml"
helm template beluga-data gitops/charts/beluga-data -f gitops/values/sso.yaml --namespace storage -f gitops/values/profile-full.yaml > "${TMP}/new.yaml"
diff -u "${TMP}/old.yaml" "${TMP}/new.yaml"
echo "PASS: full values render equals previous --set render (empty diff)"
python3 -I - "${ROOT}" "${TMP}" <<'PY'
import copy
import os
from pathlib import Path
import subprocess
import sys
import yaml

root, tmp = map(Path, sys.argv[1:])

def apps(text):
    docs = list(yaml.safe_load_all(text))
    assert len(docs) == 3, 'expected exactly three Applications'
    return {d['metadata']['name']: d for d in docs}

raw = apps('\n---\n'.join(p.read_text() for p in sorted((root / 'gitops/apps').glob('*.yaml'))))
assert apps((tmp / 'default.yaml').read_text()) == raw, 'default root changed'
expected = copy.deepcopy(raw)
expected['beluga-root']['spec']['source']['path'] = 'gitops/profiles/full'
assert raw['beluga-root']['metadata']['labels']['beluga.internal/app-role'] == 'root'
expected['beluga-data']['spec']['source']['helm']['valueFiles'].append('../../values/profile-full.yaml')
assert apps((tmp / 'full.yaml').read_text()) == expected, 'overlay changed more than path + valueFiles'
assert '../../values/profile-full.yaml' in expected['beluga-data']['spec']['source']['helm']['valueFiles']
print('PASS: full default overlay root renders beluga-data with profile-full.yaml')
print('PASS: default root equals raw Applications; full changes only path + valueFiles')

# Exercise the directory-root apply branch with a kubectl stub that captures stdin.
stub_bin = tmp / 'kubectl-bin'
stub_bin.mkdir()
kubectl_stub = stub_bin / 'kubectl'
kubectl_stub.write_text("""#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$KUBECTL_ARGS"
if [[ "$1" == kustomize ]]; then
  [[ "${KUSTOMIZE_FAIL:-false}" == true ]] && exit 42
  cat "$KUSTOMIZE_OUTPUT"
  exit 0
fi
if [[ "$1" == apply && "$2" == -l && "$3" == beluga.internal/app-role=root && "$4" == -f && "$5" == - ]]; then
  awk 'BEGIN{RS="---"; ORS="\\n---\\n"} /beluga\\.internal\\/app-role: root/{print}' > "$APPLY_CAPTURE"
  exit "${APPLY_EXIT:-0}"
fi
echo "unexpected kubectl: $*" >&2
exit 91
""")
kubectl_stub.chmod(0o755)
capture = tmp / 'applied.yaml'
apply_args = tmp / 'kubectl-args'
apply_env = dict(os.environ, PATH=f'{stub_bin}:{os.environ["PATH"]}',
                 KUSTOMIZE_OUTPUT=str(tmp / 'full.yaml'), APPLY_CAPTURE=str(capture), KUBECTL_ARGS=str(apply_args))
apply_probe = tmp / 'apply-root-probe.sh'
bootstrap = (root / 'scripts/gitops/01-argocd-bootstrap.sh').read_text()
apply_block = bootstrap.split('log_info "Applying App-of-Apps root manifest..."', 1)[1].split('# D-SSO-4:', 1)[0]
apply_probe.write_text('#!/usr/bin/env bash\nset -euo pipefail\nAPP_OF_APPS="$1"\nlog_error() { echo "$*" >&2; }\nlog_success() { echo "SUCCESS: $*"; }\n' + apply_block + '\nlog_success "GitOps applications applied successfully."\n')
apply_probe.chmod(0o755)
subprocess.run(['bash', str(apply_probe), str(root / 'gitops/profiles/full')], env=apply_env, check=True)
applied_docs = [doc for doc in yaml.safe_load_all(capture.read_text()) if doc is not None]
assert len(applied_docs) == 1, f'expected one applied object, got {len(applied_docs)}'
assert applied_docs[0]['kind'] == 'Application'
assert applied_docs[0]['metadata']['name'] == 'beluga-root'
assert applied_docs[0]['spec']['source']['path'] == 'gitops/profiles/full'
assert 'apply -l beluga.internal/app-role=root -f -' in apply_args.read_text()
rendered_labels = [d['metadata']['name'] for d in yaml.safe_load_all((tmp / 'full.yaml').read_text())
                   if d and d.get('metadata', {}).get('labels', {}).get('beluga.internal/app-role') == 'root']
assert rendered_labels == ['beluga-root'], f'unexpected root label selection: {rendered_labels}'
print('PASS: full bootstrap selects exactly one root-labeled object: beluga-root at gitops/profiles/full')

# Directory-root failures must fail closed before any child application is applied.
zero_labels = tmp / 'zero-labels.yaml'
zero_labels.write_text((tmp / 'full.yaml').read_text().replace('    beluga.internal/app-role: root\n', ''))
two_labels = tmp / 'two-labels.yaml'
two_labels.write_text((tmp / 'full.yaml').read_text() + '\n---\napiVersion: argoproj.io/v1alpha1\nkind: Application\nmetadata:\n  name: extra-root\n  labels:\n    beluga.internal/app-role: root\nspec:\n  source:\n    path: gitops/profiles/full\n')

def assert_fail_closed(name, **overrides):
    args_file = tmp / f'{name}-args'
    env = dict(apply_env, KUBECTL_ARGS=str(args_file), APPLY_CAPTURE=str(tmp / f'{name}-capture.yaml'))
    env.update(overrides)
    if 'KUSTOMIZE_OUTPUT' not in env:
        env['KUSTOMIZE_OUTPUT'] = str(tmp / 'full.yaml')
    result = subprocess.run(['bash', str(apply_probe), str(root / 'gitops/profiles/full')],
                            env=env, capture_output=True, text=True)
    assert result.returncode != 0, f'{name} unexpectedly succeeded: {result}'
    assert 'SUCCESS:' not in result.stdout, f'{name} reported success: {result.stdout}'
    assert ('Unable to render' in result.stderr or
            'Expected exactly one root-labeled' in result.stderr or
            'Unable to apply root-labeled' in result.stderr), result.stderr
    calls = args_file.read_text().splitlines() if args_file.exists() else []
    assert all(call.startswith('kustomize ') or call == 'apply -l beluga.internal/app-role=root -f -' for call in calls), calls
    assert not any(call.startswith('apply -f ') or call.startswith('apply -k ') for call in calls), calls
    if name == 'apply-failure':
        assert calls == ['kustomize ' + str(root / 'gitops/profiles/full'),
                         'apply -l beluga.internal/app-role=root -f -'], calls
    else:
        assert not any(call.startswith('apply ') for call in calls), calls
    print(f'PASS: {name} fails closed without child applies or success output')

assert_fail_closed('zero-labelled', KUSTOMIZE_OUTPUT=str(zero_labels))
assert_fail_closed('two-labelled', KUSTOMIZE_OUTPUT=str(two_labels))
assert_fail_closed('kustomize-failure', KUSTOMIZE_FAIL='true')
assert_fail_closed('apply-failure', APPLY_EXIT='43')

script = root / 'scripts/gitops/01-argocd-bootstrap.sh'
# Execute the actual initialization through profile selection; functions and live
# operations below get_cred are excluded from positive probes.
prefix = script.read_text().split('get_cred() {', 1)[0].replace('source "${SCRIPT_DIR}/../../env.sh"', f'source "{root}/scripts/common/logging.sh"\nsource "{tmp}/env.sh"\nsource "{root}/scripts/common/verified-fetch.sh"')
render = script.read_text().split('helm template beluga-data ', 1)[1].split('| kubectl apply', 1)[0]
render = 'helm template beluga-data ' + render.strip()
probe = tmp / 'probe.sh'
probe.write_text(prefix.replace('SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"',
                               f'SCRIPT_DIR="{tmp}/scripts/gitops"').replace('source "${SCRIPT_DIR}/../common/env.sh"', f'source "{tmp}/env.sh"').replace('source "${SCRIPT_DIR}/../common/logging.sh"', f'source "{root}/scripts/common/logging.sh"').replace('BELUGA_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"',
                               f'BELUGA_ROOT="{tmp}"').replace('source "${SCRIPT_DIR}/../common/verified-fetch.sh"',
                               f'source "{root}/scripts/common/verified-fetch.sh"') +
                 '\nprintf "ROOT=%s\\n" "$APP_OF_APPS"\nprintf "VALUES=%s\\n" "${DATA_PROFILE_VALUES[*]}"\n' +
                 render.replace('\"${BELUGA_ROOT}/gitops/charts/beluga-data\"', f'\"{root}/gitops/charts/beluga-data\"').replace('\"${BELUGA_ROOT}/gitops/values/sso.yaml\"', f'\"{root}/gitops/values/sso.yaml\"').replace('\"${BELUGA_ROOT}/gitops/values/profile-full.yaml\"', f'\"{root}/gitops/values/profile-full.yaml\"') + ' > "$PROFILE_RENDER_OUT"\n')
(tmp / 'configs').mkdir()
(tmp / 'scripts' / 'gitops').mkdir(parents=True)
(tmp / 'gitops' / 'values').mkdir(parents=True)
(tmp / 'gitops' / 'values' / 'sso.yaml').write_text((root / 'gitops/values/sso.yaml').read_text())
(tmp / 'gitops' / 'values' / 'profile-full.yaml').write_text((root / 'gitops/values/profile-full.yaml').read_text())
env_source = (root / 'scripts/common/env.sh').read_text()
env_source = env_source.replace('BELUGA_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"', f'BELUGA_ROOT="{tmp}"')
env_source = env_source.replace('apply_ram_profile || { return 1 2>/dev/null || exit 1; }', ':')
(tmp / 'env.sh').write_text(env_source)
# Isolate the repo's cluster.env auto-profile so probe flags are deterministic.
(tmp / 'configs' / 'cluster.env').write_text('BELUGA_PROFILE=32\n')
no_override = str(tmp / 'nonexistent-override.env')
blocked_bin = tmp / 'bin'
blocked_bin.mkdir()
for name in ('kubectl', 'helm', 'vagrant'):
    blocked = blocked_bin / name
    blocked.write_text('#!/usr/bin/env bash\necho unexpected-cluster-access >&2\nexit 99\n')
    blocked.chmod(0o755)
for om, worker in [('false', 'false'), ('true', 'true'), ('true', 'false'), ('false', 'true')]:
    env = {'PATH': os.environ['PATH'], 'HOME': os.environ.get('HOME', ''), 'BELUGA_PROFILE': '32',
           'BELUGA_ROOT': str(tmp), 'BELUGA_ENV_OVERRIDE_FILE': no_override, 'KUBECONFIG': os.devnull,
           'ENABLE_OPENMETADATA': om, 'TRINO_WORKER_ENABLED': worker,
           'PROFILE_RENDER_OUT': str(tmp / 'bootstrap.yaml'),
           'BASE_DOMAIN': 'local.beluga.internal'}
    env.pop('BELUGA_APP_OF_APPS', None)
    if om != worker:
        # Actual profile validation must exit before get_cred or any external operation.
        mixed_env = dict(env, ENABLE_OPENMETADATA=om, TRINO_WORKER_ENABLED=worker,
                         PATH=f"{blocked_bin}:{env['PATH']}")
        result = subprocess.run(['bash', str(probe)], env=mixed_env, capture_output=True, text=True)
        assert 'unexpected-cluster-access' not in result.stderr, result
        assert result.returncode == 1 and 'No GitOps profile' in result.stderr + result.stdout, result
        continue
    result = subprocess.run(['bash', str(probe)], env=env, capture_output=True, text=True)
    assert result.returncode == 0, result
    full = om == 'true'
    selected = tmp / ('gitops/profiles/full' if full else 'gitops/apps/app-of-apps.yaml')
    values = f'-f {tmp}/gitops/values/sso.yaml'
    if full:
        values += f' -f {tmp}/gitops/values/profile-full.yaml'
    assert f'ROOT={selected}\nVALUES={values}\n' in result.stdout, result.stdout
    app = (expected if full else raw)['beluga-data']
    if full:
        assert '../../values/profile-full.yaml' in app['spec']['source']['helm']['valueFiles']
        assert selected == tmp / 'gitops/profiles/full'
    chart = root / app['spec']['source']['path']
    args = ['helm', 'template', 'beluga-data', str(chart), '--namespace', 'storage']
    for value_file in app['spec']['source']['helm']['valueFiles']:
        args += ['-f', str(chart / value_file)]
    desired = subprocess.run(args, capture_output=True, text=True, check=True).stdout
    assert (tmp / 'bootstrap.yaml').read_text() == desired, 'bootstrap differs from Application render'
    env['BELUGA_APP_OF_APPS'] = str(root / 'csp/kakao-cloud/gitops/app-of-apps-kakao.yaml')
    # Preserve the selected profile explicitly; env.sh only fills unset flags.
    env['ENABLE_OPENMETADATA'] = om
    env['TRINO_WORKER_ENABLED'] = worker
    explicit = subprocess.run(['bash', str(probe)], env=env, capture_output=True, text=True, check=True)
    assert f"ROOT={env['BELUGA_APP_OF_APPS']}\n" in explicit.stdout, explicit.stdout
    if full:
        kakao = yaml.safe_load((root / 'csp/kakao-cloud/gitops/apps/beluga-data.yaml').read_text())
        assert '../../values/profile-full.yaml' in kakao['spec']['source']['helm']['valueFiles']
        kakao_chart = root / kakao['spec']['source']['path']
        kakao_args = ['helm', 'template', 'beluga-data', str(kakao_chart), '--namespace', 'storage']
        for value_file in kakao['spec']['source']['helm']['valueFiles']:
            kakao_args += ['-f', str(kakao_chart / value_file)]
        kakao_render = subprocess.run(kakao_args, capture_output=True, text=True, check=True).stdout
        # Compare Kakao's own Application render with the bootstrap flags and domain.
        kakao_env = {'PATH': os.environ['PATH'], 'HOME': os.environ.get('HOME', ''),
                     'BELUGA_PROFILE': '64', 'BELUGA_ENV_OVERRIDE_FILE': no_override, 'KUBECONFIG': os.devnull,
                     'ENABLE_OPENMETADATA': 'true', 'TRINO_WORKER_ENABLED': 'true',
                     'PROFILE_RENDER_OUT': str(tmp / 'kakao-bootstrap.yaml'),
                     'BASE_DOMAIN': 'kakao.beluga.internal',
                     'BELUGA_APP_OF_APPS': str(root / 'csp/kakao-cloud/gitops/app-of-apps-kakao.yaml'),
                     'BELUGA_ROOT': str(root)}
        kakao_bootstrap = subprocess.run(['bash', str(probe)], env=kakao_env, capture_output=True, text=True)
        assert kakao_bootstrap.returncode == 0, kakao_bootstrap
        assert (tmp / 'kakao-bootstrap.yaml').read_text() == kakao_render, 'Kakao bootstrap differs from Kakao Application render'
# Invalid explicit roots and mixed flags must stop before any kubectl call.
missing = dict(env, BELUGA_PROFILE='32', ENABLE_OPENMETADATA='false', TRINO_WORKER_ENABLED='false', BELUGA_APP_OF_APPS=str(tmp / 'missing-root'))
missing_result = subprocess.run(['bash', str(probe)], env=dict(missing, PATH=f"{blocked_bin}:{missing['PATH']}"), capture_output=True, text=True)
assert missing_result.returncode == 1 and 'BELUGA_APP_OF_APPS must name' in missing_result.stderr + missing_result.stdout, missing_result
up = root / 'scripts/up.sh'
up_result = subprocess.run(['bash', str(up)], env=dict(env, BELUGA_PROFILE='64', ENABLE_OPENMETADATA='true', TRINO_WORKER_ENABLED='false', PATH=f"{blocked_bin}:{env['PATH']}"), capture_output=True, text=True)
assert up_result.returncode != 0 and 'No GitOps profile' in up_result.stderr + up_result.stdout, up_result
assert 'unexpected-cluster-access' not in up_result.stderr
print('PASS: bootstrap matches Application renders, selects default/full, preserves explicit root, rejects mixed flags, and validates roots before cluster access')
PY
echo "PASS: profile GitOps static contract"
