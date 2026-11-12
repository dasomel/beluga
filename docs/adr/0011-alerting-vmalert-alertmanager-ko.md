# ADR-0011: 스토리지/CDC 경보용 vmalert와 Alertmanager

[English](0011-alerting-vmalert-alertmanager.md) | 한국어

- 상태: 수락 (구현 선언, 라이브 검증 대기)
- 날짜: 2026-11-13
- 오너: dasomel, 이슈 #408 (2026-11-13 결정)
- 승인 범위: 두 컴포넌트 추가와 metrics 읽기 RBAC, 그 외 권한 확대 없음

## 배경

[2026-11-12 인시던트](../../research/incidents/2026-11-12-cdc-slot-wal-disk-pressure/README.md)는
Connect 로그가 root disk를, 슬롯 WAL이 data disk를 각각 채웠음을 기록한다.
테스트 29는 시점 검사이고 연속 탐지가 아니다. node-exporter·kube-state-metrics·
Prometheus Operator는 없다. 오너가 Grafana-managed 평가 대신 vmalert와
Alertmanager를 선택했다. ADR-0010이 사용 중이므로 0011을 쓴다.

## 결정

- **D-ALERT-1 — 직접 kubelet과 제한된 SD.** VM Kubernetes SD로 nodes와 CNPG
  exporter pods를 찾는다. ClusterRole은 `list/watch nodes`, `get nodes/metrics`만,
  namespace Role은 database/platform-system `list/watch pods`만 허용한다.
  SA 토큰+CA로 kubelet `:10250`의 `/metrics`, `/metrics/cadvisor`,
  `/metrics/resource`를 수집한다. API proxy는 임의 kubelet API까지 허용하는
  `nodes/proxy`가 필요하므로 제외한다. node SD 기본 InternalIP:10250을 유지한다
  (주소 재작성 없음). 오너 제공 colima 실측(2026-11-13): `nodes/metrics get`과
  nodes list/watch로 충분하며 proxy 불필요. kubelet 인증서는 `k3s-server-ca` 발급,
  SA `ca.crt`로 검증 성공, SAN에 노드 이름과 InternalIP `192.168.5.3` 포함.
  `tls_config.ca_file` 전체 검증을 유지하고 `insecure_skip_verify`는 설정하지 않는다.
  비용: 다른 환경의 CA/SAN과 인증된 수집은 추가 실측 필요. 탈출구: 네트워크/인증서 수정; proxy 전환은
  별도 보안 검토·승인, TLS 검증 생략 금지. Secret API 권한 없음. Pod SD는
  CNPG cluster 라벨과 9187로 제한하며 monitor CRD·exporter 추가 없음.
- **D-ALERT-2 — 이미지.** vmalert v1.155.0은 VM과 일치한다. Alertmanager는
  v0.35.0 출시 4일 시점이라 오너 제공 v0.34.2를 쓴다. 두 이미지 모두
  Apache-2.0, 오너 제공 amd64/arm64 멀티아치 digest 고정이다. 비용: 최신 수정
  지연. 탈출구: 회귀 검사 후 VERSIONS.md·이미지·라이선스 원자적 갱신.
- **D-ALERT-3 — null 수신자.** alertname/namespace로 묶고 integration 없는
  `name: "null"`만 기본 설정한다. 외부 통지는 없다. 비용: 자동 호출·외부
  Watchdog 감시 없음. 탈출구: 오너가 채널/라우팅/자격증명을 결정한 뒤
  `alertmanager.config`, `extraEgress` 값 변경; 비밀 필요 시 Secret 투영 별도 설계.
- **D-ALERT-4 — 상태와 Grafana.** vmalert는 VM query·remote write/read로
  pending 상태를 재시작 후 복원한다(업스트림 lookback 범위). 이 경로에는 VM
  admin 키가 필요 없어 기존 file:// 관리 키를 VM에만 유지한다. VM
  `-vmalert.proxyURL`과 `manageAlerts: true`, `prometheusType: Prometheus`로
  Grafana에서 외부 규칙을 조회한다(규칙 원천은 GitOps). 내장 Alertmanager
  데이터소스는 Prometheus 구현, `handleGrafanaManagedAlerts: false`다.
  플러그인·공개 호스트명 추가 없음. 비용: 단일 VM/평가기 장애 영역.
  탈출구: 별도 검토한 HA 설계.
