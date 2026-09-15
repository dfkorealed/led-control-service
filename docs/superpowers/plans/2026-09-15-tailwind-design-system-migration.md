# Tailwind Design System Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 현재 Web UI의 시각적 인상과 기능을 유지하면서 간격·색상·타이포그래피를 Tailwind v4 토큰으로 통제하고, React Aria 기반 공통 폼·날짜·overlay 컴포넌트를 모든 메뉴에 적용한다.

**Architecture:** `styles/theme.css`가 CSS-first 토큰의 단일 원천이고, `components/ui`의 typed wrapper가 React Aria의 접근성 동작과 제품 variant를 결합한다. UI 기반 작업 세션이 공통 파일을 단독 소유하며, 각 페이지 작업 세션은 공통 API가 배포된 뒤 자기 feature와 메뉴 문서만 전환한다.

**Tech Stack:** React 18.3.1, TypeScript 5.7, Vite 5.4, Tailwind CSS 4.3.3, React Aria Components 1.21.1, `@internationalized/date` 3.12.4, class-variance-authority 0.7.1, tailwind-merge 3.7.0, Vitest, Testing Library, axe-core 4.13.0, Playwright

**Spec:** `docs/superpowers/specs/2026-09-15-tailwind-design-system-migration-design.md`

## Global Constraints

- 실제 작업 디렉터리는 `/Users/kim-jh/Documents/led-control-service`, 대상 브랜치는 `codex/mvp1-cloud-web`이다.
- 각 작업 세션은 시작 전에 root와 대상 경로의 `AGENTS.md`, `docs/agent-operations.md`, `docs/project-status.md`, 본 계획과 spec을 전부 읽고 `superpowers:test-driven-development`를 적용한다.
- `@theme`가 spacing, color, typography, radius, shadow와 breakpoint의 단일 원천이다. JavaScript Tailwind config를 만들지 않는다.
- 허용 spacing은 `2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 24, 28, 32, 40, 48, 64px`뿐이다.
- production 색상은 `brand-*`, `surface-*`, `content-*`, `border-*`, `action-*`, `status-*`, `chart-*`, `fixture-*` semantic token만 사용한다.
- 정적 스타일은 Tailwind utility로 작성한다. Konva/Recharts runtime geometry와 복잡한 keyframe만 문서화된 CSS 예외를 허용한다.
- 모든 공통 UI는 의미 있는 typed `variant`, `size`, `className`, forwarded `ref`를 제공한다.
- production 컴포넌트는 `querySelector`로 focus target이나 자식 상태를 찾지 않는다.
- React Aria Components는 `components/ui` wrapper 내부에서만 사용하고 페이지에서는 wrapper를 import한다.
- 날짜 UI는 `ko-KR`, 시간 UI는 24시간제를 사용하며 date-only 값은 `YYYY-MM-DD`를 유지한다.
- API request, route, 권한, DB와 장비 제어 동작은 변경하지 않는다.
- 페이지 변경 시 영향을 받는 `docs/menus/*.md`를 같은 커밋에 갱신한다.
- 각 작업 세션은 자신에게 배정된 파일만 수정한다. 공통 API가 부족하면 UI 기반 세션에 후속 요청한다.

## 작업 세션 및 통합 순서

| 단계 | 작업 세션 | Task | 시작 조건 |
| --- | --- | --- | --- |
| A | `서비스 UI 개선` (`01a04ba1-65a6-7de3-b94c-8a395c5b420d`) | 1~5 | 즉시 시작 |
| B | `통계 페이지 기능 개선` (`01a088fa-5016-7162-99b0-a573d3173995`) | 6 | Task 1~5 커밋 통합 후 |
| C | `모니터링 페이지 기능 개선` (`01a088f3-9a15-7802-bd31-cfcfcba2f4d1`) | 7 | Task 1~5 커밋 통합 후 |
| C | `제어 페이지 기능 개선` (`01a088db-9c18-7fc1-8ec4-9782efb8ad20`) | 8 | Task 1~5 커밋 통합 후 |
| C | `설정 페이지 기능 개선` (`019f1d62-874a-7c13-b6f4-ab125bdb5714`) | 9, 이후 10 | Task 1~5, Task 9 순서 |
| C | `Shell·인증·운영 UI 개선` (`01a0a55c-d098-71f3-83ab-b1d9384c26b2`) | 11 | Task 1~5와 Task 10 커밋 통합 후 |
| D | `서비스 UI 개선` + 총괄 | 12 | Task 6~11 통합 후 |

동일 checkout을 사용하므로 단계 A와 페이지 migration을 동시에 실행하지 않는다. 단계 C의 페이지 작업은 소유 파일이 겹치지 않을 때만 병렬 실행한다. Task 10과 Task 11은 모두 모니터링·설정 메뉴 문서를 갱신하므로 Task 10을 먼저 완료하고 Task 11을 시작한다. `styles.css`, `components/ui/index.ts`, `App.tsx`, `CustomerShell.tsx`는 표의 소유 세션 외에는 수정하지 않는다.

---

### Task 1: Tailwind v4 테마와 UI 정책 검사 도입

**Owner:** `서비스 UI 개선`

**Files:**
- Modify: `apps/web/package.json`
- Modify: `pnpm-lock.yaml`
- Modify: `apps/web/vite.config.ts`
- Modify: `apps/web/src/styles.css`
- Create: `apps/web/src/styles/theme.css`
- Create: `apps/web/src/styles/base.css`
- Create: `apps/web/src/styles/exceptions.css`
- Create: `apps/web/scripts/ui-policy.mjs`
- Create: `apps/web/scripts/ui-policy.test.mjs`
- Create: `apps/web/scripts/ui-policy-baseline.json`
- Modify: `docs/ui-spacing.md`

**Interfaces:**
- Consumes: 기존 `styles.css`의 `:root` 토큰과 production literal inventory.
- Produces: `pnpm --filter @led-control/web ui:check`; Tailwind utilities `p-0.5`부터 `p-16`, semantic color utilities, `max-compact:*` responsive variant.

- [x] **Step 1: 정책 검사의 실패 테스트를 작성한다**

```js
import test from "node:test";
import assert from "node:assert/strict";
import { inspectUiSource } from "./ui-policy.mjs";

test("rejects arbitrary spacing, raw colors and production querySelector", () => {
  const violations = inspectUiSource("sample.tsx", 'className="p-[13px] text-[#fff]"; node.querySelector("button")');
  assert.deepEqual(violations.map(({ rule }) => rule), ["arbitrary-spacing", "raw-color", "query-selector"]);
});

test("accepts approved semantic utilities", () => {
  assert.deepEqual(inspectUiSource("sample.tsx", 'className="gap-3 bg-surface-panel text-content-primary"'), []);
});
```

- [x] **Step 2: 검사 모듈이 없어 실패하는지 확인한다**

