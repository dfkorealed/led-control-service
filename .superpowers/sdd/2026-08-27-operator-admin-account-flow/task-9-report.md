# Task 9 실백엔드 E2E·전체 회귀 보고서

기준일: 2026-08-27

## 상태

- operator/admin 계정 전환의 software E2E와 전체 자동 회귀를 완료했다.
- 커밋: `HEAD` / `test(e2e): verify admin-led site installation`
- push와 merge는 수행하지 않는다.
- controller의 실제 in-app browser 수동 QA와 Raspberry Pi/ESP32-H2 HIL은 미실행이다.

## RED

1. 이전 journey를 `E2E_REAL_BACKEND_LAB=1 pnpm --filter @led-control/web exec playwright test e2e/installation-customer-journey.spec.ts --project=chromium --trace=off`로 실행했다.
2. 기존 테스트는 operator 로그인 뒤 `초기 설치 설정`을 기대했지만 실제 앱은 `/operator/site-admins`의 `현장 관리자 계정`으로 이동해 실패했다. 이는 폐기된 operator 설치 계약을 재현한 RED다.
3. `SetupWizard.test.tsx`에 시간대 선택과 payload 검증을 먼저 추가했고 `시간대` label 부재로 RED를 확인했다.
4. `FloorEditorRoute.test.tsx`에 최초 lease 요청 실패 뒤 재시도 검증을 먼저 추가했고 호출 1회로 RED를 확인했다. 실백엔드 StrictMode에서 경합한 lease 요청 중 하나가 PostgreSQL `40001`로 실패한 뒤 활성 effect가 읽기 전용에 고정되는 원인이었다.
5. 최종 `pnpm test`의 첫 실행은 Gateway journal 테스트 1개가 실패했다. ACK 시각은 2026-08-26 고정인데 현재 clock은 실제 시간을 사용해 24시간 보존 기간이 지나 정상 prune되는 시간 의존 테스트였다.

## GREEN

- Setup wizard가 IANA 시간대 선택을 제공하고 `POST /setup/initial-site`에 `timeZone`을 전송한다.
- Floor editor가 최초 lease 예외를 250ms 뒤 다시 시도해 실백엔드 StrictMode 경합에서도 editable 상태로 수렴한다.
- Gateway journal 테스트 clock을 ACK 직후로 고정해 보존 기간 안의 application ACK terminal 비재생 계약을 결정적으로 검증한다.
- 새 browser journey와 production bundle isolation 테스트가 최종 실행에서 `2 passed`다.

## Lab 격리

- 매 실행 `task9-{pid}-{timestamp}-{random}` 전용 디렉터리를 만들고 그 안에서 `initdb`로 새 PostgreSQL cluster와 `createdb`를 생성한다.
- 전용 PostgreSQL, Redis, mTLS Mosquitto, API, Web 프로세스를 사용한다. 지정 포트가 이미 사용 중이면 기존 서비스에 붙지 않고 즉시 실패한다.
- `DATABASE_URL`은 전용 PostgreSQL port만 가리킨다. 사용자 개발 DB를 조회하거나 migrate/reset하지 않는다.
- test-only Gateway inventory, viewer User/SiteMembership, software MQTT publisher는 `apps/web/e2e/support/real-backend-lab.ts`에만 있다.
- 시작 중 실패와 정상 종료 모두 MQTT/background task를 drain하고 자식 프로세스를 TERM/KILL 경계로 종료한 뒤 전용 디렉터리를 삭제한다.
- 최종 실행 뒤 `.local/e2e-real-backend/task9-*` 잔여 디렉터리가 0개임을 확인했다.
- production Web build에서 lab sentinel과 `real-backend-lab` 문자열이 없음을 별도 테스트로 확인했다.

## Journey와 증거

1. operator `loginId` 로그인과 `/operator/site-admins` 도착
2. UI에서 고객사, pending Site, assigned admin 생성
3. 생성 응답에 password 계열 필드가 없고 operator customer deep link가 모두 전용 route로 복귀
4. operator network 13건 중 `/api/sites`와 dashboard 0건
5. logout 후 발급 admin 로그인, selected Site를 보존한 pending `/settings` redirect
6. UI에서 주소, kWh 단가, `Asia/Seoul`, B1 층 설정
7. 격리 제조 inventory의 serial/일회성 code로 production Gateway claim
8. 첫 scan 0건 완료, UI 재검색, test support가 주입한 자사 node 2개 검색
9. UI 전체 선택·일괄 설정으로 node 2개 registration/provisioning 완료
10. 모니터링에서 실제 fixture-state와 Health snapshot 확인
11. 개별, 임의 다중, 층, 저장 구역 4개 dimming command를 production API로 생성
12. software Gateway simulator가 MQTT acceptance/device-status ACK와 fixture-state를 발행하고 API state-ingested ACK까지 수신
13. 24시간 100% 기준 통계와 등록 조명 2개 기준 문구 확인
14. UI floor editor에서 조명 X 좌표 저장 후 모니터링 CSS 좌표 반영 확인
15. UI 비밀번호 변경, 이전 비밀번호 로그인 실패, 새 비밀번호 로그인 성공
16. 격리 DB viewer fixture 로그인, 제어 비활성화, 비밀번호 메뉴 미노출, 도면 read-only 확인

