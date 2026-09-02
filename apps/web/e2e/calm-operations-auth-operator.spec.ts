import { expect, test, type Page } from "@playwright/test";
import { expectMinimumTouchTargets, expectNoHorizontalOverflow } from "./support/layout-assertions";

const viewports = [
  { width: 1440, height: 900 },
  { width: 1024, height: 768 },
  { width: 390, height: 844 },
  { width: 320, height: 740 }
] as const;

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

for (const viewport of viewports) {
  test(`calm operations auth and operator surfaces remain responsive at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    let authenticated = false;
    await installAuthOperatorRoutes(page, () => authenticated);

    await page.goto("/");
    await expect(page.getByRole("heading", { name: /빛을 더 안정적으로/ })).toBeVisible();
    await expect(page.getByRole("heading", { name: "LED Control 로그인" })).toBeVisible();
    await expect(page.getByLabel("아이디")).toBeVisible();
    await expect(page.getByLabel("비밀번호")).toBeVisible();
    await expect(page.getByText("연결 조명")).toHaveCount(0);
    await expect(page.getByText("정상 운영")).toHaveCount(0);
    await expect(page.getByText(/^(Gateway|게이트웨이)$/i)).toHaveCount(0);
    await expectNoHorizontalOverflow(page);

    if (viewport.width <= 760) {
      await expectMinimumTouchTargets(page, ".auth-submit");
    }

    authenticated = true;
    await page.goto("/operator/site-admins");
    await expect(page.getByRole("heading", { name: "현장 관리자 계정" })).toBeVisible();
    await expect(page.getByLabel("현장 관리자 계정 표")).toBeVisible();
    await expect(page.getByRole("group", { name: "운영 현장" })).toContainText("4");
    await expect(page.getByRole("group", { name: "설치 완료" })).toContainText("2");

    if (viewport.width <= 760) {
      await expectMinimumTouchTargets(page, ".operator-admin-management > .ui-page-header");
    }

    await page.getByRole("button", { name: "현장 및 관리자 생성" }).click();
    await expect(page.getByRole("dialog", { name: "현장 및 관리자 생성" })).toBeVisible();
    await expectNoHorizontalOverflow(page);

    if (viewport.width <= 760) {
      await expectMinimumTouchTargets(page, ".operator-dialog-actions");
    }
  });
}

async function installAuthOperatorRoutes(page: Page, isAuthenticated: () => boolean) {
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (!pathname.startsWith("/api/")) return route.continue();
    const path = pathname.replace(/^\/api/, "");

    if (path === "/auth/me") {
      return route.fulfill(isAuthenticated()
        ? { json: { user: { id: "operator-1", organizationId: "provider-1", organizationType: "service_provider", loginId: "operator", name: "운영자", role: "operator", status: "active" } } }
        : { status: 401, json: { message: "unauthorized" } });
    }
    if (path === "/operator/site-admins" && request.method() === "GET") {
      return route.fulfill({ json: siteAdmins });
    }
    return route.fulfill({ status: 404, json: { message: `Unhandled fixture route: ${path}` } });
  });
}
