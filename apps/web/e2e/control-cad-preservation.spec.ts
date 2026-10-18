import { test, expect } from "./support/design-system-fixture";
import { installSettingsApiRoutes, commandDetailClockFixture } from "./support/settings-api";
import type { Page, Locator } from "@playwright/test";
import { installPreparedReview, jobId as cadJobId, nativeScene } from "./support/cad-journey";

const commandId = "99999999-9999-4999-8999-000000000711";
const history = {
  ...commandDetailClockFixture, id: commandId, siteId: "site-1", stage: "verified_applied", outcome: "applied",
  targetType: "fixture", targetId: "fixture-1", targetFixtureIds: ["fixture-1"], brightness: 37,
  verificationAttemptCount: 1, dispatchCount: 1, completedFixtureCount: 1, totalFixtureCount: 1, errorMessage: null,
  dispatches: [{ id: "dispatch-history", kind: "dimming", status: "completed", gateway: { id: "gateway-1", name: "Gateway B2" },
    errorMessage: null, results: [{ fixtureId: "fixture-1", fixtureName: "B2-L001", status: "succeeded", errorMessage: null, brightness: 37 }] }]
};

const readPaths = new Set([
  "/api/auth/me", "/api/sites", "/api/sites/default/dashboard", "/api/sites/site-1/dashboard",
  "/api/sites/site-1/floors/floor-1/fixtures", "/api/sites/site-1/floors/floor-1/map-snapshot",
  "/api/floors/floor-1/map-document/manifest", "/api/floors/floor-1/map-document/changes",
  "/api/commands", `/api/commands/${commandId}`, "/api/sites/site-1/temporary-controls",
  "/api/sites/site-1/fixture-groups", "/api/sites/site-1/automation/schedules", "/api/sites/site-1/monitoring-incidents"
]);

async function installControlReadBoundary(page: Page) {
  const unknownApi: string[] = [];
  // The settings fixture has a generic 404 fallback. Fence it here so an
  // unknown API cannot be mistaken for a configured domain mock.
  await page.route("**/api/**", route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    // Vite's /src/api/*.ts modules also match the glob; only the HTTP API
    // namespace belongs to this boundary, just as in the shared fixture.
    if (!path.startsWith("/api/")) return route.fallback();
    if (request.method() !== "GET" || !readPaths.has(path)) {
      unknownApi.push(`${request.method()} ${path}`); return route.abort();
    }
    return route.fallback();
  });
  return unknownApi;
}

