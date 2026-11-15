# 사고 보고서: VM 시계 점프·Kafka 쓰기 폭증와 부팅 정지

[English](README.md) | 한국어

## 요약

**실측(measured):** Colima 실습 VM은 `2122-01-07T00:27:01Z`, 호스트는 `2026-11-15T15:15:26Z`, RTC는 `2026-11-15 15:15:27`이었다. uptime은 24,855일이었다([raw/01](raw/01-clock-state.txt)). `kafka.Kafka -Xmx1024m` 프로세스 3개의 누적 `write_bytes`는 각각 101,266,726,912 / 101,297,623,040 / 101,883,527,168 바이트였다. stdout에는 `CertificateExpiredException: NotAfter: Thu Nov 04 14:26:33 GMT 2027`, SSL handshake 실패와 KRaft FETCH `NETWORK_EXCEPTION`이 반복됐다([raw/07](raw/07-kafka-write-and-log-sample.txt)).

**추론(inferred):** 미래 시각 때문에 인증서가 만료된 것으로 판단됐으며, TLS 실패·KRaft 재시도는 선출 폭풍과 부합한다(consistent with). 컨테이너 stdout은 측정 쓰기의 일부만 설명하며 나머지 쓰기 대상은 측정하지 않았다. 시계 오프셋은 56비트 카운터의 거의 한 바퀴에 해당하는 델타와 부합한다. 점프 당시 카운터 값은 수집하지 않아 역행 자체와 촉발 조건은 확인되지 않았다. 이 문서는 실측·업스트림 검증·추론을 구분하며 작성 중 클러스터·네트워크에는 접근하지 않았다.

**두 번째 근본 원인 — 실측:** 00:42 부팅에서 루트 fsck가 실패하고 systemd가 emergency shell을 시작했다([raw/20](raw/20-failed-boot-journal.txt)). SSH 포트 22는 대기 내내 연결을 거부했다([raw/24](raw/24-hung-boot-network-probe.txt)). emergency shell이 SSH 불가의 원인이라는 설명은 **추론**이며 sshd 상태를 관측한 것은 아니다. 두 디스크를 오프라인 복구한 뒤 HWE 커널 `7.0.0-43-generic`으로 부팅했다. **소유자 결정, 2026-11-16:** 커널 완화책 적용과 가드 무인 재부팅 유지를 모두 승인했다. 재발 방지 효과와 실제 점프 재부팅 경로는 아직 입증되지 않았다.

## 환경과 영향

**점프 당시 실측:** 게스트 커널 `6.8.0-117-generic`, clocksource `arch_sys_counter`([raw/01](raw/01-clock-state.txt)); 마스크 56비트, 타이머 24 MHz([raw/05](raw/05-kernel-at-jump.txt), [raw/06](raw/06-counter-and-rtc.txt)). 호스트는 Apple M4 Pro, macOS 27.2.1 build 26B131, Lima 2.3.0, Colima 0.10.3이다. 11월 14·15일 호스트 전원 로그 요약에는 Sleep/Wake/DarkWake가 없었다([raw/04](raw/04-host-power-summary.txt)). 호스트 재부팅은 2026-11-13 01:52·2026-11-15 11:02 KST로 기록됐다. 11월 14일 18:35·15일 15:49 KST의 점프는 호스트 재부팅에 인접하지 않았다. 촉발 조건은 미상이다.

**실측 — 오케스트레이터 제공 요약, raw 일부 누락:** 30초 표본에서 각 브로커의 `/proc/<pid>/io` `write_bytes`가 약 3.4 MB/s 증가했다. Raw/07의 누적 카운터는 브로커당 약 101–102 GB(94.3–94.9 GiB)다. 별도로 stdout은 브로커당 약 10 MB가 60–70초마다 회전했다(≈0.15 MB/s). 이는 측정 쓰기의 작은 일부만 설명한다. Kafka 데이터 디렉터리는 25 MB로 증가하지 않았고 KRaft 메타데이터 로그도 진전이 없었으며 `quorum-state`·`*-checkpoint` 파일의 mtime은 현재 시각이었다. 재시작 전 나머지 약 3 MB/s의 쓰기 대상은 측정하지 않았다. **추론 / 미측정 후보:** 선출 폭풍 중 작은 상태 파일의 반복 덮어쓰기. stdout은 57k lines/min, VOTE/FETCH `NETWORK_EXCEPTION`, 루트 사용률은 39%, 데이터 디스크는 56%였다. Raw/07은 누적 카운터·회전 stdout 크기/시각·인증서/FETCH 오류를 뒷받침하나 속도 표본·데이터 크기/진전·상태 파일 mtime·VOTE 발췌·복구 전 df는 보존하지 않아 제공받은 측정 요약으로 남긴다. **실측:** 시각 보정 후 폭풍이 멈추고 브로커 쓰기는 약 9 KB/s로 내려갔다(raw/17·28).

