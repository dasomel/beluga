# CDC 복제 슬롯 WAL 보존

[English](cdc-slot-wal-retention.md) | 한국어

대상은 Debezium 3.6.1.Final, CNPG 1.30.0, PostgreSQL 17.6이며 버전 원천은
[VERSIONS.md](../../VERSIONS.md)다. 이 변경에서 라이브 복구는 수행하지 않았다.

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
seed ConfigMap은 seed 훅 재실행으로, 커넥터는 PUT으로 적용되며 이 변경에 Deployment
재시작은 필요하지 않다.

## 탐지 (읽기 전용)

리포 로컬 kubeconfig 또는 명시한 KUBECONFIG로
`bash tests/29-cdc-slot-wal-retention.sh`를 실행한다. 설정 사본을 격리하고 heartbeat,
양수 WAL 상한, 활성 pgoutput/shop 슬롯, 보존 WAL <1GiB, DiskPressure=False와
모든 노드 nodefs/imagefs 여유 >=20%(보고되면 containerfs도)를 검사한다.
보존 바이트, confirmed_flush_lsn, 파일시스템 여유 바이트/비율을 출력한다.
정보/권한 누락은 실패한다. pod exec와 nodes/proxy 읽기 권한이 필요하며 새 RBAC는
부여하지 않는다. 환경별 근거가 있을 때만 `CDC_WAL_MAX_BYTES`,
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

## 근거와 검증 한계

- [Debezium 3.6 PostgreSQL 문서](https://debezium.io/documentation/reference/3.6/connectors/postgresql.html): filtered publication, heartbeat 쿼리·토픽 이름.
- [CNPG v1.30.0 설정 소스](https://github.com/cloudnative-pg/cloudnative-pg/blob/v1.30.0/pkg/postgres/configuration.go): fixed/blocked 목록에 `max_slot_wal_keep_size`가 없고 `wal_keep_size` 기본값은 512MB다. 소스상 설정 가능하지만 배포된 webhook 수락·실제 적용은 라이브 확인이 필요하다.
- [PostgreSQL 17 복제 설정](https://www.postgresql.org/docs/17/runtime-config-replication.html): checkpoint 시점 슬롯 보존 제약.

라이브 잔여 항목: seed 권한/훅 순서, 기존 publication 갱신, pgoutput heartbeat 전달,
토픽 준비, task/offset flush, 업무 테이블 idle 중 confirmed_flush_lsn 전진, CNPG 수락/reload,
checkpoint 공간 회수, nodes/proxy 권한, Kafka/Flink 연속성. 정적 렌더는 이를 증명하지 않는다.
