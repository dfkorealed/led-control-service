import { expect, test } from "@playwright/test";

test.skip(process.env.E2E_REAL_AUTH !== "true", "Set E2E_REAL_AUTH=true after starting the real API and database.");

test("real backend rejects wrong credentials and accepts the seeded demo account", async ({ page }) => {
  await page.goto("/");

  await page.getByLabel("아이디").fill("wrong@example.com");
  await page.getByLabel("비밀번호").fill("wrong-password");
  await page.getByRole("button", { name: "로그인" }).click();
  await expect(page.getByText("아이디 또는 비밀번호를 확인해 주세요.")).toBeVisible();

  await page.getByLabel("아이디").fill("operator@example.com");
  await page.getByLabel("비밀번호").fill("demo-password-1234");
  await page.getByRole("button", { name: "로그인" }).click();
  await expect(page.getByRole("heading", { name: "모니터링" })).toBeVisible();
  await expect(page.getByRole("button", { name: "로그아웃" })).toBeVisible();
});
