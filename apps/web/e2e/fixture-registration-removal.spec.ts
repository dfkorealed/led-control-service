import { expect, test, type Page, type Route } from "@playwright/test";
import { expectNoHorizontalOverflow } from "./support/layout-assertions";

const siteId = "11111111-1111-4111-8111-111111111111";
const floorId = "22222222-2222-4222-8222-222222222222";
const fixtureId = "33333333-3333-4333-8333-333333333333";
const operationId = "44444444-4444-4444-8444-444444444444";
const instant = "2026-10-16T00:00:00.000Z";
const fixtureName = "B2 입구 조명";
const serialNumber = "BIO-2026-000001";
type Status = "pending" | "gateway_confirmed" | "completed" | "rejected" | "reconcile_required";
interface RemovalBody { clientRequestId: string; expectedUpdatedAt: string }

async function install(page: Page, role: "admin" | "viewer" = "admin") {
  const state = { status: "pending" as Status, blocked: false, losePost: false, lookupNull: false, lookupFailure: false,
    previewTimestamp: instant, previewName: fixtureName, previewSerial: serialNumber as string | null,
    defaultDashboardReads: 0,
    acceptedBody: null as RemovalBody | null,
    posts: [] as RemovalBody[], gets: [] as string[], unknown: [] as string[] };
  const site = { id: siteId, name: "등록 삭제 검증 현장", address: "서울시", timeZone: "Asia/Seoul", currency: "KRW", tariffKwhRate: 160, updatedAt: instant };
  const floor = { id: floorId, name: "B2", level: -2, displayOrder: 1, status: "active", fixtureCount: 1, activeGroupCount: 0, updatedAt: instant };
  const fixture = { id: fixtureId, name: fixtureName, ratedWatt: 40, updatedAt: instant, serialNumber,
    deviceUuid: "bio:aabbccddeeff", meshAddress: "0x0001", firmwareVersion: "1.0.0" };
  function view() { return { operationId, siteId, floorId, fixtureId, status: state.status,
    errorCode: ["rejected", "reconcile_required"].includes(state.status) ? "GATEWAY_BUSY" : null,
    createdAt: instant, completedAt: state.status === "completed" ? instant : null }; }
  await page.route("**/api/**", async route => {
    const request = route.request(); const url = new URL(request.url());
    if (!url.pathname.startsWith("/api/")) return route.continue();
    const path = url.pathname.slice(4); const method = request.method();
    if (path === "/auth/me") return reply(route, { user: { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", organizationId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", organizationType: "customer",
      loginId: "route-fixture", name: "검증 관리자", role, status: "active", mustChangePassword: false } });
    if (path === "/sites") return reply(route, [{ id: siteId, name: site.name, customerName: "검증 고객" }]);
    if (path === `/sites/${siteId}/dashboard` || path === "/sites/default/dashboard") {
      if (path === "/sites/default/dashboard") state.defaultDashboardReads++;
      return reply(route, {
      generatedAt: instant, capabilities: { read: true, manage: true, commission: true, control: true },
      site: { ...site, customerName: "검증 고객", installationStatus: "installed" },
      summary: { totalFixtures: state.status === "completed" ? 0 : 1, onlineFixtures: state.status === "completed" ? 0 : 1, offlineFixtures: 0, faultFixtures: 0, averageBrightness: 70 },
      floors: [{ ...floor, floorPlan: null, meshControlGroups: [], fixtures: [] }], groups: [], gateways: []
      });
    }
    if (path === `/sites/${siteId}/settings`) return reply(route, { site, floors: [{ ...floor, fixtureCount: state.status === "completed" ? 0 : 1 }] });
    if (path === `/sites/${siteId}/floors/${floorId}/fixtures/settings`) return reply(route, { items: state.status === "completed" ? [] : [fixture], nextCursor: null });
    if (path === `/sites/${siteId}/fixture-groups`) return reply(route, []);
    if (path.includes("bio-sensor-policy")) return reply(route, { enabled: false, revision: 0, ownerUserId: null, maximumResponseSeconds: null, escalationAction: null });
    if (path === "/bio-sensor-profiles") return reply(route, []);
    if (path.includes("monitoring-incidents")) return reply(route, { incidents: [], unreadCount: 0, nextCursor: null, activeCount: 0 });
    if (path.endsWith("/registration-removal-preview")) return reply(route, { fixtureId, fixtureName: state.previewName, serialNumber: state.previewSerial,
      expectedUpdatedAt: state.previewTimestamp, allowed: !state.blocked,
      blockedReasons: state.blocked ? [{ code: "GATEWAY_OFFLINE", message: "Gateway가 오프라인입니다. 연결 후 다시 확인하세요." },
        { code: "SCHEDULE_REFERENCE", message: "야간 스케줄에서 먼저 제외하세요." }] : [] });
    if (path.endsWith("/registration-removals") && method === "POST") {
      const body = request.postDataJSON() as RemovalBody; state.posts.push(body);
      if (state.acceptedBody?.clientRequestId === body.clientRequestId) {
        if (state.acceptedBody.expectedUpdatedAt !== body.expectedUpdatedAt) return reply(route, { code: "REQUEST_CONFLICT" }, 409);
      } else {
        if (body.expectedUpdatedAt !== state.previewTimestamp) return reply(route, { code: "settings_version_conflict" }, 409);
        state.acceptedBody = body;
      }
      if (state.losePost) return route.abort("failed");
      return reply(route, view(), 202);
    }
    if (path.includes("/registration-removals/")) {
      state.gets.push(path);
      if (state.lookupFailure) return reply(route, { message: "unavailable" }, 503);
      return reply(route, state.lookupNull || !state.acceptedBody ? null : view());
    }
    state.unknown.push(`${method} ${path}`);
    return reply(route, { message: `Unhandled fixture: ${method} ${path}` }, 501);
  });
  return state;
}
function reply(route: Route, json: unknown, status = 200) { return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(json) }); }
async function visit(page: Page) { await page.goto(`/settings/site?siteId=${siteId}`); await expect(page.getByRole("heading", { name: "조명 관리" })).toBeVisible(); }
async function open(page: Page) {
  await page.getByRole("button", { name: `${fixtureName} 등록 삭제`, exact: true }).click();
  const dialog = page.getByRole("alertdialog", { name: "조명 등록 삭제" });
  await expect(dialog).toBeVisible(); return dialog;
}

