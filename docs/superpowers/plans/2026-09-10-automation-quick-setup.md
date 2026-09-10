# Automation Quick Setup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 스케줄·차량 이벤트 설정을 빠른 프리셋, 선택 요약 카드, 접힌 고급 설정과 전용 대상 선택 화면으로 단순화한다.

**Architecture:** 기존 form value와 API 변환 함수는 계약 경계로 유지한다. 두 dialog가 공유하는 표시 컴포넌트와 target 요약 함수를 automation 폴더에 추가하고, 긴 `ControlTargetPicker`는 dialog의 별도 view에서만 렌더링한다. CSS는 기본 설정 화면과 picker 화면의 높이를 분리해 PC body overflow와 선택 설명에 의한 layout shift를 방지한다.

**Tech Stack:** React 18, TypeScript, Vitest, Testing Library, Playwright, CSS

**Spec:** `docs/superpowers/specs/2026-09-10-automation-quick-setup-design.md`

## Global Constraints

- 기존 schedule 및 vehicle-event API payload와 검증 범위를 변경하지 않는다.
- 공통 버튼은 기존 `Button`을 사용하고 새 재사용 요소는 `automation/components`에 둔다.
- 1440×900 PC viewport에서 기본 dialog가 viewport 안에 들어오며 body 스크롤을 만들지 않는다.
- 대상 목록은 전용 picker view에서만 스크롤한다.
- `docs/menus/control.md`를 같은 변경에서 갱신한다.

---

### Task 1: 빠른 설정 도메인 표현과 기본값

**Files:**
- Modify: `apps/web/src/features/control/automation/schedule-form.ts`
- Modify: `apps/web/src/features/control/automation/schedule-form.test.ts`
- Create: `apps/web/src/features/control/automation/automation-presenters.ts`
- Create: `apps/web/src/features/control/automation/automation-presenters.test.ts`

**Interfaces:**
- Produces: `schedulePreset(values)`, `applySchedulePreset(values, preset)`, `scheduleSummary(values, dashboard)`, `vehicleEventSummary(values, dashboard)`, `controlSelectionSummary(selection, dashboard)`.

- [x] **Step 1: Write failing tests for default name, preset mapping and literal summaries**

```ts
expect(createEmptyScheduleForm("Asia/Seoul", now).name).toBe("조명 스케줄");
expect(applySchedulePreset(values, "weekday")).toMatchObject({ recurrenceKind: "weekly", weeklyDays: [1, 2, 3, 4, 5] });
expect(scheduleSummary(values, dashboard)).toContain("매일 18:00–23:00");
expect(vehicleEventSummary(eventValues, dashboard)).toContain("차량 감지 → B1-L001");
```

- [x] **Step 2: Run tests and verify they fail for missing quick-setup behavior**

Run: `pnpm exec vitest run src/features/control/automation/schedule-form.test.ts src/features/control/automation/automation-presenters.test.ts`

- [x] **Step 3: Implement minimal pure helpers and non-empty schedule default name**

```ts
export type SchedulePreset = "daily" | "weekday" | "weekend" | "once";
export function applySchedulePreset(values: ScheduleFormValues, preset: SchedulePreset): Partial<ScheduleFormValues>;
export function controlSelectionSummary(selection: ControlSelection, dashboard: Dashboard): SelectionSummary;
```

- [x] **Step 4: Run tests and verify they pass**

Run: `pnpm exec vitest run src/features/control/automation/schedule-form.test.ts src/features/control/automation/automation-presenters.test.ts`

### Task 2: 공통 빠른 설정 컴포넌트

**Files:**
- Create: `apps/web/src/features/control/automation/components/AutomationQuickFields.tsx`
- Create: `apps/web/src/features/control/automation/components/AutomationQuickFields.test.tsx`
- Modify: `apps/web/src/styles.css`

**Interfaces:**
- Produces: `AutomationPresetGroup`, `AutomationSelectionCard`, `AutomationAdvancedSection`, `AutomationSummaryBar`, `AutomationTargetPickerView`.
- Consumes: existing `Button`, `ControlTargetPicker`, `useDialogFocus` contracts.

- [x] **Step 1: Write failing interaction and accessibility tests**

```tsx
expect(screen.getByRole("button", { name: "평일" })).toHaveAttribute("aria-pressed", "true");
fireEvent.click(screen.getByRole("button", { name: "세부 일정 설정" }));
expect(screen.getByRole("region", { name: "세부 일정 설정" })).toBeVisible();
expect(screen.getByText("2개 조명")).toBeInTheDocument();
```

- [x] **Step 2: Run component tests and verify missing exports fail**

Run: `pnpm exec vitest run src/features/control/automation/components/AutomationQuickFields.test.tsx`

- [x] **Step 3: Implement the shared components using the existing Button component**

```tsx
<Button type="button" variant="secondary" aria-pressed={selected} onClick={onSelect}>{label}</Button>
```

- [x] **Step 4: Add bounded description and picker-list layout styles**

```css
.automation-selection-copy small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.automation-picker-view .control-target-list { max-height: min(52vh, 460px); }
```

- [x] **Step 5: Run component tests and verify they pass**

Run: `pnpm exec vitest run src/features/control/automation/components/AutomationQuickFields.test.tsx`

### Task 3: 스케줄 dialog 전환

