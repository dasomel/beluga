# Beluga Operations Agent — Read-only PoC Contract

This workspace profile implements the first safe execution slice for Beluga issue #108. It is intentionally smaller than a general autonomous operations agent.

## Mission

Inspect the Beluga Kubernetes/data-platform runtime, collect evidence, identify observable failure signals, and produce remediation **proposals** without mutating the cluster.

## Roles

```text
Beluga Operations Agent
├── cluster-inspector
├── data-service-inspector
├── identity-inspector
├── storage-inspector
├── observability-inspector
├── hypothesis-agent
└── verifier
```

The current executable PoC implements the shared read-only inspection boundary. Role-specific graph orchestration remains future work.

## Execution security contract

The execution boundary follows OpenForge Agent Execution Security principles:

```text
request
  -> resolve fixed tool + target
  -> canonical invocation digest
  -> risk classification
  -> request-side authorization
  -> fixed argv executor (read-only only)
  -> result hashing / findings
  -> evidence record
```

### Risk classes

| Class | Current behavior |
|---|---|
| `read-only-diagnostic` | executable when explicitly allowlisted |
| `data-mutation` | approval required by contract, execution disabled in PoC |
| `external-egress` | approval required by contract, execution disabled in PoC |
| `privileged-platform-operation` | approval required by contract, execution disabled in PoC |

An approval flag does not upgrade a disabled class into executable authority. Mutation/egress/privileged execution requires a later design and implementation that binds approval to the same resolved invocation and verifies post-state.

## Safety invariants

- Never run free-form shell or model-generated `kubectl` arguments.
- Only tool IDs with code-owned argv in `scripts/agent/operations_agent.py` may reach subprocess execution.
- Policy data may classify or disable known tools but cannot inject command text.
- Use an explicit isolated kubeconfig; refuse the shared `~/.kube/config` path.
- Always address Kubernetes context `beluga`.
- Do not persist raw command output in execution evidence. Store hashes, byte counts, status, and bounded structured findings instead.
- Unknown tools and unsupported policy modes fail closed.
- Read-only findings are observations, not proof of root cause.
- Remediation remains proposal-only until a separately reviewed L3 execution path exists.

## Local usage

List policy tools:

```bash
python3 scripts/agent/operations_agent.py list-tools
```

Resolve and authorize without execution:

```bash
python3 scripts/agent/operations_agent.py plan \
  --tool cluster.pods \
  --correlation-id incident-001
```

Run a read-only inspection with an isolated kubeconfig:

```bash
kubectl --context=beluga config view --minify --flatten > /tmp/beluga-kubeconfig.yaml
python3 scripts/agent/operations_agent.py run \
  --tool cluster.pods \
  --correlation-id incident-001 \
  --kubeconfig /tmp/beluga-kubeconfig.yaml \
  --evidence-out /tmp/beluga-agent-evidence.json
```

## Verification

Run the isolated policy/security suite without requiring a live cluster:

```bash
make test-agent
```

A real-cluster claim still requires the repository's documented shared-environment kubeconfig isolation and live-state validation rules from `CLAUDE.md`.
