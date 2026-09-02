import { expect, test, type Browser, type Locator, type Page } from "@playwright/test";
import { expectNoHorizontalOverflow } from "./support/layout-assertions";
import { installSettingsApiRoutes } from "./support/settings-api";
import type { RegistrationSession } from "../src/api/registration";

const viewports = [
  { width: 1440, height: 900 },
  { width: 1024, height: 768 },
  { width: 390, height: 844 },
  { width: 320, height: 740 }
] as const;

const ids = {
  site: "22222222-2222-4222-8222-222222222222",
  floor: "44444444-4444-4444-8444-444444444444",
  gateway: "77777777-7777-4777-8777-777777777771"
} as const;

const discoveredNode = {
  id: "66666666-6666-4666-8666-666666666666",
  sessionId: "88888888-8888-4888-8888-888888888888",
  deviceUuid: "esp32h2-b2-001",
  serialNumber: "LC-B2-001",
  rssi: -54,
  oobCapability: "static-oob",
  firmwareVersion: "1.0.0",
  status: "discovered" as const,
  identifyState: "idle",
  meshAddress: null,
  errorMessage: null,
  scanCorrelationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  scanAttempt: 1,
  discoveredAt: "2026-08-26T00:01:59.000Z"
};

function registrationSession(nodes: RegistrationSession["discoveredNodes"]): RegistrationSession {
  return {
    id: discoveredNode.sessionId,
    siteId: ids.site,
    floorId: ids.floor,
    gatewayId: ids.gateway,
    requestedBy: "99999999-9999-4999-8999-999999999999",
    status: "active",
    scanStatus: "completed",
    scanCorrelationId: discoveredNode.scanCorrelationId,
    scanAttempt: 1,
    scanStartedAt: "2026-08-26T00:00:00.000Z",
    scanCompletedAt: "2026-08-26T00:01:00.000Z",
    scanFailureCode: null,
    scanFailureMessage: null,
    startedAt: "2026-08-26T00:00:00.000Z",
    completedAt: null,
    discoveredNodes: nodes
  };
}

