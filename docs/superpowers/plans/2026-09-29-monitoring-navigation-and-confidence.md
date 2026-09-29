# 모니터링 탐색·시야 개선 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. 사용자 지시에 따라 새 서브에이전트를 사용하지 않고 현재 세션에서 직접 구현한다. 기존 UI/UX 디자이너 세션만 협업한다.

**Goal:** KPI에서 조명을 찾고 지도 시야를 유지하면서 사용자용 정보만 읽을 수 있게 한다.

**Architecture:** 기존 API/cursor/snapshot/공통 renderer를 재사용한다. 카메라·배치·필터·시야 저장·상세를 작은 모듈로 분리하고 shell에는 범위가 지정된 전체 보기 context를 추가한다.

**Tech Stack:** React18, TypeScript, TanStack Query, 공통 React Aria UI, Vitest, Playwright, Node22/pnpm9.15.

**Spec:** [승인 수정 설계](../specs/2026-09-29-monitoring-navigation-and-confidence-design.md).

## Global Constraints

- 기준0a8dcd52, 작업 codex/monitoring-navigation-confidence, 별도 .worktrees/monitoring-navigation. 기본 폴더 WIP/서버 보존, 새 서브에이전트 금지.
- 상태 확인 결과 UI와 기술 정보(접기 포함)는 구현하지 않는다. 기존 수동 확인 POST/terminal/후속 조회·오류 안내는 유지한다.
- 전체 보기 아이콘만, aria-label `지도 전체 보기`/`전체 보기 종료`. 닫기 시 높이·scroll·카메라 변화0, 초점 복귀 preventScroll.
- 현장 KPI readonly, 층 KPI server summary, 필터 DTO status. saved placement 정본/legacy fallback만.
- 마커20px/밝기10단계/배지·도형·권한 유지. common opt-in 기본 false로 설정/제어 보호.
- 저장 중심0~1/배율0.1~4,30일/50개/300ms/미래5분, generation+크기 검증, storage fallback. 인증/장비/선택 상태 저장 금지.
- API/DB/firmware/운영·push 없음. 후속 사용자 지시에 따라 별도 브랜치 검증 후 `codex/mvp1-cloud-web`에 로컬 병합한다. 4너비44px/overflow0/실제 장비 HIL 별도.

## Review Focus

1. 뒤쪽 cursor에만 있는 이상 조명과 추가 조회 실패: Task2/6에 1,000대·부분 실패 사례.
2. 저장 좌표/runtime 불일치·미배치·미조회 핀: Task1/2/3에서 이동/unknown 검증.
3. 닫기 높이/초점/scroll 흔들림: Task3/6에서 모바일 실 DOM geometry 비교.
4. 전체 보기 resize와 renderer 수명·중첩 Escape: Task4/6에 canvas identity/카메라/overlay 우선.
5. 사용자·현장·generation 전환과 storage 오류: Task5/6에 범위/유효성/메모리 fallback.

---

## 승인·준비

- [x] 사용자가 시안과 상세 계획을 검토하고 네 수정사항 반영 후 즉시 구현을 승인했다.
- [x] 상태 확인 결과/기술 정보 제거로 기존 계획 Task3와 Disclosure 관련 구현을 제외했다.
- [x] native 도구의 Not a git repository를 확인하고 ignored Git fallback으로 격리 브랜치를 만들었다.
- [x] Node22 frozen install·workspace prepare·기준 Web 테스트 확인(2,595 passed/3 skipped, Prisma client generate만 수행).

### Task 1: 공통 위치·카메라 계약

**Files:** Create `apps/web/src/features/floor-map/map-camera.ts`, `map-camera.test.ts`, `fixture-map-position.ts`, `fixture-map-position.test.ts`. Modify `FloorMapViewport.tsx`, `FloorMapViewport.test.tsx`, `FloorScene.tsx`, `FloorScene.test.tsx`.

