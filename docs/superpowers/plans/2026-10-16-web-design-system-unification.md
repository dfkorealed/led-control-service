# 전체 Web 공통 디자인 시스템 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 현장 운영·시설관리 담당자가 상태·대상·조작 결과를 편하게 읽고 작업하도록 전체 Web의 공통 디자인 역할을 일관되게 적용한다.

**Architecture:** canonical theme를 변경하지 않고 공통 layout/title/panel API를 후방 호환 opt-in으로 확장한다. 공통 소비 계약을 먼저 검증하고 고객·운영자·인증·공개 및 상태 화면을 순차 전환한다. 브랜드 구성·workspace geometry·도메인 수명은 보존한다.

**Tech Stack:** React18, TypeScript, Tailwind4.3.3, React Aria Components, React Query, Vitest, Playwright Chromium, pnpm9.15.0.

**Spec:** [전체 적용 설계](../specs/2026-10-15-web-design-system-unification-design.md), [정확한 값과 역할 가이드](../../ui-design-system.md).

상태: 2026-10-16 사용자가 상세 기준의 공통 컴포넌트·전체 Web 적용과 분리 작업공간 실행을 승인했다. `codex/web-design-system-unification-20261016`에서 Task1·2 구현·독립 검토와 보완 재검토를 완료하고 Task3를 시작한다. 아래 체크박스는 검증·독립 검토가 끝난 실제 단계만 완료한다. 전체 unit5FAIL은 남아 있고 Task1 추가 관측 browser3FAIL은 Task2에서 전제·의미를 검증해 실제 흐름 PASS로 확인했다. 운영 서비스·DB·장비 작업은 포함하지 않는다.

## Global Constraints

- 일반 functional 계약: section20px, card grid18px, regular panel desktop20/mobile16px, page title26/mobile24px, section title20px, card title16px, 실제 hit≥44×44px. 기존52px 이상 control 보존.
- 고객·운영자 일반 문서 main 외곽은 PC좌우28/상하24px·compact좌우14/상하18px 목표다. 인증 fullscreen composition·공개·workspace 목적 frame에는 이 gutter를 강제하지 않는다.
- font/body/caption/색/radius의 정확 값과 목적 예외는 중앙 guide 표를 따른다. 지원한 고객 light/dark만 사용하며 새 테마·기능·리브랜딩을 추가하지 않는다.
- theme738선언, 승인 anchor `e841c57b11321a5ae35d15920031020089f06ee2`, 빈 `files: {}` baseline 보존. 새 semantic token이 필요하면 해당 작업을 분리하고 독립 승인 전 token/policy 변경 금지.
- API/data/auth/session/principal/cache/비밀 입력·command safety·pending/disabled·등록·PDF/다운로드 계약 보존. backend/DB/장비/실제 서비스 재시작·배포 금지.
- floor editor 최소256px, 수동 지도 실제 content588px split, 높이·scroll owner·선택·배율·dirty draft 및 이전8수리 보존.
- 고객12leaf/전체15surface=12−control1+manual/schedule/event/group4mode. public3page의 main/landing/service entry는 각각 검증하되 page 중복 집계 금지. operator4route, auth gate/state, overlay/error/recovery/404/bootstrap 포함.
- HTML14는 제품entry4/React concept1/archive5/smoke4 inventory다. archive 재디자인·smoke 제품화 금지. 공개상담은 tel/mailto modal이며 inquiry API가 아니다.
- 실제 mock-only Chromium만 사용한다. 기존5173/4000에 접속·중단·재사용하지 않는다. 소유 Vite port15341, `--strictPort`, `reuseExistingServer:false`, workers1 고정. 점유되면 기존 process를 종료하지 않고 실패한다.
- 모든 브라우저 시나리오는 API를 route mock으로 선차단하고 service worker를 차단한다. 미등록 API·외부 write는 abort+실패한다. real-backend lab/사용자 DB/실제 인증 mutation·메일·장비 경로 실행 금지.
- 변경 메뉴8개는 기존 문서 구성을 유지하고 영향받은 모든 문서를 같은 작업에서 갱신한다. 사용자 dirty AGENTS/status와 외부 변경을 stage하지 않는다.

## Review Focus

1. 같은 view의 loaded→pending→error→empty 전환에도 page/section wrapper와 제목 위계가 유지되는지: Task1/2의 상태 matrix가 wrapper 역할·gap을 단언한다.
2. security 요청 중 A→B principal 교체 시 늦은 응답·secret·focus가 B에 섞이지 않는지: Task2의 기존 보안 회귀와 새 presentation 양쪽 검증에서 단언한다.
3. 320×600·긴 ID/UUID/한국어와 content587/588/589px에서 reader·안전 action·선택이 유지되는지: Task4의 이전8수리 실제 tap/wheel/Range 회귀가 단언한다.
4. 같은 공개 page를 main/landing/service로 열 때 브랜드·연락·로그인과 private module 경계가 유지되는지: Task5의 mode matrix가 API비호출·연락href·직접URL·404를 단언한다.
5. 기존 실패6unit/6locator가 가려지거나 새 회귀가 같은 항목으로 오인되지 않는지: Task1 fresh baseline을 Task6 독립 QA가 원 assertion·소스·재현조건으로 대조한다. 로그표만으로 동일 원인을 자동 증명하지 않는다.

---

