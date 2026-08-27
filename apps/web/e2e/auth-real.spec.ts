import { expect, test } from "@playwright/test";

test.skip(process.env.E2E_REAL_AUTH !== "true", "Set E2E_REAL_AUTH=true after starting the real API and database.");
test.use({ trace: "off", screenshot: "off" });

test("real backend rejects wrong credentials and accepts the bootstrapped operator", async ({ page }) => {
  const operatorLoginId = process.env.E2E_OPERATOR_LOGIN_ID;
  const operatorPassword = process.env.E2E_OPERATOR_PASSWORD;
  if (!operatorLoginId || !operatorPassword) {
    throw new Error("E2E_OPERATOR_LOGIN_ID and E2E_OPERATOR_PASSWORD are required for real auth E2E.");
  }
  let customerApiRequests = 0;
  page.on("request", (request) => {
    const pathname = new URL(request.url()).pathname;
    if (pathname === "/api/sites" || /^\/api\/sites\/[^/]+\/dashboard$/.test(pathname)) {
      customerApiRequests += 1;
    }
  });
  await page.goto("/");

  await page.getByLabel("아이디").fill("wrong@example.com");
  await page.getByLabel("비밀번호").fill("wrong-password");
  await page.getByRole("button", { name: "로그인" }).click();
  await expect(page.getByText("아이디 또는 비밀번호를 확인해 주세요.")).toBeVisible();

  await page.getByLabel("아이디").fill(operatorLoginId);
  await page.getByLabel("비밀번호").fill(operatorPassword);
  await page.getByRole("button", { name: "로그인" }).click();
  await expect(page).toHaveURL(/\/operator\/site-admins$/);
  await expect(page.getByRole("heading", { name: "현장 관리자 계정" })).toBeVisible();
  await expect(page.getByRole("button", { name: "로그아웃" })).toBeVisible();
  expect(customerApiRequests).toBe(0);
});
