# 보안 정책 (Security Policy)

[English](SECURITY.md) | 한국어

## 지원 대상 버전

Beluga는 아직 태그된 릴리스가 없는 개인/학습 스케일 pre-1.0 프로젝트다. `main`
브랜치만 지원 대상이다.

| 버전   | 지원 여부 |
| ------ | -------- |
| `main` | :white_check_mark: |

## 보안 범위 및 인증 정보 격리

Beluga는 로컬 멀티 VM Kubernetes 클러스터를 구성하고 그 위에 전체 데이터 플랫폼
(Kafka/CDC, Flink, Iceberg, Trino, Airflow, Keycloak/OpenLDAP, ArgoCD)을 GitOps로
배포한다.

- **리포에는 어떤 인증 정보도 커밋되지 않는다.** 모든 서비스 비밀번호는 부트스트랩
  시점에 `openssl rand`로 생성되어 Kubernetes Secret `beluga-credentials`에만
  저장된다([README-ko.md](README-ko.md#자격-증명) 참고). 리포에 커밋된 값은 전부
  `SET-AT-BOOTSTRAP` 플레이스홀더다.
- `configs/cluster.env`에는 비밀이 아닌 클러스터 토폴로지(서브넷, 노드 IP, 도메인
  레지스트리)만 있다 — 실제 시크릿을 추가하지 않는다.
- 이 머신은 다수의 동시 세션/클러스터가 공유한다 — `beluga` 컨텍스트로
  `kubectl`/`helm`을 실행하기 전 항상 `KUBECONFIG`를 격리한다([CLAUDE.md](CLAUDE.md)
  참고).
- 게이트웨이/인증 변경은 컴포넌트 직접 접근과 문서화된 사용자 진입점(APISIX
  게이트웨이 도메인 레지스트리) 둘 다로 검증해야 한다.

## 취약점 보고 절차

보안 취약점은 공개 이슈로 등록하지 말고, 이 저장소의 GitHub Private Vulnerability
Reporting을 통해 비공개로 보고하거나 관리자에게 직접 연락한다. 영업일 기준 5일
이내 접수를 확인한다.

참조: [OpenForge Security Standard](https://github.com/dasomel/openforge/blob/main/docs/security.md)
