# Task 6 구현 보고서

## 구현 내용

- 현장 일반 유저 목록과 CRUD API 타입 및 함수를 추가했다.
- 비밀번호를 받는 생성·초기화 작업은 React Query mutation cache를 사용하지 않도록 분리했다.
- `apiDelete(path, body?)`가 선택적인 JSON body를 전송하도록 확장했다.
- Dashboard의 `capabilities`를 기준으로 제어 메뉴와 route를 차단한다.
- 권한 조회 전에는 고객 shell을 열지 않아 조회 전용 사용자가 제어 화면을 잠시 렌더링하지 않는다.
- `control` 사용자는 수동 제어만 사용하며 schedule/event query는 `manual`로 replace한다.
- admin 설정 순서를 설정 개요, 유저 관리, 조명 등록, 맵 관리, 비밀번호 변경으로 변경했다.
- 일반 유저는 설정 개요, 읽기 전용 맵 관리, 본인 비밀번호 변경만 볼 수 있다.
- Task 7 전까지 `/settings/users`는 admin 전용 route 계약과 제목만 제공한다.

## TDD 증거

- RED: 신규 API 모듈 부재, 기존 role 기반 제어 노출, viewer 비밀번호 route 차단으로 지정 테스트 6건이 실패했다.
- GREEN: Task 6 지정 테스트와 App 회귀 테스트 135개가 모두 통과했다.

## 검증 결과

- `pnpm --filter @led-control/web exec vitest run src/api/site-users.test.ts src/features/shells/CustomerShell.test.tsx src/features/shells/SettingsNavigationItem.test.tsx src/features/settings/settings-sections.test.ts src/features/control/ControlView.test.tsx src/App.test.tsx`: 135개 통과
- `pnpm --filter @led-control/web typecheck`: 통과
- `pnpm --filter @led-control/web build`: 통과
- `git diff --check`: 통과

## 자체 리뷰와 우려사항

- 일반 유저의 실제 접근 수준은 Dashboard 응답이 결정하며 role 문자열은 admin 전용 설정 분류에만 사용한다.
- 비밀번호 평문은 API 호출 인자로만 전달되고 Query/Mutation cache에는 저장하지 않는다.
- production build의 기존 메인 chunk 크기 경고는 남아 있으나 이번 권한 변경의 오류는 아니다.
- 유저 관리 본문과 강제 비밀번호 변경 화면은 계획대로 Task 7, Task 8 범위에 남겨 두었다.
