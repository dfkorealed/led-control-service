# Task 9 브라우저 E2E와 문서 정합성 보고서

기준일: 2026-09-11

## 작업 결과

- mock API Chromium 4개 시나리오로 admin의 목록·생성·수정·비활성화·재활성화·비밀번호 초기화·영구 삭제 전체 여정과 중복 로그인 아이디·100명 상한 초과 오류를 검증했다. 100명 검증은 이미 100명인 상태의 단일 생성 요청 거절 범위이며 동시 요청 경쟁 조건을 주장하지 않는다. 생성 POST와 수정 PATCH fixture는 exact key, 필수값, enum과 `expectedUpdatedAt`을 검사해 잘못된 클라이언트 body를 허용하지 않는다.
- 신규 일반 유저의 임시 비밀번호 최초 로그인, 전용 강제 비밀번호 변경, 변경 전 보호 API의 `403 PASSWORD_CHANGE_REQUIRED`, 변경 후 모니터링 진입을 검증했다.
- `read | control | admin`별 주 메뉴와 설정 하위 메뉴의 exact 노출 범위를 검증했다. read/control 일반 유저의 `/settings/users` 직접 접근은 `/settings`로 replace되고, read는 제어 화면과 수동 제어 API가 차단되며, control은 manual만 허용되고 schedule/event query는 manual로 replace된다. admin은 전체 제어 모드와 유저 관리 화면을 사용한다.
- RealBackendLab의 격리 PostgreSQL/API/Chromium으로 강제 비밀번호 변경 전 보호 API의 `403 PASSWORD_CHANGE_REQUIRED`, 변경 후 read 사용자 메뉴와 `/settings/users` 직접 접근 차단, 사용자를 비활성화한 PATCH의 HTTP 200과 응답 `status=disabled`, 기존 브라우저 세션의 다음 보호 요청 401, 재로그인 실패를 검증했다. 각 run은 임시 DB·Redis·API를 생성하고 종료 시 정리하며 물리 Gateway와 ESP32-H2를 사용하지 않는다.
- 비밀번호 변경으로 `User.updatedAt`이 바뀐 뒤 기존 admin 목록의 상태 변경이 409가 되는 정상 optimistic-concurrency 경계를 발견했다. UI가 `SITE_USER_CHANGED`에서 최신 profile을 refetch하고 요청한 상태만 한 번 재시도하도록 TDD로 보완했다. Real E2E는 admin 목록을 reload해 최신 revision을 받은 뒤 단일 PATCH를 검증한다.

## 테스트 결과

| 검증 | 결과 |
| --- | --- |
| mock E2E 최초 RED | 1 실패: 중복 로그인 아이디를 201 처리하는 느슨한 mock POST 확인 |
| PATCH body mutation RED | 1 실패: `expectedUpdatedAt` 오타를 exact-key assertion이 검출, 즉시 원복 |
| mock Chromium E2E | 4 통과, 6.6초 |
| `SiteUsersView` 단위 테스트 | 1 file, 18 통과 |
| 관련 API 단위 테스트 | 4 suite, 81 통과 |
| RealBackendLab Chromium E2E | 1 통과, 26.4초 |
| Web typecheck | 통과 |
| `git diff --check` | 통과 |

- 기준 커밋 `2811916`에서 기록한 전체 API 910개·Web 589개 및 Web/API build 결과는 이번 리뷰 수정에서 재실행한 수치로 간주하지 않는다. 이번 변경은 위 관련 단위·E2E와 Web typecheck로 다시 검증했다.
- Real E2E 조정 과정에서 실제 route와 다른 응답 matcher가 15초 timeout으로 한 번 실패했다. 실제 `PATCH /api/sites/:siteId/users/:userId`로 수정했고, 최종 실행에서는 응답 body와 상태 cell을 각각 검증했다.

## 보안 확인

- 생성·비밀번호 변경 API 응답에 password 계열 field나 입력 평문이 없는지 검사한다.
- mock E2E는 API 응답, DOM/input 값과 local/session storage를 검사한다. React Query query/mutation cache의 password·삭제 PII 부재는 `SiteUsersView.test.tsx` 단위 테스트가 검증하며, Playwright가 애플리케이션 내부 QueryClient를 직접 검사한다고 주장하지 않는다.
- 두 E2E 파일은 trace와 screenshot을 비활성화했다. 최종 test artifact에는 `.last-run.json`만 있고 zip/png는 없다.
- 테스트 비밀번호는 실행 시 UUID로 만들며, 비밀번호 부재 assertion은 해시 또는 최종 boolean만 matcher에 전달해 실패 메시지에도 평문을 넣지 않는다.

## 문서

- `docs/menus/settings.md`: 일반 유저 CRUD, 권한, 충돌 복구와 미구현 onboarding 범위를 반영했다.
- `docs/menus/control.md`, `monitoring.md`, `statistics.md`: capability별 메뉴·route·API 동작과 소프트웨어 검증 범위를 반영했다.
- `docs/project-status.md`: 현장 유저 관리 Task 1~9 완료 상태를 추가했다.
- `docs/lesson_leared.md`: 시스템 role/현장 capability 분리, write transaction 재인가, 삭제 PII cache 즉시 제거를 반복 가능한 교훈으로 기록했다.
- 기존 미구현 계획은 구현 완료로 변경하지 않았고, 자동 브라우저 검증을 실장비 검증으로 표현하지 않았다.

## 커밋과 dirty worktree

- mock E2E는 `d126e02 test: cover site user management journey`로 먼저 분리 커밋했다.
- Real E2E, 충돌 복구, 실행 script와 문서/보고서는 `2811916 test: cover site user management journey`에 반영했다.
- 리뷰 수정은 `fix(test): harden site user e2e coverage` 단일 커밋으로 분리한다.
- 기존 맵 작업이 있던 `apps/web/package.json`, `docs/lesson_leared.md`, `docs/menus/monitoring.md`, `docs/menus/settings.md`, `docs/project-status.md`는 Task 9 신규 hunk만 stage한다.
- 그 밖의 기존 수정·삭제·신규 파일은 되돌리거나 stage하지 않는다.

## 미실행 범위

- Raspberry Pi, BLE Mesh, ESP32-H2와 실제 조명 HIL은 현장 유저 관리 브라우저/API 범위에 필요하지 않아 실행하지 않았다.
- 수동 in-app Browser 시각 검증은 실행하지 않았다. mock 및 격리 실백엔드 Playwright Chromium을 기능 증거로 사용했다.