## 공통 파일 구조와 확정 인터페이스

신규 파일은 아래 Task의 Create 목록에만 만든다. 기존 큰 feature의 무관한 구조 분해는 하지 않는다. 모든 source 상대 경로는 저장소 루트 기준이다.

```ts
// Create apps/web/src/components/ui/FunctionalLayout.tsx
export type PanelPadding = "none" | "customer" | "regular" | "compact";
export function panelPaddingClass(padding: PanelPadding): string;
// none="", customer/regular="p-5 max-compact:p-4", compact="p-4"
export interface FunctionalLayoutProps extends React.HTMLAttributes<HTMLElement> {
  as?: "div" | "section"; children: React.ReactNode;
}
export const PageStack: React.ForwardRefExoticComponent<FunctionalLayoutProps & React.RefAttributes<HTMLElement>>;
export const CardGrid: React.ForwardRefExoticComponent<FunctionalLayoutProps & React.RefAttributes<HTMLElement>>;
// PageStack grid min-w-0 content-start gap-5; CardGrid grid min-w-0 gap-4.5
// column/responsive geometry remains caller-owned; ref/aria/data/rest forwarding preserved.

// Modify PageHeader.tsx: existing props retain names/defaults.
export type TitleRole = "page" | "section" | "card";
// PageHeaderProps adds titleRole?: TitleRole.
// omitted: legacy variant customer -> customer-page-title, default -> section-title.
// explicit: page -> customer-page-title; section -> customer-section-title;
// card -> customer-card-title. headingLevel remains semantic only.

// CardProps.padding?: PanelPadding; default remains none, customer alias retained.
// SidePanelProps adds padding?: PanelPadding; default none; same recipe.
// ModalDialogProps/DrawerDialogProps public interface unchanged.
// AccountSecurityView props adds presentation?: "customer" | "operator";
// default customer for compatibility; both shells pass it explicitly.
```

## Task 1: 공통 layout·제목·panel 계약과 정본 참조

**Files:**
- Create: `apps/web/playwright.design-system.config.ts`
- Create: `apps/web/e2e/support/design-system-fixture.ts`
- Create/Test: `apps/web/e2e/design-system-foundation.spec.ts`
- Create: `docs/assets/web-design-system-2026-10-16/baseline.md`
- Create: `apps/web/src/components/ui/FunctionalLayout.tsx`
- Create/Test: `apps/web/src/components/ui/functional-layout.test.tsx`
- Modify: `apps/web/src/components/ui/{Button,Card,SidePanel,PageHeader}.tsx`, `apps/web/src/components/ui/index.ts`
- Modify: `docs/ui-spacing.md`, `docs/ui-design-system.md`
- Test: 기존 `apps/web/src/components/ui/ui-primitives.test.tsx`

**Interfaces:** 위 공통 인터페이스를 생산한다. 기존 Card tone/variant, padding none/customer, SidePanel surface, PageHeader headingLevel/variant/default는 보존한다.

```ts
// design-system-fixture.ts; 기존 mock-api-boundary/settings-api를 소비한다.
export type DesignScenario = {
  principal: "admin" | "viewer" | "operator" | "anonymous";
  state: "ready" | "pending" | "paused" | "empty" | "error";
  theme?: "light" | "dark";
};
export const test: import("@playwright/test").TestType<
  import("@playwright/test").PlaywrightTestArgs &
  import("@playwright/test").PlaywrightTestOptions & {
    designScenario: (scenario: DesignScenario) => Promise<void>
  },
  import("@playwright/test").PlaywrightWorkerArgs &
  import("@playwright/test").PlaywrightWorkerOptions
>;
export { expect } from "@playwright/test";
// 같은 support 파일에서 foundation memory fixture의 수명을 소유한다.
export function mountFoundationFixture(
  page: import("@playwright/test").Page
): Promise<{ close(): Promise<void> }>;
```

- [x] **Step 0 준비: dependency 생성.** baseline unit과 모든 leaf 검증 전에 저장소 루트 `pnpm workspace:prepare`를 선행하고 성공을 확인한다. 준비 실패를 test skip이나 이전 dist 재사용으로 통과시키지 않는다.
- [x] **Step 0a: runner·fixture 작성.** config는 workers1/serviceWorkers block, 소유127.0.0.1:15341/strictPort/reusefalse이며 command는 `pnpm --filter @led-control/web exec vite --host 127.0.0.1 --port 15341 --strictPort`다. testMatch는 `design-system-{foundation,roles,coverage}.spec.ts`, `ui-eight-layout-regressions.spec.ts`, `account-security.spec.ts`, `calm-operations-auth-operator.spec.ts`다. 자체 production build/ephemeral server를 쓰는 `ui-overlays.spec.ts`는 여기서 제외하고 기존 ui-cascade config로 실행한다.
- [x] **Step 0b: 네트워크 방어 RED→GREEN.** 기존 `installMockApiBoundary(context,baseURL)`의 context fallback을 재사용해 기존 page.route LIFO 도메인mock이 우선하도록 한다. context에서 미등록API404·외부POST abort를 관찰하고 보통 시나리오에서는 실패시킨다. 아래 방어test만 예상sentinel을 수집해 일치하면 PASS한다. WebSocket/sendBeacon 차단과 unsupported theme setup 실패도 확인한다.