Run: `node --test apps/web/scripts/ui-policy.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `ui-policy.mjs`.

- [x] **Step 3: dependency와 Tailwind Vite plugin을 추가한다**

Run:

```bash
pnpm --filter @led-control/web add react-aria-components@1.21.1 @internationalized/date@3.12.4 class-variance-authority@0.7.1 tailwind-merge@3.7.0
pnpm --filter @led-control/web add -D tailwindcss@4.3.3 @tailwindcss/vite@4.3.3 axe-core@4.13.0
```

Change `apps/web/vite.config.ts` to import `tailwindcss` from `@tailwindcss/vite` and use `plugins: [tailwindcss(), react()]`.

- [x] **Step 4: 고정 테마를 정의한다**

`apps/web/src/styles.css`의 첫 줄은 다음 import만 두고 기존 규칙은 import 아래 compatibility 영역에 유지한다.

```css
@import "tailwindcss";
@import "./styles/theme.css";
@import "./styles/base.css";
@import "./styles/exceptions.css";
```

`theme.css`에는 기본 namespace를 제거하고 제품 토큰을 명시한다.

```css
@theme static {
  --color-*: initial;
  --text-*: initial;
  --radius-*: initial;
  --shadow-*: initial;
  --breakpoint-*: initial;
  --spacing: 4px;
  --color-brand-navy: #15324a;
  --color-brand-blue: #256fa1;
  --color-brand-coral: #ff7a5c;
  --color-brand-paper: #f4f8fa;
  --color-surface-canvas: #f4f8fa;
  --color-surface-panel: #ffffff;
  --color-content-primary: #15324a;
  --color-content-secondary: #64748b;
  --color-content-muted: #73839a;
  --color-border-default: #dbe7f5;
  --color-action-primary: #256fa1;
  --color-action-primary-hover: #1d5c86;
  --color-action-primary-soft: #e8f2f8;
  --color-status-success-foreground: #15803d;
  --color-status-warning-foreground: #b45309;
  --color-status-danger-foreground: #dc2626;
  --text-display: 2rem;
  --text-display--line-height: 2.5rem;
  --text-page-title: 1.75rem;
  --text-page-title--line-height: 2.25rem;
  --text-section-title: 1.5rem;
  --text-section-title--line-height: 2rem;
  --text-card-title: 1.25rem;
  --text-card-title--line-height: 1.75rem;
  --text-body-lg: 1rem;
  --text-body-lg--line-height: 1.5rem;
  --text-body: 0.875rem;
  --text-body--line-height: 1.375rem;
  --text-body-sm: 0.8125rem;
  --text-body-sm--line-height: 1.25rem;
  --text-label: 0.75rem;
  --text-label--line-height: 1.125rem;
  --text-caption: 0.75rem;
  --text-caption--line-height: 1.125rem;
  --text-overline: 0.6875rem;
  --text-overline--line-height: 1rem;
  --text-metric: 1.75rem;
  --text-metric--line-height: 2.125rem;
  --radius-control: 0.625rem;
  --radius-panel: 0.875rem;
  --radius-popover: 0.875rem;
  --radius-pill: 9999px;
  --shadow-panel: 0 8px 24px rgb(30 64 175 / 0.06);
  --shadow-popover: 0 18px 40px rgb(15 23 42 / 0.18);
  --breakpoint-compact: 47.5rem;
  --breakpoint-tablet: 64rem;
}
```

상태 background/border, chart, fixture 토큰은 inventory의 실제 값을 이름별로 추가한다. `base.css`에는 `html`, `body`, `button/input/select/textarea`의 font inheritance와 `:focus-visible` 기본값만 둔다. `exceptions.css`는 파일 머리말에 허용 범위를 주석으로 기록하고 비어 있는 상태로 시작한다.

- [x] **Step 5: 정책 검사와 baseline을 구현한다**

`inspectUiSource(path, source)`는 arbitrary spacing/color, literal color, production `querySelector`와 승인되지 않은 CSS import를 `{ rule, path, match }[]`로 반환한다. CLI는 `ui-policy-baseline.json`의 파일별 위반 개수보다 증가하면 exit 1을 반환한다. `package.json`에 아래 scripts를 추가한다.

```json
{
  "ui:check": "node scripts/ui-policy.mjs",
  "test:ui-policy": "node --test scripts/ui-policy.test.mjs"
}
```

- [x] **Step 6: 검사·typecheck·build를 통과시킨다**

Run:

```bash
node --test apps/web/scripts/ui-policy.test.mjs
pnpm --filter @led-control/web ui:check
pnpm --filter @led-control/web typecheck
pnpm --filter @led-control/web build
```

Expected: all commands exit 0; Vite output contains generated Tailwind utilities.

- [x] **Step 7: 간격 문서와 첫 커밋을 만든다**

`docs/ui-spacing.md`에 16개 허용값, `max-compact` 사용법, CSS 예외와 policy command를 기록한다.

```bash
git add apps/web/package.json pnpm-lock.yaml apps/web/vite.config.ts apps/web/src/styles.css apps/web/src/styles apps/web/scripts/ui-policy.mjs apps/web/scripts/ui-policy.test.mjs apps/web/scripts/ui-policy-baseline.json docs/ui-spacing.md
git commit -m "feat(web): add Tailwind design token foundation"
```

**Task 1 검증 결과(2026-09-15):** 정책 missing-module RED 후 15/15 GREEN, Web unit 77 files·888/888, typecheck·build·ui:check와 frozen offline install exit 0. 구현 이전 `d0fe85ee` inventory 2,396건에서 제거된 16건을 차감해 baseline 35 files·2,380건, 신규 위반 0건이다. 실제 Vite 메모리 fixture에서 semantic·spacing·typography·`max-compact` CSS 생성과 test fixture 제외를 검증했고 1440/1024/390/320 통계 responsive Chromium 4/4를 통과했다. 기존 테스트 두 파일만 canonical theme와 실제 계산된 스타일 검증으로 보정했으며 production feature/API는 변경하지 않았다. 전체 E2E·전체 메뉴 migration·HIL은 미실행이며 다음 단계는 Task 2다.

> **Task 1 Fix Round 1(2026-09-16):** 27/27 정책 회귀(실제 Vite compile 포함), Web 888/888, typecheck/build/ui:check를 통과했다. `p-px`·정적 spacing/font 계산·line-height slash·미승인 token/breakpoint, semantic var 오탐/JSX literal 누락, query receiver/selector allowance 상쇄와 import suffix/optional call/comment를 보정했다. 신뢰 anchor `24b5ea59` Git source로 재계산한 baseline은 35 files·2,344건, 신규 위반 0건이다. sourceRef와 allowance의 Git 검증도 추가했다. 기존 2,380건 대비 오탐 42건 제거와 기존 계산식 6건 신규 분류이며 production feature 파일은 변경하지 않았다. 독립 재검토 후 Task 2로 진행한다.

> **Task 1 Fix Round 2(2026-09-16):** 승인 Git theme의 token 이름→값 검증과 template/image/shadow literal color 검사를 RED→GREEN으로 보강했다. 정책 29/29(실제 Vite compile 포함), Web 888/888, typecheck/build/ui:check 통과. baseline은 승인 `24b5ea59` source 기준 35 files·2,344건 그대로이며 신규 0건이다. feature/Task 2 파일 변경 없이 독립 재검토를 기다린다.

> **Task 1 Fix Round 3(2026-09-16):** 승인 theme token 전체의 exactly-once inventory와 단일 static block을 검사해 누락·중복·alternate/extra block을 거부한다. Template 정적 구간·filter/SVG stopColor 색상을 검사하고 URL payload 오탐을 제거했다. 정책 32/32(실제 Vite compile 포함), Web 888/888, typecheck/build/ui:check 통과. baseline·feature 소스는 변경 없이 35 files·2,344건, 신규 0건이다. 독립 재검토 후 Task 2를 재개한다.

### Task 2: class utility, typography와 기존 기본 primitive 전환

**Owner:** `서비스 UI 개선`

**Files:**
- Create: `apps/web/src/components/ui/utils/cn.ts`
- Create: `apps/web/src/components/ui/utils/theme-color.ts`
- Create: `apps/web/src/components/ui/Typography.tsx`
- Create: `apps/web/src/components/ui/Typography.test.tsx`
- Modify: `apps/web/src/components/ui/Button.tsx`
- Create: `apps/web/src/components/ui/IconButton.tsx`
- Modify: `apps/web/src/components/ui/Card.tsx`
- Modify: `apps/web/src/components/ui/FeedbackState.tsx`
- Modify: `apps/web/src/components/ui/IconTooltipButton.tsx`
- Modify: `apps/web/src/components/ui/StatusBadge.tsx`
- Modify: `apps/web/src/components/ui/MetricCard.tsx`
- Modify: `apps/web/src/components/ui/PageHeader.tsx`
- Modify: `apps/web/src/components/ui/ProgressSteps.tsx`
- Modify: `apps/web/src/components/ui/RouteLoadingState.tsx`
- Modify: `apps/web/src/components/ui/SidePanel.tsx`
- Modify: `apps/web/src/components/ui/UnderlineNavigation.tsx`
- Modify: `apps/web/src/components/ui/ui-primitives.test.tsx`
- Modify: `apps/web/src/components/ui/index.ts`

**Interfaces:**
- Produces: `cn(...classes)`, `themeColor(token)`, `Heading`, `Text`, Button/IconButton과 토큰화된 기존 공통 primitive 전체.

- [x] **Step 1: ref·className·typography 계약 테스트를 먼저 작성한다**

```tsx
it("forwards typography refs without adding margins", () => {
  const ref = createRef<HTMLHeadingElement>();
  render(<Heading ref={ref} as="h2" variant="section-title" className="text-content-secondary">제목</Heading>);
  expect(ref.current).toBe(screen.getByRole("heading", { name: "제목", level: 2 }));
  expect(ref.current).toHaveClass("m-0", "text-section-title", "text-content-secondary");
});

it("merges a caller button class after the variant", () => {
  render(<Button variant="primary" size="lg" className="w-full">저장</Button>);
  expect(screen.getByRole("button")).toHaveClass("w-full");
});
```

- [x] **Step 2: 새 export가 없어 실패하는지 확인한다**

Run: `pnpm --filter @led-control/web test -- src/components/ui/Typography.test.tsx src/components/ui/ui-primitives.test.tsx`

Expected: FAIL because `Heading` and `Text` are not exported.

- [x] **Step 3: utility와 typography API를 구현한다**

```ts
export function cn(...classes: Array<string | false | null | undefined>) {
  return twMerge(classes.filter(Boolean).join(" "));
}

export const themeColorTokens = [
  "brand-navy", "brand-blue", "brand-coral", "brand-paper",
  "surface-canvas", "surface-panel", "content-primary", "content-secondary", "content-muted",
  "border-default", "action-primary", "action-primary-hover", "action-primary-soft",
  "status-success-foreground", "status-warning-foreground", "status-danger-foreground",
  "chart-usage", "chart-cost", "chart-baseline", "fixture-connected", "fixture-inspection", "fixture-offline"
] as const;
export type ThemeColorToken = typeof themeColorTokens[number];

