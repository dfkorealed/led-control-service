# CAD Native Map Rendering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** DWG/DXF의 한 층 영역을 편집 가능한 네이티브 CAD scene으로 변환하고 PixiJS WebGL과 Konva 오버레이로 PC·모바일 WebView에서 고성능 렌더링한다.

**Architecture:** 서버는 CAD model space를 region으로 분리하고 선택 region을 512 단위 타일과 LOD로 변환해 object storage에 압축 저장한다. 웹은 PixiJS WebGL로 CAD tile batch를 그리고 기존 Konva는 조명, 수동 도형과 현재 선택된 CAD 요소의 편집 오버레이에만 사용한다.

**Tech Stack:** NestJS, TypeScript, PostgreSQL/Prisma, S3-compatible object storage, React, PixiJS v8 WebGL, Konva, Web Worker, Vitest/Jest/Playwright

**Spec:** `docs/superpowers/specs/2026-09-18-cad-native-map-rendering-design.md`

## Global Constraints

- 모든 사용자 문구와 프로젝트 문서는 한글로 작성한다.
- 논리 맵 긴 변 기본값은 16384, 최대값은 32768이고 framebuffer는 viewport 크기로만 생성한다.
- CAD geometry를 `FloorMapObject` DB 행, DOM 또는 Konva/Pixi scene object로 1:1 펼치지 않는다.
- tile 크기는 512이며 WebGL renderer를 운영 기본값으로 사용한다.
- 기존 SVG-only floor는 하위 호환한다.
- TDD로 테스트 실패를 먼저 확인한 뒤 구현한다.
- DB 변경과 설정 메뉴 변경은 `docs/database-schema.md`, `docs/menus/settings.md`, 반복 교훈은 `docs/lesson_leared.md`에 반영한다.

---

### Task 1: 공유 scene 계약과 맵 크기 정책

**Files:**
- Create: `packages/shared/src/cad-scene-contracts.ts`
- Create: `packages/shared/src/cad-scene-contracts.test.ts`
- Modify: `packages/shared/src/index.ts`
- Modify: `packages/shared/src/cad-import-contracts.ts`

**Interfaces:**
- Produces: `cadSceneManifestSchema`, `cadSceneTileSchema`, `cadRegionSchema`, `normalizeCadMapSize(bounds)`와 import region 선택 계약.

- [ ] primitive, tile manifest, region preview와 override DTO의 실패 테스트를 작성한다.
- [ ] bounds 16:9, 세로형, 극단형에 대해 16384/1024/32768 정책의 실패 테스트를 작성한다.
- [ ] 공유 계약과 크기 정규화 함수를 구현한다.
- [ ] shared 테스트와 typecheck를 통과시킨다.
- [ ] `feat(cad): define native scene contracts`로 커밋한다.

### Task 2: DB scene 메타데이터와 migration

**Files:**
- Modify: `apps/api/prisma/schema.prisma`
- Create: `apps/api/prisma/migrations/*_add_floor_cad_scene/migration.sql`
- Modify: `docs/database-schema.md`

**Interfaces:**
- Consumes: Task 1 scene 식별자와 version 정책.
- Produces: `FloorImportRegion`, `FloorCadScene`, `FloorCadTile`, `FloorCadElementOverride`, `FloorCadLayerState` 모델, `cad` floor plan source 및 CAD asset kind와 cascade 관계.

- [ ] Prisma 모델 관계와 unique/index를 검증하는 schema 테스트를 먼저 실패시킨다.
- [ ] migration의 기존 데이터 무변경 및 cascade 테스트를 실패시킨다.
- [ ] schema와 migration을 구현하고 Prisma client를 생성한다.
- [ ] migration 테스트와 Prisma validation을 통과시킨다.
- [ ] DB 문서를 최신화하고 `feat(cad): persist native floor scenes`로 커밋한다.

### Task 3: CAD region 탐지와 정규화

**Files:**
- Create: `apps/api/src/floor-import/cad-region-detector.ts`
- Create: `apps/api/src/floor-import/cad-region-detector.spec.ts`
- Modify: `apps/api/src/floor-import/cad-viewport.ts`
- Modify: `apps/api/src/floor-import/cad-core-executor.ts`
- Modify: `apps/api/src/floor-import/cad-core-child.ts`

**Interfaces:**
- Produces: `detectCadRegions(document)`, region별 bounds/statistics와 선택 region transform.

- [ ] 멀리 떨어진 평면도·표제란·상세도를 분리하는 실패 테스트를 작성한다.
- [ ] 반복 block과 다중 entity 군집이 singleton 제거에 묻히지 않는 실패 테스트를 작성한다.
- [ ] region detector와 맵 크기 정규화를 구현한다.
- [ ] 실제 제공 DWG 변환 결과를 fixture manifest로 검증한다.
- [ ] 관련 unit/integration 테스트를 통과시키고 `feat(cad): detect import drawing regions`로 커밋한다.