for (const width of [1440, 390]) {
  test(`${width}px: 확인·취소·차단·완료까지 현재 카드와 공통 확인창을 사용한다`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 }); const state = await install(page); await visit(page);
    const button = page.getByRole("button", { name: `${fixtureName} 등록 삭제`, exact: true });
    await button.hover(); await expect(page.getByRole("tooltip", { name: "등록 삭제" })).toBeVisible();
    const bounds = await button.boundingBox(); expect(bounds!.width).toBeGreaterThanOrEqual(44); expect(bounds!.height).toBeGreaterThanOrEqual(44);
    let dialog = await open(page);
    await expect(dialog).toContainText(serialNumber); await expect(dialog).toContainText("공장 초기화·소등");
    await expect(dialog).toContainText("통계와 제어 이력");
    await page.screenshot({ path: testInfo.outputPath(`confirm-${width}.png`) });
    await dialog.getByRole("button", { name: "취소", exact: true }).click();
    await expect(dialog).toHaveCount(0); expect(state.posts).toHaveLength(0); await expect(button).toBeFocused();
    state.blocked = true; dialog = await open(page);
    await expect(dialog).toContainText("Gateway가 오프라인"); await expect(dialog).toContainText("야간 스케줄");
    await expect(dialog.getByRole("button", { name: "등록 삭제", exact: true })).toBeDisabled();
    await page.screenshot({ path: testInfo.outputPath(`blocked-${width}.png`) });
    await dialog.getByRole("button", { name: "취소", exact: true }).click(); expect(state.posts).toHaveLength(0);
    state.blocked = false; dialog = await open(page);
    state.previewTimestamp = "2026-10-16T00:00:00.160Z";
    await dialog.getByRole("button", { name: "등록 삭제", exact: true }).click();
    await expect(page.getByText("삭제 접수 · Gateway 확인 대기", { exact: true })).toBeVisible();
    expect(state.posts).toHaveLength(1);
    expect(state.posts[0].expectedUpdatedAt).toBe("2026-10-16T00:00:00.160Z");
    await expect(page.getByText("조명 등록을 삭제했습니다.", { exact: true })).toHaveCount(0);
    state.status = "gateway_confirmed"; await page.getByRole("button", { name: "상태 확인", exact: true }).click();
    await expect(page.getByText("Gateway 정리 확인 · 서버 반영 중", { exact: true })).toBeVisible();
    await page.reload(); await expect(page.getByText("Gateway 정리 확인 · 서버 반영 중", { exact: true })).toBeVisible();
    expect(state.posts).toHaveLength(1); state.status = "completed";
    await page.getByRole("button", { name: "상태 확인", exact: true }).click();
    await expect(page.getByText("이 층에 등록된 조명이 없습니다.", { exact: true })).toBeVisible();
    await expect(page.getByRole("region", { name: "알림", exact: true })).toContainText("조명 등록을 삭제했습니다.");
    if (width < 760) {
      // The existing compact shell announces toasts and stores their visual
      // history in the alarm center rather than overlaying the small viewport.
      await page.getByRole("button", { name: /^알람센터,/ }).click();
      await expect(page.getByRole("region", { name: "최근 알림", exact: true })).toContainText("조명 등록을 삭제했습니다.");
      await page.screenshot({ path: testInfo.outputPath(`completed-notification-${width}.png`) });
      await page.getByRole("button", { name: "알람센터 닫기", exact: true }).click();
    }
    await expectNoHorizontalOverflow(page); expect(state.unknown).toEqual([]);
    await page.screenshot({ path: testInfo.outputPath(`completed-${width}.png`) });
  });

  test(`${width}px: POST 유실·null·재조회 실패·새로고침은 같은 요청만 복구한다`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 }); const state = await install(page); state.losePost = true; state.lookupNull = true;
    await visit(page); const dialog = await open(page); await dialog.getByRole("button", { name: "등록 삭제", exact: true }).click();
    await expect(page.getByText("요청 결과 미확인", { exact: true })).toBeVisible();
    const original = state.posts[0]; await page.reload();
    await expect(page.getByText("요청 결과 미확인", { exact: true })).toBeVisible();
    expect(state.gets.some(path => path.endsWith(`/by-request/${original.clientRequestId}`))).toBe(true);
    expect(state.posts).toHaveLength(1);
    state.lookupFailure = true; await page.getByRole("button", { name: "상태 확인", exact: true }).click();
    await expect(page.getByRole("button", { name: "상태 확인", exact: true })).toBeEnabled();
    await expect(page.getByText("요청 결과 미확인", { exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(`unknown-recovery-${width}.png`) });
    state.previewTimestamp = "2026-10-16T00:05:00.000Z";
    await page.getByRole("button", { name: "같은 요청 다시 보내기", exact: true }).click();
    await expect.poll(() => state.posts.length).toBe(2); expect(state.posts[1]).toEqual(original);
    state.lookupFailure = false; state.lookupNull = false; state.status = "reconcile_required";
    await page.getByRole("button", { name: "상태 확인", exact: true }).click();
    await expect(page.getByText("결과 재조정 필요", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "같은 요청 다시 보내기", exact: true })).toHaveCount(0);
    await page.reload(); await expect(page.getByText("결과 재조정 필요", { exact: true })).toBeVisible();
    expect(state.posts).toHaveLength(2); expect(state.unknown).toEqual([]);
  });

  test(`${width}px: 이름·시리얼 변경은 재확인하고 telemetry timestamp만 최신값으로 전송한다`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 }); const state = await install(page); await visit(page);
    const dialog = await open(page);
    state.previewName = "변경된 입구 조명"; state.previewSerial = "BIO-2026-CHANGED";
    state.previewTimestamp = "2026-10-16T00:00:00.170Z";
    await dialog.getByRole("button", { name: "등록 삭제", exact: true }).click();
    await expect(dialog).toContainText("변경된 이름과 시리얼을 확인한 뒤 다시 등록 삭제를 눌러 주세요.");
    await expect(dialog).toContainText(state.previewName); await expect(dialog).toContainText(state.previewSerial);
    expect(state.posts).toHaveLength(0);
    await expect(dialog.getByRole("button", { name: "등록 삭제", exact: true })).toBeEnabled();
    await page.screenshot({ path: testInfo.outputPath(`identity-reconfirmation-${width}.png`) });
    state.previewTimestamp = "2026-10-16T00:00:00.180Z";
    await dialog.getByRole("button", { name: "등록 삭제", exact: true }).click();
    await expect.poll(() => state.posts.length).toBe(1);
    expect(state.posts[0].expectedUpdatedAt).toBe("2026-10-16T00:00:00.180Z");
    await expect(page.getByText("삭제 접수 · Gateway 확인 대기", { exact: true })).toBeVisible();
    expect(state.unknown).toEqual([]);
  });

  test(`${width}px: siteId 없는 기본 현장 진입도 완료 직후 shell 조명 수를 갱신한다`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 }); const state = await install(page);
    await page.goto("/settings/site");
    await expect(page.getByRole("heading", { name: "조명 관리" })).toBeVisible();
    const summary = page.getByRole("region", { name: "현장 전체", exact: true });
    await expect(summary.getByRole("definition").first()).toHaveText("1대");
    const initialReads = state.defaultDashboardReads;
    expect(initialReads).toBeGreaterThan(0);
    const dialog = await open(page);
    await dialog.getByRole("button", { name: "등록 삭제", exact: true }).click();
    await expect(page.getByText("삭제 접수 · Gateway 확인 대기", { exact: true })).toBeVisible();
    state.status = "completed";
    await page.getByRole("button", { name: "상태 확인", exact: true }).click();
    await expect(page.getByText("이 층에 등록된 조명이 없습니다.", { exact: true })).toBeVisible();
    await expect(summary.getByRole("definition").first()).toHaveText("0대");
    expect(state.defaultDashboardReads).toBeGreaterThan(initialReads);
    expect(new URL(page.url()).search).toBe("");
    expect(state.posts).toHaveLength(1); expect(state.unknown).toEqual([]);
    await page.screenshot({ path: testInfo.outputPath(`default-site-completed-${width}.png`) });
  });
}

test("viewer는 manage capability가 있어도 등록 삭제 아이콘을 받지 않는다", async ({ page }) => {
  await install(page, "viewer"); await visit(page);
  await expect(page.getByRole("button", { name: `${fixtureName} 등록 삭제`, exact: true })).toHaveCount(0);
});

test("전용 15342 서버는 route fixture가 없는 API를 외부 proxy 전에 차단한다", async ({ request }) => {
  const response = await request.get("/api/unconfigured-isolation-probe");
  expect(response.status()).toBe(501);
  expect(await response.json()).toEqual({ message: "Unhandled registration-removal route fixture" });
});
