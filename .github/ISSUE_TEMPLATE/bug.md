---
name: Bug Report
about: Report a failure in cluster bootstrap, GitOps sync, or a deployed component
title: 'fix: '
labels: bug
---

### Problem Description
Clear description of the failure — what you expected vs. what actually happened.

### Environment
- Host RAM profile (32/48/64GB):
- Hypervisor (`VAGRANT_PROVIDER`):
- `vagrant status` output:
- Affected component(s):

### Steps to Reproduce
1. Run `...`
2. Observe `...`

### Evidence
<!-- kubectl/helm output, test script output, logs. Distinguish "renders/lints
     successfully" from "actually broke at runtime" per AGENTS.md. -->

### Have you checked `docs/mistakes-log.md`?
- [ ] Yes, this is not a known/documented failure class.
