# Monitoring Map Objects Visibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 설정 맵 편집기에서 저장한 도형이 모니터링 지도에서도 실제 화면 높이와 색상을 유지하며 표시되도록 수정한다.

**Architecture:** 편집기와 모니터링은 기존 공통 `FloorMapObjectNode` 렌더러를 유지한다. 모니터링의 절대 배치된 Konva 컨테이너가 percentage-height chain에서 0px로 축소되는 CSS만 바로잡고, 데이터 존재가 아니라 최종 브라우저 레이아웃과 픽셀을 검증하는 E2E로 회귀를 차단한다.

**Tech Stack:** React 18, TypeScript, react-konva/Konva, CSS, Playwright

**Spec:** 2026-09-11 현재 작업의 사용자 버그 보고

## Global Constraints

- 기능 작업은 `codex/fix-monitoring-map-objects` 격리 브랜치에서 수행한 뒤 `codex/mvp1-cloud-web`에 병합한다.
- 공통 도형 렌더러를 중복 구현하지 않는다.
- 다른 작업자가 수정 중인 메인 작업공간의 변경은 보존한다.
- `docs/menus/monitoring.md`, `docs/menus/settings.md`, `docs/project-status.md`를 실제 구현 상태와 일치시킨다.

---

### Task 1: Make saved map objects visible in monitoring

**Files:**
- Modify: `apps/web/e2e/settings-floor-editor.spec.ts`
- Modify: `apps/web/src/styles.css`
- Modify: `docs/menus/monitoring.md`
- Modify: `docs/menus/settings.md`
- Modify: `docs/project-status.md`

**Interfaces:**
- Consumes: `FloorScene({ snapshot, fixtures, interactive })` and the shared `FloorMapObjectNode`
- Produces: a non-zero `.floor-scene-canvas`/Konva wrapper visual box that matches the monitoring map bounds

- [x] **Step 1: Strengthen the failing browser regression**

Update the existing “a map object saved in settings is rendered immediately in monitoring” test to assert that `.floor-scene-canvas`, `.konvajs-content`, and its canvas all have positive heights matching the floor map, and sample hand-derived RGB values from rectangle, triangle, line, and text pixels rather than alpha-only existence checks.

- [x] **Step 2: Run the focused Playwright test and verify RED**

Run: `pnpm --filter @led-control/web exec playwright test settings-floor-editor.spec.ts --project=chromium --grep "a map object saved"`

Expected: FAIL because the Konva wrapper/canvas has a `0px` rendered height even though its 1200x800 backing store contains the shapes.

- [x] **Step 3: Apply the minimal CSS layout fix**

Give the shared scene and its Konva container an explicit `width: 100%` and `height: 100%` sizing chain within the already-sized `.floor-map`. Keep `FloorScene` and `FloorMapObjectNode` shared; do not add a second renderer or alter stored coordinates.

- [x] **Step 4: Run the focused test and verify GREEN**

Run the same focused Playwright command and require all layout and four shape-color assertions to pass.

- [x] **Step 5: Update menu and project documentation**

Record that saved settings objects are rendered through the shared scene and that browser regression coverage validates the final composed height/pixels. Preserve explicit limitations for mock-only and hardware-unverified behavior.

- [x] **Step 6: Run proportional regression verification**

Run Web unit tests, TypeScript/production build, the monitoring Playwright suites, and `git diff --check`. Confirm the isolated worktree is clean after committing.

- [x] **Step 7: Commit**

Commit the implementation and verification documentation with a focused bug-fix message.
