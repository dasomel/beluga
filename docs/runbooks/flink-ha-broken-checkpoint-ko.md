# Flink HA 손상 체크포인트 핸들 복구 런북

[English](flink-ha-broken-checkpoint.md) | 한국어

## 범위와 장애 배경

이 런북은 [이슈 #412](https://github.com/dasomel/beluga/issues/412)(2026-11-13 ~01:43 KST 호스트 전원 차단 뒤 2026-11-14 KST Colima 단일 노드에서 실측)에서 기록된 장애 모드와 [ADR-0011](../adr/0011-alerting-vmalert-alertmanager-ko.md)(`D-ALERT-21`)에 선언된 Flink 경보를 다룬다.

쓰기 도중 호스트나 스토리지 전원이 끊기면 SeaweedFS filer 메타데이터에는 Flink HA 체크포인트 상태 핸들이 남지만 실제 볼륨 청크(needle)가 디스크에 기록되지 않을 수 있다(**inferred(추론)**: 전원 차단 시점에 볼륨 플러시 전 승인된 쓰기와 부합). 재기동 시 Flink JobManager는 `s3a://beluga-lake/flink-system/ha/flink-cluster/`의 손상된 `completedCheckpoint*` 핸들을 읽다 `IOException` / `ConnectionClosedException`으로 실패하며, 실행 중인 잡이 0개인 채로 무한 `CrashLoopBackOff`에 빠진다.

## 증상과 경보

### 경보 규칙 (`gitops/charts/beluga-platform/files/observability/rules/pipeline.yml`)

| 경보 이름 | 식 (PromQL) | 지속 시간 / 심각도 | 의미 |
|---|---|---|---|
| `FlinkNoRunningJobs` | `up{job="flink"} == 0 or absent(flink_jobmanager_numRunningJobs{job="flink"}) or flink_jobmanager_numRunningJobs{job="flink"} < 1` | `5m` / `critical` | JobManager Prometheus 엔드포인트(`Service/flink-cluster-metrics` 경유 `:9249`)가 다운/비응답이거나 `RUNNING` 잡 수가 0개임 |
| `FlinkJobManagerRestarting` | `changes(container_start_time_seconds{job="kubelet-resource",namespace="streaming",container="flink-main-container"}[15m]) >= 2 or resets(flink_jobmanager_Status_JVM_CPU_Time{job="flink"}[15m]) >= 2` | `5m` / `warning` | 15분 동안 Flink 컨테이너 시작 시각이 2회 이상 바뀌었거나 JobManager JVM 가동 시간이 2회 이상 리셋됨 |
| `FlinkCheckpointsStalled` | `changes(flink_jobmanager_job_numberOfCompletedCheckpoints{job="flink"}[10m]) == 0` | `5m` / `critical` | 보고되는 잡이 10분 동안 체크포인트를 하나도 완료하지 못함. Iceberg 싱크는 체크포인트에서만 커밋하므로 잡이 `RUNNING`으로 보여도 테이블에 새 데이터가 들어오지 않는다 (D-ALERT-29) |
| `FlinkCheckpointsFailing` | `changes(flink_jobmanager_job_numberOfFailedCheckpoints{job="flink"}[15m]) >= 3` | `5m` / `warning` | 15분 동안 실패한 체크포인트 수가 3회 이상 바뀜. 커밋이 지연되고 곧 정지로 이어질 수 있다. VictoriaMetrics는 새 시리즈의 첫 샘플도 변화로 세므로, 잡 재제출이나 JobManager 재시작 후 15분 안에는 실제 실패 2회로도 경보가 난다 |
| `FlinkJobMissing` | 기대 SQL 잡마다 `absent(flink_jobmanager_job_numberOfCompletedCheckpoints{job="flink",job_name="<name>"})` | `10m` / `critical` | 다른 잡은 실행 중일 수 있지만 기대하는 SQL 잡의 잡별 시리즈가 없음(FAILED, CANCELED 또는 재제출 안 됨) (D-ALERT-30) |

### 로그 징후 (#412 실측)

`kubectl -n streaming logs -l app=flink-cluster,component=jobmanager` 출력:

```text
org.apache.flink.util.FlinkException: Could not retrieve checkpoint 11593 from state handle under checkpointID-0000000000000011593. This indicates that the retrieved state handle is broken. Try cleaning the state handle store.
...
Caused by: org.apache.http.ConnectionClosedException: Premature end of Content-Length delimited message body (expected: 6,640; received: 0)
```

대상 경로는 `s3a://beluga-lake/flink-system/ha/flink-cluster/completedCheckpoint7747805683f9`였다. 2026-11-13 장애에서는 JobManager가 약 18시간 동안 43회 재시작하며 스트리밍 잡이 하나도 돌지 않았다.

## 진단 절차 (읽기 전용 우선)

모든 `kubectl` 실행 전 격리된 kubeconfig를 만든다(공유 `~/.kube/config` 수정 금지; Colima는 [colima-single-node-ko.md](../colima-single-node-ko.md)의 격리 터널 kubeconfig 사용):

```bash
kubectl --kubeconfig .kube/config config view --minify --flatten > /tmp/beluga-kubeconfig.yaml
export KUBECONFIG=/tmp/beluga-kubeconfig.yaml
```

### 1. Flink 파드 상태와 JobManager 로그 확인

```bash
kubectl -n streaming get flinkdeployment,pods -o wide
kubectl -n streaming logs -l app=flink-cluster,component=jobmanager --tail=200
kubectl -n streaming logs -l app=flink-cluster,component=jobmanager --previous --tail=200 || true
```

깨진 것으로 보고된 `checkpointID-<19자리-순번>` 키와 `s3a://beluga-lake/flink-system/ha/flink-cluster/completedCheckpoint*` 경로를 확인한다.

### 2. `streaming` 네임스페이스의 Kubernetes HA ConfigMap 확인

`high-availability.type: kubernetes`(`gitops/charts/beluga-data/templates/05-flink-operator.yaml:28-30`)에서 Flink는 `streaming` 네임스페이스의 ConfigMap에 HA 핸들을 저장한다:

- `flink-cluster-cluster-config-map`: 클러스터 리더 선출 항목과 `s3a://beluga-lake/flink-system/ha/flink-cluster/jobGraph*`를 가리키는 `jobGraph-<jobid>` 참조를 보관한다.
- `flink-cluster-<jobid>-config-map` (제출된 잡당 1개 — Beluga 세션 클러스터의 세 잡 `beluga-events_sessionization`, `beluga-cdc_orders`, `beluga-cdc_customers`에 대응하는 3개): `s3a://beluga-lake/flink-system/ha/flink-cluster/completedCheckpoint*`를 가리키는 `checkpointID-<19자리-순번>` 키, `counter`, 잡 리더 키를 보관한다.

HA ConfigMap과 키 목록 조회(읽기 전용):

```bash
for cm in $(kubectl -n streaming get configmap -o name | grep -E '^configmap/flink-cluster-'); do
  echo "=== ${cm} ==="
  kubectl -n streaming get "${cm}" -o jsonpath='{.data}' | python3 -c 'import json,sys; d=json.load(sys.stdin); print("\n".join(sorted(d.keys())))'
done
```

### 3. SeaweedFS 청크 무결성 검사 (`weed shell` `fs.verify`)

`/buckets`(`beluga-lake/flink-system/ha/flink-cluster/` 및 `beluga-lake/flink-system/checkpoints/`) 아래 SeaweedFS 볼륨 청크가 읽히는지 확인한다:

```bash
kubectl -n storage exec seaweedfs-0 -- sh -c 'printf "fs.verify /buckets\n" | weed shell'
```

2026-11-14 #412 실측에서는 `fs.verify /buckets`가 24,577개 파일을 검사해 전원 차단 시점에 기록된 Flink 파일 4개(`flink-system/ha/flink-cluster/completedCheckpoint*` 핸들 3개와 `flink-system/checkpoints/fa8ed8f8…/chk-11593/_metadata` 1개)에서 청크 누락(`not found, at volume server`)을 보고했으며, Iceberg 데이터·메타데이터 파일은 실패가 없었다.

### 4. 체크포인트 정지 또는 반복 실패 (`FlinkCheckpointsStalled` / `FlinkCheckpointsFailing`, D-ALERT-29)

잡은 여전히 `RUNNING`일 수 있고, 해당 Iceberg 테이블에만 커밋이 들어오지 않는다. 읽기 전용 점검:
잡 목록을 확인하고, 체크포인트 수와 완료되지 않은 시도의 실패 메시지를 읽고(REST 이력은 최근 10회,
30초 간격으로 약 5분만 보관한다), 각 vertex의
backpressure를 확인한 뒤, TaskManager 로그에서 체크포인트·S3·Iceberg 커밋 경고와 오류를 찾는다(일상적인 INFO 커밋 줄은 걸러낸다):

```bash
B=/api/v1/namespaces/streaming/services/flink-cluster-rest:8081/proxy
kubectl get --raw "$B/jobs/overview" | python3 -c 'import json,sys; [print(j["jid"], j["name"], j["state"]) for j in json.load(sys.stdin)["jobs"]]'
J=<경보 job_name에 해당하는 jid>
kubectl get --raw "$B/jobs/$J/checkpoints" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d["counts"]); f = (d.get("latest") or {}).get("failed"); print("latest failed:", f and (f["id"], (f.get("failure_message") or "")[:200])); [print(h["id"], h["status"], h.get("failure_message", "")[:200]) for h in d["history"] if h["status"] != "COMPLETED"]'
for V in $(kubectl get --raw "$B/jobs/$J" | python3 -c 'import json,sys; print(" ".join(v["id"] for v in json.load(sys.stdin)["vertices"]))'); do
  kubectl get --raw "$B/jobs/$J/vertices/$V/backpressure" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("status"), d.get("backpressureLevel"))'
done
kubectl -n streaming logs -l component=taskmanager --prefix --tail=5000 | grep -E " (WARN|ERROR) " \
  | grep -iE "checkpoint|S3|Commit|Iceberg|timeout|refresh|ExpiredSignature" | grep -v "Not authorized: invalid_client" | tail -40
# 토큰 갱신 잡음(아래 설명)은 따로 센다:
kubectl -n streaming logs -l component=taskmanager --prefix --since=15m --tail=-1 | grep -c " WARN .*Not authorized: invalid_client"
# JobManager는 체크포인트 트리거·만료·거절 메시지를 남긴다:
kubectl -n streaming logs deploy/flink-cluster --tail=5000 | grep -iE "(fail|expired|declin)[a-z]* .*checkpoint|checkpoint.*(fail|expired|declin)" | tail -20
```

규칙적으로 반복되는 동안은 알려진 잡음이다: 스택에 `OAuth2Util.refreshToken`이 있는
`WARN org.apache.iceberg.util.Tasks - Retrying task after failure: Not authorized: invalid_client`.
Iceberg 1.7.1 클라이언트는 Lakekeeper/서명 토큰(client credentials, `expires_in=300`)을 만료 직전에
RFC 8693 토큰 교환으로 갱신한다. 첫 시도는 현재 bearer 토큰만 실어 Keycloak이 `invalid_client`로
답하고, Iceberg가 이를 다섯 번 재시도한다(WARN 다섯 줄). 그다음 클라이언트 Basic 자격증명으로 토큰 교환을
다시 하며, 이는 Keycloak 클라이언트 `flink`에 `standard.token.exchange.enabled=true`가 있을 때만
성공한다. 2026-11-28 실측: 인증 세션마다 4~5분에 다섯 줄 한 묶음(두 TaskManager 합쳐 주기당 약 25줄,
위 카운트 명령은 15분에 75~100, 즉 3~4주기. 인증 세션 수, 곧 TaskManager와 잡 수에 비례한다), `Failed to clean up on failure` ERROR 없음, 모든 체크포인트 완료.

체크포인트 실패·정지와 함께 다음 중 하나라도 보이면 원인으로 본다:
`ERROR org.apache.iceberg.util.Tasks - Failed to clean up on failure`가 나타남(Basic 자격증명 토큰 교환도
거부됨, 예: `Standard token exchange is not enabled`, 이후 Iceberg는 갱신을 더 예약하지 않음), 규칙적인 묶음이 멈춤, Lakekeeper나 S3 서명기가 401/`ExpiredSignature`를 반환, 클라이언트
`flink`에 `standard.token.exchange.enabled`가 없음. 이것이 [`keycloak-clients.yaml` 5b 단계](../../gitops/charts/beluga-platform/templates/keycloak-clients.yaml)에
기록된 실제 장애이며, 그때도 client-credentials 토큰 요청은 성공했으므로 그 요청이 된다고 이 원인을
배제할 수 없다.

대표 원인과 다음 단계: 실패 메시지가 S3/SeaweedFS 관련이면 `storage` 파드와 진단 3번(`fs.verify`)을
확인한다. Lakekeeper/Iceberg 커밋 충돌이면 `lakehouse` 로그를 본다(`iceberg_table_maintenance` 실행과
잠시 충돌할 수 있다). REST API가 보고하는 backpressure 수준(`ok`/`low`/`high`)이 `high`인 체크포인트
타임아웃이면 싱크 지연이나 Kafka 따라잡기가 원인이다. 잡이 재시작을 반복하면 위 HA 절차를 본다.
Kafka가 커밋되지 않은 오프셋을 보존하는 동안 데이터는 유실되지 않는다. 소스는 커밋된 그룹 오프셋에서
재개하고, 소스가 읽는 토픽(`cdc.shop.public.orders`, `cdc.shop.public.customers`,
`events.clickstream`)은 7일을 보존한다(브로커 기본값, KafkaTopic으로 선언되지 않고 자동 생성됨).
그 이후에는 `earliest` 재설정 때문에 조용한 공백이 생기므로 7일 안에 충분히 여유를 두고, 또는 원인이
불명확하면 에스컬레이션한다. 상태를 폐기하는 복구는 아래처럼 승인이 필요하다.

## 복구 절차 (상태 폐기 복구 — 소유자/운영자 승인 필요)

> [!WARNING]
> `flink-cluster-<jobid>-config-map`에서 `checkpointID-*` 키를 제거하는 것은ConfigMap에 읽을 수 있는 이전 체크포인트 핸들이 없을 때 **체크포인트 상태를 버리는 복구(state-discarding recovery)** 다. 클러스터 ConfigMap을 변경하기 전 명시적 승인을 받고 백업 본을 보존하며, `jobGraph-*`·`counter`나 임의의 키는 절대 삭제하지 않는다.

[이슈 #412](https://github.com/dasomel/beluga/issues/412)에서 수행한 절차 그대로 실행한다:

### 1단계: 세 `flink-cluster-<jobid>-config-map` ConfigMap 백업

```bash
BACKUP_DIR="/tmp/flink-ha-backup-$(date +%Y%m%d-%H%M%S)"
mkdir -p "${BACKUP_DIR}"
for cm in $(kubectl -n streaming get configmap -o name | grep -E '^configmap/flink-cluster-[0-9a-f]{32}-config-map$'); do
  name="${cm#configmap/}"
  kubectl -n streaming get configmap "${name}" -o yaml > "${BACKUP_DIR}/${name}.yaml"
  echo "Backed up ${BACKUP_DIR}/${name}.yaml"
done
```

### 2단계: 영향받은 각 ConfigMap에서 깨진 `checkpointID-…` 키 제거

JobManager 예외 로그와 `fs.verify /buckets`로 확인한 읽기 불가 `completedCheckpoint*` 객체를 가리키는 `checkpointID-<seq>` 키만 제거하고, 나머지 키(`counter`, 리더 키 등)는 그대로 보존한다:

```bash
# <jobid>와 checkpointID-0000000000000011593을 진단에서 확인한 실제 값으로 바꾼다:
kubectl -n streaming patch configmap "flink-cluster-<jobid>-config-map" \
  --type=json -p='[{"op":"remove","path":"/data/checkpointID-0000000000000011593"}]'
```

### 3단계: JobManager 파드를 삭제해 재생성

```bash
kubectl -n streaming delete pod -l app=flink-cluster,component=jobmanager
kubectl -n streaming rollout status deployment/flink-cluster --timeout=180s
```

## 상태 없이 재시작할 때 소실되는 데이터 보장 범위

깨진 `checkpointID-…` 핸들을 제거하고 유효한 보존 체크포인트가 남지 않으면 JobManager는 `restored: 0`을 기록하며 각 잡을 저장된 `jobGraph`로부터 상태 없이 재시작한다:

1. **Kafka 소스 오프셋 재개 (레포 선언 및 #350/#412 실측)**:
   - 세 SQL 파이프라인(`gitops/charts/beluga-data/files/flink-sql/{cdc_customers,cdc_orders,events_sessionization}.sql`)은 모두 `'scan.startup.mode' = 'group-offsets'`, `'properties.auto.offset.reset' = 'earliest'`, 잡별 고정 컨슈머 그룹(`flink-cdc-customers-group`, `flink-cdc-orders-group`, `flink-events-sessionization-group`; `tests/13-flink-sql-idempotent.sh:91-98`이 강제)을 사용한다.
   - Flink 체크포인트 상태 없이(`restored: 0`) 잡이 재시작되면 Kafka 소스는 토픽 처음(`earliest-offset`)이 아니라 이전 완료 체크포인트 시점에 Kafka 컨슈머 그룹에 마지막으로 커밋된 오프셋에서 재개한다.
2. **상태 손실 구간에 걸친 Iceberg 적재 보장 (inferred / 추론)**:
   - **Inferred(추론, 레포 내 자동 장애 주입 테스트로 직접 측정되지 않음)**: **상태 폐기 복구 구간에 걸쳐 Iceberg로의 정확히 한 번(exactly-once) 적재는 보장되지 않는다.**
   - **Inferred(추론)**: Kafka 컨슈머 그룹에 마지막으로 커밋된 오프셋 이후의 레코드(손상된 체크포인트 직전 인메모리 연산자 상태에 머물렀거나 2단계 커밋 경계에 걸친 레코드)는 Kafka 그룹 오프셋부터 다시 읽히며, 체크포인트에만 있던 인메모리 상태는 유실된다:
     - `iceberg_catalog.bronze.cdc_customers`(`cdc_customers.sql:23-39`)와 `iceberg_catalog.bronze.cdc_orders`(`cdc_orders.sql:23-41`)는 `PRIMARY KEY (...) NOT ENFORCED`와 `'write.upsert.enabled' = 'true'`를 선언하므로, 마지막 커밋된 Kafka 그룹 오프셋 이후 꼬리 CDC 이벤트가 재생되더라도 동일 기본 키로 멱등 덮어쓰기된다(**inferred**).
     - `iceberg_catalog.silver.events_enriched`(`events_sessionization.sql:29-39`)는 `PRIMARY KEY (event_id, event_ts) NOT ENFORCED`만 선언하고 `'write.upsert.enabled' = 'true'`가 없는 append 전용 싱크이므로, 마지막 커밋된 Kafka 그룹 오프셋과 이미 커밋된 Iceberg 스냅샷 사이의 꼬리 구간이 재생될 때 중복 행이 생길 수 있으며 폐기된 체크포인트의 인메모리 상태는 유실된다(**inferred**).

## 복구 후 검증 방법

1. **JobManager·TaskManager 파드 및 3개 잡 `RUNNING` 확인**:
   ```bash
   kubectl -n streaming get pods -l app=flink-cluster
   JM_POD="$(kubectl -n streaming get pod -l app=flink-cluster,component=jobmanager -o jsonpath='{.items[0].metadata.name}')"
   kubectl -n streaming exec "${JM_POD}" -- curl -sf http://localhost:8081/jobs/overview
   ```
   `beluga-events_sessionization`, `beluga-cdc_orders`, `beluga-cdc_customers` 세 잡이 모두 `"state":"RUNNING"`인지 확인한다.

2. **새 체크포인트 완료(`counts.completed > 0`) 확인**:
   체크포인트 주기는 `30s`(`05-flink-operator.yaml:13`)다. 30~60초 뒤 `/jobs/<jid>/checkpoints`에서 완료 카운트가 증가하는지 확인한다:
   ```bash
   for jid in $(kubectl -n streaming exec "${JM_POD}" -- curl -sf http://localhost:8081/jobs | python3 -c 'import json,sys; print(" ".join(j["id"] for j in json.load(sys.stdin)["jobs"]))'); do
     echo "=== job ${jid} ==="
     kubectl -n streaming exec "${JM_POD}" -- curl -sf "http://localhost:8081/jobs/${jid}/checkpoints" | python3 -c 'import json,sys; c=json.load(sys.stdin)["counts"]; print(c)'
   done
   ```

3. **스트리밍-Iceberg E2E 및 경보 파이프라인 검증 스크립트 실행**:
   ```bash
   KUBECONFIG=/tmp/beluga-kubeconfig.yaml bash tests/03-stream-iceberg.sh
   KUBECONFIG=/tmp/beluga-kubeconfig.yaml bash tests/31-alerting-pipeline.sh
   ```

## `state.checkpoints.num-retained`만 늘려도 해결되지 않는 이유

Apache Flink 1.20(`org.apache.flink.runtime.checkpoint.DefaultCompletedCheckpointStore.recover()`)은 HA 복구 시 `flink-cluster-<jobid>-config-map`에 남아 있는 **모든** `checkpointID-*` 상태 핸들을 순회하며 각각 `retrieveCompletedCheckpoint(checkpointStateHandle)`로 S3 메타데이터 객체를 읽어 인메모리 `completedCheckpoints` 큐를 재구성한 뒤 최신 체크포인트를 고른다.

보존된 `checkpointID-*` 핸들 중 **하나라도** `s3a://beluga-lake/flink-system/ha/flink-cluster/completedCheckpoint*`의 깨진(청크 누락/절단) S3 객체를 가리키면 `retrieveCompletedCheckpoint`가 즉시 예외를 던져 복구 전체가 중단된다 — Flink는 깨진 최신 핸들을 건너뛰고 이전 체크포인트(`checkpointID-(N-1)`)로 자동 폴백하지 않는다. 따라서 `state.checkpoints.num-retained`만 늘려도 깨진 최신 핸들이 ConfigMap에 남아 있는 한 동일하게 CrashLoop가 발생한다.

## 예방: Flink 저장소 동기 쓰기 (#412)

**실측(저장소/렌더):** `01a-seaweedfs-flink-fsync.yaml`의 멱등 Sync hook은
wave 0 `lakekeeper-bootstrap`의 lake 버킷 생성 뒤 wave 1에서
`fs.configure -locationPrefix=... -fsync -apply`를 실행한다. 기본 위치는
`/buckets/beluga-lake/flink-system/`이며 HA·checkpoint 경로와 같은
`flink.storage.bucket`, `flink.storage.systemPrefix` 값에서 파생한다.
`fs.configure` 결과를 출력하고 정확한 위치에 `fsync: true`가 없으면 실패한다.
FlinkDeployment는 wave 0을 유지하므로 복구와 독립적이며, 최초 설치에서는 hook
성공 전 쓰기 창이 남는다. 기존 손상 핸들은 복구하지 않는다. hook 완료 전에는
예방 설정이 활성화됐다고 판단하지 않는다.

**추론(내구성 효과):** fsync는 해당 PUT마다 디스크 동기화를 기다려, 승인됐지만
볼륨에 영속화되지 않은 쓰기 창을 줄인다. 파일시스템·장치·VM 장애 생존이나
filer 메타데이터와 볼륨 데이터의 원자성을 보장하지 않고 기존 missing needle도
고치지 않는다. Flink가 손상된 HA 핸들을 허용하게 만들지 않으므로 남은 손상은
위 복구 절차로 처리한다. `D-FSYNC-1`은 Iceberg 데이터 PUT의 디스크 동기화 비용을
피하려고 기본 적용을 Flink 제어 상태로 제한한다. 탈출구는
`seaweedfs.fsyncPrefixes`에 템플릿 형태의 절대 버킷 경로를 추가하는 것이며
Flink 위치는 필수다. 목록에서 제거해도 이미 적용된 SeaweedFS 규칙은 삭제되지
않으므로 명시적 삭제는 별도 검토한다. 전체 저장소 fsync나 버전 변경은 없다.

**실측(저장소 조사):** SeaweedFS는 `weed server -dir=/data`로 실행되고
`/data`에 `seaweedfs-data` PVC를 마운트한다. 차트에는 `filer.toml`이나 명시적
filer store 경로가 없다. **추론·오프라인 미검증:** `fs.configure`는 컨테이너
로컬 파일 대신 filer entry `/etc/seaweedfs/filer.conf`에 설정을 저장하며,
내장 filer store는 PVC에 영속화될 것으로 예상한다. 실제 내장 store 디렉터리와
재시작 후 보존은 배포된 4.41에서 확인해야 한다. PVC 마운트만으로 증명되지 않는다.

**To confirm live (이번 변경에서 미실행):** hook 완료와 로그의 정확한 위치·
`fsync: true`를 확인하고
`KUBECONFIG=<격리-config> bash tests/09-seaweedfs-authz-live.sh`를 실행한다.
운영자가 승인한 SeaweedFS pod 재시작 뒤 **ArgoCD sync가 규칙을 재적용하기 전**
같은 검사를 반복하고 filer store 위치를 조사한다. 새 Flink checkpoint와 복구도
별도 확인한다. 정적 검사는 전원 차단 내구성을 증명하지 않는다. hook은 저장소의
SeaweedFS 4.41 이미지 태그를 재사용한다. 검증된 digest는 로컬에 없어 추가 확보가 필요하다.