export type TypographyVariant = "display" | "page-title" | "section-title" | "card-title" | "body-lg" | "body" | "body-sm" | "label" | "caption" | "overline" | "metric";
export type TextTone = "primary" | "secondary" | "muted" | "inverse" | "danger" | "success" | "warning";
```

`Heading`과 `Text`는 `forwardRef`, polymorphic `as`, `variant`, `className`을 지원하고 외부 margin을 항상 0으로 둔다. `metric`은 `tabular-nums`를 포함한다. `themeColor`은 typed `ThemeColorToken`만 받아 `getComputedStyle(document.documentElement).getPropertyValue('--color-' + token).trim()`을 반환한다.

- [x] **Step 4: 기존 primitive를 CVA와 Tailwind로 전환한다**

Button props를 다음 계약으로 유지·확장한다.

```ts
export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement>, Pick<AriaButtonProps, "isDisabled" | "onPress"> {
  variant?: "primary" | "secondary" | "ghost" | "danger" | "link";
  size?: "sm" | "md" | "lg";
  isLoading?: boolean;
  loadingLabel?: string;
  className?: string;
  children: ReactNode;
}
```

기존 native button 호출자가 사용하는 `type`, `disabled`, `onClick`을 깨지 않게 adapter하고, React Aria `isDisabled`와 기존 `disabled`를 모두 정규화한다. IconButton은 `aria-label`을 필수로 받고 Button의 variant/size/ref 계약을 공유한다. Card, FeedbackState, IconTooltipButton, StatusBadge, MetricCard, PageHeader, ProgressSteps, RouteLoadingState, SidePanel과 UnderlineNavigation도 typed `variant`, `className`과 root ref를 지원한다. 시각 분기가 없는 컴포넌트의 기본 variant는 `"default"`이며 API를 임의 문자열로 열지 않는다.

`ui-primitives.test.tsx`는 모든 public component를 table-driven 방식으로 렌더링해 기본 variant, 지원 variant, caller `className`과 ref 전달을 확인한다.

- [x] **Step 5: focused tests와 policy를 통과시킨다**

Run:

```bash
pnpm --filter @led-control/web test -- src/components/ui/Typography.test.tsx src/components/ui/ui-primitives.test.tsx
pnpm --filter @led-control/web ui:check
pnpm --filter @led-control/web typecheck
```

Expected: all commands exit 0.

- [x] **Step 6: 커밋한다**

```bash
git add apps/web/src/components/ui
git commit -m "feat(web): add typed Tailwind UI primitives"
```

**Task 2 검증 결과(2026-09-16):** 기준 `0c7d5d94`에서 missing export·size·disabled·root ref 계약의 실제 RED 32 failed/36 passed 후 focused 83/83(typography 24·primitive 59), 전체 Web 78 files·938/938, typecheck/build/ui:check(기존 2,344건·신규 0건)와 diff 검사를 통과했다. 실제 Chromium 메모리 fixture에서도 Enter/Space/mouse의 click·press 각 1회, native implicit submit과 disabled를 확인했다. Button은 React Aria Button의 자동 `tabindex=0`이 기존 ModalDialog 초기 focus selector에 영향을 주므로 총괄 결정에 따라 native semantic adapter로 유지하고 React Aria 타입의 `isDisabled`/`onPress`만 지원한다. 기존 native type·disabled·onClick, modal focus 회귀와 `ui-*` compatibility hook은 보존했다. React Aria field/date/overlay 전환, menu migration, legacy global cascade 제거 및 전체 E2E/HIL은 이번 완료 범위가 아니다. 독립 검토 후 Task 3으로 진행한다.

**Task 2 Fix Round 1 검증 결과(2026-09-16):** `45d9a109`의 실제 production-build Chromium에서 size·caller override·keyboard 좌표 RED 7 failed/1 passed를 확인한 뒤 공통 compatibility 규칙을 components 계층으로 이동하고 중복 font reset을 기존 base로 통합했다. 모든 Button size, caller padding, tooltip padding/size, legacy sidebar/row action/tooltip alignment와 Enter/Space 좌표가 8/8 GREEN이다. 위 Button interface 예제도 실제 native + `Pick<AriaButtonProps, "isDisabled" | "onPress">` 범위와 일치시켰다.

- [x] 공통 CSS 계층과 selector 경계를 보존하고 blanket important 없이 production utility/caller 우선순위를 검증한다.
- [x] Layer 첫 selector 누락을 synthetic RED 2 failed → 정책 34/34 GREEN으로 수정해 별도 `4199a487`에 커밋한다. Immutable anchor·baseline은 유지하고 현재 부채 2,342건/신규 0건(중복 reset 실제 제거 2건)을 확인한다.
- [x] JSDOM-only compatibility loader를 공통화하고 helper RED→GREEN 2/2, 기존 UI·브랜드·편집기 assertion 유지, focused 93/93·전체 Web 80 files/948개 연속 단독 실행 2회·typecheck·build·ui:check·diff 검사를 완료한다.

동시 full/focused Vitest·policy compile·production build 실행에서 API 초기화 오류 37건이 한 번 관측됐다. API/feature 코드 변경 없이 단독 full 실행 두 번(9.18초/9.20초)은 모두 통과했으며 동시 transform/cache 경합은 가설이지 확정 원인이 아니다. Production cascade의 검증 근거는 JSDOM flattening이 아니라 실제 Chromium이다. Feature production과 모달 focus는 변경하지 않았고 메뉴별 legacy cascade·전체 E2E/HIL은 후속 범위다. Task 2 독립 재검토 후 Task 3으로 진행한다.

**Task 2 Fix Round 2 검증 결과(2026-09-16):** 중첩 group의 첫 selector와 keyframe 회귀 RED 3 failed/1 passed를 확인하고 grouping brace를 재귀적으로 보존하되 keyframe step은 selector로 분류하지 않도록 보완했다. Keyframe의 색상·spacing 검사는 유지한다. 정책 39/39 및 별도 scanner 커밋 `0645bff5`를 완료했다.

- [x] 동일 immutable `24b5ea59` source의 inventory로만 baseline을 재계산한다. 기존 media 첫 selector 17건(css-selector만, 13개 기존 fingerprint 빈도 증가·4개 신규 노출 fingerprint)을 반영해 baseline 2,361건, current 2,359건/신규 0건이다. 초기 29개 경고 중 나머지 12개는 rule-total 초과 연쇄 경고였으며 별도 allowance를 추가하지 않았다.
- [x] 실제 missing-browser 환경에서 기존 unit cascade suite 실패를 재현한 뒤 8개 assertion을 `e2e/ui-cascade.spec.ts`로 이동한다. `e2e:ui-cascade`는 production memory build만 사용하며 dev/backend server를 요구하지 않는다. CI의 기존 Chromium install 뒤 필수 단계로 실행한다.
- [x] CI 연결 missing-step RED→GREEN과 브라우저 없는 `--list` discovery를 추가한다. Browserless Web 79 files·940/940, focused 85/85, CI contracts 38/38과 browser-enabled production cascade 8/8, typecheck/build/ui:check/diff를 통과한다.

실행: `pnpm --filter @led-control/web e2e:ui-cascade` (Chromium 설치 필요). 일반 `pnpm test`는 browser를 요구하지 않으며 browser가 없는 E2E 명령은 명시적으로 실패한다. 기존 948개는 이제 unit 940개 + 필수 Chromium 8개로 분리된 것이며 assertion을 제거하거나 skip하지 않았다. Feature production·모달·장비 코드는 변경하지 않았고 Task 3은 독립 재검토 이후다.

### Task 3: Field, text, number와 selection 컴포넌트 구현

**Owner:** `서비스 UI 개선`

**Files:**
- Create: `apps/web/src/components/ui/fields/field-types.ts`
- Create: `apps/web/src/components/ui/fields/FormField.tsx`
- Create: `apps/web/src/components/ui/fields/TextField.tsx`
- Create: `apps/web/src/components/ui/fields/NumberField.tsx`
- Create: `apps/web/src/components/ui/fields/FileField.tsx`
- Create: `apps/web/src/components/ui/fields/SelectBox.tsx`
- Create: `apps/web/src/components/ui/fields/ComboBox.tsx`
- Create: `apps/web/src/components/ui/fields/Checkbox.tsx`
- Create: `apps/web/src/components/ui/fields/RadioGroup.tsx`
- Create: `apps/web/src/components/ui/fields/Switch.tsx`
- Create: `apps/web/src/components/ui/fields/Slider.tsx`
- Create: `apps/web/src/components/ui/fields/fields.test.tsx`
- Create: `apps/web/src/test/a11y.ts`
- Modify: `apps/web/src/components/ui/index.ts`
- Create: `apps/web/e2e/ui-fields.spec.ts` (승인된 browser-only 검증 확장)
- Modify: `apps/web/playwright.ui-cascade.config.ts`
- Modify: `scripts/ci-workflows.test.mjs`
- Modify: `apps/web/package.json`, `pnpm-lock.yaml` (Fix Round 1 승인: 기존 resolved `react-aria@3.52.1` 직접 고정)

**Interfaces:**
- Produces: `TextField`, `SearchField`, `PasswordField`, `TextArea`, `NumberField`, `FileField`, `SelectBox<T>`, `ComboBox<T>`, `Checkbox`, `CheckboxGroup`, `RadioGroup`, `Switch`, `Slider`.

- [x] **Step 1: 공통 상태·ref·keyboard 테스트를 작성한다**

```tsx
it("connects a field label, help and error to the input", () => {
  const ref = createRef<HTMLInputElement>();
  render(<TextField ref={ref} label="이름" description="현장 표시명" errorMessage="필수 항목입니다" isInvalid />);
  const input = screen.getByRole("textbox", { name: "이름" });
  expect(ref.current).toBe(input);
  expect(input).toHaveAccessibleDescription(expect.stringContaining("필수 항목입니다"));
});

it("selects an option with the keyboard", async () => {
  render(<SelectBox label="층" items={[{ id: "f1", label: "1층" }]} selectedKey={null} onSelectionChange={() => {}} />);
  await user.click(screen.getByRole("button", { name: "층" }));
  expect(screen.getByRole("option", { name: "1층" })).toBeVisible();
});

it("has no serious axe violations", async () => {
  const { container } = render(<TextField label="이름" description="현장 표시명" />);
  expect(await axeViolations(container, ["serious", "critical"])).toEqual([]);
});
```

- [x] **Step 2: 새 컴포넌트가 없어 실패하는지 확인한다**

Run: `pnpm --filter @led-control/web test -- src/components/ui/fields/fields.test.tsx`

Expected: FAIL on missing field exports.

- [x] **Step 3: 공통 field 계약을 구현한다**

```ts
export interface FieldVisualProps {
  variant?: "outline" | "filled" | "ghost";
  size?: "sm" | "md" | "lg";
  className?: string;
  label?: ReactNode;
  description?: ReactNode;
  errorMessage?: ReactNode;
}

export interface TextFieldProps extends FieldVisualProps {
  value?: string;
  defaultValue?: string;
  onChange?(value: string): void;
  type?: "text" | "search" | "password" | "email" | "tel" | "url";
  autoComplete?: string;
  minLength?: number;
  maxLength?: number;
  inputMode?: "none" | "text" | "tel" | "url" | "email" | "numeric" | "decimal" | "search";
  autoFocus?: boolean;
  isDisabled?: boolean;
  isReadOnly?: boolean;
  isRequired?: boolean;
  isInvalid?: boolean;
}

export interface SelectItem<T extends Key = Key> {
  id: T;
  label: string;
  description?: string;
  isDisabled?: boolean;
}

export interface SelectBoxProps<T extends Key> extends FieldVisualProps {
  items: ReadonlyArray<SelectItem<T>>;
  selectedKey: T | null;
  onSelectionChange(key: T | null): void;
  placeholder?: string;
  isDisabled?: boolean;
}

export interface NumberFieldProps extends FieldVisualProps {
  value: number | null;
  onChange(value: number | null): void;
  minValue?: number;
  maxValue?: number;
  step?: number;
}