**Interfaces:** `MapViewportCamera={centerXRatio:number;centerYRatio:number;zoom:number}`. `FloorMapViewportHandle={getCamera():MapViewportCamera|null;restoreCamera(camera:MapViewportCamera):void;centerOn(point:MapPoint):void;fit():void}`. viewport optional forwarded ref, `maintainCameraOnResize?:boolean` defaultfalse, `onCameraSettled?:(camera)=>void`, `onCameraReady?:()=>void`. scene optional `onFixtureAnchorChange(id,anchor|null)`, `emphasizedFixtureIds`, `unobservedFixtureIds`. `resolveFixtureMapPosition(snapshot,fixture)` returns placed point/unplaced/unknown.

- [x] RED: saved x700/runtime20→700, unknown/invalid/unplaced no-pan, legacy fallback, center keepszoom, fitcenter.5/zoom1, resize opt-in, anchorcleanup and unknown label.
- [x] Run `pnpm --filter @led-control/web exec vitest run src/features/floor-map/map-camera.test.ts src/features/floor-map/fixture-map-position.test.ts src/features/floor-map/FloorMapViewport.test.tsx src/features/floor-map/FloorScene.test.tsx`. Expected new behavior fails.
- [x] Implement existing refs/gesture/camera publish path, clamp only actual scroll, normalized full-viewport center, opt-in resize retain.
- [x] GREEN same tests plus `src/features/floor-map/map-gestures.test.ts`, Web typecheck. Expected exit0.
- [ ] Update monitoring docs and commit `feat(web): add reusable monitoring map camera contracts`.

### Task 2: KPI 필터·조명 위치 탐색

**Files:** Create `features/monitoring/monitoring-fixture-filter.ts/.test.ts`, `components/ui/MetricContent.tsx`, `MetricButton.tsx/.test.tsx`. Modify `MetricCard.tsx`, UI index, `MonitoringSummary.tsx/.test.tsx`, `MonitoringFixtureFinder.tsx/.test.tsx`, `FloorMap.tsx/.test.tsx`, `MonitoringView.tsx/.test.tsx`.

**Interfaces:** `MonitoringFixtureFilter="all"|"online"|"fault"|"offline"|"unplaced"`; `matchesMonitoringFixture(fixture,filter,placement):boolean`. Summary optional filter/onSelect; site ignorescallback. Finder optional controlledfilter/onFilterChange/defaultOpen and snapshot placement, nextPageError. `FloorMap.focusRequest?:{requestId:number;fixtureId:string}`, `onFocusResult?(id,result:"focused"|"unplaced"|"unknown")`.

- [x] RED: floor KPI opens filtered list/site readonly/0valid/null disabled; fault status+commandfailed still fault; snapshot placement; next-page failure stops automatic loop; empty result waits; repeat select requests focus.
- [x] Run `pnpm --filter @led-control/web exec vitest run src/features/monitoring/monitoring-fixture-filter.test.ts src/components/ui/MetricButton.test.tsx src/features/monitoring/MonitoringSummary.test.tsx src/features/monitoring/MonitoringFixtureFinder.test.tsx src/features/monitoring/FloorMap.test.tsx src/features/monitoring/MonitoringView.test.tsx`. Expected new cases fail.
- [x] Implement single View filter/scope state, loaded DTO status emphasis, dimnonmatching pins remainselectable; placed row close→camera+anchor→pin; unplaced staysdetail; no-count overwrite and partial/retry cues.
- [x] GREEN 집중 unit/typecheck 및 Chromium의1,000대 모니터링 렌더·cursor·10분 경계가 통과했다. 같은 파일의 설정 편집기8초 성능 검사 실패는 Task6 미해결 항목으로 남긴다.
- [ ] Update docs and commit `feat(web): connect monitoring KPIs and map navigation`.

### Task 3: 사용자용 조명 정보·안정적인 닫기

**Files:** Create `features/monitoring/FixtureDetailPanel.tsx/.test.tsx`, `FixturePinPopover.test.tsx`. Modify `FixturePinPopover.tsx`, `FloorMap.tsx/.test.tsx`, `MonitoringView.tsx/.test.tsx`, new `e2e/monitoring-navigation-confidence.spec.ts`.

**Interfaces:** `FixtureDetailPanel({fixture:DashboardFixture|null,position:ReturnType<resolveFixtureMapPosition>,timeZone:string})`; no technical fields. Pin props `onShowDetails?`, status presentation fromrealfixture, closes through existing onOpenChange. `FloorMap.onPinOpenChange?(open:boolean)` for overlay priority.

