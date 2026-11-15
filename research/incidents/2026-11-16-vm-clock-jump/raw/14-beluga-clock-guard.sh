#!/bin/sh
# VM-local guard (2026-11-16 incident, colima vz guest). The guest counter (arch_sys_counter,
# 56 bits at 24 MHz) can step so that the kernel adds one counter wrap (~95.14 years) to BOTH
# CLOCK_REALTIME and CLOCK_MONOTONIC. The RTC stays correct. After that, no userspace time set
# works: the kernel rejects a wall time earlier than the monotonic clock (settimeofday/clock_adjtime
# return EINVAL - measured for systemd-timesyncd and lima-guestagent). Only a reboot recovers.
# D-CLOCK-1: compare system clock with the RTC; try to reset it; if that fails, reboot.
# Cost: an unattended VM reboot (k3s restarts). Escape hatch: `systemctl disable --now beluga-clock-guard.timer`.
rtc=$(cat /sys/class/rtc/rtc0/since_epoch) || exit 0
now=$(date +%s)
d=$((now - rtc)); [ "$d" -lt 0 ] && d=$((0 - d))
[ "$d" -le 120 ] && exit 0
logger -t beluga-clock-guard -p daemon.crit "system clock off by ${d}s from RTC (sys=$now rtc=$rtc); resetting from RTC"
if [ -z "${GUARD_TEST_FORCE_FAIL:-}" ] && date -u -s "@$rtc" >/dev/null 2>&1; then
  logger -t beluga-clock-guard -p daemon.crit "system clock reset from RTC"
  exit 0
fi
up=$(cut -d. -f1 /proc/uptime)
logger -t beluga-clock-guard -p daemon.crit "cannot set the clock (kernel refuses a wall time below the monotonic clock; uptime=${up}s); rebooting"
[ -n "${GUARD_DRY_RUN:-}" ] && { echo "DRY-RUN: would reboot"; exit 0; }
sync
systemctl reboot