for (const viewport of viewports) {
  test(`commissioning states stay responsive at ${viewport.width}px`, async ({ browser, baseURL }) => {
    await withFixturePage(browser, baseURL, viewport, async (page) => {
      await installSettingsApiRoutes(page, "admin", { installationStatus: "pending", ids: fixtureIds() });
      await page.goto(`/settings?siteId=${ids.site}`);
      await expect(page.getByRole("heading", { name: "현장 기본 정보를 입력하세요" })).toBeVisible();
      await expect(page.getByRole("list", { name: "현장 설치 진행" })).toContainText("Gateway 연결");
      await page.getByLabel("주소").fill("서울시 강남구");
      await expectNoHorizontalOverflow(page);
      await expectTouchTargets(page, ["주소 미입력", "층 자동 생성", "초기 설정 완료"], viewport.width);
    });

    await withFixturePage(browser, baseURL, viewport, async (page) => {
      await installSettingsApiRoutes(page, "viewer", { installationStatus: "pending", ids: fixtureIds() });
      await page.goto(`/settings?siteId=${ids.site}`);
      await expect(page.getByRole("region", { name: "Viewer 설치 대기" })).toBeVisible();
      await expect(page.getByRole("heading", { name: "게이트웨이 등록" })).toHaveCount(0);
      await expectNoHorizontalOverflow(page);
    });

    await withFixturePage(browser, baseURL, viewport, async (page) => {
      await installSettingsApiRoutes(page, "admin", { fixtures: [], includeGateway: false, ids: fixtureIds() });
      await page.goto(`/settings?siteId=${ids.site}`);
      await expect(page.getByRole("region", { name: "Gateway 연결" })).toBeVisible();
      await page.getByLabel("제품 시리얼").fill("GW-E2E-NEW");
      await page.getByLabel("일회성 등록 코드").fill("claim-code");
      await expect(page.getByRole("button", { name: "게이트웨이 등록" })).toBeEnabled();
      await expectNoHorizontalOverflow(page);
      await expectTouchTargets(page, ["게이트웨이 등록"], viewport.width);
    });

    await withFixturePage(browser, baseURL, viewport, async (page) => {
      const empty = registrationSession([]);
      await installSettingsApiRoutes(page, "admin", {
        fixtures: [], ids: fixtureIds(), registrationSession: empty, registrationRetrySession: empty
      });
      await page.goto(`/settings?siteId=${ids.site}`);
      await startSearch(page);
      await expect(page.getByText("검색된 미등록 조명이 없습니다.")).toBeVisible();
      await page.getByRole("button", { name: "다시 검색" }).click();
      await expectNoHorizontalOverflow(page);
    });

    await withFixturePage(browser, baseURL, viewport, async (page) => {
      const discovered = registrationSession([discoveredNode]);
      await installSettingsApiRoutes(page, "admin", { fixtures: [], ids: fixtureIds(), registrationSession: discovered });
      await page.goto(`/settings?siteId=${ids.site}`);
      await startSearch(page);
      await page.getByLabel("조명 1 선택").check();
      await expect(page.getByRole("button", { name: "선택 조명 등록" })).toBeEnabled();
      await page.getByRole("radio", { name: "개별 설정" }).check();
      await page.getByLabel("조명 1 X 좌표").fill("120");
      await page.getByRole("button", { name: "선택 조명 등록" }).click();
      await expect(page.locator(".individual-error")).toHaveText("X와 Y 좌표를 모두 입력하거나 모두 비워주세요.");
      await expectNoHorizontalOverflow(page);
      await expectTouchTargets(page, ["선택 조명 등록"], viewport.width);
    });

    await withFixturePage(browser, baseURL, viewport, async (page) => {
      const reconcile = registrationSession([{ ...discoveredNode, status: "reconcile_required", errorMessage: "Gateway ACK 확인 필요" }]);
      await installSettingsApiRoutes(page, "admin", { fixtures: [], ids: fixtureIds(), registrationSession: reconcile });
      await page.goto(`/settings?siteId=${ids.site}`);
      await startSearch(page);
      await expect(page.getByRole("list", { name: "조명 등록 진행" })).toContainText("상태 확인");
      await page.getByLabel("장비 상태를 확인했으며 현재 세션에서 제외").check();
      await expect(page.getByRole("button", { name: "현재 세션에서 제외" })).toBeEnabled();
      await expectNoHorizontalOverflow(page);
      await expectTouchTargets(page, ["현재 세션에서 제외"], viewport.width);
    });
  });
}

function fixtureIds() {
  return { siteId: ids.site, floorId: ids.floor, gatewayId: ids.gateway };
}

async function startSearch(page: Page) {
  await page.getByLabel("등록 층").selectOption(ids.floor);
  await page.getByLabel("등록 게이트웨이").selectOption(ids.gateway);
  await page.getByRole("button", { name: "조명 검색 시작" }).click();
}

async function expectTouchTargets(page: Page, actionNames: readonly string[], width: number) {
  if (width > 760) return;
  for (const actionName of actionNames) {
    const action = page.getByRole("button", { name: actionName });
    await action.scrollIntoViewIfNeeded();
    await expectMinimumTouchTargetSize(action);
  }
}

async function expectMinimumTouchTargetSize(target: Locator) {
  const bounds = await target.boundingBox();
  expect(bounds).not.toBeNull();
  if (!bounds) return;
  expect(bounds.width).toBeGreaterThanOrEqual(44);
  expect(bounds.height).toBeGreaterThanOrEqual(44);
}

async function withFixturePage(
  browser: Browser,
  baseURL: string | undefined,
  viewport: { width: number; height: number },
  run: (page: Page) => Promise<void>
) {
  const page = await browser.newPage({ baseURL, viewport });
  try {
    await run(page);
  } finally {
    await page.close();
  }
}