### Task 4: 네이티브 primitive 변환과 tile encoder

**Files:**
- Create: `apps/api/src/floor-import/cad-scene-builder.ts`
- Create: `apps/api/src/floor-import/cad-scene-builder.spec.ts`
- Create: `apps/api/src/floor-import/cad-scene-codec.ts`
- Create: `apps/api/src/floor-import/cad-scene-codec.spec.ts`
- Modify: `apps/api/src/floor-import/cad-geometry.ts`

**Interfaces:**
- Produces: `buildCadScene(document, region, options)`, stable occurrence element ID, 512 tile/LOD binary payload와 manifest.

- [ ] LINE/POLYLINE/rectangle/triangle/circle/ellipse/arc/text 변환 실패 테스트를 작성한다.
- [ ] block occurrence ID 안정성, simplify/deduplicate와 tile 경계 중복 방지 실패 테스트를 작성한다.
- [ ] compact typed-array codec round-trip 실패 테스트를 작성한다.
- [ ] builder와 codec을 구현한다.
- [ ] 300,000 primitive benchmark fixture에서 memory/time 예산을 기록하고 `feat(cad): build tiled native scenes`로 커밋한다.

**완료 기록 (2026-09-19):** 실제 geometry가 지나는 셀만 순회하고 line/polyline은 타일 경계에서 분할한다. 비균일 변환 곡선의 적응형 오차 샘플링과 정확 극값, additive LOD, 연속 `part`, 16 MiB 단일 tile, 512 MiB scene 전체 출력, 셀당 128 part, 전역 12,288 descriptor와 manifest/tile asset ID 유일성을 강제한다. 격리한 30만 primitive 벤치마크는 약 2.2초, builder 추가 최대 RSS 약 440 MiB로 30초/512 MiB 예산을 통과했다.

### Task 5: worker persistence와 region API

**Files:**
- Modify: `apps/api/src/floor-import/floor-import-worker.service.ts`
- Modify: `apps/api/src/floor-import/floor-import.service.ts`
- Modify: `apps/api/src/floor-import/floor-import.controller.ts`
- Modify: `apps/api/src/storage/object-storage.service.ts`
- Modify: `apps/api/src/floor-import/floor-import.integration.spec.ts`

**Interfaces:**
- Consumes: Task 3 regions, Task 4 scene tiles.
- Produces: region 목록/선택 API, scene manifest/tile private content API, atomic apply와 orphan cleanup.

- [ ] 여러 region job이 선택 전 apply되지 않는 통합 실패 테스트를 작성한다.
- [ ] tenant/floor 권한, tile hash/size 검증과 범위 밖 tile 요청 실패 테스트를 작성한다.
- [ ] storage 업로드 후 DB 활성화 실패 시 cleanup tombstone 테스트를 작성한다.
- [ ] API와 worker persistence를 구현한다.
- [ ] API unit/integration 테스트를 통과시키고 `feat(cad): publish native scene tiles`로 커밋한다.

### Task 6: override 및 layer 편집 API

**Files:**
- Modify: `packages/shared/src/cad-scene-contracts.ts`
- Modify: `apps/api/src/floor-map/floor-map.controller.ts`
- Modify: `apps/api/src/floor-map/floor-map.service.ts`
- Modify: `apps/api/src/floor-map/floor-map.integration.spec.ts`

**Interfaces:**
- Produces: scene manifest 조회, element override upsert/delete와 layer visible/locked 저장 API.

- [ ] lease/revision/권한 및 존재하지 않는 element override 거부 테스트를 작성한다.
- [ ] override batch 한도와 원자적 revision 증가 테스트를 작성한다.
- [ ] API를 구현하고 editor-state/map snapshot에 scene descriptor를 추가한다.
- [ ] 관련 테스트를 통과시키고 `feat(editor): persist cad element edits`로 커밋한다.

### Task 7: PixiJS WebGL CAD renderer

**Files:**
- Modify: `apps/web/package.json`
- Create: `apps/web/src/features/cad-scene/CadSceneRenderer.ts`
- Create: `apps/web/src/features/cad-scene/cad-scene-camera.ts`
- Create: `apps/web/src/features/cad-scene/cad-scene-tile-cache.ts`
- Create: `apps/web/src/features/cad-scene/cad-scene-worker.ts`
- Create: `apps/web/src/features/cad-scene/cad-scene-renderer.test.ts`

**Interfaces:**
- Consumes: scene manifest/tile codec.
- Produces: `CadSceneRenderer.mount(canvas)`, `setCamera`, `pick`, `setSelectionExclusion`, `destroy`.

