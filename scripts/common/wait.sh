#!/usr/bin/env bash
# D-WAIT-1: bootstrap readiness waits fail closed ("Never fabricate state").
# `kubectl wait ... || true` let `make up` exit 0 after the Keycloak LDAP federation,
# group-mapper and shop-seed Jobs had all timed out. These helpers return non-zero on a
# timeout or a Failed Job and log what failed, where, and the command to inspect it;
# the caller decides whether to stop now or record the failure and exit non-zero later.
# Cost: an honest timeout now fails `make up` instead of being logged and forgotten.
# Escape hatch: a wait that is genuinely best-effort keeps `|| true` with a
# `# wait-best-effort: <reason>` comment on the line above (tests/test_bootstrap_waits.py).
#
# Requires logging.sh to be sourced first.

# wait_job_complete <namespace> <job> <timeout-seconds>
# Polls the Job's True conditions. `kubectl wait --for=condition=complete` is not used
# because a Job that hits backoffLimit is Failed, never Complete, so it would sit out the
# whole timeout and then report only "timed out".
wait_job_complete() {
  local ns="$1" job="$2" timeout="$3"
  local interval="${BELUGA_WAIT_POLL_INTERVAL:-5}"
  local deadline=$((SECONDS + timeout))
  local out="" last_err=""
  log_info "Waiting up to ${timeout}s for Job ${ns}/${job} to complete..."
  while :; do
    if out="$(kubectl --request-timeout=10s -n "${ns}" get job "${job}" \
        -o jsonpath='{range .status.conditions[?(@.status=="True")]}{.type}{" "}{end}' 2>&1)"; then
      last_err=""
      case " ${out} " in
        *" Complete "*)
          log_success "Job ${ns}/${job} completed."
          return 0
          ;;
        *" Failed "*)
          log_error "Job ${ns}/${job} failed (condition Failed, backoffLimit exhausted or deadline exceeded)."
          _wait_job_hint "${ns}" "${job}"
          return 1
          ;;
      esac
    else
      last_err="${out}"
    fi
    if (( SECONDS >= deadline )); then
      log_error "Job ${ns}/${job} did not complete within ${timeout}s."
      if [[ -n "${last_err}" ]]; then
        log_error "  last kubectl error: ${last_err}"
      fi
      _wait_job_hint "${ns}" "${job}"
      return 1
    fi
    sleep "${interval}"
  done
}

_wait_job_hint() {
  log_error "  inspect: kubectl -n $1 logs job/$2 ; kubectl -n $1 describe job/$2"
}

# wait_rollout <namespace> <kind/name> <timeout-seconds>
wait_rollout() {
  local ns="$1" target="$2" timeout="$3"
  if kubectl rollout status "${target}" -n "${ns}" --timeout="${timeout}s"; then
    return 0
  fi
  log_error "${target} in namespace ${ns} did not become ready within ${timeout}s."
  log_error "  inspect: kubectl -n ${ns} describe ${target} ; kubectl -n ${ns} get pods"
  return 1
}