test("Control boundary aborts and reports an unknown API and a command write", async ({ page }) => {
  await installSettingsApiRoutes(page, "admin");
  const unknownApi = await installControlReadBoundary(page);
  // No document navigation is needed for this transport defense probe. Use
  // same-origin requests from a locally fulfilled page, with SW still blocked.
  await page.route("**/control-boundary-probe", route => route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Boundary probe</title>" }));
  await page.goto("/control-boundary-probe");
  const blocked = await page.evaluate(async () => Promise.all([
    fetch("/api/control-preservation-unknown").then(() => false, () => true),
    fetch("/api/commands/dimming", { method: "POST", body: "{}" }).then(() => false, () => true)
  ]));
  expect(blocked).toEqual([true, true]);
  expect(unknownApi).toEqual(["GET /api/control-preservation-unknown", "POST /api/commands/dimming"]);
});

async function hit(locator: Locator) {
  await locator.scrollIntoViewIfNeeded();
  const result = await locator.evaluate(element => {
    const r = element.getBoundingClientRect();
    return { width: r.width, height: r.height, rect: r.toJSON(), ancestors: [...(function* () { for (let p = element.parentElement; p; p = p.parentElement) yield p; })()].map(p => ({ tag: p.tagName, class: p.className, rect: p.getBoundingClientRect().toJSON(), scrollWidth: p.scrollWidth, clientWidth: p.clientWidth })), hits: [[r.x + r.width / 2, r.y + r.height / 2], [r.x + 4, r.y + 4], [r.right - 4, r.bottom - 4]]
      .map(([x, y]) => { const hit = document.elementFromPoint(x, y); return Boolean(hit && (hit === element || element.contains(hit))); }),
      hitElements: [[r.x + r.width / 2, r.y + r.height / 2], [r.x + 4, r.y + 4], [r.right - 4, r.bottom - 4]].map(([x, y]) => {
        const hit = document.elementFromPoint(x, y); return { x, y, tag: hit?.tagName, text: hit?.textContent, class: hit?.getAttribute("class") };
      }) };
  });
  await test.info().attach("close-hit", { body: JSON.stringify(result), contentType: "application/json" });
  expect(result.width).toBeGreaterThanOrEqual(44); expect(result.height).toBeGreaterThanOrEqual(44);
  expect(result.hits).toEqual([true, true, true]);
}

async function more(page: Page) {
  const opener = page.getByRole("button", { name: "더보기", exact: true });
  if (await opener.isVisible() && await opener.getAttribute("aria-expanded") === "false") await opener.click();
}

async function expandDetail(page: Page) {
  await more(page);
  // Closing the command does not erase its disclosure preference. Reopening
  // the same history row may already be expanded; use its actual UI state.
  const toggle = page.getByRole("button", { name: "상세 보기", exact: true });
  if (await toggle.isVisible()) await toggle.click();
  await expect(page.getByRole("region", { name: "최근 결과 상세" })).toBeVisible();
}

async function resizeManual(page: Page, width: number) {
  await page.setViewportSize({ width, height: 900 });
  // setViewportSize resolves before Shell's media subscription necessarily
  // commits. Wait for the real compact/desktop presentation, not a delay.
  await expect(page.locator("[data-control-panel]")).toHaveCSS("padding", width < 760 ? "0px" : "20px");
}

for (const width of [320, 390, 1024, 1440]) for (const theme of ["light", "dark"] as const) {
  test(`Control preservation history close keyboard and resize ${width} ${theme}`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript(value => localStorage.setItem("led-control.customer-theme.v1", value), theme);
    await page.addInitScript(() => {
      const records: unknown[] = [];
      (window as unknown as { controlFocusEvidence: unknown[] }).controlFocusEvidence = records;
      for (const type of ["focusin", "focusout"]) document.addEventListener(type, event => {
        const target = event.target as HTMLElement, related = (event as FocusEvent).relatedTarget as HTMLElement | null;
        if (target.getAttribute("role") === "tab") records.push({ type, id: target.id, connected: target.isConnected,
          related: related?.id ?? null, active: (document.activeElement as HTMLElement | null)?.id, at: performance.now() });
      }, true);
    });
    const api = await installSettingsApiRoutes(page, "admin", { readyMapDocument: true });
    const writes: string[] = [];
    page.on("request", request => {
      if (new URL(request.url()).pathname.startsWith("/api/") && !["GET", "HEAD", "OPTIONS"].includes(request.method())) writes.push(`${request.method()} ${request.url()}`);
    });
    // All history/status reads are explicit fixture routes; no command is sent.
    await page.route("**/api/commands?**", route => route.fulfill({ json: { ...commandDetailClockFixture, items: [history], nextCursor: null } }));
    await page.route(`**/api/commands/${commandId}`, route => route.fulfill({ json: history }));
    await page.route("**/api/sites/*/temporary-controls?**", route => route.fulfill({ json: { items: [], nextCursor: null } }));
    await page.route("**/api/sites/site-1/fixture-groups*", route => route.fulfill({ json: [] }));
    await page.route("**/api/sites/site-1/automation/schedules?*", route => route.fulfill({ json: { items: [], total: 0, nextCursor: null } }));
    await page.route("**/api/sites/site-1/monitoring-incidents?*", route => route.fulfill({ json: { incidents: [], activeCount: 0, unreadCount: 0, nextCursor: null } }));
    const unknownApi = await installControlReadBoundary(page);
    try {
    await page.goto("/control?siteId=site-1&mode=manual&keep=literal%25#section");
    const map = page.getByTestId("target-selection-map-viewport"); await expect(map).toBeVisible();
    const pageHeading = page.getByRole("heading", { level: 1 });
    await expect(pageHeading).toHaveCount(1); await expect(pageHeading).toHaveText("조명 제어");
    const originalMap = await map.elementHandle();
    const marker = page.locator("[data-spatial-map-marker]").first(); await marker.click();
    await page.getByRole("button", { name: "지도 확대", exact: true }).click();
    await expect(map).toHaveAttribute("data-zoom", "1.1");
    await page.getByRole("button", { name: new RegExp(`최근 명령 상세: ${commandId}`) }).click();
    if (width < 760) await expect(page.getByRole("region", { name: "최근 결과 상세" })).toHaveCount(0);
    await expandDetail(page);
    await expect(pageHeading).toHaveCount(1); await expect(pageHeading).toHaveText("조명 제어");
    const detail = page.getByRole("region", { name: "최근 결과 상세" });
    await expect(detail).toContainText("37%");
    const close = page.getByRole("button", { name: "명령 상세 닫기", exact: true });
    await expect(close).toHaveCount(1); await hit(close); await close.focus();
    await resizeManual(page, width < 760 ? 1440 : 390);
    await expect(close).toBeVisible(); await expect(close).toBeFocused(); await expect(close).toHaveCount(1);
    await expect(map).toHaveJSProperty("isConnected", true);
    expect(await map.evaluate((element, original) => element === original, originalMap)).toBe(true);
    await expect(marker).toHaveAttribute("aria-pressed", "true"); await expect(map).toHaveAttribute("data-zoom", "1.1");
    await close.click(); await expect(detail).toHaveCount(0);
    await page.getByRole("button", { name: new RegExp(`최근 명령 상세: ${commandId}`) }).click();
    await expandDetail(page);
    await expect(detail).toBeVisible(); await expect(close).toHaveCount(1);
    await resizeManual(page, width); await more(page);
    const manual = page.getByRole("tab", { name: "수동 제어", exact: true });
    const group = page.getByRole("tab", { name: "그룹/구역", exact: true });
    const originalTab = await manual.elementHandle();
    await manual.focus(); await manual.press("ArrowLeft"); await expect(group).toBeFocused();
    await expect(page.getByText("저장된 구역이 없습니다.", { exact: true })).toBeVisible();
    await expect(page).toHaveURL(/mode=group&keep=literal%25#section$/);
    await group.press("Home"); await expect(manual).toBeFocused(); await expect(manual).toBeVisible();
    expect(await manual.evaluate((element, original) => element === original, originalTab)).toBe(true);
    await expect(page.getByRole("tablist", { name: "제어 방식" })).toHaveCount(1);
    await page.getByRole("button", { name: theme === "dark" ? "라이트 모드로 변경" : "다크 모드로 변경", exact: true }).click();
    await expect(manual).toHaveAttribute("aria-selected", "true");
    expect(await manual.evaluate((element, original) => element === original, originalTab)).toBe(true);
    await manual.focus();
    await manual.press("ArrowRight"); await expect(page.getByRole("tab", { name: "스케줄 제어" })).toBeFocused();
    await expect(page.getByText("등록된 스케줄이 없습니다.", { exact: true })).toBeVisible();
    await page.getByRole("tab", { name: "스케줄 제어" }).press("End"); await expect(group).toBeFocused();
    await group.press("ArrowRight"); await expect(manual).toBeFocused();
    await page.goBack(); await expect(group).toHaveAttribute("aria-selected", "true");
    await page.goForward(); await more(page); await expect(manual).toHaveAttribute("tabindex", "0");
    await page.screenshot({ path: info.outputPath(`control-${width}-${theme}.png`) });
    if (width < 760) {
      await manual.focus(); await manual.press("Escape");
      await expect(page.getByRole("button", { name: "더보기", exact: true })).toBeFocused();
      await expect(page.getByRole("tablist", { name: "제어 방식" })).toHaveCount(0);
      await expect(pageHeading).toHaveCount(1); await expect(pageHeading).toHaveText("조명 제어");
    }
    const input = page.getByRole("textbox", { name: "밝기 수치" }); await input.focus();
    await resizeManual(page, 1440); await input.focus();
    await resizeManual(page, 390);
    await expect(input).toBeFocused(); await expect(page.getByRole("button", { name: "더보기", exact: true })).toHaveAttribute("aria-expanded", "false");
    await expect(pageHeading).toHaveCount(1); await expect(pageHeading).toHaveText("조명 제어");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(writes, "Navigation/history/resize must issue zero physical or other writes").toEqual([]);
    await page.screenshot({ path: info.outputPath("control-preservation.png") });
    await info.attach("physical-writes", { body: JSON.stringify(writes), contentType: "application/json" });
    } finally {
      await info.attach("native-focus-events", { body: JSON.stringify(await page.evaluate(() => (window as unknown as { controlFocusEvidence: unknown[] }).controlFocusEvidence)), contentType: "application/json" });
      await info.attach("api-reads", { body: JSON.stringify(api.requests), contentType: "application/json" });
      await info.attach("unknown-api", { body: JSON.stringify(unknownApi), contentType: "application/json" });
      expect(unknownApi, "Unknown APIs and every attempted mutation must abort and fail").toEqual([]);
    }
  });
}

async function installCadBoundary(page: Page) {
  const reads = new Set([
    "/api/auth/me", "/api/sites", "/api/sites/site-1/dashboard", "/api/sites/default/dashboard",
    "/api/sites/site-1/monitoring-incidents", "/api/floors/floor-1/editor-state", "/api/floors/floor-1/editor-revisions",
    "/api/floors/floor-2/editor-state",
    "/api/floors/floor-1/import-jobs/active", "/api/floors/floor-1/import-jobs/applied-overlay",
    `/api/floors/floor-1/import-jobs/${cadJobId}`, `/api/floors/floor-1/import-jobs/${cadJobId}/regions`,
    `/api/floors/floor-1/import-jobs/${cadJobId}/candidates`,
    "/api/floors/floor-1/assets/rendered/content", nativeScene.descriptor.statePath
  ]);
  for (const prefix of ["/api/floors/floor-1/map-document", `/api/floors/floor-1/import-jobs/${cadJobId}/map-document`]) {
    for (const suffix of ["", "/manifest", "/changes", ...[0, 1, 2].map(index => `/tiles/00000000-0000-4000-8000-00000000009${index}`)]) reads.add(prefix + suffix);
  }
  for (const job of [cadJobId, "00000000-0000-4000-8000-000000000081"]) {
    reads.add(nativeScene.descriptor.manifestContentPath.replace(cadJobId, job));
    for (const { descriptor } of nativeScene.tiles) reads.add(nativeScene.descriptor.tileContentPathTemplate.replace(cadJobId, job)
      .replace("{lod}", String(descriptor.lod)).replace("{tileX}", String(descriptor.tileX))
      .replace("{tileY}", String(descriptor.tileY)).replace("{part}", String(descriptor.part)));
  }
  const mutations = new Set([
    "POST /api/floors/floor-1/editor-lease", "DELETE /api/floors/floor-1/editor-lease",
    "POST /api/floors/floor-2/editor-lease", "DELETE /api/floors/floor-2/editor-lease",
    `POST /api/floors/floor-1/import-jobs/${cadJobId}/apply`, `POST /api/floors/floor-1/import-jobs/${cadJobId}/cancel`,
    "POST /api/floors/floor-1/map-document/elements"
  ]);
  const requests: string[] = [], unknown: string[] = [];
  await page.route("**/api/**", route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (!path.startsWith("/api/")) return route.fallback();
    const entry = `${request.method()} ${path}`;
    requests.push(entry);
    if (request.method() === "GET" ? reads.has(path) : mutations.has(entry)) return route.fallback();
    unknown.push(entry);
    return route.abort();
  });
  return { requests, unknown };
}