- **D-ALERT-5 — Cilium 네트워크.** platform-system의 namespaced
  `victoria-metrics-entity-egress` CiliumNetworkPolicy는 `app=victoria-metrics`만
  선택한다. 가산 적용되는 두 egress 규칙은 `kube-apiserver` TCP 6443/443,
  `host, remote-node` TCP 10250만 허용한다. `ipBlock`은 이 Cilium identity를
  선택하지 못한다(보안 기준선 REQ-015).
  오너 제공 colima 실측(2026-11-13, k3s+Cilium tunnel mode,
  `policy-cidr-match-mode` 미설정): VM Pod에서 nodeIP:10250과
  kubernetes.default.svc는 CIDR 정책 아래 타임아웃, 임시 entity 정책 추가 후
  HTTP 401, 제거 후 다시 타임아웃이었다. 401은 연결 증거이며 인증된 수집 증거는 아니다.
  지원 환경 Vagrant/Kakao 모두 Cilium이고 실측 colima에 CRD가 존재한다.
  `observability.ciliumEntityEgress` 기본값 true. 비용: Cilium CRD 의존;
  탈출구: 비 Cilium 클러스터는 false로 끌 수 있으나 별도 네트워크 경로 설계 없이는
  노드 메트릭 수집 불가. CIDR 값은 제거한다. 신규 파드 경로 양쪽은 개별 정책으로
  제한하고 Alertmanager 기본 egress는 DNS만 허용한다. `manager-db-ingress`에
  VM 전용 TCP 9187만 추가한다(D-ALERT-15). 두 차트 모두 database NetworkPolicy가
  없어 postgres-main 인그레스는 변경하지 않는다. 기존 DB 클라이언트·namespace 기본 정책 유지.
- **D-ALERT-6 — 저장소 범위.** cAdvisor는 `id="/",device=~"/dev/.+",device!="/dev/shm"`
  usage/limit만 보존해 tmpfs/overlay 시리즈를 버린다. D-ALERT-16은 용량
  >1073741824 bytes(1 GiB)를 `node, device`별로 평가해 root/data disk를 포함한다.
  Colima 실측에서 cloud-init ISO `/dev/vdc`는 항상 100% 사용하므로 전체 장치
  최솟값은 영구 오탐을 낸다. 비용: 1 GiB 이하 또는 `/dev/` 밖 파일시스템은 제외한다.
  동일 라벨 selector(용량 비교 없음)의 전체 부재 경보와 테스트 31이 보완한다.
  테스트 31은 노드마다 선택된 용량 >1 GiB 시리즈를 요구하고 장치를 출력한다.
  탈출구: mountpoint 라벨이 있는 node-exporter. 경보 이름은 유지한다.
  `NodeRootFilesystemMetricAbsent`는 15m 후 warning; 규칙은 총 12개다.
  kubelet은 volume stats·node/pod CPU/memory resource만 보존한다.
  local-path available bytes는 PVC quota가 아니라 공유 data filesystem 신호다.
  container fs는 전체 로그/emptyDir를 보장하지 않아 PodEphemeralStorageHigh 생략.
  비용: 파드별 저장소 원인 경보 없음. 탈출구: 신뢰 가능한 사용량·분모 실측 후 추가.
- **D-ALERT-7/8 — 설정·영속성.** 규칙 파일은 tpl 없이 ConfigMap에 넣어 annotation
  템플릿을 보존하고 checksum으로 rollout한다. Alertmanager 설정도 checksum을
  쓰며 Recreate Deployment+256Mi local-path PVC에 silence/nflog를 보존한다.
  비용: 노드 의존·교체 중 중단. 탈출구: 복제 스토리지/HA 검토; emptyDir로 조용히
  바꿔 silence를 버리지 않는다.
