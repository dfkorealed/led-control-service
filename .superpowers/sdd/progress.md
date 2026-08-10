# Gateway PKI Subagent-Driven 진행 기록

- 기준 계획: `docs/superpowers/plans/2026-07-11-production-device-foundation.md` Task 23~31
- 작업 브랜치: `codex/mvp1-cloud-web`
- 원칙: 기존 dirty 변경 보존, 비밀 원문 DB/로그/Git 저장 금지, 하드웨어 증거 없는 양산 완료 선언 금지

| Task | 범위 | 구현 | 단위/통합 테스트 | 사양 리뷰 | 품질 리뷰 | 비고 |
|---|---|---|---|---|---|---|
| 23 | PKI 도메인/인증서 원장 | 완료 | 통과 | PASS | APPROVED | 임시 PostgreSQL 전체 12 migration 적용 통과 |
| 24 | CA Provider/Vault | 완료 | 19/19 및 API 전체 통과 | PASS | PASS | 실 Vault integration은 Task 28 |
| 25 | 제조 Enrollment | 완료 | 전체 API 151 tests | PASS | PASS | 13 migration deploy 통과 |
| 26 | Gateway key/CSR | 완료 | Gateway 88/88, identity 23/23 | PASS | PASS | Docker image build 환경 대기 |
| 27 | MQTT 인증서 bootstrap | 완료 | 통과 | PASS | PASS | API/Gateway 독립 재리뷰 findings 0 |
| 28 | LAN TLS/Vault infra | 대기 | 대기 | 대기 | 대기 | SAN/CA bundle |
| 29 | Rotation/Revoke/CRL | 대기 | 대기 | 대기 | 대기 | 30일 renewal window |
| 30 | 제조 station 자동화 | 대기 | 대기 | 대기 | 대기 | Claim label 0600 |
| 31 | 보안 E2E/HIL gate | 대기 | 대기 | 대기 | 대기 | 실기 증거 별도 |

## 현재 결정과 주의사항

- Raspberry Pi에서 ECDSA P-256 PKCS#8 private key를 생성하며 외부로 내보내지 않는다.
- Device 인증서는 365일, MQTT 인증서는 90일이며 만료 30일 전 갱신한다.
- Root CA는 오프라인, issuing CA는 Vault PKI를 사용한다.
- 제조 enrollment token은 15분/1회용이며 Claim Code는 최초 응답에서만 노출한다.
- 실제 Raspberry Pi와 ESP32-H2가 필요한 단계는 자동 테스트와 분리해 `하드웨어 대기`로 기록한다.

## Task 23 완료 증거

- schema 계약 테스트 5개와 inventory enrollment 테스트를 포함해 9/9 통과했다.
- Prisma generate/validate와 API typecheck가 통과했다.
- 빈 임시 PostgreSQL DB에 전체 12개 migration을 `prisma migrate deploy`로 적용했고 status/introspection까지 통과했다.
- `GatewayCertificate.fingerprint`를 정본으로 사용하고 기존 inventory/gateway fingerprint는 active device 인증서 포인터로 유지한다.
- 발급·교체 시 정본과 포인터의 원자 동기화는 Task 25/29의 필수 acceptance criterion으로 이관했다.

## Task 24 완료 증거

- Vault provider/PkiModule 테스트 19/19, API 전체 114 tests, API typecheck가 통과했다.
- production에서 Vault HTTPS, token file, CA, purpose별 mount/role이 없으면 시작을 거부한다.
- non-production 기본 provider는 서버 시작은 허용하지만 실제 서명/폐기는 거부한다.
- token은 요청마다 sink file에서 다시 읽고 오류에 token/CSR/PEM/Vault body를 포함하지 않는다.

## Task 25 완료 증거

- PKCS#10 PoP/ECDSA P-256, 제조 CA 용도 분리, 1회용 token/Claim Code와 원자적 인증서 원장을 구현했다.
- token은 `<UUID>.<256-bit secret>`이며 DB에는 salted scrypt hash만 저장한다.
- serial당 미사용 enrollment 하나를 partial unique index로 강제하고 빈 PostgreSQL에 13개 migration 전체 적용을 확인했다.
- 전체 API 151 tests, 관련 재검증 22/22, typecheck/build가 통과했다.

## Task 27 완료 증거

- Device mTLS fingerprint에서 active device 인증서, claim inventory, gateway assignment를 검증한 뒤 서버 고정 `CN=Gateway.id`와 90일 TTL로 별도 MQTT 인증서를 발급한다.
- inventory별 advisory lock과 PostgreSQL partial unique index로 active MQTT 인증서를 하나로 강제하고, 교체 원장을 한 transaction에서 연결한다.
- 빈 요청, 잘못된 CSR, metadata/DB 실패, 동시 발급, Vault 지연 및 lock timeout 경로를 검증했고 임시 PostgreSQL에 전체 14개 migration 적용을 확인했다.
- Gateway는 별도 P-256 key를 내부에서 생성하고 검증된 certificate bundle을 세대별로 원자 설치한 뒤에만 BlueZ/MQTT runtime을 시작한다.
- 실패 세대 private key 정리, current 권한 fail-closed, 실제 leaf 유효기간과 응답 metadata 결속을 검증했다.
- 커밋: `340454c`, `c17895c`, `4822a8e`, `9f05810`, `60b536a`; API/Gateway 재리뷰 모두 findings 0.

