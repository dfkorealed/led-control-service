# 층별 도면 에디터 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 모니터링 페이지에 전체 화면 도면 에디터를 추가해 층별 도면 배경, 도형, 텍스트, LED 조명 위치와 기본 정보를 수정할 수 있게 한다.

**Architecture:** 기존 읽기 전용 `FloorMap`은 유지하고, 편집 모드는 `FloorEditorView`와 Canvas 기반 `react-konva` 컴포넌트로 분리한다. DB는 `FloorPlan`을 확장하고 `FloorMapObject`를 추가해 도면 배경, 조명 좌표, 도형 객체를 분리 저장한다.

**Tech Stack:** React, TypeScript, React Query, Zustand, Konva, react-konva, pdfjs-dist, NestJS, Prisma, PostgreSQL, Jest, Vitest.

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
