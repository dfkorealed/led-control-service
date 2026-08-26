import { expect, test } from "@playwright/test";
import { RealBackendLab } from "./support/real-backend-lab";

test.describe.configure({ mode: "serial" });

const lab = new RealBackendLab();

test.beforeAll(async () => {
  test.setTimeout(180_000);
  test.skip(process.env.E2E_REAL_BACKEND_LAB !== "1", "E2E_REAL_BACKEND_LAB=1에서만 격리 실백엔드 랩을 실행합니다.");
  await lab.start();
});

test.afterAll(async () => {
  await lab.stop();
});

test("운영자 설치부터 고객 관리자 운영까지 실제 API와 MQTT 계약으로 이어진다", async ({ browser }, testInfo) => {
  test.setTimeout(240_000);
  const operator = await browser.newPage();
  lab.captureNetwork(operator);

  await operator.goto("/monitoring");
  await login(operator, lab.operator.email, lab.operator.password);
  await expect(operator.getByRole("heading", { name: "초기 설치 설정" })).toBeVisible();

  await operator.getByLabel("고객사명").fill("Task 11 고객사");
  await operator.getByLabel("현장명").fill("Task 11 지하주차장");
  await operator.getByLabel("주소").fill("서울시 테스트구 11번지");
  await operator.getByLabel("kWh 단가").fill("160");
  await operator.getByLabel("지하 층수").fill("1");
  await operator.getByLabel("지상 층수").fill("0");
  await operator.getByRole("button", { name: "층 자동 생성" }).click();
  await operator.getByRole("button", { name: "초기 설정 완료" }).click();
  await expect(operator.getByRole("heading", { name: "게이트웨이 등록" })).toBeVisible();

  const installation = await lab.readInstallation();
  expect(installation.timeZone).toBe("Asia/Seoul");
  await lab.seedGatewayInventory();
  await operator.getByLabel("게이트웨이 이름").fill("Task 11 게이트웨이");
  await operator.getByLabel("제품 시리얼").fill(lab.gateway.serialNumber);
  await operator.getByLabel("일회성 등록 코드").fill(lab.gateway.claimCode);
  await operator.getByRole("button", { name: "게이트웨이 등록" }).click();
  await expect(operator.getByRole("heading", { name: "조명 등록" })).toBeVisible();
  await lab.attachGatewayPublisher();

  await operator.reload();
  await operator.getByLabel("등록 층").selectOption(installation.floorId);
  await operator.getByLabel("등록 게이트웨이").selectOption(lab.gateway.id);
  await operator.getByRole("button", { name: "조명 검색 시작" }).click();
  await expect(operator.getByText("검색된 미등록 조명이 없습니다.")).toBeVisible();
  await operator.getByRole("button", { name: "다시 검색" }).click();
  await expect(operator.getByText(lab.fixtures[0].serialNumber)).toBeVisible({ timeout: 20_000 });
  await expect(operator.getByText(lab.fixtures[1].serialNumber)).toBeVisible({ timeout: 20_000 });
  await operator.getByLabel("등록 가능 조명 전체 선택").check();
  await operator.getByLabel("이름 접두어").fill("B1 조명-");
  await operator.getByLabel("정격 전력(W)").fill("40.00");
  await operator.getByRole("button", { name: "선택 조명 등록" }).click();
  await expect(operator.getByText("등록 완료").first()).toBeVisible();
  await operator.getByRole("button", { name: "등록 세션 완료" }).click();
  await expect(operator.getByRole("heading", { name: "B1 운영 현황" })).toBeVisible();
  await expect(operator.getByRole("region", { name: "층 도면" })).toBeVisible();
  await expect(operator.getByText("장비 Health")).toBeVisible();
  await expect(operator.locator(".info-list").getByText("정상").first()).toBeVisible();
  await lab.screenshot(operator, testInfo, "01-operator-installation");

  await operator.getByRole("button", { name: "로그아웃" }).click();
  await lab.seedCustomerAdminInvitation();
  const admin = await browser.newPage();
  lab.captureNetwork(admin);
  await admin.goto("/monitoring");
  await signup(admin, lab.admin);
  await login(admin, lab.admin.email, lab.admin.password);

  await admin.getByRole("link", { name: "통계" }).click();
  // Provisioning 직후 실제 첫 publication이 적산되므로 이 journey의 초기 상태는 partial이다.
  await expect(admin.getByText("수집 공백 있음").first()).toBeVisible();
  await expect(admin.getByLabel("오늘 전력 사용량")).toBeVisible();
  await expect(admin.getByRole("img", { name: /일별 상태 기반 추정/ })).toBeVisible();
  await lab.publishEnergyHistory("available");
  await admin.reload();
  await expect(admin.getByLabel("오늘 전력 사용량")).toBeVisible();
  await expect(admin.getByRole("img", { name: /일별 상태 기반 추정/ })).toBeVisible();
  await expect(admin.getByText("이번 달 예상 비용")).toBeVisible();

  await admin.getByRole("link", { name: "제어" }).click();
  await admin.getByRole("button", { name: "구역 관리" }).click();
  await admin.getByRole("button", { name: "새 구역" }).click();
  await admin.getByLabel("구역 이름").fill("입구 구역");
  await admin.getByLabel("층", { exact: true }).selectOption(installation.floorId);
  await admin.getByLabel("게이트웨이", { exact: true }).selectOption(lab.gateway.id);
  await admin.getByLabel("B1 조명-001 포함").check();
  await admin.getByLabel("B1 조명-002 포함").check();
  await admin.getByRole("button", { name: "구역 만들기" }).click();
  await expect(admin.getByText("제어 준비 완료")).toBeVisible({ timeout: 20_000 });
  await admin.getByRole("button", { name: "입구 구역 수정" }).click();
  await admin.getByLabel("구역 이름").fill("입구 통로");
  await admin.getByRole("button", { name: "변경 저장" }).click();
  await expect(admin.getByText("입구 통로")).toBeVisible();
  await admin.getByRole("button", { name: "구역 관리 닫기" }).click();

  await runControl(admin, "fixture");
  await runControl(admin, "fixtures");
  await runControl(admin, "floor");
  await runControl(admin, "group");
  await lab.screenshot(admin, testInfo, "02-admin-control");

  await admin.getByRole("button", { name: "구역 관리" }).click();
  await admin.getByRole("button", { name: "입구 통로 삭제" }).click();
  await admin.getByRole("button", { name: "삭제 확인" }).click();
  await expect(admin.getByText(/구역 삭제를 시작했습니다/)).toBeVisible();
  await lab.screenshot(admin, testInfo, "03-group-retirement");
  await admin.getByRole("button", { name: "구역 관리 닫기" }).click();

  await admin.getByRole("button", { name: "로그아웃" }).click();
  await lab.seedCustomerViewerInvitation();
  const viewer = await browser.newPage();
  lab.captureNetwork(viewer);
  await viewer.goto("/monitoring");
  await signup(viewer, lab.viewer);
  await login(viewer, lab.viewer.email, lab.viewer.password);
  await expect(viewer.getByRole("heading", { name: "B1 운영 현황" })).toBeVisible();
  await viewer.getByRole("link", { name: "제어" }).click();
  await expect(viewer.getByText(/조회 전용 계정입니다/)).toBeVisible();
  await expect(viewer.getByRole("button", { name: "밝기 적용" })).toBeDisabled();
  await viewer.getByRole("link", { name: "통계" }).click();
  await expect(viewer.getByLabel("오늘 전력 사용량")).toBeVisible();
  await lab.screenshot(viewer, testInfo, "04-viewer-readonly");

  await lab.assertEvidence();
  await lab.writeEvidence(testInfo);
});

