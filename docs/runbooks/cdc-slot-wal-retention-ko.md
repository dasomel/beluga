# CDC 복제 슬롯 WAL 보존

[English](cdc-slot-wal-retention.md) | 한국어

대상은 Debezium 3.6.1.Final, CNPG 1.30.0, PostgreSQL 17.6이며 버전 원천은
[VERSIONS.md](../../VERSIONS.md)다. 이번 변경은 오프라인에서만 검증했다. 아래 사고 관측은
새 라이브 실행이 아니라 보존된 2026-11-12 증거에 근거한다.

## 예방과 배포 순서

`shop-cdc`는 `beluga_shop_slot`을 유지하며 기존 기본 publication 이름
`dbz_publication`을 명시한다. `publication.autocreate.mode=filtered`는 기존
publication도 `table.include.list`에 맞춰 갱신한다. orders/customers에
`public.cdc_heartbeat`를 추가했다. 이 모드에서는 목록에서 빼면 pgoutput publication에서도
빠지므로 heartbeat 쓰기가 전달되지 않는다. `heartbeat.interval.ms=10000`과
`heartbeat.action.query`의 id=1 UPSERT가 업무 테이블이 한가해도 shop에서 변경을 만든다.
CHECK 제약으로 현재 행은 하나이며 UPDATE의 dead tuple은 autovacuum이 회수해야 한다.

seed Job은 기존 커넥터 사용자이자 소유자인 `beluga_admin`으로 테이블을 만들고
SELECT(스냅숏/충돌 읽기), INSERT, UPDATE를 명시 부여한다. 시퀀스 권한은 필요 없다.
생성된 `db-roles.sql` 본문은 변경하지 않는다. 등록은 기존과 같은 멱등
`PUT /connectors/shop-cdc/config`이며 wave 0 seed 완료 뒤 Sync wave 1에서 실행된다.
기존 커넥터도 갱신하지만 PUT 성공은 task RUNNING이나 publication 반영의 증거가 아니다.

`03-cdc-heartbeat-topics.yaml`의 GitOps KafkaTopic 두 개가 테이블 CDC 토픽
`cdc.shop.public.cdc_heartbeat`와 Debezium 자체 heartbeat 토픽
`__debezium-heartbeat.cdc.shop`(prefix 명시)을 만든다. 각각 1 partition/RF1,
delete 보존 1일, segment rolling 1시간이다. 두 토픽 생성은 broker/Connect 자동 생성
기본값에 의존하지 않는다. 기존 업무 토픽 자동 생성은 유지한다. Flink SQL은
orders/customers/events 토픽 이름을 정확히 지정하므로 두 heartbeat 토픽을 소비하지 않는다.

`max_slot_wal_keep_size=1GB`는 선언된 5Gi PGDATA PVC, CNPG 기본
`wal_keep_size=512MB`, PostgreSQL 기본 `max_wal_size=1GB`를 고려한 예산이다.
이들은 서로 겹치는 보존 제약이며 단순 합산 예약 공간이 아니다. checkpoint 시 지연 슬롯이
`wal_status=lost`가 되어 재스냅숏 검토가 필요할 수 있다. 노드 전체 eviction보다 이를 택한다.
전체 디스크 hard cap은 아니며 checkpoint 사이 초과, 아카이빙 실패, DB 성장, 다른 볼륨이
여전히 노드를 채울 수 있다. 저장 공간/트래픽 변경 후 다시 산정한다.

**사고 클러스터에 이 변경을 sync하기 전에 Kafka를 복구하고 기존 슬롯 적체를 1GiB 미만으로
줄인다.** 22GB 적체 상태에서 상한을 적용하면 다음 checkpoint가 슬롯을 무효화할 수 있다.
heartbeat 없이는 따라잡지 못한다면 검토된 단계별 GitOps 배포(스키마/토픽/커넥터 먼저,
따라잡은 뒤 상한)를 사용한다. ArgoCD self-heal 때문에 원천 변경으로 반영해야 한다.
seed ConfigMap은 seed 훅 재실행이 필요하고 커넥터는 PUT으로 적용된다.
실제로 둘 다 실행됐는지 확인한다. 아래 훅 주의사항은 라이브에서 관측된 사례다.

