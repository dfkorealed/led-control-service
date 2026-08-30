# Task 17 Web 제어 탭과 스케줄 CRUD UI 보고서

기준일: 2026-08-31

## 구현 내용

- 제어 페이지에 `수동 제어`, `스케줄 제어`, `이벤트 제어` 탭을 추가하고 `mode=manual|schedule|event` URL query로 선택 상태를 유지했다. 누락되거나 잘못된 mode는 다른 query를 보존한 채 `manual`로 정규화한다.
- 서버 `SchedulesService.toResponse`의 실제 응답을 기준으로 Web response 타입과 stable schedule query key를 정의했다. GET/POST/PATCH/DELETE는 `/sites/:siteId/automation/schedules` 계약을 사용하고 mutation 성공 시 schedule list와 dashboard를 invalidate한다.
- admin에게 추가·수정·삭제·활성화/비활성화 command를 제공하고 viewer와 operator에는 mutation command를 렌더링하지 않는다. Site 또는 사용자 변경은 schedule panel을 새 key로 remount해 열린 dialog와 표시 중인 mutation 상태를 새 scope로 넘기지 않는다.
- 목록은 이름, 활성 상태, Site timezone의 다음 실행, 반복·시간, 밝기, 대상 수, Gateway 동기화 상태, 최근 실행 결과를 표시한다. API의 bounded cursor를 100개 단위로 이어 불러오고 3초 polling한다.
- dialog는 `once|daily|weekly|monthly|yearly`, 적용 기간, 자정 통과 가능한 한 시간 구간, dimming ON 0~100%·OFF 100%, 개별/다중·층·구역 target을 지원한다. 월 29~31일과 매년 2월 29일은 허용하고 실행이 없는 기간의 건너뛰기 의미를 안내한다.
- Site 달력 날짜는 브라우저 local datetime으로 해석하지 않고 Site IANA timezone의 local noon에 해당하는 ISO instant로 변환한다. 편집 시에도 API instant를 같은 Site timezone의 달력 날짜로 복원한다.
- `schedule_overlap`, `single_gateway_required`, 입력·권한·not found와 일반 연결 실패를 서버 원문 대신 안전한 한글 메시지로 표시한다. 직접 fixture 선택은 기존 picker의 최대 1,000개 제한을 재사용한다.
- 이벤트 탭은 Task 18 전의 준비 상태만 표시하고 차량 이벤트 CRUD를 앞당겨 구현하지 않았다.

## TDD RED

1. `automation.test.ts`, `schedule-form.test.ts`를 먼저 추가하고 실행해 `automation.ts`, `schedule-form.ts`가 없어 2개 suite가 실패하는 것을 확인했다.
2. `ScheduleControlPanel.test.tsx`와 URL mode 테스트를 먼저 추가했다. panel 모듈 부재와 tab 미렌더링으로 실패했고, 같은 실행에서 기존 `ControlView` 수동 제어 테스트 41개는 통과했다.
3. 다중 fixture target canonical order 테스트를 추가해 입력 순서가 그대로 전송되는 1건 실패를 확인한 뒤 fixture ID 정렬을 구현했다.
4. 첫 typecheck에서 nullable `lastExecution`의 `kind` 타입 접근 1건이 실패하는 것을 확인하고 실제 null guard에 맞춰 `NonNullable` 타입을 적용했다.
5. 삭제 mutation 실패 메시지가 확인 dialog 안에 없음을 별도 테스트로 재현하고, 공통 `ConfirmDialog` children에 안전한 오류를 표시했다.

## GREEN 검증

- `pnpm --filter @led-control/web test -- ScheduleControlPanel.test.tsx ControlView.test.tsx automation.test.ts schedule-form.test.ts`: 4파일 67/67 통과
- `pnpm --filter @led-control/web test`: 31파일 321/321 통과
- `pnpm --filter @led-control/web typecheck`: 통과
- `pnpm --filter @led-control/web lint`: 통과
- `pnpm --filter @led-control/web build`: 통과. 기존 500 kB 초과 chunk 경고는 유지된다.

## 남은 한계

- 차량 이벤트 규칙 CRUD와 수동 override 종료 시각 입력은 Task 18 범위로 미구현이다.
- schedule CRUD의 production API/Gateway 연동 Chromium software E2E는 이번 Task에서 실행하지 않았다.
- 인앱 브라우저 제어 런타임이 현재 세션에 없어 수동 데스크톱·모바일 스크린샷 검사는 실행하지 못했다. Testing Library의 role, focus return, URL 전환과 반응 상태로 검증했다.
- Gateway offline 실행, 실제 BLE Mesh 조명 적용과 Raspberry Pi/ESP32-H2 HIL은 기존 후속 검증 범위다.
