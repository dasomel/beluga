# Shop CDC 트래픽 생성기

[English](shop-traffic-generator.md) | 한국어

클릭스트림 생성기와 함께 `Deployment/database/shop-gen`이 합성 데이터를 계속
변경하여 Postgres → Debezium → Kafka → Flink → Iceberg 경로를 사용한다.
정적·단위 검사는 선언과 로직을 검증한다. 런타임 설치, CNPG 계정 조정, Cilium 집행,
종단 간 전파는 라이브 미검증이다.

`shopGenerator.enabled` 기본값은 **false**다(D-SHOP-8). 기존 클러스터가 자동
동기화만 받아도 생성기 워크로드·계정·grants 의존성이 추가되지 않는다.
활성 시 3초당 쓰기 1회, 20회마다 로그를 남긴다. 기본 주문 상한은 1,000행이며
CDC DELETE를 위해 최대 1행 초과를 허용한다. 고객 INSERT는 100행에서 멈춘다.
전체 주문이 상한을 넘었을 때만 10 tick마다 생성기 소유의 가장 오래된 주문 하나를
삭제한다. 상한을 낮춰도 같은 속도로 줄인다. 시드·비소유 행은 그 자체로 상한을
넘어도 삭제하지 않는다. 선택적 grants 훅이 `orders.generator_owned` 열(기본 false)을 멱등 추가하고
생성기 INSERT만 true로 설정한다(D-SHOP-11). 업무 상태값을 바꾸지 않고 UPDATE·
재시작에도 소유권을 유지한다. 다른 writer는 이 값을 false로 유지해야 한다. 기존 초과 고객은 외래 키 때문에 보존한다.
다른 writer는 이 상한으로 제한되지 않으며 합성 데이터에만 사용한다.

D-SHOP-1/2는 트랜잭션 advisory lock과 DB 행 수로 재시작·중복 writer를 처리하며
별도 시드/리셋이 없다. 단일 replica는 Recreate를 쓴다. D-SHOP-3은 DB 장애,
스키마 부재, 비동기 계정·권한 적용 중 1–32초 지수 backoff로 재시도하고
7회 연속 실패하면 1로 종료하여 `ContainerRestartingFrequently`가 지속 장애를 알린다.
숫자 설정 오류는 종료 코드 2이며 오류 로그에 연결 진단·비밀값을 쓰지 않는다.
스크립트 checksum으로 변경 시 rollout한다. 기존 `python:3.12-slim`에서
`psycopg2-binary==2.9.10`을 bounded emptyDir에 설치하며 pip 실패도 backoff로
재시도한다. 버전 고정이며 패키지 해시·이미지 digest 검증은 아니다.
D-SHOP-5는 ephemeral-storage request 32Mi, limit 384Mi(라이브러리 32Mi + 임시
128Mi + 로그/쓰기 계층 224Mi)를 선언하며 사용량 실측치는 아니다.

D-SHOP-4는 Manager DB 패턴을 따른다. 부트스트랩이 `beluga-credentials`에 비밀번호를
한 번 생성하고 `database`의 전용 `shop-generator-db` Secret으로 투영한다.
CNPG는 `shop_generator`(LOGIN, NOINHERIT, 연결 2개)를 관리한다. 기존 owner 실행
`db-roles-setup` 훅은 최대 60회, 5초 간격으로 기다린다(DB 쿼리도 시간 제한).
D-SHOP-9는 계정 부재·grants 실패 시 명확한 로그와 함께 선택적 grants를 건너뛰고
공유 플랫폼 동기화는 성공시킨다. D-SHOP-12는 선택 Deployment를 ArgoCD health
게이트에서 제외해 연결 장애로 후속 wave가 막히지 않게 한다. 생성기 로그·재시작
경보는 별도로 확인한다(Secret 부재는 기동 전 오류라 컨테이너 재시작이 발생하지 않는다). CONNECT, 스키마 USAGE,
`public.orders`/`public.customers`에만 DML, 두 serial sequence에만 USAGE를 부여한다.
D-SHOP-10은 `PGSSLMODE=verify-full`과 같은 네임스페이스의 CNPG
`postgres-main-ca` Secret에서 `ca.crt`만 마운트한다. 복사나 새 RBAC가 필요 없다.
런타임에는 owner 자격증명·클러스터 RBAC가 없다. 사람 정책 컴파일 결과는 유지한다.
비활성화하면 워크로드·정책·CNPG 선언 항목을 제거하지만 저장된 계정·권한·Secret을
자동 삭제하지는 않는다.

D-SHOP-6은 DB TCP 5432에 생성기만 허용하는 규칙을 추가하되 DB default-deny를
새로 켜지 않는다. 이 워크트리에는 해당 DB ingress baseline이 없다. 생성기 Cilium
egress는 Postgres TCP 5432, 클러스터 DNS, `pypi.org`/`files.pythonhosted.org`의
HTTPS만 허용한다. Cilium CRD·FQDN DNS 프록시가 필요하다. 기존 DB 소비자 전체가
ingress 격리됐다는 의미는 아니다.

활성화하려면 먼저 Secret을 준비한다. 아래 격리된 실습 kubeconfig를 사용하며
Colima는 [별도 kubeconfig 안내](colima-single-node-ko.md)를 따른다.

```bash
KUBECONFIG=/tmp/beluga-kubeconfig.yaml bash scripts/gitops/01-argocd-bootstrap.sh --shop-generator-secrets-only
```

그다음 Vagrant/Colima 실습 Application `gitops/apps/beluga-data.yaml`이 읽는
`gitops/values/shop-generator-lab.yaml`에서 `shopGenerator.enabled: true`로 설정한다.
`gitops/profiles/full/Kustomization`은 이 Application을 상속하고
`gitops/values/profile-full.yaml`을 추가한다. 이 full 값 파일은 Kakao도 사용하므로
거기서 생성기를 켜지 않는다. Kakao의 별도 Application
(`csp/kakao-cloud/gitops/apps/beluga-data.yaml`)은 기본 비활성을 유지한다.
실습 값 변경은 정상 GitOps 리뷰·동기화 절차로 반영한다.
CNPG가 계정을 만든 후 `argocd app sync beluga-data` 또는 UI에서 리소스 선택 없는
**전체** Sync를 실행한다. 훅은 전체 동기화마다 grants를 멱등 적용하므로 수동 SQL
GRANT가 필요 없다. 선택적 리소스 동기화는 훅을 실행하지 않는다.

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

비활성화는 실습 값을 false로 바꾸고 pruning 동기화한 뒤 `database/shop-gen`이
사라질 때까지 기다린다. 계정·grants·Secret·소유권 열은 남는다. 선택적으로 자격증명·계정을
정리하려면 동기화 완료 후 격리 kubeconfig와 기존 owner 접근으로 실행한다.

```bash
kubectl -n database exec postgres-main-1 -- psql -U postgres -d shop -v ON_ERROR_STOP=1 -c 'DROP OWNED BY shop_generator; DROP ROLE shop_generator;'
kubectl -n database delete secret shop-generator-db
kubectl -n platform-system patch secret beluga-credentials --type=json -p='[{"op":"remove","path":"/data/shop-generator-password"}]'
```

`DROP OWNED`는 이 계정의 grants를 회수한다. 생성기는 DB 객체를 만들지 않는다.
마지막 명령은 저장 비밀번호를 지워 secrets-only 단계에서 새로 만들도록 한다.
managed role이 present로 선언된 동안은 정리하지 않는다.
