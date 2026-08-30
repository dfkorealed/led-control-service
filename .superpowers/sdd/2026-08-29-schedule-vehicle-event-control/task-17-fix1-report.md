# Task 17 Fix Round 1 보고서

기준일: 2026-08-31

## 수정 내용

- 매년 반복은 실제 Gregorian 월·일 조합만 저장하며 2월 29일은 윤년 실행 계약으로 허용한다. 매월 29~31일은 기존 설계대로 유지한다.
- 최근 action result는 `automationExecutionActionResultPayloadV1Schema.safeParse`를 통과한 production payload만 집계한다. fixture별 `succeeded|failed|timed_out` 건수로 모두 성공·일부 실패·실패를 구분하고 legacy/unknown payload는 상세 확인 불가로 표시한다.
- infinite schedule query의 초기 로딩 오류, 다음 cursor 오류, background polling 오류를 구분한다. 기존 행은 유지하며 다음 페이지 재시도와 stale Gateway 상태 재조회를 각각 제공한다.
- ARIA tab은 선택 항목만 일반 Tab 순서에 두고 ArrowLeft/ArrowRight 순환, Home/End, focus·selection·URL 동기화와 browser back/forward 복원을 지원한다.
- schedule list/poll/mutation `401`은 `로그인 세션이 만료되었습니다.`로 안내하고 `authMeQueryKey`를 invalidate한다. 사용자·Site scope 세대당 1회만 실행하며 A→B→A 왕복 뒤 과거 mutation의 `401`도 새 principal에 적용하지 않는다. `403`과 network 오류 문구는 유지한다.

## TDD RED

1. focused 4파일을 실행해 78건 중 9건 실패를 확인했다. 실패는 연간 무효 날짜 1건, action-result/pagination/polling/401 5건, tabs keyboard/history 2건, API 401 mapping 1건이었다.
2. scope 문자열 비교만으로는 A→B→A 왕복 뒤 과거 A mutation을 구분하지 못하는 별도 실패 테스트를 확인하고 scope generation을 추가했다.
3. dialog Escape/focus wrap/return 회귀 테스트는 기존 `useDialogFocus` 계약으로 RED 실행부터 통과했다.

## GREEN 검증

- focused Web: 4파일 78/78 통과
- Web 전체: 31파일 332/332 통과
- Web typecheck: 통과
- Web lint: 통과
- Web build: 통과. workspace CommonJS인 shared production schema를 runtime import하도록 Vite 변환 범위에 shared dist를 포함했으며 기존 500 kB 초과 chunk 경고는 유지된다.
- `git diff --check`: 통과

## 남은 한계

- 차량 이벤트 규칙 CRUD와 수동 override 종료 시각 입력은 Task 18 범위로 미구현이다.
- production API/Gateway를 연결한 Chromium software E2E는 이번 fix round에서 실행하지 않았다.
- 실제 Raspberry Pi/BlueZ/ESP32-H2 RF 및 전원 차단 HIL은 실행하지 않았다.
