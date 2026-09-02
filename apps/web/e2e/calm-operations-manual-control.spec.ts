import { expect, test } from "@playwright/test";
import { expectMinimumTouchTargetsAfterScrolling, expectNoHorizontalOverflow } from "./support/layout-assertions";
import { installSettingsApiRoutes, type SettingsFixture } from "./support/settings-api";

const ids = {
  site: "77777777-7777-4777-8777-777777777701",
  floor: "77777777-7777-4777-8777-777777777702",
  gateway: "77777777-7777-4777-8777-777777777703"
};

const fixtures: SettingsFixture[] = [{
  id: "77777777-7777-4777-8777-777777777704",
  name: "B2-L01",
  x: 120,
  y: 140,
  ratedWatt: 40,
  brightness: 70,
  status: "online",
  health: { faultCodes: [], observedAt: "2026-09-02T00:00:00.000Z" },
  rssi: -58,
  hopCount: 1,
  commandSuccessRate: 1,
  lastSeenAt: "2026-09-02T00:00:00.000Z",
  gateway: { id: ids.gateway, name: "Gateway B2", connectionStatus: "online" },
  controllable: true,
  controlBlockReason: null
}];

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 1024, height: 768 },
  { width: 390, height: 844 },
  { width: 320, height: 740 }
] as const) {
  test(`${viewport.width}px 수동 제어는 단계·응답 문구·반응형 계약을 유지한다`, async ({ page }) => {
    await page.setViewportSize(viewport);
    const api = await installSettingsApiRoutes(page, "admin", {
      ids: { siteId: ids.site, floorId: ids.floor, gatewayId: ids.gateway },
      fixtures
    });
    await page.goto(`/control?siteId=${ids.site}`);

    await page.getByRole("checkbox", { name: "B2-L01 선택" }).check();
    await page.getByRole("button", { name: "밝기 적용" }).click();
    await expect(page.getByRole("list", { name: "명령 진행" })).toContainText("장비 응답");
    api.setCommandStatus({
      stage: "partial_failed",
      results: [{
        fixtureId: api.dimmingRequests[0].target.type === "fixture" ? api.dimmingRequests[0].target.fixtureId : "",
        fixtureName: "B2-L01",
        status: "failed",
        errorMessage: "게이트웨이 ACK를 확인하지 못했습니다."
      }]
    });

    await expect(page.getByText("게이트웨이 장비 응답을 확인하지 못했습니다.")).toBeVisible();
    await expect(page.getByText(/ACK/i)).toHaveCount(0);
    await expectNoHorizontalOverflow(page);
    if (viewport.width <= 760) await expectMinimumTouchTargetsAfterScrolling(page, ".control-screen");
  });
}