- [x] 디자이너 시안에서 높이 변경→문서 scroll clamp→카메라 재계산을 재현했다. 제품의 동일 원인을 확정했다고 주장하지 않고 실제 제품 close geometry/focus 회귀로 계약을 검증했다.
- [x] RED: popup name/status/actualbrightness/time/recommendation/detail; no technical fields; unknown notfake0%; close usespreventScroll, keepsmap/camera/bodygeometry; offline recentbrightness.
- [x] Run `pnpm --filter @led-control/web exec vitest run src/features/monitoring/FixtureDetailPanel.test.tsx src/features/monitoring/FixturePinPopover.test.tsx src/features/monitoring/FloorMap.test.tsx src/features/monitoring/MonitoringView.test.tsx`; run new Playwright spec with Task2 command pattern. Expected regression fails.
- [x] Implement shared presentFixtureStatus/brightness/time, replace largeViewdetail, no technical primitive/results. Stable height across open/close; usecommonPopover collision placement and preventScroll focus only.
- [x] GREEN same tests and new Playwright mobile close-scroll cases, expected exit0.
- [ ] Update docs/lesson and commit `fix(web): simplify fixture information and prevent close jitter`.

### Task 4: 아이콘 전용 전체 보기

**Files:** Create `components/ui/workspace-focus/WorkspaceFocusProvider.tsx/.test.tsx`. Modify UI index, `CustomerShell.tsx`, `CustomerShell.monitoring.test.tsx`, MonitoringView/FloorMap and theirtests.

**Interfaces:** provider optional sharedcontext scopekey principal/site/route; hook `{active,enter(returnFocusElement),exit()}` with no-op fallback for isolatedView. Same shell and map hierarchy; CSS hideschrome, no mapportal/navigation. View owns drawer/pin flags and local Escape handler.

- [x] RED: iconaccessible names/no visible집중, samecanvas/zoom/selection, requiredtools, Escapeoverlayfirst, returnfocus preventScroll, site/route/user reset.
- [x] Run `pnpm --filter @led-control/web exec vitest run src/components/ui/workspace-focus/WorkspaceFocusProvider.test.tsx src/features/shells/CustomerShell.monitoring.test.tsx src/features/monitoring/MonitoringView.test.tsx`. Expected missingcontext/action fails.
- [x] Implement shell scopedprovider and additive conditionalclasses; preserve DOM/key/renderer, local Escape/event.defaultPrevented and overlay flags.
- [x] GREEN same tests/typecheck/new E2E at4widths, expectedexit0.
- [ ] Update docs and commit `feat(web): add icon-only monitoring full view`.

### Task 5: 범위별 카메라 기억

**Files:** Create `features/monitoring/monitoring-camera-storage.ts/.test.ts`, `useMonitoringCameraMemory.ts/.test.tsx`. Modify FloorMap/View andtests.

**Interfaces:** `MonitoringCameraScope={principal,siteId,floorId}`; `monitoringMapIdentity(snapshot):string`; store `load(scope,identity,now):MapViewportCamera|null`, `save(scope,identity,camera,now):void`, `clearMemory():void`; hook consumes scope/snapshot/viewportRef and returns onCameraSettled/onCameraReady. Restore once measured per scope/identity, flush oldscope before switch, never save initial default before restore.

- [x] RED: B1/B2 andprincipal/site isolation, generationreset/revisionpreserve, legacyrevisionreset, JSON/NaN/invalidrange/expiry/future, storage throwmemoryfallback/50LRU/300debounce/StrictMode.
- [x] Run `pnpm --filter @led-control/web exec vitest run src/features/monitoring/monitoring-camera-storage.test.ts src/features/monitoring/useMonitoringCameraMemory.test.tsx src/features/monitoring/FloorMap.test.tsx`. Expected missingstorage behavior fails.
- [x] Implement small validatedrecords/noauth ordevicedata, namespace/TTL/eviction, scopedmemo+debounced writes, readycallback restorebefore save, mapgeneration fit.
- [x] GREEN 저장소·hook의 범위/세대/크기/예외/StrictMode unit과 브라우저 reload 복원이 통과했다. 사용자·현장 전환은 unit 검증이며 모든 전환을 실브라우저로 확인했다고 확대하지 않는다.
- [ ] Update docs and commit `feat(web): remember scoped monitoring map views`.

