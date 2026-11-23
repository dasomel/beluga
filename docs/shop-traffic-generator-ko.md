# Shop CDC 트래픽 생성기

[English](shop-traffic-generator.md) | 한국어

클릭스트림 생성기와 함께 `Deployment/database/shop-gen`이 합성 데이터를 계속
변경하여 Postgres → Debezium → Kafka → Flink → Iceberg 경로를 사용한다.
정적·단위 검사는 선언과 로직을 검증한다. 런타임 설치, CNPG 계정 조정, Cilium 집행,
종단 간 전파는 라이브 미검증이다.

`gitops/charts/beluga-data/values.yaml`의 `shopGenerator` 기본값은 활성화,
3초당 커밋 쓰기 1회, 주문 1,000행·고객 100행 상한, 20회마다 진행 로그 1줄이다.
10 tick 주기로 주문 INSERT, 상태·금액 UPDATE, 가장 오래된 주문 DELETE,
고객 INSERT/UPDATE를 섞는다. 주문 상한에서는 DELETE가 우선한다. 상한을 낮추면
초과 주문을 tick당 하나씩 줄인다. 고객은 상한에서 INSERT를 멈추며 기존 초과 고객은
주문 외래 키 때문에 보존한다. 다른 writer의 쓰기는 이 상한으로 제한되지 않는다.
시드 행도 변경·삭제할 수 있으므로 합성 데이터에만 사용한다.

D-SHOP-1/2는 트랜잭션 advisory lock과 DB 행 수로 재시작·중복 writer를 처리하며
별도 시드/리셋이 없다. 단일 replica는 Recreate를 쓴다. D-SHOP-3은 DB 장애,
스키마 부재, 비동기 계정·권한 적용 중 최대 60초 지수 backoff로 재시도한다.
숫자 설정 오류는 종료 코드 2이며 오류 로그에 연결 진단·비밀값을 쓰지 않는다.
스크립트 checksum으로 변경 시 rollout한다. 기존 `python:3.12-slim`에서
`psycopg2-binary==2.9.10`을 bounded emptyDir에 설치하며 pip 실패도 backoff로
재시도한다. 버전 고정이며 패키지 해시·이미지 digest 검증은 아니다.
D-SHOP-5는 ephemeral-storage request 32Mi, limit 384Mi(라이브러리 32Mi + 임시
128Mi + 로그/쓰기 계층 224Mi)를 선언하며 사용량 실측치는 아니다.

D-SHOP-4는 Manager DB 패턴을 따른다. 부트스트랩이 `beluga-credentials`에 비밀번호를
한 번 생성하고 `database`의 전용 `shop-generator-db` Secret으로 투영한다.
CNPG는 `shop_generator`(LOGIN, NOINHERIT, 연결 2개)를 관리한다. 기존 owner 실행
`db-roles-setup` 훅은 계정 생성을 기다린 후 CONNECT, 스키마 USAGE,
`public.orders`/`public.customers`에만 DML, 두 serial sequence에만 USAGE를 부여한다.
런타임에는 owner 자격증명·클러스터 RBAC가 없다. 사람 정책 컴파일 결과는 유지한다.
비활성화하면 워크로드·정책·CNPG 선언 항목을 제거하지만 저장된 계정·권한·Secret을
자동 삭제하지는 않는다.

D-SHOP-6은 DB TCP 5432에 생성기만 허용하는 규칙을 추가하되 DB default-deny를
새로 켜지 않는다. 이 워크트리에는 해당 DB ingress baseline이 없다. 생성기 Cilium
egress는 Postgres TCP 5432, 클러스터 DNS, `pypi.org`/`files.pythonhosted.org`의
HTTPS만 허용한다. Cilium CRD·FQDN DNS 프록시가 필요하다. 기존 DB 소비자 전체가
ingress 격리됐다는 의미는 아니다.

기존 클러스터는 검토한 차트 동기화 전에 Secret을 준비한다.

```bash
KUBECONFIG=/tmp/beluga-kubeconfig.yaml bash scripts/gitops/01-argocd-bootstrap.sh --shop-generator-secrets-only
```

전체 부트스트랩에도 포함된다. secrets-only에는 기존
`platform-system/beluga-credentials`와 `database` 네임스페이스가 필요하다.
기존 Secret을 보존하며 비밀번호 회전은 별도 작업이다.

운영자가 ArgoCD로 차트를 동기화한 뒤 실행한다.

```bash
kubectl --kubeconfig .kube/config config view --minify --flatten > /tmp/beluga-kubeconfig.yaml
export KUBECONFIG=/tmp/beluga-kubeconfig.yaml
kubectl -n database rollout status deployment/shop-gen --timeout=180s
kubectl -n database logs deployment/shop-gen --tail=50
bash tests/02-ingest-cdc.sh
bash tests/03-stream-iceberg.sh
bash tests/04-trino-query.sh
```

기존 테스트는 smoke 검사이며 지속적인 c/u/d 수렴의 증거는 아니다. 생성기 계정으로
다음 스냅샷을 60초 이상 간격으로 두 번 조회하여 상한과 값 변화를 확인한다.

```bash
kubectl -n database exec deployment/shop-gen -- python -c 'import psycopg2; c=psycopg2.connect(); q=c.cursor(); q.execute("SELECT count(*), min(order_id), max(order_id), max(updated_at) FROM public.orders"); print(q.fetchone()); q.execute("SELECT count(*), max(customer_id) FROM public.customers"); print(q.fetchone())'
```

서비스 계정으로 테이블 생성·다른 애플리케이션 테이블 읽기가 거부되는지도 확인하고,
Debezium의 `op=c/u/d` 레코드와 실제 Iceberg 주문·고객 ID 및 값을 운영자 Trino
자격증명으로 비교한다. smoke 성공이나 소스 스냅샷만으로 DELETE 전파·최소 권한·
Cilium 거부 집행을 입증할 수는 없다.

합성 이메일 도메인은 `baseDomain`에서 가져온다. 기존 이메일 열 길이에 맞춰 빈 도메인·67자 초과 도메인은 설정 오류로 거부한다.