## 두 번째 원인: nodefs의 Connect 로그

사고에는 디스크 소비자가 둘 있었다. imagefs의 보존 WAL 외에도 Connect의
`/kafka/logs` emptyDir가 **19GB 루트 파일시스템(nodefs)**을 사용했다.
시간별 `connect-service.log.YYYY-MM-DD-HH`에 보존·크기 상한이 없었다.
평소 약 68KB/시간이던 로그가 Kafka 재접속 WARN 스택과 Metadata INFO로
약 1GB/시간, 11월 11일 하루 10.9GB까지 증가했다. 회전 로그 삭제 후 nodefs 사용률이
83%에서 28%로 줄었다. imagefs 정상은 nodefs 정상을 뜻하지 않는다.
[보존된 로그 증거](../../research/incidents/2026-11-12-cdc-slot-wal-disk-pressure/raw/09-connect-log-growth.txt).

`debezium-connect-logging`은 콘솔 전용 `log4j.properties`를
`/kafka/config/log4j.properties`에 읽기 전용 subPath로 마운트한다.
NetworkClient, Metadata, FetchSessionHandler를 ERROR로 제한한다. 재접속 WARN/INFO를
억제하는 방식이며 초당 메시지 수 제한은 아니다. 장애 진단 정보가 줄어드는 비용이 있으므로
필요할 때 GitOps로 WARN/INFO를 임시 복원한다. stdout은 kubelet 컨테이너 로그 회전에
의존하며 실제 설정과 파일시스템 집계는 라이브 확인이 필요하다. 파일 내용 checksum이
Pod 롤아웃을 유발한다. 배포 후 ConfigMap만 직접 수정했다면 승인된 rollout restart가 필요하다.

추가 방어: `kafka-logs` 256Mi(콘솔 전용이면 보통 미사용), `tmp` 128Mi,
ephemeral-storage request 128Mi / limit 512Mi다. emptyDir 384Mi에 런타임 로그·쓰기 계층
128Mi를 더한 예산으로 19GB nodefs 대비 작게 잡았다. request는 스케줄링 예산이며 실제
디스크 공간 예약이 아니다. kubelet은 주기 검사로 초과 Pod를 eviction하므로 **동기식
파일시스템 quota가 아니며** 노드 전체 압박을 완전히 막는다고 보장할 수 없다.
트래픽·저장 공간 실측 후 재산정한다. 기존 readOnlyRootFilesystem은 유지한다.

이미지가 마운트한 로그 설정을 무시해 파일 appender가 유지되면 상한은 지켜지지만 Pod가
`kafka-logs` 256Mi / ephemeral-storage 512Mi에 도달해 반복적으로 eviction·재생성된다
(장애 시 관측치 약 1GB/h 기준 약 15분마다). 이는 수용된 실패 방식이다(D-LOG-4): 노드 전체의
nodefs 대신 Pod 하나만 재시작한다. Connect eviction 반복(`kubectl -n streaming get events`)은
로깅 설정 미적용 신호로 보고, 한도를 올리지 말고 설정을 고친다.

