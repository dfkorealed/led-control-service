# Task 8 구현 보고서

## 상태

`DONE_WITH_CONCERNS`

모니터링 읽기 모델과 `FloorScene`을 CAD 맵 좌표계로 연결하고, revision 복구가 현재 CAD slot 상태와 무관하게 snapshot의 plan, object, fixture, slot 및 assignment를 한 transaction에서 복원하도록 구현했다.

## RED / GREEN

### RED

- `pnpm --filter @led-control/shared test -- schemas.test.ts`
  - 결과: `floorMapSnapshotSchema`가 배정 fixture layout을 거부해 실패했다.
- `pnpm --filter @led-control/api test -- floor-map.service.spec.ts --runInBand`
  - 결과: 읽기 DTO에 배정 fixture가 없어 실패했다.
- `pnpm --filter @led-control/web test -- FloorScene.test.tsx`
  - 결과: snapshot의 배정 좌표와 미배정 fixture 필터가 적용되지 않아 실패했다.
- `FLOOR_EDITOR_TEST_DATABASE_URL=postgresql://led:led@127.0.0.1:5432/led_control_floor_task8?schema=public pnpm --filter @led-control/api test -- floor-editor.integration.spec.ts --runInBand -t "restores the historical slot set"`
  - 결과: 현재 slot이 남고 과거 revision의 두 slot과 assignment가 복원되지 않아 실패했다.
- `pnpm --filter @led-control/shared test -- cad-import-contracts.test.ts`
  - 결과: source job/candidate 중 하나만 있는 불완전한 snapshot slot이 허용되어 실패했다.

### GREEN

- Shared focused test: 2 files, 33 tests passed.
- API focused test: 2 suites, 24 tests passed. 실제 PostgreSQL에서 revision 복구 및 snapshot/hash 일치를 검증했다.
- Web focused test: 2 files, 81 tests passed.
- `pnpm --filter @led-control/shared build`: 통과.
- `pnpm --filter @led-control/api typecheck`: 통과.
- `pnpm --filter @led-control/web typecheck`: 통과.
- `git diff --check`: 통과.

## 구현 내용

- 모니터링 DTO는 내부 `FloorLightSlot` 목록을 노출하지 않는다. CAD plan, 보이는 map object, slot에 배정되고 `placed`인 fixture의 ID, 이름, slot 좌표와 크기만 반환한다.
- `FloorScene`은 snapshot fixture layout을 runtime 상태와 ID로 O(n) 결합한다. 좌표는 설정 맵의 slot 좌표를 사용하고, runtime 상태가 아직 없으면 offline fallback으로 표시한다. 저장 직후 React Query cache도 같은 계약으로 갱신한다.
- 신규 V2 revision snapshot은 slot의 source import job/candidate 참조를 함께 저장한다. 복구는 source 소속을 검증하고 현재 slot 전체를 snapshot 목록으로 교체한 뒤 assignment와 fixture placement/좌표 invariant를 확인한다.
- plan, object, fixture, slot 교체와 신규 revision/audit 생성은 기존 Serializable transaction 안에서 수행된다. 복구 후 생성된 snapshot과 SHA-256이 원본 revision과 일치하는지 실DB 테스트로 확인했다.

## 변경 파일

- Shared: `packages/shared/src/schemas.ts`, `schemas.test.ts`, `cad-import-contracts.test.ts`
- API: `apps/api/src/floor-map/floor-map.service.ts`와 spec, `apps/api/src/floor-editor/floor-editor-snapshot.ts`, `floor-editor.service.ts`, integration spec
- Web: `apps/web/src/features/floor-map/FloorScene.tsx`와 test, `apps/web/src/features/floor-editor/editor-monitoring-cache.ts`, `FloorEditorView.test.tsx`
- 문서: `docs/menus/monitoring.md`, `docs/menus/settings.md`의 Task 8 CAD hunk만 포함
- 커밋: 이 보고서와 동일 작업 단위의 Task 8 커밋이며 정확한 SHA는 최종 결과에 기록한다.

## 남은 우려

- source 참조가 없던 구형 V2 snapshot은 같은 ID의 현재 slot에서 source를 확인할 수 있을 때만 복원한다. 현재 slot도 사라졌다면 잘못 추정하지 않고 transaction 전체를 rollback한다.
- `fixtures`는 이전 Web cache와의 호환을 위해 Shared 읽기 schema에서 optional이지만, 현재 API 응답은 항상 배열을 반환한다.
- 자동 테스트는 CAD SVG URL, 도형과 좌표 계약을 검증했다. 실제 현장 CAD의 육안 정합성과 Raspberry Pi/ESP32-H2 HIL은 Task 8 범위에 포함하지 않았다.
