# 사고 기록: VM vCPU 정체와 호스트 메모리 압박

[English](README.md) | 한국어

## 요약

**실측:** Colima 단일 노드 실습 환경에서 2026-11-16 KST에 두 차례 정체가 있었다. A의 첫 soft lockup은 04:14:01, 정지는 07:06:41이다. B 부팅의 보존 journal 범위는 07:07:01–09:51:33이며, 22:30:41 호스트 캡처는 SSH 포트가 열려도 150초 안에 로그인하지 못했다고 기록한다. 재기동은 22:41:02 완료됐다([raw/10](raw/10-first-stall.txt), [raw/03 정지](raw/03-colima-stop.log), [raw/19](raw/19-prev-boot-summary.txt), [raw/14](raw/14-host-2232.txt), [raw/18](raw/18-start.log)).

**추론:** 게스트 페이지가 호스트 compressor에 들어가 vCPU가 압축 해제 또는 스케줄링을 기다리는 호스트 메모리 초과 할당 가설과 부합한다. **미상:** 특정 게스트 페이지·vCPU 정지를 호스트 압축에 연결한 캡처는 없다. 메모리와 독립적인 VZ/커널 7.0 스케줄링 결함도 배제하지 못한다. 이전 [커널 6.8 시계 점프](../2026-11-16-vm-clock-jump/README-ko.md)와의 관계는 미상이다. 이 기록 작성에 클러스터·네트워크 접근을 사용하지 않았다.

## 환경과 영향

**실측:** Colima는 aarch64·10 vCPU·24 GiB를 보고한다([raw/03 요약](raw/03-stop-summary.txt)). 기동은 VZ를 사용한다(raw/18). 커널 trace는 `7.0.0-43-generic`과 Apple Virtualization Generic Platform을 식별한다(raw/10·19). 호스트 RAM은 64 GB다([raw/12](raw/12-host-memory.txt)).

**실측 — A:** Raw/10은 idle `swapper/3`를 포함한 soft lockup 2,146개와 RCU stall 일치 55개를 보고한다. [Raw/09](raw/09-oom-history.txt)는 global OOM kill 108개·memcg kill 0개, 첫 OOM 06:47:12를 기록한다. 06:46:48 load는 521.25/519.70/518.41, MemAvailable은 1,766,448 kB다([raw/01](raw/01-vm-memory.txt)). 06:47:01 `eventpoll_epi`는 16,221,664개, `oom_kill`은 106이다([raw/02](raw/02-thread-states-slab.txt)). 측정 시각·범위가 다른 카운터를 같은 총계로 취급하지 않는다. Raw/09의 시간별 lockup 합계는 2,211로 raw/10의 종류별 요약 2,146과 다르다. 질의 범위가 보존되지 않아 후자는 대조 확정한 총계가 아닌 제공 요약 수치로 남긴다.

**실측 / 추론 — timer와 wall clock:** [Raw/11](raw/11-time-events.txt)의 시간 관련 systemd 항목은 04시까지 있고 05–07시 구간에는 없다. **추론:** timer 진행 중단과 부합하지만 모든 timer 정지를 실측한 것은 아니다. Guestagent는 06:49–06:53에 호스트 동기화와 +154·−140·+121 ms drift를 보고했다. **추론:** 해당 순간의 정상 wall clock을 뒷받침하며 정체 전체 구간의 시각 정확성은 입증하지 않는다.

**실측 — B:** Raw/19는 보존 journal 종료 전 soft lockup 5개·RCU stall 일치 2개·OOM 0개·ext4 오류 일치 0개를 보고한다. 09:51:21 CPU 3 expedited RCU stall과 `cpuidle_idle_call` 발췌가 있고, 09:51:33 CPU 7의 `cilium-agent`가 `smp_call_function_many_cond`에서 멈췄다. **추론:** IPI 대기와 부합하지만 trace만으로 호스트 원인을 특정할 수 없다.

