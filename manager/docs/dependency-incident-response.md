# Dependency Incident Response

Procedure for handling a compromised or yanked npm dependency in this repository: quarantine,
rollback, offline verification, and emergency bypass. Written for issue #47's remaining
supply-chain requirements.

## What already covers most of this

This is a small npm/TypeScript project with no container images or complex build, and existing
tooling already provides most of what a "trusted dependency set" and "reproducible verification"
require:

- **`package-lock.json` (committed) is the approved dependency/artifact set.** Every dependency's
  exact resolved version and `integrity` (SRI hash) is pinned there. Any tampering or substitution
  fails `npm ci` immediately.
- **`npm ci` (used in the `test` job of `.github/workflows/ci.yml`) is the reproducible
  verification mechanism.** It installs exactly what the lockfile specifies and refuses to
  proceed if `package.json` and `package-lock.json` disagree, so it cannot silently drift.
- **The `dependency-diff` CI job** (`actions/dependency-review-action` in `ci.yml`) reviews every
  direct/transitive change to `package-lock.json` on each PR.
- **The 14-day Dependabot cooldown** (`.github/dependabot.yml`, `cooldown.default-days: 14`)
  delays adoption of freshly published releases, the window in which supply-chain compromises
  (e.g. the 2026-08 Rust incident referenced in `dependabot.yml`) are typically injected.
- **Git history is the last-known-good snapshot store.** Because `package-lock.json` is committed
  and every push to `main` runs the `test` job, the last-known-good state is simply the lockfile
  from the most recent commit where CI was green.

What's genuinely missing is *process*: what to do the moment a dependency is flagged, not new
tooling.

## Quarantine procedure

When a dependency already in `package-lock.json` is flagged compromised or yanked:

1. **Identify the last green commit before the compromised version was introduced.**
   ```bash
   git log --oneline -- package-lock.json
   git show <commit>:package-lock.json | grep -A2 '"<package-name>"'
   ```
2. **Extract the last-known-good lock state** for that package from the identified commit
   (`git show <commit>:package-lock.json`), and confirm the corresponding CI run on that commit
   was green.
3. **Pin the package to the last-known-good version + integrity hash** to block reintroduction via
   any transitive path, using npm's `overrides` field in `package.json`:
   ```json
   {
     "overrides": {
       "<package-name>": "<last-known-good-version>"
     }
   }
   ```
   Then run `npm install` to regenerate the lockfile with the override applied, and verify the
   resulting `integrity` hash for `<package-name>` in `package-lock.json` matches the
   last-known-good commit's hash.
4. **Verify the fix**: `npm ci`, `npm test`, `npm audit`. Remove the `overrides` entry once
   upstream ships a patched release past the cooldown and the audit is clean.

## Rollback reproducibility

`git checkout <last-good-commit> -- package.json package-lock.json && npm ci` deterministically
reproduces the last-known-good dependency tree. Both files must be checked out together — `npm ci`
refuses to run if `package.json` and `package-lock.json` are out of sync.

Verified against this repository: checking out `package.json` + `package-lock.json` from commit
`bfbcdfe` (prior to the vitest 5.0.0 and later bumps) into a clean `node_modules` and running
`npm ci` completed successfully with `0 vulnerabilities`, reproducing that commit's exact
dependency tree.

## Offline verification

Once the local npm cache is warm (any prior `npm ci`/`npm install`), the dependency set can be
verified without network access:

```bash
npm ci            # warms the cache
rm -rf node_modules
npm ci --offline  # reinstalls entirely from cache, no network
```

Verified against this repository: `npm ci --offline` after a warm cache reinstalled all 47
packages successfully (`0 vulnerabilities`), confirming the committed lockfile is sufficient for
fully offline, reproducible dependency verification today.

## Emergency bypass

An urgent security patch may skip the 14-day Dependabot cooldown, but only under these
constraints:

- Must be a **human-reviewed PR**, never auto-merged — the cooldown exists specifically to slow
  down unreviewed adoption, so bypassing it raises (not lowers) the review bar.
- The PR description must **link the security advisory** (GHSA/CVE) that justifies the bypass.
- The change must be **revertible via the rollback procedure above** — confirm before merging that
  `git checkout <pre-patch-commit> -- package.json package-lock.json && npm ci` would restore the
  prior state if the patch itself turns out to be bad.

## Out of scope

Full air-gapped registry mirroring (e.g. a private npm proxy caching every package ever installed)
is not implemented and is not proportionate for a project this size — the committed lockfile plus
a warm local/CI npm cache already gives reproducible offline verification for the dependency set
this repo actually uses. If the platform ever needs to install dependencies with no prior cache and
no network at all, that would require a registry mirror and should be reassessed then.
