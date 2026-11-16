# Colima VM-local recovery helpers

English | [한국어](README-ko.md)

## Scope and evidence

These are manual **VM-local** lab workarounds, **not applied by GitOps** or by a repository installer. The documentation worker has not run the commands below. The [2026-11-16 incident](../../research/incidents/2026-11-16-vm-clock-jump/README.md) distinguishes supplied measurements from inference. The script is an exact copy of [raw/14](../../research/incidents/2026-11-16-vm-clock-jump/raw/14-beluga-clock-guard.sh), preserving `D-CLOCK-1`. Service/timer and dnsmasq drop-in below are reconstructed installation instructions from the orchestrator's evidence/action summary; they are not byte-for-byte unit captures. Raw/11–12 show activation, raw/15 the test limits.

**Measured / inferred / unknown:** The later [vCPU-stall incident](../../research/incidents/2026-11-16-vm-vcpu-stall/README.md) records measured RCU/soft lockups and host pressure; memory causality is inferred and relation to the clock jump unknown. Host budget and kernel choice remain open.

**Owner-approved (2026-11-16):** Retain unattended reboot (`D-CLOCK-1`); apply HWE kernel `7.0.0-43-generic` (`D-CLOCK-2`, measured raw/25,27). Upstream v7.0 discards deltas above `max_delta` (verified raw/18, raw/18a). The counter remains `arch_sys_counter`, 56 bits at 24 MHz; guest binary internals were not inspected. The VM image/kernel is outside repository management. The retained 6.8 fallback lacks this mitigation. Recurrence prevention and the real-jump reboot path remain unproven; monitor `uptime` and system time versus RTC. See also [offline disk repair](../../docs/colima-single-node.md).

## Install the clock guard

The guard checks absolute system/RTC skew. Above 120 s it attempts a realtime reset; on failure it **reboots the VM unattended**, interrupting k3s and every workload on this node. It assumes a readable, correct RTC. If RTC reading fails it exits without action. A 30 s timer is not a guarantee of recovery within 30 s after a counter jump.

For the existing `beluga` profile, copy from the repository root on macOS, then enter the VM:

```sh
colima ssh --profile beluga -- sh -c 'cat > /tmp/beluga-clock-guard.sh' < scripts/colima/beluga-clock-guard.sh
colima ssh --profile beluga
```

Run inside the VM (requires sudo):

```sh
sudo install -m 0755 /tmp/beluga-clock-guard.sh /usr/local/sbin/beluga-clock-guard
sudo tee /etc/systemd/system/beluga-clock-guard.service >/dev/null <<'UNIT'
[Unit]
Description=Reset system clock from RTC after a guest counter jump (Beluga lab)

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/beluga-clock-guard
UNIT
sudo tee /etc/systemd/system/beluga-clock-guard.timer >/dev/null <<'UNIT'
[Unit]
Description=Check Beluga guest clock against RTC

[Timer]
OnBootSec=30
OnUnitActiveSec=30
AccuracySec=1

[Install]
WantedBy=timers.target
UNIT
sudo systemctl daemon-reload
sudo systemctl enable --now beluga-clock-guard.timer
sudo systemctl start beluga-clock-guard.service
sudo systemctl status beluga-clock-guard.timer --no-pager
sudo journalctl -u beluga-clock-guard.service -n 20 --no-pager
date -u
cat /sys/class/rtc/rtc0/since_epoch
```

Raw/12 and raw/15 show a realtime-only 2122 injection corrected within seconds, consistent with guestagent / guard operation; they do not isolate both actors. Only a forced-failure dry-run tested the reboot branch. **Inferred from settimeofday semantics, not measured (no monotonic readings in raw/12 or raw/15):** a userspace clock set does not reproduce the CLOCK_MONOTONIC jump, so recovery from a real counter jump is **unproven**. `GUARD_DRY_RUN=1` suppresses only reboot, not `date -s`; `GUARD_TEST_FORCE_FAIL=1` bypasses the date attempt. Do not set these on the normal service or treat them as a real-jump test.

Escape hatch, inside the VM:

```sh
sudo systemctl disable --now beluga-clock-guard.timer
```

This stops future timer activation; it cannot cancel a reboot already requested.

## dnsmasq bare-IP workaround

The orchestrator measured a two-address VM causing Colima to write a bare second IP line to `/etc/dnsmasq.d/01-colima.conf`; dnsmasq failed startup. Raw/11 records failed then active status, but not the malformed file. Inspect `sudo systemctl cat dnsmasq` and the config before installing: the helper path below is the original check used in this lab. Reset ExecStartPre, strip only lines consisting entirely of an IPv4-shaped address, then retain that check. Other distributions may have different pre-start steps; this reconstructed drop-in must match the VM's unit.

Run inside the VM:

```sh
sudo tee /usr/local/sbin/beluga-dnsmasq-strip >/dev/null <<'SCRIPT'
#!/bin/sh
sed -i -E "/^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$/d" /etc/dnsmasq.d/01-colima.conf
SCRIPT
sudo chmod 0755 /usr/local/sbin/beluga-dnsmasq-strip
sudo mkdir -p /etc/systemd/system/dnsmasq.service.d
sudo tee /etc/systemd/system/dnsmasq.service.d/10-beluga-strip.conf >/dev/null <<'UNIT'
[Service]
ExecStartPre=
ExecStartPre=/usr/local/sbin/beluga-dnsmasq-strip
ExecStartPre=/usr/share/dnsmasq/systemd-helper checkconfig
UNIT
sudo systemctl daemon-reload
sudo systemctl restart dnsmasq
sudo systemctl status dnsmasq --no-pager
sudo cat /etc/dnsmasq.d/01-colima.conf
```

The script runs before every dnsmasq start because Colima can regenerate the file. It does not remove `server=...` directives. Restarting DNS briefly interrupts resolution. To remove this workaround, delete `/etc/systemd/system/dnsmasq.service.d/10-beluga-strip.conf`, run `sudo systemctl daemon-reload`, and restore a valid config before restarting dnsmasq.

## Repository checks

`make lint` finds every `*.sh` under `scripts/`, `tests/`, `demo/`, and `csp/`; the new guard is included automatically. No CI checker registration is needed. The current doc-pair workflow (`.github/workflows/docs-check.yml`) enumerates root docs, architecture/development and ADRs; it does not require pairs in this directory. This README nevertheless includes a Korean pair for the operator procedure. Static shellcheck does not establish VM or reboot behavior.