**실측:** Raw/19의 메모리 절 제목은 “09:20–09:49 (every 5th)”이나 실제 보존 행은 09:20:18–09:45:18 KST의 6개다. 가용 메모리는 `avail_mb` 8,721–8,864, `eventpoll_epi`는 6,816으로 일정하며 load는 1.05에서 0.54로 내려간다(중간 최댓값 1.14). 별도로 09:49:58 clock guard 완료 행이 있다. **추론:** 이 표본에는 게스트 메모리 고갈·epoll slab 증가가 없다. B의 선행 조건이라는 가설에 반하는 근거지만 마지막 미관측 수분의 변화를 배제할 수 없어 “09:49까지 정상”·“촉발 원인 배제”로 단정하지 않는다. 8.7 GiB로 환산 단정하지 않고 출력 단위를 유지한다.

## 타임라인 (KST, UTC+09:00)

**추론 표시 외에는 실측이며, 아래 시각은 기록된 표기다.**

| KST | 관측 | 출처 |
|---|---|---|
| 04:14:01 | idle swapper·RCU worker의 첫 soft lockup | raw/09·10 |
| 06:46–06:53 | 높은 load/slab·OOM, guestagent의 1초 미만 drift 표본 | raw/01·02·09·11 |
| 07:03:07–07:06:41 | Colima 정지, containerd 정지 실패 후 VZ 정지, exit 0 | raw/03 정지 |
| 07:07:01–09:51:33 | B의 보존 journal 범위, 기동 명령 완료 07:09:13 | raw/19, [raw/04](raw/04-colima-start.log) |
| 09:20–09:45 | 보존 메모리 표본의 epoll slab 일정 | raw/19 |
| 09:51:12–09:51:33 | cpuidle trace·CPU 3 RCU stall·cilium-agent lockup 후 journal 중단 | raw/19 |
| 22:30:41 | SSH 포트는 열렸으나 150초 내 로그인 불가, 호스트 메모리 압박 | raw/14 |
| 22:30:48 | Colima 정지 시작, 이 파일에 완료 없음 | [raw/15](raw/15-stop.log) |
| 22:38:06–22:38:36 | hostagent SIGINT·VZ 종료·인스턴스 정지, exit 0 | [raw/16](raw/16-limactl-stop.log) |
| 22:38:44 | 호스트 51G 사용·compressor 10G·미사용 12G | [raw/17](raw/17-host-after-stop.txt) |
| 22:38:45–22:41:02 | Colima 재기동, exit 0 | raw/18 |
| 22:43:04–22:43:24 | 제공 검사 03·09·31 통과, 32도 시각 없이 PASS 기록 | raw/20-* |

**추론 / 산술:** 마지막 journal에서 22:38:36 정지까지 약 12.8시간이다. 장시간 정체와 부합하지만 전체 구간의 연속 무응답을 관측한 것은 아니다.

## 호스트 관측과 해석

**실측:** Raw/14의 22:30:41 호스트는 PhysMem 62G 사용·compressor 17G·미사용 1,283M, swap 4,096M 중 2,817.38M 사용이다. VZ 프로세스는 CPU 722.5%·RSS 6.6G이며, 호스트의 다른 VM 하나가 RSS 17.6G를 차지한다. A 이후·B 이전인 07:55:14의 raw/12는 63G 사용·compressor 17G·미사용 316M, swap 3,145.38M/4,096M, 실습 VZ PID RSS 18.4GB를 기록한다. 이는 스냅샷이며 발병 시점의 압박 추적이 아니다. 제공 파일에는 주장된 22:25–22:32 구간이나 미사용 최솟값 209M이 없다.

**실측 / 산술:** 실습 VM 정지 후 raw/17의 미사용 12G는 설정된 24 GiB보다 작다. **추론:** 해당 할당을 위한 즉시 미사용 메모리가 부족했다. 미사용량과 회수 가능 용량은 다르며 compressor 크기·누적 압축 해제 수·낮은 VZ RSS만으로 어느 게스트 페이지가 압축됐는지 또는 vCPU 정체 원인을 입증하지 못한다.

**추론 / 미입증:** 호스트 메모리 초과 할당에 따른 압축·해제 또는 descheduling은 관측과 부합한다. **미상:** 메모리와 독립적인 VZ/커널 7.0 vCPU 스케줄링 결함 가능성, 커널 6.8의 +95년 점프와의 관계. A의 epoll·OOM 관측은 B의 촉발 원인이나 A의 slab 증가·정체 선후관계를 확정하지 않는다.

## 실제 복구와 결과

