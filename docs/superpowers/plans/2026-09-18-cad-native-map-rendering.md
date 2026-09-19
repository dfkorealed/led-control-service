# CAD Native Map Rendering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** DWG/DXF의 한 층 영역을 편집 가능한 네이티브 CAD scene으로 변환하고 PixiJS WebGL과 Konva 오버레이로 PC·모바일 WebView에서 고성능 렌더링한다.

**Architecture:** 서버는 CAD model space를 region으로 분리하고 선택 region을 512 단위 타일과 LOD로 변환해 object storage에 압축 저장한다. 웹은 PixiJS WebGL로 CAD tile batch를 그리고 기존 Konva는 조명, 수동 도형과 현재 선택된 CAD 요소의 편집 오버레이에만 사용한다.

**Tech Stack:** NestJS, TypeScript, PostgreSQL/Prisma, S3-compatible object storage, React, PixiJS v8 WebGL, Konva, Web Worker, Vitest/Jest/Playwright

**Spec:** `docs/superpowers/specs/2026-09-18-cad-native-map-rendering-design.md`

## 현재 실행 상태 (2026-09-19)

- Task 1~7: 구현·검증·커밋 완료 (`af63a8de`~`f4569975`, renderer `1a408c5b`).
- Task 8~10: 지원 범위의 구현·검증·커밋 완료. `6228e9c2` 영역 선택/API 연동, `39680539` bounded 벡터 렌더링/원본 선택, `0645984e` 편집·모니터링·WebView 통합이다.
- Task 11: 실제 두 DWG의 모든 후보 적용 2/2, 실제 타일 8개 화면, 실제 요소 편집/reload 1개, 모바일 정책 4개 화면 검증을 완료했다. API/Web 빌드와 타입 검사, 전체·집중 회귀 및 문서 갱신을 마쳤다. 실기기 WebView·원본 전체 충실도·양산 컨테이너 성능은 별도 후속 범위다.
- `f124bbf1`: 제외 영역 통계와 이동 요소 source locator migration 및 실제 PostgreSQL 업그레이드 검증 완료.
- Task 11 재현으로 Task 3 재개: 실제 두 DWG의 region OOM/공간 bucket 오류를 bounded 탐지·단일 순회 preview로 보완했고, 197/1,817개 preview 및 집중 99개 테스트를 통과했다. Native/SVG 중첩·작은 viewport fit·canvas context 재사용·늦은 camera 요청도 보정했다. `acf3b482`는 대용량 region/브라우저 계약 보완이다. 로컬 DB backup 후 CAD migration 6개 적용 및 개발 서버 실행은 사용자 승인 범위에서 완료했다.
- 최종 실제 경로 보완: 원본과 표시용 geometry 분리, 정확한 원본 선택, atlas 텍스트 폭과 context-loss 캐시 퇴출을 구현했다. Scene exact-float 저장·CAD FloorPlan 주소·영역 밖 block 원점 좌표를 수정한 `df96a8b6`에서 두 실제 pipeline 적용·재조회가 통과했고 모든 후보 1,308/2개 slot 적용을 추가 검증했다. 기존 래스터 배경으로 대체하지 않는다.

## Global Constraints

- 2026-09-19 사용자 재확인: CAD는 배경 이미지가 아니라 선택·편집 가능한 맵 요소로 표시한다. 네모·세모·선·텍스트 외에 원·타원·호·연속선을 지원하며, 배치 렌더링은 저장·그리기 최적화일 뿐 요소의 식별자·좌표·편집 가능성을 제거하지 않는다.
- 실제 제공 도면의 전체 보기에서 메모리 예산으로 중앙 일부 타일만 표시되는 회귀가 확인됐다. 확대 수준별 벡터 표현을 보완하고 전체 영역 표시와 확대 후 원본 요소 편집을 검증하기 전에는 완료로 판정하지 않는다. 래스터 배경으로 대체하거나 임의로 요소를 삭제하는 방식은 사용하지 않는다.
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

- [x] primitive, tile manifest, region preview와 override DTO의 실패 테스트를 작성한다.
- [x] bounds 16:9, 세로형, 극단형에 대해 16384/1024/32768 정책의 실패 테스트를 작성한다.
- [x] 공유 계약과 크기 정규화 함수를 구현한다.
- [x] shared 테스트와 typecheck를 통과시킨다.
- [x] `feat(cad): define native scene contracts`로 커밋한다.

### Task 2: DB scene 메타데이터와 migration

