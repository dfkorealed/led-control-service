import { expect, test } from "./support/design-system-fixture";
import type { Page } from "@playwright/test";
import { expectMinimumTouchTargets, expectMinimumTouchTargetsAfterScrolling, expectNoHorizontalOverflow } from "./support/layout-assertions";

const viewports = [
  { width: 1440, height: 900 },
  { width: 1378, height: 1237 },
  { width: 1024, height: 768 },
  { width: 390, height: 844 },
  { width: 320, height: 720 }
] as const;

// The timestamp formatter intentionally uses the device timezone. Pin this
// fixture's browser zone so expected display values stay independent and exact.
test.use({ timezoneId: "Asia/Seoul" });

const siteAdmins = [
  {
    siteId: "site-pending-active",
    customerName: "새빛 물류",
    siteName: "인천 물류센터",
    installationStatus: "pending",
    admin: { id: "admin-active", name: "김관리", loginId: "customer_admin", status: "active", updatedAt: "2026-08-27T08:00:00.000Z" }
  },
  {
    siteId: "site-installed-unassigned",
    customerName: "한결 주차",
    siteName: "강남 주차장",
    installationStatus: "installed",
    admin: null
  },
  {
    siteId: "site-installed-disabled",
    customerName: "동행 파크",
    siteName: "성수 주차장",
    installationStatus: "installed",
    admin: { id: "admin-disabled", name: "이비활성", loginId: "disabled_admin", status: "disabled", updatedAt: "2026-08-26T08:00:00.000Z" }
  },
  {
    siteId: "site-pending-unassigned",
    customerName: "한빛 상가",
    siteName: "종로 상가",
    installationStatus: "pending",
    admin: null
  }
];

// Hand-written display/action expectations catch a missing column, placeholder,
// status mapping or action even when the API fixture still contains its data.
const expectedSiteAdminCards = [
  {
    siteName: "인천 물류센터",
    fields: [["고객사", "새빛 물류"], ["현장", "인천 물류센터"], ["설치 상태", "설치 대기"], ["관리자 이름", "김관리"], ["로그인 아이디", "customer_admin"], ["계정 상태", "활성"], ["최종 변경", "2026-08-27 17:00:00"]],
    actions: ["김관리 수정", "김관리 비밀번호 재설정", "인천 물류센터 현장 전체 삭제"]
  },
  {
    siteName: "강남 주차장",
    fields: [["고객사", "한결 주차"], ["현장", "강남 주차장"], ["설치 상태", "설치 완료"], ["관리자 이름", "관리자 미지정"], ["로그인 아이디", "-"], ["계정 상태", "-"], ["최종 변경", "-"]],
    actions: ["강남 주차장 관리자 지정"]
  },
  {
    siteName: "성수 주차장",
    fields: [["고객사", "동행 파크"], ["현장", "성수 주차장"], ["설치 상태", "설치 완료"], ["관리자 이름", "이비활성"], ["로그인 아이디", "disabled_admin"], ["계정 상태", "비활성"], ["최종 변경", "2026-08-26 17:00:00"]],
    actions: ["이비활성 수정", "이비활성 비밀번호 재설정", "성수 주차장 현장 전체 삭제"]
  },
  {
    siteName: "종로 상가",
    fields: [["고객사", "한빛 상가"], ["현장", "종로 상가"], ["설치 상태", "설치 대기"], ["관리자 이름", "관리자 미지정"], ["로그인 아이디", "-"], ["계정 상태", "-"], ["최종 변경", "-"]],
    actions: ["종로 상가 관리자 지정"]
  }
] as const;

