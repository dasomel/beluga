#!/usr/bin/env bash
# Beluga Shell Logging Utilities

COLOR_RESET="\033[0m"
COLOR_INFO="\033[36m"
COLOR_SUCCESS="\033[32m"
COLOR_WARN="\033[33m"
COLOR_ERROR="\033[31m"

log_info() {
  echo -e "${COLOR_INFO}[INFO] [$(date +'%Y-%m-%dT%H:%M:%S%z')] $*${COLOR_RESET}"
}

log_success() {
  echo -e "${COLOR_SUCCESS}[OK] [$(date +'%Y-%m-%dT%H:%M:%S%z')] $*${COLOR_RESET}"
}

log_warn() {
  echo -e "${COLOR_WARN}[WARN] [$(date +'%Y-%m-%dT%H:%M:%S%z')] $*${COLOR_RESET}"
}

log_error() {
  echo -e "${COLOR_ERROR}[ERROR] [$(date +'%Y-%m-%dT%H:%M:%S%z')] $*${COLOR_RESET}" >&2
}