```ts
test("fixture blocks unknown API and external POST", async ({ page }) => {
  // 이 test만 예상 차단 sentinel을 검사하고 일반 auto-failure를 유예한다.
  await page.goto("/");
  const result = await page.evaluate(async () => ({
    api: await fetch("/api/not-configured").then(r => r.status),
    external: await fetch("https://blocked.invalid/", { method: "POST" })
      .then(() => "sent", () => "blocked")
  }));
  expect(result).toEqual({ api: 404, external: "blocked" });
});
```

- [x] **Step 0c: fresh baseline.** 제품 적용 전에 전체 Web unit과 기존 선정 browser를 소유 runner에서 실행하고 원6unit/6locator 각각의 source·assertion·재현조건·로그를 baseline.md에 기록한다. 기존 source 누락이면 전제 오류로 중단한다. `pnpm --filter @led-control/web test`·browser 실제 명령을 저장하며 이전32PASS를 fresh 결과로 쓰지 않는다. fixture 방어 test는 `pnpm --filter @led-control/web exec playwright test --config=playwright.design-system.config.ts e2e/design-system-foundation.spec.ts --grep fixture`로 실행하고 방어 제거 시 FAIL/적용 시PASS를 확인한다.

- [x] **Step 1: 실패 검증 작성.** `functional-layout.test.tsx`에 regular/customer 동등·compact16·none무padding, PageStack20/CardGrid18, ref/rest forwarding을 검증한다. `titleRole`별 page/section/card와 h3+section 조합, 미전달 legacy 매핑을 단언한다. source 문자열만 검사하지 말고 렌더된 구조·컴파일 검증용 fixture를 제공한다.

```tsx
it("keeps heading semantics ref and explicit role", () => {
  const ref = createRef<HTMLElement>();
  render(<PageHeader ref={ref} title="현장 구성" headingLevel={3} titleRole="section" data-testid="header" />);
  expect(screen.getByRole("heading", { level: 3 })).toHaveClass("text-card-title");
  expect(ref.current).toBe(screen.getByTestId("header"));
});
test("functional computed spacing and actual control size", async ({ page }) => {
  const fixture = await mountFoundationFixture(page);
  try {
    expect(await page.getByTestId("page-stack").evaluate(e => getComputedStyle(e).gap)).toBe("20px");
    expect(await page.getByTestId("card-grid").evaluate(e => getComputedStyle(e).gap)).toBe("18px");
    expect(await page.getByTestId("regular-panel").evaluate(e => getComputedStyle(e).paddingTop))
      .toBe(page.viewportSize()!.width < 760 ? "16px" : "20px");
    const box = await page.getByRole("button", { name: "확인", exact: true }).boundingBox();
    expect(box!.width).toBeGreaterThanOrEqual(44);
    expect(box!.height).toBeGreaterThanOrEqual(44);
  } finally { await fixture.close(); }
});
```

`mountFoundationFixture`는 기존 ui-overlays의 `write:false` Vite production memory 패턴으로 실제 FunctionalLayout/Card/PageHeader/Button과 canonical styles.css를 build한다. 소유127.0.0.1 ephemeral server에만 결과를 제공하고 그 origin의 context boundary를 등록한 뒤 page.goto한다. 자기 origin 밖 네트워크는 차단한다. 일반 앱의15341 fallback과 다른 origin이며 해당 boundary를 분리해 교차 허용하지 않는다. close는 등록 route·memory server를 정리한다. 제품 test route와 디스크 제품 산출물은 추가하지 않는다.
- [x] **Step 2: RED 실행.** `pnpm --filter @led-control/web exec vitest run src/components/ui/functional-layout.test.tsx` → 아직 API가 없어 FAIL. 구현 뒤 의미실패를 보려면 regular mapping과 section title mapping을 각각 국소 변조한 테스트 copy에서20/16·20/28 단언 FAIL을 확인한다. import 오류만을 역할 RED 근거로 쓰지 않는다.
- [x] **Step 3: 최소 구현.** 위 API를 구현·index.ts export하고 기존 미전달 소비는 변경하지 않는다. 일반 Button에 min-width44를 추가하고 기존 더 큰 너비와 landing의 등록geometry를 보존한다. Button sizes/variant·IconButton 회귀를 포함한다. 고객용 이름을 일반 역할로 재사용하되 토큰값은 바꾸지 않는다. foundation computed fixture는 기존 ui-cascade의 memory production 패턴을 사용하며 제품 test route를 추가하지 않는다.
- [x] **Step 4: GREEN 검증.** 위 focused 명령과 `pnpm --filter @led-control/web exec vitest run src/components/ui/ui-primitives.test.tsx` PASS. Task1 foundation browser에서 generated CSS/computed20/18/20·16 및26·24/20/16을 확인하고 Task6에서 전체 소비자를 확인한다. 일반 control은 높이뿐 아니라 폭도44px 이상이며 clip·가림을 제외한 실제44×44 hit가 있는지 검사한다. inline/brand는 등록된 정확한 소비 예외만 판정한다.
- [x] **Step 5: 정본 전환.** 승인된 계획 실행의 최초 기반 작업으로 ui-spacing 현행 규칙을 guide 참조로 정리하고 역사 기록을 분리 표시한다. 이전 승인/실패 수치·앵커 이력은 보존하고 coverage와 규범 효력을 분리한다.
- [x] **Step 6: 독립 검토·소유 commit.** 이 Task Files의 실제 변경 파일만 선택 stage하고 diff·`git diff --check` 확인 후 `git commit -m "refactor(web): define functional layout and title contracts"`. AGENTS/status의 타 소유 변경은 제외한다. token/policy 무변경과 legacy API 보존을 제출한다.