### Task 6: 통합 검증·문서·자기 검토

**Files:** new E2E spec plus existingcalmoperations/monitoringcontrol/1000 regressions, menusmonitoring/status/lesson/plan.

- [x] Add RED integration assertions for excludedresults/technical,4widthscroll0,1000lastpage,canvasidentity,keyboard,scopereload.
- [ ] GREEN `E2E_WEB_PORT=15371 pnpm --filter @led-control/web exec playwright test e2e/monitoring-navigation-confidence.spec.ts e2e/calm-operations-monitoring.spec.ts e2e/monitoring-control-flow.spec.ts e2e/monitoring-1000.spec.ts --project=chromium --workers=1`.
- [x] Node22 canonicalroot sequential `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`; `pnpm --filter @led-control/web ui:check`/`test:ui-policy`; record exact exit/count/warnings.
- [x] Existingdesigner session compares implemented4width screenshots. No newreviewer subagent due user prohibition; separate wholebranch authorreview, discloseweakerreview, record findings andTDDfixes.
- [ ] Sync menus/status/checklist; `git diff --check`; commit `test(web): verify monitoring navigation and stable overlays`.
- [ ] 별도 브랜치 검증 결과와 남은 HIL을 기록하고, 승인된 `codex/mvp1-cloud-web` 로컬 병합·병합 후 검증을 수행한다. push·배포는 하지 않는다.

## 실행 증거·미해결 항목 (2026-09-30)

- Tasks1–5는 FloorMap/View 계약이 겹쳐 각 RED를 확인한 뒤 한 구현 커밋으로 연결한다. 작업 시작 helper는 Task1에서 실행했으며 Task2–5의 시작 기록을 사후 생성하지 않는다. 세부 증거는 ignored `.superpowers/sdd/2026-09-29-monitoring-navigation-and-confidence/progress.md`에 보존한다.
- 작성자 전체 브랜치 검토: 범위/카메라 ready·StrictMode cleanup, pagination 오류 재요청, 저장 위치/미관측 상태, 실제 장치 새로고침 유지, overlay focus/scroll와 renderer 수명을 확인했다. ready release와 완전 조회/집계 차이 안내를 RED→GREEN으로 보완했다. 독립 코드 리뷰 에이전트는 사용자의 금지에 따라 실행하지 않았다.
- 최종 Node22/pnpm9.15 root lint/typecheck/test/build 모두 exit0. Root149/4skip·Shared411·Automation28·Mobile6·Web2626/3skip·API2963/827skip·Gateway1409·UI 정책65/65·위반0/0. Web main878.04kB chunk 경고와 환경 opt-in 제외를 유지한다.
- 최종 Chromium83건: **82 passed / 1 failed, exit1**. 새 탐색·시야 spec8건, 기존 수동/자동 갱신·제어 회귀 및1,000대 모니터링은 통과했다. 1440/1024/390/320px PNG를 기존 `UI/UX 디자이너` 세션에서 직접 검토했고320px 팝업 잘림 지적은 수정 확인됐다. 원시 ISO 갱신 문구 밀도(P3)는 후속 후보다.
- 실패는1,000대 설정 편집기의 기존8초 readiness 기준이며 약22초로 재현됐다. 모니터링 fake clock과 분리한 실제 frame context, 카메라 투영 입력, 기존 CustomerShell 비교에서도 남았다. 기준 shell 비교만으로 전체 base 브랜치가 같은 성능이라고 단정하거나 지연 원인을 확정하지 않는다. timeout/성능 기준 완화·skip·설정 제품 코드 변경은 하지 않았다.
- 사용자에게 이 실패만 별도 후속으로 남겨 UI를 병합할지, 설정 편집기 성능까지 해결할지 질문했고 답변 대기다. 메인은 변경하지 않는다. HIL/운영/DB/push/서버 재시작은 수행하지 않았다.
