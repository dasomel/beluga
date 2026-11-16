# Colima VM 로컬 복구 도구

[English](README.md) | 한국어

## 범위와 증거

수동 **VM 로컬** 실습 환경 우회책이며 **GitOps나 저장소 설치기가 적용하지 않는다**. 문서 작업자는 아래 명령을 실행하지 않았다. [2026-11-16 사고 기록](../../research/incidents/2026-11-16-vm-clock-jump/README-ko.md)은 제공된 실측과 추론을 구분한다. 스크립트는 `D-CLOCK-1`을 보존한 [raw/14](../../research/incidents/2026-11-16-vm-clock-jump/raw/14-beluga-clock-guard.sh)의 동일 복사본이다. 아래 service/timer와 dnsmasq drop-in은 오케스트레이터 증거·작업 요약에서 재구성한 설치 절차이며 unit 원본 캡처가 아니다. Raw/11–12는 활성화, raw/15는 테스트 한계를 기록한다.

**실측 / 추론 / 미상:** 후속 [vCPU 정체 사고](../../research/incidents/2026-11-16-vm-vcpu-stall/README-ko.md)는 RCU/soft lockup·호스트 압박 실측을 기록한다. 메모리 인과는 추론, 시계 점프와의 관계는 미상이며 메모리 예산·커널 선택은 미결정이다.

**소유자 승인 (2026-11-16):** `D-CLOCK-1` 무인 재부팅 동작을 유지한다. `D-CLOCK-2`로 HWE 커널 `7.0.0-43-generic`을 적용했다(실측 raw/25·27). v7.0 소스는 `max_delta` 초과 델타를 버린다(업스트림 검증 raw/18·18a). 카운터는 여전히 `arch_sys_counter` 56비트·24 MHz이며 게스트 바이너리 내부는 검사하지 않았다. VM 이미지·커널은 저장소 관리 밖이다. 6.8 fallback은 남아 있지만 해당 완화책이 없다. 실제 점프 재발 방지와 재부팅 경로는 미검증이며 `uptime`·system/RTC 시각을 계속 확인한다. [오프라인 디스크 복구](../../docs/colima-single-node-ko.md)도 참고한다.

## 시계 가드 설치

가드는 system/RTC 절대 차이가 120초를 넘으면 realtime 설정을 시도하며 실패하면 **VM을 무인 재부팅**한다. k3s와 노드의 모든 워크로드가 중단된다. RTC가 정확하고 읽을 수 있다고 가정하며 읽기 실패 시 조치 없이 종료한다. 30초 timer는 카운터 점프 후 30초 안의 복구 보장이 아니다.

기존 `beluga` 프로파일에서 macOS 저장소 루트로부터 복사 후 VM에 진입한다.

```sh
colima ssh --profile beluga -- sh -c 'cat > /tmp/beluga-clock-guard.sh' < scripts/colima/beluga-clock-guard.sh
colima ssh --profile beluga
```

VM 안에서 실행한다(sudo 필요).

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

Raw/12·15는 realtime만 2122년으로 주입한 뒤 수초 내 정상화를 보여 주며 guestagent / 가드 동작과 부합한다. 두 동작 주체를 모두 분리 검증한 것은 아니다. 재부팅 분기는 강제 실패 dry-run만 실행했다. **settimeofday 동작에 근거한 추론이며 실측 아님(raw/12·15에 monotonic 측정값 없음):** 사용자 공간 시각 설정은 CLOCK_MONOTONIC 점프를 재현하지 않으므로 실제 카운터 점프 복구는 **미검증**이다. `GUARD_DRY_RUN=1`은 재부팅만 막으며 `date -s`는 막지 않는다. `GUARD_TEST_FORCE_FAIL=1`은 date 시도를 건너뛴다. 정상 service에 이 변수를 설정하거나 실제 점프 검증으로 해석하지 않는다.

VM 내부 중지 방법:

```sh
sudo systemctl disable --now beluga-clock-guard.timer
```

향후 timer 활성화를 중지하며 이미 요청된 재부팅을 취소하지는 않는다.

## dnsmasq 단독 IP 줄 우회책

오케스트레이터는 주소 2개인 VM에서 Colima가 `/etc/dnsmasq.d/01-colima.conf`에 단독 두 번째 IP 줄을 써 dnsmasq 기동에 실패한 것을 측정했다. Raw/11은 실패 후 active를 기록하지만 잘못된 파일 내용은 없다. 설치 전 `sudo systemctl cat dnsmasq`와 설정을 확인한다. 아래 helper는 이 실습 환경의 원래 검사 경로다. ExecStartPre 목록을 초기화하고 IPv4 모양 주소만 있는 줄을 지운 다음 원래 검사를 유지한다. 배포판별로 다른 pre-start 단계가 있을 수 있어 실제 VM unit과 재구성한 drop-in이 맞아야 한다.

VM 내부에서 실행한다.

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

Colima가 파일을 재생성할 수 있어 매 dnsmasq 기동 전에 실행한다. `server=...` 지시문은 지우지 않는다. DNS 재시작 중 잠시 이름 해석이 중단된다. 제거하려면 `/etc/systemd/system/dnsmasq.service.d/10-beluga-strip.conf`를 삭제하고 `sudo systemctl daemon-reload` 후 정상 설정을 복원한 다음 dnsmasq를 재시작한다.

## 저장소 검사

`make lint`는 `scripts/`, `tests/`, `demo/`, `csp/`의 모든 `*.sh`를 찾으므로 새 가드가 자동 포함된다. 새 CI 검사기 등록은 필요 없다. 현재 문서 쌍 워크플로(`.github/workflows/docs-check.yml`)는 루트 문서·architecture/development·ADR을 열거하며 이 디렉터리에 쌍을 강제하지 않는다. 운영 절차에는 한글 쌍을 함께 제공했다. 정적 shellcheck는 VM·재부팅 동작을 증명하지 않는다.
