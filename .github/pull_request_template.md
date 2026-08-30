## Summary
<!-- What changed and why -->

## Change type

- [ ] Documentation
- [ ] Cluster provisioning (Vagrantfile / scripts/cluster)
- [ ] GitOps / Helm charts (gitops/)
- [ ] Policy (policies/)
- [ ] CI/CD
- [ ] Security / supply chain
- [ ] Demo (demo/)

## Verification
<!-- Commands executed and their real output — distinguish static checks from live-cluster checks -->

- [ ] `make lint` (shellcheck + helm lint)
- [ ] `make validate` (static manifest/YAML validation)
- [ ] `make test` (live E2E — state which tests, or note "not run: no live cluster")
- [ ] For auth/gateway changes: verified both direct component access and the
      documented gateway entry point

## Change impact

- Version source of truth (`VERSIONS.md`) updated: <!-- yes/no/n-a -->
- GitOps ownership or ArgoCD sync-wave impact: <!-- describe or n/a -->
- Workflow/toolchain impact: <!-- describe or n/a -->

## Related Issues / ADRs
<!-- Link the issue, ADR, or OpenForge standard -->