## Task 2: 공통 상태·overlay와 인증·운영자·공유 보안

**Files:**
- Modify: `apps/web/src/components/ui/overlays/DialogBase.tsx`, `apps/web/src/components/ui/{FeedbackState,RouteLoadingState,AppRecoveryState}.tsx`
- Modify: `apps/web/src/features/auth/{AuthView,RequiredPasswordChangeView}.tsx`
- Modify: `apps/web/src/features/operator/{OperatorShell,SensorProfilesView,LandingInquiriesView}.tsx`, `apps/web/src/features/operator/site-admins/SiteAdminManagementView.tsx`
- Modify: `apps/web/src/features/settings/security/AccountSecurityView.tsx`, `apps/web/src/features/shells/CustomerShell.tsx`
- Test: `apps/web/src/features/{auth/AuthView,auth/RequiredPasswordChangeView,operator/OperatorShell,settings/security/AccountSecurityView}.test.tsx`
- Modify/Test: `apps/web/e2e/{account-security,calm-operations-auth-operator,ui-overlays}.spec.ts`
- Create/Test: `apps/web/e2e/design-system-security.spec.ts` (Task1 config testMatch에 이 파일도 추가)
- Modify: `apps/web/playwright.design-system.config.ts` (security spec testMatch 추가)
- Modify: `docs/menus/{operator,settings}.md` 및 공통 상태가 영향을 주는 다른 메뉴 문서

**Interfaces:** Task1의 PageStack/CardGrid/panelPaddingClass/titleRole을 소비한다. `AccountSecurityView({user, presentation="customer"}: {user:AuthUser; presentation?:"customer"|"operator"}): JSX.Element` 생산. auth·overlay public API는 그대로다.

- [x] **Step 1: 실패 검증 작성.** 기존 보안 단위에 customer/operator presentation에서 동일 regular 카드와 단일 shell h1을 단언한다. A→B principal 전환 중 MFA/session 지연 응답·secret remount·다른 세션 revoke 회귀를 유지한다. auth ready/pending/error/MFA/recovery와 operator loading/empty/error가 같은 wrapper를 소비하는지 단언한다. OperatorShell 일반 main은 PC좌우28/상하24px·compact좌우14/상하18px를 computed로 단언한다.

```ts
test("security regular inset and modal return focus", async ({ page, designScenario }) => {
  await designScenario({ principal: "admin", state: "ready", theme: "light" });
  await page.goto("/settings/security");
  expect(await page.locator('[data-security-card="mfa"]').evaluate(e => getComputedStyle(e).paddingTop))
    .toBe(page.viewportSize()!.width < 760 ? "16px" : "20px");
  const trigger = page.getByRole("button", { name: "비밀번호 변경", exact: true });
  await trigger.click();
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
});
```

기존 AccountSecurityView 단위에 test `late MFA response after principal switch does not publish secret`를 추가한다. A enrollment promise를 보류하고 B user로 rerender한 뒤 B status query가 `{enabled:false,enabledAt:null}`로 실제 완료되는 것을 기다린다. A 응답 `{secret:"A-secret",recoveryCodes:["A-code"]}`를 resolve한 뒤 `expect(screen.queryByText("A-secret")).not.toBeInTheDocument()`, `expect(screen.queryByDisplayValue("A-secret")).not.toBeInTheDocument()`, `expect(queryClient.getQueryData(["auth","mfa",principalKey(userB)])).toEqual({enabled:false,enabledAt:null})`를 단언한다. userB/queryClient는 해당 test의 실제 fixture이며 빈 query로 통과하지 않게 한다. 기존 mounted/principal cache 방어 단언은 유지한다.
- [x] **Step 2: RED 실행.** `pnpm --filter @led-control/web exec vitest run src/features/auth/AuthView.test.tsx src/features/auth/RequiredPasswordChangeView.test.tsx src/features/operator/OperatorShell.test.tsx src/features/settings/security/AccountSecurityView.test.tsx` → 새 regular/역할 단언 FAIL과 기존 실패 baseline을 구분한다.
- [x] **Step 3: 최소 구현.** 일반 card20/16·grid18·section20·명시 titleRole을 적용한다. 보안 presentation을 양 shell에서 전달한다. operator max1160과 auth 소개/form 구성은 보존한다. loaded/pending/error/empty의 wrapper만 통일하고 query·권한·조건·문구 의미를 바꾸지 않는다.
- [x] **Step 4: overlay 내용 정합화.** DialogBase의 modal/drawer 일반 내용 inset을 공통 regular recipe로 적용하고 feature의 상충 inset override를 제거한다. backdrop·최대폭·safe-area·sheet/workspace geometry·단일 reader·52px close·pending 차단·RAC/ref/focus stack은 유지한다. feedback는 기존 semantic 역할과 liveRole을 보존한다.
- [x] **Step 5: GREEN 검증.** Step2 focused PASS 및 Task1 mock config로 account-security·calm-operations-auth-operator 실행. overlay는 `pnpm --filter @led-control/web exec playwright test --config=playwright.ui-cascade.config.ts e2e/ui-overlays.spec.ts`로 분리한다. narrow 실제 focus/Tab/Escape/복귀·긴reader·disabled action과 computed inset을 확인한다. FormField primary help 보정을 유지한다.
- [x] **Step 6: 문서·독립 검토·commit.** 영향 메뉴의 software/mock 한계를 갱신하고 이 Task Files의 실제 변경만 선택 stage한다. AGENTS/status 타 소유 변경 제외 후 `git commit -m "refactor(web): align auth operator and overlay presentation"`. principal/secret/domain 무변경 근거 제출.

