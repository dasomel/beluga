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

## ⚠ 다음 세션 1순위: LDAP 페더레이션 마감

**증상**: `keycloak-ldap-federation` Job이 "Could not determine component ID"로 실패하며 LDAP
프로바이더를 중복 생성한다(최대 36개까지 쌓였던 이력). 중복이 쌓이면 사용자 검색이
400 `Cannot parse the JSON`으로 깨지고 → 사용자 생성/LDAP write-back/PG 로그인이 연쇄 실패한다.

**지금까지 확인된 사실**:
- Keycloak `/admin/realms/{realm}/components`의 서버측 필터(`?type=`, `?parent=&type=`)는
  **둘 다 빈 목록을 반환**한다. 그래서 존재 확인이 항상 실패 → 매번 새로 생성.
- 마지막 커밋에서 **전체 목록을 받아 클라이언트에서 `providerId=='ldap'`로 거르도록** 수정했고
  검증 배치를 돌리던 중 세션이 종료됐다. **이 수정의 실효 여부를 먼저 확인할 것.**

**재개 절차**:
```bash
export KUBECONFIG=$PWD/.kube/config
KC=$(kubectl -n beluga-system get secret beluga-credentials -o jsonpath='{.data.keycloak-admin-password}' | base64 -d)
TOKEN=$(curl -s -d client_id=admin-cli -d username=admin -d "password=$KC" -d grant_type=password \
  http://sso.local.beluga.internal/realms/master/protocol/openid-connect/token | python3 -c "import sys,json;print(json.load(sys.stdin)['access_token'])")
# 1) 프로바이더 개수 확인 (기대: 1)
curl -s -H "Authorization: Bearer $TOKEN" http://sso.local.beluga.internal/admin/realms/beluga/components \
  | python3 -c "import sys,json;print(len([c for c in json.load(sys.stdin) if c.get('providerId')=='ldap']))"
# 2) 1이 아니면 전부 삭제 후 Job 재실행, LDAP uid 3종·PG 로그인까지 확인
```
2개 이상이면 여전히 중복 생성 중이므로, POST 응답의 `Location` 헤더에서 ID를 얻는 방식으로
`gitops/charts/beluga-platform/templates/keycloak-ldap-federation.yaml`을 재수정할 것.

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
