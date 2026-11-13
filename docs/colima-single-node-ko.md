# Colima 단일 노드 실습 환경

[English](colima-single-node.md) | 한국어

## 범위와 증거

Beluga 0.2.0 릴리스 후보는 Colima 단일 노드 k3s 실습 환경에서 테스트한다.
정확한 후보 SHA와 테스트 결과는 릴리스 QA 보고서에 기록한다. 이 안내 자체가
릴리스 준비 완료를 입증하지는 않는다.
기준 토폴로지는 Vagrant 4노드이며 재검증은 보류했다. 이 문서는 기존 실습 환경의
실행·테스트 안내다. Colima 자동 설치 절차나 다중 노드 장애 내성의 증거는 아니다.
`make up`, `make down`, `scripts/kubeconfig.sh`는 Vagrant를 사용한다.

2026-10-31 운영 메모의 `beluga` 프로파일은 vz, CPU 10개, RAM 24 GiB,
디스크 50 GiB, containerd 구성이다. Colima 내장 Kubernetes는 끄고 Beluga k3s를
별도로 설치했다. 스크립트는 git archive를 푼 `/opt/beluga`에서 실행했다.
이는 운영자 관측값이며 VM 내부 설정으로, 이 저장소가 관리하지 않는다.
최소 자원 요구사항을 뜻하지 않는다.

## macOS에서 API 접근

[scripts/kubeconfig.sh](../scripts/kubeconfig.sh)가 생성하는 저장소 로컬 `.kube/config`는
`vagrant ssh master-1`과 Vagrant API 주소를 사용하므로 Colima를 가리키지 않는다.
Colima VM의 `/etc/rancher/k3s/k3s.yaml`에서 관리자 kubeconfig를 가져와 비공개로
보관하고, server 엔드포인트만 아래 호스트 터널 주소로 바꾼다. CA와 클라이언트
인증 정보는 유지한다. 공유 `~/.kube/config`에 병합하거나 해당 파일을 바꾸지 않는다.

2026-11-06 운영 메모에는 다른 Lima 인스턴스와 호스트 6443 포트가 충돌한 기록이
있다. 당시 사용한 터널은 다음과 같다.

```bash
ssh -F ~/.colima/_lima/colima-beluga/ssh.config -f -N -L 16443:127.0.0.1:6443 lima-colima-beluga
```

가져온 kubeconfig의 server를 `https://127.0.0.1:16443`으로 설정한다.
SSH 프로파일·포트 충돌·터널은 운영자 관측이며 VM 내부 설정으로, 이 저장소가
관리하지 않는다. 실제 프로파일과 일치하는지 확인한다.
준비한 파일을 `/tmp/beluga-colima-kubeconfig.yaml`에 두었다면
[AGENTS.md](../AGENTS.md)의 규칙대로 작업용 격리 복사본을 만들고 모든
kubectl/Helm 명령에서 사용한다.

```bash
umask 077
kubectl --kubeconfig /tmp/beluga-colima-kubeconfig.yaml config view --minify --flatten > /tmp/beluga-kubeconfig.yaml
export KUBECONFIG=/tmp/beluga-kubeconfig.yaml
kubectl get nodes -o wide
```

## macOS에서 게이트웨이 접근

2026-11-05 운영자 관측: macOS에서 vz를 통해 MetalLB VIP `192.168.77.200`으로
가는 경로가 없었다. Lima가 호스트 443/80 포트를 VM으로 전달하고, VM 내부의 root
`socat` 릴레이가 이를 VIP로 전달했다. 호스트 도메인 레코드를 `127.0.0.1`로 바꾼 뒤
테스트한 10개 호스트 모두 TLS 검증 결과 0(성공), HTTP 응답 301을 확인했다.
VM을 재시작하면 릴레이를 다시 띄워야 한다. 릴레이와 호스트 DNS 변경은 운영자
관측이며 VM 내부 설정으로, 이 저장소가 관리하지 않는다.

