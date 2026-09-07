# Security Policy

English | [한국어](SECURITY-ko.md)

## Supported Versions

Beluga is a personal/learning-scale, pre-1.0 project with no tagged releases yet. The
`main` branch is the only supported line.

| Version | Supported          |
| ------- | ------------------ |
| `main`  | :white_check_mark: |

## Security Scope & Credential Isolation

Beluga provisions a local multi-VM Kubernetes cluster and deploys a full data platform
(Kafka/CDC, Flink, Iceberg, Trino, Airflow, Keycloak/OpenLDAP, ArgoCD) via GitOps.

- **No credential is ever committed to the repository.** All service passwords are
  generated with `openssl rand` at bootstrap time and stored only in the Kubernetes
  Secret `beluga-credentials` (see [README.md](README.md#credentials)). Repo-checked-in
  values are `SET-AT-BOOTSTRAP` placeholders only.
- `configs/cluster.env` holds non-secret cluster topology (subnets, node IPs, domain
  registry) — never add real secrets to it.
- This host is shared by multiple concurrent sessions/clusters — always isolate
  `KUBECONFIG` before running `kubectl`/`helm` against the `beluga` context (see
  [CLAUDE.md](CLAUDE.md)).
- Gateway/auth changes must be verified through both direct component access and the
  documented user entry point (the APISIX gateway domain registry).

## Reporting a Vulnerability

Please report vulnerabilities privately via GitHub Private Vulnerability Reporting on
this repository, or by contacting the maintainer directly. Do not open a public issue
for a sensitive security defect. We aim to acknowledge reports within 5 business days.

Reference: [OpenForge Security Standard](https://github.com/dasomel/openforge/blob/main/docs/security.md)