- [ ] visible tile 계산, LOD 전환, request dedupe와 LRU eviction 실패 테스트를 작성한다.
- [ ] renderer가 primitive별 Pixi display object를 생성하지 않는 구조 테스트를 작성한다.
- [ ] PixiJS를 설치하고 명시적 WebGL renderer와 batch geometry를 구현한다.
- [ ] context loss/recovery와 resolution cap을 구현한다.
- [ ] renderer unit/benchmark 테스트를 통과시키고 `feat(web): render cad scenes with webgl`로 커밋한다.

### Task 8: FloorEditor 하이브리드 통합

**Files:**
- Create: `apps/web/src/features/floor-editor/CadSceneCanvas.tsx`
- Create: `apps/web/src/features/floor-editor/CadElementOverlay.tsx`
- Modify: `apps/web/src/features/floor-editor/FloorEditorCanvas.tsx`
- Modify: `apps/web/src/features/floor-editor/editor-store.ts`
- Modify: `apps/web/src/features/floor-editor/editor-types.ts`
- Modify: `apps/web/src/features/floor-editor/FloorEditorView.tsx`

**Interfaces:**
- Consumes: Task 7 renderer, Task 6 override API.
- Produces: synchronized camera, group click/element double-click, Konva promote/edit/demote 흐름.

- [ ] Pixi와 Konva pan/zoom 좌표가 일치하는 실패 테스트를 작성한다.
- [ ] CAD group 선택, double-click element 선택과 override 저장 실패 테스트를 작성한다.
- [ ] CAD canvas를 Konva 아래에 합성하고 pointer controller를 통합한다.
- [ ] 선택 element를 Konva overlay로 승격해 이동·크기·회전·색상·숨김 편집을 구현한다.
- [ ] editor 테스트를 통과시키고 `feat(editor): edit native cad elements`로 커밋한다.

### Task 9: region 선택 및 가져오기 UI

**Files:**
- Modify: `apps/web/src/features/floor-editor/CadImportPanel.tsx`
- Modify: `apps/web/src/features/floor-editor/CadImportPanel.test.tsx`
- Modify: `apps/web/src/api/queries.ts`

**Interfaces:**
- Consumes: Task 5 region/scene API.
- Produces: region preview 선택, 변환 통계, 맵 초기화 확인과 적용 흐름.

- [ ] 단일 region 자동선택과 다중 region 필수선택 UI 실패 테스트를 작성한다.
- [ ] primitive/slot/제외 요소 수와 새 맵 크기 표시 테스트를 작성한다.
- [ ] UI를 구현하고 진행률이 region/scene 단계에서도 단조 증가하도록 연결한다.
- [ ] UI 테스트를 통과시키고 `feat(editor): select cad import regions`로 커밋한다.

### Task 10: 모니터링 및 모바일 WebView 대응

**Files:**
- Modify: `apps/web/src/features/floor-map/FloorScene.tsx`
- Modify: `apps/web/src/features/floor-map/FloorMapViewport.tsx`
- Modify: `apps/web/src/features/floor-map/FloorScene.test.tsx`
- Modify: React Native WebView shell files located during implementation

**Interfaces:**
- Produces: 모니터링 read-only CAD scene, 모바일 hardware layer/gesture/resolution 정책.

- [ ] 모니터링이 applied scene을 read-only로 표시하는 실패 테스트를 작성한다.
- [ ] WebView에서 고빈도 camera event가 native bridge로 전송되지 않는 테스트를 작성한다.
- [ ] read-only renderer와 모바일 gesture adapter를 구현한다.
- [ ] web/mobile build와 테스트를 통과시키고 `feat(map): share cad renderer across clients`로 커밋한다.

### Task 11: 실제 DWG 검증, 문서와 회귀 점검

**Files:**
- Modify: `docs/menus/settings.md`
- Modify: `docs/menus/monitoring.md`
- Modify: `docs/lesson_leared.md`
- Create: `docs/test-results/cad-native-map-2026-09-18.md`

**Interfaces:**
- Consumes: 전체 구현.
- Produces: 실제 도면 정확도와 성능 측정 결과.

- [ ] 제공된 두 DWG를 실제 pipeline으로 변환한다.
- [ ] region bounds, native primitive 수, 조명 후보 수와 변환 불가 요소 비율을 기록한다.
- [ ] 1,000 fixture를 합성해 desktop 및 mobile viewport benchmark를 실행한다.
- [ ] API/web/shared 전체 테스트, lint/typecheck/build를 실행한다.
- [ ] Playwright에서 업로드→region 선택→적용→선택/편집→새로고침→모니터링 흐름을 검증한다.
- [ ] 메뉴/교훈/테스트 결과 문서를 최신화하고 `docs(cad): record native map verification`으로 커밋한다.