이 경로에서는 [도메인 레지스트리](../AGENTS.md)의
서비스 이름이 루프백으로 해석되어야 하며, 테스트 전에 VM 릴레이를 준비해야 한다.
메모에서는 ClusterDeck의 `~/.clusterdeck/dns/zones.json`(DNS `127.0.0.1:15353`)을
사용했다. ClusterDeck이 이 파일을 재생성할 수 있으며 저장소의 구성 원천은 아니다.
HTTPS 443을 사용하고 클러스터의 `beluga-internal-ca`를 신뢰하도록 설정한다.
HTTP 80은 HTTPS로 리다이렉트한다. 서비스 이름과 인증은
[접근 가이드](access-guide.md)를 참고하되, Vagrant용 호스트 라우팅 설명을
Colima에 그대로 적용하지 않는다.

## 라이브 테스트 실행

격리 kubeconfig와 게이트웨이·DNS·TLS를 준비한 뒤 저장소 루트에서 실행한다.
0.2.0의 [PR #413](https://github.com/dasomel/beluga/pull/413) 테스트 변경이 필요하다.
`tests/01`은 `EXPECTED_NODES`를 받으며 기본값은 4다. Colima에서는 다음과 같이 실행한다.

```bash
KUBECONFIG=/tmp/beluga-kubeconfig.yaml EXPECTED_NODES=1 make test
```

[tests/run-all.sh](../tests/run-all.sh)를 실행하는 라이브 테스트다. 임시 워크로드를
생성하거나 애플리케이션 쓰기 동작을 확인하는 검사도 포함한다. 커밋·환경·종료 코드와
개별 건너뜀 결과를 릴리스 증거로 보관한다.

- `tests/27`은 `DBT_RUN_ID`가 없으면 건너뛴다. [dbt/README.md](../dbt/README.md)에
  따라 실행 승인을 받고 `dbt_shop_medallion`의 일시 중지를 해제한 뒤 수동 실행한다.
  그 실행 ID를 테스트 환경에 넘긴다. 테스트는 지정한 실행을 조회하며 직접 시작하지 않는다.
- 2026-11-14 소유자 실측: 모니터링 파드가 시작된 뒤 약 1분 이내에는 스크레이프와
  Watchdog가 준비되지 않아 `tests/31`이 실패한다. 준비를 확인한 뒤 실행한다.
  스크립트는 Watchdog 발화와 Alertmanager 수신을 명시적으로 검사한다.
- 2026-11-14 소유자 실측: macOS 시스템 curl은 신뢰 루트를 격리하려 해도 로그인
  키체인의 `beluga-internal-ca`를 계속 신뢰한다. PR #413은 `tests/10` 3단계의
  부정 TLS 검사를 공개 루트 번들을 사용하는 OpenSSL로 바꾼다.
- PR #413은 Flink가 선언되어 있으나 내려가 있을 때 `tests/03`이 건너뛰지 않고
  실패하도록 바꾼다. 이 변경들은 0.2.0에 포함되며 #413 이전 체크아웃에는 없다.
- Cilium 기본 operator 복제본 2개는 단일 노드에서 같은 hostPort를 요구한다.
  2026-11-14 소유자 승인으로 이 Colima 실습 환경만 복제본 1개로 조정했다.
  Helm revision 2는 차트 1.20.0과 기존 값을 유지하고 `operator.replicas=1`만 바꿨다.
  이후 `tests/01`은 모든 파드가 Running 또는 Completed인 상태로 통과했다.
  Vagrant 기본값이나 GitOps 차트 변경이 아닌 실습 환경 전용 Helm 재정의다.
  변경 전 `helm get values cilium -n kube-system`을 백업한다. 격리 kubeconfig로
  실행한 명령은 다음과 같다.

  ```bash
  helm upgrade cilium cilium/cilium --namespace kube-system --version 1.20.0 --reuse-values --set operator.replicas=1 --wait --timeout 180s
  ```

  버전은 VERSIONS.md와 일치시킨다. Pending 파드는 여전히 `tests/01` 실패이며,
  `EXPECTED_NODES=1`은 파드 상태 검사를 면제하지 않는다.

## 알려진 주의사항과 Vagrant와의 차이

다음은 과거 운영자 관측과 VM 내부 우회 설정이며, 이 저장소가 관리하지 않는다.
반복 적용하기 전에 현재 VM 상태를 확인한다.

| 관측 | 저장소 대조 / 운영상 의미 |
|------|--------------------------|
| 2026-10-31: 노드 IP `192.168.5.3`, `/etc/beluga/node.env`의 `ROLE=master`; 재정의 값 `MASTER_IP=192.168.5.3`, `BELUGA_PROFILE=32`, `METALLB_INTERFACE=eth0`, `UPSTREAM_DNS=192.168.5.2` | `scripts/common/env.sh`는 `/etc/beluga/cluster.override.env`를 읽는다. `03-cni-metallb.sh`는 인터페이스, `10-dnsmasq.sh`는 상위 DNS를 받는다. 실제 값과 노드 파일은 운영자 관측이다. |
| 2026-10-31: `/opt/cni/bin` 소유자가 uid 1001이라 Cilium mount-cgroup에서 EPERM 발생 | 운영자가 소유자를 root로 변경했다. 이 문서는 Colima 소유권 복구 도구를 제공하지 않는다. |
| 2026-10-31: 기존 dnsmasq 재시작 필요, dig/nslookup 부재 | 현재 `10-dnsmasq.sh`는 dnsmasq를 정지한 뒤 시작한다. 메모의 시작만 한다는 설명은 현재 코드와 다르다. 당시 운영자는 재시작하고 dnsutils를 설치했다. |
| 2026-11-06: `/var/lib/rancher` 데이터 디스크 마운트 전에 k3s가 시작되어 루트 디스크의 오래된 상태가 노출됨 | 운영자는 `/etc/systemd/system/k3s.service.d/10-wait-data-disk.conf`에 mountpoint를 기다리는 ExecStartPre를 추가하고 k3s를 재시작했다. 데이터 유실은 아니었다. |
| 2026-11-06: DHCP가 `.3`을 `.1`로 바꿔 Cilium의 API 경로 단절 | 운영자는 `/etc/netplan/60-beluga-node-ip.yaml`에 `192.168.5.3/24` 보조 주소를 추가한 뒤 k3s와 Cilium 파드를 재시작했다. |
| 2026-11-06: cilium-operator 롤링 재시작 후 교체 파드들이 Pending | 운영자는 `rollout undo`를 사용했다. 단일 노드에서 무작정 재시작하지 않는다. |
| 2026-11-01: 정지 후 에이전트 인증서와 k3s CA가 불일치 | 운영자가 k3s를 재구축했다. 과거 장애 기록이며 권장 재구축 절차가 아니다. |

Vagrant는 기준 주소와 수명주기 스크립트를 갖춘 마스터 1대·워커 3대를 제공한다.
Colima는 모든 워크로드가 한 노드에 있고, 호스트 API에는 터널, 게이트웨이에는
VM 릴레이를 쓰며 위 VM별 설정이 필요하다. 단일 노드 테스트 성공으로 노드 장애
내성이 입증되지는 않는다.

## 비정상 종료 후

소유자 실측 장애: 2026-11-13 호스트 전원 강제 종료 후 Flink JobManager가 읽을 수 없는
HA 체크포인트 핸들 때문에 반복 종료됐다. SeaweedFS `fs.verify /buckets`에서
24,577개 중 4개 파일이 영향을 받았으며 모두 Flink 체크포인트 파일이었다.
이는 해당 검사 범위의 결과이며 다른 데이터의 무결성까지 입증하지는 않는다.
복구와 남은 과제는 [이슈 #412](https://github.com/dasomel/beluga/issues/412)에
기록되어 있다(소유자 제공 장애 사실이며 여기서 독립적으로 재실행하지 않았다).

해당 장애에서 운영자가 수행한 복구는 다음과 같다.

1. `streaming`의 `flink-cluster-<jobid>-config-map` ConfigMap 3개를 백업한다.
2. 영향을 받은 ConfigMap에서 읽을 수 없는 객체를 가리키는 `checkpointID-…` 키를
   제거한다. 다른 항목은 보존한다.
3. JobManager 파드를 삭제해 다시 생성되게 한다.

이 복구는 상태를 버린다. 잡은 체크포인트 상태 없이 Kafka 그룹 오프셋으로 다시 시작한다.
투명한 HA 복구가 아니다. 클러스터 변경 승인을 받고 백업을 보관하며 임의의 체크포인트
키를 제거하지 않는다. Flink HA는 이 핸들 손상에서 자동 복구하지 못하며,
아직 Flink 알림도 없다(#412).