async function cadGeometry(page: Page, dialog: Locator, preview: Locator) {
  await preview.scrollIntoViewIfNeeded();
  const box = (await preview.boundingBox())!, modal = (await dialog.boundingBox())!;
  expect(box.width).toBeGreaterThan(0); expect(box.height).toBeGreaterThanOrEqual(192);
  expect(box.x).toBeGreaterThanOrEqual(modal.x); expect(box.x + box.width).toBeLessThanOrEqual(modal.x + modal.width + 1);
  expect(modal.x).toBeGreaterThanOrEqual(0); expect(modal.x + modal.width).toBeLessThanOrEqual(page.viewportSize()!.width + 1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect.poll(() => preview.evaluate((element, size) => {
    const r = element.getBoundingClientRect(), zoom = Number((element as HTMLElement).dataset.zoom);
    return zoom > 0 && size.width * zoom <= r.width - 47 && size.height * zoom <= r.height - 47;
  }, { width: nativeScene.manifest.width, height: nativeScene.manifest.height })).toBe(true);
}

for (const width of [320, 390, 1024, 1440]) {
  test(`CAD preservation current preview paint dirty and mock apply ${width}`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript(theme => localStorage.setItem("led-control.customer-theme.v1", theme), width < 760 ? "light" : "dark");
    await installSettingsApiRoutes(page, "admin");
    const api = await installPreparedReview(page);
    api.state().floor.name = "지하 주차장 연결 통로와 비상 대피 구역을 포함한 긴 층 이름";
    const boundary = await installCadBoundary(page);
    let releaseRegions!: () => void, releaseTiles!: () => void;
    const regions = new Promise<void>(resolve => { releaseRegions = resolve; });
    const tiles = new Promise<void>(resolve => { releaseTiles = resolve; });
    await page.route(`**/api/floors/floor-1/import-jobs/${cadJobId}/regions`, async route => { await regions; await route.fallback(); });
    await page.route(`**/api/floors/floor-1/import-jobs/${cadJobId}/map-document/tiles/*`, async route => { await tiles; await route.fallback(); });
    try {
      await page.goto("/settings/floor-plans/floor-1/edit?siteId=site-1");
      const dialog = page.getByRole("dialog", { name: "CAD 가져오기", exact: true });
      const preview = dialog.getByRole("region", { name: "CAD 도면 미리보기" });
      const apply = dialog.getByRole("button", { name: "확인 및 적용", exact: true });
      await expect(apply).toBeVisible();
      await expect(preview).toHaveAttribute("data-preview-ready", "false");
      await expect(apply).toBeDisabled();
      releaseRegions();
      await expect(preview.getByRole("img", { name: "맵 도형" })).toBeVisible();
      await expect(preview).toHaveAttribute("data-preview-ready", "false");
      await expect(apply).toBeDisabled();
      await apply.evaluate(element => (element as HTMLButtonElement).click());
      expect(api.payloads).toEqual([]);
      releaseTiles();
      await expect(preview).toHaveAttribute("data-preview-ready", "true");
      await expect(apply).toBeEnabled();
      await cadGeometry(page, dialog, preview);
      await page.screenshot({ path: info.outputPath(`cad-review-${width}.png`) });
      // Use the real store's dirty transition while the read-only preview owns
      // the modal; pointer-edit gestures are covered by the editor journeys.
      await page.evaluate(async () => {
        const path = "/src/features/floor-editor/editor-store.ts";
        const { useFloorEditorStore } = await import(/* @vite-ignore */ path);
        useFloorEditorStore.getState().updateFixture("fixture-1", { name: "저장하지 않은 조명 이름 변경" });
      });
      await expect(apply).toBeDisabled();
      await apply.evaluate(element => (element as HTMLButtonElement).click());
      expect(api.payloads).toEqual([]);
      await page.evaluate(async () => {
        const path = "/src/features/floor-editor/editor-store.ts";
        const { useFloorEditorStore } = await import(/* @vite-ignore */ path);
        useFloorEditorStore.getState().undo();
      });
      await expect(apply).toBeEnabled();
      await apply.click();
      const reset = page.getByRole("dialog", { name: "새 CAD 도면으로 맵을 교체할까요?" });
      await expect(reset).toContainText("조명 2개가 미배치 상태로 변경");
      await expect(reset).toContainText("수동 도형 1개가 삭제");
      await expect(reset).toContainText("기존 CAD 슬롯 1개가 삭제");
      await reset.getByRole("button", { name: "취소", exact: true }).click();
      await expect(apply).toBeFocused();
      expect(api.payloads).toEqual([]);
      await hit(apply);
      await apply.click();
      await reset.getByRole("button", { name: "교체 후 적용" }).click();
      await expect.poll(() => api.payloads.length).toBe(1);
      expect(api.payloads[0]).toEqual({ candidateIds: [], expectedRevision: 1, confirmMapReset: true, leaseToken: "lease-floor-1", leaseFence: 1 });
      await expect(dialog).toBeHidden();
      expect(api.state().floor.mapRevision).toBe(2);
      expect(api.state().objects).toEqual([]);
      expect(api.state().lightSlots).toEqual([]);
      expect(api.state().fixtures.every(fixture => fixture.placementStatus === "unplaced")).toBe(true);
      expect(api.savePayloads()).toEqual([]);
      await page.screenshot({ path: info.outputPath(`cad-applied-${width}.png`) });
    } finally {
      releaseRegions(); releaseTiles();
      await info.attach("cad-api", { body: JSON.stringify({ requests: boundary.requests, unknown: boundary.unknown, unhandled: api.unhandledRequests, applies: api.payloads }), contentType: "application/json" });
      expect(boundary.unknown).toEqual([]); expect(api.unhandledRequests).toEqual([]);
    }
  });
}