## Task 3: P3 여섯 항목과 고객 설정·통계 소비

**Files:**
- Modify: `apps/web/src/features/monitoring/MonitoringView.tsx`
- Modify: `apps/web/src/features/settings/{SettingsView,SettingsShell}.tsx`, `apps/web/src/features/settings/site/SiteOperationsView.tsx`, `apps/web/src/features/settings/floor-plans/FloorPlanSettingsView.tsx`
- Modify: `apps/web/src/features/settings/users/SiteUsersView.tsx`, `apps/web/src/features/settings/registration/RegistrationSettingsView.tsx`, `apps/web/src/features/settings/security/PasswordSettingsView.tsx`
- Modify: `apps/web/src/features/statistics/{StatisticsShell,StatisticsOverviewPage}.tsx`, `apps/web/src/features/statistics/analysis/{StatisticsAnalysisPage,EnergyHeatmap}.tsx`, `apps/web/src/features/statistics/reports/StatisticsReportsPage.tsx`
- Modify: `apps/web/src/features/statistics/analysis/EnergyRankingDetailPanel.tsx`
- Test: `apps/web/src/features/settings/site/SiteOperationsView.test.tsx`, `apps/web/src/features/statistics/StatisticsShell.test.tsx`
- Create/Test: `apps/web/e2e/design-system-roles.spec.ts`
- Modify: `docs/menus/{monitoring,settings,statistics}.md`

**Interfaces:** Task1 wrapper/titleRole/padding·typed fixture/config와 Task2 shared security를 소비한다. 도메인 API 생산 없음.

- [ ] **Step 1: 역할 단언 작성.** browser spec에 OPS003 일반 MonitoringView section20, SET005 설정 section20/grid18, BUS004 통계 desktop20/mobile8 예외, SET006 일반 mobile panel16, BUS003 desktop 통계 panel20, SET007 형제 하위 section20/28·card16/24를 단언한다. h3의 visual section과 문서 계층을 따로 검사한다.

```ts
test("P3 exact section grid inset and heading roles", async ({ page, designScenario }) => {
  await designScenario({ principal: "admin", state: "ready", theme: "light" });
  await page.goto("/monitoring");
  expect(await page.locator("[data-monitoring-screen]").evaluate(e => getComputedStyle(e).rowGap)).toBe("20px");
  await page.goto("/settings/security");
  expect(await page.getByTestId("account-security-layout").evaluate(e => getComputedStyle(e).gap)).toBe("18px");
  expect(await page.locator('[data-security-card="sessions"]').evaluate(e => getComputedStyle(e).paddingTop))
    .toBe(page.viewportSize()!.width < 760 ? "16px" : "20px");
  await page.goto("/statistics/overview");
  expect(await page.getByRole("region", { name: "통계", exact: true }).evaluate(e => getComputedStyle(e).gap))
    .toBe(page.viewportSize()!.width < 760 ? "8px" : "20px");
});
```

같은 spec의 test `site subsection h3 uses section visual role`는 mock 현장 진입 후 `층 관리` h3의 fontSize20px/lineHeight28px, `현장 구성` section20/28을 단언한다. 통계 외부 chart/cost/heatmap panel desktop20은 해당 기존 accessible heading의 closest Card에서 computed inset으로 검사한다.
- [ ] **Step 2: RED 실행.** `pnpm --filter @led-control/web exec playwright test --config=playwright.design-system.config.ts e2e/design-system-roles.spec.ts` → 기존16/12/24px gap·mobile20px inset·26/24px 하위 title의 정확한 computed 불일치 FAIL을 기록한다. 현재 동등한 역할은 무리하게 RED로 만들지 않는다.
- [ ] **Step 3: 순서대로 적용.** OPS003→SET005→BUS004→SET006→BUS003→SET007 순으로 공통 API를 소비한다. 일반 MonitoringView section은20, fullview는8을 유지한다. 통계 shell mobile8과 chart 내부 margin·cell geometry를 보존하고 외부 inset만 조정한다.
- [ ] **Step 4: 나머지 설정·통계 leaf 연결.** 동일 역할이 있는 users/registration/security/reports 소비도 coverage에서 대조하고 공통 API로 연결한다. 회귀에서 발견한 추가 소비 파일은 이 Task 소유 목록과 메뉴 문서에 명시하고 새 기능은 넣지 않는다.
- [ ] **Step 5: GREEN 검증.** Step2 PASS 및 `pnpm --filter @led-control/web exec vitest run src/features/settings/site/SiteOperationsView.test.tsx src/features/statistics/StatisticsShell.test.tsx`. 320/390/1024/1440·light/dark에서 text Range·단위·긴 이름·실제 저장/탭 mock action을 확인한다.
- [ ] **Step 6: 문서·검토·commit.** P3 여섯의 소비역할/computed/예외와 영향 메뉴를 갱신한다. 이 Task Files 실제 변경만 선택 stage하고 타 소유 변경을 제외한 뒤 `git commit -m "refactor(web): unify settings monitoring and statistics roles"`.

