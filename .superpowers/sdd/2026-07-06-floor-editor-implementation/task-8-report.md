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

- 모니터링 DTO는 내부 `FloorLightSlot` 목록을 노출하지 않는다. CAD plan, 보이는 map object와 `placed`인 모든 fixture layout을 반환한다.
- `FloorScene`은 snapshot fixture layout을 runtime 상태와 ID로 O(n) 결합한다. slot 배정 좌표를 우선하고 snapshot에 없는 자유 배치 fixture는 자체 좌표로 보완하며, runtime 상태가 아직 없으면 offline fallback으로 표시한다. 저장 직후 React Query cache도 같은 계약으로 갱신한다.
- 신규 V2 revision snapshot은 slot의 source import job/candidate 참조를 함께 저장한다. 복구는 source 소속을 검증하고 현재 slot 전체를 snapshot 목록으로 교체한 뒤 assignment와 fixture placement/좌표 invariant를 확인한다.
- plan, object, fixture, slot 교체와 신규 revision/audit 생성은 기존 Serializable transaction 안에서 수행된다. 복구 후 생성된 snapshot과 SHA-256이 원본 revision과 일치하는지 실DB 테스트로 확인했다.

## 변경 파일

- Shared: `packages/shared/src/schemas.ts`, `schemas.test.ts`, `cad-import-contracts.test.ts`
- API: `apps/api/src/floor-map/floor-map.service.ts`와 spec, `apps/api/src/floor-editor/floor-editor-snapshot.ts`, `floor-editor.service.ts`, integration spec
- Web: `apps/web/src/features/floor-map/FloorScene.tsx`와 test, `apps/web/src/features/floor-editor/editor-monitoring-cache.ts`, `FloorEditorView.test.tsx`
- 문서: `docs/menus/monitoring.md`, `docs/menus/settings.md`의 Task 8 CAD hunk만 포함
- 커밋: 이 보고서와 동일 작업 단위의 Task 8 커밋이며 정확한 SHA는 최종 결과에 기록한다.

## 남은 우려

- source 참조가 없던 구형 V2 snapshot은 보존된 CAD asset/job/candidate에서 exact source를 복구한다. 결정적 매핑 정보가 부족하면 잘못 추정하지 않고 transaction 전체를 rollback한다.
- `fixtures`는 이전 Web cache와의 호환을 위해 Shared 읽기 schema에서 optional이지만, 현재 API 응답은 항상 배열을 반환한다.
- 자동 테스트는 CAD SVG URL, 도형과 좌표 계약을 검증했다. 실제 현장 CAD의 육안 정합성과 Raspberry Pi/ESP32-H2 HIL은 Task 8 범위에 포함하지 않았다.

## 수정 라운드 1

### 상태

`DONE_WITH_CONCERNS`

- 모니터링 projection은 `placed`인 모든 fixture를 포함한다. slot 배정 fixture는 slot x/y와 fixture size를 사용하고, 자유 배치·legacy/non-CAD fixture는 fixture 자체 x/y/size를 사용한다. API, 저장 직후 cache와 `FloorScene`의 merge/fallback이 같은 규칙을 사용하며 `unplaced`만 숨긴다.
- source-less 기존 V2 snapshot은 현재 slot ID를 조회하지 않는다. snapshot의 원본 CAD asset 경로로 과거 import job을 한정하고 accepted candidate의 x/y/rotation exact match가 유일할 때 source job/candidate를 복구한다. missing, duplicate geometry와 이미 사용된 candidate는 전체 transaction을 rollback한다.

### RED / GREEN

- RED: API read model은 `floor.lightSlots`만 읽어 자유 배치 fixture를 반환하지 못했고, `FloorScene`과 editor monitoring cache도 snapshot에 없는 placed fixture를 제거했다. API 2건, Web 2건 실패로 확인했다.
- RED: 실제 PostgreSQL에서 현재 slot 교체 후 source-less V2 exact 복구가 `historical light slot source is unavailable`로 실패했다. ambiguous/missing도 구분하지 못했다.
- GREEN: Shared focused 33/33, API floor-map과 전체 editor 실DB 통합 27/27, Web `FloorScene`/`FloorEditorView` 81/81 통과.
- GREEN: `FLOOR_EDITOR_TEST_DATABASE_URL=postgresql://led:led@127.0.0.1:5432/led_control_floor_task8_fix1?schema=public`에서 source-less exact 복구, ambiguous rollback, missing rollback을 포함한 전체 integration을 통과했다. exact 복구의 신규 enriched snapshot SHA-256이 canonical snapshot hash와 일치함을 검증했다.
- GREEN: Shared build, Prisma validate, API/Web typecheck와 `git diff --check` 통과. Prisma validate는 같은 전용 실DB URL을 `DATABASE_URL`로 명시했다.

### 남은 우려

- source-less V2 복구에는 revision snapshot이 보존한 canonical floor asset 경로와 해당 import job/candidate가 필요하다. 원본 후보가 삭제됐거나 동일 import에 완전히 같은 x/y/rotation의 accepted 후보가 둘 이상이면 안전하게 복원할 정보가 부족하므로 의도적으로 실패한다.
- 실제 CAD 육안 정합성과 Raspberry Pi/ESP32-H2 HIL은 이 수정 라운드에서도 수행하지 않았다.