for (const width of [320, 1440]) for (const interruption of ["cancel", "scope"] as const) {
  test(`CAD preservation late paint after ${interruption} ${width}`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 900 });
    await installSettingsApiRoutes(page, "admin");
    const api = await installPreparedReview(page);
    const before = structuredClone(api.state());
    let cancelled = 0;
    await page.route(`**/api/floors/floor-1/import-jobs/${cadJobId}/cancel`, route => {
      cancelled++; return route.fulfill({ json: { jobId: cadJobId, status: "cancelled" } });
    });
    await page.route("**/api/floors/floor-2/editor-state", route => route.fulfill({ status: 404, json: { message: "Unavailable fixture floor" } }));
    await page.route("**/api/floors/floor-2/editor-lease", route => route.fulfill({ json: { editable: false } }));
    const boundary = await installCadBoundary(page);
    let releaseTiles!: () => void;
    let heldTileRequests = 0, releasedTileResponses = 0;
    const tiles = new Promise<void>(resolve => { releaseTiles = resolve; });
    await page.route(`**/api/floors/floor-1/import-jobs/${cadJobId}/map-document/tiles/*`, async route => {
      heldTileRequests++;
      await tiles;
      try { await route.fallback(); } finally { releasedTileResponses++; }
    });
    try {
      await page.goto("/settings/floor-plans/floor-1/edit?siteId=site-1");
      const dialog = page.getByRole("dialog", { name: "CAD 가져오기", exact: true });
      const preview = dialog.getByRole("region", { name: "CAD 도면 미리보기" });
      await expect(preview.getByRole("img", { name: "맵 도형" })).toBeVisible();
      await expect(preview).toHaveAttribute("data-preview-ready", "false");
      await expect.poll(() => heldTileRequests).toBeGreaterThan(0);
      const originalDocument = await page.locator("html").elementHandle();
      if (interruption === "cancel") {
        await dialog.getByRole("button", { name: "가져오기 취소", exact: true }).click();
        await expect(preview).toHaveCount(0);
      } else {
        // A real router floor change owns a new editor query. Clearing only
        // the store would legitimately rehydrate the same durable review.
        await page.evaluate(() => {
          window.history.pushState({}, "", "/settings/floor-plans/floor-2/edit?siteId=site-1");
          dispatchEvent(new PopStateEvent("popstate"));
        });
        await expect(page).toHaveURL(/floor-2\/edit/);
        expect(await originalDocument!.evaluate(element => element.isConnected && element === document.documentElement)).toBe(true);
        await expect.poll(() => boundary.requests.includes("GET /api/floors/floor-2/editor-state")).toBe(true);
        await expect(preview).toHaveCount(0);
      }
      releaseTiles();
      await expect.poll(() => releasedTileResponses).toBe(heldTileRequests);
      await expect(preview).toHaveCount(0);
      expect(api.payloads).toEqual([]);
      expect(api.state()).toEqual(before);
      expect(cancelled).toBe(interruption === "cancel" ? 1 : 0);
      await page.screenshot({ path: info.outputPath(`cad-${interruption}-${width}.png`) });
    } finally {
      releaseTiles();
      await info.attach("cad-api", { body: JSON.stringify({ requests: boundary.requests, unknown: boundary.unknown, unhandled: api.unhandledRequests, applies: api.payloads, cancelled, heldTileRequests, releasedTileResponses }), contentType: "application/json" });
      expect(boundary.unknown).toEqual([]); expect(api.unhandledRequests).toEqual([]);
    }
  });
}
