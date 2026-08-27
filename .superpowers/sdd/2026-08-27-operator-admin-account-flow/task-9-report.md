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
4. operator customer path(`/api/sites`, `/api/sites?...`, dashboard) 0건
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

- network evidence는 id, actor, method, path, status, outcome만 저장하고 request body, cookie, authorization header를 저장하지 않는다.
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

## Fix Round 1 (2026-08-27)

### 상태와 RED

- review Critical C1과 Important I1~I5를 별도 수정 단위로 처리했다. 기존 Task 9 커밋은 `7c46207`이고 이번 round commit subject는 `fix(e2e): harden isolated backend lab`이다. push/merge는 수행하지 않는다.
- failure-injection RED에서 선점된 Web port가 있어도 build/migration 단계가 4회 진입했고, 응답 없이 실패한 operator dashboard request가 isolation assertion에 잡히지 않았다.
- start 중간 실패 RED에서 SIGTERM을 무시하는 descendant가 남았고, MQTT graceful close callback이 오지 않으면 `stop()`이 250ms 안에 끝나지 않았다.
- shared DFK filter RED는 `selectDfkScanCandidates` 정본 연결이 없어 spec import 단계에서 실패했다.
- 첫 격리 auth GREEN 시도에서 workspace 절대 경로가 PostgreSQL Unix socket 길이 제한을 넘는 문제를 확인해 짧고 무작위인 `/tmp/lcs-e2e-pg-*` 전용 socket으로 고쳤다. 종료 직후 macOS의 음수 PGID probe가 `EPERM`을 반환한 문제는 실제 `ps` process-group membership 조회로 재현 가능하게 해결했다.
- gateway별 ACL 첫 journey는 acceptance/device-status ACK publish가 `Not authorized`로 거부돼 첫 dimming이 timeout되는 실패를 냈다. ACL에 이 두 gateway write topic만 추가한 뒤 전체 journey가 통과했다.

### 격리 identity와 cleanup

- lab은 어떤 build, `createdb`, migration보다 먼저 PostgreSQL/Redis/MQTT/API/Web port 선점을 확인한다. 선점 fixture test는 외부 listener에 payload를 보내지 않고 mutation-capable `run()` 0회, labDir 잔여 0개를 확인한다.
- PostgreSQL은 TCP listener를 열지 않고 실행별 private Unix socket만 사용한다. read-only `SHOW data_directory`, `postmaster.pid`, spawned PID와 postmaster liveness를 전후로 비교한 뒤에만 `createdb`와 migration을 실행한다.
- Redis는 spawned PID의 listener 소유권과 `INFO server`의 `process_id`가 일치해야 통과한다. Mosquitto는 실행별 lab CA/config/CRL과 spawned PID listener를 확인한 뒤 lab API certificate로 read-only 연결 probe를 한다.
- API와 Web은 pnpm wrapper가 아니라 Node API entry와 Vite binary를 detached process-group leader로 직접 spawn한다. spawned PID가 각 port를 소유한 상태에서만 `/auth/me` 및 Web 응답을 health evidence로 인정하므로 기존 5173/API service를 재사용할 수 없다.
- child spawn error와 identity 확인 전 early exit를 즉시 실패로 처리한다. `stop()`은 background/MQTT stage를 각각 bounded all-settled로 처리하고, graceful MQTT timeout에는 forced close를 적용한다. 이후 모든 process group을 TERM, timeout, KILL, 실제 membership 0 순서로 종료하며 앞 단계 실패와 무관하게 labDir과 private socket directory를 삭제한다.
- focused test가 선점 port 외부 fixture 비침해, start 중간 실패, TERM 무시 descendant KILL, hung MQTT forced close를 검증했다. 최종 확인에서 `.local/e2e-real-backend/task9-*`, `/tmp/lcs-e2e-pg-*`, lab port listener와 관련 process group은 모두 0개였다.

### Network와 secret evidence

- network evidence는 `request` 시점에 `{ id, actor, method, path, status: null, outcome: pending }`만 만들고 `response`로 status를 correlation한다. `requestfailed`도 `failed`로 남으므로 취소·실패 request가 0건 assertion에서 빠지지 않는다.
- header, cookie, authorization, request/response body는 수집하지 않는다. 최종 operator customer path(`/api/sites`, `/api/sites?...`, dashboard) 결과는 0건이며 이 값이 총 request 수와 무관한 정본이다.
- runtime 비밀번호, claim code와 key는 source/docs에 쓰지 않고 trace와 자동 screenshot을 비활성화한다. 지정된 비-secret 화면 screenshot만 남기고 evidence/log 저장 전 runtime secret을 마스킹한다. 최종 artifact에는 `.key`, PEM, trace, HAR가 0개였다.