**실측 / 추론:** 오케스트레이터는 11월 14·15일 다수 파드의 약 100–200회 재시작과 k3s의 `current time 2122-01-06` 인증서 오류를 보고했다. raw/16의 삭제 파드 목록에는 최대 111회 재시작이 있고 raw/02에는 잘린 k3s CA 검증 오류가 있다. raw/08은 유효한 파드 상태 캡처가 아니다. 이전 재시작을 같은 시계 메커니즘으로 설명하는 것은 증상과 부합하는 **추론**이며 파드별 인과는 입증하지 않았다.

## 타임라인 (KST, UTC+09:00)

**실측:** 아래는 기록된 시각이며 정확한 점프 순간은 아니다. journal은 파일 잘림과 메시지 누락을 경고한다. 미래 시각을 경과시간 측정에 사용할 수 없다([raw/02](raw/02-journal-year-transitions.txt), raw/05).

| KST / 캡처에 있는 UTC | 관측 | 출처 |
|---|---|---|
| 2026-11-13 22:03:06 KST | 첫 연도 전이 이전 부팅 | raw/02 |
| 2026-11-14 18:35:24 KST → 2122-01-06 05:45:51 KST | 마지막 정상 항목 → journald 재시작 후 첫 미래 항목 | raw/02 |
| 2026-11-15 11:50:48 KST | 두 번째 전이 이전 부팅 | raw/02 |
| 2026-11-15 15:49:02 KST → 2122-01-07 01:02:08 KST | 마지막 정상 항목 → 첫 미래 항목, 커널 메시지 누락 | raw/02, raw/05 |
| 2026-11-16 00:15:26 KST / 2026-11-15 15:15:26Z | 호스트·VM·RTC 불일치 캡처 | raw/01 |
| 2026-11-16 00:18:13 KST / 2026-11-15 15:18:13Z | 복구 시작, 00:18:28 KST에 Colima 정지 완료 | [raw/11](raw/11-recovery.log) |
| 2026-11-16 00:21:06 KST / 2026-11-15 15:21:06Z | VM/RTC 시각 정상, synchronized=yes | raw/11 |
| 2026-11-16 00:21:29–30 KST / 2026-11-15 15:21:29–30Z | realtime 주입 후 1초 만에 정상 시각 | [raw/12](raw/12-clock-guard-injection-test.txt) |
| 2026-11-16 00:23:28 KST / 2026-11-15 15:23:28Z | 두 번째 realtime 주입 후 12초 만에 정상 시각 | [raw/15](raw/15-clock-guard-test.txt) |
| 2026-11-16 00:31:38 KST / 2026-11-15 15:31:38Z; 검사 00:32:10 KST까지 | 호스트/VM 일치, 아래 워크로드 검증 | [raw/17](raw/17-post-recovery.txt) |
| 2026-11-16 00:42 / 00:52 KST | 기동 시작 시각. 각각 약 10분(599초) 대기 후 약 00:52 / 01:02에 exit 1(정확한 종료 시각 미보존). journal은 00:42:29 부팅, 프로브는 두 번째 대기 중/직후인 01:03 | [raw/19](raw/19-kernel-upgrade.log), [raw/20](raw/20-failed-boot-journal.txt), [raw/24](raw/24-hung-boot-network-probe.txt) |
| 2026-11-16 01:04–01:07 KST (운영자 제공 구간; raw에는 복구 시각 없음) | rescue VM에서 루트·데이터 디스크 fsck 복구, 재검사 정상 | [raw/21](raw/21-root-fsck.txt), [raw/22](raw/22-data-fsck-check.txt), [raw/23](raw/23-data-fsck.txt) |
| 2026-11-16 01:10 KST | fsck 후 기동 exit 0 | raw/24 |
| 2026-11-16 01:11–01:14 KST (운영자 제공 구간); 01:13 기동 exit 0; 스냅샷 01:13:55 KST / 16:13:55Z | 커널 설치·재부팅 후 `7.0.0-43-generic` 실행 | [raw/25](raw/25-kernel-install.txt), [raw/27](raw/27-kernel7-boot.txt), raw/24 |
| 2026-11-16 01:15:52 KST / 2026-11-15 16:15:52Z | 커널 7 검증 스냅샷; 운영자는 검사 구간을 01:16으로 표기, 개별 검사는 시각 없음 | [raw/28](raw/28-post-kernel7-verification.txt) |