export interface FileFieldProps extends FieldVisualProps {
  accept?: string;
  multiple?: boolean;
  onChange(files: FileList | null): void;
}
```

React Aria `TextField`, `Input`, `Label`, `FieldError`, `Select`, `ListBox`, `Popover`, `Checkbox`, `RadioGroup`, `Switch`, `Slider`를 wrapper 내부에서 조합한다. `data-invalid`, `data-disabled`, `data-focus-visible`, `data-selected` 상태는 CVA/Tailwind data variant로 스타일링한다.

NumberField는 값이 실제로 `number | null`인 UI에만 사용하고 임의 clamp를 하지 않는다. 빈 문자열, 소수점 입력 중간 상태나 범위 밖 값을 domain validation까지 보존해야 하는 요금·정격전력·스케줄 입력은 TextField에 `inputMode="decimal"` 또는 `inputMode="numeric"`를 사용한다. FileField는 native file input을 공통 label/error/variant 안에 넣고 실제 `HTMLInputElement` ref와 FileList를 그대로 전달한다.

`apps/web/src/test/a11y.ts`는 `axe.run(container)` 결과를 받아 지정 impact의 violation만 반환한다. fields test는 각 component family를 table-driven 방식으로 렌더링해 variant, `sm | md | lg`, disabled/invalid 상태, `className`, root/control ref와 serious/critical axe violation 0건을 확인한다.

- [x] **Step 4: 검색·비밀번호·textarea를 TextField thin wrapper로 만든다**

`SearchField`는 `type="search"`, `PasswordField`는 `type="password"`, `TextArea`는 React Aria `TextArea`를 사용한다. 세 wrapper 모두 실제 input/textarea ref를 전달하고 base field variant를 공유한다.

- [x] **Step 5: 테스트·typecheck·policy를 통과시킨다**

Run:

```bash
pnpm --filter @led-control/web test -- src/components/ui/fields/fields.test.tsx
pnpm --filter @led-control/web typecheck
pnpm --filter @led-control/web ui:check
```

Expected: all commands exit 0.

- [x] **Step 6: 커밋한다**

```bash
git add apps/web/src/components/ui/fields apps/web/src/components/ui/index.ts
git commit -m "feat(web): add accessible form field primitives"
```

**Task 3 검증 결과(2026-09-16):** 14 family missing-export의 실제 RED 117/117 실패를 먼저 확인하고 field 계약 128/128 GREEN, 전체 Web 80 files·1,068/1,068, typecheck/build/ui:check 및 diff 검사를 통과했다. TextField의 `""`·`"-"`·`"1."`·범위 밖 문자열, NumberField의 `number | null`, FileField의 실제 FileList identity, selection 숫자/문자 key와 단일 callback을 보존했다. Input/textarea/file/checkbox/switch/slider는 실제 input ref, SelectBox는 trigger ref, FormField와 group은 root ref를 제공한다. Closed variant/size는 실제 styled control에도 적용하고 caller className은 field layout root에 병합한다. React Aria 1.21.1의 NumberField는 VoiceOver 호환상 spinbutton 대신 named textbox + `aria-roledescription="Number field"`를 사용하므로 숫자 키보드·min/max/step으로 동작을 검증했다.

승인된 별도 정책 수정 `5d566840`은 CVA `sm:`/`md:`/`lg:` 객체 key를 responsive utility로 오인하던 오류를 RED 2/2 실패→정책 41/41로 보완했다. 실제 미승인 responsive utility 거부는 유지했으며 immutable anchor `24b5ea59`와 baseline 2,361건은 변경하지 않았다. 현재 기존 부채 2,359건/신규 0건이다.

Chromium 설치 뒤 실행하는 기존 `e2e:ui-cascade` 경로에 field 7개를 추가해 총 15/15(2 files)를 통과했고 CI discovery/순서 계약은 38/38이다. Native Space 단일 toggle, FileList/동일 파일 재선택, actual ref/focus-visible, popup keyboard/disabled skip, 숫자·radio·slider key, 계산된 variant/size/caller cascade와 production CSS axe를 검증했다. 실제 axe RED에서 canvas 설명 대비 4.45:1과 selected 설명 대비 4.18:1을 발견해 theme 값 변경 없이 승인 `content-primary`로 보완했다(SelectBox/ComboBox 공통 option 포함). JSDOM은 pseudo geometry를 측정할 수 없어 해당 측정만 브라우저 증거로 분리하며 axe rule 자체는 끄지 않았다. Browser 없는 일반 Web unit은 계속 독립 실행 가능하다.

Production build main은 651.01 kB/gzip 199.41 kB이며 Vite의 500 kB chunk 경고가 남는다. Page/feature production, 기존 모달·compatibility hooks, API/DB/MQTT/firmware는 변경하지 않았다. 전체 메뉴 전환·전체 E2E/HIL·실제 보조기기 수동 검증은 미실행이고 Task 4는 시작하지 않았다. Task 3 독립 검토를 기다린다.

**Task 3 Fix Round 1(2026-09-16):** 독립 리뷰의 mixed 표시/ID/라벨 typography를 실제 unit RED 8 failed·129 passed, Chromium RED 3 failed로 재현했다. Checkbox는 React Aria render state로 빈 표시·✓·−를 구분하며 mixed가 selected보다 우선한다. Checkbox/Switch의 sm/md/lg 실제 라벨은 13/14/16px이고 caller ID는 actual input/ref와 일치한다. Slider는 기존 resolved `react-aria@3.52.1`을 직접 exact dependency로 추가하고 공개 `useSliderThumb`/`useFocusRing` 및 RAC state/track/label contexts를 조합했다. 실제 mounted track ref로 keyboard/move를 유지하고 native range input에 ID·aria-controls를 전달한다. 내부 라벨의 generated-ID lookup 회귀도 unit/browser RED→GREEN으로 보완해 public state를 통한 focus를 유지한다. 내부 child 복제·DOM 속성 사후 수정·새 react-stately 의존성은 없다. Lockfile은 Web importer 3줄만 늘고 frozen offline install과 production fixture의 단일 react-aria 버전 검사가 통과했다.

추가 QA의 강제 ARIA validation은 unit RED 21 failed(11 family×3 mode), browser native submit RED로 재현 후 제거했다. Caller `validationBehavior`와 React Aria native 기본값을 보존하고 CheckboxGroup 항목에도 caller mode를 전달해 33/33 검증을 통과했다. `FormField.children`은 속성을 전달하는 render function으로만 제한하고 `FileField.isReadOnly`는 공개 타입에서 제거했다. 두 compile-time RED `@ts-expect-error`와 linked-ID/DOM non-leak 회귀를 확인했다. 최종 focused 172/172, Chromium 19/19(기존 8+field 11), typecheck를 통과했으며 33 실제 form의 checkValidity/requestSubmit, 외부·내부 label focus, Arrow/Home/End·step/min/max·단일 callback, class cascade와 전체 field fixture axe를 포함한다. 일반 unit에 browser 의존성을 추가하지 않았고 Task 4는 미착수·독립 재검토 대기다.

Fix Round 1 최종 전체 검증은 Web 80 files·1,112/1,112, 정책 41/41, CI 계약 38/38, ui:check 기존 2,359/신규 0, typecheck/build·diff 검사 exit 0이다. Main bundle 650.83 kB/gzip 199.47 kB이며 500 kB 경고는 남는다. 승인 anchor/baseline·page/feature production·기존 compatibility·API/장비 코드는 변경하지 않았다.

**Task 3 Fix Round 2(2026-09-16):** QA의 slider thumb 수직 오차를 실제 production Chromium RED 1 failed(중심 delta 22px, 허용 0.5px)로 재현했다. Hook의 `translateY(-50%)` 기준점이 없었던 원인을 승인 정적 `top-1/2` anchor 한 곳으로 보완했다. sm/md/lg×0/50/100의 9개 조합에서 bar/track/thumb 수직 중심과 thumb 수평 위치를 0.5px 이하로 검증하고, 실제 drag 50→80 및 ArrowRight 90의 단일 callback을 유지했다. Focused 172/172, 전체 Web 80 files·1,112/1,112, Chromium 20/20(기존 8+field 12), 정책 41/41·CI 계약 38/38·typecheck/build·diff 검사와 ui:check 기존 2,359/신규 0건을 통과했다. Main은 650.84 kB/gzip 199.48 kB로 기존 chunk 경고가 남으며, production 변경은 Slider의 정적 class와 설명 주석뿐이다. Task 4는 미착수·독립 재검토 대기다.

### Task 4: Calendar, DatePicker와 TimePicker 구현

**Owner:** `서비스 UI 개선`

**Files:**
- Create: `apps/web/src/components/ui/date/date-adapters.ts`
- Create: `apps/web/src/components/ui/date/Calendar.tsx`
- Create: `apps/web/src/components/ui/date/DatePicker.tsx`
- Create: `apps/web/src/components/ui/date/DateRangePicker.tsx`
- Create: `apps/web/src/components/ui/date/TimePicker.tsx`
- Create: `apps/web/src/components/ui/date/date-components.test.tsx`
- Create: `apps/web/src/components/ui/date/date-field.tsx`
- Create: `apps/web/e2e/ui-dates.spec.ts`
- Modify: `apps/web/playwright.ui-cascade.config.ts`, `scripts/ci-workflows.test.mjs` (browser-installed foundation 검증 확장)
- Modify: `apps/web/src/components/ui/index.ts`

**Interfaces:**
- Produces: `parseIsoDate(value: string): CalendarDate`, `formatIsoDate(value: DateValue): string`, `parseLocalTime(value: string): Time`, `formatLocalTime(value: TimeValue): string`, `FocusableFieldHandle` and date/time components.

- [x] **Step 1: date-only와 24시간제 실패 테스트를 작성한다**

```tsx
it("round-trips a date-only value without UTC shifting", () => {
  expect(formatIsoDate(parseIsoDate("2026-09-15"))).toBe("2026-09-15");
});

it("uses Korean labels and a 24-hour time field", () => {
  render(<TimePicker label="시작 시각" value="23:30" onChange={() => {}} />);
  expect(screen.getByRole("group", { name: "시작 시각" })).toHaveTextContent("23");
});
```

- [x] **Step 2: adapter가 없어 실패하는지 확인한다**

Run: `TZ=America/Los_Angeles pnpm --filter @led-control/web test -- src/components/ui/date/date-components.test.tsx`

Expected: FAIL on missing exports.

- [x] **Step 3: 문자열 경계 adapter를 구현한다**

```ts
export const parseIsoDate = (value: string) => parseDate(value);
export const formatIsoDate = (value: DateValue) => value.toString();
export const parseLocalTime = (value: string) => parseTime(value);
export const formatLocalTime = (value: TimeValue) => value.toString().slice(0, 5);
```

native `Date`와 `toISOString()`은 date-only adapter에서 사용하지 않는다.

- [x] **Step 4: React Aria date/time wrapper를 구현한다**

DatePicker와 TimePicker의 외부 계약은 다음과 같다.

```ts
export interface DatePickerProps extends FieldVisualProps {
  value: string | null;
  minValue?: string;
  maxValue?: string;
  onChange(value: string | null): void;
}

export interface FocusableFieldHandle {
  focus(): void;
  readonly element: HTMLElement | null;
}

