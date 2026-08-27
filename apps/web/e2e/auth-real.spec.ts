import { expect, test } from "@playwright/test";
import { RealBackendLab } from "./support/real-backend-lab";

test.skip(process.env.E2E_REAL_BACKEND_LAB !== "1", "격리 RealBackendLab 실행은 e2e:auth:real에서 집계합니다.");
test.use({ trace: "off", screenshot: "off" });

const lab = new RealBackendLab();

test.beforeAll(async () => {
  test.setTimeout(180_000);
  await lab.start();
});

test.afterAll(async () => {
  await lab.stop();
});

test("real backend rejects wrong credentials and accepts the bootstrapped operator", async ({ page }) => {
  lab.captureNetwork(page, "operator");
  await page.goto("/");

  await page.getByLabel("아이디").fill("wrong@example.com");
  await page.getByLabel("비밀번호").fill("wrong-password");
  await page.getByRole("button", { name: "로그인" }).click();
  await expect(page.getByText("아이디 또는 비밀번호를 확인해 주세요.")).toBeVisible();

  await page.getByLabel("아이디").fill(lab.operator.loginId);
  await page.getByLabel("비밀번호").fill(lab.operator.password);
  await page.getByRole("button", { name: "로그인" }).click();
  await expect(page).toHaveURL(/\/operator\/site-admins$/);
  await expect(page.getByRole("heading", { name: "현장 관리자 계정" })).toBeVisible();
  await expect(page.getByRole("button", { name: "로그아웃" })).toBeVisible();
  lab.assertOperatorNetworkIsolation();
});
