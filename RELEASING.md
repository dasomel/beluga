# Releasing

English | [한국어](RELEASING-ko.md)

Beluga has not cut a tagged release yet — this document defines the procedure for when
it does.

## Versioning

Beluga itself does not ship a versioned artifact (it is IaC that pulls upstream
component images at deploy time). When a release is cut, tag the repository state with
Semantic Versioning (`vMAJOR.MINOR.PATCH`) describing the platform definition, not any
single component.

Component/image versions are tracked independently in [VERSIONS.md](VERSIONS.md), which
remains the single source of truth regardless of repository tags.

## Release procedure

1. Ensure `main` is green: `make lint` and `make validate` pass in CI
   ([.github/workflows/ci.yml](.github/workflows/ci.yml)).
2. Confirm `VERSIONS.md` reflects the actual deployed images (no drift between declared
   and `values.yaml`-referenced images).
3. Update [CHANGELOG.md](CHANGELOG.md) and [CHANGELOG-ko.md](CHANGELOG-ko.md), moving
   `[Unreleased]` entries under the new version heading.
4. Tag the commit: `git tag -a vX.Y.Z -m "vX.Y.Z"` and push the tag.
5. If the release changes deployed component versions, re-run
   `bash scripts/generate-sbom.sh` against a live cluster and archive the output
   alongside the release notes (see [NOTICE](NOTICE) for the SBOM process).

## Rollback

Because Beluga deploys nothing but declarative manifests pulled at apply time, rollback
is `git revert` on the offending commit followed by an ArgoCD sync — there is no
separate binary artifact to roll back. Cluster-side rollback specifics (PVC data loss
risk on `StatefulSet` recreation, ArgoCD `selfHeal` interaction) are documented per
incident in [docs/mistakes-log.md](docs/mistakes-log.md).
