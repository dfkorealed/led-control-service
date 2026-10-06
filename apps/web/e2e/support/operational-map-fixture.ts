import type { Page } from "@playwright/test";
import { installSettingsApiRoutes, type SettingsFixture } from "./settings-api";

export const operationalIds = {
  siteId: "99999999-9999-4999-8999-000000000001",
  floorId: "99999999-9999-4999-8999-000000000002",
  gatewayId: "99999999-9999-4999-8999-000000000003"
};
const instant = "2026-10-01T15:00:00.000Z";

// Preserve the designer's original five saved centers and UUIDs. These are
// software route fixtures; no command, DB or device receipt is real.
export function operationalDenseFixtures(): SettingsFixture[] {
  return ([[0, 0], [-18, 0], [18, 0], [0, -18], [0, 18]] as const).map(([dx, dy], index) => ({
    id: `99999999-9999-4999-8999-${String(121 + index).padStart(12, "0")}`,
    name: `Task9 밀집 조명 ${index}`, x: 600 + dx, y: 400 + dy, ratedWatt: 40, brightness: 70,
    status: index === 4 ? "fault" : "online", statusReason: "reported",
    health: index === 4 ? { faultCodes: [1], observedAt: instant } : null,
    rssi: -60, hopCount: 1, commandSuccessRate: 1, lastSeenAt: instant,
    gateway: { id: operationalIds.gatewayId, name: "Task9 Gateway", connectionStatus: "online" },
    controllable: index !== 4, controlBlockReason: index === 4 ? "fixture_fault" : null
  }));
}

export async function installOperationalMapFixture(page: Page, baseURL: string | undefined) {
  if (!baseURL) throw new Error("Operational map fixture requires the configured baseURL");
  const configured = new URL(baseURL);
  if (!["http:", "https:"].includes(configured.protocol)) throw new Error("Operational map fixture requires an HTTP baseURL");
  const origin = configured.origin;
  const api = await installSettingsApiRoutes(page, "admin", {
    ids: operationalIds, fixtures: operationalDenseFixtures(), snapshotGeneratedAt: instant, gatewayHeartbeatAt: instant
  });
  const equipmentPosts: string[] = [];
  await page.route("**/api/**", route => {
    const path = new URL(route.request().url()).pathname;
    if (!path.startsWith("/api/")) return route.fallback();
    if (route.request().method() === "POST" && path.includes("/commands")) equipmentPosts.push(path);
    if (path === "/api/commands") return route.fulfill({ json: {
      items: [], nextCursor: null, generatedAt: instant, retainedFrom: "2026-07-01T15:00:00.000Z", retentionEnabled: false
    } });
    return route.fallback();
  });
  // Register last so this guard runs before every API/static handler. Otherwise
  // an external URL with a known /api path could bypass the origin allowlist.
  await page.route("**/*", route => new URL(route.request().url()).origin === origin
    ? route.fallback() : route.abort("blockedbyclient"));
  return { api, equipmentPosts };
}
