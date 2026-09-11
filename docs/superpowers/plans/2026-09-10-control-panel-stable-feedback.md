# Control Panel Stable Feedback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 조명 선택과 조건부 메시지 표시가 우측 제어 카드의 배지·핵심 입력을 자르거나 밀지 않도록 안정화한다.

**Architecture:** `ControlView`의 조건부 상태 출력을 하나의 상시 렌더링 피드백 영역으로 묶는다. PC 2열 레이아웃에서는 카드 자체가 아니라 제어 본문과 피드백 영역이 각각 내부 스크롤을 맡고, 대상 헤더와 피드백 슬롯은 고정된 그리드 행으로 유지한다.

**Tech Stack:** React 18, TypeScript, CSS Grid, Playwright, Vitest

**Spec:** `docs/superpowers/specs/2026-09-10-control-panel-stable-feedback.md`

## Global Constraints

- PC 제어 페이지는 전체 문서 세로 스크롤을 만들지 않는다.
- 상태 배지, 핵심 입력과 조건부 피드백은 우측 카드 경계를 벗어나지 않는다.
- 조건부 문구가 나타나도 밝기, 프리셋, override 시간과 적용 버튼 위치를 유지한다.
- 제어 메뉴 변경 사항은 `docs/menus/control.md`에 기록한다.

---

### Task 1: 우측 제어 카드의 안정적인 피드백 슬롯

**Files:**
- Modify: `apps/web/e2e/calm-operations-manual-control.spec.ts`
- Modify: `apps/web/src/features/control/ControlView.tsx`
- Modify: `apps/web/src/styles.css`
- Modify: `docs/menus/control.md`

**Interfaces:**
- Consumes: 기존 `.control-panel`, `.panel-title-row`, `.command-status-region`과 수동 제어 선택 상태
- Produces: `.control-panel-feedback` 상시 영역과 PC 카드 경계·위치 안정성 브라우저 계약

- [x] **Step 1: 실패하는 브라우저 회귀 테스트 작성**

  1440x900, 1121x900과 1366x768에서 선택 전후 `.dial-card`, `.preset-row`, `.control-override-field`, 적용 버튼의 `getBoundingClientRect()`를 비교한다. 긴 이름의 제어 불가 조명을 선택한 뒤 상태 배지와 차단 사유의 사각형이 `.control-panel` 내부에 있고 문서 높이가 viewport를 넘지 않는지 literal 기준으로 검증한다.

- [x] **Step 2: RED 확인**

  Run: `pnpm exec playwright test calm-operations-manual-control.spec.ts --grep 'PC 수동 제어 카드는 선택 피드백이 추가되어도 핵심 UI를 고정한다'`

  Expected: 기존 조건부 차단 사유가 카드의 일반 흐름에 추가되어 핵심 UI 위치 또는 경계 검증이 실패한다.

- [x] **Step 3: 최소 구현**

  `ControlView.tsx`에서 차단 사유와 명령 상태·오류를 상시 렌더링되는 `.control-panel-feedback`으로 묶는다. `styles.css`에서 PC 2열 카드의 명시적 그리드 행, 헤더/배지의 shrink 방지, 피드백 영역의 `minmax(0, 1fr)` 및 내부 스크롤을 적용하고 카드 자체의 스크롤 책임을 제거한다.

- [x] **Step 4: GREEN 및 관련 회귀 확인**

  Run: `pnpm exec playwright test calm-operations-manual-control.spec.ts --grep 'PC 수동 제어 카드는 선택 피드백이 추가되어도 핵심 UI를 고정한다'`

  Expected: 3 passed.

  Run: `pnpm --filter @led-control/web test`

  Expected: 모든 Web unit test 통과.

- [x] **Step 5: 메뉴 문서 갱신**

  `docs/menus/control.md`의 구현 완료에 PC 우측 제어 카드 고정 헤더·피드백 슬롯·무문서스크롤 브라우저 검증을 기록하고 관련 파일 목록을 최신화한다.

- [x] **Step 6: 전체 Web 검증**

  Run: `pnpm --filter @led-control/web typecheck`

  Run: `pnpm --filter @led-control/web build`

  Run: `pnpm exec playwright test calm-operations-manual-control.spec.ts monitoring-control-flow.spec.ts`

  Expected: typecheck/build 성공, 관련 Chromium E2E 전체 통과.

  Result: typecheck/build, Web unit 516개와 수동 제어 Chromium E2E 19개가 통과했다. 함께 실행한 `monitoring-control-flow.spec.ts`는 30개 중 이번 제어 변경과 관련된 28개가 통과했고, 등록 다이얼로그를 찾지 못하는 기존 모니터링 등록 테스트 2개가 단독 재실행에서도 실패했다.

- [x] **Step 7: 커밋**

  ```bash
  git add apps/web/e2e/calm-operations-manual-control.spec.ts apps/web/src/features/control/ControlView.tsx apps/web/src/styles.css docs/menus/control.md docs/superpowers/specs/2026-09-10-control-panel-stable-feedback.md docs/superpowers/plans/2026-09-10-control-panel-stable-feedback.md
  git commit -m "fix(web): stabilize manual control feedback layout"
  ```