오프라인 근거: [상류 3.6 진입점](https://github.com/debezium/container-images/blob/main/connect-base/3.6/docker-entrypoint.sh)은
`/kafka/config/log4j.properties`를 읽고 `KAFKA_LOG4J_OPTS`를 덮어쓴다.
`CONNECT_LOG4J_LOGGERS`로 root logger를 설정하며 `CONNECT_LOG4J_*` / `LOG_LEVEL`은
파일을 직접 편집한다. [3.6 properties](https://github.com/debezium/container-images/blob/main/connect-base/3.6/log4j.properties)는
**Log4j 1 properties 문법**으로 stdout과 DailyRollingFileAppender를 함께 사용한다.
마운트 파일 방식은 읽기 전용 파일에 env 기반 쓰기를 하지 않는다. 이 소스와 사고의 파일명·패턴은
일치하지만 고정 `quay.io/debezium/connect:3.6.1.Final` 이미지 계층은 여기서 검사하지 못했다
(Docker 소켓 거부, 레지스트리 DNS 실패). 소스 브랜치만으로 이미지의 정확한 로깅 구현/JAR
버전을 단정하지 않는다. 롤아웃 완료 전 실제 이미지의 진입점/설정 계약, 기동 성공, 콘솔 출력,
로거 레벨, Kafka 장애·시간 회전 경계를 지나는 동안 새 로그 파일 부재를 확인한다.
kubelet 로그 회전과 Pod별 eviction 집계도 실측해야 한다.

## 탐지 (읽기 전용)

리포 로컬 kubeconfig 또는 명시한 KUBECONFIG로
`bash tests/29-cdc-slot-wal-retention.sh`를 실행한다. 설정 사본을 격리하고 heartbeat,
양수 WAL 상한, 활성 pgoutput/shop 슬롯, 보존 WAL <1GiB, **모든** Connect Pod의
`/kafka/logs` 할당 사용량 <=200MiB(롤링 업데이트 중 구 Pod 포함), DiskPressure=False와
모든 노드 nodefs/imagefs 여유 >=20%(보고되면 containerfs도)를 검사한다.
로그 바이트, 보존 바이트, confirmed_flush_lsn, 파일시스템 여유 바이트/비율을 출력한다.
정보/권한 누락은 실패한다. pod exec와 nodes/proxy 읽기 권한이 필요하며 새 RBAC는
부여하지 않는다. 환경별 근거가 있을 때만 `CDC_WAL_MAX_BYTES`, `CONNECT_LOG_MAX_BYTES`,
`NODE_FS_MIN_FREE_PERCENT`로 기준을 바꾼다.

현재 VM은 CNPG 9187의 기본 `cnpg_pg_replication_slots_*`나 노드 파일시스템을 수집하지
않는다. CNPG custom query ConfigMap, 경보 평가/전달, 대시보드 프로비저닝 관례도 없다.
이 검사는 run-all에 등록한 시점 검사다. 알림이 필요하면 운영자가 외부 스케줄을 연결해야
하며 자동 관측·알림 구축은 남은 과제다.

## 복구 (운영자 전용, 변경은 사고 대응 승인 필요)

1. 정리 전 Events, 노드 디스크 사용, 커넥터 상태, 슬롯 LSN을 보존한다.
   **슬롯 삭제/강제 전진, Connect offset 초기화, pg_wal 파일 삭제는 하지 않는다.**
   모든 DB가 WAL을 공유하므로 shop 크기가 작아도 WAL은 클 수 있다.
2. 사고 대응 계획에 따라 안전한 무관 디스크 공간을 확보하거나 노드/볼륨을 확장한다.
   PostgreSQL/Kafka 데이터와 필요한 WAL은 보존한다. nodefs/imagefs 여유와
   DiskPressure 해소를 확인하고 Kafka가 재스케줄되어 준비되도록 기다린다.
3. Connect 및 shop-cdc task RUNNING, heartbeat 쿼리 권한,
   `pg_publication_tables`에서 `dbz_publication`의 세 테이블, 두 heartbeat 토픽을 확인한다.
   읽기 전용 검사를 실행하고 실패를 기록한다. 통과를 위해 기준을 완화하지 않는다.
4. primary에서 아래 SELECT를 30–60초 간격으로 반복해 confirmed_flush_lsn 전진과
   보존 바이트 감소를 확인한다. 상한을 넘는 지연 슬롯의 공간을 회수하려고 먼저 checkpoint를
   강제하지 않는다.

   ```sql
   SELECT slot_name, active, wal_status, restart_lsn, confirmed_flush_lsn,
          pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn) AS retained_bytes
   FROM pg_replication_slots WHERE slot_name = 'beluga_shop_slot';
   SELECT schemaname, tablename FROM pg_publication_tables
   WHERE pubname = 'dbz_publication';
   SHOW max_slot_wal_keep_size;
   ```

5. 따라잡아 상한보다 충분히 낮아진 뒤 권한 있는 PostgreSQL 운영자가 primary에서
   `CHECKPOINT;`를 실행한다. 실제 pg_wal/노드 여유 회복과 archiver 정상 동작을 확인한다.
   `wal_keep_size` 때문에 일부 WAL이 남는 것은 정상이다.
6. `wal_status=lost`이거나 필요한 WAL이 없으면 자동 복구 시도를 중단한다.
   별도 승인된 계획으로 재스냅숏과 하류 정합성을 검토한다. `snapshot.mode=when_needed`는
   설정되어 있지만 기존 lost 슬롯의 안전한 복구를 증명하지 않는다. 조용히 슬롯을 삭제하지
   않는다. 복구 후 orders/customers 데이터 연속성과 모든 Flink 잡을 확인한다.

모든 명령은 공유 current-context 대신 격리 설정을 사용한다:

```bash
umask 077
CHECK_DIR="$(mktemp -d)"
trap 'rm -rf "$CHECK_DIR"' EXIT
kubectl --kubeconfig .kube/config config view --minify --flatten > "$CHECK_DIR/kubeconfig"
export KUBECONFIG="$CHECK_DIR/kubeconfig"
PRIMARY="$(kubectl -n database get cluster postgres-main -o jsonpath='{.status.currentPrimary}')"
# 위 SELECT는 psql -X -v ON_ERROR_STOP=1 -U postgres -d shop으로 실행한다.
# 실행 위치: kubectl -n database exec "$PRIMARY" -c postgres -- psql ...
```

위 격리 설정으로 커넥터 시크릿을 출력하지 않고 로그 크기·목록을 확인한다:

```bash
kubectl -n streaming exec deploy/debezium-connect -c connect -- du -sk /kafka/logs
kubectl -n streaming exec deploy/debezium-connect -c connect -- \
  find /kafka/logs -maxdepth 1 -type f -name 'connect-service.log.20??-??-??-??' -ls
```

승인된 긴급 정리에서는 먼저 시간별 샘플과 크기를 보존한 뒤 **닫힌 시간별 로그만** 삭제한다.
Kafka 데이터, offset, pg_wal은 지우지 않는다:

```bash
kubectl -n streaming exec deploy/debezium-connect -c connect -- \
  find /kafka/logs -maxdepth 1 -type f -name 'connect-service.log.20??-??-??-??' -delete
bash tests/29-cdc-slot-wal-retention.sh
```

활성 `connect-service.log`는 제외한다. 정리는 GitOps 콘솔 로깅 배포 전의 임시 조치다.
Pod가 교체되면 구 emptyDir와 로컬 로그가 사라진다.

## ArgoCD 훅 주의사항과 검증된 복구 경로

WAL 수정(main `2c1488f`) 당시 자동 selective sync가 `shop-seed` /
`debezium-register-shop`을 **재실행하지 않았다**. 이후 full sync도 “no more tasks”를
보고했다. 재실행되지 않은 정확한 근본 원인은 **확립되지 않았다**. Synced/Healthy나
full sync 요청만으로 훅 실행을 증명하지 않는다. 수동 작업 전 Application operation을
조회하고 사고 운영자와 조율해 훅 동시 실행을 피한다.

검증된 우회는 **main 브랜치 차트**를 `gitops/values/sso.yaml`로 렌더해 두 Job을
seed → 등록 순서로 실행한 것이다(11월 11일 약 17:57Z). 이후 커넥터/task RUNNING,
publication의 cdc_heartbeat 포함, idle shop의 flush LSN 전진이 관측됐다.
[보존된 검증](../../research/incidents/2026-11-12-cdc-slot-wal-disk-pressure/raw/08-post-fix-verification.txt).
아래 운영자 전용 절차는 완료 Job/finalizer를 재사용하지 않도록 새 이름의 사본을 만든다.
최신 main SHA와 실제 Application values를 먼저 검토한다(해당 profile/domain overlay 추가).
위 격리 설정과 `CHECK_DIR`를 쓰며 커넥터 전체 설정을 출력하지 않는다.

```bash
MAIN_REV="$(git rev-parse origin/main)"  # 실행 전 이 main 리비전을 검토한다
git archive "$MAIN_REV" gitops/charts/beluga-data gitops/values/sso.yaml | tar -x -C "$CHECK_DIR"
KUBECONFIG=/dev/null helm template "$CHECK_DIR/gitops/charts/beluga-data" \
  -f "$CHECK_DIR/gitops/values/sso.yaml" > "$CHECK_DIR/main-jobs.yaml"
```

검토한 두 Job만 추출한다:

```bash
python3 - "$CHECK_DIR" <<'PY'
import pathlib, sys, time, yaml
root = pathlib.Path(sys.argv[1])
docs = [d for d in yaml.safe_load_all((root / 'main-jobs.yaml').read_text()) if d]
for name, ns in [('shop-seed', 'database'), ('debezium-register-shop', 'streaming')]:
    jobs = [d for d in docs if d.get('kind') == 'Job'
            and d['metadata'].get('namespace') == ns and d['metadata']['name'] == name]
    assert len(jobs) == 1, name
    job = jobs[0]
    job['metadata']['name'] = name + '-recovery-' + str(int(time.time()))
    job['metadata'].pop('annotations', None)  # Argo 훅이 아닌 독립 복구 사본
    (root / (name + '.yaml')).write_text(yaml.safe_dump(job))
PY
(
  set -eu
  for job in shop-seed debezium-register-shop; do
    kubectl create -f "$CHECK_DIR/$job.yaml"
    kubectl wait --for=condition=complete --timeout=600s -f "$CHECK_DIR/$job.yaml"
  done
  bash tests/29-cdc-slot-wal-retention.sh
)
```

seed 실패 시 중단하고 재시도 전 Job 상태/로그를 조사한다. 위 절차대로 task RUNNING,
publication 포함, 반복 LSN 전진도 확인한다. 훅 재실행 동작은 별도 ArgoCD 조사 대상이며
이번 로깅 변경에서 해결됐다고 주장하지 않는다.

## 근거와 검증 한계

- [Debezium 3.6 PostgreSQL 문서](https://debezium.io/documentation/reference/3.6/connectors/postgresql.html): filtered publication, heartbeat 쿼리·토픽 이름.
- [CNPG v1.30.0 설정 소스](https://github.com/cloudnative-pg/cloudnative-pg/blob/v1.30.0/pkg/postgres/configuration.go): fixed/blocked 목록에 `max_slot_wal_keep_size`가 없고 `wal_keep_size` 기본값은 512MB다. 소스상 설정 가능하지만 배포된 webhook 수락·실제 적용은 라이브 확인이 필요하다.
- [PostgreSQL 17 복제 설정](https://www.postgresql.org/docs/17/runtime-config-replication.html): checkpoint 시점 슬롯 보존 제약.

라이브 잔여 항목: seed 권한/훅 순서, 기존 publication 갱신, pgoutput heartbeat 전달,
토픽 준비, task/offset flush, 업무 테이블 idle 중 confirmed_flush_lsn 전진, CNPG 수락/reload,
checkpoint 공간 회수, nodes/proxy 권한, Kafka/Flink 연속성. 정적 렌더는 이를 증명하지 않는다.
