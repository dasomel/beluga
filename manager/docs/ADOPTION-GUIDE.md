# Beluga Manager Adoption Guide

> Beluga Manager is architecture-forward and evolving. This guide deliberately separates **implemented vertical slices** from target architecture.

## 1. Read claims by evidence level

Use three labels when documenting a domain, endpoint, or UI workflow:

- **Implemented** — source exists and the workflow can be run/verified.
- **Integrated** — implemented and exercised against the intended Beluga/backend boundary.
- **Planned** — design/roadmap only; not presented as current product behavior.

## 2. First-success contract

A new contributor should be able to choose one implemented domain and prove a vertical slice:

1. Start the manager using the repository's current development path.
2. Reach the UI/API entry point.
3. Execute one read-only domain operation against a controlled backend or fixture.
4. Confirm the response is represented correctly in the UI/API surface.
5. Capture the command/test/build evidence used to verify it.

Do not require every target domain to exist before the project has a useful first success.

## 3. Architecture boundary

The manager is an aggregation/management surface; it should not become an undocumented second source of truth for Beluga resources. Ownership of configuration, credentials, cluster operations, and external APIs must remain explicit.

## 4. Documentation structure

Prioritize: current status -> runnable Quick Start -> first verified vertical slice -> implemented/planned matrix -> architecture -> domain details -> roadmap.

## 5. Maintenance rule

Whenever a planned domain becomes implemented, update the implementation matrix and add the smallest reproducible verification before promoting the claim in README or blog content.