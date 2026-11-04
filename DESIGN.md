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
    ArgoCD GitOps + shell scripts). Its only first-party rendered surface is the
    Keycloak login theme `beluga` (see Product personality); every other interface
    end users see is an upstream OSS UI it deploys as-is (Trino, Superset, Airflow,
    ArgoCD). The closest archetype is a Developer Tool consumed through the CLI
    (`make`, `vagrant`, `kubectl`, `helm`), with that one themed login page as the
    sole exception.
```

## Product personality

Beluga renders one first-party page: the Keycloak login (SSO entry for every
component). It is the single deliberate exception to "no skinning" (owner request,
2026-11-05). Deployed upstream components (Trino, Superset, Airflow UI, ArgoCD UI) each
carry their own upstream design and remain out of scope; this repo does not skin or
fork them. Keycloak's admin and account consoles also stay on the upstream theme.

Login personality: quiet and exact, a data-platform front door. Left, a deep "fjord"
panel with a bathymetric contour drawing (the lake/sea-depth motif of "beluga" and the
data lake); right, an ice-white left-aligned form. Boldness is spent only on the contour
panel; the form, copy and controls stay plain. Sentence case, no all-caps labels, no
decorative arrows or numbering.

## Token mapping

Login theme tokens (`gitops/charts/beluga-platform/files/keycloak-theme/beluga/login/resources/css/beluga.css`):

| Token | Value | Use |
|---|---|---|
| Ice | `#F3F7F9` | page and form surface |
| Fjord | `#0E2A36` | contour panel, headings |
| Current | `#0E7490` | primary button, focus ring, links (same cyan-700 as Beluga Manager); hover `#0B5F75` |
| Shoal | `#9CC9D6` | contour strokes, low opacity on Fjord |
| Ink | `#334155` | body text |
| Signal | `#B42318` | errors (always with icon and text) |
| Dark mode | form `#0F2530`, text `#E2EEF2`, inputs `#132F3B` / border `#2A4A57` | `prefers-color-scheme: dark`; the panel is unchanged |

Type: Red Hat Display (wordmark, title, weight 600) and Red Hat Text (body), both bundled
with Keycloak's PatternFly 5, so no external font fetch; Hangul falls back to system fonts.
Everything else Beluga renders has no tokens of its own. If a future companion project (e.g. a Beluga
operations dashboard) wraps these components in a first-party UI, that project should
declare its own `DESIGN.md` against the `Operations Dashboard` or `Data Control Plane`
archetype (see `docs/design-system.md`'s "Beluga Manager" archetype entry for the
in-repo `manager/` project that does this).

## Information architecture

CLI/config surface, plus one themed page (Keycloak login: contour panel + single-column
form, panel collapses to a 120px band under 900px):

- `Makefile` — `up` / `down` / `status` / `test` / `lint` / `validate` / `clean`
  (see [README.md](README.md#quick-start))
- `configs/cluster.env` — declarative cluster topology
- `policies/*.yaml` — declarative RBAC/group/resource policy input, compiled downstream

## Core workflows

Documented per-command in [README.md](README.md#quick-start) and
[docs/development.md](docs/development.md). Failure/recovery behavior for each stage is
tracked in [docs/mistakes-log.md](docs/mistakes-log.md) rather than restated here.

## Accessibility

Login theme: visible keyboard focus (2px Current ring with offset), WCAG AA contrast in
light and dark, error and alert states carry an icon and text (never color alone), the
only motion is a single fade of the contour panel and it is disabled under
`prefers-reduced-motion`, usable at 320px width. For the CLI, output uses
`scripts/common/logging.sh` severity prefixes (info/warn/error/success) rather than
color alone, the analog of the non-color status-cue rule for a terminal-only surface.

## Deviations

| Rule | Deviation | Rationale | Accessibility impact | Owner |
|---|---|---|---|---|
| Semantic color tokens, shared components | Not implemented | Only the Keycloak login theme is first-party; it uses its own CSS custom properties, not OpenForge semantic tokens | None for CLI; login theme meets the checks above | dasomel |
| "Does not skin upstream UIs" | Keycloak login only | Owner request (2026-11-05): SSO is the front door for every component and deserves a designed entry; the theme stays CSS/SVG/messages plus one minimal `login.ftl` fork | See Accessibility | dasomel |

## Review checklist

- [x] Project archetype declared (Developer Tool, headless)
- [x] Deviation documented (no UI surface except the Keycloak login theme)
- [ ] Semantic tokens used — N/A, no UI beyond the login theme (own CSS properties)
- [x] Login theme: error and alert states covered (invalid credentials, account disabled); loading/empty N/A
- [x] Login theme: keyboard and focus reviewed (2px Current ring, screenshots in the change evidence)
- [x] Status is not color-only (CLI log prefixes; login errors use icon + text)
