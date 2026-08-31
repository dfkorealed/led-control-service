import { expect, test, type Locator, type Page } from "@playwright/test";
import { RealBackendLab } from "./support/real-backend-lab";

test.describe.configure({ mode: "serial" });
test.use({
  actionTimeout: 15_000,
  baseURL: `http://127.0.0.1:${Number(process.env.E2E_LAB_WEB_PORT ?? 15173)}`,
  trace: "off",
  screenshot: "off",
});

const lab = new RealBackendLab();
const targetName = "B2-001";
const sensorName = "B2-SENSOR-001";

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

test("admin creates and executes schedule and vehicle event rules", async ({ browser }, testInfo) => {
  test.setTimeout(360_000);
  const operator = await browser.newPage();
  await operator.goto("/monitoring");
  await login(operator, lab.operator.loginId, lab.operator.password);
  await operator.getByRole("button", { name: "현장 및 관리자 생성" }).click();
  await operator.getByLabel("고객사명").fill("Task 19 고객사");
  await operator.getByLabel("현장명").fill("Task 19 지하주차장");
  await operator.getByLabel("관리자 이름").fill(lab.admin.name);
  await operator.getByLabel("로그인 아이디").fill(lab.admin.loginId);
  await operator.getByLabel("초기 비밀번호").fill(lab.admin.password);
  const createSite = operator.waitForResponse((response) =>
    response.url().endsWith("/api/operator/site-admins") && response.request().method() === "POST");
  await operator.getByRole("button", { name: "생성", exact: true }).click();
  const created = await (await createSite).json() as { siteId: string };
  await operator.close();

  const admin = await browser.newPage();
  lab.captureNetwork(admin, "admin");
  await admin.goto(`/monitoring?siteId=${created.siteId}`);
  await login(admin, lab.admin.loginId, lab.admin.password);
  await admin.getByLabel("주소").fill("서울시 Task 19 테스트구 19번지");
  await admin.getByLabel("kWh 단가").fill("160");
  await admin.getByLabel("시간대").selectOption("Asia/Seoul");
  await admin.getByLabel("지하 층수").fill("1");
  await admin.getByLabel("지상 층수").fill("0");
  await admin.getByRole("button", { name: "층 자동 생성" }).click();
  await admin.getByRole("button", { name: "초기 설정 완료" }).click();

  const installation = await lab.readInstallation();
  await lab.seedGatewayInventory();
  await admin.getByLabel("게이트웨이 이름").fill("Task 19 Gateway");
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
  await admin.getByLabel("등록 가능 조명 전체 선택").check();
  await admin.getByLabel("이름 접두어").fill("Task 19 fixture-");
  await admin.getByLabel("정격 전력(W)").fill("40.00");
  await admin.getByRole("button", { name: "선택 조명 등록" }).click();
  await expect(admin.getByText("등록 완료").first()).toBeVisible();
  await admin.getByRole("button", { name: "등록 세션 완료" }).click();

  await lab.startAutomationGateway({ targetName, sensorName });
  await lab.waitForVehicleSensorCapability(sensorName);

  await admin.goto(`/control?siteId=${created.siteId}&mode=schedule`);
  await createSchedule(admin, { brightness: 40, target: targetName });
  await expect(syncRow(admin, "Task 19 상시 스케줄")).toContainText("적용됨", { timeout: 20_000 });
  await lab.waitForFixtureBrightness(targetName, 40);

  await admin.getByRole("tab", { name: "이벤트 제어" }).click();
  await createVehicleEvent(admin, {
    brightness: 80,
    source: sensorName,
    target: targetName,
  });
  await expect(syncRow(admin, "Task 19 차량 이벤트")).toContainText("적용됨", { timeout: 20_000 });
  await lab.injectSensorEdge(sensorName, "detected");
  await lab.waitForFixtureBrightness(targetName, 80);
  await expectFixtureBrightness(admin, created.siteId, targetName, "80%");

  await admin.goto(`/control?siteId=${created.siteId}&mode=manual`);
  await admin.getByRole("checkbox", { name: `${targetName} 선택` }).check();
  await admin.getByRole("slider", { name: "밝기" }).fill("60");
  await admin.getByLabel("수동 override 종료 시각").fill(localDateTimeMinute(new Date(Date.now() + 70_000)));
  await admin.getByRole("button", { name: "밝기 적용" }).click();
  await expect(admin.getByText("조명 적용 완료")).toBeVisible();
  await lab.waitForFixtureBrightness(targetName, 60);
  await expectFixtureBrightness(admin, created.siteId, targetName, "60%");

  await lab.waitForFixtureBrightness(targetName, 80, 90_000);
  await expectFixtureBrightness(admin, created.siteId, targetName, "80%");
  await lab.injectSensorEdge(sensorName, "cleared");
  await lab.waitForFixtureBrightness(targetName, 40, 20_000);
  await expectFixtureBrightness(admin, created.siteId, targetName, "40%");

  await lab.assertAutomationEvidence({ targetName, sensorName });
  await lab.writeEvidence(testInfo);
});