for (const viewport of viewports) {
  test(`calm operations auth and operator surfaces remain responsive at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    let authenticated = false;
    const operatorLoginId = viewport.width === 320 ? `operator_${"a".repeat(91)}` : "operator";
    await installAuthOperatorRoutes(page, () => authenticated, operatorLoginId);

    // Public landing owns `/`; this scenario verifies the authenticated entry surface.
    await page.goto("/login");
    await expect(page).toHaveTitle("킨다 | 스마트 조명 운영");
    await expect(page.getByRole("img", { name: "킨다", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "킨다 로그인" })).toBeVisible();
    const authMain = page.getByRole("main");
    const authBox = await authMain.boundingBox();
    expect(authBox).not.toBeNull();
    expect(authBox!.width).toBeLessThanOrEqual(Math.min(viewport.width, 960));
    await expect(page.getByTestId("auth-stage-card")).toHaveAttribute("data-auth-stage", "credentials");
    const loginButton = page.getByRole("button", { name: "로그인", exact: true });
    await expect(loginButton).toHaveCSS("background-color", "rgb(37, 111, 161)");
    await loginButton.hover();
    await expect(loginButton).toHaveCSS("background-color", "rgb(29, 92, 134)");
    // Tailwind theme의 canonical token이 로그인 표면의 최종 색상을 결정한다.
    expect(await page.evaluate(() => {
      const root = getComputedStyle(document.documentElement);
      return {
        actionPrimary: root.getPropertyValue("--color-action-primary").trim(),
        surfaceCanvas: root.getPropertyValue("--color-surface-canvas").trim(),
        contentPrimary: root.getPropertyValue("--color-content-primary").trim(),
        focus: root.getPropertyValue("--shadow-focus").trim()
      };
    })).toEqual({
      actionPrimary: "#256fa1",
      surfaceCanvas: "#f4f8fa",
      contentPrimary: "#15324a",
      focus: "0 0 0 3px rgb(37 111 161 / 0.28)"
    });
    await expect(page.getByLabel("아이디")).toBeVisible();
    await expect(page.getByLabel("비밀번호")).toBeVisible();
    await expect(page.getByText("연결 조명")).toHaveCount(0);
    await expect(page.getByText("정상 운영")).toHaveCount(0);
    await expect(page.getByText(/^(Gateway|게이트웨이)$/i)).toHaveCount(0);
    await expectNoHorizontalOverflow(page);

    if (viewport.width < 760) {
      await expectMinimumTouchTargets(page, "[data-auth-submit]");
    }

    authenticated = true;
    await page.goto("/operator/site-admins");
    await expect(page.getByRole("img", { name: "킨다 서비스 운영" })).toBeVisible();
    await expect(page.getByText(operatorLoginId, { exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "현장 관리자 계정" })).toBeVisible();
    const operatorMain = page.getByRole("main");
    const mainBox = await operatorMain.boundingBox();
    expect(mainBox).not.toBeNull();
    expect(mainBox!.width).toBeLessThanOrEqual(Math.min(viewport.width, 1160));
    await expectMinimumTouchTargets(page, "header");
    // These eight columns require 1230px. The preserved 1160px operator frame
    // supplies at most 1104px of content, so all named viewports use cards.
    // The old label-only query also matched this UL and never proved a table.
    const accounts = page.getByRole("list", { name: "현장 관리자 계정 표", exact: true });
    await expect(accounts).toBeVisible();
    expect((await accounts.boundingBox())!.width).toBeLessThan(1230);
    await expect(page.getByRole("table", { name: "현장 관리자 계정 표", exact: true })).toHaveCount(0);
    await expect(accounts.getByRole("listitem")).toHaveCount(4);
    for (const expected of expectedSiteAdminCards) {
      const row = accounts.getByRole("listitem").filter({ hasText: expected.siteName });
      await expect(row.getByRole("term")).toHaveText(["고객사", "현장", "설치 상태", "관리자 이름", "로그인 아이디", "계정 상태", "최종 변경", "작업"]);
      for (const [label, value] of expected.fields) {
        const field = row.getByRole("term").filter({ hasText: new RegExp(`^${label}$`) }).locator("..");
        await expect(field.getByRole("definition")).toHaveText(value);
        await expect(field.getByRole("definition")).toBeVisible();
      }
      const actions = row.getByRole("term").filter({ hasText: "작업" }).locator("..").getByRole("definition");
      await expect(actions.getByRole("button")).toHaveCount(expected.actions.length);
      for (const label of expected.actions) {
        const action = actions.getByRole("button", { name: label, exact: true });
        await expect(action).toBeVisible();
        // Account disabled status does not disable operator maintenance actions;
        // unassigned rows expose only assignment, verified by the exact count.
        await expect(action).toBeEnabled();
      }
    }
    if (viewport.width < 760) {
      await expectMinimumTouchTargetsAfterScrolling(page, 'ul[aria-label="현장 관리자 계정 표"]');
      const metrics = page.locator('[data-testid="operator-summary-strip"] [data-metric-card]');
      const first = await metrics.nth(0).boundingBox();
      const second = await metrics.nth(1).boundingBox();
      const third = await metrics.nth(2).boundingBox();
      expect(first).not.toBeNull();
      expect(second).not.toBeNull();
      expect(third).not.toBeNull();
      expect(Math.abs(first!.y - second!.y)).toBeLessThanOrEqual(1);
      expect(third!.y).toBeGreaterThan(first!.y + first!.height);
    }
    await expect(page.getByRole("group", { name: "운영 현장" })).toContainText("4");
    await expect(page.getByRole("group", { name: "설치 완료" })).toContainText("2");
    await expectNoHorizontalOverflow(page);

    if (viewport.width <= 760) {
      await expectMinimumTouchTargetsAfterScrolling(page, "[data-operator-admin-header]");
    }

    await page.getByRole("button", { name: "현장 및 관리자 생성" }).click();
    const createDialog = page.getByRole("dialog", { name: "현장 및 관리자 생성" });
    await expect(createDialog).toBeVisible();
    await expectNoHorizontalOverflow(page);

    if (viewport.width <= 760) {
      await expectMobileDialogControls(createDialog);
    }
    await createDialog.getByRole("button", { name: "현장 및 관리자 생성 닫기" }).click();

    await page.getByRole("button", { name: "김관리 수정" }).click();
    const editDialog = page.getByRole("dialog", { name: "김관리 수정" });
    await expect(editDialog).toBeVisible();
    if (viewport.width <= 760) {
      await expectMobileDialogControls(editDialog);
    }
    await editDialog.getByRole("button", { name: "김관리 수정 닫기" }).click();

    if (viewport.width <= 760) {
      await page.getByRole("button", { name: "김관리 비밀번호 재설정" }).click();
      const resetDialog = page.getByRole("dialog", { name: "김관리 비밀번호 재설정" });
      await expectMobileDialogControls(resetDialog);
      await resetDialog.getByRole("button", { name: "김관리 비밀번호 재설정 닫기" }).click();

      await page.getByRole("button", { name: "인천 물류센터 현장 전체 삭제" }).click();
      const deleteDialog = page.getByRole("dialog", { name: "인천 물류센터 현장 전체 삭제" });
      await expectMobileDialogControls(deleteDialog);
    }
  });
}

async function expectMobileDialogControls(dialog: ReturnType<Page["getByRole"]>) {
  const close = dialog.locator("[data-dialog-close]");
  await expect(close).toHaveCSS("min-height", "52px");
  const closeBox = await close.boundingBox();
  expect(closeBox).not.toBeNull();
  expect(closeBox!.width).toBeGreaterThanOrEqual(44);
  expect(closeBox!.height).toBeGreaterThanOrEqual(44);

  const actions = dialog.locator("[data-dialog-actions] > button");
  for (const action of await actions.all()) {
    const box = await action.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.width).toBeGreaterThanOrEqual(44);
    expect(box!.height).toBeGreaterThanOrEqual(44);
  }
}

async function installAuthOperatorRoutes(page: Page, isAuthenticated: () => boolean, loginId: string) {
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (!pathname.startsWith("/api/")) return route.continue();
    const path = pathname.replace(/^\/api/, "");

    if (path === "/auth/me") {
      return route.fulfill(isAuthenticated()
        ? { json: { user: { id: "operator-1", organizationId: "provider-1", organizationType: "service_provider", loginId, name: "운영자", role: "operator", status: "active" } } }
        : { status: 401, json: { message: "unauthorized" } });
    }
    if (path === "/operator/site-admins" && request.method() === "GET") {
      return route.fulfill({ json: siteAdmins });
    }
    return route.fulfill({ status: 404, json: { message: `Unhandled fixture route: ${path}` } });
  });
}
