계획: 기존 maintenance 신원 패턴 조사 → 전용 reader/Secret/describe·네트워크·차트 연결 → 이름/수 조회·갱신/실패 처리 → 문서·렌더/단위 검증. 클러스터·정책·LDAP·이미지 핀은 변경하지 않았다.

구현: `manager-catalog-reader`/`svc-manager-catalog-reader`, aud=lakekeeper, warehouse lake describe만 부여한다. Secret은 iam/platform-system 전용이다. 모든 인증 사용자에게 이름/수만 제공하고 중첩·페이지 전체 집계와 실패 시 503을 적용했다. ADR-0009 예약 참조를 보존하고 ADR-0010 영/한 쌍과 인덱스를 추가했다.

변경 파일: 양 차트 values와 keycloak/keycloak-clients/manager, lakehouse NetworkPolicy/bootstrap, scripts/gitops bootstrap·인증서/네트워크 인벤토리, Manager source/routes/app·테스트·API 영/한 문서, 접근/특권/구성 문서·실수 로그, tests/29·렌더 테스트·run-all·Makefile. 전체 경로와 정확한 검증 명령/실제 출력 꼬리는 [증거](issue-372-manager-lakekeeper-verification.txt)에 있다.

검증:
- `cd manager && make verify`: `Beluga Manager repository verification: PASS`.
- `cd manager && npm test`: `7 failed | 1372 passed | 26 skipped`, `5 errors`. socket EPERM/후속 timeout 및 알려진 ICU 날짜 형식 실패다.
- 관련 최종 vitest 5개 파일: `86 passed`; `npm run typecheck`, `npm run build` 통과.
- `python3 tests/test_manager_catalog_reader_render.py`: default/full/Kakao/disabled 양 차트 helm template·신원 교정·비밀 비출력·describe 멱등성·ADR 인덱스 PASS.
- 기존 dbt identity 및 Lakekeeper authz 렌더, certificate/ROPC/networkpolicy(egress 포함)/run-all/rendered-shell 검사 PASS.
- `shellcheck scripts/gitops/01-argocd-bootstrap.sh tests/30-manager-lakekeeper-assets.sh tests/run-all.sh`: exit 0. `make lint`: 양 차트 `0 chart(s) failed`.
- test29는 opt-in 없음으로 SKIP만 확인했다. `make validate`, 스테이징/커밋은 실행하지 않았다.

열린 사항: 설계 질문 없음. 배포 전 새 Manager 이미지 게시·핀 갱신 필수(현재 고정 이미지에는 새 코드가 없음). 라이브에서 신규/기존 realm 교정·Secret 회전, subject/audience, 권한 상속/쓰기 403, 내부 네트워크, gateway TLS/PKCE, 실제 집계 일치, 만료 후 토큰 갱신, 브라우저 UI/장애 표시를 확인해야 한다. 정책/생성 snapshot 재생성은 해당 변경이 없어 불필요했다. manager/CLAUDE.md에는 AGENTS 외 thin-adapter/draft 메모가 있다.
