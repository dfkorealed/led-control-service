# Task 18 Web 차량 이벤트 CRUD와 수동 override UI 보고서

기준일: 2026-08-31

## 구현 내용

- `VehicleEventControlPanel`과 `VehicleEventDialog`로 event rule의 admin 생성·수정·삭제·활성화/비활성화, viewer read-only 목록, cursor pagination, 3초 polling, Gateway sync와 최근 감지를 연결했다.
- source picker는 Dashboard fixture의 Gateway 등록, `vehicleSensorCapabilityStatus === "supported"`, verified timestamp를 모두 확인한 fixture만 보인다. Dashboard API가 해당 capability 읽기 모델을 제공하도록 최소 보완했다.
- 수동 제어에 local `datetime-local` 종료 시각을 추가했다. 기본값은 현재부터 1시간이며 ISO `overrideUntil`로 전송한다. 빈 값은 API field를 생략해 서버 기본값을 유지하고, 과거와 30일 초과 값은 Web에서 거부한다.

## TDD RED

1. `vehicle-event-form.test.ts`와 `VehicleEventControlPanel.test.tsx`를 먼저 추가했다. 존재하지 않는 form/panel module 때문에 0 test suite load 실패가 발생했다.
2. `ControlView.test.tsx`를 먼저 확장했다. event tab은 기존 placeholder만 렌더링했고 수동 override input이 없어 각각 실패했다.
3. `SitesService` unit test는 supported capability와 verified timestamp가 Dashboard fixture에 없어서 실패했다.

## GREEN 증거

- `pnpm --filter @led-control/web test -- VehicleEventControlPanel.test.tsx vehicle-event-form.test.ts automation.test.ts ControlView.test.tsx`: 4 files, 63/63 passed.
- `pnpm --filter @led-control/api test -- sites.service.spec.ts --runInBand`: 5/5 passed.
- `pnpm --filter @led-control/web typecheck`: passed.
- `pnpm --filter @led-control/api typecheck`: passed.
- `pnpm --filter @led-control/web test`: 34 files, 342/342 passed.
- `pnpm --filter @led-control/web build`: passed. Event panel is emitted as a lazy 11.98 kB chunk.

## 변경 파일

- `apps/api/src/sites/sites.service.ts`, `apps/api/src/sites/sites.service.spec.ts`
- `apps/web/src/api/automation.ts`, `apps/web/src/api/automation.test.ts`, `apps/web/src/api/queries.ts`
- `apps/web/src/features/control/ControlTargetPicker.tsx`, `apps/web/src/features/control/ControlView.tsx`, `apps/web/src/features/control/ControlView.test.tsx`
- `apps/web/src/features/control/automation/VehicleEventControlPanel.tsx`, `VehicleEventControlPanel.test.tsx`, `VehicleEventDialog.tsx`, `vehicle-event-form.ts`, `vehicle-event-form.test.ts`
- `docs/menus/control.md`, `docs/project-status.md`, `docs/superpowers/plans/2026-08-29-schedule-vehicle-event-control.md`
- `.superpowers/sdd/2026-08-29-schedule-vehicle-event-control/task-18-report.md`

## 실행 명령과 결과

- Focused Web, API unit, Web/API typecheck, 전체 Web test와 Web build는 위 GREEN 증거대로 통과했다.
- 병렬로 Web test와 typecheck를 실행한 첫 시도는 shared build cleanup이 동일 artifact를 동시에 제거해 `ENOENT`가 발생했다. 이후 모든 shared build 의존 검증을 순차 실행했고 통과했다.
- `git diff --check`를 최종 실행해 whitespace 오류가 없음을 확인했다.

## Self-review

- API DTO와 controller의 기존 event CRUD route 및 `overrideUntil` optional 계약을 변경하지 않았다.
- source visibility는 Web convenience filter일 뿐이며 API의 registered/capability/single-Gateway fail-closed 검증을 대체하지 않는다.
- event panel과 manual input은 desktop Web 범위만 변경했고 mobile은 수정하지 않았다.
- event panel lazy import, dialog focus trap, viewer mutation 은닉, query invalidation과 scope-bound 401 invalidation을 Schedule UI convention에 맞췄다.

## 우려사항

- production API/Gateway Chromium E2E와 Raspberry Pi/BlueZ/ESP32-H2 HIL은 Task 19 이후 범위로 미실행이다.
- Vite는 기존과 같이 500 kB를 넘는 main bundle 경고를 출력한다. 새 event panel은 별도 chunk로 분리됐다.
