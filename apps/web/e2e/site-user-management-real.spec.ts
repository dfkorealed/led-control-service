import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { RealBackendLab } from "./support/real-backend-lab";

test.describe.configure({ mode: "serial" });
test.skip(process.env.E2E_REAL_BACKEND_LAB !== "1", "격리 RealBackendLab 실행은 e2e:site-users:real에서 집계합니다.");
test.use({ trace: "off", screenshot: "off" });

const lab = new RealBackendLab();

test.beforeAll(async () => {
  test.setTimeout(180_000);
  await lab.start();
});

test.afterAll(async () => {
  await lab.stop();
});

test("비활성화된 일반 유저의 현재 세션과 재로그인을 실제 API가 차단한다", async ({ browser }) => {
  test.setTimeout(180_000);
  const siteName = `유저 E2E 현장 ${randomUUID().slice(0, 8)}`;
  const loginId = `site_user_${randomUUID().replaceAll("-", "")}`;
  const temporaryPassword = runtimePassword("temporary");
  const permanentPassword = runtimePassword("permanent");

  const operator = await browser.newPage();
  await operator.goto("/");
  await login(operator, lab.operator.loginId, lab.operator.password);
  await expect(operator).toHaveURL(/\/operator\/site-admins$/);
  await operator.getByRole("button", { name: "현장 및 관리자 생성" }).click();
  await operator.getByLabel("고객사명").fill("유저 E2E 고객사");
  await operator.getByLabel("현장명").fill(siteName);
  await operator.getByLabel("관리자 이름").fill(lab.admin.name);
  await operator.getByLabel("로그인 아이디").fill(lab.admin.loginId);
  await operator.getByLabel("초기 비밀번호").fill(lab.admin.password);
  const createSiteResponsePromise = operator.waitForResponse((response) => response.url().endsWith("/api/operator/site-admins") && response.request().method() === "POST");
  await operator.getByRole("button", { name: "생성", exact: true }).click();
  const createSiteResponse = await createSiteResponsePromise;
  expect(createSiteResponse.status()).toBe(201);
  const createdSite = await createSiteResponse.json() as { siteId: string };
  expect(JSON.stringify(createdSite)).not.toMatch(/password/i);
  await operator.close();

  const admin = await browser.newPage();
  await admin.goto(`/monitoring?siteId=${createdSite.siteId}`);
  await login(admin, lab.admin.loginId, lab.admin.password);
  await expect(admin.getByRole("heading", { name: "현장 기본 정보를 입력하세요" })).toBeVisible();
  await admin.getByLabel("주소").fill("서울시 격리 테스트구");
  await admin.getByLabel("kWh 단가").fill("160");
  await admin.getByLabel("시간대").selectOption("Asia/Seoul");
  await admin.getByLabel("지하 층수").fill("1");
  await admin.getByLabel("지상 층수").fill("0");
  await admin.getByRole("button", { name: "층 자동 생성" }).click();
  await admin.getByRole("button", { name: "초기 설정 완료" }).click();
  await expect(admin.getByRole("heading", { name: "설정 개요" })).toBeVisible();

  await admin.goto(`/settings/users?siteId=${createdSite.siteId}`);
  await expect(admin.getByRole("heading", { name: "유저 관리" })).toBeVisible();
  await admin.getByRole("button", { name: "사용자 추가" }).click();
  const createUserDialog = admin.getByRole("dialog", { name: "사용자 추가" });
  await createUserDialog.getByLabel("이름").fill("현장 조회 사용자");
  await createUserDialog.getByLabel("로그인 아이디").fill(loginId);
  await createUserDialog.getByLabel("임시 비밀번호").fill(temporaryPassword);
  const createUserResponsePromise = admin.waitForResponse((response) => response.url().endsWith(`/api/sites/${createdSite.siteId}/users`) && response.request().method() === "POST");
  await createUserDialog.getByRole("button", { name: "사용자 생성" }).click();
  const createUserResponse = await createUserResponsePromise;
  expect(createUserResponse.status()).toBe(201);
  const createdUser = await createUserResponse.json() as { id: string; loginId: string };
  expect(createdUser.loginId).toBe(loginId);
  expect(JSON.stringify(createdUser)).not.toMatch(/password/i);
  await expect(admin.getByText(loginId)).toBeVisible();

  const user = await browser.newPage();
  await user.goto("/");
  await login(user, loginId, temporaryPassword);
  await expect(user.getByRole("heading", { name: "비밀번호를 변경해 주세요" })).toBeVisible();
  await user.getByLabel("현재 임시 비밀번호").fill(temporaryPassword);
  await user.getByLabel("새 비밀번호", { exact: true }).fill(permanentPassword);
  await user.getByLabel("새 비밀번호 확인").fill(permanentPassword);
  const changeResponsePromise = user.waitForResponse((response) => response.url().endsWith("/api/auth/change-password") && response.request().method() === "POST");
  await user.getByRole("button", { name: "비밀번호 변경" }).click();
  const changeResponse = await changeResponsePromise;
  expect(changeResponse.status()).toBe(201);
  const changeResponseBody = JSON.stringify(await changeResponse.json());
  expect(changeResponseBody).not.toContain(temporaryPassword);
  expect(changeResponseBody).not.toContain(permanentPassword);
  await expect(user).toHaveURL(/\/monitoring$/);
  await expect(user.getByRole("heading", { name: "모니터링", level: 1 })).toBeVisible();

  await admin.bringToFront();
  // 비밀번호 변경도 User.updatedAt을 갱신하므로 목록을 새로 받아 최신 낙관적 잠금 값을 사용한다.
  await admin.reload();
  await expect(admin.getByRole("heading", { name: "유저 관리" })).toBeVisible();
  await expect(admin.getByText(loginId)).toBeVisible();
  const userPatchPath = `/api/sites/${createdSite.siteId}/users/${createdUser.id}`;
  const isUserPatch = (response: { url(): string; request(): { method(): string } }) =>
    response.url().endsWith(userPatchPath) && response.request().method() === "PATCH";
  const disableResponsePromise = admin.waitForResponse(isUserPatch);
  await admin.getByRole("button", { name: "현장 조회 사용자 비활성화" }).click();
  const disableResponse = await disableResponsePromise;
  const disableBody = await disableResponse.json() as { status?: string; message?: string; code?: string };
  expect(disableResponse.status(), `사용자 비활성화 API 실패: ${JSON.stringify(disableBody)}`).toBe(200);
  expect(disableBody.status, `사용자 비활성화 응답 오류: ${JSON.stringify(disableBody)}`).toBe("disabled");
  const userRow = admin.getByRole("row").filter({ hasText: loginId });
  await expect(userRow.getByRole("cell", { name: "비활성", exact: true })).toBeVisible();

  const protectedStatus = await user.evaluate(async () => (await fetch("/api/sites", { credentials: "include" })).status);
  expect(protectedStatus).toBe(401);
  await user.reload();
  await expect(user.getByRole("heading", { name: "LED Control 로그인" })).toBeVisible();
  await login(user, loginId, permanentPassword);
  await expect(user.getByText("아이디 또는 비밀번호를 확인해 주세요.")).toBeVisible();

  await user.close();
  await admin.close();
});

async function login(page: Page, loginId: string, password: string) {
  await page.getByLabel("아이디").fill(loginId);
  await page.getByLabel("비밀번호").fill(password);
  await page.getByRole("button", { name: "로그인" }).click();
}

function runtimePassword(label: string) {
  return `${label}-${randomUUID()}-A1!`;
}