**Files:**
- Modify: `apps/web/src/features/control/automation/ScheduleDialog.tsx`
- Modify: `apps/web/src/features/control/automation/ScheduleControlPanel.test.tsx`
- Modify: `apps/web/src/styles.css`

**Interfaces:**
- Consumes: Task 1 presenter helpers and Task 2 common components.
- Produces: quick schedule editor with `main | target` internal views.

- [x] **Step 1: Replace the old section expectations with failing quick-flow tests**

```ts
expect(within(dialog).getByRole("group", { name: "언제 켤까요?" })).toBeVisible();
expect(within(dialog).queryByLabelText("스케줄 이름")).not.toBeInTheDocument();
fireEvent.click(within(dialog).getByRole("button", { name: "평일" }));
expect(within(dialog).getByText(/평일 18:00–23:00/)).toBeVisible();
fireEvent.click(within(dialog).getByRole("button", { name: "대상 선택" }));
expect(within(dialog).getByRole("group", { name: "조명 목록" })).toBeVisible();
```

- [x] **Step 2: Run the schedule panel test and verify the new assertions fail**

Run: `pnpm exec vitest run src/features/control/automation/ScheduleControlPanel.test.tsx`

- [x] **Step 3: Implement quick sections, advanced disclosure, summary and picker view**

```tsx
const [view, setView] = useState<"main" | "target">("main");
const [advancedOpen, setAdvancedOpen] = useState(false);
```

When validation finds a name/date/recurrence error, set `advancedOpen` before focusing. When it finds a target error, switch to `target` and focus the target fieldset after render.

- [x] **Step 4: Update changed focus tests while preserving create/edit payload assertions**

Run: `pnpm exec vitest run src/features/control/automation/ScheduleControlPanel.test.tsx src/features/control/automation/schedule-form.test.ts`

- [x] **Step 5: Refactor duplicated markup and keep the tests green**

Run: `pnpm exec vitest run src/features/control/automation/ScheduleControlPanel.test.tsx`

### Task 4: 차량 이벤트 dialog 전환

**Files:**
- Modify: `apps/web/src/features/control/automation/VehicleEventDialog.tsx`
- Modify: `apps/web/src/features/control/automation/VehicleEventControlPanel.test.tsx`
- Modify: `apps/web/src/styles.css`

**Interfaces:**
- Consumes: Task 1 presenter helpers and Task 2 common components.
- Produces: quick event editor with `main | source | target` internal views.

- [x] **Step 1: Write failing quick-flow tests for source, target and action presets**

```ts
expect(within(dialog).getByText("감지 센서를 선택해 주세요.")).toBeVisible();
fireEvent.click(within(dialog).getByRole("button", { name: "감지 센서 선택" }));
expect(within(dialog).queryByLabelText("B1-L001 선택")).not.toBeInTheDocument();
fireEvent.click(within(dialog).getByLabelText("B1-SENSOR-001 선택"));
fireEvent.click(within(dialog).getByRole("button", { name: "선택 완료" }));
expect(within(dialog).getByText(/B1-SENSOR-001 감지/)).toBeVisible();
```

- [x] **Step 2: Run the event panel test and verify the new assertions fail**

Run: `pnpm exec vitest run src/features/control/automation/VehicleEventControlPanel.test.tsx`

- [x] **Step 3: Implement summary cards, dedicated picker views, brightness and hold presets**

```tsx
const [view, setView] = useState<"main" | "source" | "target">("main");
const holdPreset = ["30", "60", "300"].includes(values.holdSeconds) ? values.holdSeconds : "custom";
```

- [x] **Step 4: Preserve capability filtering, validation focus and create/edit payload tests**

Run: `pnpm exec vitest run src/features/control/automation/VehicleEventControlPanel.test.tsx src/features/control/automation/vehicle-event-form.test.ts`

### Task 5: Layout E2E and menu documentation

**Files:**
- Modify: `apps/web/e2e/calm-operations-automation.spec.ts`
- Modify: `docs/menus/control.md`
- Modify: `docs/superpowers/plans/2026-09-10-automation-quick-setup.md`

**Interfaces:**
- Consumes: completed schedule/event quick dialogs.
- Produces: viewport regression coverage and current control-menu documentation.

- [x] **Step 1: Update E2E assertions for quick sections and picker views**

```ts
await expect(scheduleDialog.getByRole("group", { name: "언제 켤까요?" })).toBeVisible();
await scheduleDialog.getByRole("button", { name: "대상 선택" }).click();
await expect(scheduleDialog.getByRole("group", { name: "조명 목록" })).toBeVisible();
await expectDialogInsideViewport(scheduleDialog, viewport);
```

- [x] **Step 2: Run the four-viewport Chromium test**

Run: `pnpm exec playwright test e2e/calm-operations-automation.spec.ts --project=chromium`

- [x] **Step 3: Update control menu status and related file list**

Document the quick setup flow, advanced settings, dedicated picker, summary bar, layout contract and remaining hardware scope under the existing required headings.

- [x] **Step 4: Run the focused unit suite, typecheck and production build**

Run: `pnpm exec vitest run src/features/control/automation`

Run: `pnpm run typecheck`

Run: `pnpm run build`

- [x] **Step 5: Mark every completed checklist item and review the final diff**

Run: `git diff --check && git status --short`