최종 evidence에는 scan-start 2, scan-completed 2, scan-found 2, provision command/completed 각 2, dimming command 4, mesh subscription sync/result 각 2, fixture-state/state-ingested ACK 각 73건이 기록됐다. 이는 software simulator 증거이며 Raspberry Pi/ESP32-H2 HIL 증거가 아니다.

## Network·Secret 처리

- network evidence는 actor, method, path, status만 저장하고 request body, cookie, authorization header를 저장하지 않는다.
- operator customer path 판정은 `/api/sites`, `/api/sites?...`, dashboard path를 포함하며 최종 결과는 0건이다.
- operator/admin/viewer 비밀번호와 claim code는 실행마다 crypto random 값으로만 만든다. 문서와 소스에 실제 값이 없다.
- real-backend lab과 real-auth 테스트는 Playwright trace/screenshot 자동 수집을 끈다.
- 수동 screenshot은 secret 입력 dialog가 닫힌 operator 목록, admin 모니터링, viewer 설정 화면에서만 생성한다.
- evidence 저장 전 모든 runtime 비밀번호와 claim code를 `[REDACTED]`로 마스킹한다. private key는 lab 디렉터리 밖으로 복사하지 않는다.
- 최종 artifact 검색에서 password/claim/private-key 원문은 없었고 API route 이름만 확인됐다.

## 명령 결과

| 명령 | 결과 |
| --- | --- |
| focused old journey RED | 실패 확인: operator 설치 heading 부재 |
| `pnpm --filter @led-control/web exec vitest run src/features/setup/SetupWizard.test.tsx` | PASS, 6 tests |
| `pnpm --filter @led-control/web exec vitest run src/features/settings/floor-plans/FloorEditorRoute.test.tsx` | PASS, 27 tests |
| `pnpm --filter @led-control/gateway exec vitest run src/state/provisioning-scan-journal.test.ts` | PASS, 16 tests |
| `pnpm typecheck` | PASS |
| `pnpm lint` | PASS |
| `pnpm test` | PASS: root 15, shared 53, mobile 1, web 280, gateway 289, API 596; API 환경 조건부 69 skipped |
| `pnpm --filter @led-control/web exec playwright test --project=chromium` | PASS: 24 passed, real-auth 1 skipped |
| `pnpm --filter @led-control/web e2e:journey:real` | PASS: 2 passed, 47.9s |

## 변경 파일

- 실백엔드: `apps/web/e2e/installation-customer-journey.spec.ts`, `apps/web/e2e/support/real-backend-lab.ts`, `apps/web/playwright.config.ts`
- 브라우저 회귀: `apps/web/e2e/auth-real.spec.ts`, `floor-editor-layout.spec.ts`, `monitoring-control-flow.spec.ts`, `mvp1.spec.ts`, `settings-floor-editor.spec.ts`, `statistics-flow.spec.ts`, `support/settings-api.ts`
- Web 동작·단위 테스트: `SetupWizard.tsx`와 테스트, `FloorEditorRoute.tsx`와 테스트, `ControlView.tsx`, `App.test.tsx`
- 전체 회귀 안정화: `apps/gateway/src/state/provisioning-scan-journal.test.ts`
- 문서: `docs/project-status.md`, `docs/menus/monitoring.md`, `control.md`, `settings.md`, `docs/runbooks/device-lab-first-install.md`, Task 9 checklist, 이 보고서

## Controller 수동 브라우저 QA 준비

- URL: `http://localhost:5173`
- operator: QA 환경의 `BOOTSTRAP_OPERATOR_LOGIN_ID`/`BOOTSTRAP_OPERATOR_PASSWORD`로 준비한 service-provider operator 1명
- admin: `/operator/site-admins`의 UI로 새 pending Site와 함께 발급한 assigned admin 1명
- viewer: 같은 customer Organization과 SiteMembership을 가진 별도 viewer 1명. 공개 signup UI는 사용하지 않는다.
- secret은 런타임 환경 변수 또는 승인된 secret manager로만 전달하고 보고서, 채팅, screenshot, HAR에 기록하지 않는다.
- 확인 항목: 역할별 deep link/새로고침, operator CRUD 확인 dialog, pending setup, claim·0건 scan·재검색·등록, 네 가지 제어, 통계, map save, password 교체, viewer read-only.
- DevTools Network: operator `/api/sites`와 dashboard 0건, admin create 응답 password 계열 필드 0개를 확인한다.

## 남은 HIL과 우려

- Raspberry Pi 실제 BlueZ adapter, ESP32-H2 2대의 RF scan/provisioning/model bind는 실행하지 않았다.
- 실제 BLE Mesh unicast/group 전송, Lightness Status, Health Current, packet loss/timeout, 재부팅 복구를 실행하지 않았다.
- controller의 실제 in-app browser 수동 QA는 Task review 뒤 남아 있다.
- 모바일과 재설치는 Task 9 범위 밖이다.