- **D-ALERT-9 — 임계값.** root/data 여유 <20% warning 10m / <12% critical 2m,
  대략 10–15% eviction 전 탐지. 슬롯 WAL >512MiB warning 10m / >900MiB critical
  2m은 checkpoint 시점 1GiB cap 전 탐지. 비활성 슬롯 15m, pg_wal >2GiB 10m,
  archive ready >20 15m, scrape down 10m, Watchdog 1m. 비용: 급증 시 대응 시간
  보장 불가. 탈출구: 증가율·평가 지연 실측 후 조정. 모든 규칙에 severity·for·
  summary·description·[런북](../runbooks/cdc-slot-wal-retention-ko.md) 링크 포함.
- **D-ALERT-10/11/12 — 증거.** 기존 PyYAML+stdlib 검사기는 렌더 YAML·정확한
  메트릭 이름 allowlist·인증/TLS·RBAC·digest·null 수신자를 검사하고 음성 fixture
  15개와 네트워크 음성 fixture 25개를 거부한다. 양쪽 차트와 새 파드 경로의
  양방향 정책을 검사한다(D-ALERT-14). PromQL 평가기가 아니다. 테스트 31은 격리 kubeconfig와 임시
  포트 forward로 상태/API만 읽는다. 비용: 오프라인 엔진·통지 증명 없음.
  탈출구: 라이브 테스트와 후속 엔진 테스트.

- **D-ALERT-13 — 외부 호출 인벤토리.** 정확한 런북 annotation은 사람용 링크이므로
  해당 경로/URL 패턴만 제외한다. 비용: 제한된 추출 예외. 탈출구: 구조적 endpoint
  파서. 회귀 fixture로 원래 오탐을 재현하고 같은 파일의 실제 URL·실행 소스의 동명 키는
  계속 탐지한다. 외부 호출 기준선 추가 없음.

## 검증·미결정

오프라인: `python3 scripts/ci/check-alerting-pipeline.py`, 개별 CI 게이트 및
Helm default/SSO/full/Kakao 렌더 및 비 Cilium opt-out. 이 worker는 라이브에
접근하지 않았으며 위 colima 실측은 오케스트레이터가 제공했다.
라이브 확인: 배포·1분 이상 준비 후 테스트 31; 차트 관리 Cilium 규칙과 모든 노드의
인증된 kubelet TLS 수집·두 CNPG 클러스터의 SD/메트릭·규칙 평가·Watchdog 전달, 실제 Grafana SSO 경유
규칙/Alertmanager 화면. 별도 승인된 재시작 시험에서 pending 상태 복구와 silence/nflog
보존 확인. 채널·자격증명·담당자/대응 목표·HA·파드별 저장소 경보는 미결정이다.
롤백: GitOps에서 차트/값/규칙/인벤토리를 함께 되돌린다. PVC 선언 제거는 데이터 삭제
승인이 아니다. 훅 추가 없음.

## 확인한 업스트림 원천

- [kubelet 인증/인가](https://kubernetes.io/docs/reference/access-authn-authz/kubelet-authn-authz/): metrics/proxy 차이.
- [VM Kubernetes SD](https://docs.victoriametrics.com/victoriametrics/sd_configs/#kubernetes_sd_configs): single-node node/pod SD.
- [vmalert](https://docs.victoriametrics.com/victoriametrics/vmalert/): 상태 복원과 rules/alerts API.
- [VM proxy](https://docs.victoriametrics.com/victoriametrics/single-server-victoriametrics/#vmalert): Grafana 규칙 프록시.
- [Grafana Prometheus](https://grafana.com/docs/grafana/latest/datasources/prometheus/configure/): 외부 규칙 조회.
- [Grafana Alertmanager](https://grafana.com/docs/grafana/latest/datasources/alertmanager/): 내장 데이터소스·silence.
- [CNPG 기본 쿼리](https://raw.githubusercontent.com/cloudnative-pg/cloudnative-pg/main/config/manager/default-monitoring.yaml): slot_name 라벨. 메트릭 존재 증거는 업스트림 추정이 아니라 오너 제공 2026-11-13 실측이다.