**Files:**
- Modify: `apps/api/prisma/schema.prisma`
- Create: `apps/api/prisma/migrations/*_add_floor_cad_scene/migration.sql`
- Modify: `docs/database-schema.md`

**Interfaces:**
- Consumes: Task 1 scene 식별자와 version 정책.
- Produces: `FloorImportRegion`, `FloorCadScene`, `FloorCadTile`, `FloorCadElementOverride`, `FloorCadLayerState` 모델, `cad` floor plan source 및 CAD asset kind와 cascade 관계.

- [x] Prisma 모델 관계와 unique/index를 검증하는 schema 테스트를 먼저 실패시킨다.
- [x] migration의 기존 데이터 무변경 및 cascade 테스트를 실패시킨다.
- [x] schema와 migration을 구현하고 Prisma client를 생성한다.
- [x] migration 테스트와 Prisma validation을 통과시킨다.
- [x] DB 문서를 최신화하고 `feat(cad): persist native floor scenes`로 커밋한다.

### Task 3: CAD region 탐지와 정규화

**Files:**
- Create: `apps/api/src/floor-import/cad-region-detector.ts`
- Create: `apps/api/src/floor-import/cad-region-detector.spec.ts`
- Modify: `apps/api/src/floor-import/cad-viewport.ts`
- Modify: `apps/api/src/floor-import/cad-core-executor.ts`
- Modify: `apps/api/src/floor-import/cad-core-child.ts`

**Interfaces:**
- Produces: `detectCadRegions(document)`, region별 bounds/statistics와 선택 region transform.

- [x] 멀리 떨어진 평면도·표제란·상세도를 분리하는 실패 테스트를 작성한다.
- [x] 반복 block과 다중 entity 군집이 singleton 제거에 묻히지 않는 실패 테스트를 작성한다.
- [x] region detector와 맵 크기 정규화를 구현한다.
- [x] 실제 제공 DWG 변환 결과를 fixture manifest로 검증한다.
- [x] 관련 unit/integration 테스트를 통과시키고 커밋한다(최초 `cd7d1a92`, 실제 원본 보완 `df96a8b6`).

### Task 4: 네이티브 primitive 변환과 tile encoder

**Files:**
- Create: `apps/api/src/floor-import/cad-scene-builder.ts`
- Create: `apps/api/src/floor-import/cad-scene-builder.spec.ts`
- Create: `apps/api/src/floor-import/cad-scene-codec.ts`
- Create: `apps/api/src/floor-import/cad-scene-codec.spec.ts`
- Modify: `apps/api/src/floor-import/cad-geometry.ts`

**Interfaces:**
- Produces: `buildCadScene(document, region, options)`, stable occurrence element ID, 512 tile/LOD binary payload와 manifest.

- [x] LINE/POLYLINE/rectangle/triangle/circle/ellipse/arc/text 변환 실패 테스트를 작성한다.
- [x] block occurrence ID 안정성, simplify/deduplicate와 tile 경계 중복 방지 실패 테스트를 작성한다.
- [x] compact typed-array codec round-trip 실패 테스트를 작성한다.
- [x] builder와 codec을 구현한다.
- [x] 300,000 primitive benchmark fixture에서 memory/time 예산을 기록하고 `feat(cad): build tiled native scenes`로 커밋한다.

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

- [x] 여러 region job이 선택 전 apply되지 않는 통합 실패 테스트를 작성한다.
- [x] tenant/floor 권한, tile hash/size 검증과 범위 밖 tile 요청 실패 테스트를 작성한다.
- [x] storage 업로드 후 DB 활성화 실패 시 cleanup tombstone 테스트를 작성한다.
- [x] API와 worker persistence를 구현한다.
- [x] API unit/integration 테스트를 통과시키고 `feat(cad): publish native scene tiles`로 커밋한다.

### Task 6: override 및 layer 편집 API

**Files:**
- Modify: `packages/shared/src/cad-scene-contracts.ts`
- Modify: `apps/api/src/floor-map/floor-map.controller.ts`
- Modify: `apps/api/src/floor-map/floor-map.service.ts`
- Modify: `apps/api/src/floor-map/floor-map.integration.spec.ts`

**Interfaces:**
- Produces: scene manifest 조회, element override upsert/delete와 layer visible/locked 저장 API.

