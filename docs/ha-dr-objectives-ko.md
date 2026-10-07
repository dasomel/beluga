# HA 및 재해 복구 목표 (제안)

[English](ha-dr-objectives.md) | 한국어

[Issue #5](https://github.com/dasomel/beluga/issues/5) ("Establish HA and disaster-recovery objectives for the data platform") 관련 문서.

> **상태: 제안(PROPOSAL). 문서 전용.** 매니페스트, values 파일, 스크립트, 백업 스케줄을 변경하지 않는다. 저장소
> 관련 서술에는 이 문서를 작성한 커밋에서 읽은 `file:line`을 붙였다. 라이브 관련 서술은 2026-10-07(약 14:07 UTC)에 실행한 읽기 전용
> `kubectl` 명령에서 나왔으며 **L#** 로 표시한다. 측정하지 않은 항목은 **not verified live** 이다. 외부
> 서술은 공식 페이지 `[S#]`(접근일 2026-10-07)를 인용하거나 **no official recommendation** 이라고 밝힌다. **RPO, RTO,
> 가용성 목표는 Owner decisions** 이다. 이 문서는 선택지와 각 선택지의 근거를 제시할 뿐, 목표를 사실로 제시하지 않는다.
> (영문 라벨은 그대로 유지한다: **Proposed** = 제안, **Owner decision** = 소유자 결정, **not verified live** = 라이브 미검증,
> **no official recommendation** = 공식 권고 없음.)

관련 문서: [환경 프로필](environment-profiles-ko.md) (HA 설정을 담게 될 프로덕션 스타일 프로필),
[데이터 라이프사이클 정책](data-lifecycle-policy-ko.md) (보호 대상 데이터의 보존).

---

## 1. 목적 및 이슈 매핑

| Issue #5 인수 기준 | 다루는 위치 |
|---|---|
| RPO/RTO 목표가 문서화되어 있다 | 4.2절(계층별 선택지, **Owner decision**) |
| 프로덕션 프로필에 의도하지 않은 단일 인스턴스 핵심 데이터스토어가 없다 | 2절, 4.3절 |
| PostgreSQL 페일오버를 시연했다 | 5절(여기서는 실행하지 않음) |
| 대상이 될 수 있는 브로커를 잃어도 Kafka가 계속 동작한다 | 4.3절, 5절(여기서는 실행하지 않음) |
| 클린 클러스터에서 백업과 복원을 시연했다 | 4.4절, 5절(여기서는 실행하지 않음) |
| 복구 검증이 `tests/`에서 반복 가능하거나 문서화되어 있다 | 5절, 작업 T4 |

README는 이 프로젝트가 개인/학습 규모이며 프로덕션 준비를 주장하지 않는다고 밝힌다([`README.md:7`](../README.md#L7), [`:16`](../README.md#L16)). 따라서 현재 구성은 이슈가 유지하라고 요구하는 **비프로덕션 프로필**이다.

---

## 2. 현재 상태 (확인됨)

### 2.1 저장소와 라이브 비교

| 컴포넌트 | 저장소 | 라이브 (L1, 읽기 전용) | 관찰된 장애 도메인 |
|---|---|---|---|
| PostgreSQL (CNPG 1.30.0, PG 17.6) | `instances: 1`, 5Gi ([`02-cnpg.yaml:7`](../gitops/charts/beluga-data/templates/02-cnpg.yaml#L7), [`:17`](../gitops/charts/beluga-data/templates/02-cnpg.yaml#L17)) | `worker-2`에 파드 1개. PVC `local-path`는 `worker-2`. PDB min 1 / allowed disruptions 0 | 노드 하나 |
| SeaweedFS (S3) | `replicas: 1`, 5Gi ([`01-seaweedfs.yaml:61`](../gitops/charts/beluga-data/templates/01-seaweedfs.yaml#L61), [`:239-246`](../gitops/charts/beluga-data/templates/01-seaweedfs.yaml#L239-L246)) | 파드 1개. PV는 `master-1`(컨트롤 플레인 노드). 볼륨 한도(Proposed, 이슈 #5): `-volume.max=48` x `-master.volumeSizeLimitMB=1024` = 명목 48GiB(PVC 요청은 강제되지 않음; 2.1a 참고), [`01-seaweedfs.yaml:175-205`](../gitops/charts/beluga-data/templates/01-seaweedfs.yaml#L175-L205) 참고 | 노드 하나 |
| Kafka (Strimzi, Kafka 4.3.0, KRaft) | `KafkaNodePool` 레플리카는 values에서 가져옴(`strimzi.replicas: 3`), 역할 controller+broker, 5Gi JBOD, `deleteClaim: false`. offsets/transaction/기본 복제 계수 1, transaction min ISR 1, `min.insync.replicas` 없음 ([`values.yaml:25`](../gitops/charts/beluga-data/values.yaml#L25), [`03-strimzi-kafka.yaml:25-31`](../gitops/charts/beluga-data/templates/03-strimzi-kafka.yaml#L25-L31), [`:101-104`](../gitops/charts/beluga-data/templates/03-strimzi-kafka.yaml#L101-L104)) | 노드 3개. PV: 브로커 0과 2는 `worker-3`, 브로커 1은 `master-1`. PDB min 2 / allowed 1. `KafkaTopic` 객체 없음(토픽은 브로커 기본값으로 생성되며 토픽 수준 RF는 **not verified live**). Strimzi `Warning KafkaMinInsyncReplicas` | 브로커 0과 2가 노드 하나를 공유 |
| Flink (오퍼레이터 1.15.0, Flink 1.20.0) | 세션 클러스터, JobManager 1개, HA 또는 체크포인트 디렉터리 키 없음 ([`05-flink-operator.yaml:10-20`](../gitops/charts/beluga-data/templates/05-flink-operator.yaml#L10-L20)) | 라이브 설정에는 `execution.checkpointing.mode/interval`만 있음. 잡 3개 실행 중, 오늘 10:19 UTC에 시작됨 | JobManager 파드 |
| Trino | 코디네이터 `replicas: 1`. 워커 `replicas: 1`은 `trino.workerEnabled`일 때만(기본값 `false`) ([`06-trino.yaml:235`](../gitops/charts/beluga-data/templates/06-trino.yaml#L235), [`:413`](../gitops/charts/beluga-data/templates/06-trino.yaml#L413), [`:436`](../gitops/charts/beluga-data/templates/06-trino.yaml#L436), [`values.yaml:74`](../gitops/charts/beluga-data/values.yaml#L74)) | 코디네이터 1/1과 워커 1/1이 모두 존재(차트 기본값과 다름. 이유는 조사하지 않음) | 단일 코디네이터 |
| 기타 | Lakekeeper, Keycloak, OpenFGA, OPA, OpenLDAP, APISIX, ArgoCD, Superset, Airflow, OpenMetadata | 모두 레플리카 1개(L1). OpenLDAP PV는 `master-1`. APISIX etcd는 `worker-2`에 레플리카 1개 | 컴포넌트별 |
| 컨트롤 플레인 | 서버 노드 `master-1` 하나 | 컨트롤 플레인 노드 1개(L2). k3s 데이터스토어 유형은 **not verified live** | 단일 컨트롤 플레인 |
| 스토리지 클래스 | `local-path`뿐, reclaim `Delete` | PV node affinity가 모든 볼륨을 한 노드에 고정(L3) | 노드 손실 = 볼륨 손실 |

### 2.1a SeaweedFS 볼륨 슬롯 (런북, 수치는 **Proposed**, 이슈 #5)

볼륨 슬롯은 모든 버킷이 공유하는 하나의 풀이다. `weed server -volume.max`가 소진되면 **모든** collection의 새 볼륨 할당이 실패하므로 CNPG 백업과 `beluga-lake`(Iceberg/Flink) 쓰기가 함께 실패한다(`PutObject InternalError`, 마스터 로그 `created 0: Not enough data nodes found!`).

- 제안 한도: `-volume.max=48`, `-master.volumeSizeLimitMB=1024`(명목 48GiB), `WEED_MASTER_VOLUME_GROWTH_COPY_1=1`. 모델·산술은 [`01-seaweedfs.yaml`](../gitops/charts/beluga-data/templates/01-seaweedfs.yaml) 주석과 `scripts/ci/check-seaweedfs-volume-limits.py` 참고(30d 보존 x ~97MB/일 + 적체 WAL 445개 ~ 3.1GB ~ 볼륨 4개; 기존 볼륨 8개 중 7개는 기본 collection이 고정; growth env 적용 시 수요 17, 무시되면 43: 8 + 7 + 7 + 3 x 7).
- 읽는 법: `weed shell` -> `volume.list`; DataNode 줄의 `hdd(volume:N/M ...)`에서 N = 사용 중 볼륨 수, M = `-volume.max`.
- growth env 적용 확인(성공 기준): 첫 백업 쓰기 후 `volume:9/48`이고 백업 collection의 볼륨이 정확히 1개여야 한다. 7개가 더 늘어 있으면 env가 무시된 것이다.
- 제안 알림 임계: N >= 36/48(75%) — N이 M에 닿기 전에 점검하고 `-volume.max`를 올린다.
- 5Gi PVC 요청은 강제되지 않으므로(`local-path`, `volumeClaimTemplates` 불변) 명목 용량이 5Gi를 넘는 것은 수용된 결정이다. 호스트 디스크 모니터링 또는 실제 쿼터 설정은 소유자 결정 대기.
- 롤백: 인자를 되돌리면 파드가 재시작된다. 낮춘 `-volume.max`를 초과하는 기존 볼륨도 계속 서비스될 것으로 예상하나 **미검증**.

### 2.2 백업 상태

| 사실 | 근거 |
|---|---|
| CNPG는 in-tree `barmanObjectStore`로 **같은 클러스터의 SeaweedFS**(자체가 `master-1`의 단일 레플리카)에 있는 `s3://beluga-postgres-backups/`로 백업한다. WAL은 gzip, `retentionPolicy: 30d`, 매일 02:00 UTC | [`02-cnpg.yaml:57-71`](../gitops/charts/beluga-data/templates/02-cnpg.yaml#L57-L71), [`:81`](../gitops/charts/beluga-data/templates/02-cnpg.yaml#L81) |
| **라이브: 예약 백업 둘 다 완료되지 못했다.** `postgres-main-backup-20261005020000`은 2026-10-05T02:00:00Z에 시작해 2026-10-07T02:08:09Z에 `failed`로 표시됐고, 두 번째 `Backup` 객체는 2026-10-07T02:09:09Z에 생성됐으며(이름은 여전히 20261006) 09:58:43Z에 `failed`로 표시됐다. 둘 다 "instance manager was restarted during backup" 오류를 갖고, `startedAt`/`stoppedAt`이 없으며, 각각 약 2일, 약 7시간 50분 동안 끝나지 않은 채 남아 있었다. 즉 백업이 **멈춰 있었고**(hung), 재시작은 그것을 끝냈을 뿐이다(재시작, 아마 VM 재시작은 조사하지 않았다). `lastSuccessfulBackup`과 `firstRecoverabilityPoint`는 비어 있다(L4). **복구 체인이 깨진 원인(검증됨):** 클러스터 조건 `ContinuousArchiving`이 2026-10-04T07:19:43Z부터 `False`이고("unexpected failure invoking barman-cloud-wal-archive: exit status 4"), 인스턴스 로그에 `barman-cloud-check-wal-archive ... ERROR ... An error occurred (AccessDenied) when calling the CreateBucket operation: Access Denied`가 반복된다(최근 로그 5000줄 중 766줄 일치). 따라서 WAL 아카이빙은 부트스트랩 이후 계속 실패했다. CNPG는 오브젝트 스토어 백업에 항상 WAL 아카이빙이 필요하다고 명시한다 [S1]. 멈춤의 원인이 아카이브 실패라는 것은 **가설**이다(읽기 전용으로 확인하지 못함) | `kubectl -n database get backup.postgresql.cnpg.io -o yaml`; `kubectl -n database get cluster postgres-main -o json` (status.conditions); `kubectl -n database logs postgres-main-1 --tail=5000 \| grep -c AccessDenied` |
| 저장소는 버킷 `beluga-postgres-backups`를 생성하지 않는다(참조는 목적지 경로와 S3 식별자 `postgres-backup-service`뿐이며, 이 식별자의 권한은 해당 버킷에 대한 `Read/Write/List/Tagging`이고 버킷 생성 권한은 없다). 이 권한만으로 barman-cloud가 충분하다는 주석은 라이브의 `CreateBucket` AccessDenied와 모순된다. 버킷이 존재하는지는 **검증하지 못했다**(오류는 버킷이 없다는 것과 일치하며, 이는 barman-cloud 동작에 대한 추론이다) | [`01-seaweedfs.yaml:5-7`](../gitops/charts/beluga-data/templates/01-seaweedfs.yaml#L5-L7), [`:35-37`](../gitops/charts/beluga-data/templates/01-seaweedfs.yaml#L35-L37), [`02-cnpg.yaml:57-59`](../gitops/charts/beluga-data/templates/02-cnpg.yaml#L57-L59) |
| CNPG는 복구에 물리 베이스 백업이 필요하며 WAL 아카이브만으로는 복구할 수 없다 [S1]. 따라서 현재는 복구 지점이 없다 | [S1] |
| **[S1]에서 검증됨:** in-tree `barmanObjectStore` 백업은 "deprecated from 1.26 in favor of the Barman Cloud Plugin, but still the default for backward compatibility"이며, 네이티브 백업/복구는 코어 오퍼레이터에서 CNPG-I 플러그인으로 점진적으로 이관(phase out)되고 있다. `spec.backup.retentionPolicy`도 deprecated이다. 저장소는 둘 다 사용한다(CNPG 1.30.0) | [`02-cnpg.yaml:57`](../gitops/charts/beluga-data/templates/02-cnpg.yaml#L57), [`:71`](../gitops/charts/beluga-data/templates/02-cnpg.yaml#L71) |
| Kubernetes 리소스 백업 도구는 없다("no Velero in Beluga"). 선언적 상태는 Git에 있으나, 부트스트랩이 생성한 자격 증명은 Git에 없다(부트스트랩마다 무작위) | [`portfolio-integration-matrix-ko.md:76`](portfolio-integration-matrix-ko.md#L76), [`01-argocd-bootstrap.sh:52`](../scripts/gitops/01-argocd-bootstrap.sh#L52) |
| Kafka, SeaweedFS(Iceberg 데이터), OpenLDAP, Keycloak realm(DB 경유)은 저장소에 선언된 백업이 없다 | `gitops/` 검색: CNPG 백업 리소스뿐 |

### 2.3 라이브 측정 (읽기 전용, 2026-10-07)

| # | 명령 | 결과 |
|---|---|---|
| L1 | `kubectl get deploy,sts -A`; `kubectl get pdb -A` | 모든 Beluga 워크로드가 레플리카 1개. PDB: `postgres-main-primary`(min 1, allowed 0), `beluga-kafka-kafka`(min 2, allowed 1), entity operator(allowed 1) |
| L2 | `kubectl get nodes` | 노드 4개, 컨트롤 플레인 1개 |
| L3 | `kubectl get pv -o json`, `kubectl get sc` | PV별 node affinity: Postgres `worker-2`. SeaweedFS, Kafka-1, OpenLDAP data/config `master-1`. Kafka-0과 Kafka-2 `worker-3`. APISIX etcd `worker-2`. reclaim `Delete` |
| L4 | `kubectl -n database get backup.postgresql.cnpg.io -o yaml`; `get scheduledbackups`; 클러스터 `status.conditions`; `logs postgres-main-1` | `Backup` 객체 2개, 둘 다 멈춘 뒤 `failed`(2.2 참고). `ContinuousArchiving=False`가 2026-10-04T07:19:43Z부터 계속되며 `AccessDenied ... CreateBucket`. `ScheduledBackup` `0 0 2 * * *`, 마지막 예약 2026-10-06T02:00Z |
| L5 | `kubectl -n streaming get kafka`, `kafkanodepool` | 노드 3개 `[controller, broker]`. Warning `KafkaMinInsyncReplicas`. 설정 RF 1 |
| L6 | API 서버 프록시를 통한 Flink REST (GET) | HA/체크포인트 디렉터리 키 없음 |

---

## 3. 인수 기준 대비 공백

| 기준 | 상태 | 공백 |
|---|---|---|
| RPO/RTO 문서화 | **Open** | 정의된 것이 없다 |
| 프로덕션 프로필에 의도하지 않은 단일 인스턴스 핵심 데이터스토어 없음 | **Open** | 프로덕션 스타일 HA values가 없다. 모든 데이터스토어가 인스턴스 하나다(2.1) |
| PostgreSQL 페일오버 시연 | **Open** | `instances: 1`이므로 페일오버가 불가능하다 |
| 대상이 될 수 있는 브로커를 잃어도 Kafka 유지 | **Open** | 브로커는 3개지만 RF가 1이다. 브로커 하나를 잃으면 그 파티션을 쓸 수 없게 되고, 브로커 0과 2가 노드를 공유하므로(L3) 노드 하나를 잃으면 컨트롤러/브로커 3개 중 2개가 사라진다 |
| 클린 클러스터에서 백업/복원 | **Open, blocked** | 유일한 백업 경로가 실패하고 있으며(L4) 그 대상은 컨트롤 플레인 노드의 싱글턴이다 |
| 반복 가능한 복구 검증 | **Open** | 없음 |

---

## 4. 제안 (모두 **Proposed**)

### 4.1 두 가지 프로필

현재 구성은 **학습 프로필**로 유지한다(HA 없음, 문서화된 RPO는 "best effort"). **프로덕션 스타일 HA 프로필**을 Helm values 레이어로 추가한다(메커니즘과 파일 이름은 환경 프로필 제안을 따른다). 노트북에서 필수여서는 안 된다.

### 4.2 RPO/RTO 및 가용성 선택지 (**Owner decision**)

수치 목표에 대한 **No official recommendation** 이 있으며, 목표는 업무상 필요에 따른다. 계층별 선택지:

| 계층 | 저장소 | 선택지 A (학습) | 선택지 B (HA 프로필) | 근거 |
|---|---|---|---|---|
| T1 관계형 | PostgreSQL (shop, `beluga_meta`, Keycloak/Lakekeeper/Airflow/OpenFGA 메타데이터) | RPO = 마지막 성공 백업(매일), RTO = 수동 복원 | RPO는 WAL 아카이브 간격 수준, RTO = 자동 페일오버 | CNPG는 WAL 아카이빙으로 리전 간에도 기본 제공 RPO <= 5분을 명시한다 [S1]. 페일오버는 기본적으로 즉시(`failoverDelay` 0)이며 RTO/RPO에 영향을 줄 수 있다 [S2]. 둘 다 베이스 백업이 존재한 뒤에만 성립한다(L4) |
| T2 이벤트 로그 | Kafka | RPO = 복제되지 않은 데이터는 손실될 수 있음 | 확인응답된 쓰기에 대해 RPO 0(`acks=all`, RF 3, `min.insync.replicas` 2) | Kafka 문서의 내구성 패턴: RF 3, min ISR 2, `acks=all` [S3]; 단 [S3]는 Kafka **4.1** 페이지이고 배포 버전은 4.3.0이다([`VERSIONS.md:28`](../VERSIONS.md#L28)). 채택 전에 4.3 페이지의 문구를 확인한다 |
| T3 레이크 데이터 | SeaweedFS (Iceberg 파일, 백업 대상) | 단일 사본 | 복제된 볼륨 또는 외부 S2 대상 | 고정된 SeaweedFS 버전의 복제 모드는 이 레인에서 **확인하지 않았다** |
| T4 처리 상태 | Flink 잡 | Kafka 오프셋에서 재구축 | Kubernetes HA + 내구성 스토리지의 체크포인트/세이브포인트 디렉터리 | Flink: HA가 없으면 JobManager 장애가 실행 중인 프로그램을 실패시킨다. HA는 JobGraph와 완료된 체크포인트를 영속화한다 [S4] |
| T5 컨트롤/ID | ArgoCD, Keycloak, OpenLDAP, APISIX, Lakekeeper | Git + DB에서 복원 | 컴포넌트가 지원하는 경우 레플리카 2개 이상 | 컴포넌트별 지원 여부는 **확인하지 않았다** |

### 4.3 HA 프로필 내용 (바뀌어야 하는 것. 여기서는 아무것도 하지 않음)

| 컴포넌트 | 제안 설정 | 비고 |
|---|---|---|
| CNPG | `instances` 2 또는 3, 노드 간 anti-affinity, 장애 도메인 밖의 백업 대상 | 인스턴스 수: **no official recommendation** 을 찾지 못함. 소유자가 비용에 따라 선택 |
| Kafka | offsets/transaction/기본 토픽의 RF 3, transaction min ISR 2, `min.insync.replicas` 2. 브로커를 노드 간에 분산(현재 둘이 `worker-3`을 공유). RF를 명시한 `KafkaTopic` | 브로커 3개 이상 필요(충족). 컨트롤러 쿼럼 산술은 여기서 공식 문서로 **확인하지 않았다** |
| SeaweedFS | 복제 또는 다중 인스턴스 토폴로지 | 먼저 버전별 문서를 읽어야 함 |
| Trino | 이 프로필에서는 워커를 기본으로 활성화. 두 번째 코디네이터가 검증되기 전까지 단일 코디네이터 파드는 알려진 SPOF로 남음 | 미검증 |
| Flink | `high-availability.type` kubernetes와 `high-availability.storageDir`. 체크포인트 디렉터리는 S2에 둠 [S4] | `last-state`/`savepoint` 업그레이드를 가능하게 함 [S5] |
| 컨트롤 플레인 | 서버 노드 3개(HA k3s) 또는 SPOF 수용 | k3s HA 모드는 여기서 **확인하지 않았다** |
| 스토리지 | 노드에 고정된 `local-path`는 노드 손실을 견딜 수 없음. 복제되는 스토리지 클래스 또는 애플리케이션 수준 복제 | 소유자 결정 |

### 4.4 백업 및 복원

1. 실패하는 백업을 먼저 고치고(T1), 그다음 복구 지점을 확인한다.
2. 백업 대상을 주 장애 도메인 밖에 둔다(두 번째 S3 엔드포인트 또는 클러스터 외부). 현재는 SeaweedFS 노드를 잃으면 주 데이터와 백업이 함께 사라지기 때문이다(2.2).
3. 복원 모델: CNPG 복구는 `bootstrap.recovery`로부터 **새** 클러스터를 만들며, 선택적으로 `targetTime`까지 복구한다 [S6]. 제자리(in-place) 복구가 아니다.
4. Kubernetes 리소스: 선언된 상태의 백업은 Git이다. 생성된 자격 증명은 Git에 없으므로 DR 설계에는 시크릿 에스크로 또는 재생성 정책이 필요하다(**Owner decision**. ADR-0002가 무작위 부트스트랩 생성을 문서화한다).
5. Kafka/Iceberg 데이터: 백업 방식이 정의되지 않았다. Kafka를 재생 가능한 소스(CDC 재스냅샷)로 볼지, MirrorMaker/백업이 필요한지 결정한다.
6. DR 런북 `docs/runbooks/disaster-recovery.md`: 순서 = 컨트롤 플레인, ArgoCD + 시크릿, CNPG 복원, SeaweedFS, Kafka, Lakekeeper 카탈로그, Flink 재제출, 검증.

---

## 5. 검증 및 테스트 아이디어

| 테스트 | 인수 신호 |
|---|---|
| 백업 최신성 프로브 (읽기 전용) | `lastSuccessfulBackup`이 비어 있거나 선택한 RPO보다 오래되면 0이 아닌 값으로 종료 |
| 복원 훈련 `tests/19-restore-verify.sh` (랩) | 오브젝트 스토어에서 스크래치 네임스페이스로 복구. `shop`의 행 수가 복구 지점의 원본과 같음 |
| PostgreSQL 페일오버 (HA 프로필) | 프라이머리 파드를 삭제. 레플리카가 승격됨. 측정된 중단 시간을 RTO 증적으로 기록 |
| Kafka 브로커 손실 (HA 프로필) | 브로커 하나를 중지. `acks=all`로 생산과 소비가 여전히 성공 |
| Flink JobManager 손실 (HA 프로필) | 재제출 없이 마지막 체크포인트에서 잡이 재개됨 |
| 클린 클러스터 DR | Git과 복원된 자격 증명, CNPG 백업으로 재구축한 뒤 `tests/run-all.sh` |

훈련은 리허설 클러스터에서만 실행하며, 여기서는 어느 것도 실행하지 않았다.

---

## 6. 남은 소유자 결정

| # | 결정 | 권고 (근거) |
|---|---|---|
| D1 | 계층별 RPO/RTO | 학습 프로필은 선택지 A로 시작하고, D2가 정해지면 선택지 B를 프로덕션 목표로 작성 |
| D2 | 요구 가용성(계획 시간, 단일 사이트 vs 다중 사이트) | 단일 사이트 먼저. 공식 수치 권고 없음 |
| D3 | PostgreSQL 인스턴스 수(2 vs 3) | 3이면 하나를 재구축하는 동안에도 레플리카가 있음. 용량과 대조해 확인 |
| D4 | 백업 대상 위치 | 주 장애 도메인 밖(2.2) |
| D5 | 자격 증명 에스크로 vs 재생성 | 루트 자격 증명 시크릿을 에스크로. 재생성하면 복원된 DB 롤이 깨짐(추론, 훈련에서 테스트) |
| D6 | Kafka를 재생 가능한 소스로 볼지 백업되는 저장소로 볼지 | CDC는 재생 가능으로, 재생 불가능한 토픽만 백업 |
| D7 | HA 컨트롤 플레인 | 보류. 수용된 위험으로 문서화 |

---

## 7. 후속 구현 작업 (순서대로, 작게)

| # | 작업 | 인수 테스트 아이디어 |
|---|---|---|
| T1 | 멈추는 CNPG 백업과 실패하는 WAL 아카이빙을 진단하고 고친다. 진단 순서(읽기 전용 우선): (1) 버킷 `beluga-postgres-backups`가 존재하는가, 어떤 S3 식별자가 생성할 수 있는가; (2) `postgres-backup-s3-credential` Secret이 존재하고 키 쌍이 `postgres-backup-service` 식별자와 일치하는가(존재와 키 이름만 확인하고 값은 절대 읽지 않는다); (3) 네트워크 경로: `AccessDenied` 응답은 엔드포인트가 도달 가능하고 응답한다는 뜻이므로 원인일 가능성이 낮다(`database` 네임스페이스에는 NetworkPolicy가 없고, `storage`에는 `default-deny-all`, `allow-cluster-dns`, `seaweedfs-data-plane-restrict`가 있으며 그 영향은 검증하지 않았다); (4) SeaweedFS S3 엔드포인트 상태와 식별자 설정; (5) 베이스 백업이 실패하지 않고 멈추는 이유 | `completed` Backup, `ContinuousArchiving=True`, 설정된 `firstRecoverabilityPoint` |
| T2 | `scripts/ops/`에 읽기 전용 백업 최신성 검사를 추가한다 | 현재 상태에서 실패(L4) |
| T3 | 1.26부터 deprecated인 in-tree `barmanObjectStore`/`retentionPolicy` [S1]에서 Barman Cloud Plugin으로 이전한다(또는 유지하기로 한 Owner decision을 기록한다). `check-postgres-backup-config.py`도 갱신한다 | 새 메커니즘에서 정적 검사와 복구 드릴이 통과 |
| T4 | 복원 훈련 스크립트(스크래치 네임스페이스) | 행 수 일치 |
| T5 | CNPG와 Kafka용 HA values 레이어(RF 3, min ISR 2, anti-affinity) | `helm template`이 렌더링됨. 페일오버/브로커 손실 훈련 통과 |
| T6 | Flink HA와 체크포인트 디렉터리 | JobManager를 삭제해도 잡이 유지됨 |
| T7 | DR 런북과 시크릿 결정(D5) | 클린 클러스터 재구축 증적 |

---

## 출처

모두 2026-10-07에 접근했다.

| ID | 출처 |
|---|---|
| S1 | CloudNativePG 1.30 backup: https://cloudnative-pg.io/docs/1.30/backup |
| S2 | CloudNativePG 1.30 failover: https://cloudnative-pg.io/docs/1.30/failover |
| S3 | Apache Kafka 4.1 topic configs (`min.insync.replicas`): https://kafka.apache.org/41/configuration/topic-configs/ |
| S4 | Flink 1.20 HA overview: https://nightlies.apache.org/flink/flink-docs-release-1.20/docs/deployment/ha/overview/ |
| S5 | Flink Kubernetes Operator 1.15 job management: https://nightlies.apache.org/flink/flink-kubernetes-operator-docs-release-1.15/docs/custom-resource/job-management/ |
| S6 | CloudNativePG 1.30 recovery: https://cloudnative-pg.io/docs/1.30/recovery |
