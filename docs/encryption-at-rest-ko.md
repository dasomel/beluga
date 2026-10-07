# 저장 데이터 암호화 및 키 관리 (제안)

[English](encryption-at-rest.md) | 한국어

이슈 [#16](https://github.com/dasomel/beluga/issues/16) ("Define encryption-at-rest and key-management controls") 관련.

> **상태: 제안. 문서만 변경.** 이 문서는 매니페스트, 스크립트, `VERSIONS.md` 항목, 정책을 변경하지 않습니다. 저장소에 대한 모든 서술은
> 커밋 `9f74c2b`에서 읽은 `file:line`을 가집니다. 라이브 클러스터에 대한 서술은 2026-10-07에 실행한 읽기 전용 `kubectl` 명령
> ([2.2절](#22-라이브-상태-2026-10-07-실측))에서 나왔거나 **라이브 미검증**으로 표시했습니다. 외부 사실은 [출처](#출처)(접근일 2026-10-07)를 인용하며,
> 공식 수치를 찾지 못한 경우 "공식 권고 없음"으로 적었습니다. **제안** 항목은 정책이 되기 전에 소유자 결정이 필요합니다.

관련 문서: [`docs/data-lifecycle-policy.md`](data-lifecycle-policy.md) (백업 버킷의 보존 및 Object Lock),
[`docs/privileged-access-inventory.md`](privileged-access-inventory.md) (자격증명 출처), [`docs/environment-profiles.md`](environment-profiles.md) (보안 프로파일),
[`docs/certificate-lifecycle.md`](certificate-lifecycle.md) (TLS 키, 이슈 #47).

## 1. 목적과 이슈 매핑

이슈 #16은 보호 대상 데이터 분류(PostgreSQL, Kafka 볼륨, SeaweedFS 데이터, Kubernetes Secret, 백업)마다 저장 시 보호 메커니즘, 문서화된 키 수명주기,
암호화되고 접근 통제되는 백업, 반복 가능한 회전/폐기, 보안 프로파일 검증을 요구합니다. 이 문서는 현재 존재하는 것을 목록화하고 측정 가능했던 것을 기록하며 계층형 모델을 제안합니다. 구현은 하지 않습니다.

## 2. 현재 상태 (검증됨)

### 2.1 저장소가 정의하는 것

| 데이터 분류 | 사실 | 출처 |
|---|---|---|
| PostgreSQL (모든 애플리케이션 DB: shop, lakekeeper, keycloak, openfga, openmetadata, `beluga_meta`) | CNPG PVC, 5Gi, 기본 StorageClass: Cluster spec에 암호화 설정 없음; 인스턴스 1개 | [`02-cnpg.yaml:7`](../gitops/charts/beluga-data/templates/02-cnpg.yaml#L7), [`:16-17`](../gitops/charts/beluga-data/templates/02-cnpg.yaml#L16-L17), [`:27-31`](../gitops/charts/beluga-data/templates/02-cnpg.yaml#L27-L31) |
| Kafka | 5Gi 영구 클레임 볼륨 3개(JBOD, `deleteClaim: false`): 저장 시 설정 없음 | [`03-strimzi-kafka.yaml:25-31`](../gitops/charts/beluga-data/templates/03-strimzi-kafka.yaml#L25-L31) |
| SeaweedFS (레이크하우스 데이터, Postgres 백업) | StatefulSet PVC 5Gi: `weed server -s3 ... -dir=/data`로 시작하며 `-encryptVolumeData`나 SSE 설정 없음 | [`01-seaweedfs.yaml:143-150`](../gitops/charts/beluga-data/templates/01-seaweedfs.yaml#L143-L150), [`:185-191`](../gitops/charts/beluga-data/templates/01-seaweedfs.yaml#L185-L191) |
| OpenLDAP, APISIX etcd | PVC 2Gi/1Gi 및 1Gi | [`openldap.yaml:55-74`](../gitops/charts/beluga-platform/templates/openldap.yaml#L55-L74), [`apisix-infra.yaml:10-19`](../gitops/charts/beluga-platform/templates/apisix-infra.yaml#L10-L19) |
| PostgreSQL 백업 | 동일 SeaweedFS의 S3 버킷 `beluga-postgres-backups`, 평문 `http://`; gzip 압축만; 보존 30d; `barmanObjectStore`; `encryption` 필드 없음 | [`02-cnpg.yaml:56-71`](../gitops/charts/beluga-data/templates/02-cnpg.yaml#L56-L71) |
| 백업 자격증명 범위 | S3 아이덴티티가 백업 버킷으로 제한 | [`01-seaweedfs.yaml:37`](../gitops/charts/beluga-data/templates/01-seaweedfs.yaml#L37) |
| Kubernetes Secret | k3s 서버 플래그에 `--secrets-encryption` 없음 | [`02-k8s-init.sh:27`](../scripts/cluster/02-k8s-init.sh#L27) |
| 노드 디스크 | VM 박스 `dasomel/ubuntu-26.04-xfs`(파일시스템 선택일 뿐) | [`Vagrantfile:51`](../Vagrantfile#L51) |
| 선언된 데이터 민감도 | 레지스트리 분류 값은 `internal`, `pii`; `email`, `name` 같은 컬럼은 `pii` | [`policies/data-standards.yaml:28`](../policies/data-standards.yaml#L28), [`:39`](../policies/data-standards.yaml#L39), [`:45-46`](../policies/data-standards.yaml#L45-L46) |
| PostgreSQL 전송 구간 | `pg_hba`는 `hostssl`이 아닌 `host`를 사용하며 매니페스트 주석이 클러스터 내부 평문을 수용 | [`02-cnpg.yaml:38`](../gitops/charts/beluga-data/templates/02-cnpg.yaml#L38), [`:46-47`](../gitops/charts/beluga-data/templates/02-cnpg.yaml#L46-L47) |

`scripts/`, `Vagrantfile`, `gitops/`, `docs/*.md`에서 `secrets-encryption`, `encryption-provider`, `EncryptionConfiguration`, `luks`, `cryptsetup`, `dm-crypt`, `kms`를 (대소문자 무시) 검색: **일치 없음**.
따라서 저장소는 해당 경로에서 저장 시 암호화나 키 관리 메커니즘을 선언하지 않습니다. 특정 호스트에 아무것도 없다는 결론은 아닙니다.

### 2.2 라이브 상태 (2026-10-07 실측)

| 측정 | 명령 | 결과 |
|---|---|---|
| StorageClass | `kubectl get sc` | 기본 `local-path`(`rancher.io/local-path`) 하나, reclaimPolicy `Delete`, 파라미터 없음: 볼륨은 노드 자체 파일시스템의 디렉터리 |
| PVC | `kubectl get pvc -A` | 8개 모두 `local-path`: `postgres-main-1`, `openldap-config`, `openldap-data`, `apisix-etcd-data`, `seaweedfs-data-seaweedfs-0`, `data-0-beluga-kafka-mixed-{0,1,2}` |
| k3s 서버 플래그 | `kubectl get node master-1 -o jsonpath='{.metadata.annotations.k3s\.io/node-args}'` | `server --flannel-backend none --disable-network-policy --disable traefik --disable servicelb --disable-kube-proxy --egress-selector-mode cluster --node-ip ...`: `--secrets-encryption` 없음. 호스트의 k3s `config.yaml`은 이 어노테이션만으로 배제되지 않음: **미검증** |
| Secret | `kubectl get secrets -A` | Opaque 63, TLS 9, Helm 릴리스 3, node-password 4 |
| PostgreSQL 파라미터 | `kubectl get cluster.postgresql.cnpg.io -n database postgres-main -o jsonpath=...` | `ssl_min_protocol_version: TLSv1.3`, `shared_preload_libraries: ""` |
| 백업 상태 | `kubectl get backup -n database` | 2026-10-05, 2026-10-06 예약 백업이 `failed`("instance manager was restarted during backup"); 따라서 이 두 객체로는 최근 성공 백업이 확인되지 않음 |
| 노드 디스크 암호화 | `kubectl`로 측정 불가 | **라이브 미검증**(노드 셸 접근은 이 레인의 범위 밖) |

### 2.3 사용한 업스트림 사실

- PostgreSQL 17: 저장 암호화는 파일시스템 또는 블록 수준(Linux의 dm-crypt + LUKS)에서 수행; 드라이브 도난에는 대비되나 파일시스템이 마운트된 상태의 공격에는 대비되지 **않음**;
  읽은 페이지는 내장 투명 데이터 암호화를 설명하지 않음 [S1].
- k3s: `--secrets-encryption` 플래그로 활성화; `k3s secrets-encrypt status`, `rotate-keys`, `rotate` 명령; 기존 클러스터에서는 활성화 후 키 회전과 서버 재시작이 있어야 완전히 적용 [S2].
- SeaweedFS: `weed filer -encryptVolumeData`는 filer 저장소의 메타데이터로 보관되는 청크별 랜덤 키의 AES256-GCM으로 볼륨 데이터를 암호화; 페이지는 키 회전이나 키 분실 복구 절차를 명시하지 않음 [S3].
  S3 서버 측 암호화 모드 SSE-KMS, SSE-C, SSE-S3가 설명됨(KMS 제공자: AWS KMS, Google Cloud KMS, OpenBao/Vault, Azure Key Vault 실험적); 고정 버전 4.41 및 Iceberg/Trino 트래픽에 대한 적용 가능성은 **미검증** [S4].
- CloudNativePG v1.30.0: `barmanObjectStore`는 v1.26부터 Barman Cloud 플러그인으로 대체되어 deprecated; 읽은 백업 페이지에는 백업 암호화 옵션에 대한 서술이 없음 [S5].
- Kafka와 Strimzi: 이번 조사에서 공식 저장 시 서술을 조사하지 않음; **여기에 기록된 공식 권고 없음**.

## 3. 수락 기준 대비 간극

| 수락 기준 | 상태 | 이유 |
|---|---|---|
| 모든 보호 대상 데이터 분류에 저장 시 메커니즘 식별 | **미충족** | 어떤 분류에도 선언된 메커니즘 없음(2.1); 노드 수준 상태 미상(2.2) |
| 키 수명주기와 소유권 문서화 | **미충족** | 소유할 키가 없음; 존재하는 키는 TLS 키(이슈 #47)와 S3/DB 자격증명(권한 접근 인벤토리)뿐 |
| 백업 산출물이 암호화되고 접근 통제됨 | **부분** | 접근 통제: 전용 S3 아이덴티티(2.1). 암호화: 선언 없음; 전송은 평문 `http://` |
| 키 회전/폐기가 반복 가능 | **미충족** | 회전할 대상 없음; 권한 접근 인벤토리상 자격증명 회전도 확립되지 않음 |
| 보안 프로파일 검증이 암호화 통제를 확인 | **미충족** | `make validate`나 테스트에 암호화를 참조하는 점검 없음(2.1의 검색); 프로파일 설계에도 암호화 점검이 없음 |

## 4. 제안 (모든 항목은 제안)

### 4.1 계층 모델

| 계층 | 대상 | 후보 메커니즘 | 이 계층 이후 잔여 평문 |
|---|---|---|---|
| L1 노드/볼륨 | `local-path` 볼륨이 노드 디렉터리이므로 모든 PVC(PostgreSQL, Kafka, SeaweedFS, OpenLDAP, etcd)를 한 번에 | 데이터 디스크의 블록 수준 암호화(dm-crypt + LUKS) [S1], 또는 하위 플랫폼의 암호화 볼륨 | 실행 중인 노드의 모든 것(호스트 접근이 있는 침해된 워크로드 포함)이 데이터를 읽을 수 있음 [S1] |
| L2 Kubernetes Secret | Opaque Secret 63개(자격증명, 키스토어 암호) | k3s `--secrets-encryption` 및 `secrets-encrypt rotate-keys` [S2] | Secret은 메모리와, 키 없이 만든 API 서버 데이터 백업에서 평문; 파드의 env/볼륨 사본 |
| L3 오브젝트 스토어 | 레이크하우스 데이터와 백업 버킷 | SeaweedFS `-encryptVolumeData` [S3] 또는 S3 SSE [S4], 호환성 테스트 이후에만 | 키 자료는 filer 저장소(S3) 또는 KMS(S4)에 존재 |
| L4 백업 | `beluga-postgres-backups` | 버킷/오브젝트 수준 SSE 및/또는 SeaweedFS 볼륨의 L1; Barman Cloud 플러그인 이전은 이미 보류된 결정(데이터 수명주기 D10) [S5] | 엔드포인트를 바꾸기 전까지 백업 트래픽은 `http://` |
| L5 데이터베이스/Kafka 자체 | PostgreSQL, Kafka | PostgreSQL은 내장 투명 암호화 설명 없음 [S1]; Kafka는 조사하지 않음 | 해당 없음 |

개발 프로파일: 변경 없음(이슈 #16의 로컬 실용성 요구). 프로덕션 프로파일: **제안** 최소 기준은 L1 + L2; L3/L4는 호환성 테스트 후.

### 4.2 키 수명주기 (소유자가 채울 표; 여기에는 수치가 없음)

| 키 | 소유자 | 저장 위치 | 회전 | 폐기 | 복구 |
|---|---|---|---|---|---|
| 디스크(LUKS) 키 | **D1** | **D1**(패스프레이즈, TPM, 네트워크 바인딩) | **D2** | 재암호화 또는 볼륨 파기 | **D3** |
| k3s Secret 암호화 키 | **D1** | k3s 서버 데이터 디렉터리 | `rotate-keys` [S2]; 주기 **D2** | 회전 후 재시작 [S2] | 서버 상태 백업에 포함; **D3** |
| SeaweedFS 데이터/SSE 키 | **D1** | filer 저장소 또는 KMS [S3, S4] | `-encryptVolumeData`는 문서화되지 않음 [S3] | 문서화되지 않음 | 문서화되지 않음 |
| 백업 키 | **D1** | 백업 저장소 정책과 동일 | **D2** | **D2** | **D3** |

회전 주기: **읽은 공식 수치 없음**(이번 조사에서 NIST SP 800-57은 참조하지 않음); 수치는 소유자 결정입니다.
이슈의 분리 요구: 키 관리 자격증명은 애플리케이션 자격증명을 재사용하면 안 됩니다. **제안**: 키 자료 전용 Secret/네임스페이스를 두고 권한 접근 인벤토리에 설명된 `beluga-credentials` 투영에서 제외.

## 5. 검증 및 테스트 아이디어

1. 정적: 프로덕션 렌더에서 암호화됨으로 어노테이션된 StorageClass(어노테이션 규약은 **제안**)가 아닌 PVC가 있거나 Cluster `backup`에 암호화 선언이 없으면 실패하는 게이트.
2. 라이브 읽기 전용: `k3s.io/node-args`의 `kubectl get node -o jsonpath`로 `--secrets-encryption` 단언; `k3s secrets-encrypt status`(노드 접근, 이 레인 밖)로 Enabled 단언.
3. 라이브: 폐기 가능 클러스터에서 Secret을 쓰고 백킹 스토어를 읽어 저장 값이 평문이 아님을 단언(L2 확인).
4. 백업: 폐기 가능 클러스터에서 암호화된 버킷으로 백업, 복원, 행 수 비교; 키 없이는 오브젝트를 읽을 수 없음을 확인.
5. 부정: 잘못되었거나 폐기된 키로 복원 시도 시 fail closed.
6. 폐기 훈련: 키를 회전하고 D3에 따라 이전 백업이 복원 가능한지 확인.

## 6. 남은 소유자 결정

| ID | 결정 | 권고 |
|---|---|---|
| D1 | 키 분류별 키 소유자, 저장소, 보관 모델 | L1/L2 키는 플랫폼 소유자; 백업 키는 별도 역할 |
| D2 | 회전 주기 | 공식 수치 없음; NIST SP 800-57과 조직 정책을 읽은 후 선택 |
| D3 | 복구 및 에스크로 절차 | L1/L2를 활성화하기 전에 오프라인 에스크로 문서화 |
| D4 | 프로덕션 프로파일에서 필수인 계층 | L1 + L2 필수; L3/L4는 테스트 후 |
| D5 | SeaweedFS 옵션: `-encryptVolumeData` vs SSE-KMS vs 없음(L1에 의존) | 먼저 L1에 의존; 선택 전에 폐기 가능 클러스터에서 Trino/Lakekeeper와 SSE 테스트 |
| D6 | 백업 경로: 플러그인 이전, 별도 장애 도메인의 버킷, `https` 엔드포인트 | 데이터 수명주기 D10과 함께 결정 |
| D7 | 애플리케이션 롤에 `pg_hba`가 `hostssl`을 요구해야 하는지 | 별도의 전송 이슈; 결정이 누락되지 않도록 여기에만 언급 |

## 7. 후속 구현 작업 (순서대로)

1. 승인된 절차로 노드별 라이브 노드 수준 상태(디스크 암호화 여부) 기록; 수락: 이 문서에 명령과 출력을 담은 표.
2. `k3s.io/node-args`의 `--secrets-encryption`을 보고하는 읽기 전용 점검 추가; 수락: 프로덕션 프로파일에서 없으면 exit 1(픽스처 테스트).
3. 폐기 가능 클러스터에서 `rotate-keys` 포함 k3s Secret 암호화 활성화 및 테스트; 수락: 테스트 5.3 통과.
4. 폐기 가능 클러스터에서 Trino 및 Lakekeeper에 대해 SeaweedFS SSE/`-encryptVolumeData` 테스트; 수락: Iceberg 읽기/쓰기 E2E 유지.
5. 백업 경로 암호화 및 복원 훈련 추가; 수락: 테스트 5.4, 5.5.
6. 프로덕션 프로파일 정적 게이트 추가(5.1).

## 출처

모두 2026-10-07 접근.

| ID | 출처 |
|---|---|
| S1 | PostgreSQL 17, Encryption Options: https://www.postgresql.org/docs/17/encryption-options.html |
| S2 | K3s, secrets-encrypt: https://docs.k3s.io/cli/secrets-encrypt |
| S3 | SeaweedFS wiki, Filer Data Encryption: https://github.com/seaweedfs/seaweedfs/wiki/Filer-Data-Encryption |
| S4 | SeaweedFS wiki, Server-Side Encryption: https://github.com/seaweedfs/seaweedfs/wiki/Server-Side-Encryption |
| S5 | CloudNativePG v1.30.0, Backup: https://github.com/cloudnative-pg/cloudnative-pg/blob/v1.30.0/docs/src/backup.md |