- [x] lease/revision/권한 및 존재하지 않는 element override 거부 테스트를 작성한다.
- [x] override batch 한도와 원자적 revision 증가 테스트를 작성한다.
- [x] API를 구현하고 editor-state/map snapshot에 scene descriptor를 추가한다.
- [x] 관련 테스트를 통과시키고 `feat(editor): persist cad element edits`로 커밋한다.

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

- [x] visible tile 계산, LOD 전환, request dedupe와 LRU eviction 실패 테스트를 작성한다.
- [x] renderer가 primitive별 Pixi display object를 생성하지 않는 구조 테스트를 작성한다.
- [x] PixiJS를 설치하고 명시적 WebGL renderer와 batch geometry를 구현한다.
- [x] context loss/recovery와 resolution cap을 구현한다.
- [x] renderer unit/benchmark 테스트를 통과시키고 `feat(web): render cad scenes with webgl`로 커밋한다.

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
- Produces: synchronized camera, 그룹은 click/요소는 double-click, 그룹 없는 단독 요소는 single-click 선택, Konva promote/edit/demote 흐름.

- [x] Pixi와 Konva pan/zoom 좌표가 일치하는 실패 테스트를 작성한다.
- [x] CAD group 선택, double-click element 선택과 override 저장 실패 테스트를 작성한다.
- [x] CAD canvas를 Konva 아래에 합성하고 pointer controller를 통합한다.
- [x] 선택 element를 Konva overlay로 승격해 이동·크기·회전·색상·숨김 편집을 구현한다.
- [x] editor 테스트를 통과시키고 커밋한다(`0645984e`).

### Task 9: region 선택 및 가져오기 UI

**Files:**
- Modify: `apps/web/src/features/floor-editor/CadImportPanel.tsx`
- Modify: `apps/web/src/features/floor-editor/CadImportPanel.test.tsx`
- Modify: `apps/web/src/api/queries.ts`

**Interfaces:**
- Consumes: Task 5 region/scene API.
- Produces: region preview 선택, 변환 통계, 맵 초기화 확인과 적용 흐름.

- [x] 단일 region 자동선택과 다중 region 필수선택 UI 실패 테스트를 작성한다.
- [x] primitive/slot/제외 요소 수와 새 맵 크기 표시 테스트를 작성한다.
- [x] UI를 구현하고 진행률이 region/scene 단계에서도 단조 증가하도록 연결한다.
- [x] UI 테스트를 통과시키고 커밋한다(`6228e9c2`).

### Task 10: 모니터링 및 모바일 WebView 대응

**Files:**
- Modify: `apps/web/src/features/floor-map/FloorScene.tsx`
- Modify: `apps/web/src/features/floor-map/FloorMapViewport.tsx`
- Modify: `apps/web/src/features/floor-map/FloorScene.test.tsx`
- Modify: React Native WebView shell files located during implementation

**Interfaces:**
- Produces: 모니터링 read-only CAD scene, 모바일 hardware layer/gesture/resolution 정책.

- [x] 모니터링이 applied scene을 read-only로 표시하는 실패 테스트를 작성한다.
- [x] WebView에서 고빈도 camera event가 native bridge로 전송되지 않는 테스트를 작성한다.
- [x] read-only renderer와 모바일 gesture adapter를 구현한다.
- [x] Web build와 Mobile typecheck/자동 테스트를 통과시키고 커밋한다(`0645984e`). 실제 iOS/Android 바이너리 빌드·기기 WebView GPU 성능은 이 소프트웨어 검증으로 대체하지 않는다.

### Task 11: 실제 DWG 검증, 문서와 회귀 점검

**Files:**
- Modify: `docs/menus/settings.md`
- Modify: `docs/menus/monitoring.md`
- Modify: `docs/lesson_leared.md`
- Create: `docs/test-results/cad-native-map-2026-09-18.md`

**Interfaces:**
- Consumes: 전체 구현.
- Produces: 실제 도면 정확도와 성능 측정 결과.

- [x] 제공된 두 DWG를 실제 pipeline으로 변환한다.
- [x] region bounds, native primitive 수, 조명 후보 수와 변환 불가 요소 비율을 기록한다.
- [x] 1,000 fixture를 합성해 desktop 및 mobile viewport benchmark를 실행한다.
- [x] API/web/shared 전체 테스트, lint/typecheck/build를 실행한다(환경 의존 제외와 후속 집중 회귀 범위는 검증 보고서/상태판에 구분).
- [x] Playwright에서 업로드→region 선택→적용→선택/편집→새로고침→모니터링 흐름을 검증한다(합성 API/geometry 기반 Chromium, 실제 원본 pipeline과 별도).
- [x] 메뉴/교훈/테스트 결과 문서를 최신화하고 `docs(cad): record native map verification`으로 커밋한다.

