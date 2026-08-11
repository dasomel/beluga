# Beluga Session Handoff — 2026-08-11

새 세션에서 이 파일부터 읽고 이어서 진행할 것.

## 빠른 시작 (새 세션 첫 3줄)

```bash
bash scripts/kubeconfig.sh            # .kube/config 생성 + 접속 검증 (--merge로 전역 등록)
export KUBECONFIG=$PWD/.kube/config
bash scripts/credentials.sh           # 전 서비스 URL·계정·비밀번호 한 번에
```

브라우저 접근은 호스트에 1회 설정이 되어 있어야 한다(이미 적용됨):
`sudo mkdir -p /etc/resolver && echo 'nameserver 192.168.77.10' | sudo tee /etc/resolver/local.beluga.internal`

## 현재 상태

**클러스터 가동 중**(k3s v1.36, VM 4대). 설계 D1~D20 확정, 데이터 경로·권한 체계 대부분 실측 완료.
런타임 실측으로 결함 **40건 이상** 수정·커밋함 — 상세는 `docs/mistakes-log.md`(이 리포의 핵심 자산).

- 설계서: `docs/superpowers/specs/2026-08-09-beluga-data-platform-design.md`
  — §2 D-레지스트리(D1~D20), §10 권한 체계(D18 매트릭스·D19 상속 모델·D20 계정 통합)
- 접근: `docs/access-guide.md` (dnsmasq/resolver, kubeconfig.sh, 트러블슈팅)

## §8 검증 기준 (실측)

| 기준 | 상태 |
|------|------|
| 1. 전 파드 Running | ✅ |
| 2. 이벤트 데모→Superset | ✅ events_enriched 15만행+ / 대시보드 'Beluga Overview'(차트 2종) 생성 확인 |
| 3. CDC→Iceberg 미러 | ✅ 스냅숏 3행 정확 + 라이브 UPDATE upsert 단일행 반영 |
| 4. Trino 타임트래블 | ✅ `FOR VERSION AS OF` 동작 |
| 5. Airflow DAG 이력 | 🔶 DAG 파싱·트리거 성공, **런은 failed** — `iceberg_compaction` 태스크 실패 원인 미규명(KPO 로그 추출이 CLI에서 안 잡힘) |
| 6. lint/테스트 | 🔶 shellcheck·helm lint ✅ / kubeconform·pytest 미실행 |
| 7. tests/ 실상태 | 🔶 01·02 실질화 완료, 03~05 및 거버넌스 검증 스크립트 미작성 |
| 8. 도메인 :80 | ✅ 전 도메인 (dnsmasq + APISIX 라우트 10종) |
| 9. SSO 로그인+롤 매핑 | 🔶 컴포지트 롤·그룹 매핑 구현, Superset OAuth 브라우저 플로우 미실측 |
| 10. OPA 허용/거부 | ✅ Trino 실쿼리로 관측 (analyst `Access Denied` / engineer 허용) |
| 11. OM 리니지 | ⬜ 미착수 |

## §10 권한 체계 (D18~D20)

| 검증 | 상태 |
|---|---|
| OPA 3-tier (Trino·Kafka) | ✅ opa eval 15케이스 + Trino 실쿼리 |
| PG 롤 상속 + PII 차단 | ✅ analyst customers 거부 / engineer 상속 통과 |
| Keycloak 컴포지트 롤·그룹 | ✅ realm 정의 |
| **LDAP write-back → PG 로그인** | 🔶 **이전에 1회 성공 실측**(current_user=beluga-analyst), 이후 vegardit 전환·프로바이더 중복 사고로 깨짐 — 아래 참조 |
| Kafka OAuth/ACL | 게이트 구현(기본 off), 활성 검증 미실시 |

## ⚠ 다음 세션 1순위: LDAP write-back 마감 (D20 마지막 조각)

**해소된 것**(이번 세션):
- 프로바이더 36개 중복 → 컴포넌트 조회를 클라이언트 필터로 교정, 라이브 정리 후 **1개 유지 확인**
- 동기화 404 → `/components/{id}/sync` → `/user-storage/{id}/sync` 교정
- 두 Job(`keycloak-ldap-federation`, `keycloak-users`) 모두 **정상 완료(Complete)**

**남은 증상**: Keycloak 사용자 3종이 `federationLink=LOCAL`로 생성되고 **LDAP에 기록되지 않는다**.
프로바이더 설정은 정상(`editMode=WRITABLE`, `syncRegistrations=true`, `importEnabled=true`).

