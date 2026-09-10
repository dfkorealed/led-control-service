# Monitoring Map Workspace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 모니터링 지도를 화면의 주 작업 영역으로 확대하고, 지도 이동·확대/축소 및 공통 우측 정보 패널의 overflow 안전성을 제공한다.

**Architecture:** `FloorMap`이 읽기 전용 지도 viewport와 zoom/pan 상태를 소유하고 기존 `FloorScene` renderer는 그대로 재사용한다. 공통 `SidePanel` primitive와 `ui-side-panel-layout` CSS 계약을 모니터링·제어·통계·설정 편집기에 적용한다.

**Tech Stack:** React 18, TypeScript, Vitest/Testing Library, Playwright, CSS Grid, ResizeObserver

**Spec:** `docs/superpowers/specs/2026-09-10-monitoring-map-workspace-design.md`

## Global Constraints

- 설정에서 저장한 map snapshot과 `FloorScene` renderer를 그대로 사용한다.
- 320px 이상에서 document-level horizontal overflow를 만들지 않는다.
- 조명 marker의 기존 접근성 이름과 선택 동작을 유지한다.
- API와 DB schema를 변경하지 않는다.
- 메뉴 기능 변경과 함께 영향을 받는 `docs/menus` 문서를 모두 갱신한다.
- 현재 작업은 사용자가 승인한 현재 기능 브랜치에서 수행하며 별도 커밋은 요청 전까지 만들지 않는다.

---

### Task 1: 모니터링 정보 밀도 조정

**Files:**
- Modify: `apps/web/src/features/monitoring/MonitoringView.tsx`
- Test: `apps/web/src/features/monitoring/MonitoringView.test.tsx`
- Test: `apps/web/e2e/calm-operations-monitoring.spec.ts`

**Interfaces:**
- Consumes: 기존 `MetricCard`, `floorSummary`
- Produces: KPI 3개와 지도-상세 패널의 연속 DOM 구조

- [x] **Step 1: KPI 3개와 빠른 상태 제거를 요구하는 단위/E2E 테스트를 작성한다.**
- [x] **Step 2: 테스트가 기존 평균 밝기와 빠른 상태 때문에 실패하는지 확인한다.**
- [x] **Step 3: 평균 밝기 및 빠른 상태 UI를 제거하고 선택 fallback은 기존 fixture 선택 로직으로 유지한다.**
- [x] **Step 4: 대상 단위 테스트를 통과시킨다.**

### Task 2: 읽기 전용 지도 pan/zoom viewport

**Files:**
- Modify: `apps/web/src/features/monitoring/FloorMap.tsx`
- Create: `apps/web/src/features/monitoring/FloorMap.test.tsx`
- Modify: `apps/web/src/styles.css`
- Test: `apps/web/e2e/calm-operations-monitoring.spec.ts`

**Interfaces:**
- Consumes: `FloorMapSnapshot`, `FloorScene`
- Produces: `FloorMap` 내부의 `data-zoom`, 확대/축소/화면 맞춤 버튼, `monitoring-map-viewport`

- [x] **Step 1: 버튼·휠 zoom과 drag pan의 사용자 동작 테스트를 작성한다.**
- [x] **Step 2: 조작 UI가 없어 테스트가 실패하는지 확인한다.**
- [x] **Step 3: ResizeObserver 기반 fit size와 zoom/pan 이벤트를 구현한다.**
- [x] **Step 4: 지도 단위 테스트와 극단 비율·overflow E2E를 통과시킨다.**

### Task 3: 공통 우측 정보 패널 계약

**Files:**
- Create: `apps/web/src/components/ui/SidePanel.tsx`
- Modify: `apps/web/src/components/ui/index.ts`
- Modify: `apps/web/src/components/ui/ui-primitives.test.tsx`
- Modify: `apps/web/src/features/monitoring/MonitoringView.tsx`
- Modify: `apps/web/src/features/control/ControlView.tsx`
- Modify: `apps/web/src/features/statistics/StatisticsView.tsx`
- Modify: `apps/web/src/features/floor-editor/FloorEditorView.tsx`
- Modify: `apps/web/src/styles.css`

**Interfaces:**
- Produces: `SidePanel(props: HTMLAttributes<HTMLElement>)`, `ui-side-panel`, `ui-side-panel-layout`

- [x] **Step 1: 공통 complementary landmark와 class 계약 테스트를 작성한다.**
- [x] **Step 2: export가 없어 테스트가 실패하는지 확인한다.**
- [x] **Step 3: primitive와 공통 overflow/width CSS를 구현하고 네 화면에 적용한다.**
- [x] **Step 4: 단위 테스트와 반응형 E2E를 통과시킨다.**

### Task 4: 문서 및 전체 검증

**Files:**
- Modify: `docs/menus/monitoring.md`
- Modify: `docs/menus/control.md`
- Modify: `docs/menus/statistics.md`
- Modify: `docs/menus/settings.md`

- [x] **Step 1: 네 메뉴 문서의 구현 완료·한계·관련 파일을 현재 동작으로 갱신한다.**
- [x] **Step 2: Web 단위 테스트, 타입 검사, 빌드와 관련 Playwright E2E를 실행한다.**
- [x] **Step 3: diff와 승인된 설계를 대조해 누락과 불필요한 변경을 확인한다.**
