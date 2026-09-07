# DESIGN.md — Beluga

This file records the project-specific design contract used with the OpenForge OSS
Design System.

Reference: `https://github.com/dasomel/openforge/blob/main/docs/design-system.md`

## Product archetype

```yaml
archetype:
  primary: "Developer Tool"
  secondary: ""
  rationale: >
    Beluga is a headless Infrastructure-as-Code project (Vagrantfile + Helm +
    ArgoCD GitOps + shell scripts). It has no proprietary UI of its own — the
    only interfaces end users see are upstream OSS UIs it deploys as-is
    (Trino, Superset, Airflow, ArgoCD, Keycloak). The closest archetype is a
    Developer Tool consumed entirely through the CLI (`make`, `vagrant`,
    `kubectl`, `helm`) rather than a rendered surface this repo owns.
```

## Product personality

Not applicable — Beluga renders no UI. Deployed upstream components (Trino,
Superset, Airflow UI, ArgoCD UI, Keycloak) each carry their own upstream design and are
out of scope for OpenForge semantic tokens; this repo does not skin, theme, or fork
them.

## Token mapping

Not applicable for the same reason. If a future companion project (e.g. a Beluga
operations dashboard) wraps these components in a first-party UI, that project should
declare its own `DESIGN.md` against the `Operations Dashboard` or `Data Control Plane`
archetype (see `docs/design-system.md`'s "Beluga Manager" archetype entry for the
sibling project that does this).

## Information architecture

CLI/config surface only:

- `Makefile` — `up` / `down` / `status` / `test` / `lint` / `validate` / `clean`
  (see [README.md](README.md#quick-start))
- `configs/cluster.env` — declarative cluster topology
- `policies/*.yaml` — declarative RBAC/group/resource policy input, compiled downstream

## Core workflows

Documented per-command in [README.md](README.md#quick-start) and
[docs/development.md](docs/development.md). Failure/recovery behavior for each stage is
tracked in [docs/mistakes-log.md](docs/mistakes-log.md) rather than restated here.

## Accessibility

Not applicable — no first-party UI. CLI output uses `scripts/common/logging.sh`
severity prefixes (info/warn/error/success) rather than color alone, which is the
closest analog to the non-color status-cue rule for a terminal-only surface.

## Deviations

| Rule | Deviation | Rationale | Accessibility impact | Owner |
|---|---|---|---|---|
| Semantic color tokens, shared components | Not implemented | No proprietary UI exists to apply tokens to | None — terminal output only | dasomel |

## Review checklist

- [x] Project archetype declared (Developer Tool, headless)
- [x] Deviation documented (no UI surface)
- [ ] Semantic tokens used — N/A, no UI
- [ ] Loading/empty/error/success/disabled states covered — N/A, no UI
- [ ] Keyboard and focus reviewed — N/A, no UI
- [x] Status is not color-only (CLI log prefixes)