**후속 설정·시각 검사 실측:** raw/29는 2026-11-15T16:31:37Z(01:31:37 KST)에 uptime 19분, system/RTC epoch 1794760297/1794760298(차이 1초)을 기록한다. 이 짧은 관측은 재발 방지를 입증하지 않는다.

## 메커니즘과 자동 복구 실패 이유

**실측 / 산술:** `2^56 / 24e6 = 3,002,399,751.58 s`, 약 95.142년이다. system−RTC는 3,002,433,095초로 한 바퀴보다 33,343초, 약 11 ppm 크다([raw/06](raw/06-counter-and-rtc.txt), [raw/09](raw/09-wrap-arithmetic.txt)). **추론:** clocksource 배율 반올림 / NTP 주파수 보정과 부합하나 각 기여를 분리 측정하지 않았다.

**업스트림 검증(verified upstream), [raw/18](raw/18-upstream-verification.txt)과 명령 키 [raw/18a](raw/18a-upstream-verification-key.md) 근거:** v6.8 `clocksource_delta`는 `CONFIG_CLOCKSOURCE_VALIDATE_LAST_CYCLE`이 없으면 음의 이동 가드 없이 `(now - last) & mask`를 계산한다. [raw/29](raw/29-guest-kernel-config-check.txt)는 `/boot/config-6.8.0-117-generic`과 `/boot/config-7.0.0-43-generic` 모두 count 0을 기록한다. v7.0 소스 블록의 가드는 더 이상 이 옵션에 의존하지 않는다. 어느 아키텍처가 옵션을 선택하는지는 미검증이다. 다음 값이 조금 작으면 거의 한 바퀴의 양의 델타로 해석될 수 있다. **추론:** 미래 wall clock과 큰 uptime은 이 메커니즘과 부합한다. 카운터 역행은 직접 관측하지 않았고 vz 카운터가 왜 역행하는지는 모른다.

**실측:** timesyncd는 대체로 약 32초 간격으로 `Failed to call clock_adjtime(): Invalid argument`를 남겼다([raw/03](raw/03-timesyncd-journal.txt)). NTP 오프셋은 `-95y 1month 3w`였다(raw/01). Lima guestagent는 10초 간격으로 `SyncTime: failed to set system time` / `invalid argument`를 남겼고 부팅 로그 쿼리에 5,923개 일치 항목이 있었다([raw/13](raw/13-lima-guestagent.txt)).

**업스트림 검증:** v6.8 `kernel/time/timekeeping.c` 1328–1333행의 settimeofday 경로는 `timespec64_compare(&tk->wall_to_monotonic, &ts_delta) > 0`이면 `-EINVAL`을 반환한다(raw/18·18a 블록 3; 바깥 함수명은 캡처되지 않았다). **추론:** uptime과 부합하는 monotonic 시계 점프 때문에 2026년으로 설정하려는 wall time이 CLOCK_MONOTONIC보다 앞서게 되어 거부된 것으로 설명된다. 동기화 반복으로는 그 상태를 복구하지 못하며 재부팅으로 초기화한다. stop/start 복구는 아래 실측이지만 직접 카운터 추적은 없다.

