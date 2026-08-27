import { expect, test, type Page } from "@playwright/test";
import { RealBackendLab } from "./support/real-backend-lab";

test.describe.configure({ mode: "serial" });
test.skip(process.env.E2E_REAL_BACKEND_LAB !== "1", "격리 RealBackendLab 실행은 e2e:journey:real에서 집계합니다.");
test.use({ trace: "off", screenshot: "off" });

const lab = new RealBackendLab();
const fixtureNames = ["B1 조명-001", "B1 조명-002"];

test.beforeAll(async () => {
  test.setTimeout(180_000);
  await lab.start();
});

test.afterAll(async () => {
  await lab.stop();
});

test.afterEach(async ({}, testInfo) => {
  if (testInfo.status !== testInfo.expectedStatus) await lab.writeEvidence(testInfo);
});

test("operator가 발급한 admin이 설치부터 운영하고 viewer는 읽기 전용으로 접근한다", async ({ browser }, testInfo) => {
  test.setTimeout(300_000);
  const operator = await browser.newPage();
  lab.captureNetwork(operator, "operator");

  await operator.goto("/monitoring");
  await login(operator, lab.operator.loginId, lab.operator.password);
  await expect(operator).toHaveURL(/\/operator\/site-admins$/);
  await expect(operator.getByRole("heading", { name: "현장 관리자 계정" })).toBeVisible();

  await operator.getByRole("button", { name: "현장 및 관리자 생성" }).click();
  await operator.getByLabel("고객사명").fill("Task 9 고객사");
  await operator.getByLabel("현장명").fill("Task 9 지하주차장");
  await operator.getByLabel("관리자 이름").fill(lab.admin.name);
  await operator.getByLabel("로그인 아이디").fill(lab.admin.loginId);
  await operator.getByLabel("초기 비밀번호").fill(lab.admin.password);
  const createResponsePromise = operator.waitForResponse((response) => (
    response.url().endsWith("/api/operator/site-admins") && response.request().method() === "POST"
  ));
  await operator.getByRole("button", { name: "생성", exact: true }).click();
  const createResponse = await createResponsePromise;
  expect(createResponse.status()).toBe(201);
  const created = await createResponse.json() as { siteId: string; installationStatus: string };
  expect(created.installationStatus).toBe("pending");
  expect(hasPasswordField(created)).toBe(false);
  await expect(operator.getByText("현장과 관리자 계정을 생성했습니다.")).toBeVisible();
  await expect(operator.getByText(lab.admin.loginId)).toBeVisible();
  await lab.screenshot(operator, testInfo, "01-operator-site-admin-created");

  for (const customerRoute of [
    `/monitoring?siteId=${created.siteId}`,
    `/control?siteId=${created.siteId}`,
    `/statistics?siteId=${created.siteId}`,
    `/settings?siteId=${created.siteId}`
  ]) {
    await operator.goto(customerRoute);
    await expect(operator).toHaveURL(/\/operator\/site-admins$/);
  }
  lab.assertOperatorNetworkIsolation();
  await operator.getByRole("button", { name: "로그아웃" }).click();

  const admin = await browser.newPage();
  lab.captureNetwork(admin, "admin");
  await admin.goto(`/monitoring?siteId=${created.siteId}`);
  await login(admin, lab.admin.loginId, lab.admin.password);
  await expect(admin).toHaveURL(new RegExp(`/settings\\?siteId=${created.siteId}$`));
  await expect(admin.getByRole("heading", { name: "초기 설치 설정" })).toBeVisible();
  await admin.getByLabel("주소").fill("서울시 Task 9 테스트구 9번지");
  await admin.getByLabel("kWh 단가").fill("160");
  await admin.getByLabel("시간대").selectOption("Asia/Seoul");
  await admin.getByLabel("지하 층수").fill("1");
  await admin.getByLabel("지상 층수").fill("0");
  await admin.getByRole("button", { name: "층 자동 생성" }).click();
  await admin.getByRole("button", { name: "초기 설정 완료" }).click();
  await expect(admin.getByRole("heading", { name: "게이트웨이 등록" })).toBeVisible();

  const installation = await lab.readInstallation();
  expect(installation).toMatchObject({ siteId: created.siteId, timeZone: "Asia/Seoul" });
  await lab.seedGatewayInventory();
  await admin.getByLabel("게이트웨이 이름").fill("Task 9 Gateway");
  await admin.getByLabel("제품 시리얼").fill(lab.gateway.serialNumber);
  await admin.getByLabel("일회성 등록 코드").fill(lab.gateway.claimCode);
  await admin.getByRole("button", { name: "게이트웨이 등록" }).click();
  await expect(admin.getByRole("heading", { name: "조명 등록" })).toBeVisible();
  await lab.attachGatewayPublisher();

  await admin.reload();
  await admin.getByLabel("등록 층").selectOption(installation.floorId);
  await admin.getByLabel("등록 게이트웨이").selectOption(lab.gateway.id);
  await admin.getByRole("button", { name: "조명 검색 시작" }).click();
  await expect(admin.getByText("검색된 미등록 조명이 없습니다.")).toBeVisible();
  await admin.getByRole("button", { name: "다시 검색" }).click();
  await expect(admin.getByText(lab.fixtures[0].serialNumber)).toBeVisible({ timeout: 20_000 });
  await expect(admin.getByText(lab.fixtures[1].serialNumber)).toBeVisible({ timeout: 20_000 });
  await admin.getByLabel("등록 가능 조명 전체 선택").check();
  await admin.getByLabel("이름 접두어").fill("B1 조명-");
  await admin.getByLabel("정격 전력(W)").fill("40.00");
  await admin.getByRole("button", { name: "선택 조명 등록" }).click();
  await expect(admin.getByText("등록 완료").first()).toBeVisible();
  await admin.getByRole("button", { name: "등록 세션 완료" }).click();
  await admin.getByRole("link", { name: "모니터링" }).click();
  await expect(admin.getByRole("heading", { name: "B1 운영 현황" })).toBeVisible();
  await expect(admin.getByText("장비 Health")).toBeVisible();
  await lab.screenshot(admin, testInfo, "02-admin-monitoring");

  await admin.getByRole("link", { name: "제어" }).click();
  await expect(admin.getByRole("heading", { name: "조명 밝기 제어" })).toBeVisible();
  let expectedDimmingCount = lab.dimmingCommandCount();

  await admin.getByRole("checkbox", { name: `${fixtureNames[0]} 선택` }).check();
  await admin.getByRole("button", { name: "30%", exact: true }).click();
  await admin.getByRole("button", { name: "밝기 적용" }).click();
  await lab.waitForDimmingCommandCount(++expectedDimmingCount);
  await expect(admin.getByText("조명 적용 완료")).toBeVisible();

  await admin.getByRole("checkbox", { name: `${fixtureNames[1]} 선택` }).check();
  await admin.getByRole("button", { name: "70%", exact: true }).click();
  await admin.getByRole("button", { name: "밝기 적용" }).click();
  await lab.waitForDimmingCommandCount(++expectedDimmingCount);
  await expect(admin.getByText("조명 적용 완료")).toBeVisible();

  await admin.getByRole("button", { name: "층", exact: true }).click();
  await admin.getByRole("button", { name: "B1", exact: true }).click();
  await admin.getByRole("button", { name: "100%", exact: true }).click();
  await admin.getByRole("button", { name: "밝기 적용" }).click();
  await lab.waitForDimmingCommandCount(++expectedDimmingCount);
  await expect(admin.getByText("조명 적용 완료")).toBeVisible();

  await admin.getByRole("button", { name: "구역 관리" }).click();
  await admin.getByRole("button", { name: "새 구역" }).click();
  await admin.getByLabel("구역 이름").fill("Task 9 구역");
  await admin.getByLabel("층", { exact: true }).selectOption(installation.floorId);
  await admin.getByLabel("게이트웨이", { exact: true }).selectOption(lab.gateway.id);
  await admin.getByLabel(`${fixtureNames[0]} 포함`).check();
  await admin.getByLabel(`${fixtureNames[1]} 포함`).check();
  await admin.getByRole("button", { name: "구역 만들기" }).click();
  await expect(admin.getByText("제어 준비 완료")).toBeVisible({ timeout: 20_000 });
  await admin.getByRole("button", { name: "구역 관리 닫기" }).click();
  await admin.reload();
  await admin.getByRole("button", { name: "구역", exact: true }).click();
  await admin.getByRole("button", { name: "Task 9 구역 선택" }).click();
  await admin.getByRole("button", { name: "0%", exact: true }).click();
  await admin.getByRole("button", { name: "밝기 적용" }).click();
  await lab.waitForDimmingCommandCount(++expectedDimmingCount);
  await expect(admin.getByText("조명 적용 완료")).toBeVisible();

  await lab.publishEnergyHistory("available");
  await admin.getByRole("link", { name: "통계" }).click();
  await expect(admin.getByLabel("오늘 전력 사용량")).toBeVisible();
  await expect(admin.getByText(/현재 등록 조명 2개 .* 24시간 .* 100% 밝기/)).toBeVisible();

  const mapFixtureName = fixtureNames[1];
  const originalPlacement = await lab.readFixturePlacement(mapFixtureName);
  const movedX = 240;
  await admin.getByRole("link", { name: "설정" }).click();
  await admin.getByRole("link", { name: "도면 관리" }).click();
  await admin.getByRole("link", { name: "B1 도면 편집" }).click();
  const canvas = admin.getByLabel("B1 편집 캔버스");
  await expect(admin.getByRole("button", { name: "선택" })).toBeEnabled();
  await canvas.click({ position: originalPlacement });
  const properties = admin.getByRole("complementary", { name: "속성 패널" });
  await expect(properties.getByRole("heading", { name: mapFixtureName })).toBeVisible();
  await properties.getByLabel("X").fill(String(movedX));
  await admin.getByRole("button", { name: "저장", exact: true }).click();
  await expect(admin).toHaveURL(new RegExp(`/settings/floor-plans\\?siteId=${created.siteId}$`));
  await admin.getByRole("link", { name: "모니터링" }).click();
  const movedFixture = admin.getByRole("button", { name: new RegExp(mapFixtureName) });
  await expect(movedFixture).toBeVisible();
  await expect(movedFixture).toHaveCSS("--fixture-left", `${movedX / 12}%`);

  await admin.getByRole("link", { name: "설정" }).click();
  await admin.getByRole("link", { name: "비밀번호 변경" }).click();
  await admin.getByLabel("현재 비밀번호").fill(lab.admin.password);
  await admin.getByLabel("새 비밀번호", { exact: true }).fill(lab.admin.newPassword);
  await admin.getByLabel("새 비밀번호 확인").fill(lab.admin.newPassword);
  await admin.getByRole("button", { name: "비밀번호 변경" }).click();
  await expect(admin.getByRole("status")).toHaveText("비밀번호를 변경했습니다.");
  await admin.getByRole("button", { name: "로그아웃" }).click();

  await admin.getByLabel("아이디").fill(lab.admin.loginId);
  await admin.getByLabel("비밀번호").fill(lab.admin.password);
  await admin.getByRole("button", { name: "로그인" }).click();
  await expect(admin.getByText("아이디 또는 비밀번호를 확인해 주세요.")).toBeVisible();
  await admin.getByLabel("비밀번호").fill(lab.admin.newPassword);
  await admin.getByRole("button", { name: "로그인" }).click();
  await expect(admin.getByRole("heading", { name: "비밀번호 변경" })).toBeVisible();
  await admin.getByRole("link", { name: "모니터링" }).click();
  await expect(admin.getByRole("heading", { name: "B1 운영 현황" })).toBeVisible();
  await admin.getByRole("button", { name: "로그아웃" }).click();

  await lab.seedViewerAccount();
  const viewer = await browser.newPage();
  lab.captureNetwork(viewer, "viewer");
  await viewer.goto(`/monitoring?siteId=${created.siteId}`);
  await login(viewer, lab.viewer.loginId, lab.viewer.password);
  await expect(viewer.getByRole("heading", { name: "B1 운영 현황" })).toBeVisible();
  await viewer.getByRole("link", { name: "제어" }).click();
  await expect(viewer.getByText(/조회 전용 계정입니다/)).toBeVisible();
  await expect(viewer.getByRole("button", { name: "밝기 적용" })).toBeDisabled();
  await viewer.getByRole("link", { name: "설정" }).click();
  await expect(viewer.getByRole("link", { name: "도면 관리" })).toBeVisible();
  await expect(viewer.getByRole("link", { name: "비밀번호 변경" })).toHaveCount(0);
  await viewer.getByRole("link", { name: "도면 관리" }).click();
  await expect(viewer.getByText("도면 미등록")).toBeVisible();
  await expect(viewer.getByRole("link", { name: "B1 도면 편집" })).toHaveCount(0);
  await lab.screenshot(viewer, testInfo, "03-viewer-read-only");

  await lab.assertEvidence();
  await lab.writeEvidence(testInfo);
});

test("테스트 랩 지원 코드는 production Web bundle에 포함되지 않는다", async () => {
  await lab.assertProductionBundleIsolation();
});

async function login(page: Page, loginId: string, password: string) {
  await page.getByLabel("아이디").fill(loginId);
  await page.getByLabel("비밀번호").fill(password);
  await page.getByRole("button", { name: "로그인" }).click();
  await expect(page.getByRole("button", { name: "로그아웃" })).toBeVisible();
}

function hasPasswordField(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  return Object.entries(value).some(([key, nested]) => /password/i.test(key) || hasPasswordField(nested));
}