export interface TimePickerProps extends FieldVisualProps {
  value: string | null;
  minValue?: string;
  maxValue?: string;
  onChange(value: string | null): void;
}
```

DatePicker, DateRangePicker와 TimePicker의 forwarded ref는 `FocusableFieldHandle`이며 `focus()`가 첫 editable segment로 이동한다. 내부에서는 `I18nProvider locale="ko-KR"`, `hourCycle={24}`, `DateInput`, `DateSegment`, `CalendarGrid`, `Popover`, `Dialog`를 사용한다.

- [x] **Step 5: timezone·keyboard·ref 테스트를 통과시킨다**

Run:

```bash
TZ=Asia/Seoul pnpm --filter @led-control/web test -- src/components/ui/date/date-components.test.tsx
TZ=America/Los_Angeles pnpm --filter @led-control/web test -- src/components/ui/date/date-components.test.tsx
pnpm --filter @led-control/web typecheck
```

Expected: both timezones pass with identical date strings.

- [x] **Step 6: 커밋한다**

```bash
git add apps/web/src/components/ui/date apps/web/src/components/ui/index.ts
git commit -m "feat(web): add accessible date and time controls"
```

**Task 4 검증 결과(2026-09-16):** 승인 기준 `44a47234`에서 missing-export RED를 서울·로스앤젤레스 각각 41 failed/1 type-only passed로 확인했다. 날짜·시간 public 값은 `YYYY-MM-DD`, `HH:mm`, `{ start: string; end: string } | null`이며 malformed 문자열과 모순된 min/max는 `RangeError`로 거부한다. 날짜 경계에는 native `Date`·UTC 변환을 사용하지 않는다. 역순 범위와 범위 밖 값은 정상적인 편집 중간 상태이므로 원래 문자열을 보존하고 React Aria validation에 맡긴다. 역순 범위를 throw하면 연도 세그먼트 수정이 crash하는 RED를 확인해 이 계약을 고정했다.

`FocusableFieldHandle.element`는 caller id를 가진 안정적인 control/root DOM이고 `focus()`는 locale 순서의 첫 editable segment로 이동한다. disabled/readOnly에서는 editable segment가 없으므로 명시적 no-op이다. Calendar/DatePicker/DateRangePicker/TimePicker는 `ko-KR`, 시간 24시간제, typed variant/size, 실제 control 스타일, label/help/error·외부 ARIA와 caller/default validationBehavior를 보존한다. 일부 세그먼트를 지울 때는 React Aria의 편집 중간 상태를 유지하며 모두 비우면 `null`을 정확히 한 번 전달한다. Calendar는 native form control이 아니므로 `isRequired`/`validationBehavior`를 공개하지 않는다.

Production Chromium에서 popup의 기본 12px viewport inset과 310px calendar가 320px 폭을 1px 넘는 RED를 재현하고 승인된 4px inset으로 보완했다. 실제 Enter/Escape·focus 복귀·ArrowRight/Enter 날짜 선택·윤년/월 경계·min/max·역순 범위 편집·Backspace/Delete 전체 지우기·9개 native/default/aria form·320px overflow·44px target·axe serious/critical 0을 검증했다. 양 TZ focused 각각 **54/54**, 전체 Web **81 files·1,166/1,166**, production Chromium **30/30**(primitive 8+field 12+date 10), CI 계약 **38/38**, typecheck/build/diff·ui:check **기존 2,359/신규 0건**을 통과했다. Main은 **799.48 kB/gzip 245.88 kB**이고 기존 500 kB chunk 경고는 남는다. 일반 unit은 browser를 요구하지 않으며, 새 date browser suite는 기존 browser-installed CI 단계에만 연결했다. Page/feature·Task 5 overlay·기존 모달·장비 계약은 변경하지 않았다. 메뉴 migration·전체 E2E·HIL·실제 보조기기 수동 검증은 미실행이며 **Task 4 독립 QA 대기, Task 5 미착수**다.

**Task 4 Fix Round 1(2026-09-16):** 독립 검토의 날짜 경계·자동 invalid 스타일과 추가 bundle 지적을 보완했다.

- [x] 서울·로스앤젤레스 각각 `0000-01-01`이 예외 없이 `0001-01-01`로 바뀌는 RED 1 failed/57 passed를 재현하고, 파싱 뒤 원문과 canonical 문자열의 일치를 검증한다. `0000-02-29` 거부, `0001-01-01`·`9999-12-31`·윤일의 정상 round trip과 분 단위 시간의 canonical 계약을 유지한다.
- [x] TimePicker min/max·native submit에서 ARIA는 invalid지만 실제 border는 정상 gray인 production Chromium RED 2/2를 재현한다. 공개 TimeField render state로 실제 styled root의 data-invalid를 연결하고 min/max·native/default submit·explicit invalid 및 정상 값 복구의 ARIA/border·stable root를 검증한다. DOM 탐색·중복 validation은 추가하지 않는다.
- [x] date forwardRef 초기화 5개에 PURE 주석을 명시하고 public barrel exports를 유지한다. Normal app과 메모리의 no-date-export control은 **650,839자/gzip 199,478바이트/513모듈**, SHA-256 `3d066d0e14576befcb3fcc8464ca1cb5a4bb1df08a6670055c53846e1f6fbef2`로 같아 Task 3 main baseline을 정확히 복구했다. PURE 제거 negative control은 **799,670자/gzip 245,948바이트/672모듈**이며, 명시적 consumer는 네 date 모듈을 모두 포함하고 Node SSR에서 네 컴포넌트를 실제 렌더링한다.
- [x] Task 2의 transform/cache 경합을 피하도록 bundle 회귀를 일반 Vitest에서 제거하고 `apps/web/scripts/date-bundle.mjs`와 package `test:date-bundle` 별도 직렬 gate로 제공한다. `.github/workflows/ci.yml`의 unit `pnpm test` 뒤 조건 없이 실행하며 CI contract는 누락/if/continue-on-error 우회를 거부한다. 일반 Web test는 production Vite build를 시작하지 않는다.

최종 양 TZ focused **각각 58/58**, 전체 Web **81 files·1,170/1,170**, Chromium **30/30**, 별도 bundle gate **1/1 두 번**, CI 계약 **39/39**, typecheck/build·diff 및 ui:check **기존 2,359/신규 0건**을 통과했다. Production date fixture는 네 date 모듈의 실제 포함도 검사하며 기존 keyboard/ref/ARIA/44px/320px/axe serious·critical 0을 유지한다. Main은 **650.84 kB/gzip 199.48 kB**이며 기존 500 kB warning은 그대로다. Browser suite 수는 추가하지 않고 기존 10개 date scenario의 assertion을 확장했다. Feature/page·Task 5·장비·보호 경로는 변경하지 않았으며 **독립 재검토 대기, Task 5 미착수**다. 향후 실제 페이지가 date 컴포넌트를 소비할 때에는 zero-cost migration gate를 그 사용 범위에 맞게 명시적으로 갱신한다.

### Task 5: Dropdown과 overlay/dialog 체계 통합

**Owner:** `서비스 UI 개선`

**Files:**
- Create: `apps/web/src/components/ui/overlays/DropdownMenu.tsx`
- Create: `apps/web/src/components/ui/overlays/Popover.tsx`
- Rewrite: `apps/web/src/components/ui/ModalDialog.tsx`
- Rewrite: `apps/web/src/components/ui/ConfirmDialog.tsx`
- Delete: `apps/web/src/components/ui/ModalDialog.css`
- Modify: `apps/web/src/components/ConfirmDialog.tsx`
- Create: `apps/web/src/components/ui/overlays/overlays.test.tsx`
- Modify: `apps/web/src/components/ui/ui-primitives.test.tsx`
- Modify: `apps/web/src/components/ui/index.ts`

**Interfaces:**
- Produces: one `ModalDialog`, one `ConfirmDialog`, `DropdownMenu<T>`, `Popover`; focus containment and return are owned by React Aria.

- [ ] **Step 1: overlay focus와 querySelector 금지 테스트를 작성한다**

```tsx
it("returns focus to the trigger after Escape", async () => {
  render(<DialogHarness />);
  const trigger = screen.getByRole("button", { name: "열기" });
  await user.click(trigger);
  await user.keyboard("{Escape}");
  expect(trigger).toHaveFocus();
});