### Simulator 범위와 증거

- test-support publisher는 shared package의 production 정본 `parseDfkDeviceUuid`를 직접 호출한다. 각 scan attempt evidence는 후보 3개, 허용 2개, invalid/타사 UUID 제외 1개이며 scan-found는 허용 후보 2개에만 발행됐다. 판별 로직을 support에 복제하지 않았다.
- simulator는 API service certificate를 사용하지 않는다. claim 후 lab CA가 `CN=Gateway.id`인 gateway 전용 client certificate를 발급하고 broker는 own-gateway commands read, application ACK read, 필요한 event/state/command ACK write만 허용한다. negative probe는 다른 gateway state와 자기 command topic publish 2건이 모두 거부됨을 확인했다.
- 위 검증은 lab CA와 test-generated Mosquitto ACL의 software 범위다. production Gateway certificate API 발급·device mTLS bootstrap·배포 broker ACL, 실제 `apps/gateway` runtime, BlueZ scan/provisioning, RF와 ESP32-H2를 검증했다고 주장하지 않는다.
- browser journey는 production API/auth/claim/registration/outbox/command ACK/state ingestion 경로를 통과하며 최종 `2 passed`다. Raspberry Pi/ESP32-H2 HIL과 controller in-app browser 수동 QA는 계속 미실행이다.

### Real auth와 전체 검증

- `e2e:auth:real`은 외부 `E2E_OPERATOR_*`, 개발 API/DB와 5173를 요구하지 않고 RealBackendLab에서 runtime operator를 bootstrap한다. `playwright.config.ts`의 installation `testIgnore`를 제거했으며 full Chromium에서는 real lab spec 3건이 명시적 환경 skip으로 집계된다. 일반 browser regression은 skip하지 않았다.
- focused helper: `5 passed`; isolated `e2e:auth:real`: `1 passed`; focused/final `e2e:journey:real`: `2 passed`.
- `pnpm typecheck`: PASS. `pnpm lint`: PASS.
- `pnpm test`: PASS. root 15, shared 53, mobile 1, Web 280, Gateway 289, API 596 passed; API 환경 조건부 69 skipped.
- full Chromium: `29 passed, 3 skipped`이며 skipped 3건은 `auth-real` 1건과 installation real lab 2건이다.
- final real journey: `2 passed (48.3s)`. operator customer path 0건, scan filter 3/2/1, gateway ACL negative publish 2건 거부가 evidence에 남았다.
- `git diff --check`: PASS.

### 변경 파일과 남은 수동 검증

- 코드/설정: `apps/web/e2e/support/real-backend-lab.ts`, `real-backend-lab-support.spec.ts`, `auth-real.spec.ts`, `installation-customer-journey.spec.ts`, `apps/web/playwright.config.ts`, `apps/web/package.json`, `README.md`.
- 문서/ledger: Task 9 report, operator-admin plan의 Task 6·Task 9 checklist, plan 전용 local progress ledger, project status, monitoring/control/settings 메뉴 문서와 first-install runbook.
- controller 수동 QA URL과 역할 준비는 기존 `Controller 수동 브라우저 QA 준비` 절을 따른다. 실제 계정 secret은 승인된 runtime channel로만 전달하며 DevTools에서 operator customer path 0건과 admin 생성 응답 password field 0개를 다시 확인한다.
- 남은 concern은 production Gateway identity/bootstrap/ACL deployment, Raspberry Pi BlueZ, ESP32-H2 2-node RF scan/provisioning/model bind/control/state, packet loss/timeout/reboot HIL과 controller 수동 QA다.

## Fix Round 2 (2026-08-27)

### RED와 원인