## 2026-07-21 설정 권한 및 도면 에디터 이동

- 기준 계획: `docs/superpowers/plans/2026-07-21-settings-foundation-floor-editor.md`
- 역할: `operator`, `admin`, `viewer`
- 실행 정책: Task 1+2는 enum migration 중간 파손 방지를 위해 하나의 구현·리뷰 단위로 실행한다.

| Task | 범위 | 상태 | 커밋 | 리뷰 |
| --- | --- | --- | --- | --- |
| 1+2 | 역할/tenant schema와 operator bootstrap | 완료 | `cd7d430`, `fc9fd5c`, `be74154`, `b32568a`, `215859a` | Task 1~5 통합 보안 리뷰 APPROVED |
| 3 | Roles Guard, SiteAccess, Audit | 완료 | `3272f9c`, `a21d351` | APPROVED |
| 4 | 모니터링·제어 site access | 완료 | `15df496`, `c2e2d1c` | APPROVED |
| 5 | operator 설치·시운전 | 완료 | `b62167e`, `de066d5`, `b1a9816`, `da10741`, `e0c5059`, `0d798b1` | Task 1~5 통합 보안 리뷰 APPROVED |
| 6 | 설정 routing과 현장 선택 | 완료 | `b5a92bd`, `ed7cfd0`, `8b53420`, `7e75f1f`, `cb5e69d` | 재리뷰 APPROVED |
| 7 | 에디터 설정 이동 | 완료 | `295c4e9`, `f3fff58` | APPROVED |
| 8 | 원자 저장/revision API | 완료 | `d8d42f1`..`9cec664` | APPROVED |
| 9 | 변경분 저장/복구 UI | 완료 | `c43ff85`..`566bd6b` | APPROVED |
| 10 | 편집 lease | 완료 | `4182f45`..`8876664` | APPROVED |
| 11 | E2E/성능/문서 | 완료 | `4862796`..`681d818` | APPROVED |

### 중단 및 재개 안내 (2026-07-21, Task 6 완료)

- 사용자 요청에 따라 Task 6의 리뷰 수정과 재리뷰까지만 완료하고 Task 7은 시작하지 않는다.
- whole-branch final review(`.superpowers/sdd/2026-07-21-settings-foundation-floor-editor/final-review.md`)에서 C1, I1~I6, M1~M2를 발견해 2026-08-10 final fix wave를 진행했고, 현재 구현 커밋은 `219dfe3`, `cc72fa7`, `2c2eb5b`, `ef1c577`, `3e41953`이며 scoped final re-review만 대기 중이다.
- Task 7에서 모니터링의 편집 버튼과 in-memory editor branch를 제거하고, `/settings/floor-plans/:floorId/edit`가 editor state 조회·저장·취소 navigation을 소유하도록 한다.
- Task 6 검증: focused Web 37, fixture API 7, 전체 Web 65, API/Web typecheck, Web build, Docker/nginx deep route 및 `/api` proxy contract 통과. 재리뷰 APPROVED.
- Vite의 기존 대형 chunk 경고는 남아 있으며 Task 11 성능 검증에서 code splitting 후보로 재검토한다.
- corrective follow-up 증거:
  - self-contained real PostgreSQL signup integration 6/6 통과로 operator/viewer invitation의 원자 membership 생성, invalid assignment rejection, invitation rollback을 확인했다.
  - restored floor-editor PostgreSQL integration 9/9와 PostgreSQL+Redis lease integration 6/6 통과로 비-legacy save/restore coverage, stale predecessor fencing, authoritative row-lock expiry, stale/missing Redis rejection, successor save/restore 성공을 확인했다.
  - 전체 workspace `pnpm typecheck`, `pnpm lint`, `pnpm test`, focused Playwright 6개, web/api build, container contract 3개, real Docker build, `git diff --check`가 모두 통과했다.

### Task 1~5 통합 보안 리뷰 완료 (2026-07-21)

- Floor editor 기존 API를 SiteAccess `read/manage`로 전환하고 viewer write 및 미배정/cross-tenant 접근을 차단했다.
- Invitation은 transaction 안의 조건부 소비로 1회 사용을 보장한다.
- legacy migration은 Organization 유형을 추정하지 않고 기존 조직을 customer로 유지하며 어떤 사용자도 operator로 승격하지 않는다.
- legacy 역할은 User/Invitation 모두 owner/operator/admin→admin, viewer→viewer로 보존한다.
- service_provider/operator는 advisory lock과 partial unique index가 적용된 bootstrap CLI로만 명시 생성한다.
- disposable PostgreSQL migration/role matrix 및 동시 bootstrap singleton 검증 후 재리뷰 APPROVED.
- 다음 재개 지점은 Task 6 URL 기반 설정 shell과 현장 선택이다.