## Task 4: 제어4mode·workspace·editor와 이전8수리 보호

**Files:**
- Modify: `apps/web/src/features/control/{ControlView,TemporaryControlPanel,CommandHistoryPanel}.tsx`, `apps/web/src/features/control/automation/components/AutomationWorkspaceSurface.tsx`
- Modify: `apps/web/src/features/control/automation/{ScheduleControlPanel,VehicleEventControlPanel}.tsx`, `apps/web/src/features/control/groups/{FixtureGroupsPanel,FixtureGroupsContent}.tsx`
- Modify: `apps/web/src/features/control/ManualExecutionPanel.tsx`, `apps/web/src/features/control/target-selection/ManualSelectionPanel.tsx`, `apps/web/src/features/floor-editor/FloorEditorView.tsx`
- Modify: `apps/web/src/features/shells/CustomerShell.tsx`, `apps/web/src/features/settings/floor-plans/FloorEditorRoute.tsx`의 일반 내용 소비만
- Test: `apps/web/src/features/control/ControlView.test.tsx`, `apps/web/src/features/settings/floor-plans/FloorEditorRoute.test.tsx`
- Modify/Test: `apps/web/e2e/ui-eight-layout-regressions.spec.ts`, `apps/web/e2e/design-system-roles.spec.ts`
- Test/소비: `apps/web/e2e/support/{mock-api-boundary,settings-api,first-screen-statistics}.ts`
- Modify: `docs/menus/{control,settings,monitoring,statistics}.md`

**Interfaces:** Task1 일반 layout contract를 소비한다. 기존 mode·control session·editor props·callback 시그니처와 effect 수명은 변경하지 않는다.

이전 `.local`32case 증거는 실행 의존성이 아니다. 현재 versioned ui-eight spec과 mock-api-boundary/settings-api/first-screen-statistics 지원fixture가 없으면 전제 오류로 중단하며 임의 복원하지 않는다. FloorEditorView 정보 SidePanel(현재678행)의 p0·width280/overlay320·단일reader geometry는 보존하고 내부 일반 정보/속성 내용만 regular 역할을 적용한다. canvas/toolbar에 일반 inset을 덮어쓰지 않는다.

- [ ] **Step 1: mode별 역할 실패 단언 작성.** manual/schedule/event/group의 ready/pending/error/empty 일반 패널에 section/grid/inset/title 역할을 단언한다. 실제 제공 상태만 사용한다. geometry inset과 ordinary content를 다른 assertion으로 구분한다.

```ts
// ui-eight의 기존 SET-003 setup/navigation 이후, 원 testcase 안에서 실행.
const workspace = page.getByTestId("floor-editor-layout");
expect((await workspace.boundingBox())!.height).toBeGreaterThanOrEqual(256);
// 기존 SET-004 기록 탭 진입 이후, 원 testcase 안에서 실행.
const restore = page.getByRole("button", { name: "리비전 7 복구", exact: true });
await restore.focus();
await expect(restore).toBeFocused();
expect((await page.getByTestId("editor-revision-list").boundingBox())!.height).toBeGreaterThan(50);
// 기존 통계 수치 testcase의 target locator에 원 Range assertion 유지.
expect(await target.evaluate(e => { const r = document.createRange(); r.selectNodeContents(e); return r.getBoundingClientRect().width; }))
  .toBeGreaterThan(0);
```

기존 test명 `SET-003 short editor retains a reachable placement body`와 SET-004 기록/복구, 통계 scenario의 실제 locator를 유지한다. 원 content587/588/589 동일 map DOM·zoom·선택 assertion, UUID100끝 wheel·disabled를 실행하며 위 핵심 assertion으로32case를 대체하지 않는다.
- [ ] **Step 2: RED 실행.** `pnpm --filter @led-control/web exec playwright test --config=playwright.design-system.config.ts e2e/design-system-roles.spec.ts --grep control` → 기존 역할 불일치의 computed FAIL을 기록한다. 기존8수리 spec은 실행 전 기준 결과를 보존한다.
- [ ] **Step 3: 최소 소비 적용.** 공통 API를 일반 control surface에 적용하고 지도 chrome·editor height/containment·scroll owner는 유지한다. class 정합화가 필요해도 수동 거절/불확정 잠금·timer·자동 재전송·권한·mutation/cache 로직은 바꾸지 않는다.
- [ ] **Step 4: 실제 보호 회귀.** `ui-eight-layout-regressions.spec.ts`에서 floor editor256 이상, content587/588/589 split과 동일 map DOM/selection/zoom/history, 긴100 UUID의 끝 reader/위험disabled, 등록 ID·긴층·Save16px·통계수치/단위·초기화ID를 tap/wheel/keyboard/Range로 단언한다. bounds만 맞고 실제 접근 실패하면 FAIL이다.
- [ ] **Step 5: GREEN 검증.** Step2 PASS 및 `pnpm --filter @led-control/web exec playwright test --config=playwright.design-system.config.ts e2e/ui-eight-layout-regressions.spec.ts`·관련 focused Vitest. 759/760·1023/1024·1120·320×600을 확인하고 6unit 잔여는 별도 baseline로 남긴다.
- [ ] **Step 6: 문서·검토·commit.** mode·workspace/ordinary 경계와 수리 보호 근거를 갱신한다. 이 Task Files 실제 변경만 선택 stage하고 타 소유 변경 제외 후 `git commit -m "refactor(web): align control surfaces without changing workspace behavior"`.

