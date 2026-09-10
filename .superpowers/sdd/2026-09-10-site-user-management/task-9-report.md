# Task 9 브라우저 E2E와 문서 정합성 보고서

기준일: 2026-09-11

## 작업 결과

- mock API Chromium 3개 시나리오로 admin의 목록·생성·수정·비활성화·재활성화·비밀번호 초기화·영구 삭제 전체 여정을 검증했다.
- 신규 일반 유저의 임시 비밀번호 최초 로그인, 전용 강제 비밀번호 변경, 모니터링 진입을 검증했다.
- `read | control | admin`별 메뉴와 direct route를 검증했다. read는 제어 화면과 수동 제어 API가 차단되고, control은 manual만 허용되며 schedule/event query는 manual로 replace되고, admin은 전체 모드를 사용한다.
- RealBackendLab의 격리 PostgreSQL/API/Chromium으로 사용자를 비활성화한 PATCH의 HTTP 200과 응답 `status=disabled`, 기존 브라우저 세션의 다음 보호 요청 401, 재로그인 실패를 검증했다. 각 run은 임시 DB·Redis·API를 생성하고 종료 시 정리하며 물리 Gateway와 ESP32-H2를 사용하지 않는다.
- 비밀번호 변경으로 `User.updatedAt`이 바뀐 뒤 기존 admin 목록의 상태 변경이 409가 되는 정상 optimistic-concurrency 경계를 발견했다. UI가 `SITE_USER_CHANGED`에서 최신 profile을 refetch하고 요청한 상태만 한 번 재시도하도록 TDD로 보완했다. Real E2E는 admin 목록을 reload해 최신 revision을 받은 뒤 단일 PATCH를 검증한다.

## 테스트 결과

| 검증 | 결과 |
| --- | --- |
| mock E2E 최초 RED | 1 실패: 미구현 mock 권한/API 계약 확인 |
| mock Chromium E2E | 3 통과 |
| SiteUsersView 충돌 복구 단위 테스트 | 18 통과 |
| RealBackendLab Chromium E2E | 1 통과, 26.3초 |
| 전체 API 테스트 | 93 suite 통과, 910 통과, 환경 의존 193 skip |
| 전체 Web 테스트 | 50 file 통과, 589 통과 |
| Web/API typecheck | 모두 통과 |
| Web/API production build | 모두 통과 |
| `git diff --check` | 통과 |

- 모든 장기 명령은 Perl alarm으로 60~900초 timeout을 적용했다.
- Web build에는 기존 main chunk 500 kB 초과 경고가 남지만 build는 성공했다.
- Real E2E 조정 과정에서 실제 route와 다른 응답 matcher가 15초 timeout으로 한 번 실패했다. 실제 `PATCH /api/sites/:siteId/users/:userId`로 수정했고, 최종 실행에서는 응답 body와 상태 cell을 각각 검증했다.

## 보안 확인

- 생성·비밀번호 변경 API 응답에 password 계열 field나 입력 평문이 없는지 검사한다.
- mock 여정은 DOM, local/session storage와 React Query query/mutation cache를 검사한다.
- 두 E2E 파일은 trace와 screenshot을 비활성화했다. 최종 test artifact에는 `.last-run.json`만 있고 zip/png는 없다.
- 테스트 비밀번호는 실행 시 UUID로 만들며 보고서·로그에 실제 값을 기록하지 않는다.

## 문서

- `docs/menus/settings.md`: 일반 유저 CRUD, 권한, 충돌 복구와 미구현 onboarding 범위를 반영했다.
- `docs/menus/control.md`, `monitoring.md`, `statistics.md`: capability별 메뉴·route·API 동작과 소프트웨어 검증 범위를 반영했다.
- `docs/project-status.md`: 현장 유저 관리 Task 1~9 완료 상태를 추가했다.
- `docs/lesson_leared.md`: 시스템 role/현장 capability 분리, write transaction 재인가, 삭제 PII cache 즉시 제거를 반복 가능한 교훈으로 기록했다.
- 기존 미구현 계획은 구현 완료로 변경하지 않았고, 자동 브라우저 검증을 실장비 검증으로 표현하지 않았다.

## 커밋과 dirty worktree

- mock E2E는 `d126e02 test: cover site user management journey`로 먼저 분리 커밋했다.
- Real E2E, 충돌 복구, 실행 script와 문서/보고서는 Task 9 잔여 변경만 후속 커밋한다.
- 기존 맵 작업이 있던 `apps/web/package.json`, `docs/lesson_leared.md`, `docs/menus/monitoring.md`, `docs/menus/settings.md`, `docs/project-status.md`는 Task 9 신규 hunk만 stage한다.
- 그 밖의 기존 수정·삭제·신규 파일은 되돌리거나 stage하지 않는다.

## 미실행 범위

- Raspberry Pi, BLE Mesh, ESP32-H2와 실제 조명 HIL은 현장 유저 관리 브라우저/API 범위에 필요하지 않아 실행하지 않았다.
- 수동 in-app Browser 시각 검증은 실행하지 않았다. mock 및 격리 실백엔드 Playwright Chromium을 기능 증거로 사용했다.
