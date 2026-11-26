#!/usr/bin/env bash
# Beluga Node Preparation Script

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
source "${SCRIPT_DIR}/../common/logging.sh"

log_info "Preparing node kernel and OS dependencies..."

# Disable swap
sudo swapoff -a || true
sudo sed -i '/swap/d' /etc/fstab || true

# Load kernel modules
cat <<EOF | sudo tee /etc/modules-load.d/k8s.conf
overlay
br_netfilter
EOF

sudo modprobe overlay || true
sudo modprobe br_netfilter || true

# Sysctl settings
cat <<EOF | sudo tee /etc/sysctl.d/k8s.conf
net.bridge.bridge-nf-call-iptables  = 1
net.bridge.bridge-nf-call-ip6tables = 1
net.ipv4.ip_forward                 = 1
fs.inotify.max_user_watches         = 524288
fs.inotify.max_user_instances       = 8192
EOF

sudo sysctl --system > /dev/null 2>&1 || true

# Ubuntu 26.04 apparmor ships kernel.apparmor_restrict_unprivileged_unconfined=1
# (/usr/lib/sysctl.d/10-apparmor.conf). runc writes `exec cri-containerd.apparmor.d`
# while still root, then drops to the container's capability set (no CAP_MAC_OVERRIDE)
# before execve — the kernel then converts the transition into a stack
# (`cri-containerd.apparmor.d//&unconfined`, audit: "change_profile unprivileged
# unconfined converted to stacking"). containerd's profile only allows signals to
# peer=cri-containerd.apparmor.d, so processes in the same container cannot signal
# each other (postgres: "could not signal for checkpoint: Permission denied").
# Reproduced on boxes 0.3.1 and 0.3.5 — not a box regression. Must be set before
# k3s/containerd starts any container; already-running containers keep the stacked label.
# Cost: unprivileged unconfined host processes may change_profile again (pre-26.04
# behavior). Containers stay confined by the intended profile; userns restriction is
# untouched. The 20- prefix overrides 10-apparmor.conf, as that file recommends.
AA_UNCONFINED_KEY=/proc/sys/kernel/apparmor_restrict_unprivileged_unconfined
if [ -e "${AA_UNCONFINED_KEY}" ]; then
  echo "kernel.apparmor_restrict_unprivileged_unconfined = 0" | sudo tee /etc/sysctl.d/20-apparmor.conf > /dev/null
  sudo sysctl -q -w kernel.apparmor_restrict_unprivileged_unconfined=0
  actual="$(cat "${AA_UNCONFINED_KEY}")"
  if [ "${actual}" != "0" ]; then
    log_error "kernel.apparmor_restrict_unprivileged_unconfined is ${actual}, expected 0 — containers would get stacked AppArmor labels and lose intra-container signals."
    exit 1
  fi
  log_info "AppArmor: restrict_unprivileged_unconfined=0 (verified)."
fi

log_success "Node preparation completed successfully."