async function login(page: Page, loginId: string, password: string) {
  await page.getByLabel("아이디").fill(loginId);
  await page.getByLabel("비밀번호").fill(password);
  await page.getByRole("button", { name: "로그인" }).click();
  await expect(page.getByRole("button", { name: "로그아웃" })).toBeVisible();
}

async function createSchedule(page: Page, input: { brightness: number; target: string }) {
  const now = new Date();
  await page.getByRole("button", { name: "스케줄 추가" }).click();
  const dialog = page.getByRole("dialog", { name: "스케줄 추가" });
  await dialog.getByLabel("스케줄 이름").fill("Task 19 상시 스케줄");
  await dialog.getByLabel("적용 시작일").fill(siteDate(new Date(now.getTime() - 86_400_000)));
  await dialog.getByLabel("적용 종료일").fill(siteDate(new Date(now.getTime() + 86_400_000)));
  await dialog.getByLabel("시작 시각").fill(siteTime(new Date(now.getTime() - 3_600_000)));
  await dialog.getByLabel("종료 시각").fill(siteTime(new Date(now.getTime() + 3_600_000)));
  await dialog.getByLabel("반복").selectOption("daily");
  await dialog.getByLabel("밝기", { exact: true }).fill(String(input.brightness));
  await dialog.getByRole("checkbox", { name: `${input.target} 선택` }).check();
  await dialog.getByRole("button", { name: "스케줄 만들기" }).click();
  await expect(dialog).toBeHidden();
}

async function createVehicleEvent(
  page: Page,
  input: { brightness: number; source: string; target: string },
) {
  await page.getByRole("button", { name: "이벤트 추가" }).click();
  const dialog = page.getByRole("dialog", { name: "이벤트 추가" });
  await dialog.getByRole("group", { name: "감지 센서" })
    .getByRole("checkbox", { name: `${input.source} 선택` }).check();
  await dialog.getByRole("group", { name: "제어 조명" })
    .getByRole("checkbox", { name: `${input.target} 선택` }).check();
  await dialog.getByLabel("규칙 이름").fill("Task 19 차량 이벤트");
  await dialog.getByLabel("밝기", { exact: true }).fill(String(input.brightness));
  await dialog.getByLabel("유지 시간").fill("5");
  await dialog.getByRole("button", { name: "저장", exact: true }).click();
  await expect(dialog).toBeHidden();
}

function syncRow(page: Page, name: string): Locator {
  return page.getByRole("row").filter({ hasText: name });
}

async function expectFixtureBrightness(
  page: Page,
  siteId: string,
  fixtureName: string,
  brightness: string,
) {
  await page.goto(`/monitoring?siteId=${siteId}`);
  await expect(page.getByRole("button", {
    name: new RegExp(`^${escapeRegExp(fixtureName)} .* ${escapeRegExp(brightness)}$`),
  })).toBeVisible();
}

function siteDate(date: Date) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function siteTime(date: Date) {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Seoul",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(date);
}

function localDateTimeMinute(date: Date) {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
