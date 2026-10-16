import { expect, test, type Page } from "@playwright/test";

const id = (n: number) => `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, "0")}`;
const site = id(1), gateway = id(3), source = id(10), target = id(11);

async function installFixture(page: Page, origin: string, failFirst = false) {
  let prepared = false;
  const requests: Array<{ clientRequestId: string; fixtureId: string; operation: string }> = [];
  const patches: Array<Record<string, unknown>> = [];
  let row = { id: id(90), name: "센서 자동 제어", status: "disabled", sensorProtocol: "bio-usb-pulse", gatewayId: gateway,
    sourceFixtureIds: [source], sourceCount: 1, sources: [{ fixtureId: source }], targetFixtureIds: [target], targetCount: 1,
    targets: [{ fixtureId: target }], action: { dimmingEnabled: true, brightnessPercent: 80 }, holdSeconds: 10,
    desiredRevision: 1, appliedRevision: 1, syncStatus: "APPLIED", lastDetection: null, lastExecution: null,
    createdById: id(20), updatedById: id(20), createdAt: "2026-10-15T00:00:00.000Z", updatedAt: "2026-10-15T00:00:00.000Z" };
  await page.route("**/*", async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== origin && !["data:", "blob:"].includes(url.protocol)) return route.abort();
    const path = url.pathname;
    if (path === `/api/sites/${site}/dashboard` || path === "/api/sites/default/dashboard") {
      const response = await route.fetch(), dashboard = await response.json();
      for (const floor of dashboard.floors) for (const fixture of floor.fixtures) {
        const ready = prepared && fixture.id === source;
        fixture.vehicleEventSource = { sensorProtocol: "bio-usb-pulse", readiness: ready ? "ready" : "off", sourceEligible: ready,
          capabilityEvidence: ready ? "ready" : "off", targetEligible: true, blockReasons: ready ? [] : ["mode_unverified"],
          modeVerification: { commandId: null, status: "unverified", modeVerified: false, verifiedAt: null } };
        fixture.bioSensorPreparation = { preparationCandidate: true, status: ready ? "ready" : "unverified", commandId: null,
          profileKey: null, observedAt: null, blockedReasons: ready ? [] : ["mode_unverified"] };
      }
      return route.fulfill({ json: dashboard });
    }
    if (path === `/api/sites/${site}/automation/vehicle-event-rules`) return route.fulfill({ json: { items: [row], total: 1, filteredTotal: 1,
      siteSummary: { ruleCount: 1, syncRuleCounts: { APPLIED: 1, PENDING: 0, REJECTED: 0 } }, nextCursor: null } });
    if (path === `/api/sites/${site}/automation/vehicle-event-rules/${id(90)}` && request.method() === "PATCH") {
      const input = request.postDataJSON(); patches.push(input);
      if (!prepared) return route.fulfill({ status: 409, json: { message: "not prepared" } });
      row = { ...row, ...input }; return route.fulfill({ json: row });
    }
    if (path === "/api/bio-sensor-preparations" && request.method() === "POST") {
      const input = request.postDataJSON(); requests.push(input);
      return route.fulfill({ json: { commandId: id(95), siteId: site, fixtureId: input.fixtureId, status: "pending" } });
    }
    if (path === `/api/bio-sensor-preparations/${id(95)}`) {
      prepared = !(failFirst && requests.length === 1);
      return route.fulfill({ json: { commandId: id(95), siteId: site, fixtureId: source, status: prepared ? "ready" : "unverified", supersededAt: null } });
    }
    return route.continue();
  });
  return { requests, patches };
}

for (const width of [1440, 390]) test(`direct settings and automatic activation at ${width}px`, async ({ page, baseURL }) => {
  const field = await installFixture(page, baseURL!);
  await page.setViewportSize({ width, height: 900 }); await page.goto(`/control?siteId=${site}&mode=event`);
  await expect(page.getByRole("button", { name: "센서 자동 제어 활성화", exact: true })).toBeEnabled();
  expect(field.requests).toHaveLength(0);
  await page.getByRole("button", { name: "센서 자동 제어 작업", exact: true }).click();
  await page.getByRole("menuitem", { name: "수정", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "이벤트 수정" });
  await expect(dialog.getByRole("button", { name: /센서 사용 설정|준비 상태 확인|요청 결과 확인/ })).toHaveCount(0);
  await expect(dialog.getByRole("textbox", { name: "유지 시간" })).toHaveValue("10");
  await dialog.getByRole("textbox", { name: "유지 시간" }).fill("1");
  await dialog.getByRole("button", { name: "감지 센서 변경" }).click();
  await expect(dialog.getByRole("button", { name: /B1-L001.*선택 불가/ })).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "1개 조명 선택 완료" })).toBeEnabled();
  await dialog.getByRole("button", { name: "1개 조명 선택 완료" }).click();
  await expect(dialog.getByRole("button", { name: "실행할 조명 변경" })).toBeEnabled();
  await dialog.getByRole("button", { name: "저장", exact: true }).click(); await expect(dialog).toBeHidden();
  expect(field.requests).toHaveLength(1); expect(field.requests[0]).toMatchObject({ operation: "ensure_sensor", fixtureId: source });
  expect(field.patches[0]).toMatchObject({ sourceFixtureIds: [source], status: "disabled", holdSeconds: 1 });
  await page.getByRole("button", { name: "센서 자동 제어 활성화", exact: true }).click();
  await expect(page.getByRole("button", { name: "센서 자동 제어 비활성화", exact: true })).toBeEnabled();
  expect(field.requests).toHaveLength(1); expect(field.patches.at(-1)).toEqual({ status: "enabled" });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("failed setup stays inactive and the same power button retries", async ({ page, baseURL }) => {
  const field = await installFixture(page, baseURL!, true);
  await page.goto(`/control?siteId=${site}&mode=event`);
  const activate = page.getByRole("button", { name: "센서 자동 제어 활성화", exact: true });
  await activate.click();
  const row = page.getByRole("row", { name: /센서 자동 제어.*비활성/ });
  await expect(row.getByRole("alert")).toContainText("조명 연결을 확인한 뒤 다시 시도");
  expect(field.patches).toHaveLength(0); await expect(activate).toBeEnabled();
  await activate.click(); await expect(page.getByRole("button", { name: "센서 자동 제어 비활성화", exact: true })).toBeEnabled();
  expect(field.requests).toHaveLength(2); expect(field.requests[0].clientRequestId).not.toBe(field.requests[1].clientRequestId);
  expect(field.patches).toEqual([{ status: "enabled" }]);
});
