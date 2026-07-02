# UI Design Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the approved A+B hybrid UI direction for the LED control service web app with responsive web, mobile, and tablet layouts.

**Architecture:** Keep the existing Vite React app and navigation store. Add focused presentation helpers inside existing feature files, then replace the global stylesheet with reusable design tokens and responsive layout rules.

**Tech Stack:** React, TypeScript, Vite, React Query, Zustand, Vitest, Testing Library, Playwright, CSS.

---

## File Structure

- Modify: `apps/web/src/App.test.tsx` - verify shell-level design landmarks.
- Modify: `apps/web/src/features/monitoring/FloorMap.test.tsx` - verify accessible floor map status labels.
- Modify: `apps/web/src/App.tsx` - add top bar, site context, mobile/tablet friendly shell structure.
- Modify: `apps/web/src/features/monitoring/MonitoringView.tsx` - add KPI cards, map/detail split, device status panel.
- Modify: `apps/web/src/features/monitoring/FloorMap.tsx` - add status labels, brightness bars, selected-friendly markup.
- Modify: `apps/web/src/features/control/ControlView.tsx` - add target cards, group context, SmartThings-style control panel.
- Modify: `apps/web/src/features/statistics/StatisticsView.tsx` - add energy summary cards and visual bar chart.
- Modify: `apps/web/src/features/settings/SettingsView.tsx` - add structured settings menu cards.
- Modify: `apps/web/src/features/rf/RfPlanningPanel.tsx` - align RF panel with final design language.
- Modify: `apps/web/src/styles.css` - implement design tokens, desktop shell, mobile bottom tabs, tablet map/detail layout.

## Task 1: Shell and Monitoring Design Landmarks

**Files:**
- Modify: `apps/web/src/App.test.tsx`
- Modify: `apps/web/src/features/monitoring/FloorMap.test.tsx`
- Modify: `apps/web/src/App.tsx`
- Modify: `apps/web/src/features/monitoring/MonitoringView.tsx`
- Modify: `apps/web/src/features/monitoring/FloorMap.tsx`
- Modify: `apps/web/src/styles.css`

- [ ] **Step 1: Write failing tests**

Add assertions that expect the shell to expose `관제 센터`, `B2 운영 현황`, and `상세 패널`. Add a floor map assertion for accessible fixture status text `B2-L01 online 70%`.

- [ ] **Step 2: Run tests to verify failure**

Run: `pnpm --filter @led-control/web test -- App.test.tsx FloorMap.test.tsx`

Expected: FAIL because the new design labels are not rendered yet.

- [ ] **Step 3: Implement shell, monitoring, and floor map**

Add a branded top bar, monitoring KPI grid, map/detail layout, and accessible fixture buttons.

- [ ] **Step 4: Run tests to verify pass**

Run: `pnpm --filter @led-control/web test -- App.test.tsx FloorMap.test.tsx`

Expected: PASS.

## Task 2: Control, Statistics, Settings Screens

**Files:**
- Modify: `apps/web/src/App.test.tsx`
- Modify: `apps/web/src/features/control/ControlView.tsx`
- Modify: `apps/web/src/features/statistics/StatisticsView.tsx`
- Modify: `apps/web/src/features/settings/SettingsView.tsx`
- Modify: `apps/web/src/features/rf/RfPlanningPanel.tsx`
- Modify: `apps/web/src/styles.css`

- [ ] **Step 1: Write failing tests**

Add navigation assertions for `빠른 밝기 제어`, `에너지 리포트`, and `운영 설정`.

- [ ] **Step 2: Run tests to verify failure**

Run: `pnpm --filter @led-control/web test -- App.test.tsx`

Expected: FAIL because the redesigned section headings are not rendered yet.

- [ ] **Step 3: Implement redesigned menu screens**

Update control, statistics, settings, and RF panels with final design components.

- [ ] **Step 4: Run tests to verify pass**

Run: `pnpm --filter @led-control/web test -- App.test.tsx`

Expected: PASS.

## Task 3: Responsive Verification

**Files:**
- Modify: `apps/web/e2e/mvp1.spec.ts`
- Modify: `apps/web/src/styles.css`

- [ ] **Step 1: Update Playwright expectations**

Expect the redesigned labels to appear while preserving original navigation behavior.

- [ ] **Step 2: Run unit tests**

Run: `pnpm --filter @led-control/web test`

Expected: PASS.

- [ ] **Step 3: Run typecheck**

Run: `pnpm --filter @led-control/web typecheck`

Expected: PASS.

- [ ] **Step 4: Run Playwright smoke test**

Run: `pnpm --filter @led-control/web exec playwright test`

Expected: PASS.

- [ ] **Step 5: Commit**

Run:

```bash
git add docs/superpowers/plans/2026-07-02-ui-design-implementation.md apps/web
git commit -m "feat(web): implement approved control UI design"
```
