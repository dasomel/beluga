# Contributing to Beluga Manager

Thank you for contributing to Beluga Manager.

Beluga Manager is an open-source project for building a unified control plane for the Beluga Data Platform.

## Development Principles

- Keep user-facing documentation in separate English and Korean files.
- Use `<name>.md` for English and `<name>-ko.md` for Korean.
- Prefer integration through authoritative OSS APIs instead of reimplementing specialist UIs.
- Keep Beluga Domain APIs locale-neutral.
- Do not translate actual resource names such as topics, tables, jobs, or namespaces.
- Keep changes small and testable.
- Document architectural decisions as ADRs when they affect project boundaries.

## Pull Requests

1. Explain the problem and proposed solution.
2. Link the relevant issue.
3. Include tests or explain why tests are not applicable.
4. Update documentation for user-visible or architectural changes.
5. Keep English and Korean documentation semantically synchronized.

See [CONTRIBUTING-ko.md](CONTRIBUTING-ko.md) for the Korean version.
