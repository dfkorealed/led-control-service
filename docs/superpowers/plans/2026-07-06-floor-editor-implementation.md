# 층별 도면 에디터 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**목표:** DWG/DXF를 최적화된 층별 맵으로 가져오고, 기존 맵을 안전하게 초기화한 뒤 최대 2,000개 CAD 조명 슬롯에 1,000개 실제 조명을 배치한다.

**구조:** CAD는 단일 gzip SVG 배경으로 유지하고 승인된 조명 후보만 `FloorLightSlot` 정규 상태로 분리한다. CAD 적용은 editor lease/revision으로 보호된 단일 DB transaction에서 기존 수동 객체 삭제, fixture 미배치 전환, 슬롯 교체와 revision 기록을 수행한다. Web은 레이어 분리, viewport culling, LOD와 목록 가상화로 렌더 비용을 제한한다.

**기술:** React, TypeScript, React Query, Zustand, Konva, NestJS, Prisma, PostgreSQL, MQTT, BlueZ, ESP-IDF, Jest, Vitest, Playwright.

**설계:** [층별 도면 에디터 설계](../specs/2026-07-06-floor-editor-design.md)의 `2026-09-18 CAD 맵 교체와 조명 배치 슬롯 설계`.

## 2026-09-18 CAD 맵 교체·슬롯 배치 활성 계획

상태: 구현 진행 중. Task 1 슬롯 DB 모델과 공유 계약까지 완료했다. 이 절이 현재 활성 체크리스트이며 아래 `2026-09-09 대량 배치 실행 계획`은 완료된 과거 이력이다.

### 전역 제약

- 신규 맵 파일은 DWG/DXF만 허용하고 PNG/JPG/PDF 신규 업로드를 거부한다. 기존 이미지/PDF 자산의 인증 조회와 revision 복구 호환은 유지한다.
- CAD apply는 `confirmMapReset: true`, editor lease token/fence와 expected revision이 모두 유효해야 한다.
- apply transaction은 기존 `FloorMapObject` 전체 삭제, 모든 fixture의 unplaced/x=0/y=0/미확인 전환, 기존 slot 삭제, 새 plan/slot 저장, revision/audit/job 완료를 원자적으로 처리한다.
- 실제 fixture 등록, Mesh 주소, 그룹, 제어·자동화·전력 이력은 CAD apply로 삭제하거나 변경하지 않는다.
- 상한은 한 층 fixture 1,000개, CAD 후보/slot 2,000개, map object 2,000개다.
- 렌더 성능 기준은 Chromium 1440x900 warm 편집 준비 p95 3초 이하, pan/zoom frame p95 33ms 이하, drag commit p95 100ms 이하, 저장 p95 3초 이하다.
- 각 Task는 회귀 테스트 실패 확인, 최소 구현, 범위 테스트, `docs/menus/settings.md` 및 필요한 스키마 문서 갱신, 독립 커밋 순서로 끝낸다.
- 기존 사용자 변경과 BIO 관련 미커밋 파일은 수정·stage·revert하지 않는다.
- `docs/menus/settings.md`와 `docs/menus/monitoring.md`에는 기존 BIO 변경이 있으므로 커밋 때 파일 전체를 `git add`하지 않는다. CAD 작업에서 추가한 hunk만 diff로 확인해 선택적으로 stage한다.

### Task 1: 슬롯 DB 모델과 공유 계약

**파일:**
- 수정: `apps/api/prisma/schema.prisma`
- 생성: `apps/api/prisma/migrations/20260918090000_floor_light_slots_map_reset/migration.sql`
- 수정: `packages/shared/src/schemas.ts`
- 수정: `packages/shared/src/cad-import-contracts.ts`
- 수정: `packages/shared/src/cad-import-contracts.test.ts`
- 수정: `docs/database-schema.md`

**인터페이스:**
- 생성: `FloorLightSlot` Prisma 모델과 `floorLightSlotSchema`.
- 변경: `floorImportApplyInputSchema`에 `confirmMapReset: z.literal(true)`.
- 변경: editor snapshot에 `lightSlots: FloorLightSlotDto[]`.

- [x] **Step 1: 실패하는 공유 계약 테스트 작성**

```ts
expect(() => floorImportApplyInputSchema.parse({
  expectedRevision: 4,
  leaseToken: "lease",
  leaseFence: 2,
  candidateIds: [candidateId]
})).toThrow();

expect(floorLightSlotSchema.parse({
  id: slotId,
  x: 120,
  y: 240,
  rotation: 0,
  assignedFixtureId: null
})).toMatchObject({ assignedFixtureId: null });
```

- [x] **Step 2: 공유 테스트가 실패하는지 확인**

Run: `pnpm --filter @led-control/shared test -- cad-import-contracts.test.ts schemas.test.ts`

Expected: `confirmMapReset`와 `floorLightSlotSchema`가 없어 실패.

- [x] **Step 3: Prisma 모델·제약·공유 타입 구현**

```prisma
model FloorLightSlot {
  id                String  @id @default(uuid())
  floorId           String
  sourceImportJobId String
  sourceCandidateId String  @unique
  assignedFixtureId String? @unique
  x                 Float
  y                 Float
  rotation          Float   @default(0)
  floor             Floor   @relation(fields: [floorId], references: [id], onDelete: Cascade)
  sourceImportJob   FloorImportJob @relation(fields: [sourceImportJobId], references: [id], onDelete: Cascade)
  sourceCandidate   FloorImportCandidate @relation(fields: [sourceCandidateId], references: [id], onDelete: Cascade)
  assignedFixture   Fixture? @relation(fields: [assignedFixtureId], references: [id], onDelete: SetNull)
  createdAt         DateTime @default(now())
  updatedAt         DateTime @updatedAt
  @@index([floorId, id])
}
```

`Floor`, `FloorImportJob`, `FloorImportCandidate`, `Fixture`에는 각각 반대 relation field를 추가한다. Migration SQL에는 finite x/y/rotation, candidate/job/floor 일치, assigned fixture/floor 일치 검증 trigger를 포함한다.

- [x] **Step 4: schema generate와 계약 테스트 실행**

Run: `pnpm --filter @led-control/api prisma:generate && pnpm --filter @led-control/shared test -- cad-import-contracts.test.ts schemas.test.ts && pnpm --filter @led-control/shared typecheck`

Expected: 모두 통과.

- [x] **Step 5: DB 문서 갱신 후 커밋**

```bash
git add apps/api/prisma/schema.prisma apps/api/prisma/migrations/20260918090000_floor_light_slots_map_reset packages/shared/src/schemas.ts packages/shared/src/cad-import-contracts.ts packages/shared/src/cad-import-contracts.test.ts docs/database-schema.md
git commit -m "feat(editor): add persistent cad light slots"
```

### Task 2: 이미지 신규 업로드 제거와 CAD 자산 경계

**파일:**
- 수정: `apps/api/src/floor-editor/floor-assets.service.ts`
- 수정: `apps/api/src/floor-editor/floor-assets.service.spec.ts`
- 수정: `apps/api/src/floor-editor/floor-assets.integration.spec.ts`
- 수정: `apps/web/src/features/floor-editor/FloorEditorView.tsx`
- 삭제: `apps/web/src/features/floor-editor/FloorAssetUploadPanel.tsx`
- 삭제: `apps/web/src/features/floor-editor/FloorAssetUploadPanel.test.tsx`
- 수정: `apps/web/src/features/floor-editor/FloorEditorView.test.tsx`

**인터페이스:**
- `createUploadIntent`는 `kind=original`일 때 공유 `cadImportMimeTypeSchema`만 허용한다.
- 기존 ready image/pdf/rendered SVG content 조회는 변경하지 않는다.

- [ ] **Step 1: PNG/JPG 업로드 거부 API 테스트와 UI 부재 테스트 작성**

```ts
await expect(service.createUploadIntent(user, floorId, {
  kind: "original",
  mimeType: "image/png",
  sizeBytes: 1024,
  sha256: "a".repeat(64)
})).rejects.toThrow("unsupported floor asset MIME type");
```

```tsx
expect(screen.queryByRole("region", { name: "도면 자산" })).not.toBeInTheDocument();
expect(screen.getByRole("region", { name: "CAD 가져오기" })).toBeInTheDocument();
```

- [ ] **Step 2: API/Web 대상 테스트 실패 확인**

Run: `pnpm --filter @led-control/api test -- floor-assets.service.spec.ts --runInBand && pnpm --filter @led-control/web test -- FloorEditorView.test.tsx`

Expected: PNG upload가 허용되고 이미지 panel이 남아 실패.

- [ ] **Step 3: 업로드 allowlist와 이미지 panel 제거 구현**

`FloorEditorView`의 `FloorAssetUploadPanel` import, upload busy state와 callback을 제거한다. `FloorAssetsService`는 CAD source MIME만 client upload intent로 허용하고 internal rendered SVG 저장 경로는 기존 worker 전용 API로 유지한다.

- [ ] **Step 4: 조회 호환과 신규 거부 테스트 실행**

Run: `pnpm --filter @led-control/api test -- floor-assets.service.spec.ts floor-assets.integration.spec.ts --runInBand && pnpm --filter @led-control/web test -- FloorEditorView.test.tsx`

Expected: 신규 이미지 거부, 기존 이미지 조회 테스트 통과.

- [ ] **Step 5: 설정 문서 갱신 후 커밋**

```bash
git add apps/api/src/floor-editor apps/web/src/features/floor-editor
# docs/menus/settings.md는 이번 Task의 CAD hunk만 선택적으로 stage한다.
git commit -m "refactor(editor): remove image floor uploads"
```

### Task 3: CAD 진행률과 완료 상태 복구

**파일:**
- 수정: `apps/api/src/floor-import/floor-import-worker.service.ts`
- 수정: `apps/api/src/floor-import/floor-import-worker.service.spec.ts`
- 수정: `packages/shared/src/cad-import-contracts.ts`
- 수정: `apps/web/src/features/floor-editor/CadImportPanel.tsx`
- 수정: `apps/web/src/features/floor-editor/CadImportPanel.test.tsx`

**인터페이스:**
- 생성: `cadImportStageSchema`와 `cadImportStageLabel(stage)`.
- Web polling은 terminal 상태 전까지 1초 간격이며 `updatedAt`을 effect dependency로 사용하지 않는다.

- [ ] **Step 1: 진행률 단조 증가와 100% 완료 표시 회귀 작성**

```ts
expect(progressUpdates.map(({ progressPercent }) => progressPercent)).toEqual([15, 35, 70, 90, 100]);
```

