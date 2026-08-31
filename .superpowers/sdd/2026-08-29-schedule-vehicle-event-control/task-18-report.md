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
- event panel lazy import, dialog focus trap, viewer mutation 은닉을 Schedule UI convention에 맞췄다. Fix Round 1에서 event mutation의 auth/cache side effect는 scope와 독립적으로 수행하고 UI state만 scope generation으로 제한하도록 보완했다.

## 우려사항

- production API/Gateway Chromium E2E와 Raspberry Pi/BlueZ/ESP32-H2 HIL은 Task 19 이후 범위로 미실행이다.
- Vite는 기존과 같이 500 kB를 넘는 main bundle 경고를 출력한다. 새 event panel은 별도 chunk로 분리됐다.

## Fix Round 1 (2026-08-31)

### RED 증거

- `pnpm --filter @led-control/web test -- VehicleEventControlPanel.test.tsx vehicle-event-form.test.ts ControlView.test.tsx`에서 기존 구현은 9건 실패했다. dimming OFF의 stale brightness 검증, `undefined` verified timestamp source 노출, 오류 ARIA 연결, unmount 뒤 mutation `401`/cache invalidation, cursor/background `401` 분류, Site/user scope의 override reset이 각각 요구한 이유로 실패했다.
- scope reset 테스트의 첫 `waitFor`는 fake timer 대기 자체로 timeout이어서 동기 assertion으로 바꿨고, 기존 값 `2030-01-01T00:00`이 유지되는 실제 실패를 확인했다.
- canonical timestamp 경계를 추가해 `2026-02-30T00:00:00.000Z`가 JavaScript `Date.parse()`에서 보정되어 source로 노출되는 RED를 추가로 확인했다.

### GREEN 증거

- `pnpm --filter @led-control/web typecheck && pnpm --filter @led-control/web test -- VehicleEventControlPanel.test.tsx vehicle-event-form.test.ts ControlView.test.tsx`: typecheck 통과, 3 files 63/63 passed.
- `pnpm --filter @led-control/web test`: 34 files 352/352 passed.
- `pnpm --filter @led-control/api test`: 79 passed suites, 727 passed tests, 18 suites/159 tests skipped.
- `pnpm --filter @led-control/web typecheck`, `lint`, `build`와 `pnpm --filter @led-control/api typecheck`, `lint`, `build`: 모두 통과.

### Fix Round 1 변경과 self-review

- `VehicleEventControlPanel`의 mutation auth/cache 처리를 mutation-level callback으로 이동해 observer unmount 뒤에도 원래 Site query와 Dashboard cache를 invalidate하고, `401`은 현재 scope와 무관하게 `auth/me`를 invalidate한다. UI message/dialog state만 generation으로 제한한다.
- 모든 event query failure path는 `401`을 세션 만료로 먼저 표시한다. source capability는 Gateway 등록·supported·canonical ISO timestamp를 모두 요구한다.
- dimming OFF는 hidden brightness를 검증하지 않고 100으로 정규화한다. manual override default는 Site/user scope reset에서 다시 계산한다.
- field/group validation error는 stable id와 ARIA error relation을 갖고 첫 invalid group/control로 focus한다.

### Fix Round 1 우려사항

- Web/API unit·build 검증은 production API/Gateway Chromium E2E나 Raspberry Pi/BlueZ/ESP32-H2 HIL을 대체하지 않는다.
- Vite main bundle warning은 기존 상태로 남아 있고, event panel은 lazy chunk `13.32 kB`로 분리됐다.