**핵심 단서 (다음 세션은 여기서 시작)**: vegardit 이미지는 osixia와 **기본 디렉터리 구조가 다르다**.
실제 트리(실측):
```
dc=beluga,dc=internal
├── ou=Users        ← 대문자 U. 하위에 sub-OU가 이미 존재
│   ├── ou=Internal
│   ├── ou=External
│   └── ou=TechnicalAccounts
├── ou=Groups       (cn=admins 등 기본 그룹 존재)
└── ou=Policies     ← 기본 ppolicy. 쓰기 제약 가능성
```
현재 Keycloak `usersDn`은 `ou=users,dc=beluga,dc=internal`(소문자)를 가리킨다.
확인할 가설 순서:
1. `usersDn`을 `ou=Internal,ou=Users,dc=beluga,dc=internal`로 바꿔야 하는가
   (vegardit는 사람 계정을 Internal 하위에 두는 전제일 수 있음)
2. slapd ACL이 `cn=admin` 외 쓰기를 막는가 — `ldapadd`를 수동 실행해 write 자체가 되는지 먼저 격리
3. `ou=Policies`의 ppolicy가 비밀번호 정책으로 생성을 거부하는가

**격리 테스트(먼저 이것부터)**: Keycloak을 거치지 않고 LDAP에 직접 쓰기가 되는지 확인.
```bash
export KUBECONFIG=$PWD/.kube/config
LP=$(kubectl -n beluga-system get secret beluga-credentials -o jsonpath='{.data.ldap-admin-password}' | base64 -d)
OP=$(kubectl -n beluga-system get pods -l app=openldap -o name | head -1)
# 트리 확인 (오류를 숨기지 말 것 — 2>/dev/null 금지)
kubectl -n beluga-system exec "$OP" -- ldapsearch -x -H ldap://localhost:389 \
  -D "cn=admin,dc=beluga,dc=internal" -w "$LP" -b "dc=beluga,dc=internal" dn
```
성공하면 Keycloak `usersDn`을 맞춰 재실행 → LDAP uid 3종 → `beluga-analyst`로 PG 로그인 확인.

**참고**: osixia 1.5.0에서는 이 체인이 **1회 성공 실측**됐다(`current_user=beluga-analyst`).
vegardit 전환은 osixia 방치(안정 태그 2021년) 때문이며, 최악의 경우 osixia 회귀도 선택지다
— 단 그 경우 §9의 유지보수 리스크를 다시 안는다.

## 다음 단계 (우선순위)

1. **LDAP 페더레이션 마감**(위) → LDAP uid 3종 + `beluga-analyst`로 PG 로그인 재확인
2. **Airflow DAG 실패 규명**(§8-⑤) — KPO 태스크 로그를 웹 UI(`http://airflow.local.beluga.internal`)
   또는 `kubectl logs`로 직접 확보. RBAC(SA `airflow`)는 이미 추가됨
3. **tests/ 03~05 실질화 + 거버넌스 검증 스크립트**(§5 데모 ③: SSO 로그인·OPA 허용/거부·리니지)
4. **후속 백로그**: OM 리니지(⑪), Kafka OAuth 활성 검증, kubeconform·pytest,
   LDAPS(§9 — cert-manager 미설치가 선행 과제), opa-kafka-plugin JAR 커스텀 이미지,
   OpenFGA 활성, Grafana/Prometheus 도메인 편입

## 운영 규약 (반드시 승계)

- **D10 하네스**: Fable 지휘 + agy 워커. 워커 레인은 **worktree 격리** 필수(동일 트리 병렬은 사고 이력).
  agy 쿼터 소진 시 네이티브 서브에이전트로 폴백(sonnet 기본).
- **D15 자격증명**: 리포에 실값 금지. `scripts/credentials.sh`로 조회.
- **D17 버전 정책**: 최신 안정판 핀. **워커의 "확인했다"는 증거가 아니다** —
  신규/변경 이미지는 오케스트레이터가 `docker manifest inspect`로 태그 실존+arm64 직접 재검증.
- **검증 규율**: 렌더·lint 통과는 기동을 보증하지 않는다. YAML 속 python heredoc 편집은
  렌더→`py_compile`을 게이트로. 편집 후 `grep`으로 실제 반영 재확인(no-op 통과 사고 이력).
- **커밋**: Conventional Commits + 모듈 스코프, LOCAL only(푸시는 명시 요청 시).

## 참조

| 무엇 | 어디 |
|------|------|
| 실수 기록(최우선 참조) | `docs/mistakes-log.md` — 작업 영역 기록을 먼저 읽을 것 |
| 자매 프로젝트 | `~/Documents/IdeaProjects/20.dasomel/idp/narwhal`, `20.dasomel/kubemetal` |
| 접근·트러블슈팅 | `docs/access-guide.md` |
| 버전 단일 원천 | `VERSIONS.md` |
