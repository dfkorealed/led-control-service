import { createHmac } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { RealBackendLab } from "./support/real-backend-lab";

test.skip(process.env.E2E_REAL_BACKEND_LAB !== "1", "격리 RealBackendLab 실행은 e2e:auth:real에서 집계합니다.");
test.use({ trace: "off", screenshot: "off" });

const lab = new RealBackendLab();
test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  test.setTimeout(180_000);
  await lab.start();
});

test.afterAll(async () => {
  await lab.stop();
});

test("real backend rejects wrong credentials and accepts the bootstrapped operator", async ({ page }) => {
  lab.captureNetwork(page, "operator");
  await openLogin(page);

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

test("real MFA login survives a trusted ingress client-IP change", async ({ page }) => {
  await openLogin(page);
  await page.getByLabel("아이디").fill(lab.operator.loginId);
  await page.getByLabel("비밀번호").fill(lab.operator.password);
  await page.getByRole("button", { name: "로그인" }).click();
  await expect(page).toHaveURL(/\/operator\/site-admins$/);

  const enrollmentResponse = await page.evaluate(async () => {
    const response = await fetch("/api/auth/mfa/enrollment", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    return { status: response.status, body: await response.json() };
  }) as { status: number; body: { enrollmentToken: string; secret: string } };
  expect(enrollmentResponse.status).toBe(201);
  const enrollment = enrollmentResponse.body;
  const confirmation = await page.evaluate(async ({ enrollmentToken, code }) => {
    const response = await fetch("/api/auth/mfa/enrollment/confirm", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enrollmentToken, code })
    });
    return { status: response.status, body: await response.json() };
  }, { enrollmentToken: enrollment.enrollmentToken, code: totpCode(enrollment.secret) }) as {
    status: number;
    body: { recoveryCodes: string[] };
  };
  expect(confirmation.status).toBe(201);
  expect(confirmation.body.recoveryCodes).toHaveLength(10);
  await page.evaluate(() => fetch("/api/auth/logout", { method: "POST" }));
  await openLogin(page);

  await page.setExtraHTTPHeaders({
    "X-Web-Ingress-Secret": lab.webIngressSecret,
    "X-Web-Client-IP": "198.51.100.20"
  });
  await page.getByLabel("아이디").fill(lab.operator.loginId);
  await page.getByLabel("비밀번호").fill(lab.operator.password);
  await page.getByRole("button", { name: "로그인" }).click();
  await expect(page.getByRole("heading", { name: "2단계 인증" })).toBeVisible();

  await page.setExtraHTTPHeaders({
    "X-Web-Ingress-Secret": lab.webIngressSecret,
    "X-Web-Client-IP": "198.51.100.21"
  });
  await page.getByRole("button", { name: "복구 코드 사용" }).click();
  await page.getByLabel("복구 코드").fill(confirmation.body.recoveryCodes[0]);
  await page.getByRole("button", { name: "인증하고 로그인" }).click();
  await expect(page).toHaveURL(/\/operator\/site-admins$/);
  await expect(page.getByRole("heading", { name: "현장 관리자 계정" })).toBeVisible();
});

async function openLogin(page: Page) {
  await page.goto("/");
  await page.getByRole("link", { name: "로그인", exact: true }).click();
  await expect(page.getByLabel("아이디")).toBeVisible();
}

function totpCode(secret: string, nowMs = Date.now()) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const character of secret.trim().toUpperCase()) {
    value = (value << 5) | alphabet.indexOf(character);
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(Math.floor(nowMs / 30_000)));
  const digest = createHmac("sha1", Buffer.from(bytes)).update(message).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary = ((digest[offset] & 0x7f) << 24)
    | ((digest[offset + 1] & 0xff) << 16)
    | ((digest[offset + 2] & 0xff) << 8)
    | (digest[offset + 3] & 0xff);
  return String(binary % 1_000_000).padStart(6, "0");
}
