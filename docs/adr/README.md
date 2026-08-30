# Architecture Decision Records (ADR)

English | [한국어](README-ko.md)

This directory records durable, cross-cutting architecture decisions made for the
Beluga project, per the
[OpenForge Decision Management Standard](https://github.com/dasomel/openforge/blob/main/docs/decision-management.md).
Day-to-day operational failures and their root causes belong in
[docs/mistakes-log.md](../mistakes-log.md), not here — ADRs record **why** a durable
choice was made; the mistakes log records **why something broke** and how it was fixed.

## Index

| ADR | Title | Status | Date |
|---|---|---|---|
| [ADR-0001](0001-vagrant-k3s-gitops-platform-architecture.md) | Vagrant + k3s + ArgoCD GitOps platform architecture | Accepted | 2026-08-09 |
| [ADR-0002](0002-bootstrap-time-random-credential-generation.md) | Bootstrap-time random credential generation | Accepted | 2026-08-10 |

## When to add an ADR

Per the standard, evaluate a new ADR when a change affects architecture or a layer
boundary, changes trust/access/secret/release boundaries, or deliberately chooses among
credible alternatives with meaningful trade-offs. Routine implementation work fully
determined by an already-accepted decision does not need a new ADR.