**실측:** Raw/15에는 22:30:48 정지 요청만 있다. Raw/16은 22:38:06 SIGINT부터 22:38:36 종료까지 기록상 30초, exit 0이다. **미상:** 주장된 Colima 420초 timeout과 limactl 경과 32초는 보존되지 않았다. 운영자는 대체 명령을 `LIMA_HOME=~/.colima/_lima limactl stop colima-beluga`로 식별했으나 raw/16에는 명령행이 없다. 게스트 정상 종료 여부·다음 부팅 ext4 journal recovery 및 오류 유무도 이 캡처로 확정할 수 없다.

**실측:** Raw/18은 재기동 exit 0이다. 제공 라이브 캡처의 [검사 03](raw/20-test-03.log)은 Flink 활성 잡 중복·Lakekeeper/SeaweedFS 확인, [09](raw/20-test-09.log)는 S3 권한·네트워크·fsync, [31](raw/20-test-31.log)은 3 groups/17 평가 규칙과 Watchdog 전달, [32](raw/20-test-32.log)는 시점 한정 시각 검사를 통과했다. 문서 작업자가 재실행한 검사가 아니다. **미상:** 전체 파드 Ready 목록·소요시간은 없으며 검사 03만으로 HA runbook 개입 없는 복구를 증명하지 못한다. A 이후 [raw/06](raw/06-flink-crashloop.txt)에는 HA checkpoint handle 손상·파일 검증 실패가 있다. [Raw/07](raw/07-seaweedfs-fsync-options.txt)은 설정·도움말·dry-run 캡처로 실제 설정 반영의 증거가 아니다.

## 열린 소유자 결정과 판별 후속 과제

- **미상 / 소유자 결정:** VM 크기와 다른 작업의 호스트 메모리 예산. 여기서는 할당을 바꾸지 않는다.
- **미상 / 소유자 결정:** 커널 7.0 유지 또는 6.8 복귀. 이전 시계 점프 위험도 고려해야 하며 여기서 결정하지 않는다.
- **추론 — 판별 실험:** 호스트 여유 메모리가 VM 할당보다 큰 조건에서 재실행하고 게스트 sampler와 함께 호스트 `memory_pressure`를 매분 수집한다. 안정 실행은 압박 가설을 강화하지만 단독으로 인과를 입증하지 않는다.
- **미상:** 발병 시점 스케줄링 추적·압축 페이지 귀속·실제 중단시간과 데이터 손실·통제된 재현 방법.

## 다음 발생 시 식별 체크리스트

**추론 — raw/10·12·14·19에서 도출한 진단 절차:**

1. VM 할당이 호스트 여유 메모리 안에 들어가고 호스트 작업의 여유도 남도록 예산을 잡는다. 호스트 compressor·swap·pressure와 게스트 MemAvailable·slab을 함께 본다.
2. SSH 연결만 되고 로그인하지 못하면 게스트 OOM에 귀속하기 전에 호스트 VZ CPU/RSS와 게스트 cpuidle·RCU·IPI trace를 확인한다.
3. Boot ID로 journal을 고른다. Raw/19는 이전 시계 점프의 2122년 부팅이 뒤로 정렬되어 `journalctl -b -1`이 다른 부팅을 골랐다고 기록한다. `journalctl --list-boots`로 대상 부팅을 확인하고 B에는 `journalctl -b 88de76e0381f498f8ce723c97937be19`를 쓴다. 상대 인덱스만 신뢰하지 않는다.

## 증거 한계

**실측 범위:** `raw/`에는 바이트를 바꾸지 않은 운영자 캡처 23개와 log 허용 `.gitignore`가 있다. 빈 입력 `13-probe-2230.txt`는 제외했으며 SSH 관측은 raw/14에 있다. 모든 입력의 비밀정보를 검토하고 저장소 증거 검사기의 secret pattern도 확인했으며 비밀정보가 있는 파일은 발견하지 않았다. 다른 VM의 프로젝트 식별정보는 포함하지 않는다. 요약 수치·발췌로 누락 journal이나 질의 범위를 복원할 수 없다. JSONL revision은 문서 작성 기준선이며 배포 SHA 검증이 아니다.

**실측 — 문서 검사:** 오프라인 명령·종료 코드·출력은 [verification.txt](verification.txt)에 보존한다. 정적 검사는 라이브 복구·재발 방지를 입증하지 않는다. 실행 코드·클러스터 설정·커널·호스트 할당은 변경하지 않았다.