it("contains no production querySelector in overlay sources", () => {
  for (const source of overlaySources) expect(source).not.toMatch(/\.querySelector(?:All)?\(/);
});
```

- [ ] **Step 2: 기존 구현에서 금지 테스트가 실패하는지 확인한다**

Run: `pnpm --filter @led-control/web test -- src/components/ui/overlays/overlays.test.tsx src/components/ui/ui-primitives.test.tsx`

Expected: FAIL because existing ModalDialog and ConfirmDialog call `querySelector`.

- [ ] **Step 3: React Aria overlay로 교체한다**

`ModalOverlay`, `Modal`, `Dialog`, `Heading`, `Button`을 조합하고 기존 props인 `title`, `description`, `actions`, `onClose`, `isPending`, `initialFocusRef`, `returnFocusElement`, `fallbackFocusElement`, `role`, `className`을 유지한다. `isDismissable={!isPending}`, `isKeyboardDismissDisabled={isPending}`로 pending 보호를 보존한다.

- [ ] **Step 4: 두 ConfirmDialog를 하나의 public API로 수렴한다**

```ts
export interface ConfirmDialogProps {
  isOpen?: boolean;
  title: string;
  children: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  tone?: "primary" | "danger";
  isPending?: boolean;
  onCancel(): void;
  onConfirm(): void;
  initialFocusRef?: RefObject<HTMLElement>;
  returnFocusRef?: RefObject<HTMLElement>;
  fallbackFocusRef?: RefObject<HTMLElement>;
  returnFocusElement?: HTMLElement | null;
  fallbackFocusElement?: HTMLElement | null;
}
```

ModalDialog와 ConfirmDialog는 화면별 접근성 이름을 보존할 수 있도록 `closeLabel?: string`을 받고 기본값은 `"닫기"`다. React Aria의 중첩 overlay stack을 사용해 자식 ConfirmDialog가 열려 있을 때 부모 focus scope가 자식 focus를 되돌리지 않게 한다.

`returnFocusRef`/`fallbackFocusRef`를 신규 호출의 기본 계약으로 사용한다. 기존 호출자가 가진 element 기반 `returnFocusElement`/`fallbackFocusElement`도 migration 기간에 보존하고 ref가 없을 때만 사용한다. legacy import 경로는 re-export adapter로 한 migration 단계 동안 유지하고, 모든 page migration이 끝난 Task 12에서 제거한다.

- [ ] **Step 5: overlay tests·전체 UI primitive tests·policy를 통과시킨다**

Run:

```bash
pnpm --filter @led-control/web test -- src/components/ui/overlays/overlays.test.tsx src/components/ui/ui-primitives.test.tsx
pnpm --filter @led-control/web typecheck
pnpm --filter @led-control/web ui:check
```

Expected: all commands exit 0 and production common components contain no `querySelector`.

- [ ] **Step 6: foundation 완료 커밋을 만든다**

```bash
git add apps/web/src/components/ConfirmDialog.tsx apps/web/src/components/ui
git commit -m "refactor(web): unify accessible overlays"
```

Task 1~5 완료 후 총괄은 다섯 커밋, focused tests, Web typecheck와 build를 직접 확인하고 페이지 담당 세션에 foundation HEAD를 전달한다.

### Task 6: 통계 페이지 pilot migration

**Owner:** `통계 페이지 기능 개선`

**Files:**
- Modify: `apps/web/src/features/statistics/StatisticsShell.tsx`
- Modify: `apps/web/src/features/statistics/StatisticsSubnavigation.tsx`
- Modify: `apps/web/src/features/statistics/StatisticsOverviewPage.tsx`
- Modify: `apps/web/src/features/statistics/analysis/StatisticsAnalysisPage.tsx`
- Modify: `apps/web/src/features/statistics/analysis/EnergyHeatmap.tsx`
- Modify: `apps/web/src/features/statistics/analysis/EnergyRankingList.tsx`
- Modify: `apps/web/src/features/statistics/analysis/EnergyRankingDetailPanel.tsx`
- Modify: `apps/web/src/features/statistics/reports/ReportCreateDialog.tsx`
- Modify: `apps/web/src/features/statistics/reports/ReportJobList.tsx`
- Modify: `apps/web/src/features/statistics/StatisticsShell.test.tsx`
- Modify: `apps/web/src/features/statistics/StatisticsOverviewPage.test.tsx`
- Modify: `apps/web/src/features/statistics/EnergyComparisonChart.test.tsx`
- Modify: `apps/web/src/features/statistics/PeriodComparisonPanel.test.tsx`
- Modify: `apps/web/src/features/statistics/analysis/EnergyHeatmap.test.tsx`
- Modify: `apps/web/src/features/statistics/analysis/StatisticsAnalysisPage.test.tsx`
- Modify: `apps/web/src/features/statistics/reports/StatisticsReportsPage.test.tsx`
- Modify: `apps/web/e2e/statistics-flow.spec.ts`
- Modify: `docs/menus/statistics.md`

**Interfaces:**
- Consumes: Task 1~5 exports. Produces no common UI API.

- [ ] **Step 1: 날짜·select·typography migration 테스트를 작성한다**

```tsx
it("edits the report range through design-system date pickers", async () => {
  renderReportDialog();
  await user.click(screen.getByRole("group", { name: "기간 시작" }));
  expect(screen.getByRole("dialog")).toContainElement(screen.getByRole("grid"));
  expect(screen.getByRole("button", { name: "보고서 요청" })).toBeEnabled();
});
```

- [ ] **Step 2: 현재 native date 입력으로 실패하는지 확인한다**

Run: `pnpm --filter @led-control/web test -- src/features/statistics`

Expected: new Calendar grid assertion fails.

- [ ] **Step 3: 분석·보고서 form을 공통 컴포넌트로 교체한다**

```tsx
<SelectBox label="순위 기준" items={metricItems} selectedKey={metric} onSelectionChange={(key) => setMetric(key as EnergyRankingMetric)} />
<DatePicker label="시작일" value={from} maxValue={to} onChange={(value) => value && setFrom(value)} />
<DatePicker label="종료일" value={to} minValue={from} onChange={(value) => value && setTo(value)} />
```

보고서 scope, target, format도 SelectBox로 교체하되 기존 request object를 변경하지 않는다. `defaultRange`는 date adapter를 사용해 local/UTC 날짜 이동을 제거한다.

- [ ] **Step 4: 페이지 layout·chart color·typography를 Tailwind token으로 전환한다**

Heading/Text/MetricCard/Card와 semantic chart token을 사용한다. Recharts prop에는 `themeColor("chart-usage")`처럼 Task 2 adapter를 전달한다. feature CSS를 새로 만들지 않는다.

- [ ] **Step 5: focused tests와 viewport E2E를 통과시킨다**

Run:

```bash
pnpm --filter @led-control/web test -- src/features/statistics
pnpm --filter @led-control/web exec playwright test e2e/statistics-flow.spec.ts --project=chromium
pnpm --filter @led-control/web ui:check
```

Expected: all commands exit 0 at 1440×900, 1024×768, 390×844 and 320×740 assertions.

- [ ] **Step 6: 문서와 커밋을 만든다**

`docs/menus/statistics.md`에 공통 날짜 UI, chart token, 남은 제한과 검증 명령을 기록한다.

```bash
git add apps/web/src/features/statistics apps/web/e2e/statistics-flow.spec.ts docs/menus/statistics.md
git commit -m "refactor(web): migrate statistics to design system"
```

### Task 7: 모니터링 페이지 migration

**Owner:** `모니터링 페이지 기능 개선`

**Files:**
- Modify: `apps/web/src/features/monitoring/MonitoringView.tsx`
- Modify: `apps/web/src/features/monitoring/FloorMap.tsx`
- Modify: `apps/web/src/features/monitoring/MonitoringView.test.tsx`
- Modify: `apps/web/src/features/monitoring/FloorMap.test.tsx`
- Modify: `apps/web/src/features/floor-map/FloorScene.tsx`
- Modify: `apps/web/src/features/floor-map/FloorScene.test.tsx`
- Modify: `apps/web/e2e/calm-operations-monitoring.spec.ts`
- Modify: `apps/web/e2e/monitoring-1000.spec.ts`
- Modify: `docs/menus/monitoring.md`

**Interfaces:**
- Consumes: SelectBox, Button/IconButton, FeedbackState, MetricCard, StatusBadge, Heading/Text and fixture tokens.

- [ ] **Step 1: 상태와 선택 control 계약 테스트를 추가한다**

```tsx
it("uses labelled design-system selectors and non-color status text", () => {
  renderMonitoring();
  expect(screen.getByRole("button", { name: "맵 선택" })).toBeVisible();
  expect(screen.getByText("점검 필요")).toBeVisible();
  expect(screen.getByText("오프라인")).toBeVisible();
});
```

- [ ] **Step 2: native select 때문에 실패하는지 확인한다**

Run: `pnpm --filter @led-control/web test -- src/features/monitoring src/features/floor-map`

Expected: design-system select role assertion fails.

- [ ] **Step 3: toolbar, floor/fixture 선택과 상태 카드를 전환한다**

floor/fixture native select를 SelectBox로 교체하고 기존 selected id state와 query key를 그대로 유지한다. refresh와 zoom actions는 Button/IconButton, 안내는 Text, 상태는 fixture token이 적용된 StatusBadge를 사용한다.

- [ ] **Step 4: 지도 예외 경계를 적용한다**

정적 shell, legend, toolbar와 panel은 Tailwind로 전환한다. `stageStyle`, `mapStyle`, pan/zoom 좌표와 runtime dimension만 inline style 또는 `exceptions.css`의 문서화된 custom property로 유지한다.

- [ ] **Step 5: 1,000개 조명과 반응형 회귀를 검증한다**

Run:

```bash
pnpm --filter @led-control/web test -- src/features/monitoring src/features/floor-map
pnpm --filter @led-control/web exec playwright test e2e/calm-operations-monitoring.spec.ts e2e/monitoring-1000.spec.ts --project=chromium
pnpm --filter @led-control/web ui:check
```

Expected: all commands exit 0; map pan/zoom and selection remain functional.

- [ ] **Step 6: 문서와 커밋을 만든다**

```bash
git add apps/web/src/features/monitoring apps/web/src/features/floor-map apps/web/e2e/calm-operations-monitoring.spec.ts apps/web/e2e/monitoring-1000.spec.ts docs/menus/monitoring.md
git commit -m "refactor(web): migrate monitoring to design system"
```

### Task 8: 제어와 automation migration

**Owner:** `제어 페이지 기능 개선`

**Files:**
- Modify: `apps/web/src/features/control/CommandHistoryPanel.tsx`
- Modify: `apps/web/src/features/control/CommandOutcomeActions.tsx`
- Modify: `apps/web/src/features/control/ControlTargetPicker.tsx`
- Modify: `apps/web/src/features/control/ControlView.tsx`
- Modify: `apps/web/src/features/control/FixtureGroupDialog.tsx`
- Modify: `apps/web/src/features/control/automation/ControlModeTabs.tsx`
- Modify: `apps/web/src/features/control/automation/ScheduleControlPanel.tsx`
- Modify: `apps/web/src/features/control/automation/ScheduleDialog.tsx`
- Modify: `apps/web/src/features/control/automation/VehicleEventControlPanel.tsx`
- Modify: `apps/web/src/features/control/automation/VehicleEventDialog.tsx`
- Modify: `apps/web/src/features/control/automation/components/AutomationQuickFields.tsx`
- Delete: `apps/web/src/features/control/useModalFocus.ts`
- Modify: `apps/web/src/features/control/CommandHistoryPanel.test.tsx`
- Modify: `apps/web/src/features/control/CommandOutcomeActions.test.tsx`
- Modify: `apps/web/src/features/control/ControlView.test.tsx`
- Modify: `apps/web/src/features/control/FixtureGroupDialog.test.tsx`
- Modify: `apps/web/src/features/control/automation/ScheduleControlPanel.test.tsx`
- Modify: `apps/web/src/features/control/automation/VehicleEventControlPanel.test.tsx`
- Modify: `apps/web/src/features/control/automation/components/AutomationQuickFields.test.tsx`
- Modify: `apps/web/e2e/calm-operations-manual-control.spec.ts`
- Modify: `apps/web/e2e/calm-operations-automation.spec.ts`
- Modify: `apps/web/e2e/automation-control-flow.spec.ts`
- Modify: `docs/menus/control.md`

**Interfaces:**
- Consumes: all Task 1~5 form, date/time, Slider, overlay and typography exports.

- [ ] **Step 1: 공통 control 사용과 값 보존 테스트를 추가한다**

```tsx
it("keeps schedule API strings while using design-system controls", async () => {
  renderScheduleDialog();
  await user.clear(screen.getByRole("textbox", { name: "스케줄 이름" }));
  await user.type(screen.getByRole("textbox", { name: "스케줄 이름" }), "야간 절전");
  await setTimeField("시작 시각", "22:30");
  await user.click(screen.getByRole("button", { name: "저장" }));
  expect(saveSchedule).toHaveBeenCalledWith(expect.objectContaining({ name: "야간 절전", startTime: "22:30" }));
});
```

- [ ] **Step 2: 현재 native time/date/range control로 실패하는지 확인한다**

Run: `pnpm --filter @led-control/web test -- src/features/control`

Expected: TimePicker/Slider interaction helper fails against native controls.

- [ ] **Step 3: 수동 제어와 그룹 dialog를 전환한다**

ControlTargetPicker의 select/checkbox/radio, ControlView의 brightness range/number와 FixtureGroupDialog의 fields를 공통 컴포넌트로 교체한다. brightness는 Slider와 NumberField가 하나의 number state를 공유하며 기존 0~100 validation을 유지한다.

- [ ] **Step 4: schedule와 vehicle event form을 전환한다**

ScheduleDialog의 time/date/number/select/checkbox, VehicleEventDialog와 AutomationQuickFields의 form controls를 교체한다. schedule/event에서 빈 값·범위 밖 값·소수점 중간 문자열을 검증해야 하는 숫자 입력은 TextField `inputMode="numeric" | "decimal"`을 사용하고, 수동 ControlView처럼 실제 number state인 brightness만 NumberField를 사용한다. DatePicker/TimePicker validation focus는 `FocusableFieldHandle`을 사용한다. 기존 `schedule-form.ts`, `vehicle-event-form.ts` validation과 API payload는 그대로 사용한다.

- [ ] **Step 5: 자체 dialog와 focus hook을 제거한다**

ScheduleDialog, VehicleEventDialog와 FixtureGroupDialog를 ModalDialog/ConfirmDialog로 구성하고 `useModalFocus.ts`를 삭제한다. caller의 opener ref를 `returnFocusRef`로 전달한다.

- [ ] **Step 6: focused tests와 제어 E2E를 통과시킨다**

Run:

```bash
pnpm --filter @led-control/web test -- src/features/control
pnpm --filter @led-control/web exec playwright test e2e/calm-operations-manual-control.spec.ts e2e/calm-operations-automation.spec.ts e2e/automation-control-flow.spec.ts --project=chromium
pnpm --filter @led-control/web ui:check
```

Expected: all commands exit 0 and command/schedule payload assertions are unchanged.

- [ ] **Step 7: 문서와 커밋을 만든다**

```bash
git add apps/web/src/features/control apps/web/e2e/calm-operations-manual-control.spec.ts apps/web/e2e/calm-operations-automation.spec.ts apps/web/e2e/automation-control-flow.spec.ts docs/menus/control.md
git commit -m "refactor(web): migrate control forms to design system"
```

### Task 9: 일반 설정 migration

**Owner:** `설정 페이지 기능 개선`

**Files:**
- Modify: `apps/web/src/features/settings/SettingsShell.tsx`
- Modify: `apps/web/src/features/settings/SettingsSubnavigation.tsx`
- Modify: `apps/web/src/features/settings/SettingsView.tsx`
- Modify: `apps/web/src/features/sites/SiteSwitcher.tsx`
- Modify: `apps/web/src/features/sites/SiteSwitcher.test.tsx`
- Modify: `apps/web/src/features/settings/security/AccountSecurityView.tsx`
- Modify: `apps/web/src/features/settings/security/PasswordSettingsView.tsx`
- Modify: `apps/web/src/features/settings/security/AccountSecurityView.test.tsx`
- Modify: `apps/web/src/features/settings/security/PasswordSettingsView.test.tsx`
- Modify: `apps/web/src/features/settings/site/SiteOperationsView.tsx`
- Modify: `apps/web/src/features/settings/site/SiteOperationsView.test.tsx`
- Delete: `apps/web/src/features/settings/site/SiteOperationsView.css`
- Modify: `apps/web/src/features/settings/users/DeleteSiteUserDialog.tsx`
- Modify: `apps/web/src/features/settings/users/ResetSiteUserPasswordDialog.tsx`
- Modify: `apps/web/src/features/settings/users/SiteUserFormDialog.tsx`
- Modify: `apps/web/src/features/settings/users/SiteUsersView.tsx`
- Modify: `apps/web/src/features/settings/users/SiteUsersView.test.tsx`
- Delete: `apps/web/src/features/settings/users/SiteUsersView.css`
- Modify: `apps/web/src/features/settings/SettingsShell.test.tsx`
- Modify: `apps/web/e2e/settings-operations.spec.ts`
- Modify: `apps/web/e2e/site-user-management.spec.ts`
- Modify: `docs/menus/settings.md`

**Interfaces:**
- Consumes: Task 1~5 form, typography and overlay exports.

- [ ] **Step 1: ref 기반 subnavigation과 공통 form 테스트를 작성한다**

```tsx
it("scrolls the active settings item through its registered ref", () => {
  renderSettingsAt("/settings/security");
  expect(scrollIntoView).toHaveBeenCalledOnce();
  expect(settingsSubnavigationSource).not.toMatch(/querySelector/);
});
```

- [ ] **Step 2: 기존 querySelector와 raw field 때문에 실패하는지 확인한다**

Run: `pnpm --filter @led-control/web test -- src/features/settings`

Expected: source assertion fails on `SettingsSubnavigation.tsx`.

- [ ] **Step 3: shell, security, site operation과 user form을 전환한다**

NavLink callback ref 또는 item ref map으로 활성 tab을 직접 보관한다. SiteSwitcher는 label 또는 `aria-label`을 가진 SelectBox로 바꾸고 SettingsShell 테스트의 native `combobox` 기대를 trigger `button`과 option keyboard 계약으로 갱신한다. dirty 상태에서 선택한 다음 현장 id를 SettingsShell state에 보관하고 ConfirmDialog 확인 뒤에만 draft 폐기와 navigate를 실행한다. AccountSecurity의 현재 세션 종료 `window.confirm`, PasswordSettings, SiteOperations, SiteUser form/reset/delete dialog도 TextField/PasswordField/SelectBox/Checkbox/ModalDialog/ConfirmDialog로 전환한다. 요금·정격전력처럼 문자열 중간 상태가 필요한 숫자 입력은 NumberField가 아니라 TextField `inputMode="decimal"`을 사용해 기존 validation과 payload 문자열을 보존한다.

- [ ] **Step 4: feature CSS를 제거하고 Tailwind로 옮긴다**

`SiteOperationsView.css`, `SiteUsersView.css`의 정적 규칙을 component utility로 옮기고 파일 import를 삭제한다. 공통 토큰이 부족하면 UI 기반 담당에게 추가 요청하고 직접 theme를 수정하지 않는다.

- [ ] **Step 5: focused tests와 settings E2E를 통과시킨다**

Run:

```bash
pnpm --filter @led-control/web test -- src/features/settings
pnpm --filter @led-control/web exec playwright test e2e/settings-operations.spec.ts e2e/site-user-management.spec.ts --project=chromium
pnpm --filter @led-control/web ui:check
```

Expected: all commands exit 0.

- [ ] **Step 6: 문서와 커밋을 만든다**

```bash
git add apps/web/src/features/settings apps/web/src/features/sites apps/web/e2e/settings-operations.spec.ts apps/web/e2e/site-user-management.spec.ts docs/menus/settings.md
git commit -m "refactor(web): migrate settings to design system"
```

### Task 10: 등록과 floor editor migration

**Owner:** `설정 페이지 기능 개선`, Task 9 이후

**Files:**
- Modify: `apps/web/src/features/registration/FixtureBatchForm.tsx`
- Modify: `apps/web/src/features/registration/FixtureIndividualForm.tsx`
- Modify: `apps/web/src/features/registration/RegistrationPanel.tsx`
- Modify: `apps/web/src/features/registration/RegistrationPanel.test.tsx`
- Modify: `apps/web/src/features/floor-editor/EditorBatchPlacementPanel.tsx`
- Modify: `apps/web/src/features/floor-editor/EditorFixtureNode.tsx`
- Modify: `apps/web/src/features/floor-editor/EditorLayersPanel.tsx`
- Modify: `apps/web/src/features/floor-editor/EditorMinimap.tsx`
- Modify: `apps/web/src/features/floor-editor/EditorPropertiesPanel.tsx`
- Modify: `apps/web/src/features/floor-editor/FixturePlacementAction.tsx`
- Modify: `apps/web/src/features/floor-editor/FixturePlacementList.tsx`
- Modify: `apps/web/src/features/floor-editor/FloorAssetUploadPanel.tsx`
- Modify: `apps/web/src/features/floor-editor/FloorEditorCanvas.tsx`
- Modify: `apps/web/src/features/floor-editor/FloorEditorView.tsx`
- Modify: `apps/web/src/features/floor-editor/FloorEditorView.test.tsx`
- Modify: `apps/web/src/features/settings/floor-plans/FloorEditorRoute.tsx`
- Modify: `apps/web/src/features/settings/floor-plans/FloorEditorRoute.test.tsx`
- Modify: `apps/web/src/features/settings/floor-plans/FloorPlanSettingsView.tsx`
- Modify: `apps/web/src/features/settings/floor-plans/FloorPlanSettingsView.test.tsx`
- Modify: `apps/web/src/features/setup/GatewayClaimPanel.tsx`
- Modify: `apps/web/src/features/setup/GatewayClaimPanel.test.tsx`
- Modify: `apps/web/src/features/setup/SetupWizard.tsx`
- Modify: `apps/web/src/features/setup/SetupWizard.test.tsx`
- Modify: `apps/web/src/features/rf/RfPlanningPanel.tsx`
- Modify: `apps/web/e2e/calm-operations-commissioning.spec.ts`
- Modify: `apps/web/e2e/floor-editor-layout.spec.ts`
- Modify: `apps/web/e2e/settings-floor-editor.spec.ts`
- Modify: `docs/menus/settings.md`
- Modify: `docs/menus/monitoring.md`

**Interfaces:**
- Consumes: Task 1~5 form and overlay exports; Konva runtime geometry remains an approved exception.

- [ ] **Step 1: 등록 값과 editor focus 회귀 테스트를 추가한다**

```tsx
it("submits the same batch registration payload through shared fields", async () => {
  renderRegistration();
  await user.type(screen.getByRole("textbox", { name: "조명 이름 접두어" }), "주차-");
  await user.click(screen.getByRole("button", { name: "선택 조명 등록" }));
  expect(registerFixtures).toHaveBeenCalledWith(expect.objectContaining({ namePrefix: "주차-" }));
});
```

- [ ] **Step 2: 공통 field role assertion이 실패하는지 확인한다**

Run: `pnpm --filter @led-control/web test -- src/features/registration src/features/floor-editor src/features/settings/floor-plans src/features/setup`

Expected: new shared-control assertion fails.

- [ ] **Step 3: 등록 form과 선택 UI를 전환한다**

RegistrationPanel, FixtureBatchForm, FixtureIndividualForm, GatewayClaimPanel과 SetupWizard의 select, checkbox, radio, text와 number controls를 공통 컴포넌트로 교체한다. 정격전력과 이름 자릿수처럼 문자열 중간 상태가 필요한 값은 TextField `inputMode="decimal" | "numeric"`을 사용한다. active session disable, registered-elsewhere, partial failure, gateway claim과 payload semantics를 유지한다. FloorAssetUploadPanel의 파일 입력은 FileField로 교체한다. 현재 route에서 노출하지 않는 RfPlanningPanel도 policy 위반이 남지 않게 공통 컴포넌트와 토큰으로 전환하되 새 route를 추가하지 않는다.

- [ ] **Step 4: floor editor의 정적 UI만 Tailwind로 전환한다**

list search, tabs, properties, batch placement, asset panel, actions와 confirm dialog를 공통 UI로 교체한다. Konva canvas position/scale, virtual list translate, minimap geometry는 inline runtime style로 유지하고 이유를 코드 주석과 `exceptions.css` allowlist에 기록하도록 UI 기반 담당에게 요청한다. FloorEditorCanvas, EditorFixtureNode와 EditorMinimap의 정적 raw color는 `themeColor()` adapter로 교체하고 geometry 예외로 남기지 않는다. FixturePlacementAction과 FixturePlacementList는 callback ref registry를 공유해 production `document.querySelector`를 제거한다.

- [ ] **Step 5: `window.confirm`을 공통 ConfirmDialog로 교체한다**

FloorEditorRoute의 dirty navigation은 pending destination을 state로 저장하고, 확인 시 저장된 action을 실행한다. browser unload의 native `beforeunload` prompt는 브라우저 제약으로 유지한다.

`settings-floor-editor.spec.ts`에서 현장 선택기를 찾는 native `combobox` selector는 Task 9의 SelectBox trigger `button`과 option 선택 계약으로 갱신한다.

- [ ] **Step 6: registration/floor tests와 E2E를 통과시킨다**

Run:

```bash
pnpm --filter @led-control/web test -- src/features/registration src/features/floor-editor src/features/settings/floor-plans src/features/setup
pnpm --filter @led-control/web exec playwright test e2e/calm-operations-commissioning.spec.ts e2e/floor-editor-layout.spec.ts e2e/settings-floor-editor.spec.ts --project=chromium
pnpm --filter @led-control/web ui:check
```

Expected: all commands exit 0 and canvas pan/zoom/placement remains unchanged.

- [ ] **Step 7: 문서와 커밋을 만든다**

```bash
git add apps/web/src/features/registration apps/web/src/features/floor-editor apps/web/src/features/settings/floor-plans apps/web/src/features/setup apps/web/src/features/rf apps/web/e2e/calm-operations-commissioning.spec.ts apps/web/e2e/floor-editor-layout.spec.ts apps/web/e2e/settings-floor-editor.spec.ts docs/menus/settings.md docs/menus/monitoring.md
git commit -m "refactor(web): migrate commissioning UI system"
```

### Task 11: shell, 인증과 운영자 화면 migration

**Owner:** `Shell·인증·운영 UI 개선`

**Files:**
- Modify: `apps/web/src/App.tsx`
- Modify: `apps/web/src/AppRoot.tsx`
- Modify: `apps/web/src/features/shells/CustomerShell.tsx`
- Modify: `apps/web/src/features/shells/SettingsNavigationItem.tsx`
- Modify: `apps/web/src/features/auth/AuthView.tsx`
- Modify: `apps/web/src/features/auth/RequiredPasswordChangeView.tsx`
- Modify: `apps/web/src/features/auth/AuthView.test.tsx`
- Modify: `apps/web/src/features/auth/RequiredPasswordChangeView.test.tsx`
- Delete: `apps/web/src/features/auth/RequiredPasswordChangeView.css`
- Modify: `apps/web/src/features/operator/OperatorShell.tsx`
- Modify: `apps/web/src/features/operator/OperatorShell.test.tsx`
- Modify: `apps/web/src/features/operator/site-admins/DeleteSiteDialog.tsx`
- Modify: `apps/web/src/features/operator/site-admins/ResetAdminPasswordDialog.tsx`
- Modify: `apps/web/src/features/operator/site-admins/SiteAdminFormDialog.tsx`
- Modify: `apps/web/src/features/operator/site-admins/SiteAdminManagementView.tsx`
- Modify: `apps/web/src/features/operator/site-admins/SiteAdminManagementView.test.tsx`
- Modify: `apps/web/src/features/shells/CustomerShell.monitoring.test.tsx`
- Modify: `apps/web/src/features/shells/CustomerShell.test.tsx`
- Modify: `apps/web/src/features/shells/SettingsNavigationItem.test.tsx`
- Modify: `apps/web/e2e/calm-operations-auth-operator.spec.ts`
- Modify: `apps/web/e2e/calm-operations-shell.spec.ts`
- Modify: `apps/web/e2e/app-shell-recovery.spec.ts`
- Modify: `docs/menus/monitoring.md`
- Modify: `docs/menus/control.md`
- Modify: `docs/menus/statistics.md`
- Modify: `docs/menus/settings.md`

**Interfaces:**
- Consumes: Task 1~5 TextField/PasswordField/Checkbox, Button/IconButton, Card, FeedbackState/RouteLoadingState, Modal/ConfirmDialog, typography and navigation primitives.

- [ ] **Step 1: 인증 payload와 shell confirmation 회귀 테스트를 작성한다**

```tsx
it("keeps login credentials unchanged through shared fields", async () => {
  renderAuth();
  await user.type(screen.getByRole("textbox", { name: "아이디" }), "admin");
  await user.type(screen.getByLabelText("비밀번호"), "secret");
  await user.click(screen.getByRole("button", { name: "로그인" }));
  expect(login).toHaveBeenCalledWith({ loginId: "admin", password: "secret", rememberMe: true });
});

it("uses an accessible confirmation dialog for dirty logout", async () => {
  renderDirtyShell();
  await user.click(screen.getByRole("button", { name: "로그아웃" }));
  expect(screen.getByRole("alertdialog", { name: "로그아웃 확인" })).toBeVisible();
});
```

- [ ] **Step 2: 현재 raw auth input와 window.confirm으로 실패하는지 확인한다**

Run: `pnpm --filter @led-control/web test -- src/App.test.tsx src/features/auth src/features/shells src/features/operator`

Expected: alertdialog assertion fails against `window.confirm`.

- [ ] **Step 3: App loading/recovery와 CustomerShell을 전환한다**

App.tsx의 auth loading panel을 RouteLoadingState로 바꾸고 `styles.css` import는 유지한다. CustomerShell의 responsive layout, navigation, site badge와 logout을 Tailwind token으로 전환하고 Task 9가 제공한 SiteSwitcher를 소비한다. dirty logout은 boolean state와 ConfirmDialog로 처리하며 기존 command/editor guard를 유지한다.

- [ ] **Step 4: Auth와 required-password form을 전환한다**

AuthView의 loginId/password/MFA/remember fields와 RequiredPasswordChangeView의 password fields를 공통 컴포넌트로 교체한다. autoComplete, min/max length, initial focus, error announcement와 기존 auth API payload를 보존한다.

- [ ] **Step 5: operator dialog와 form을 통합한다**

SiteAdminFormDialog, ResetAdminPasswordDialog, DeleteSiteDialog를 공통 overlay와 fields로 교체한다. 현재 operator dialog focus code와 `querySelector`를 제거한다. 현장 삭제 action label은 실제 범위가 드러나도록 기존 테스트 기대와 메뉴 문서를 확인해 일관되게 유지한다.

- [ ] **Step 6: shell/auth/operator focused tests와 E2E를 통과시킨다**

Run:

```bash
pnpm --filter @led-control/web test -- src/App.test.tsx src/App.recovery.test.tsx src/features/auth src/features/shells src/features/operator
pnpm --filter @led-control/web exec playwright test e2e/calm-operations-auth-operator.spec.ts e2e/calm-operations-shell.spec.ts e2e/app-shell-recovery.spec.ts --project=chromium
pnpm --filter @led-control/web ui:check
```

Expected: all commands exit 0; login, MFA, password change, logout and operator CRUD payloads are unchanged.

- [ ] **Step 7: 커밋한다**

네 메뉴 문서에 공통 shell/auth 변경의 적용 범위, 자동 browser 증거와 실제 장비 검증이 아니라는 경계를 동일하게 기록한다.

```bash
git add apps/web/src/App.tsx apps/web/src/AppRoot.tsx apps/web/src/features/shells apps/web/src/features/auth apps/web/src/features/operator apps/web/e2e/calm-operations-auth-operator.spec.ts apps/web/e2e/calm-operations-shell.spec.ts apps/web/e2e/app-shell-recovery.spec.ts docs/menus/monitoring.md docs/menus/control.md docs/menus/statistics.md docs/menus/settings.md
git commit -m "refactor(web): migrate shell auth and operator UI"
```

### Task 12: legacy CSS 제거, zero-baseline과 전체 회귀 검증

- [ ] **정책 CI 연결:** `ui:check`와 `test:ui-policy`를 canonical Web/CI 검증에 연결한다. CI checkout에서 정책의 신뢰 Git commit object를 확보하고, 누락을 skip하지 않고 fail-closed하는지 확인한다.

**Owner:** `서비스 UI 개선`이 CSS를 정리하고, 총괄이 최종 검증·통합한다.

**Files:**
- Modify: `apps/web/src/styles.css`
- Modify: `apps/web/src/styles/theme.css`
- Modify: `apps/web/src/styles/exceptions.css`
- Modify: `apps/web/scripts/ui-policy-baseline.json`
- Delete: `apps/web/src/components/ConfirmDialog.tsx`
- Modify: `apps/web/src/components/ui/index.ts`
- Modify: `apps/web/e2e/layout-assertions.spec.ts`
- Modify: `apps/web/e2e/support/layout-assertions.ts`
- Modify: all affected `docs/menus/*.md`
- Modify: `docs/ui-spacing.md`
- Modify: this plan checklist

**Interfaces:**
- Consumes: all page migration commits. Produces a zero-baseline policy and final public UI API.

- [ ] **Step 1: zero-baseline을 요구하는 실패 검사를 작성한다**

```js
test("production UI has no legacy policy violations", async () => {
  const result = await inspectWorkspace({ baseline: {} });
  assert.deepEqual(result.violations, []);
});
```

- [ ] **Step 2: 남은 legacy CSS 때문에 실패하는지 확인한다**

Run: `node --test apps/web/scripts/ui-policy.test.mjs && pnpm --filter @led-control/web ui:check`

Expected: FAIL and print exact remaining files/rules.

- [ ] **Step 3: 사용하지 않는 global selector와 legacy adapter를 제거한다**

각 selector를 `rg`로 production 사용처가 0인지 확인한 뒤 `styles.css`에서 제거한다. 사용처가 남아 있으면 해당 소유 세션으로 돌려보내고 총괄/UI 기반 세션이 페이지 파일을 대신 수정하지 않는다. legacy `components/ConfirmDialog.tsx` import가 0이면 파일을 삭제한다.

- [ ] **Step 4: 허용 예외만 남기고 baseline을 0으로 만든다**

Konva/Recharts runtime geometry와 keyframe 예외에는 이유 주석이 있어야 한다. `ui-policy-baseline.json`은 빈 violation map이어야 하며 production `querySelector`, arbitrary spacing/color, raw color와 raw spacing이 0이어야 한다.

- [ ] **Step 5: unit, typecheck와 build를 실행한다**

Run:

```bash
pnpm --filter @led-control/web test
pnpm --filter @led-control/web typecheck
pnpm --filter @led-control/web build
pnpm --filter @led-control/web ui:check
```

Expected: all commands exit 0 with zero failed tests.

- [ ] **Step 6: 전체 browser 회귀를 실행한다**

Run: `pnpm --filter @led-control/web exec playwright test`

Expected: all configured Playwright projects pass; no horizontal document overflow at the four target viewports.

- [ ] **Step 7: 문서 일치와 diff를 검증한다**

Run:

```bash
rg -n "Tailwind|React Aria|검증" docs/ui-spacing.md docs/menus/monitoring.md docs/menus/control.md docs/menus/statistics.md docs/menus/settings.md
git diff --check
git status --short
```

Expected: all menu docs describe applied scope and remaining hardware/mock limits; diff check exits 0; only intended files are modified.

- [ ] **Step 8: 최종 정리 커밋을 만든다**

```bash
git add apps/web/src/styles.css apps/web/src/styles apps/web/src/components apps/web/scripts docs/ui-spacing.md docs/menus docs/superpowers/plans/2026-09-15-tailwind-design-system-migration.md
git commit -m "refactor(web): complete Tailwind UI migration"
```

## 총괄 체크포인트

- [x] 확정 설계 승인과 작업 세션별 구현 계획 작성을 완료한다.
- [ ] Task 1~5의 각 커밋과 focused test 증거를 확인한다.
- [ ] foundation HEAD를 Task 6~11 담당 세션에 전달한다.
- [ ] Task 6 pilot 결과로 공통 API 변경이 필요하면 UI 기반 세션에서만 수정·검증한다.
- [ ] Task 7, 8, 9를 소유 파일 기준으로 병렬 진행한다.
- [ ] Task 9 통과 뒤 Task 10을 시작하고, Task 10 통과 뒤 Task 11을 시작한다.
- [ ] 각 담당 세션의 결과는 보고만 믿지 않고 diff와 검증 명령을 총괄이 재실행한다.
- [ ] Task 12에서 정책 baseline 0, 전체 Web test/typecheck/build/E2E를 확인한다.
- [ ] 완료된 커밋을 `codex/mvp1-cloud-web`에 순서대로 통합하고 최종 결과를 사용자에게 보고한다.