### Task 12: 실제 웹 가져오기 실패 복구

- [x] 실제 실패 작업의 상태·단계·시도 횟수 확인(35%, parse, 3회).
- [x] 업로드된 원본과 실제 서버의 기본 설정을 대조한다. 새 프로세스는 1,817개 영역을 정상 반환하지만 실행 중인 API 메모리에는 과거 100개 상한이 남아 있음을 확인했다.
- [x] 실패 화면을 안전한 단계별 안내로 보완했다(`2fa9f1a3`). Web 전체 1,605개 통과/2개 opt-in 제외, 타입 검사와 집중 63개 회귀 통과.
- [x] DXF 직접 분석과 안전한 진단 분류를 추가했다(`8c15226a`). 최종 API 전체 2,163 통과/524 환경 제외/실패 0, parser/region 집중 회귀, PostgreSQL 23개 통과. 기존 자원·손상 입력 검증을 유지한다.
- [x] 최신 기본 converter/core에서 실제 두 DWG 변환·분석 2/2 통과 및 재시작된 API 메모리/디스크 코드 일치를 확인했다. 5173 응답 200, 비로그인 auth 응답 401을 확인했다.
- [ ] 실제 사용자 로그인 후 재업로드→영역 선택→적용 브라우저 검증: 내장 브라우저 로그인 대기. 이전 route fixture 결과로 대체하지 않는다. 기존 실패 이력·맵 데이터는 수정하지 않았다.
- [x] 설정 메뉴·교훈·상태판·검증 보고서를 갱신했다. 코드 작업은 위 두 커밋으로 분리했고 문서도 별도 작업 단위로 기록한다.

### Task 13: 기존 맵 교체 실패 및 후보 미리보기 확대

- [x] 실서버 기록 확인: 같은 층 첫 apply 200, 두 번째 apply 500(125ms), 두 번째 작업은 review_required 유지.
- [x] 실제 기존 맵·후보·scene 상태 대조: 동일 selected region의 두 번째 적용에서 형식 version 2를 쓰려다 SQL23514 `FloorCadScene_dimensions_check`가 실패함을 실제 PostgreSQL RED 회귀로 확인했다.
- [x] 형식 버전 보존 수정과 native→native 교체·rollback·적용 후 재조회 회귀 완료. 실제 PostgreSQL 포함 집중 56/56, API 전체 2,163 통과/527 제외/실패 0, 타입 검사 통과. DB migration/사용자 데이터 재작성 없음.
- [x] 기존 중앙 편집 화면의 후보 검토를 선택 영역 native scene 좌표로 수정하고 자동 맞춤·확대/축소·이동·후보 선택을 검증한다. 이전 맵·배치 숨김, 실패 안내/재시도, 층/영역 전환·renderer 해제를 포함한다.
- [x] 실제 PostgreSQL 집중 56개, Web 전체 1,614 통과/2 제외, Chromium route fixture 여정 2개, 타입 검사와 API/Web 빌드를 확인하고 메뉴 문서·교훈·진행 상태에 검증 범위를 구분해 기록한다.
- [ ] 별도 큰 미리보기 팝업: 사용자 설계 답변 대기. 현재 중앙 편집 화면의 큰 검토와 별개이며 팝업을 구현했다고 표시하지 않는다.
- [ ] 실제 사용자 계정의 적용→새로고침 브라우저 검증: 내장 브라우저 로그인 대기. 사용자 DB의 맵·배치를 임의 적용/초기화하지 않았다.

### 유지할 후속 한계

- 원본 DXF `ELLIPSE` 등 미지원 entity 파싱, 사람 기준 원본 재현 정확도·조명 후보 precision/recall은 별도 작업이다. Native `ellipse` 모델 지원과 입력 parser 지원을 혼동하지 않는다.
- 큰 도면 최초 전체 표시 약 10~13초를 줄일 추가 전송량 최적화, 실제 iOS/Android 기기의 GPU 성능, Linux 양산 컨테이너 실측은 이번 완료 판정에 포함하지 않는다.
- 실제 하드웨어 자동 등록은 하지 않는다. CAD 후보는 미배정 위치이고, 등록한 실제 조명을 사용자가 연결하는 정책을 유지한다.
