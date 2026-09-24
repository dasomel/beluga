#!/usr/bin/env bash
# Ensures workspace dependencies (tsx in particular) are installed before
# `npm run policyctl` invokes the policy-compiler CLI.
#
# `policyctl` is also invoked as a cross-repo tool: other repositories (e.g.
# dasomel/beluga's tests/14-policy-compiler-seam.sh) clone this repository as
# a sibling checkout and run `npm run policyctl` directly, without ever
# running `npm install`/`npm ci` here first. When that happens, `tsx` is
# unresolved and both the primary `npm run policyctl` invocation and the
# Node `--import tsx` fallback fail deep inside Node's ESM loader with a
# cryptic `Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'tsx'`
# (dasomel/openforge#54). Bootstrap deterministically from the committed
# lockfile instead of surfacing that error.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

if [[ ! -d "${REPO_ROOT}/node_modules/tsx" ]]; then
  (cd "${REPO_ROOT}" && npm ci)
fi