```tsx
expect(screen.getByRole("progressbar", { name: "CAD 가져오기 진행률" })).toHaveValue(100);
expect(screen.getByText("분석 완료 · 조명 위치 후보를 불러오는 중")).toBeInTheDocument();
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `pnpm --filter @led-control/api test -- floor-import-worker.service.spec.ts --runInBand && pnpm --filter @led-control/web test -- CadImportPanel.test.tsx`

Expected: review 상태에서 progress UI가 사라져 실패.

- [ ] **Step 3: 고정 polling loop와 완료 전환 구현**

`CadImportPanel`은 `jobId/status/error`만으로 timer를 관리하고, candidate fetch 동안 `reviewLoadingJobId`를 유지한다. 실패한 polling은 기존 job/progress를 보존한 채 `다시 확인`으로 재개한다.

- [ ] **Step 4: polling cleanup·새로고침 복구 테스트 실행**

Run: `pnpm --filter @led-control/web test -- CadImportPanel.test.tsx && pnpm --filter @led-control/api test -- floor-import-worker.service.spec.ts --runInBand`

Expected: queued → processing → 100% loading → review 전환과 unmount cleanup 통과.

- [ ] **Step 5: 문서 갱신과 커밋**

```bash
git add packages/shared/src/cad-import-contracts.ts apps/api/src/floor-import/floor-import-worker.service* apps/web/src/features/floor-editor/CadImportPanel*
# docs/menus/settings.md는 이번 Task의 CAD hunk만 선택적으로 stage한다.
git commit -m "fix(cad): keep import progress visible through review"
```

### Task 4: 주 도면 영역과 CAD 엔티티 보강

**파일:**
- 수정: `apps/api/src/floor-import/cad-types.ts`
- 수정: `apps/api/src/floor-import/dxf-document-parser.ts`
- 수정: `apps/api/src/floor-import/dxf-document-parser.spec.ts`
- 수정: `apps/api/src/floor-import/cad-geometry.ts`
- 수정: `apps/api/src/floor-import/cad-svg-renderer.ts`
- 수정: `apps/api/src/floor-import/cad-svg-renderer.spec.ts`
- 수정: `apps/api/src/floor-import/cad-viewport.ts`
- 수정: `apps/api/src/floor-import/cad-viewport.spec.ts`
- 수정: `apps/api/src/floor-import/cad-runtime-contract.ts`

**인터페이스:**
- 생성: `selectPrimaryCadBounds(document): { bounds; excludedEntityCount; totalEntityCount }`.
- `NormalizedCadEntity`에 `spline | wipeout | hatch | dimension | point`을 추가한다.
- 렌더 결과 metadata에 `unsupportedEntityCounts`와 `excludedEntityCount`를 포함한다.

- [ ] **Step 1: 고립 outlier와 신규 엔티티 fixture 테스트 작성**

```ts
expect(selectPrimaryCadBounds(documentWithRemoteOutlier)).toMatchObject({
  bounds: { minX: 0, minY: 0, maxX: 1200, maxY: 800 },
  excludedEntityCount: 1
});
```

DXF fixture는 SPLINE control point/knot, WIPEOUT polygon, HATCH boundary, DIMENSION block reference, POINT를 각각 최소 한 개 포함한다.

- [ ] **Step 2: parser/viewport/renderer 테스트 실패 확인**

Run: `pnpm --filter @led-control/api test -- dxf-document-parser.spec.ts cad-viewport.spec.ts cad-svg-renderer.spec.ts --runInBand`

Expected: 신규 entity가 누락되고 remote outlier가 viewport에 포함되어 실패.

- [ ] **Step 3: deterministic primary bounds와 엔티티 렌더 구현**

주 도면 선택은 spatial bucket의 drawable 길이/면적/개수 점수로 가장 큰 연결 cluster를 택하고, 후보 좌표와 같은 transform을 사용한다. SPLINE은 bounded De Boor sampling, WIPEOUT/HATCH는 polygon path, DIMENSION은 anonymous block 우선, POINT는 fixed marker path로 렌더한다. 입력별 entity/coordinate/sample 상한을 기존 runtime contract에 추가한다.

- [ ] **Step 4: 실제 샘플 분석과 renderer 회귀 실행**

Run: `node scripts/analyze-cad-import.mjs --input "/Users/kim-jh/Downloads/2단지지하주차장전등설비합본평면도20260803.dwg" --converter /opt/homebrew/bin/dwgread`

Expected: 후보 1,302개 유지, supported geometry 통계 상승, 주요 도면 viewport가 한 화면에서 식별 가능.

- [ ] **Step 5: API 테스트와 커밋**

```bash
pnpm --filter @led-control/api test -- dxf-document-parser.spec.ts cad-viewport.spec.ts cad-svg-renderer.spec.ts cad-runtime-contract.spec.ts --runInBand
git add apps/api/src/floor-import
# docs/menus/settings.md는 이번 Task의 CAD hunk만 선택적으로 stage한다.
git commit -m "feat(cad): render primary drawing geometry"
```

### Task 5: 원자적 맵 초기화와 슬롯 생성

**파일:**
- 수정: `apps/api/src/floor-import/floor-import.service.ts`
- 수정: `apps/api/src/floor-import/floor-import.service.spec.ts`
- 수정: `apps/api/src/floor-import/floor-import.integration.spec.ts`
- 수정: `apps/api/src/floor-editor/floor-editor-snapshot.ts`
- 수정: `apps/api/src/floor-editor/floor-editor.service.ts`
- 수정: `apps/api/src/floor-editor/floor-editor.integration.spec.ts`

**인터페이스:**
- `applyJob(...): FloorImportApplyResult`에 `deletedObjectCount`, `unplacedFixtureCount`, `createdSlotCount`.
- editor state/snapshot은 `lightSlots`를 포함한다.

- [ ] **Step 1: 전체 초기화와 강제 rollback 통합 테스트 작성**

```ts
expect(result).toMatchObject({
  deletedObjectCount: 2,
  unplacedFixtureCount: 4,
  createdSlotCount: 2
});
expect(await prisma.fixture.findMany({ where: { floorId } })).toEqual(
  expect.arrayContaining([expect.objectContaining({ placementStatus: "unplaced", x: 0, y: 0 })])
);
```

slot create trigger를 강제 실패시킨 뒤 plan, objects, fixtures, slots, revision, job status가 모두 적용 전 상태인지 검사한다.

- [ ] **Step 2: 서비스/통합 테스트 실패 확인**

Run: `pnpm --filter @led-control/api test -- floor-import.service.spec.ts floor-import.integration.spec.ts --runInBand`

Expected: 기존 구현이 objects/fixtures를 유지하고 slot을 만들지 않아 실패.

- [ ] **Step 3: 단일 transaction apply 구현**

`confirmMapReset`을 authority/asset 검증 뒤 확인하고 `deleteMany(mapObjects)`, fixture bulk reset, old slot delete, accepted candidate 기반 `createMany(slots)`, plan/revision/audit/job 완료를 같은 transaction에 둔다. change summary에 네 개 count를 기록한다.

- [ ] **Step 4: apply, snapshot, rollback 검증**

Run: `pnpm --filter @led-control/api test -- floor-import.service.spec.ts floor-import.integration.spec.ts floor-editor.integration.spec.ts --runInBand`

Expected: 정상 적용과 모든 강제 실패 rollback 통과.

- [ ] **Step 5: DB/설정 문서 갱신과 커밋**

```bash
git add apps/api/src/floor-import apps/api/src/floor-editor docs/database-schema.md
# docs/menus/settings.md는 이번 Task의 CAD hunk만 선택적으로 stage한다.
git commit -m "feat(cad): replace maps atomically on import"
```

### Task 6: 적용 경고 dialog와 슬롯 배치 UX

**파일:**
- 수정: `apps/web/src/features/floor-editor/editor-types.ts`
- 수정: `apps/web/src/features/floor-editor/editor-store.ts`
- 수정: `apps/web/src/features/floor-editor/editor-store.test.ts`
- 생성: `apps/web/src/features/floor-editor/CadPlacementSlotLayer.tsx`
- 생성: `apps/web/src/features/floor-editor/CadPlacementSlotLayer.test.tsx`
- 수정: `apps/web/src/features/floor-editor/FloorEditorCanvas.tsx`
- 수정: `apps/web/src/features/floor-editor/FixturePlacementList.tsx`
- 수정: `apps/web/src/features/floor-editor/CadImportPanel.tsx`
- 수정: `apps/web/src/features/floor-editor/FloorEditorView.tsx`
- 수정: `apps/web/src/features/floor-editor/FloorEditorView.test.tsx`

**인터페이스:**
- 생성: `assignFixtureToSlot(fixtureId, slotId)`와 `unassignFixture(fixtureId)` store command.
- `CadImportPanel`은 apply 전 reset summary dialog를 열고 확인 시에만 `confirmMapReset: true`를 전송한다.

- [ ] **Step 1: dialog 취소/확인과 slot assignment 실패 테스트 작성**

```tsx
fireEvent.click(screen.getByRole("button", { name: "선택한 후보와 배경 적용" }));
expect(screen.getByRole("dialog", { name: "새 CAD 도면으로 맵을 교체할까요?" })).toHaveTextContent("조명 4개가 미배치 상태로 변경");
fireEvent.click(screen.getByRole("button", { name: "취소" }));
expect(floorEditorApi.applyFloorImportJob).not.toHaveBeenCalled();
```

```ts
store.assignFixtureToSlot(fixtureId, slotId);
expect(store.state.fixtures[0]).toMatchObject({ placementStatus: "placed", x: slot.x, y: slot.y });
expect(store.state.lightSlots[0].assignedFixtureId).toBe(fixtureId);
```

- [ ] **Step 2: Web 테스트 실패 확인**

Run: `pnpm --filter @led-control/web test -- editor-store.test.ts CadImportPanel.test.tsx FloorEditorView.test.tsx`

Expected: reset dialog와 slot store command가 없어 실패.

- [ ] **Step 3: slot layer, drag highlight, exact snap과 unassign 구현**

미할당 slot만 hollow marker로 표시하고 drag pointer가 slot hit radius 안에 들어오면 강조한다. drop은 slot 좌표/rotation을 정확히 사용한다. 이미 할당된 slot이나 다른 fixture가 사용 중인 slot은 거부한다. slot 밖 drop은 기존 자유 배치를 유지한다.

- [ ] **Step 4: 단위·컴포넌트 테스트 실행**

Run: `pnpm --filter @led-control/web test -- editor-store.test.ts CadPlacementSlotLayer.test.tsx CadImportPanel.test.tsx FloorEditorView.test.tsx`

Expected: dialog focus/Escape/취소/확인, slot 중복 차단, 배치 해제 재개방 통과.

- [ ] **Step 5: 설정 문서 갱신과 커밋**

```bash
git add apps/web/src/features/floor-editor apps/web/src/api/floor-editor.ts
# docs/menus/settings.md는 이번 Task의 CAD hunk만 선택적으로 stage한다.
git commit -m "feat(editor): place fixtures onto cad slots"
```

### Task 7: 렌더링 최적화와 배경 오류 상태

**파일:**
- 생성: `apps/web/src/features/floor-editor/editor-spatial-index.ts`
- 생성: `apps/web/src/features/floor-editor/editor-spatial-index.test.ts`
- 생성: `apps/web/src/features/floor-editor/use-floor-plan-image.ts`
- 생성: `apps/web/src/features/floor-editor/use-floor-plan-image.test.tsx`
- 수정: `apps/web/src/features/floor-editor/FloorEditorCanvas.tsx`
- 수정: `apps/web/src/features/floor-editor/EditorFixtureNode.tsx`
- 수정: `apps/web/src/features/floor-editor/CadPlacementSlotLayer.tsx`
- 수정: `apps/web/src/features/floor-editor/FixturePlacementList.tsx`
- 수정: `apps/web/src/features/floor-editor/FloorEditorView.tsx`
- 수정: `apps/web/e2e/floor-placement.spec.ts`

**인터페이스:**
- 생성: `buildEditorSpatialIndex(items, cellSize)`와 `queryEditorSpatialIndex(index, bounds, margin)`.
- 생성: `useFloorPlanImage(url): { image; status: "idle" | "loading" | "ready" | "error"; retry }`.

- [ ] **Step 1: culling, image reuse와 decode error 회귀 작성**

```ts
const visible = queryEditorSpatialIndex(index, { x: 0, y: 0, width: 500, height: 300 }, 80);
expect(visible.map(item => item.id)).toEqual(["inside", "margin"]);
```

```tsx
rerender(<Harness url="/same.svg" selection="fixture-2" />);
expect(imageConstructor).toHaveBeenCalledTimes(1);
fireEvent.error(createdImage);
expect(screen.getByText("CAD 도면을 표시하지 못했습니다.")).toBeInTheDocument();
```

- [ ] **Step 2: 최적화 회귀 실패 확인**

Run: `pnpm --filter @led-control/web test -- editor-spatial-index.test.ts use-floor-plan-image.test.tsx FloorEditorView.test.tsx`

Expected: spatial index/hook이 없어 실패.

- [ ] **Step 3: layer 분리, viewport culling, LOD와 rAF commit 구현**

CAD background/grid는 non-listening static layer로 유지한다. fixture/slot은 spatial query 결과만 렌더하고 zoom 임계값 아래에서 label/stroke detail을 숨긴다. pointer move는 requestAnimationFrame으로 합치고 drag end에만 Zustand draft를 갱신한다. fixture 목록은 기존 window 계산을 1,000개 기준으로 고정한다.

- [ ] **Step 4: 1,000 fixture/2,000 slot 브라우저 성능 테스트 실행**

Run: `pnpm --filter @led-control/web exec playwright test e2e/floor-placement.spec.ts --project=chromium --workers=1`

Expected: warm 준비 p95 ≤ 3,000ms, frame p95 ≤ 33ms, drag commit p95 ≤ 100ms이고 background image 생성 횟수가 URL당 1회.

- [ ] **Step 5: 설정 문서에 측정 환경과 결과 기록 후 커밋**

```bash
git add apps/web/src/features/floor-editor apps/web/e2e/floor-placement.spec.ts
# docs/menus/settings.md는 이번 Task의 CAD hunk만 선택적으로 stage한다.
git commit -m "perf(editor): cull cad slots and reuse map images"
```

### Task 8: 모니터링 조회와 revision 복구 연동

**파일:**
- 수정: `apps/api/src/floor-map/floor-map.service.ts`
- 수정: `apps/api/src/floor-map/floor-map.service.spec.ts`
- 수정: `apps/web/src/features/floor-map/FloorScene.tsx`
- 수정: `apps/web/src/features/floor-map/FloorScene.test.tsx`
- 수정: `apps/api/src/floor-editor/floor-editor.service.ts`
- 수정: `apps/api/src/floor-editor/floor-editor.integration.spec.ts`
- 수정: `docs/menus/monitoring.md`
- 수정: `docs/menus/settings.md`

**인터페이스:**
- 모니터링 DTO는 slot을 노출하지 않고 배치된 fixture와 CAD plan만 반환한다.
- revision restore는 plan, objects, fixture placement와 slot assignment를 함께 복구한다.

- [ ] **Step 1: 모니터링 slot 비노출과 revision 왕복 테스트 작성**

```ts
expect(monitoringMap).not.toHaveProperty("lightSlots");
expect(monitoringMap.fixtures).toEqual([expect.objectContaining({ id: assignedFixtureId })]);
```

restore 전후 `FloorLightSlot.assignedFixtureId`와 fixture placement/좌표가 snapshot과 일치하는지 실DB로 검사한다.

- [ ] **Step 2: API/Web 테스트 실패 확인**

Run: `pnpm --filter @led-control/api test -- floor-map.service.spec.ts floor-editor.integration.spec.ts --runInBand && pnpm --filter @led-control/web test -- FloorScene.test.tsx`

Expected: slot snapshot/복구가 없어 실패.

- [ ] **Step 3: 읽기 전용 map과 restore 구현**

모니터링은 CAD SVG를 단일 background로 그리고 assigned fixture만 기존 marker로 표시한다. restore transaction은 현재 slot을 snapshot slot로 교체하고 assignment와 fixture 상태를 함께 복원한다.

- [ ] **Step 4: 회귀 실행과 문서 갱신**

Run: `pnpm --filter @led-control/api test -- floor-map.service.spec.ts floor-editor.integration.spec.ts --runInBand && pnpm --filter @led-control/web test -- FloorScene.test.tsx`

Expected: 적용·새로고침·revision 복구 후 모니터링 배경/조명 일치.

- [ ] **Step 5: 커밋**

```bash
git add apps/api/src/floor-map apps/api/src/floor-editor apps/web/src/features/floor-map
# 두 메뉴 문서는 이번 Task의 CAD hunk만 선택적으로 stage한다.
git commit -m "feat(monitoring): restore cad maps with fixture assignments"
```

### Task 9: 실제 샘플과 전체 사용자 여정 검증

**파일:**
- 수정: `apps/api/src/floor-import/cad-sample-pipeline.integration.spec.ts`
- 수정: `apps/web/e2e/floor-placement-real.spec.ts`
- 수정: `apps/web/e2e/floor-placement.spec.ts`
- 수정: `scripts/analyze-cad-import.mjs`
- 수정: `scripts/analyze-cad-import.test.mjs`
- 수정: `docs/menus/settings.md`
- 수정: `docs/menus/monitoring.md`

**인터페이스:**
- 샘플 분석 결과는 viewport/excluded/unsupported counts와 후보 transform 일치율을 출력한다.

- [ ] **Step 1: 샘플 기대값과 브라우저 여정 테스트 작성**

브라우저 시나리오는 기존 맵/도형/배치 조명 준비 → DWG 업로드 → 진행률 변화 → 100% → reset dialog 취소 → 재확인 → apply → 새로고침 → 모두 미배치/slot 표시 → 두 fixture slot 배치 → 저장 → 모니터링 반영 순서다.

- [ ] **Step 2: 실제 sample pipeline 실행**

Run: `CAD_SAMPLE_DWG_PATH="/Users/kim-jh/Downloads/2단지지하주차장전등설비합본평면도20260803.dwg" CAD_SAMPLE_CONVERTER_PATH=/opt/homebrew/bin/dwgread pnpm --filter @led-control/api test -- cad-sample-pipeline.integration.spec.ts --runInBand`

Expected: job 100%, SVG decode 성공, 후보 1,302개, 주요 도면 bbox가 viewport 안에서 식별 가능.

- [ ] **Step 3: Web 단위·브라우저·실백엔드 여정 실행**

Run: `pnpm --filter @led-control/web test && pnpm --filter @led-control/web exec playwright test e2e/floor-placement.spec.ts --project=chromium --workers=1`

실백엔드 lab가 준비된 경우: `E2E_REAL_BACKEND_LAB=1 pnpm --filter @led-control/web exec playwright test e2e/floor-placement-real.spec.ts --project=chromium --workers=1`.

- [ ] **Step 4: 전체 타입·빌드·diff 검증**

Run: `pnpm --filter @led-control/shared typecheck && pnpm --filter @led-control/api typecheck && pnpm --filter @led-control/web typecheck && pnpm --filter @led-control/api build && pnpm --filter @led-control/web build && git diff --check`

Expected: 모두 exit 0.

- [ ] **Step 5: 최종 현황 문서와 계획 체크리스트 갱신 후 커밋**

```bash
git add apps/api/src/floor-import apps/web/e2e scripts/analyze-cad-import.mjs scripts/analyze-cad-import.test.mjs docs/superpowers/plans/2026-07-06-floor-editor-implementation.md
# 두 메뉴 문서는 이번 Task의 CAD hunk만 선택적으로 stage한다.
git commit -m "test(cad): verify map replacement user journey"
```

### 실행 순서

Task 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9 순서다. Task 4의 parser/renderer와 Task 3의 진행률 Web 작업은 Task 1 이후 병렬 검토할 수 있지만 동일 CAD job 계약 변경은 Task 3을 먼저 통합한다. 각 Task 완료 직후 해당 범위 테스트와 커밋을 끝내고 다음 Task로 넘어간다.

## 2026-09-09 대량 배치 실행 계획

상태: 2026-09-10 Task 1~10 및 Task 11 소프트웨어 검증 완료. 실제 장비 배포/검증만 사용자 요청으로 보류했다. 이 절은 완료된 과거 체크리스트이며 하단 작업/진행 로그도 기존 구현 이력이다. 사용자 DB에는 migration을 적용하지 않았으며 격리 DB와 브라우저로 검증했다.

진행 기록:
- backend: Task 1/10 및 Task 2 서버 배치 분리 완료. Shared 172, API 800, 격리 DB/HTTP 18 테스트와 typecheck/build 및 독립 코드 검토를 통과했다. 등록 웹의 좌표 입력 제거와 전체 브라우저 연동도 완료했다.
- web_frontend: Task 3~7 및 9의 층별 UI·목록 드롭·확인 후 배치 해제·대량 편집 완료. 웹 단위 497개, 편집기 Chromium 기존 29개와 추가 성능 1개(동일 파일 최종 6개 재실행), 실제 설치 여정 2개와 두 층 배치 여정 1개를 통과했다.
- gateway/backend: Task 8 등록 후 Health Attention 명령·결과·인증/lease·만료/중복 차단 완료. Gateway 613, API 801, Shared 172, 식별 API/실DB·Redis 17, Docker/ACL 24 및 production build 통과. firmware 출력 우선순위 단위도 완료. 웹의 시작/중지/다음/건너뛰기/재시도와 명시적 위치 확인도 구현·검증했다. 실물 점멸 검증은 제외한다.
- 총괄: 공유 계약/소유 범위 조율, 독립 검토와 통합 재검증·문서 갱신 완료. 실제 장비 동작 검증·배포는 실행하지 않는다.

### 공통 규칙

- `AGENTS.md`, `docs/agent-operations.md`, `docs/lesson_leared.md`와 해당 경로 지침을 읽고 시작한다. 담당 역할별로 검증 가능한 작은 변경을 진행하고 공유 계약은 총괄 검토 후 한 역할이 먼저 적용한다.
- 각 Task는 회귀 작성·구현·검증·메뉴 문서/상태판 갱신·범위별 커밋 순서로 완료한다. 구현 완료와 실장비 검증 완료를 분리한다.
- 위치 데이터와 장비 식별 명령을 분리한다. 배치 해제에 장비 삭제/초기화/그룹 변경/제어 명령을 연결하지 않는다.
- 입력 상한은 fixture 변경 1,000개, 기존 object mutation 합계 2,000개를 유지한다. 에디터 요청 body는 1 MiB로 명시하고 초과 요청은 일관된 413으로 표시한다. 기존 과대 데이터가 있을 때 마이그레이션으로 잘라내지 않는다.
- UI는 한글과 기존 공통 컴포넌트를 사용한다. 도면 업로드/교체와 CAD/AI 확장은 실행하지 않는다. 기존 자산과 기존 좌표는 유지한다.

### Task 1: 배치 상태와 저장 버전 계약 / backend

대상: `apps/api/prisma/schema.prisma`, 해당 migration, `packages/shared/src/schemas.ts`, `apps/api/src/floor-editor/floor-editor-snapshot.ts`, `docs/database-schema.md`.

제안 공통 값:

```ts
type FixturePlacement = {
  placementStatus: 'unplaced' | 'placed';
  positionVerifiedAt: string | null;
};
// 저장 입력은 확인 시각을 신뢰하지 않고 서버가 명시적 위치 확인에 시각을 부여한다.
type PlacementPatch = { placementStatus?: 'unplaced' | 'placed'; positionVerified?: boolean };
```

- [x] 신규 조명 기본 unplaced, 기존 row placed/미확인, 기존 x/y 보존 migration을 작성하고 이전/신규 row와 이전 snapshot 호환 테스트를 실행한다.
- [x] 배치 상태/위치 확인 필드를 editor 조회·저장·snapshot에 전파하고 새 snapshot 버전과 이전 버전 parser를 연결한다. unplaced 확인 금지와 좌표 변경 시 확인 해제를 검증한다.
- [x] shared/API 타입 및 migration 통합 검증 뒤 DB 문서/메뉴/상태판을 갱신하고 커밋한다.

### Task 2: 등록과 배치 분리 / backend

대상: `apps/api/src/registration/registration.service.ts`, `apps/api/src/floor-editor/floor-editor.service.ts`, `apps/api/src/floor-map/floor-map.service.ts`, 조명/대시보드 조회 소비자.

- [x] 캔버스 공간이 가득 차도 신규 등록이 성공하고 unplaced로 생성되는 회귀를 추가한다. 최신 웹에서는 등록 단계 배치 입력을 제거하고 구버전 요청의 기존 필드 수신 정책을 명시적으로 호환 처리한다.
  서버와 회귀 완료: 구버전 placement 입력은 호환 수신 후 무시한다. 웹 입력 제거는 Task 9와 함께 검증 완료했다.
- [x] 지도 마커의 배치 필터를 조회·제어·통계 집계 필터와 분리한다. 편집기는 미배치 조명도 포함한 전체 편집 상태를 제공한다.
- [x] 미배치 전환 전후 fixture ID, Mesh 주소, 그룹 멤버, 자동화 대상, 전력 이력이 동일한지 실DB 테스트 후 관련 문서 갱신과 커밋을 진행한다.

### Task 3: 1,000개 렌더링 기반 / web_frontend

대상: `apps/web/src/features/floor-editor/FloorEditorCanvas.tsx`, `editor-store.ts`, 신규 `EditorFixtureNode.tsx`, `apps/web/src/features/floor-map/FloorScene.tsx`.

- [x] 기존 1,000개 fixture 브라우저 시나리오에 pan/zoom 프레임 측정과 안정적인 ref 유지 검사를 추가해 기준을 기록한다.
- [x] 배경/도형/조명/선택 레이어와 Zustand selector를 분리하고 조명 노드를 memo 처리한다. pan/zoom 중 반복적인 전체 React 상태 갱신을 제거한다.
- [x] 화면 크기 Stage와 단일 좌표 변환 경로, 저배율 이름 축소, locked 객체의 상호작용 차단을 검증하고 문서 갱신 후 커밋한다.

### Task 4: 편집 명령과 Undo/Redo / web_frontend

대상: `editor-store.ts`, `editor-diff.ts`, `FloorEditorView.tsx`, `apps/web/src/features/settings/floor-plans/FloorEditorRoute.tsx`.

- [x] `placeFixtures`, `unplaceFixture`, `moveFixtures`, `updateFixtureProperties` 동작을 한 번의 이력 항목으로 적용한다. ID별 변경 추적과 재배치/배치 해제/Undo/Redo 왕복 검증을 작성한다.
- [x] 저장 후 에디터를 유지하고 응답으로 baseline/cache를 교체한다. 저장 실패/충돌에서 초안을 보존하고 서버 버전 복구와 로컬 Undo를 구분한다.
- [x] 로컬 초안은 사용자·현장·층·baseline revision으로 격리하고 로그아웃 시 제거한다. 복구 시 권한과 revision을 다시 확인하며 lease가 없으면 변경을 차단한다. 문서 갱신 후 커밋한다.

### Task 5: 목록 드롭과 확인 팝업 배치 해제 / web_frontend

대상: 신규 `FixturePlacementList.tsx`, `FixturePlacementAction.tsx`, 공통 `apps/web/src/components/ui/ConfirmDialog.tsx`, `FloorEditorCanvas.tsx`, 공통 dialog/button 컴포넌트.

- [x] 미배치 목록에서 fixture ID만 드래그하고 캔버스 drop에서 현재 층/상태를 다시 확인한다. 화면에서 월드 좌표로 변환한 중심점에 한 번 배치한다.
- [x] 단일 선택 조명 우상단에 화면 크기 고정 배치 해제 버튼을 추가한다. 핸들 중첩, 경계 넘침, 클릭 이벤트 전파를 차단한다.
- [x] 설계의 정확한 팝업 문구와 취소/확인/포커스 복귀를 구현한다. 승인 후 로컬 미배치 목록 복귀와 저장/Undo/재드롭을 검증한다.
- [x] 0.5배/1배/2배 및 pan/스크롤 상태의 드롭, 캔버스 밖 취소, 중복 drop, lease 만료, viewer 변경 차단 브라우저 회귀 후 문서 갱신과 커밋을 진행한다.

### Task 6: 검색과 지도 탐색 / web_frontend

대상: `FixturePlacementList.tsx`, `FloorEditorView.tsx`, `FloorEditorCanvas.tsx`, `EditorPropertiesPanel.tsx`.

- [x] 이름/현재 제공 가능한 시리얼·Mesh 주소 검색, 전체/배치/미배치 필터와 가상화 목록, 선택 수/배치 수를 추가한다. 식별자 DTO가 없으면 backend와 shared 계약을 먼저 확장한다.
- [x] 검색 결과 선택은 배치 조명일 때 위치로 이동하고 미배치이면 목록/속성에 머문다. 도면 맞춤·선택 맞춤·미니맵·휠 줌·팬을 연결한다.
- [x] 우측 속성/배치/레이어 탭에 기본 도형과 색상 기능을 유지하고 배경 업로드/교체 진입점을 숨긴다. 저장된 기존 배경 호환 표시와 1,000번째 항목 탐색을 검증한 뒤 문서 갱신과 커밋을 진행한다.

### Task 7: 대량 선택과 반자동 배치 / web_frontend

대상: 신규 `editor-placement.ts`, `EditorBatchPlacementPanel.tsx`, `editor-store.ts`, `EditorPropertiesPanel.tsx`, `FloorEditorCanvas.tsx`.

- [x] 박스/Shift 선택, 필터 결과 전체 선택, 다중 이동, 화살표 이동, 스냅, 정렬/균등 분배를 구현한다. 잠긴 항목을 제외하고 그룹 이동 경계는 선택 집합에 동일한 이동량을 적용한다.
- [x] 사각형 영역 격자/통로 선형 배치의 대상 ID·행/열·간격·방향 미리보기와 취소/적용을 구현한다. 공간이 부족하면 개수/간격을 수정하도록 안내하고 겹침이나 누락을 숨기지 않는다.
- [x] 이름 규칙·표시 크기·정격 W 일괄 속성을 혼합값/결과 미리보기와 연결한다. 24개 일괄 배치의 단일 Undo, 1,000개 이동, fixture 복제 없음과 제어 그룹 불변을 검증하고 커밋한다.

### Task 8: 실물 조명 위치 확인 / backend → gateway → firmware → web_frontend

대상: `packages/shared/src/fixture-identify-contracts.ts`, 등록 후 fixture 명령 API, `apps/gateway/src/mesh/bluez-mesh-adapter.ts`, Health client 경로, `apps/esp32-h2-firmware/main/identify.c`, `ble_mesh_node.c`, 신규 웹 `FixtureIdentifyPanel.tsx`.

- [x] 공유 명령에 fixture ID/site/gateway/command ID와 절대 만료 시각을 정의하고 시작/중지/결과를 분리한다. 현장 admin, 현재 lease, online/등록 상태, 단일 진행 대상을 서버에서 검증한다.
- [x] Gateway가 Health Attention 시작/중지와 응답을 처리하고 중복/만료/응답 없음/다음 대상 전환 시 이전 대상 중지를 처리한다. 기존 identify의 100% 고정 동작을 사용하지 않는다.
- [x] ESP32에서 자체 만료와 종료/재시작 처리를 검증하고 식별 중 정상 제어 목표를 보존한다. 시작 당시 밝기가 아닌 최신 목표로 돌아가도록 PWM 출력 우선순위를 정리한다. 12개 fake driver 시나리오와 portable 상태 테스트, ESP-IDF compile-only 빌드/산출물 감사 및 독립 코드 검토를 통과했다. 서비스의 10초 한도는 API/Gateway가 강제하며 펌웨어는 표준 Health Attention의 1~255초를 수용한다. 실제 RF/LED 동작은 미검증이다.
- [x] 웹의 확인 시작/중지/다음/건너뛰기와 위치 클릭·명시적 확인을 연결한다. 명령 응답과 사람의 위치 확인을 구분해 저장한다.
- [x] 소프트웨어 계약·Gateway·firmware host 테스트 및 ESP-IDF build를 통과한 각 소단위마다 커밋한다. 실제 LED 점멸/종료/스케줄·이벤트 복귀는 HIL 완료 전까지 미검증으로 남긴다. API/Gateway 독립 검토의 publisher 테스트 속성 순서 문제를 수정했고 main 재실행은 식별 Gateway 12/API 17개 통과다. MQTT/BlueZ는 이 회귀에서 mock 경계이며 실제 broker/RF Attention은 검증하지 않았다.

### Task 9: 모니터링·제어·통계 연동 / web_frontend + backend

대상: `apps/web/src/features/floor-map/FloorScene.tsx`, 모니터링 목록/빈 상태, 제어 대상 선택, API 대시보드/통계 조회와 각 회귀 테스트.

- [x] 지도에서 unplaced만 제외하고 목록에는 남긴다. 등록 1,000개/배치 0개와 등록 0개의 안내를 구분하고 설정 편집 진입을 제공한다.
- [x] 배치 해제 후 수동 제어, 기존 그룹/스케줄/이벤트 대상 유지와 전력 합계를 실백엔드에서 검증한다. 사용자가 저장하기 전에는 모니터링 지도가 바뀌지 않도록 한다.
- [x] 저장/재조회/revision 복구 후 배치/위치 확인 상태와 도형이 일치하는지 검증하고 영향받는 메뉴 문서를 갱신한 뒤 커밋한다.

### Task 10: 대량 저장·복구 안정성 / backend

대상: `apps/api/src/main.ts`, `apps/api/src/floor-editor/floor-editor.service.ts`, snapshot parser와 실DB/HTTP 통합 테스트.

- [x] 1,000개 fixture 전체 필드와 2,000개 object 변경을 실제 HTTP 경로로 보내 body 상한/검증 응답을 확인한다. 좌표 변경을 묶음 SQL로 처리하며 정격 W 변경은 기존 에너지 checkpoint를 보존한다.
- [x] 저장·복구 시간 예산과 timeout 오류 응답을 명시하고 lease/revision/atomic audit 경계를 유지한다. 실패 시 일부 row나 revision만 저장되지 않는 회귀를 실행한다.
- [x] snapshot 크기/복구 지연을 100회 저장으로 측정한다. 새 snapshot 버전·해시와 이전 버전 파서를 검증하고 기존 이력을 자동 삭제하지 않는다. 장기 보관 정책은 측정 결과와 함께 문서에 제안값으로 남긴다.
- [x] 관련 API 테스트/typecheck와 문서를 갱신하고 커밋한다. 2026-09-09 로컬 Mac 격리 PostgreSQL/HTTP 최종 재실행: 저장 100회 p95 425ms, 복구 485ms. 실제 운영 부하/HIL 성능 보장은 아니다.

### Task 11: 통합 검증과 완료 판정 / qa_reviewer

- [x] 브라우저 정상 흐름을 검증한다: 신규 등록 → 미배치 → 목록 드롭 → 다중 배치 → 위치 확인 초안 → 저장 → 모니터링 → 배치 해제 취소/승인 → 저장 → 제어/통계 유지 → 재배치.
- [x] 1,000개 조명으로 대표 PC 1440/1024, 좁은 화면 390/320의 패널/버튼 겹침을 확인한다. 성능 합격 목표는 편집 준비 p95 3초 이내, 연속 이동 중 장시간 30fps 미만 구간 없음, 대량 저장 p95 3초 이내다. 하드웨어/브라우저/회차를 증거에 기록한다.
- [x] 일반적인 데이터 손실 경로인 새로고침, 저장 실패, lease 만료, 계정 전환, Undo 후 저장, 이전 revision 복구를 점검한다. 인터랙티브 시안은 생산 코드 검증 증거로 사용하지 않는다.
- [ ] 실장비가 준비되면 Raspberry Pi/ESP32-H2/LED로 식별 시간 제한, 중지, 다음 조명 전환과 자동제어 복귀를 실행한다. 실장비 부재는 UI/소프트웨어 완료와 구분한다.
- [x] 발견된 오류를 소유 역할에 반환하고 수정 후 필요한 회귀를 재실행한다. 최종 상태판/메뉴 문서와 이 체크리스트를 일치시키고 작업 단위별 커밋을 확인한다.

### 실행 순서와 범위 검토

Task 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9 → 10 → 11 순서다. Task 8의 공유 계약/API → Gateway → firmware → 웹 순서는 유지한다. 독립된 backend 대량 저장 최적화는 공유 계약 완료 후 웹 작업과 병렬 진행할 수 있다.

- [x] 미배치 목록 드래그 앤 드롭: Task 5.
- [x] 단일 선택 조명 우상단 버튼과 확인 팝업: Task 5.
- [x] 장비 삭제가 아닌 미배치 복귀: Task 1, 2, 4, 5, 9.
- [x] 기존 파일 도면 활용 보류와 기존 자산 보존: Task 6.
- [x] 앞서 제안한 검색/일괄 편집/식별/성능 보완: Task 3, 4, 6, 7, 8, 10, 11.

위 범위의 소프트웨어 구현과 검증을 완료했다. 실제 RF/LED 식별 동작은 위 Task 11 미완료 항목으로 유지한다.


### 2026-09-10 최종 검증과 후속 재개

- 독립 웹 재실행: 43개 파일 497개 단위 테스트, production build 통과. main bundle 1,149.81 kB/gzip 347.57 kB의 기존 500 kB 경고는 남아 있으며 코드 분할은 후속 최적화다.
- 실제 두 층 API/PostgreSQL/Redis/MQTT Chromium 1개(43.9초)와 기존 설치 여정 2개 통과. RF 송수신은 테스트 전용 simulator다. 등록 후 미배치, 층별 저장/새로고침/전환 취소, 배치 해제/Undo, 미배치 70% 제어, 통계 보존, 재배치를 검증했다.
- 1,000개 배치 조명 warm reload 20회: 준비 p95 220.6ms, 최대 235.6ms. macOS arm64 M2 Pro, Chromium 149.0.7827.55, 1440x900, mock API와 warm Vite/OS cache 조건이며 운영 cold start 보장이 아니다. pan/zoom 평균 119.9fps, 프레임 p95 10.3ms와 1,000개 노드 ref 유지도 확인했다.
- main 격리 PostgreSQL/HTTP 18개 재실행: 559,679바이트 요청, 조명 1,000개/도형 2,000개 저장 100회 p95 549ms, 복구 422ms. 앞선 담당자 측정 425/485ms와 별도 실행이며 운영 부하 보장은 아니다.
- 늦은 층/계정 응답, 인증 전환의 로컬 초안, 새로고침 편집권 반납, 숨긴 항목 변경, 음수 방향 배치, 밀집 이름 겹침, 저장 후 viewport 초기화를 보완하고 회귀로 고정했다.
- 재현: 웹 경로에서 `pnpm exec vitest run`, `pnpm exec playwright test e2e/floor-placement.spec.ts --project=chromium --workers=1`. 실백엔드 시나리오는 `e2e/floor-placement-real.spec.ts`와 `e2e/installation-customer-journey.spec.ts`의 격리 lab 설정을 사용한다.
- 로컬 증거: `.superpowers/sdd/2026-07-06-floor-editor-implementation/`의 `web-final`, `web-regression-final`, `qa-final-pass`, `installation-final`. 결과 JSON·스크린샷·네트워크/MQTT 증거를 보존한다.
- 재개 시 사용자 DB를 백업하고 migration을 적용한 뒤 서비스를 시작한다. 실제 장비가 준비되면 Health Attention 시작/중지/10초 만료/다음 대상/최신 제어 밝기 복귀를 검증한다. 이번 작업에서는 사용자 DB·Pi·ESP32를 변경하지 않았다.

---

## 진행 로그

### 2026-07-07 09:30 Konva 에디터 전환

- 완료된 작업: `FloorEditorCanvas`를 DOM 절대좌표 요소 기반에서 `react-konva` Stage/Layer/Transformer 기반으로 전환했다.
- 완료된 작업: 좌측 툴바의 도형 도구를 도면 위로 HTML drag/drop할 때 Konva 좌표계로 변환해 기본 크기 객체가 생성되도록 수정했다.
- 완료된 작업: 좌측 도구 선택 후 도면 내부를 드래그해 크기를 지정하는 생성 방식도 Konva 캔버스와 DOM fallback 이벤트에서 동작하도록 유지했다.
- 완료된 작업: 도형/텍스트 객체는 Konva Transformer의 모서리/변 핸들로 리사이즈하고, 조명 객체도 동일하게 Transformer로 크기를 조절한다.
- 완료된 작업: 조명 리사이즈 저장을 위해 `Fixture.size` DB 컬럼과 API/update payload를 추가했다.
- 검증 완료:
  - `PATH="/Users/kim-jh/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:/Users/kim-jh/.cache/codex-runtimes/codex-primary-runtime/dependencies/bin:$PATH" pnpm --filter @led-control/web test -- FloorEditorView.test.tsx geometry.test.ts`

### 2026-07-07 09:02 에디터 편집 UX 보강 완료

- 완료된 작업: 좌측 도구에서 네모, 세모, 선, 텍스트 객체를 클릭 생성이 아니라 툴바 도구를 도면 위로 드래그 앤 드롭해 생성하도록 변경했다.
- 완료된 작업: 좌측 도구 선택 후 캔버스 내부를 드래그해 크기를 지정하는 보조 생성 방식은 유지하되, 단순 클릭만으로 객체가 생성되지 않도록 변경했다.
- 완료된 작업: 생성된 도형/텍스트 객체를 선택 모드에서 드래그 이동할 수 있게 했다. 드래그 시작 지점과 객체 좌상단 사이의 offset을 유지해 마우스 포인터를 자연스럽게 따라간다.
- 완료된 작업: 선택된 도형/텍스트 객체에 우하단 리사이즈 핸들을 표시하고, 핸들 드래그로 `width/height`를 변경할 수 있게 했다.
- 완료된 작업: 채우기 색상 입력을 선 색상과 동일한 color palette 입력으로 변경했다. 기본 도형 fill 색상은 팔레트 입력과 호환되는 hex 값으로 정리했다.
- 검증 완료:
  - `PATH="/Users/kim-jh/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:/Users/kim-jh/.cache/codex-runtimes/codex-primary-runtime/dependencies/bin:$PATH" pnpm --filter @led-control/web test -- FloorEditorView.test.tsx geometry.test.ts`
  - `PATH="/Users/kim-jh/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin:/Users/kim-jh/.cache/codex-runtimes/codex-primary-runtime/dependencies/bin:$PATH" pnpm --filter @led-control/web typecheck`
- 남은 개선: 도형 다중 선택/일괄 이동, 삭제, 복사/붙여넣기, 4방향/8방향 리사이즈, 회전, grid snap, undo/redo는 후속 MVP 범위다.

### 2026-07-06 15:31 통합 구현 완료

- 완료된 작업: Prisma schema와 migration에 `FloorPlanSourceType`, `FloorPlan` 확장 필드, `FloorMapObject`를 추가하고 로컬 PostgreSQL에 migration을 적용했다.
- 완료된 작업: `floor-editor` NestJS module/controller/service를 추가하고 조직 범위 guard를 적용했다. `GET /floors/:floorId/editor-state`는 웹 에디터가 바로 사용할 수 있는 `{ floor, fixtures, objects }` DTO 형태로 반환한다.
- 완료된 작업: 모니터링 화면의 `도면 편집` 진입점, 에디터 상단바, 툴바, 캔버스, 배경 업로더, 속성 패널, 저장/취소 흐름을 구현했다.
- 완료된 작업: 배경 없음, JPG/PNG data URL 배경, PDF 첫 페이지 렌더링 배경, 줌/패닝, 네모/세모/선/텍스트 추가, 조명 단일 드래그 및 기본 정보 수정, 저장 후 query invalidate를 구현했다.
- MVP 한계: 업로드 파일은 아직 별도 파일 스토리지에 저장하지 않고 data URL로 `FloorPlan`에 저장한다. 운영 전에는 정적 업로드 디렉터리 또는 S3 호환 저장소로 분리해야 한다.
- 검증 완료:
  - `pnpm --filter @led-control/api test -- floor-editor.service.spec.ts sites.service.spec.ts --runInBand`
  - `pnpm --filter @led-control/web test -- geometry.test.ts FloorEditorView.test.tsx App.test.tsx`
  - `pnpm typecheck`
  - `git diff --check`

### 2026-07-06 15:20 문서/검토 서브 에이전트 갱신

- 당시 상태: Task 1 의존성 설치가 완료되었고, 나머지 구현은 통합 전이었다. 코드 구현은 다른 에이전트가 진행할 수 있으므로 이 문서는 통합 중단에 대비한 기준점으로 사용했다.
- 완료된 작업: 메인 에이전트가 `pnpm --filter @led-control/web add konva react-konva pdfjs-dist`를 실행한 뒤 React 18 peer 호환을 위해 `react-konva@18.2.16`으로 조정했다. `pnpm --filter @led-control/web typecheck`는 PATH를 명시한 실행 환경에서 통과했다.
- Subagent-Driven 분담:
  - 백엔드 에이전트: Prisma schema/migration, `floor-editor` API, 조직 범위 guard, 서비스 테스트를 담당한다.
  - 웹 에이전트: `react-konva` 기반 에디터 화면, Zustand draft 상태, 도형/텍스트/조명 드래그 편집, 저장/취소 흐름을 담당한다.
  - 문서/검토 에이전트: `docs/menus/monitoring.md`, `docs/database-schema.md`, 서비스 설계 문서, 이 계획서의 진행 상태를 실제 구현 상태에 맞춰 갱신한다.
- 예상 통합 순서:
  1. Task 2로 Prisma 모델과 migration을 먼저 합친다.
  2. Task 3-4로 백엔드 테스트와 API를 통과시킨 뒤 editor-state 응답 계약을 고정한다.
  3. Task 5-7로 웹 타입, API client, 좌표 변환 helper, 에디터 store를 붙인다.
  4. Task 8-13으로 UI shell, canvas 렌더링, 편집 상호작용, 저장/취소, 배경 등록, 모니터링 진입점을 순서대로 연결한다.
  5. Task 14-15에서 문서를 완료 상태로 재분류하고 API/Web/typecheck/manual 검증을 수행한다.
- 당시 문서 상태: 메뉴/DB/설계 문서는 완료가 아니라 `구현 중`과 `예정`을 명시해 두었다. 실제 코드와 migration이 합쳐진 뒤 Task 14에서 완료 항목으로 이동했다.

## 1. 목표 범위

MVP 1에서 구현한다.

- 모니터링 페이지 `에디터` 버튼
- 선택 층 기준 전체 화면 편집 모드
- 도면 배경 선택 등록
  - 배경 없음 허용
  - JPG/PNG
  - PDF 첫 페이지 렌더링
- 줌인, 줌아웃, 팬
- 네모, 세모, 선, 텍스트 추가/수정
- 도형 색상, 선 두께, 텍스트 수정
- LED 조명 선택, 드래그 이동
- 조명 이름, 정격 W, 좌표 수정
- 저장, 취소
- 저장 후 dashboard 갱신

MVP 1에서 구현하지 않는다.

- 다중 조명 일괄 이동
- CAD/DWG/DXF import
- AI 도면 해석
- RF heatmap
- 전체 undo/redo 이력

## 2. 목표 파일 구조

### Backend

- Modify: `apps/api/prisma/schema.prisma`
  - `FloorPlan.sourceType`, `originalFileUrl`, `renderedImageUrl` 추가
  - `FloorMapObject` 모델 추가
- Create: `apps/api/prisma/migrations/<timestamp>_add_floor_editor/migration.sql`
- Create: `apps/api/src/floor-editor/floor-editor.module.ts`
- Create: `apps/api/src/floor-editor/floor-editor.controller.ts`
- Create: `apps/api/src/floor-editor/floor-editor.service.ts`
- Create: `apps/api/src/floor-editor/floor-editor.service.spec.ts`
- Modify: `apps/api/src/app.module.ts`
- Modify: `apps/api/src/sites/sites.service.ts`

### Web

- Create: `apps/web/src/api/floor-editor.ts`
- Create: `apps/web/src/features/floor-editor/editor-types.ts`
- Create: `apps/web/src/features/floor-editor/editor-store.ts`
- Create: `apps/web/src/features/floor-editor/geometry.ts`
- Create: `apps/web/src/features/floor-editor/FloorEditorView.tsx`
- Create: `apps/web/src/features/floor-editor/FloorEditorCanvas.tsx`
- Create: `apps/web/src/features/floor-editor/EditorToolbar.tsx`
- Create: `apps/web/src/features/floor-editor/EditorPropertiesPanel.tsx`
- Create: `apps/web/src/features/floor-editor/FloorAssetUploader.tsx`
- Create: `apps/web/src/features/floor-editor/FloorEditorView.test.tsx`
- Create: `apps/web/src/features/floor-editor/geometry.test.ts`
- Modify: `apps/web/src/features/monitoring/MonitoringView.tsx`
- Modify: `apps/web/src/styles.css`

### Docs

- Modify: `docs/menus/monitoring.md`
- Modify: `docs/database-schema.md`
- Modify: `docs/superpowers/specs/2026-07-01-led-lighting-control-service-design.md`

## 3. Task 1: 에디터 라이브러리 설치

**Files:**

- Modify: `apps/web/package.json`
- Modify: `pnpm-lock.yaml`

- [x] **Step 1: Install dependencies**

Run:

```bash
pnpm --filter @led-control/web add konva react-konva pdfjs-dist
```

Expected:

```text
dependencies:
+ konva
+ react-konva
+ pdfjs-dist
```

Result: React 18 peer 호환을 위해 `react-konva@18.2.16`으로 조정했다.

- [x] **Step 2: Verify install**

Run:

```bash
pnpm --filter @led-control/web typecheck
```

Expected: pass.

Result: PATH를 명시한 실행 환경에서 통과했다.

## 4. Task 2: Prisma 모델 추가

**Files:**

- Modify: `apps/api/prisma/schema.prisma`
- Create: `apps/api/prisma/migrations/<timestamp>_add_floor_editor/migration.sql`

- [ ] **Step 1: Update Prisma schema**

Add enum:

```prisma
enum FloorPlanSourceType {
  none
  image
  pdf
}
```

Extend `FloorPlan`:

```prisma
model FloorPlan {
  id               String              @id @default(uuid())
  floorId          String              @unique
  imageUrl         String
  width            Int
  height           Int
  version          Int                 @default(1)
  sourceType       FloorPlanSourceType @default(image)
  originalFileUrl  String?
  renderedImageUrl String?
  floor            Floor               @relation(fields: [floorId], references: [id])
  createdAt        DateTime            @default(now())
  updatedAt        DateTime            @updatedAt
}
```

Add model:

```prisma
model FloorMapObject {
  id          String   @id @default(uuid())
  floorId     String
  type        String
  x           Float
  y           Float
  width       Float?
  height      Float?
  rotation    Float    @default(0)
  points      Json?
  text        String?
  strokeColor String   @default("#0b63e5")
  fillColor   String?
  strokeWidth Float    @default(2)
  fontSize    Float?
  zIndex      Int      @default(0)
  locked      Boolean  @default(false)
  visible     Boolean  @default(true)
  floor       Floor    @relation(fields: [floorId], references: [id])
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  @@index([floorId, zIndex])
}
```

Add relation to `Floor`:

```prisma
mapObjects FloorMapObject[]
```

- [ ] **Step 2: Create migration**

Run:

```bash
pnpm --filter @led-control/api prisma migrate dev --name add_floor_editor
```

Expected: migration created and applied.

- [ ] **Step 3: Generate Prisma client**

Run:

```bash
pnpm --filter @led-control/api prisma:generate
```

Expected: generated client without errors.

## 5. Task 3: Backend service tests

**Files:**

- Create: `apps/api/src/floor-editor/floor-editor.service.spec.ts`

- [ ] **Step 1: Write editor-state test**

Create tests for:

```ts
it("returns editor state for a floor in the current organization", async () => {});
it("rejects editor state access for another organization", async () => {});
```

Expected behavior:

- Service checks `floor.site.organizationId`.
- Response includes `floor`, `floorPlan`, `fixtures`, `objects`.

- [ ] **Step 2: Write fixture update test**

Create tests for:

```ts
it("updates fixture name rated watt and position inside the current organization", async () => {});
it("rejects fixture update outside the current organization", async () => {});
```

- [ ] **Step 3: Write map object CRUD tests**

Create tests for:

```ts
it("creates a rectangle map object", async () => {});
it("updates a text map object", async () => {});
it("deletes a map object", async () => {});
```

- [ ] **Step 4: Run failing tests**

Run:

```bash
pnpm --filter @led-control/api test -- floor-editor.service.spec.ts --runInBand
```

Expected: fail because module/service does not exist.

## 6. Task 4: Backend floor-editor module 구현

**Files:**

- Create: `apps/api/src/floor-editor/floor-editor.module.ts`
- Create: `apps/api/src/floor-editor/floor-editor.controller.ts`
- Create: `apps/api/src/floor-editor/floor-editor.service.ts`
- Modify: `apps/api/src/app.module.ts`

- [ ] **Step 1: Create service input types**

Implement internal service inputs:

```ts
export interface UpdateFixtureEditorInput {
  organizationId: string;
  fixtureId: string;
  name?: string;
  ratedWatt?: number;
  x?: number;
  y?: number;
}
```

```ts
export interface UpsertMapObjectInput {
  organizationId: string;
  floorId: string;
  type: "rectangle" | "triangle" | "line" | "text";
  x: number;
  y: number;
  width?: number;
  height?: number;
  rotation?: number;
  points?: unknown;
  text?: string;
  strokeColor?: string;
  fillColor?: string;
  strokeWidth?: number;
  fontSize?: number;
  zIndex?: number;
}
```

- [ ] **Step 2: Implement organization guards**

Every query must verify ownership through `site.organizationId`.

```ts
await prisma.floor.findFirst({
  where: { id: floorId, site: { organizationId } }
});
```

- [ ] **Step 3: Implement endpoints**

Controller routes:

```text
GET /floors/:floorId/editor-state
PATCH /floors/:floorId/floor-plan
PATCH /fixtures/:fixtureId
POST /floor-map-objects
PATCH /floor-map-objects/:objectId
DELETE /floor-map-objects/:objectId
```

- [ ] **Step 4: Run tests**

Run:

```bash
pnpm --filter @led-control/api test -- floor-editor.service.spec.ts --runInBand
```

Expected: pass.

## 7. Task 5: Web API client와 타입

**Files:**

- Create: `apps/web/src/api/floor-editor.ts`
- Create: `apps/web/src/features/floor-editor/editor-types.ts`

- [ ] **Step 1: Define editor types**

Create:

```ts
export type EditorTool = "select" | "pan" | "fixture" | "rectangle" | "triangle" | "line" | "text";
export type MapObjectType = "rectangle" | "triangle" | "line" | "text";
```

Define `FloorEditorState`, `EditorFixture`, `FloorMapObject`.

- [ ] **Step 2: Implement API client**

Functions:

```ts
export function getFloorEditorState(floorId: string) {}
export function updateFloorPlan(floorId: string, payload: UpdateFloorPlanPayload) {}
export function updateEditorFixture(fixtureId: string, payload: UpdateEditorFixturePayload) {}
export function createFloorMapObject(payload: CreateFloorMapObjectPayload) {}
export function updateFloorMapObject(objectId: string, payload: UpdateFloorMapObjectPayload) {}
export function deleteFloorMapObject(objectId: string) {}
```

## 8. Task 6: Geometry unit tests

**Files:**

- Create: `apps/web/src/features/floor-editor/geometry.ts`
- Create: `apps/web/src/features/floor-editor/geometry.test.ts`

- [ ] **Step 1: Write tests**

Test:

```ts
it("converts screen coordinates to world coordinates with zoom and pan", () => {});
it("moves a fixture by a delta and clamps it inside the floor plan", () => {});
it("creates default rectangle triangle line and text objects", () => {});
```

- [ ] **Step 2: Implement helpers**

Functions:

```ts
export function screenToWorld(point, viewport) {}
export function clampPoint(point, bounds) {}
export function moveByDelta(point, delta, bounds) {}
export function createDefaultObject(type, point) {}
```

- [ ] **Step 3: Run tests**

Run:

```bash
pnpm --filter @led-control/web test -- geometry.test.ts
```

Expected: pass.

## 9. Task 7: Editor store

**Files:**

- Create: `apps/web/src/features/floor-editor/editor-store.ts`

- [ ] **Step 1: Implement Zustand state**

State:

```ts
interface FloorEditorStore {
  tool: EditorTool;
  zoom: number;
  pan: { x: number; y: number };
  selectedId: string | null;
  dirtyFixtureIds: string[];
  dirtyObjectIds: string[];
  setTool(tool: EditorTool): void;
  setZoom(zoom: number): void;
  setPan(pan: { x: number; y: number }): void;
  select(id: string | null): void;
  markFixtureDirty(id: string): void;
  markObjectDirty(id: string): void;
  resetEditor(): void;
}
```

## 10. Task 8: FloorEditorView shell

**Files:**

- Create: `apps/web/src/features/floor-editor/FloorEditorView.tsx`
- Create: `apps/web/src/features/floor-editor/EditorToolbar.tsx`
- Create: `apps/web/src/features/floor-editor/EditorPropertiesPanel.tsx`
- Create: `apps/web/src/features/floor-editor/FloorEditorView.test.tsx`

- [ ] **Step 1: Write shell test**

Test:

```ts
it("renders toolbar canvas properties panel save and cancel actions", async () => {});
```

- [ ] **Step 2: Implement shell**

Layout:

```text
topbar: floor name, zoom buttons, save, cancel
left: toolbar
center: FloorEditorCanvas
right: properties panel
```

- [ ] **Step 3: Run test**

Run:

```bash
pnpm --filter @led-control/web test -- FloorEditorView.test.tsx
```

Expected: pass.

## 11. Task 9: Konva canvas 렌더링

**Files:**

- Create: `apps/web/src/features/floor-editor/FloorEditorCanvas.tsx`
- Modify: `apps/web/src/features/floor-editor/FloorEditorView.test.tsx`

- [ ] **Step 1: Render background optional**

Rules:

- If `floorPlan.renderedImageUrl` or `floorPlan.imageUrl` exists, render image background.
- If no background exists, render grid background.

- [ ] **Step 2: Render fixtures**

Fixture marker rules:

- online: blue
- offline: gray
- fault: red
- selected: outline

- [ ] **Step 3: Render map objects**

Render:

- rectangle
- triangle
- line
- text

- [ ] **Step 4: Run tests**

Run:

```bash
pnpm --filter @led-control/web test -- FloorEditorView.test.tsx
```

Expected: pass.

## 12. Task 10: 편집 상호작용

**Files:**

- Modify: `apps/web/src/features/floor-editor/FloorEditorCanvas.tsx`
- Modify: `apps/web/src/features/floor-editor/EditorPropertiesPanel.tsx`

- [ ] **Step 1: Implement zoom controls**

Buttons:

```text
확대
축소
100%
```

Clamp zoom:

```ts
min = 0.25;
max = 4;
```

- [ ] **Step 2: Implement pan tool**

When tool is `pan`, drag empty canvas to move viewport.

- [ ] **Step 3: Implement fixture drag**

When selected fixture is dragged, update draft `x/y` and mark fixture dirty.

- [ ] **Step 4: Implement object creation**

When tool is `rectangle`, `triangle`, `line`, or `text`, click canvas to create default object.

- [ ] **Step 5: Implement property edits**

Properties panel updates:

- fixture name
- fixture ratedWatt
- fixture x/y
- object strokeColor
- object fillColor
- object strokeWidth
- object text
- object fontSize

## 13. Task 11: 저장/취소

**Files:**

- Modify: `apps/web/src/features/floor-editor/FloorEditorView.tsx`
- Modify: `apps/web/src/api/floor-editor.ts`

- [ ] **Step 1: Save changed fixtures**

For each dirty fixture:

```ts
await updateEditorFixture(fixture.id, {
  name: fixture.name,
  ratedWatt: fixture.ratedWatt,
  x: fixture.x,
  y: fixture.y
});
```

- [ ] **Step 2: Save changed objects**

For new objects call `createFloorMapObject`.

For existing dirty objects call `updateFloorMapObject`.

- [ ] **Step 3: Save floor plan background**

If floor plan changed, call `updateFloorPlan`.

- [ ] **Step 4: Invalidate dashboard**

After save:

```ts
queryClient.invalidateQueries({ queryKey: ["dashboard"] });
```

- [ ] **Step 5: Cancel**

Cancel discards draft and exits edit mode.

## 14. Task 12: MonitoringView 연결

**Files:**

- Modify: `apps/web/src/features/monitoring/MonitoringView.tsx`
- Modify: `apps/web/src/App.test.tsx`

- [ ] **Step 1: Add edit mode state**

Add:

```ts
const [isEditing, setIsEditing] = useState(false);
```

- [ ] **Step 2: Add editor button**

Button:

```text
에디터
```

Only show when `data.site.id` and selected floor exist.

- [ ] **Step 3: Render FloorEditorView**

If `isEditing`:

```tsx
<FloorEditorView floorId={floor.id} onClose={() => setIsEditing(false)} />
```

- [ ] **Step 4: Test route**

Test:

```ts
it("opens the floor editor from monitoring and returns after cancel", async () => {});
```

Run:

```bash
pnpm --filter @led-control/web test -- App.test.tsx FloorEditorView.test.tsx
```

Expected: pass.

## 15. Task 13: 도면 배경 등록

**Files:**

- Create: `apps/web/src/features/floor-editor/FloorAssetUploader.tsx`
- Modify: `apps/web/src/features/floor-editor/FloorEditorView.tsx`
- Modify: `apps/api/src/floor-editor/floor-editor.controller.ts`

- [ ] **Step 1: JPG/PNG input**

Support:

```text
image/jpeg
image/png
```

MVP 1 can store uploaded file in API static upload directory.

- [ ] **Step 2: PDF input**

Support:

```text
application/pdf
```

Render first page through `pdfjs-dist` and save rendered image as background.

- [ ] **Step 3: Background none**

Add action:

```text
배경 없음
```

This sets `sourceType = "none"`.

## 16. Task 14: 문서 갱신

**Files:**

- Modify: `docs/menus/monitoring.md`
- Modify: `docs/database-schema.md`
- Modify: `docs/superpowers/specs/2026-07-01-led-lighting-control-service-design.md`

- [x] **Step 1: Update monitoring menu doc**

Move these items from 미구현 to 구현 완료 when implemented:

- 지도 확대, 축소, 패닝
- 조명 위치 드래그 편집
- 도면 업로드 및 도면 버전 관리 UI

Add:

- 도형/텍스트 에디터
- 배경 없는 편집 캔버스

- [x] **Step 2: Update database schema doc**

Document:

- `FloorPlan.sourceType`
- `FloorPlan.originalFileUrl`
- `FloorPlan.renderedImageUrl`
- `FloorMapObject`

- [x] **Step 3: Update service design doc**

Add:

- MVP 1 manual editor
- MVP 2 automatic placement helper
- MVP 3 AI drawing interpretation

## 17. Task 15: 전체 검증

**Files:** No new files.

- [x] **Step 1: API tests**

Run:

```bash
pnpm --filter @led-control/api test -- floor-editor.service.spec.ts sites.service.spec.ts --runInBand
```

Expected: pass.

- [x] **Step 2: Web tests**

Run:

```bash
pnpm --filter @led-control/web test -- FloorEditorView.test.tsx geometry.test.ts App.test.tsx
```

Expected: pass.

- [x] **Step 3: Typecheck**

Run:

```bash
pnpm typecheck
```

Expected: pass.

- [x] **Step 4: Manual browser check**

Check:

```text
1. http://localhost:5173 접속
2. 로그인
3. 모니터링 진입
4. 층 선택
5. 에디터 클릭
6. 배경 없이 도형과 조명 편집 가능
7. 이미지 배경 등록 가능
8. 조명 드래그 후 저장
9. 읽기 모드에서 위치 반영 확인
```

## 18. Self-review

- Spec coverage: MVP 1 도면 선택 등록, 배경 없음, 도형, 텍스트, 조명 위치/정보 수정, 줌/팬을 포함한다.
- MVP separation: 다중 이동과 자동 배치는 MVP 2, AI 도면 해석과 CAD 연동은 MVP 3으로 분리했다.
- Type consistency: `FloorMapObject`, `FloorEditorState`, `UpdateFixtureRequest` 이름을 설계 문서와 구현 계획에서 일치시켰다.
- Documentation: 메뉴 문서와 DB 문서 갱신 작업을 별도 Task로 포함했다.

## 19. DWG/DXF 자동 맵 구성 실행 계획 (2026-09-16)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** DWG/DXF 원본을 비동기로 분석해 단일 맵 배경과 검토 가능한 조명 위치 후보를 만들되 실제 조명 등록은 수행하지 않는다.

**Architecture:** 기존 private `FloorAsset` 업로드 원장과 PostgreSQL lease worker 패턴을 재사용한다. CAD 변환기와 조명 분류기를 인터페이스로 격리하고 규칙 기반 분류기를 기본으로 사용하며 AI provider는 비활성 구현만 연결한다.

**Tech Stack:** NestJS, Prisma/PostgreSQL, S3/MinIO, React Query, React/Konva, TypeScript

**Spec:** `docs/superpowers/specs/2026-07-06-floor-editor-design.md` 13장

### Global Constraints

- 신규 자동 가져오기는 DWG/DXF만 지원하고 PDF는 제외한다.
- 조명 위치 후보는 `Fixture` 또는 `MeshNode`를 생성하지 않는다.
- 좌표는 CAD parser 결과만 사용하며 AI가 좌표를 생성하지 않는다.
- AI provider 기본값은 `disabled`다.
- 기존 이미지 맵, 수동 도형, 실제 조명 좌표를 가져오기가 임의 덮어쓰지 않는다.
- DB 변경은 `docs/database-schema.md`, 설정 변경은 `docs/menus/settings.md`와 같은 작업에서 갱신한다.

### Task 19.1: CAD 계약과 영속 작업 원장

**Files:**
- Modify: `apps/api/prisma/schema.prisma`
- Create: `apps/api/prisma/migrations/20260916190000_floor_cad_import/migration.sql`
- Create: `packages/shared/src/cad-import-contracts.ts`
- Modify: `packages/shared/src/index.ts`
- Test: `packages/shared/src/cad-import-contracts.test.ts`
- Modify: `docs/database-schema.md`

- [x] **RED:** DWG/DXF MIME, job 상태, 후보 응답과 apply 입력의 strict schema 테스트를 작성하고 실패를 확인한다.
- [x] **GREEN:** `FloorImportJob`, `FloorImportCandidate`, source format/status enum과 strict shared schema를 추가한다.
- [x] **VERIFY:** Shared test/typecheck, Prisma validate/generate와 PostgreSQL staged upgrade/clean replay/동시 writer를 실행한다.
- [x] **COMMIT:** 계약·migration·DB 문서를 `299aa56b`, `85b75a01`, `1c803b08`, `87858bf5`, `5f4f27ac`으로 커밋하고 4차 재검토 PASS를 받았다.

### Task 19.2: 변환·검출 코어와 AI 비활성 경계

**Files:**
- Create: `apps/api/src/floor-import/cad-types.ts`
- Create: `apps/api/src/floor-import/cad-converter.ts`
- Create: `apps/api/src/floor-import/dxf-document-parser.ts`
- Create: `apps/api/src/floor-import/cad-svg-renderer.ts`
- Create: `apps/api/src/floor-import/lighting-symbol-detector.ts`
- Create: `apps/api/src/floor-import/rule-based-lighting-symbol-detector.ts`
- Create: `apps/api/src/floor-import/disabled-ai-lighting-symbol-detector.ts`
- Test: corresponding `*.spec.ts`

- [x] **RED:** 합성 DXF의 경계·선·문자·INSERT, 조명 layer/block 검출, 비활성 AI의 외부 호출 없음, 위험 argv 거부 테스트를 작성하고 실패를 확인한다.
- [x] **GREEN:** 정규화 문서, SVG renderer, 규칙 detector와 configurable converter adapter를 구현한다.
- [x] **VERIFY:** 1,000개 후보, malformed/oversize, process tree, Linux resource limiter, dense detector abort를 포함한 66개 테스트를 실행한다.
- [x] **COMMIT:** `4e791537`, `e7534995`, `dfbaeac1`, `ecb501d2`, `89e9262e`, `c303fb60`으로 커밋하고 5차 재검토 PASS를 받았다.

### Task 19.3: 비동기 import API와 worker

**Files:**
- Create: `apps/api/src/floor-import/floor-import.module.ts`
- Create: `apps/api/src/floor-import/floor-import.controller.ts`
- Create: `apps/api/src/floor-import/floor-import.service.ts`
- Create: `apps/api/src/floor-import/floor-import-worker.service.ts`
- Modify: `apps/api/src/app.module.ts`
- Modify: `apps/api/src/storage/object-storage.service.ts`
- Modify: `apps/api/src/floor-editor/floor-assets.service.ts`
- Modify: `apps/api/src/floor-editor/floor-asset-cleanup.service.ts`
- Test: `apps/api/src/floor-import/*.spec.ts`

- [x] **RED:** 권한, 층당 활성 job 1개, lease 재개, source checksum, 실패 격리, 후보만 생성, apply의 lease/revision 충돌 테스트를 작성하고 실패를 확인한다.
- [x] **GREEN:** create/get/list/cancel/apply API와 PostgreSQL lease worker를 구현한다.
- [x] **GREEN:** 원본 stream read와 렌더 SVG private write를 추가하고 처리 중 자산을 cleanup에서 보호한다.
- [x] **VERIFY:** API focused test/typecheck와 module graph 부팅을 실행한다.
- [x] **COMMIT:** API/worker와 cleanup fence를 `1f55e92c`, `84bd5404`, `bdd6151d`, `7c264890`으로 커밋하고 3차 재검토 PASS를 받았다.

### Task 19.4: 맵 편집기 가져오기 UI와 후보 layer

**Files:**
- Create: `apps/web/src/features/floor-editor/CadImportPanel.tsx`
- Create: `apps/web/src/features/floor-editor/CadCandidateLayer.tsx`
- Modify: `apps/web/src/api/floor-editor.ts`
- Modify: `apps/web/src/features/floor-editor/editor-types.ts`
- Modify: `apps/web/src/features/floor-editor/FloorEditorCanvas.tsx`
- Modify: `apps/web/src/features/floor-editor/FloorEditorView.tsx`
- Modify: `apps/web/src/features/floor-editor/FloorAssetUploadPanel.tsx`
- Test: corresponding `*.test.tsx`

- [x] **RED:** DWG/DXF 전용 업로드, 진행 polling, review 결과, 적용, PDF 신규 업로드 부재와 1,000개 후보 batch 표시 테스트를 작성하고 실패를 확인한다.
- [x] **GREEN:** 가져오기 패널과 후보 batch layer를 구현한다.
- [x] **GREEN:** 기존 PDF 읽기 호환은 유지하고 신규 파일 선택에서는 PDF를 제거한다.
- [x] **VERIFY:** Web floor-editor 154개 테스트, typecheck/build, UI policy를 실행한다.
- [x] **COMMIT:** `38977cf0`, `867d3ba1`, `e84e3dad`, `5dc54075`, `85e6f328`, `e8813e0b`로 커밋하고 3차 재검토 Ready를 받았다.

### Task 19.5: 샘플 DWG 분석, 문서와 최종 검증

**Files:**
- Create: `scripts/analyze-cad-import.mjs`
- Test: `scripts/analyze-cad-import.test.mjs`
- Modify: `docs/menus/settings.md`
- Modify: `docs/project-status.md`
- Modify: `docs/lesson_leared.md` when a repeatable failure is found

- [x] **RED:** layer/block별 후보 개수, precision/recall 입력, F1 출력 계약과 converter/worker/storage 실패 경계 회귀를 작성하고 실패를 확인했다.
- [x] **GREEN:** 재현 가능한 로컬 분석 스크립트, 한국어 결과 요약, 비동기 제품 경로와 AI disabled 확장점을 구현했다.
- [x] **VERIFY:** 제공 DWG를 analyzer와 실제 worker/PostgreSQL/MinIO/API 경로로 실행해 기하 지원율, 후보 수와 오검출 한계를 기록했다.
- [x] **VERIFY:** Shared/API/Web focused 및 전체 회귀, Prisma validate/generate, typecheck/build, UI policy, production contract/smoke와 `git diff --check`를 실행했다.
- [x] **COMMIT:** `c401c974`~`230a1db6`, `e249e0c4`, `285585fc`, `d7470d15`, `743b3ca1`, `d929ffc7`, `7cf8b12d`, `557e9fdc`, `84e1c7ec`으로 기능을 분리 커밋하고 최종 whole-feature review에서 Spec/Quality Ready 판정을 받았다.

### Task 19.6: CAD 좌표 정규화와 자동 전체 맞춤

- [x] **RED:** 수천만 단위 CAD가 맵 상한을 초과하고 검토 배경이 나타나도 자동 맞춤이 실행되지 않는 회귀 테스트를 작성해 실패를 확인했다.
- [x] **GREEN:** 원본 종횡비를 보존한 `2400 × 1600` 상한·800px 최소 변·40px 여백 좌표계를 SVG와 후보에 공통 적용했다.
- [x] **GREEN:** 검토 또는 적용된 CAD overlay가 처음 나타날 때 전체 맵을 한 번 맞추고 이후 사용자 줌을 보존한다.
- [x] **VERIFY:** Floor import 171개, Web 전체 1,309개, Chromium 맵 편집 7개와 실제 DWG 두 종류의 worker/storage/API 경로를 검증했다. `킨다_도면등록_테스트.dwg`는 원본 `15,020,849 × 164,134`에서 `2,400 × 800`로 정규화되고 후보 2개를 유지했다.

### 19.7 Pre-flight self-review

- Spec coverage: DWG/DXF, PDF 제외, 비등록 후보, AI 비활성 확장점, 정확도 평가가 Task 19.1~19.5에 모두 연결된다.
- Type consistency: `FloorImportJob`, `FloorImportCandidate`, `LightingSymbolDetector`, `NormalizedCadDocument` 명칭을 전 Task에서 동일하게 사용한다.
- Safety: shell 문자열 실행, 자동 Fixture 생성, 기존 맵 덮어쓰기를 금지한다.
- Placeholder scan: 구현을 외부 미정 작업으로 남기는 항목 없이 초기 규칙 detector와 disabled AI 구현을 포함한다.
