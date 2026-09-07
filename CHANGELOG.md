# 변경 이력

이 프로젝트에는 Git 태그나 정식 시맨틱 버전 릴리스가 없다. 아래 커밋 이력이 변경 이력이다.

```text
1467aa5 2026-08-09 docs: beluga 데이터 플랫폼 설계서 v1 (승인된 브레인스토밍 결과)
276d8d5 2026-08-09 docs: 세션 핸드오프 — 설계 승인 상태, 다음 단계 writing-plans
0a8ee8b 2026-08-09 docs: D10 추가 — 구현 실행 체계 = Fable 오케스트레이션 + agy 워커 하네스
fa444d1 2026-08-10 feat(cluster): implement full stack beluga data platform infrastructure and demo pipelines
7bbb6ba 2026-08-10 chore(cluster): update subnet configuration to 192.168.77.x to avoid IP conflicts
f4b3622 2026-08-10 fix(cluster): expose k8s services via NodePort for host localhost access
2f1f5e6 2026-08-10 feat(cluster): configure *.beluga.local domain routing and Ingress rules
154d78d 2026-08-10 feat(cluster): align APISIX API Gateway & ApisixRoute with narwhal spec (*.local.beluga.internal)
7a43a03 2026-08-10 feat(cluster): unify all domain access ports to HTTP port 80
24511cf 2026-08-10 feat(gitops): APISIX 전환 마무리 — nginx 인그레스 제거, ClusterIP 전환, Flink 라우트 추가
bf23d07 2026-08-10 docs: D11~D14 확정 — APISIX 접근 통일, OpenMetadata·Keycloak SSO·중앙 OPA+OpenFGA 거버넌스
dd0acf0 2026-08-10 feat(gitops): 거버넌스 1차 구현 — Keycloak SSO, 중앙 OPA+OpenFGA, OpenMetadata, Lakekeeper 교체
647a05e 2026-08-10 fix(gitops): 보안 리뷰 반영 — Keycloak 자격 Secret화, OpenSearch NetworkPolicy 격리
ff6c37f 2026-08-10 fix(gitops): arm64 이미지 게이트 재검증 — OPA static 변형, Lakekeeper v0.13.1, Flink 공식 리포 교체
aea66e5 2026-08-10 feat(analytics): Superset Keycloak OIDC 로그인 + 그룹→롤 매핑 (D13)
7b2970a 2026-08-10 feat(orch): Airflow·OpenMetadata Keycloak OIDC 로그인 통합 (D13, 로그인만)
801f739 2026-08-10 merge: lane/wave2-e
246c071 2026-08-10 feat(lake): Lakekeeper 부트스트랩 + 웨어하우스 'lake' 생성 Job (D4 마무리)
d9c15ea 2026-08-10 merge: lane/wave2-f
0832fbd 2026-08-10 feat(cluster): D8 프로파일 확장 — 48GB+에서 OpenMetadata·Trino worker 활성 + Lakekeeper /catalog URI 교정
1976201 2026-08-10 merge: lane/wave2-g
b4ddade 2026-08-10 merge: lane/wave2-h
987ccca 2026-08-10 docs: 2차 레인 완료 반영 — VERSIONS curl 유틸 추가, 핸드오프 다음 단계 E2E로 갱신
c5766f2 2026-08-10 docs: D15 자격증명 랜덤 생성 정책 등재 (narwhal 패턴 승계) + 오판 기록
b980b00 2026-08-10 feat(gitops): D15 — 자격증명 부트스트랩 랜덤 생성 전환 (narwhal 패턴)
8725f4c 2026-08-10 merge: lane/wave3-credentials (D15)
8134514 2026-08-10 fix(demo): shop-seed 비밀번호 fallback 제거 — D15 정책 정합 (env 필수화)
703f00a 2026-08-10 fix(gitops): E2E 1라운드 실측 결함 8건 수정 — 전 파드 Running 달성
4d25edb 2026-08-10 fix(ingest): Strimzi 1.1.0 승급 + Kafka 4.3 KRaft 기동 — 4중 원인 사슬 해소, 테스트 게이트 강화
5a49963 2026-08-10 fix(ingest): CDC 파이프라인 완성 — Debezium 독립 Deployment 전환(D6 수정), shop 시딩·REPLICATION·퍼블리케이션 권한
837b19c 2026-08-10 test(ingest): 02 CDC 검증 실질화 — 독립 Deployment 라벨 정합 + 커넥터 task·토픽 실조회
fe4e499 2026-08-10 docs: E2E 1차 결산 — §8 기준 스코어보드, D16 판정 대기, 다음 단계 갱신
aa65caf 2026-08-10 docs: D16 확정 — K8s 배포판 k3s 수용 (채널 고정, E2E 검증 완료 기반)
738b32e 2026-08-10 feat(demo): 클릭스트림 생성기 배포 — python:3.12-slim + ConfigMap 스크립트 (레지스트리 불요)
b490d51 2026-08-10 feat(stream): Flink SQL 잡 제출 메커니즘 — 커넥터 JAR initContainer 주입 + sql-client 제출 Job
c59c409 2026-08-10 merge: lane/wave4-j
0f79111 2026-08-10 feat(orch): Airflow DAG ConfigMap 배포 + Superset 대시보드 import Job (멱등, zip 변환)
31bf937 2026-08-10 merge: lane/wave4-k
c2fbcb5 2026-08-10 merge: lane/wave4-l
6fcdc36 2026-08-10 docs+fix(gitops): D17 최신 안정판 핀 정책 등재, Flink 오퍼레이터 본체 설치 갭 수정(1.15.0 helm)
2b19e70 2026-08-10 feat(gitops): D17 버전 웨이브 — 검증 통과 컴포넌트 일괄 최신 안정판 핀
bbf82f7 2026-08-10 fix(gitops): APISIX admin key D15 주입 — 라우트 동기화 전무 원인 해소 + Lakekeeper BASE_URI 내부화
3041250 2026-08-11 feat(cluster): dnsmasq 기반 도메인 해석 (narwhal 패턴) — 파드 내부 해석 가능화
f45c58b 2026-08-11 fix(gitops): APISIX 컨트롤러 initContainer 게이트 — admin API 준비 대기
2f8f831 2026-08-11 merge: lane/wave5-m
b29cc92 2026-08-11 merge: lane/wave5-n
4531efb 2026-08-11 fix(gitops): APISIX 라우트 동기화 복구 — CRD 전체 세트(v1.8.0 태그) + Ingress RBAC
8624ce8 2026-08-11 fix(analytics): Superset authlib venv 주입 + Trino 프록시 헤더 처리 — 도메인 접근 완결
75d94e7 2026-08-11 feat(cluster): kubectl 접근 스크립트 + CoreDNS 존 중복 정의 수정
f9d6795 2026-08-11 docs: 접근 가이드 전면 갱신 — dnsmasq/resolver DNS, kubeconfig.sh, 트러블슈팅
18cb473 2026-08-11 merge: lane/wave6-docs
2363901 2026-08-11 fix(cluster): kubeconfig.sh 컨텍스트 이름 변경을 kubectl 네이티브로 — sed가 current-context를 놓쳐 깨진 kubeconfig 생성
2208121 2026-08-11 feat(cluster): 자격증명 일괄 조회 스크립트 (narwhal 요약 패턴) + Flink JAR 다운로드 검증
a7ca208 2026-08-11 docs: D18 권한 매트릭스 등재 — Keycloak 그룹 3종을 앱·데이터·DB 전 계층에 투영 (§10)
2035f5d 2026-08-11 feat(gitops): Keycloak SSO 사용자 3종 생성 Job (D13 완성) — 그룹별 계정·비밀번호
d33daf9 2026-08-11 merge: lane/wave7-sso
7cae6ba 2026-08-11 docs: D19 권한 모델 등재 — 사용자→그룹→롤(컴포지트 상속) 3계층, allow-by-role 규칙
54fc0a7 2026-08-11 docs: D20 계정 통합 등재 — OpenLDAP(저장소)+Keycloak(접점), PG는 LDAP·Kafka는 OAuth
d0c753b 2026-08-11 fix(stream): Flink 데이터 경로 3종 — 세션 클러스터 lib 교체, ISO-8601 타임스탬프, 체크포인트
f43041e 2026-08-11 feat(gitops): OPA 정책 3-tier 재작성 — D18 매트릭스 집행 (opa eval 15케이스 검증)
92e704b 2026-08-11 feat(gitops): OpenLDAP 배포 + Keycloak WRITABLE 페더레이션 + D19 컴포지트 롤 (D20)
4cc15e7 2026-08-11 feat(gitops): PG 접근제어 — D19 상속 롤(NOLOGIN)+LDAP 로그인 계정, pg_hba ldap (D20)
0bf7f92 2026-08-11 merge: lane/wave8-s
a2d8ee5 2026-08-11 feat(ingest): Kafka OAuth 리스너 + KafkaUser ACL 3종 (D20, oauthListener 게이트)
bf95548 2026-08-11 merge: lane/wave8-t
b1fb700 2026-08-11 merge: lane/wave8-u
3736644 2026-08-11 merge: lane/wave7-q (OPA 3-tier)
c73039f 2026-08-11 docs: 레인 의존 순서 실수 기록 (R→T 선병합 원칙)
d2e7fde 2026-08-11 fix(gitops): ArgoCD 3.x CRD server-side apply — 256KB 한계로 부트스트랩 전체가 조기 사망하던 문제
8dda2b6 2026-08-11 fix(gitops): CDC 역직렬화·스냅숏 체인 + OpenLDAP 1.5.0 회귀 (D17 예외)
22f2908 2026-08-11 fix(gitops): D20 계정 통합 완주 — 페더레이션 parentId, admin 로그인 계정 grant 정리
9c0b153 2026-08-11 fix(gitops)+docs: CDC 품질 마감 — 시드 멱등·upsert·REPLICA IDENTITY, §8·§10 실측 스코어보드
8eb4763 2026-08-11 fix(gitops)+demo: OPA 실환경 집행 확립 + customers 미러 + Airflow 3 DAG 정합
1427a3a 2026-08-11 docs+fix: VERSIONS↔매니페스트 LDAP 드리프트 해소(vegardit 2.6.10), superset 400 위양성 게이트 실제 수정
577eeca 2026-08-11 fix(analytics): superset-import 400 위양성 게이트 — 이번엔 실제 수정 (409/already-exists만 멱등 성공)
6a9d685 2026-08-11 docs: OpenLDAP 전환 회고 5건 기록 — emptyDir 계정 휘발, 이미지 기본 시드, 조사 레인 허위 보고, 요약도구 오판, 동시 세션 커밋 혼입
5eb9c03 2026-08-11 fix(gitops): 페더레이션 Job parentId 주입 위치 교정 — 이전 주입이 들여쓰기를 깨 SyntaxError
5a841e0 2026-08-11 feat(analytics): Superset 6 대시보드 REST 직접 생성 — import 포맷 비호환 대체 (§8-②)
b02191a 2026-08-11 merge: lane/wave9-superset (theirs — REST 직접 생성이 게이트 수정 포함 상위집합)
6cec79b 2026-08-11 fix(gitops): LDAP cn 유일성 충돌 해소(사용자 이름 구분) + Superset /pylibs SQLAlchemy 셰도잉 제거
20f0a98 2026-08-11 fix(gitops): 페더레이션 존재 확인 쿼리 — type 단독 필터가 빈 목록을 반환해 프로바이더 36개 중복 생성
5082e56 2026-08-11 fix(gitops): LDAP 페더레이션 3중 결함 마감 — 컴포넌트 조회·동기화 경로·핸드오프 갱신
edc1fc4 2026-08-11 docs: 세션 저장 — LDAP write-back 잔여 원인(vegardit 트리 구조) 특정, 실수 기록 추가
3d677de 2026-08-12 docs: IAM 컨트롤 플레인 설계 노트 (beluga manager 착수 시 읽을 것)
af12037 2026-08-12 docs: beluga manager IAM 컨트롤 플레인 설계서 (승인된 브레인스토밍 결과)
9a0d5fd 2026-08-12 docs: manager 계획 1 — 정책 컴파일러·권한 사슬 복구 (10 태스크)
5a2ebe0 2026-08-12 fix(plan): 사전 점검 결함 2건 — Rego 클레임 경로(identity.groups 실측), PG 롤 이름 변환
0b48a75 2026-08-12 fix(gitops): analyst 기본 권한 자동 부여 제거 — §10.1 기본 거부 원칙 복구
707d1a8 2026-08-12 fix(gitops): 06-authz-defaults 테스트의 PGPASSWORD argv 노출 제거
2eb2479 2026-08-16 fix(plan): Task 3 스키마를 strictObject로 — 모르는 키 조용히 버리면 오타로 PII 마스킹 소실
dabc942 2026-08-17 docs(plan): Task 3·4를 출시된 코드에 동기화 — sensitiveColumns·rowFilter 화이트리스트
98556f3 2026-08-17 docs(plan): allowUnmasked 옵트인 반영 — engineer PII 부여를 마스킹이 아닌 명시적 예외로
5069d4f 2026-08-18 docs(plan): localeCompare 전량 제거 — 공유 cmp()로 로케일 독립 정렬 (§5.3-2)
e674ee2 2026-08-18 docs(plan): Task 7 권한 정렬을 정규 순서로, 미사용 golden/roles.sql 항목 제거
def4399 2026-08-18 feat(policies): 정책 선언 원천 추가 — 롤 계층·그룹·리소스 매트릭스
c779e65 2026-08-19 docs(plan): Task 11-16 추가 — 롤 이름 정합, ExecuteQuery 갭, LDAP 그룹 프로바이더, 정책 컷오버, cert-manager+OAuth2
4120c41 2026-08-19 docs(plan): Task 9 근거 정정 — D-D 이후 이 매퍼는 Trino 권한과 무관
e20d7a6 2026-08-19 feat(gitops): Keycloak group-ldap-mapper 등록 — 그룹→롤 사슬 연결 (D19)
5477e3e 2026-08-19 docs(plan): Task 17 추가 — Superset 롤 매핑 키를 LDAP 그룹명(복수형)에 정렬 (D-G)
525a5f7 2026-08-19 docs(gitops): group-mapper 주석의 LDAP 대소문자 근거 정정
8cac366 2026-08-19 fix(policies): 롤 이름을 LDAP 그룹명과 일치시킴 — analysts/engineers/admins (D-F)
05b2bae 2026-08-19 feat(policies): 카탈로그 레벨 grant 추가 — ExecuteQuery/AccessCatalog/ShowSchemas
925294e 2026-08-19 docs(plan): Task 19 추가 — 카탈로그 브라우징 오퍼레이션 갭 + 테이블 규칙 카탈로그 가드 (D-H)
ea7122e 2026-08-19 docs(plan): Task 18 추가 — 배포 산출물 롤 이름 마이그레이션 (D-I)
2bdabc2 2026-08-19 chore(docs): 라이선스 고지·SBOM 체계 도입 (Apache-2.0)
0a4fc08 2026-08-19 chore(docs): 공개 준비 정리 — 로컬 절대경로 제거, 세션 산출물 추적 해제
8107f0b 2026-08-19 docs: 공개 릴리스용 README 작성
a33f239 2026-08-19 docs: 설계 문서를 실제 결정·배포 상태와 정합화 (공개 준비)
bf5d416 2026-08-19 docs: openldap-suite → ldapium 개명 반영
1318069 2026-08-19 docs: openldap-suite → ldapium 리네임 반영 (iam-control-plane-notes.md)
ef4d539 2026-08-19 Revert "docs: openldap-suite → ldapium 리네임 반영 (iam-control-plane-notes.md)"
840b573 2026-08-19 tmp
b229c75 2026-08-19 Remove accidental empty tmp file
51781bb 2026-08-19 tmp2
270035b 2026-08-19 Remove accidental temporary file
1d1867a 2026-08-19 tmp3
f8248c7 2026-08-19 Remove accidental temporary file
733539b 2026-08-19 x
f3717e6 2026-08-19 Remove accidental temporary file
1121457 2026-08-19 chore: temporary placeholder
5bfe999 2026-08-19 chore: remove temporary placeholder
90c38aa 2026-08-19 chore: temporary check
cafcd35 2026-08-19 chore: remove temporary check
49e1c1e 2026-08-19 chore: temporary check
4ae21a7 2026-08-19 chore: remove temporary check
6cbcec7 2026-08-19 chore: temporary
2b2cb48 2026-08-19 chore: remove temporary
421af5a 2026-08-19 chore: temporary cleanup marker
c161151 2026-08-19 chore: temporary cleanup marker
3ef79c0 2026-08-19 chore: temporary cleanup marker
b6e5a18 2026-08-19 chore: temporary cleanup marker
08e0fb7 2026-08-19 chore: remove temporary cleanup marker
8a4dfdc 2026-08-19 chore: remove temporary cleanup marker
ed0f329 2026-08-19 chore: remove temporary cleanup marker
5f786f1 2026-08-19 chore: remove temporary cleanup marker
f53151b 2026-08-19 chore: temporary
3de83aa 2026-08-19 chore: remove temporary file
5fe20e9 2026-08-19 chore: temporary rfp research marker
64265b1 2026-08-19 chore: remove temporary rfp research marker
e8092d8 2026-08-19 chore: temporary rfp research marker
18e00da 2026-08-19 chore: remove temporary rfp research marker
3d18570 2026-08-19 chore: temporary
10f9690 2026-08-19 chore: temporary
8315826 2026-08-19 chore: temporary
072fd12 2026-08-19 chore: temporary
de9c9ea 2026-08-19 chore: temporary
c1d8fc1 2026-08-19 chore: temporary
fe74b8e 2026-08-19 feat: replace vegardit OpenLDAP with ldapium
5f55ee3 2026-08-19 docs: update OpenLDAP version and image
abf4a04 2026-08-19 chore: temporary rfp marker
e5bc74c 2026-08-19 chore: remove temporary rfp marker
d1868e5 2026-08-19 x
4fcfa8e 2026-08-19 x
2ed9af3 2026-08-19 x
c3ab2f9 2026-08-19 chore: remove temporary marker
36c315a 2026-08-19 chore: remove temporary marker
6aa8bc0 2026-08-19 chore: remove temporary marker
31f44a8 2026-08-20 docs: record published ldapium-ui 0.1.0 artifact
f9642f1 2026-08-20 fix: pass CoreDNS config environment to python correctly
a497479 2026-08-20 fix: normalize CoreDNS upstream servers
df9da3f 2026-08-20 docs: NOTICE의 LDAP 서술 정정 — beluga는 ldapium을 실제로 배포한다
48b7714 2026-08-20 fix(gitops): ldapium 이미지 태그를 실재하는 불변 태그로 교체
8c81642 2026-08-20 fix(k3s): disable kube-proxy for Cilium replacement
9a700d0 2026-08-20 test(cluster): verify Cilium owns service datapath
ebbbe86 2026-08-20 fix(k3s): apply kube-proxy disable via server config
529048a 2026-08-20 fix(k3s): route control-plane service access without kube-proxy
96cb558 2026-08-20 test(cluster): verify K3s components stay disabled
7ede8e2 2026-08-20 docs: document kube-proxy-free validation
f84443a 2026-08-20 Merge pull request #102 from dasomel/fix/k3s-kube-proxy-free
8fe1688 2026-08-20 feat(cluster): 네임스페이스 재편 — beluga-system/beluga-data → 기능별 네임스페이스
cb8ac36 2026-08-20 feat(cluster): 네임스페이스 재편 — beluga-system/beluga-data → 기능별 네임스페이스
ec30614 2026-08-20 chore: 임시 파일 제거 — tmp-clean{,2..6}
60546d4 2026-08-20 Merge branch 'main' into feat/manager/policy-compiler
3c70a67 2026-08-20 docs(plan): Task 13-19 네임스페이스를 beluga-system/beluga-data → 기능별로 동기화
5fd5b38 2026-08-20 fix(gitops): 히스토리 세탁이 깨뜨린 SUPERSET_SECRET_KEY 대입 복구
3b4d85c 2026-08-20 fix(gitops): IAM 훅 Job의 sync-wave 데드락 수정
b71fb61 2026-08-21 Merge main: 네임스페이스 재편·sync-wave 수정·세탁 복구 반영
2a0652b 2026-08-21 feat(cluster): cert-manager 도입 + Trino 코디네이터 TLS (D-E 1/2)
92cdbcc 2026-08-22 fix(gitops): keycloak-users를 LDAP 페더레이션 뒤로 — 계정 원천 분열 수정 (#3)
8dce44c 2026-08-22 fix(gitops): LDAP 페더레이션 parentId를 realm UUID로 — write-back 복구 (#3)
b2bf459 2026-08-23 fix(gitops): 그룹을 LDAP 원천으로 일원화 — 멤버십 write-through 복구 (#3)
3c26387 2026-08-23 fix(gitops): 그룹 매퍼 sync 누락·관리자 토큰 만료 — 실배포로 드러난 결함 2건 (#3)
17d502d 2026-08-24 fix(gitops): 자격증명 렌더 시점 굽기 제거 — 전 워크로드 secretKeyRef 전환 (#104)
3e0c296 2026-08-25 fix(stream): Flink SQL의 lakekeeper/seaweedfs short-name을 FQDN으로 (#105)
f441381 2026-08-25 feat(orch): Trino LDAP 그룹 프로바이더 배포 — identity.groups 채우기 (D-D, Task 13)
01b7bb6 2026-08-25 feat(policies): 카탈로그 grant에 브라우징 오퍼레이션 8종 추가 — ShowTables 등
f4f5b3f 2026-08-25 feat(orch): Trino OAuth2 인증 활성화 — X-Trino-User 자칭 구멍 폐쇄 (D-E 2/2, Task 16)
ae459da 2026-08-25 fix(orch): Trino 내부 통신 공유 시크릿 추가 — OAuth2 부팅 실패 수정 (Task 16 후속)
1183a80 2026-08-25 fix(orch): Keycloak profile 클라이언트 스코프 추가 — preferred_username 클레임 누락 수정 (Task 16 후속)
ad95ec0 2026-08-25 feat(orch): 생성 정책으로 컷오버 — allow-by-role + 행 필터·컬럼 마스킹 URI 배선 (Task 14)
3986ba0 2026-08-25 fix(orch): information_schema SELECT 재컴파일 반영 (Task 14 후속)
9bfb4dc 2026-08-25 fix(stream): Trino/Flink의 seaweedfs-s3 short-name을 FQDN으로 (#105와 동일 결함)
143dd50 2026-08-25 fix(iam): 배포 산출물 롤 이름을 analysts/engineers/admins로 마이그레이션 (D-I, Task 18)
39639bc 2026-08-25 fix(gitops): APISIX Trino 업스트림을 8443/HTTPS로 전환 — 최종 리뷰 C-1 (실배포 실측: 포트 80 전면 차단)
d9cf0e9 2026-08-25 fix(docs): 최종 리뷰 M-3/M-5 — sso 도메인 문서 누락, role-migration Job 죽은 코드 정리
a749ef0 2026-08-25 fix(orch): OPA 정책에 FilterColumns 오퍼레이션 추가 — DESCRIBE 빈 컬럼 결함 (최종 리뷰 I-5)
61c0e4c 2026-08-25 test(orch): Trino OPA default-deny 컷오버 라이브 회귀 테스트 추가 (최종 리뷰 I-2)
d00cdc6 2026-08-25 docs(gitops): db-roles.sql이 컴파일러 산출물이 아님을 명시 (최종 리뷰 I-1)
b686250 2026-08-25 docs(docs): §10.2 집행 상태를 실배포 반영으로 갱신 + 메타데이터 열람 PII 트레이드오프 명시 (최종 리뷰 M-6)
8b5fcc1 2026-08-25 docs(docs): 프로젝트 지침 최신화 — 클러스터 검증 규율 4항 추가 + 실수 기록 5건 (2026-08-25)
b9ad31e 2026-08-25 fix(gitops): APISIX Admin API 노출 축소 — allowlist 축소 + NetworkPolicy + CLI admin key 제거 (이슈 #4)
0f4f48c 2026-08-25 fix(lake): SeaweedFS S3 실자격증명 + 최소권한 + NetworkPolicy 도입 (이슈 #7)
5d216f4 2026-08-25 fix(lake): SeaweedFS StatefulSet에 영구 스토리지(PVC) 추가 — 라이브 데이터 소실 실측 (이슈 #7 후속)
ba7ffe1 2026-08-26 fix(lake): tests/09의 kubectl run --rm -i 출력 오염 결함 수정 (이슈 #7 후속)
ad05d3b 2026-08-26 docs: 이슈 #7 데이터 소실·복구 과정에서 발견한 운영 교훈 4건 기록
34699c2 2026-08-26 feat(gitops): SSO/identity 경계 TLS 전환 — 게이트웨이+Keycloak+LDAP+Trino (이슈 #2 핵심 범위)
4a2e18a 2026-08-26 fix(gitops): internal-ca-distribution RBAC 웨이브 미지정 결함 — 실배포 실측
9be0848 2026-08-26 fix(gitops): internal-ca-distribution — 쉘 없는 kubectl 이미지 결함 실측 수정
1b56035 2026-08-26 fix(analytics): Trino 코디네이터 jvm.config JDK 25 비호환 옵션 제거 — 실배포 CrashLoopBackOff 실측 (이슈 #2 후속)
f674f71 2026-08-26 fix(gitops): HTTP→HTTPS 리다이렉트가 :9443으로 향하던 결함 — plugin_attr.redirect.https_port=443 (이슈 #2 실배포 실측)
fb81932 2026-08-26 feat(gitops): 이슈 #2 잔여 범위 — Superset/Airflow OIDC https 전환 + 내부 CA 신뢰, Keycloak redirect URI https 일원화, 게이트웨이 forwarded 헤더 강제
170802e 2026-08-26 test(docs): 이슈 #2 정적 preflight(tests/11) 신설 + tests/10 5케이스 확장, 진입점 문서 https 전환
9dd767d 2026-08-26 fix(gitops): OpenLDAP LDAPS가 기존 PVC에서 실제로는 꺼져 있던 결함 — cn=config TLS 속성을 postStart로 수렴 (이슈 #2 실배포 실측)
32946f6 2026-08-26 fix(gitops): APISIX SSL 리스너를 외부 노출 포트 443에 직접 바인드 — X-Forwarded-Port=9443 결함 근본 수정 (이슈 #2 실배포 실측)
6540b11 2026-08-26 fix(gitops): Keycloak realm 클라이언트 스코프 미프로비저닝 수정 (이슈 #111 실배포 실측)
7e0d5ad 2026-08-27 fix(analytics): Trino OAuth2 전용 전환 후 서비스 연결 인증 경로 추가 (이슈 #110)
633ed39 2026-08-27 docs: add cross-agent engineering contract
921b7ed 2026-08-29 fix(stream): gate Flink SQL sync hook
97605fd 2026-08-30 fix(gitops): APISIX etcd 재기동 시 라우트 상태 소실 방지 — PVC 도입 (이슈 #109)
aeb571e 2026-08-30 fix(gitops): 이슈 #109 PVC 마이그레이션 라이브 검증 중 발견한 후속 결함 수정
273283e 2026-08-30 security(gitops): LDAP group-provider용 읽기 전용 바인드 계정 분리 (이슈 #106)
```