## Task 5: 공개3entry·브랜드·연락·404·bootstrap

**Files:**
- Modify: `apps/web/src/{main,service-main,landing-main}.tsx`, `apps/web/404.html`
- Create: `apps/web/src/components/ui/MobilePreparation.tsx`
- Create/Test: `apps/web/src/components/ui/MobilePreparation.test.tsx`
- Modify: `apps/web/src/components/ui/public-site/{SiteFrame,PublicContactDialog}.tsx`
- Test: `apps/web/src/components/ui/public-site/PublicLogin.test.tsx`, `apps/web/src/features/landing/PublicContact.test.tsx`
- Modify/Test: `apps/web/e2e/{public-deploy,static-landing}.spec.ts`
- Modify: `docs/menus/{landing,features,pricing}.md`

**Interfaces:** `MobilePreparation({failed=false}: {failed?:boolean}): JSX.Element`를 생산해 main/service만 소비한다. 기존 prepare/fail 문구·role·reload action 유지. landing은 private bootstrap을 import하지 않는다. 공개상담·PublicLogin의 public API는 그대로다.

- [ ] **Step 1: 실패 단언 작성.** 일반 main/landing/service의 public3 route, 로그인 활성/준비중·외부HTTPS 링크, tel/mailto·선택plan·API호출0을 mode별 단언한다. 404가 JS 없이HTTP404·귀환44hit·functional title/body를 표시하고 bootstrap 준비/실패가 같은 공통 wrapper·상태 role을 쓰는지 검사한다.

```ts
test("public contact remains local links without API", async ({ page }) => {
  const api: string[] = [];
  page.on("request", r => { if (new URL(r.url()).pathname.startsWith("/api/")) api.push(r.url()); });
  await page.goto("/pricing");
  await page.getByRole("button", { name: /도입 상담/ }).first().click();
  await expect(page.getByRole("link", { name: "032-528-2953" })).toHaveAttribute("href", "tel:0325282953");
  await expect(page.getByRole("link", { name: "kymkjh2002@dfkorealed.com" })).toHaveAttribute("href", "mailto:kymkjh2002@dfkorealed.com");
  expect(api).toEqual([]);
});
test("404 retains CSS and works with JavaScript disabled", async ({ browser, baseURL }) => {
  const context = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const response = await page.goto(`${baseURL}/unknown-page`);
  expect(response!.status()).toBe(404);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  expect(await page.getByRole("heading", { level: 1 }).evaluate(e => getComputedStyle(e).fontSize)).toBe("26px");
  await context.close();
});
```
- [ ] **Step 2: RED 실행.** `pnpm --filter @led-control/web exec vitest run src/components/ui/MobilePreparation.test.tsx src/features/landing/PublicContact.test.tsx src/components/ui/public-site/PublicLogin.test.tsx` → 신규 공통 entry 계약 부재 FAIL을 기록하고 browser에서 독립404의 기존 typography/inset 불일치를 확인한다.
- [ ] **Step 3: 최소 구현.** main/service preparation을 공통화하고 root/unmount/bootstrap 순서·native 요청 수명을 유지한다. 404.html은 raw inline style을 제거하고 `/src/styles.css` stylesheet와 승인utility를 사용해 JS-free HTTP404를 유지한다. token/inline색을 복사하지 않는다. public hero/font/landing card geometry·palette·motion은 유지하고 상담modal 일반 내용만 regular로 정합화한다.
- [ ] **Step 4: GREEN과 bundle 검증.** Step2 PASS, `pnpm --filter @led-control/web test:landing-contract`, `pnpm --filter @led-control/web test:public-contract`. 아래 네 명령을 순서대로 실행하고 각 mode 산출물을 freeze한다. 기존 public config가 소유 preview의 cleanup까지 완료한 다음 다음mode를 build한다. 404 산출 CSS href·private module 배제·dot/privateasset HTTP404 계약을 검사하며15341 dev로 대체하지 않는다.

```bash
WEB_DEPLOY_MODE=landing pnpm --filter @led-control/web build:public
WEB_DEPLOY_MODE=landing PUBLIC_PORT=15342 pnpm --filter @led-control/web exec playwright test --config=playwright.public.config.ts
WEB_DEPLOY_MODE=service pnpm --filter @led-control/web build:public
WEB_DEPLOY_MODE=service PUBLIC_PORT=15342 pnpm --filter @led-control/web exec playwright test --config=playwright.public.config.ts
```
- [ ] **Step 5: 경계와 동작 검증.** 공개429/430/430.5/431·719/720/720.5/721·1049/1050/1050.5/1051px 및 기본4viewport에서 header/anchor/hero/font·normal/reduced-motion·modal keyboard/복귀·href를 확인한다. archive는 URL/링크 보호만 검사한다.
- [ ] **Step 6: 문서·검토·commit.** 공개 메뉴3문서에 entry별 검증과 운영 한계를 기록한다. 이 Task Files 실제 변경만 선택 stage하고 타 소유 변경 제외 후 `git commit -m "refactor(web): align public utility states and entry presentation"`.

