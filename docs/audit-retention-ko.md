# 불변 감사 및 증거 보존 (제안)

[English](audit-retention.md) | 한국어

이슈 [#35](https://github.com/dasomel/beluga/issues/35) ("Enforce immutable audit and evidence retention for security events") 관련.

> **상태: 제안. 문서만 변경.** 이 문서는 매니페스트, 스크립트, `VERSIONS.md` 항목, 정책을 변경하지 않습니다. 저장소에 대한 모든 서술은
> 커밋 `9f74c2b`에서 읽은 `file:line`을 가집니다. 라이브 클러스터에 대한 서술은 2026-10-07에 실행한 읽기 전용 `kubectl` 명령
> ([2.2절](#22-라이브-상태-2026-10-07-실측))에서 나왔거나 **라이브 미검증**으로 표시했습니다. 외부 사실은 [출처](#출처)(접근일 2026-10-07)를 인용하며, 공식 권고를 찾지 못한 경우 그렇게 적었습니다.
> 보존 기간은 **소유자 결정**이며 여기서 임의로 정한 값은 없습니다.

관련 문서: [`docs/privileged-access-logging.md`](privileged-access-logging.md) (무엇을 기록하는가, 이슈 #44), [`docs/time-synchronization.md`](time-synchronization.md) (타임스탬프, 이슈 #45),
[`docs/encryption-at-rest.md`](encryption-at-rest.md) (키, 이슈 #16), [`docs/data-lifecycle-policy.md`](data-lifecycle-policy.md) (백업 버킷의 Object Lock 메커니즘, D10),
[`docs/security-control-evidence-map.md`](security-control-evidence-map.md) (C10, C14, C17).

## 1. 목적과 이슈 매핑

이슈 #35는 보존 분류와 기간, 운영 로그 접근과 감사 증거 관리의 분리, 일상적 수정/삭제로부터의 보호, 무결성 검증, 일관된 시간 및 상관 메타데이터,
인증, 인가, 게이트웨이 관리, 데이터 접근 결정, 백업/복원, DR 증거의 포괄, 감사 기간의 내보내기/검토 절차를 요구합니다.

## 2. 현재 상태 (검증됨)

### 2.1 저장소가 정의하는 것

| 영역 | 사실 | 출처 |
|---|---|---|
| 릴리스 증거 무결성(존재) | 릴리스 번들(SBOM, 라이선스 인벤토리, 자산 인벤토리, NOTICE, LICENSE, `manifest.json`)은 다른 모든 파일에 대한 `SHA256SUMS`를 가지며, 오프라인 `verify`가 체크섬을 다시 계산하고 누락, 추가, 변조, 파싱 불가 파일에서 fail closed | [`evidence_bundle.py:2-15`](../scripts/release/evidence_bundle.py#L2-L15) |
| 릴리스 증거 증명(존재) | 릴리스 워크플로가 `SHA256SUMS`에 대한 빌드 출처 증명을 만들고 파일별로 검증 | [`release.yml:167-181`](../.github/workflows/release.yml#L167-L181) |
| 해당 메커니즘의 범위 | 릴리스 산출물만. 런타임 보안 이벤트는 다루지 않으며 번들 빌더에는 타임스탬프 필드가 없음(시간 문서 2.1 참조) | [`evidence_bundle.py:2-15`](../scripts/release/evidence_bundle.py#L2-L15) |
| 리서치 증거 레코드 | `record-evidence.py`는 명령당 스키마 검증된 레코드 하나를 추가; 고정 스칼라 키로 원시 로그 구조를 배제 | [`record-evidence.py:1-3`](../scripts/research/record-evidence.py#L1-L3), [`:55`](../scripts/research/record-evidence.py#L55), [`:137`](../scripts/research/record-evidence.py#L137) |
| QA 보고서 | 릴리스 QA 보고서는 다섯 범주의 증거를 요구하고 승인 메타데이터와 함께 면제를 기록 | [`generate_release_qa_report.py:19-22`](../scripts/generate_release_qa_report.py#L19-L22) |
| 백업 보호(정적) | CNPG 백업 게이트는 `barmanObjectStore`, secret 참조 자격증명, WAL 압축, 보존을 검사하며 불변성은 검사하지 않음 | [`check-postgres-backup-config.py:2-16`](../scripts/ci/check-postgres-backup-config.py#L2-L16) |
| 백업 버킷 | `beluga-postgres-backups`, `retentionPolicy: 30d`, 해당 버킷에 Read/Write/List/Tagging 권한의 S3 아이덴티티 `postgres-backup-service`(`Admin` 없음) | [`02-cnpg.yaml:56-71`](../gitops/charts/beluga-data/templates/02-cnpg.yaml#L56-L71), [`01-seaweedfs.yaml:34-38`](../gitops/charts/beluga-data/templates/01-seaweedfs.yaml#L34-L38) |
| 레이크하우스 데이터와 같은 스토리지 | 백업 버킷과 `beluga-lake`는 5Gi PVC 하나를 쓰는 SeaweedFS StatefulSet 하나가 제공; 아이덴티티 `lakekeeper-service`는 `beluga-lake`에만 `Admin` | [`01-seaweedfs.yaml:15-36`](../gitops/charts/beluga-data/templates/01-seaweedfs.yaml#L15-L36), [`:185-191`](../gitops/charts/beluga-data/templates/01-seaweedfs.yaml#L185-L191) |
| Object Lock | 설정되지 않음. 저장소 문서는 SeaweedFS의 Object Lock 강제가 해당 문서가 언급한 버전(3.86, `VERSIONS.md`는 4.41)에서 미검증이라고 서술 | [`configuration-sources.md:47`](configuration-sources.md#L47), [`VERSIONS.md:32`](../VERSIONS.md#L32) |
| 감사 소스 | Kubernetes API, PostgreSQL, Keycloak, ArgoCD, LDAP에 대한 감사 레코드가 생성되지 않음(이슈 #44 문서 참조); OPA 결정 로그는 콘솔로 감 | [`opa.yaml:10-11`](../gitops/charts/beluga-platform/templates/opa.yaml#L10-L11) |
| 로그 저장소 | 이 저장소에서 배포되는 것 없음 | 라이브, 2.2 |
| 증거 맵 행 | C10(로깅 및 감사 추적), C17(사고 대응), C19(통제 증거에 따른 릴리스 준비)는 `gap`; C14(릴리스 증거)는 `implemented` | [`security-control-evidence-map.md`](security-control-evidence-map.md) |

### 2.2 라이브 상태 (2026-10-07 실측)

| 측정 | 명령 | 결과 |
|---|---|---|
| 로그 수집기 / 저장소 | `kubectl get pods -A \| grep -E "prom\|graf\|loki\|alert\|fluent\|vector\|otel\|falco"` | 일치 없음 |
| 백업 객체 | `kubectl get backup -n database` | `postgres-main-backup-20261005020000`과 `...20261006020000`이 `failed` 단계("instance manager was restarted during backup on pod postgres-main-1"); 이 클러스터의 백업/복원 증거는 현재 불완전 |
| SeaweedFS 버킷의 Object Lock | S3 자격증명/API 필요 | **라이브 미검증** |
| 기존 보존 감사 이력 | 존재할 수 없음: 클러스터 생성 후 3일, API 감사 꺼짐, pgaudit 미로드(이슈 #44 문서 2.2) | 라이브 |

### 2.3 사용한 업스트림 사실

- SeaweedFS S3 Object Lock: Governance 모드는 "can be bypassed by users with proper permissions (`s3:BypassGovernanceRetention`)"; Compliance 모드는 "cannot be bypassed by any user, including root/admin"; Object Lock은 버킷 생성 시 활성화해야 하며 나중에 추가할 수 없음; 버전 관리는 자동 활성화되며 필수 [S1]. 4.41에서의 동작은 **미검증**(페이지가 버전 구분 없음).
- NIST SP 800-92(로그 관리 가이드): 초록은 로그 관리 인프라와 프로세스를 다루며 읽은 페이지에 **보존 기간은 명시되지 않음** [S2]. Beluga의 맥락에 대한 공식 보존 수치는 찾지 못함.
- Kubernetes 감사 백엔드(로테이션 플래그가 있는 로그 파일, 웹훅)는 이슈 #44 문서에 설명됨([`privileged-access-logging.md`](privileged-access-logging.md)의 출처 S1, S2).

## 3. 수락 기준 대비 간극

| 수락 기준 | 상태 | 이유 |
|---|---|---|
| 보안 증거 보존 정책 문서화 | **미충족** | 정책 없음; 기간 미결정; 이 문서가 구조를 제안 |
| 일반 운영자 워크플로로 보존 증거를 변경할 수 없음 | **미충족** | 감사 저장소 없음; 백업 버킷에 Object Lock 없음; 같은 StatefulSet/PVC와 클러스터 운영자가 통제 |
| 무결성 검증이 변경이나 손실을 탐지 | **부분(릴리스만)** | 릴리스 번들은 체크섬 + 증명; 런타임 이벤트는 없음 |
| 시간 및 상관 메타데이터가 소스 간 일관 | **미충족** | 시간 문서 참조: 시간 소스 없음, 두 도구 외 규약 없음, 게이트웨이 로그에 상관 ID 없음 |
| 감사 기간 증거 패키지를 생성하고 검증 가능 | **미충족** | 릴리스 번들 `verify` 패턴은 있으나 런타임 패키지는 없음 |

## 4. 제안 (모든 항목은 제안)

### 4.1 증거 분류

| 분류 | 소스(이슈 기준) | 현재 생성 여부 | 보존 |
|---|---|---|---|
| E1 인증 | Keycloak 로그인 이벤트, Kubernetes/ArgoCD/LDAP 로그인 | 아니오(이슈 #44 문서) | **D1** |
| E2 인가 및 데이터 접근 결정 | OPA 결정 로그, OpenFGA/Lakekeeper, Kafka 인가자 | OPA 콘솔만 | **D1** |
| E3 관리 작업 | Kubernetes API 감사, APISIX 관리, Keycloak 관리 이벤트, pgaudit ROLE/DDL | 아니오 | **D1** |
| E4 백업/복원 | CNPG `Backup` 객체, 복원 훈련 | `Backup` 객체 있음(라이브, 실패 포함); 훈련 기록 없음 | **D1** |
| E5 DR 훈련 | 훈련 보고서 | 없음 | **D1** |
| E6 릴리스 증거 | 릴리스 번들 | 예, 증명됨 | GitHub 릴리스 기준 이미 존재; 기간은 **D1** |

공식 보존 기간은 읽지 못했으며 모든 기간은 **소유자 결정 D1**입니다. 가장 긴 분류가 최소 용량과 Object Lock 보존을 결정합니다.

### 4.2 보호 저장소 설계

- 생성 시점에 Object Lock을 활성화한 전용 감사 버킷 [S1], 자동 버전 관리, 분류별 기본 보존 설정; 모드 **Compliance**는 폐기 가능 클러스터 테스트 이후에만, Compliance는 관리자도 우회할 수 없으므로 [S1] 보존 기간 오류를 고칠 수 없음. 되돌릴 수 있는 대안은 Governance(**D2**).
- 기록 아이덴티티: 해당 버킷에 쓰기 전용, `Admin` 없음, `BypassGovernanceRetention` 없음. 읽기/내보내기 아이덴티티: 읽기 전용. 보존/잠금 관리자: 레이크하우스나 플랫폼 운영자가 갖지 않는 세 번째 아이덴티티. 기존 버킷별 아이덴티티(`01-seaweedfs.yaml:15-38`)를 따름.
- 잠금이 다루지 않는 잔여 위험: 감사 버킷이 레이크하우스 데이터와 같은 SeaweedFS 인스턴스와 PVC에 있으면 StatefulSet/PVC나 노드 볼륨을 삭제할 때 Object Lock과 무관하게 파괴됨. **제안**: 감사 증거를 별도의 장애 및 관리 도메인(두 번째 저장소 또는 외부 WORM 지원 대상; **D3**)에 배치. Object Lock은 S3 API 수준의 통제일 뿐입니다.

### 4.3 무결성

기록기는 레코드를 세그먼트로 묶고, 각 세그먼트에 SHA-256과 순번 및 이전 매니페스트 해시를 가진 매니페스트 항목(해시 체인)을 부여하여 변경(해시 불일치), 손실(순번 누락 또는 파일 없음), 순서 변경을 탐지합니다.
매니페스트는 기록기와 별도로 소유한 키로 서명(키 보관: 암호화 문서 D1). 릴리스 번들의 체크섬 및 증명 방식[`evidence_bundle.py`, `release.yml:167-181`]이 모델이며, `verify`는 릴리스 `verify`처럼 오프라인이며 누락, 추가, 변조 파일에서 fail closed여야 합니다.

### 4.4 시간과 상관

모든 레코드: UTC RFC 3339 `Z`, 밀리초 정밀도, 소스 호스트, 상관 ID(시간 문서 4.4, 권한 접근 문서 4.1). 각 매니페스트 해시에 대한 선택적 RFC 3161 토큰(시간 문서 D5).

### 4.5 직무 분리

세 역할: 운영자(일상 로그만), 감사 기록자(자동화), 감사 관리자(보존 설정, 내보내기); 검토자는 관리자와 분리. 감사 저장소 자체에 대한 접근은 E3로 기록.

### 4.6 감사 기간 내보내기 및 검토

기간별 패키지: 세그먼트 + 체인 매니페스트 + 서명 + `SHA256SUMS` + 검증 보고서(분류별 건수, 누락, 이슈 #44 보고서의 감사되지 않는 경로 목록) + 검토자 서명 기록. 절차: (1) 기간 경계 고정, (2) 읽기 전용 내보내기, (3) 오프라인 verify 실행, (4) 검토자 서명, (5) 서명된 패키지 자체를 보존 하에 저장.

## 5. 검증 및 테스트 아이디어

1. Object Lock(폐기 가능 클러스터): Object Lock 버킷을 만들고 짧은 보존으로 객체를 쓴 뒤 기록자, 레이크하우스 관리자, root 아이덴티티로 삭제 및 덮어쓰기를 시도; 모두 실패함을 단언; Governance는 우회 권한이 필요함을 단언 [S1].
2. 변조: 세그먼트의 한 바이트 변경, 세그먼트 하나 삭제, 두 개 교환; 각각 `verify`가 서로 다른 메시지로 실패함을 단언.
3. 시간/상관: 게이트웨이를 통과한 요청 하나가 E2와 E3에 같은 상관 ID와 단조 증가하는 UTC 시간의 레코드를 생성.
4. 패키지: 픽스처 기간의 패키지를 생성하고 깨끗한 머신에서 오프라인 검증; 추가/누락 파일 부정 테스트.
5. 권한 분리: 기록 아이덴티티는 다른 버킷을 나열하거나 보존을 변경할 수 없음.
6. 장애: 수집기를 N분간 중지; 검증에서 누락이 조용히 무시되지 않고 탐지됨을 단언.

## 6. 남은 소유자 결정

| ID | 결정 | 권고 |
|---|---|---|
| D1 | 증거 분류별 보존 기간; 검토 주기 | 공식 수치 없음; 조직의 규정 준수 의무에서 도출 |
| D2 | Object Lock 모드: Compliance vs Governance | 파일럿 동안 Governance, 5.1 테스트 후 Compliance |
| D3 | 감사 저장소 위치: 동일 SeaweedFS vs 별도 도메인 | 별도 도메인; 동일 인스턴스 저장소는 "운영자가 변경할 수 없음"을 충족할 수 없음 |
| D4 | 서명 키 소유자와 보관 | 기록기와 분리; 암호화 문서 D1/D3 준수 |
| D5 | 로그 파이프라인/저장소 기술 | 이슈 #44, #45, #47과 하나의 공통 결정 |
| D6 | 검토자는 누구이며 얼마나 자주 | 감사 관리자가 아닌 지정된 역할 |

## 7. 후속 구현 작업 (순서대로)

1. 폐기 가능 클러스터에서 SeaweedFS 4.41 Object Lock 동작 증명(테스트 5.1); 수락: 결과 기록 및 오래된 `configuration-sources.md` 서술 갱신.
2. D1, D3, D5를 결정하고 이 문서에 기록.
3. 해시 체인 매니페스트가 있는 세그먼트 기록기와 오프라인 `verify`(테스트 5.2); 수락: 변조 픽스처가 실패.
4. 이슈 #44 문서의 E2/E3 소스를 기록기에 연결; 수락: 테스트 5.3.
5. 패키지 내보내기 및 검토 절차(5.4); 수락: 깨끗한 머신에서 검증.
6. 프로덕션 렌더에 감사 버킷 Object Lock 설정이나 세 아이덴티티가 없으면 실패하는 정적 게이트 추가.
7. 복원 훈련 기록(E4/E5) 형식과 첫 훈련 기록.

## 출처

모두 2026-10-07 접근.

| ID | 출처 |
|---|---|
| S1 | SeaweedFS wiki, S3 API FAQ (Object Lock, versioning): https://github.com/seaweedfs/seaweedfs/wiki/S3-API-FAQ |
| S2 | NIST SP 800-92, Guide to Computer Security Log Management (abstract page): https://csrc.nist.gov/pubs/sp/800/92/final |