**업스트림 검증(raw/18, raw/18a):** [Lima #5665](https://github.com/lima-vm/lima/issues/5665)는 2026-10-22 생성, 캡처 당시 open이며 vz 게스트 +95년 점프와 재시작 전까지 sync EINVAL을 보고한다. [#5543](https://github.com/lima-vm/lima/issues/5543)는 호스트 부하 시 guestagent의 wall clock 역방향 보정을 보고하고 [PR #4527](https://github.com/lima-vm/lima/pull/4527)은 호스트→게스트 동기화를 추가했다. 로컬 카운터 촉발 조건의 증명은 아니다. Linux `c163e40af9b2`(2024-10-31, “timekeeping: Always check for negative motion”), `76031d9536a0`(2024-12-03, “clocksource: Make negative motion detection more robust”)는 음의 이동을 다룬다. v6.13 소스(raw/18a 블록 5)에는 delta가 `max_delta`를 넘으면 0을 반환하는 가드가 있다. v7.0에도 같은 가드가 있다(raw/18, raw/18a). 적용한 게스트 커널과 검증 한계는 아래에 기록한다. [raw/10](raw/10-research-lane-unverified.md)의 아키텍처별 Kconfig 선택 주장 등 미확인 내용은 채택하지 않았다.

## 실제 복구와 결과

**실측:** 오케스트레이터가 2026-11-16 00:18–00:32 KST에 Colima stop/start를 수행했다. Raw/11은 정지·기동 확인·dnsmasq 실패 후 active·가드 timer 활성화·정상 시각을 기록한다. Raw/16에는 삭제 파드 11개가 있다. Raw/17에는 호스트/VM 일치, Kafka PID 4개의 쓰기 9 / 9 / 10 / 0 KB/s, Flink 잡 3개 RUNNING, `tests/02-ingest-cdc`, `tests/03-stream-iceberg`, `tests/29-cdc-slot-wal-retention` exit 0이 있다. 복구 후 루트 사용률은 37%, 데이터 디스크는 56%다. 문서 작업자가 재실행한 검사가 아닌 제공된 라이브 캡처다.

**실측 — 오케스트레이터 제공 작업/결과 요약:** 주소가 2개인 VM에서 Colima가 `/etc/dnsmasq.d/01-colima.conf`에 단독 두 번째 IP 줄을 써 dnsmasq 기동이 실패했다. VM 로컬 ExecStartPre strip 스크립트로 복구했다. `CreateContainerError` / `failed to reserve container name` 파드 11개를 삭제했다. 11월 15일 관측에서는 k3s 재시작이 도움이 되지 않았다. ArgoCD Application 3개는 Synced/Healthy, Kafka CR은 Ready였다. Raw/11·16은 복구 개요를 뒷받침하나 잘못된 파일 내용·에러 상세·실패한 k3s 재시작·ArgoCD/Kafka 상태 출력은 보존하지 않는다. 재구성한 unit과 dnsmasq drop-in은 [설치 기록](../../../scripts/colima/README-ko.md)을 참고한다.

## 두 번째 근본 원인: 파일시스템 오류로 부팅 중단

**실측:** `colima start`는 약 00:42·00:52 KST에 시작해 각각 약 10분(raw/24: timeout=599초) 대기 후 약 00:52·01:02에 exit 1로 종료됐다. 정확한 종료 시각은 미보존이다. Raw/24 프로브는 두 번째 대기 중/직후인 01:03으로 표기됐다. Raw/24에는 `192.168.5.1:22`·`.3:22` connection refused가 있다. **실측 — 오케스트레이터 요약:** 두 번 모두 10분 후 “did not receive an event with the running status”, 하이퍼바이저는 running, serial log는 비어 있었다. 2026-11-13 05:06·05:22 KST에도 같은 증상을 “cause unknown”으로 기록했다. Raw/02의 부분 커널 기록에는 두 부팅 약 5.5분 뒤 EXT4 오류 리마인더가 있지만 fsck/emergency shell journal은 없다. 00:52 부팅 journal도 미보존이다. 00:52와 11월 13일 두 실패를 같은 원인에 귀속하는 것은 같은 증상에 근거한 **추론**이다.

**실측:** 실패 journal은 `cloudimg-rootfs contains a file system with errors, check forced`, 손상된 orphan linked list inode, `UNEXPECTED INCONSISTENCY; RUN fsck MANUALLY`, fsck exit status 4, `systemd-fsck-root.service` 실패 후 `Started emergency.service - Emergency Shell`을 기록한다(raw/20). 이는 00:42 부팅만의 기록이며 sshd 행은 없다. **추론:** emergency shell이 SSH 불가를 설명한다. Raw/05에는 기존 vda1/vdb1 EXT4 오류가 있고 raw/20은 루트 error count 1, initial error epoch `1793839819`(epoch 환산: 2026-11-05 00:50:19 UTC)를 기록한다. **실측 — 오케스트레이터 요약:** 이전 부팅의 데이터 디스크 error count는 7이었다. **추론:** 강제 검사 여부는 각 부팅의 파일시스템 오류·마운트 상태와 부합하며, 손상은 과거 비정상 정지(호스트 전원 손실 / 강제 정지)와 부합한다. 손상을 만든 사건과 이전 부팅별 검사 판단은 추적하지 않았다.

**실측 — 오케스트레이터 작업 요약, 결과 raw/21–23:** 두 디스크를 APFS clone하고 임시 Lima rescue VM에 포맷 없이 연결해 unmount 후 `e2fsck -fy`로 복구했다. 루트 orphan list·bitmap·count 오류를 고친 뒤 재검사 exit 0(raw/21). k3s 상태·containerd·local-path PV가 있는 데이터 디스크의 읽기 전용 검사에는 block/inode bitmap 차이와 “Filesystem still has errors”가 있었지만 기록된 check rc는 0이었다(raw/22). 복구에서는 “deleted inode has zero dtime” 2개도 고쳤으며 재검사 exit 0(raw/23). Raw/22의 rc만으로 정상 판정하지 않는다. 복구 clone을 교체 투입하고 원본은 호스트 Colima 인스턴스 디렉터리에 `disk.bak-pre-fsck-20261116`, `datadisk.bak-pre-fsck-20261116`, `disk.bak-pre-hwe-kernel-20261116`으로 보관했다(마지막 이름은 raw/19, 교체·나머지 이름은 운영자 요약). 복구 후 첫 기동 exit 0(raw/24). 운영자는 dmesg EXT4 오류가 없었다고 보고했으며 raw/27 마지막의 `0`은 질의문이 없어 그 검사 범위를 독립 확인할 수 없다.

## 적용한 커널 예방책과 소유자 결정

**소유자 승인, 2026-11-16:** `D-CLOCK-2`는 음의 이동 가드가 있는 커널로 전환하며, `D-CLOCK-1`은 시각 설정 실패 시 무인 재부팅을 유지한다. 비용은 게스트 커널 전환과 재부팅 시 노드 전체 중단이다. 되돌릴 방법은 남겨 둔 `6.8.0-117-generic`(이 완화책 없음)으로 부팅하거나 설치 기록대로 가드 timer를 끄는 것이다. 저장소 관리 컴포넌트 버전은 바꾸지 않았다.

**실측:** `linux-virtual-hwe-24.04` 설치로 `7.0.0-43-generic`을 선택했으며 6.8도 남아 있다(raw/25). 부팅 캡처는 7.0과 기존 그대로인 `arch_sys_counter` 56비트·24 MHz를 확인한다(raw/27). 카운터 자체는 바뀌지 않았다. **업스트림 검증:** v7.0 `clocksource_delta`는 마스크 적용 델타가 `max_delta`보다 크면 적용 대신 0을 반환한다(raw/18, raw/18a). 게스트 바이너리는 버전 외에 검사하지 않았다. **추론:** 관측 점프와 부합하는 메커니즘을 다루지만 면역을 입증하지는 않는다.

**실측:** Raw/28은 ArgoCD Application 3개 Synced/Healthy, Kafka Ready, 단독 `OK` 행(오케스트레이터에 따르면 Cilium DaemonSet 파드의 `cilium status --brief` 출력이며 명령행 미보존), `tests/01`·`02`·`03`·`29` exit 0, `tests/31` PASS(3 groups/14 healthy evaluated rules; Watchdog 전달), 브로커 쓰기 9/9/9 KB/s(네 번째 표본 PID 0)를 기록한다. **실측 — 오케스트레이터 요약:** 7.0 노드 Ready, 수동 파드 삭제 없이 모두 Running/Completed, `tests/01`은 `EXPECTED_NODES=1`로 실행했다. Raw/28에는 노드·파드 목록과 이 환경 변수는 없다. 문서 작업자가 재실행한 검사가 아닌 제공된 라이브 관측이다.

## 완화책과 한계

**실측:** 설치된 VM 로컬 가드 [raw/14](raw/14-beluga-clock-guard.sh)를 [scripts/colima/beluga-clock-guard.sh](../../../scripts/colima/beluga-clock-guard.sh)에 복사했다. Raw/11–12에 활성 timer가 있다. 30초 timer는 system/RTC 절대 차이가 120초를 넘으면 `date -s @rtc`를 시도하고, 실패하면 기록 후 **무인 VM 재부팅**한다(`D-CLOCK-1`). GitOps 바깥의 VM 로컬 설정이다. RTC가 정확하고 읽을 수 있으며 timer가 동작한다고 가정한다. 카운터 결함 예방이나 복구 지연 보장은 아니다.

**실측:** Raw/12·15에서 realtime만 2122년으로 주입한 뒤 수초 안에 정상화됐다. Lima guestagent SyncTime / 가드 동작과 부합하며 raw/15는 12초 후 보정을 SyncTime으로 기록한다. Raw/12로는 어느 쪽이 보정했는지 분리할 수 없다. “설정 실패 → 재부팅”은 강제 실패를 사용한 **dry-run만** 검증했다. **settimeofday 동작에 근거한 추론:** 사용자 공간 주입은 CLOCK_MONOTONIC을 점프시키지 않았다. Raw/12·15에는 monotonic 측정값이 없다. **추론 / 미검증:** 실제 카운터 점프 후 자동 재부팅과 워크로드 복구는 입증되지 않았다. 복사 스크립트 머리말의 메커니즘 설명은 진단을 기술하며 카운터 직접 캡처가 아니다.

## 미해결 질문과 후속 과제

- **추론 / 미상:** vz 카운터 역행 촉발 조건. Sleep/Wake 부재가 다른 원인을 확정하지 않는다.
- **추론 / 미검증:** 실제 점프 후 timer·무인 재부팅 복구, 저장된 미래 타임스탬프의 영향.
- **실측 — 오케스트레이터 보고 공백:** 이 사고를 위한 clock skew·컨테이너 로그 폭증 경보가 없다. 해당 신호의 알림 전달 검증도 캡처하지 않았다(raw/28은 Watchdog 전달 검사).
- **추론 / 미검증:** 의도적으로 카운터 역행을 재현할 방법이 없어 7.0 재발 가능성을 배제하지 못한다. 시간 경과에 따라 `uptime`과 system clock/RTC 차이를 확인한다.
- **후속 과제:** 실습 환경이 안정적으로 동작한 뒤 보관 디스크 백업을 삭제한다. 현재는 복원·조사를 위해 유지한다.

## 다음 발생 시 식별 체크리스트

실측 raw/01·03·06·07에서 도출한 진단 절차다.

1. `date -u` / `date +%s`를 `cat /sys/class/rtc/rtc0/since_epoch` 및 신뢰하는 호스트 시각과 비교한다.
2. 최근 부팅한 VM의 `uptime`이 약 24,855일인지 본다.
3. `journalctl -u systemd-timesyncd`의 `clock_adjtime(): Invalid argument`와 guestagent SyncTime 오류를 확인한다.
4. Kafka/JVM 튜닝 전에 데이터 파일과 컨테이너 stdout 중 어디에 바이트가 쌓이는지 확인한다. 미래 시각·인증서 만료 재시도 폭증은 이 사고와 부합한다.
5. 하이퍼바이저는 running인데 `colima start`가 시간 초과하고 SSH를 거부하면 루트 fsck / emergency shell을 의심한다. 재시도·대기 전에 디스크에서 실패 부팅 journal을 읽고 clone·rescue VM으로 오프라인 복구한다(raw/20–24; [절차](../../../docs/colima-single-node-ko.md)).

## 증거 한계

**실측 범위:** 부분 캡처이며 journal 잘림·미래 시각·위에서 구분한 운영 요약의 원본 누락이 있다. 증거 레코드 revision은 문서 작성 기준선이며 배포 SHA 검증이 아니다. 정확한 장애 지속시간·손실 건수·전체 서비스 중단 구간·직접 카운터 원인·실제 점프 후 재부팅 성공은 입증하지 않았다. 저장소 정적 검사는 라이브 복구를 증명하지 않는다.

**실측 — 문서 검사:** 오프라인 게이트 명령·종료 코드·출력 발췌는 [verification.txt](verification.txt)에 보존했다. 라이브 VM 동작을 증명하지 않는다.

**실측 파일 목록:** `raw/`의 증거 파일은 29개(01–25·27–29·18a)이며 `.gitignore` 포함 총 30개다.