## Task 6: 전체 coverage·독립 최종 QA

Task1의 config·typed fixture·baseline을 소비하며 Task5 이후 전체 coverage와 독립 QA만 수행한다.

**Files:**
- Create/Test: `apps/web/e2e/design-system-coverage.spec.ts`
- Create: `docs/assets/web-design-system-2026-10-16/coverage.md`
- Modify: `docs/ui-design-system.md`, `docs/superpowers/specs/2026-10-15-web-design-system-unification-design.md`, 본 계획, `docs/project-status.md`, 영향 메뉴8문서

**Interfaces:** Task1의 typed fixture/config/baseline과 Task2–5의 결과를 소비한다. 신규 제품 API나 자동 원인분류 comparator는 만들지 않는다.

- [ ] **Step 1: 독립 baseline 판정.** reviewer가 시작/최종 동일 testcase의 원 assertion·source·fixture 조건·로그를 직접 대조해 동일재현/새회귀/locator전제오류/원인미확정 중 근거 있는 범주를 기록한다. 원6unit·6locator 각각의 근거가 없으면 미확정으로 남긴다. 실패명 일치만으로 동일원인이나 무관을 확정하지 않는다. 이 절차는 QA 판단이며 자동테스트가 인과를 증명한다고 주장하지 않는다.
- [ ] **Step 2: 전체 역할 matrix 작성.** coverage spec에서 고객12leaf/전체15surface, operator4, authgate 상태, public3×entry3, overlays/recovery/404/bootstrap을 행으로 매핑한다. Task1 fixture computed 수치·상태 wrapper·순수 rendering을 포함한다. 실제 없는 상태는 사유와 함께 해당없음으로 적는다.

```ts
test("coverage names all customer surfaces and operator routes", () => {
  const customer = ["monitoring", "manual", "schedule", "event", "group", "statistics-overview", "statistics-analysis", "statistics-reports", "settings", "site", "users", "registration", "floor-plans", "floor-editor", "security"];
  const operator = ["site-admins", "sensor-profiles", "landing-inquiries", "security"];
  expect(new Set(customer).size).toBe(15);
  expect(operator).toHaveLength(4);
  // 실제 testcase 등록 title 목록도 같은 집합과 대조한다. 상수의 개수만으로 완료 판정 금지.
});
```

실행 suite의 surface/entry/state testcase와 coverage.md 행을 상호 참조한다. 위 집합 수는 inventory sanity test이며 각 page PASS를 증명하지 않는다. Task1 baseline의 원인 분류는 Step1 독립 QA에서 판단하며 test명 목록만으로 무관을 단정하지 않는다.
- [ ] **Step 3: 생성CSS·사용성 최종 검증.** `pnpm --filter @led-control/web exec playwright test --config=playwright.design-system.config.ts e2e/design-system-coverage.spec.ts e2e/design-system-roles.spec.ts e2e/ui-eight-layout-regressions.spec.ts`를 실행한다. matrix의 exact computed값·텍스트 Range·실제hit·keyboard/tap/wheel/focus·theme/motion·긴내용을 저장한다. lexical PASS와 시각/동작 PASS를 다른 열로 기록한다.
- [ ] **Step 4: 필수 소프트웨어 gate.** 준비된 dependency는 저장소 `pnpm workspace:prepare` 규칙을 따른다. `pnpm --filter @led-control/web typecheck`, `pnpm --filter @led-control/web test`, `pnpm --filter @led-control/web build`, `pnpm --filter @led-control/web test:ui-policy`, `pnpm --filter @led-control/web ui:check`, landing/public 계약을 실행한다. 정책0/0·빈baseline·anchor불변을 확인한다. 실패6의 현재 원인과 전후 증거가 남으면 전체GREEN·전체완료로 발표하지 않고 처리 방향을 총괄에 보고한다.
- [ ] **Step 5: 독립 최종 QA.** 작성자가 아닌 reviewer가 spec/guide/전체diff/coverage와 미실행환경을 대조한다. 색 대비 미달이면 승인role 대체 가능성을 확인하고 토큰변경필요는 별도 승인으로 분리한다. 성공값 반올림·무근거threshold·원본수치삭제 금지. C/I 지적을 해소하고 실제 실행된 범위를 명시한다.
- [ ] **Step 6: 문서 동기화·scoped commit.** menu8개와 guide coverage·spec·계획·상태판을 실제 결과로 맞춘다. diff check·링크/경로·보호파일 확인 후 이 Task Files의 소유 변경만 선택 stage한다. 상태판은 총괄이 자신의 구간만 반영하며 다른 owner 구간·AGENTS는 제외한다. `git commit -m "docs(web): record design system coverage and verification limits"`. 운영·메일·native·장비 검증으로 확대하지 않는다.

## 계획 검토와 실행 인계

2026-10-16 사용자 승인으로 순차 subagent-driven 실행을 시작했다. 공통 API를 먼저 고정하고 같은 공유파일을 한 소유자가 수정한 뒤 소비자를 순차 검토한다. 승인된 Git worktree는 `.worktrees/web-design-system-unification-20261016`이며 시작 SHA는 `24d2d8e4`다. 계획의 명령은 실제 결과가 기록되기 전까지 실행 증거가 아니다. 병합·배포·운영 서비스 변경은 별도 승인 범위다.
