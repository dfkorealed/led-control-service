import { expect, test, type Page } from "@playwright/test";

const id = (n: number) => `bbbbbbbb-bbbb-4bbb-8bbb-${String(n).padStart(12, "0")}`;
const site = id(1), floorId = id(2), gateway = id(3), legacy = id(4), target = id(6);
const modeVerification = { commandId: null, status: "unverified", modeVerified: false, verifiedAt: null };

async function installFixture(page: Page, origin: string) {
  const writes: string[] = [], unexpected: string[] = [];
  const fixtures = [legacy, target].map((fixtureId, index) => ({ id: fixtureId, name: index ? "B1-L006" : "B1-L004",
    x: 250 + 200 * index, y: 300, ratedWatt: 40, brightness: 70, status: "online", health: null,
    rssi: -50, hopCount: 1, commandSuccessRate: 1, lastSeenAt: new Date().toISOString(), controllable: true, controlBlockReason: null,
    gateway: { id: gateway, name: "GW-B1", assignmentVersion: 1, connectionStatus: "online" },
    vehicleEventSource: { sensorProtocol: index ? "bio-usb-pulse" : "bluez-stateful", sourceEligible: false,
      targetEligible: true, readiness: "off", capabilityEvidence: null, blockReasons: ["capability_unverified"], modeVerification },
    bioSensorPreparation: { preparationCandidate: Boolean(index), status: "unverified", commandId: null, profileKey: null,
      observedAt: null, blockedReasons: index ? ["mode_unverified"] : ["binding_changed"] } }));
  const siteView = { id: site, name: "격리 현장", customerName: "격리 고객", installationStatus: "installed",
    address: null, timeZone: "Asia/Seoul", currency: "KRW", tariffKwhRate: 160, updatedAt: new Date().toISOString() };
  const dashboard = { site: siteView, generatedAt: new Date().toISOString(), capabilities: { read: true, manage: true, control: true, commission: true },
    summary: { totalFixtures: 2, onlineFixtures: 2, faultFixtures: 0, averageBrightness: 70 },
    monitoringPolicy: { gatewayOfflineAfterSeconds: 90, fixtureStaleAfterSeconds: 180 }, groups: [], gateways: [],
    floors: [{ id: floorId, name: "B1", level: -1, floorPlan: null, fixtures, meshControlGroups: [] }] };
  await page.route("**/*", async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== origin && !["data:", "blob:"].includes(url.protocol)) return route.abort();
    if (!url.pathname.startsWith("/api/")) return route.continue();
    if (!["GET", "HEAD"].includes(request.method())) {
      writes.push(`${request.method()} ${url.pathname}`);
      return route.fulfill({ status: 501, json: { message: "fixture forbids writes" } });
    }
    const path = url.pathname;
    if (path === "/api/auth/me") return route.fulfill({ json: { user: { id: id(20), organizationId: id(21), organizationType: "customer",
      loginId: "fixture-admin", name: "관리자", role: "admin", status: "active", mustChangePassword: false } } });
    if (path === "/api/sites") return route.fulfill({ json: [siteView] });
    if (path.endsWith("/dashboard")) return route.fulfill({ json: dashboard });
    if (path.endsWith("/map-snapshot")) return route.fulfill({ json: { floorId, revision: 1, width: 1000, height: 800, floorPlan: null, objects: [] } });
    if (path.endsWith("/automation/vehicle-event-rules")) return route.fulfill({ json: { items: [], total: 0, filteredTotal: 0, nextCursor: null,
      siteSummary: { ruleCount: 0, syncRuleCounts: { APPLIED: 0, PENDING: 0, REJECTED: 0 } } } });
    if (path.endsWith("/settings")) return route.fulfill({ json: { site: siteView, floors: [] } });
    if (path.endsWith("/bio-sensor-policy")) return route.fulfill({ json: { enabled: false, ownerUserId: null, maximumResponseSeconds: null, escalationAction: null, revision: 1 } });
    if (path.endsWith("/monitoring-incidents")) return route.fulfill({ json: { incidents: [], unreadCount: 0, activeCount: 0, nextCursor: null } });
    if (path.endsWith("/fixture-groups")) return route.fulfill({ json: { items: [], total: 0, nextCursor: null } });
    unexpected.push(path); return route.fulfill({ status: 501, json: { message: "unhandled fixture read" } });
  });
  return { writes, unexpected };
}

for (const width of [1440, 390]) test(`blocked source explains recovery and opens existing settings at ${width}px`, async ({ page, baseURL }) => {
  const fixture = await installFixture(page, baseURL!);
  await page.setViewportSize({ width, height: 900 }); await page.goto(`/control?siteId=${site}&mode=event`);
  await page.getByRole("button", { name: "이벤트 추가", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "이벤트 추가" });
  await dialog.getByRole("button", { name: "감지 센서 선택", exact: true }).click();
  await expect(dialog.getByRole("button", { name: /B1-L004.*등록 연결 재확인 필요/ })).toBeDisabled();
  await expect(dialog.getByRole("button", { name: "선택 완료", exact: true })).toBeDisabled();
  await dialog.getByRole("link", { name: "등록 연결 확인하러 가기" }).click();
  await expect(page).toHaveURL(`/settings/site?siteId=${site}#bio-sensor-preparation`);
  const section = page.locator("#bio-sensor-preparation"); await expect(section).toBeVisible();
  await section.getByRole("button", { name: /준비 상태를 확인할 조명/ }).click();
  await page.getByRole("option", { name: "B1-L004", exact: true }).click();
  await expect(section.getByRole("button", { name: "등록 연결 확인", exact: true })).toBeEnabled();
  await expect(section.getByRole("button", { name: "센서 사용 설정", exact: true })).toBeDisabled();
  await expect(section).toContainText("등록 연결 재확인 필요");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(fixture.writes).toEqual([]); expect(fixture.unexpected).toEqual([]);
});