- 최초 MQTT 연결 오류 failure-injection test를 먼저 추가했다. 첫 RED는 `connectMqttForLab` export 부재로 실패했고, 기존 connector를 test seam으로 노출한 다음에는 `reconnectPeriod`가 기대값 `0`이 아니라 `undefined`여서 실패했다. 이 시점의 구현은 error reject 전에 client reconnect와 `end(true)`를 보장하지 않았다.
- lab ACL byte-for-byte test는 기존 broad `acks/#` read와 별도 `heartbeat` write가 남아 있고 두 application ACK read topic이 명시되지 않아 `infra/mosquitto.acl.example`과의 diff로 실패했다.
- 최초 ACL read negative probe는 Mosquitto가 read ACL을 delivery에서 적용하면서 금지 wildcard subscription에도 성공 SUBACK을 반환해 journey가 실패했다. probe를 API principal의 고유 marker publish 후 gateway 미수신 확인으로 고쳐 broker의 실제 read 차단을 검증했다.
- start 중간 실패와 선점 port test는 default lab port 상태에 의존할 수 있었다. 각 test가 5개 lab port를 동적으로 배정하도록 바꿔 로컬 기본 listener 유무와 분리했다.

### GREEN 구현과 증거

- `connectMqttForLab`은 client를 성공 전부터 소유하고 handshake 동안 `reconnectPeriod: 0`을 강제한다. 최초 error에서는 connect/error listener를 제거하고 reconnect를 다시 차단한 뒤 `end(true)`를 호출하며, close callback이 오지 않아도 bounded timeout 후 원래 연결 오류로 reject한다. 연결 성공 후에만 원래 reconnect 설정을 복원하고 client ownership을 호출자에게 넘긴다.
- lab ACL은 `infra/mosquitto.acl.example`을 그대로 복사해 생성하므로 API의 `sites/#` readwrite와 gateway의 own commands, 두 application ACK read, acceptance/device-status/state/events write만 허용한다. broad `acks/#`와 별도 heartbeat rule은 없다.
- gateway simulator도 두 허용 ACK topic만 subscribe한다. negative probe는 다른 gateway state와 자기 command publish 2건 거부, 다른 gateway command와 자기 broad ACK read 2건 미전달을 확인했다. 최종 MQTT evidence는 `{ deniedPublishCount: 2, deniedReadCount: 2 }`다.
- 최종 network evidence record는 `{ id, actor, method, path, status, outcome }`만 포함한다. header, cookie, authorization, body는 저장하지 않으며 operator customer path 결과는 0건이다.
- 이는 lab CA가 발급한 test-only gateway certificate/CN과 software Mosquitto ACL 증거다. production Gateway certificate bootstrap/배포 ACL, 실제 `apps/gateway`, BlueZ/RF, Raspberry Pi/ESP32-H2 HIL을 검증한 결과가 아니다.

### 검증 결과

| 명령 | 결과 |
| --- | --- |
| focused helper RED | MQTT connector 미노출 후 `reconnectPeriod` 불일치 실패, ACL 정본 diff 실패 |
| `pnpm --filter @led-control/web exec playwright test e2e/real-backend-lab-support.spec.ts --project=chromium` | PASS: 7 passed |
| `pnpm --filter @led-control/web e2e:auth:real` | PASS: 1 passed, 15.3s |
| `pnpm --filter @led-control/web e2e:journey:real` | PASS: 2 passed, 47.6s |
| `pnpm --filter @led-control/web exec playwright test --project=chromium` | PASS: 31 passed, 3 explicit real-lab env skipped |
| `pnpm --filter @led-control/web typecheck` | PASS |
| `pnpm --filter @led-control/web lint` | PASS |
| `pnpm --filter @led-control/web test` | PASS: 28 files, 280 tests |
| `git diff --check` | PASS |

최종 cleanup audit에서 `.local/e2e-real-backend/task9-*`, `/tmp/lcs-e2e-pg-*`, lab/default port listener와 관련 process group은 모두 0개였다. controller 수동 in-app browser QA와 production Gateway/BlueZ/RF/ESP32-H2 HIL은 계속 미실행이다.

### 변경 파일

- `apps/web/e2e/support/real-backend-lab.ts`
- `apps/web/e2e/real-backend-lab-support.spec.ts`
- `.superpowers/sdd/2026-08-27-operator-admin-account-flow/task-9-report.md`
- `.superpowers/sdd/2026-08-27-operator-admin-account-flow/progress.md` (plan 전용 local ledger append)

별도 commit subject는 `fix(e2e): close failed MQTT lab clients`이며 push/merge는 수행하지 않는다.