test("테스트 랩 지원 코드는 production Web bundle에 포함되지 않는다", async () => {
  await lab.assertProductionBundleIsolation();
});

async function login(page: import("@playwright/test").Page, email: string, password: string) {
  await page.getByLabel("아이디").fill(email);
  await page.getByLabel("비밀번호").fill(password);
  await page.getByRole("button", { name: "로그인" }).click();
  await expect(page.getByRole("button", { name: "로그아웃" })).toBeVisible();
}

async function signup(
  page: import("@playwright/test").Page,
  user: { invitationToken: string; name: string; email: string; password: string }
) {
  await page.getByRole("button", { name: "초대 코드를 가지고 회원가입" }).click();
  await page.getByLabel("초대 코드").fill(user.invitationToken);
  await page.getByLabel("이름").fill(user.name);
  await page.getByLabel("아이디").fill(user.email);
  await page.getByLabel("비밀번호").fill(user.password);
  await page.getByRole("button", { name: "가입하기" }).click();
  await expect(page.getByText("가입이 완료되었습니다. 설정한 계정으로 로그인해 주세요.")).toBeVisible();
}

async function runControl(page: import("@playwright/test").Page, mode: "fixture" | "fixtures" | "floor" | "group") {
  if (mode === "fixture" || mode === "fixtures") {
    await page.getByRole("button", { name: "개별/다중" }).click();
    await page.getByLabel("B1 조명-001 선택").check();
    if (mode === "fixtures") await page.getByLabel("B1 조명-002 선택").check();
  } else if (mode === "floor") {
    await page.getByRole("button", { name: "층" }).click();
    await page.getByRole("button", { name: "B1" }).click();
  } else {
    await page.getByRole("button", { name: "구역", exact: true }).click();
    await page.getByRole("button", { name: "입구 통로 선택" }).click();
  }
  await page.getByLabel("밝기").fill(mode === "fixture" ? "25" : mode === "fixtures" ? "50" : mode === "floor" ? "75" : "100");
  await page.getByRole("button", { name: "밝기 적용" }).click();
  await expect(page.getByText("조명 적용 완료")).toBeVisible({ timeout: 20_000 });
}
