import { expect, test } from "@playwright/test";
const service = process.env.WEB_DEPLOY_MODE === "service";

test("production public pages use the selected login mode, preserve contact, and make no API requests", async ({ page }) => {
  const api: string[] = [];
  page.on("request", request => { if (new URL(request.url()).pathname.startsWith("/api/")) api.push(request.url()); });
  for (const path of ["/", "/features", "/pricing"]) {
    expect((await page.goto(path))!.status()).toBe(200);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    expect((await page.reload())!.status()).toBe(200);
    if (service) await expect(page.getByRole("link", { name: /로그인/ })).toHaveAttribute("href", "/login");
    else await expect(page.getByRole("button", { name: "준비 중", exact: true })).toBeDisabled();
    await page.getByRole("button", { name: /도입 상담/ }).first().click();
    const dialog = page.getByRole("dialog", { name: "도입 상담" });
    await expect(dialog.locator('a[href^="tel:"]')).toHaveCount(0);
    await expect(dialog.getByRole("link", { name: "kymkjh2002@dfkorealed.com" })).toHaveAttribute("href", "mailto:kymkjh2002@dfkorealed.com");
    await page.keyboard.press("Escape");
  }
  expect(api).toEqual([]);
});

test("unknown, concept, opposite-mode assets and private archive URLs remain real 404", async ({ page }) => {
  for (const path of ["/unknown", "/settings/nope", "/concepts/field-day.html", "/features/", "/published/r1/index.html", "/releases/r1/manifest.json", `/assets/${service ? "landing" : "service"}/app-12345678.js`, ...(!service ? ["/login", "/monitoring", "/api/auth/me"] : [])]) {
    expect((await page.goto(path))!.status()).toBe(404);
    await expect(page.getByRole("heading", { name: "페이지를 찾을 수 없습니다." })).toBeVisible();
  }
});

test("service direct nested reload enforces session and shows authorization failure without exposing shell", async ({ page }) => {
  test.skip(!service, "Only service includes the existing authenticated application");
  let status = 401;
  let calls = 0;
  await page.route("**/api/**", route => { calls++; return route.fulfill({ status, json: { message: "mock session denied" } }); });
  for (const path of ["/login", "/statistics/analysis", "/settings/floor-plans/floor-1/edit"]) {
    expect((await page.goto(path))!.status()).toBe(200);
    await expect(page.getByRole("heading", { name: "킨다 로그인" })).toBeVisible();
    expect((await page.reload())!.status()).toBe(200);
    await expect(page.getByRole("heading", { name: "킨다 로그인" })).toBeVisible();
  }
  expect(calls).toBeGreaterThanOrEqual(6);
  status = 403;
  await page.goto("/monitoring");
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(page.getByRole("heading", { name: "킨다 로그인" })).toHaveCount(0);
});

test("service login preserves same-origin credentials and operator role on direct reload at mobile width", async ({ page }) => {
  test.skip(!service, "Only service includes authentication");
  await page.setViewportSize({ width: 390, height: 844 });
  let authenticated = false;
  const user = { id:"operator-public", role:"operator", loginId:"operator", name:"운영자", organizationId:"provider-1", organizationType:"service_provider", status:"active", mustChangePassword:false };
  await page.route("**/api/**", async route => {
    const path = new URL(route.request().url()).pathname;
    if(path === "/api/auth/login") {
      expect(route.request().method()).toBe("POST");
      expect(route.request().postDataJSON()).toMatchObject({loginId:"operator",password:"test-password"});
      authenticated = true;
      return route.fulfill({json:{user},headers:{"Set-Cookie":"session=mock; Path=/; HttpOnly; SameSite=Lax"}});
    }
    if(path === "/api/auth/me") {
      if (authenticated) expect(route.request().headers().cookie).toContain("session=mock");
      return route.fulfill(authenticated ? {json:{user}} : {status:401,json:{message:"Unauthorized"}});
    }
    if(path === "/api/operator/site-admins") return route.fulfill({json:[]});
    return route.fulfill({status:404,json:{message:"Unconfigured mock API"}});
  });
  await page.goto("/login");
  await page.getByLabel("아이디").fill("operator");
  await page.getByLabel("비밀번호", {exact:true}).fill("test-password");
  await page.getByRole("button", {name:"로그인",exact:true}).click();
  await expect(page.getByRole("heading", {name:"현장 관리자 계정"})).toBeVisible();
  expect((await page.reload())!.status()).toBe(200);
  await expect(page.getByRole("heading", {name:"현장 관리자 계정"})).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
