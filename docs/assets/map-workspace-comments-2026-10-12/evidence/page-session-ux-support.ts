// Frozen source bea0dacb + root 정적관문완료 인계 후 독립 QA에서 사용한다.
// 제품·카메라·scroll 값을 주입하지 않고, 실제 UI와 native 입력의 관측값만 수집한다.
import { writeFile } from "node:fs/promises";
import { expect, type BrowserContext, type Locator, type Page, type TestInfo } from "../../../apps/web/node_modules/@playwright/test";
import { installMockApiBoundary } from "../../../apps/web/e2e/support/mock-api-boundary";
import { installSettingsApiRoutes, type SettingsFixture, type SettingsRole } from "../../../apps/web/e2e/support/settings-api";
export { expectNoHorizontalOverflow, expectMinimumTouchTargets } from "../../../apps/web/e2e/support/layout-assertions";

export const reviewCases = [
  { id: 1, viewport: { width: 1194, height: 1227 }, theme: "light", route: "monitoring", purpose: "PC gesture/detail/identity/half-overlay/wheel/focus" },
  { id: 2, viewport: { width: 390, height: 600 }, theme: "dark", route: "monitoring", purpose: "compact toolbar/detail/hit/HH:mm" },
  { id: 3, viewport: { width: 320, height: 600 }, theme: "light", route: "control", purpose: "finite document/two toolbar rows/invalid/More" },
  { id: 4, viewport: { width: 390, height: 600 }, theme: "dark", route: "control", purpose: "native marker-origin swipe/tap/long inline list" },
  { id: 5, viewport: { width: 717, height: 1227 }, resize: { width: 390, height: 844 }, theme: "light", route: "control", purpose: "remaining map/resize/raw draft/identity" },
  { id: 6, viewport: { width: 1194, height: 1227 }, theme: "dark", route: "control", purpose: "empty full-height/long internal list/important collapsed state" }
] as const;

export const ids = {
  siteId: "12121212-1212-4121-8121-121212121212",
  floorId: "23232323-2323-4232-8232-232323232323",
  gatewayId: "34343434-3434-4343-8343-343434343434"
};
const numberedId = (prefix: string, index: number) => `${prefix}-4545-4454-8454-${String(index + 1).padStart(12, "0")}`;

function fixtures(count: 3 | 60, now: string): SettingsFixture[] {
  return Array.from({ length: count }, (_, index) => ({
    id: numberedId("45454545", index),
    name: `UX 조명 ${String(index + 1).padStart(2, "0")}`,
    x: count === 3 ? [450, 720, 450][index] : 80 + index % 10 * 115,
    y: count === 3 ? [300, 300, 530][index] : 100 + Math.floor(index / 10) * 110,
    size: 20, ratedWatt: 40, brightness: 70,
    status: "online", statusReason: "reported",
    health: { faultCodes: [], observedAt: now },
    rssi: -60, hopCount: 2, commandSuccessRate: 0.99, lastSeenAt: now,
    gateway: { id: ids.gatewayId, name: "UX 가상 Gateway", connectionStatus: "online" },
    controllable: true, controlBlockReason: null
  }));
}

/** Typed GET fixtures only. Mutation attempts are recorded and aborted, never fake-completed. */
export async function prepareCustomer(page: Page, context: BrowserContext, baseURL: string, count: 3 | 60, role: SettingsRole = "admin") {
  expect(new URL(baseURL).port).toBe("15188");
  const requests: Array<{ method: string; path: string }> = [];
  page.on("request", request => {
    const url = new URL(request.url());
    if (url.origin === baseURL && url.pathname.startsWith("/api/")) requests.push({ method: request.method(), path: url.pathname });
  });
  await installMockApiBoundary(context, baseURL);
  const now = new Date().toISOString();
  const seed = fixtures(count, now);
  const fixtureState = await installSettingsApiRoutes(page, role, {
    ids, fixtures: seed, readyMapDocument: true,
    mapDimensions: { width: 1200, height: 800 },
    snapshotGeneratedAt: now, gatewayHeartbeatAt: now,
    lightSlots: seed.map((fixture, index) => ({
      id: numberedId("56565656", index), x: fixture.x, y: fixture.y,
      rotation: 0, assignedFixtureId: fixture.id
    }))
  });
  // Later routes take precedence. Do not let the reused settings helper acknowledge a mutation.
  await page.route("**/api/**", route => ["GET", "HEAD"].includes(route.request().method()) ? route.fallback() : route.abort("blockedbyclient"));
  return { requests, fixtureState, seed, assertNoWrites: () => expect(requests.filter(request => !["GET", "HEAD"].includes(request.method))).toEqual([]) };
}

/** Change theme through the actual product control; no storage payload or DOM style injection. */
export async function setReviewTheme(page: Page, theme: "light" | "dark") {
  const root = page.locator("html");
  if (await root.getAttribute("data-customer-theme") !== theme) {
    await page.getByRole("button", { name: theme === "dark" ? "다크 모드로 변경" : "라이트 모드로 변경", exact: true }).click();
  }
  await expect(root).toHaveAttribute("data-customer-theme", theme);
}

export interface GeometryContract {
  map: string;
  regions: Record<string, string>;
  // Only real opaque overlay/nav selectors from the final source belong here.
  occluders: string[];
}

export async function readGeometry(page: Page, contract: GeometryContract) {
  return page.evaluate(({ map: mapSelector, regions, occluders }) => {
    type Box = { x: number; y: number; width: number; height: number; right: number; bottom: number };
    const box = (element: Element): Box => {
      const r = element.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom };
    };
    const fromEdges = (x: number, y: number, right: number, bottom: number): Box => ({ x, y, right, bottom, width: right - x, height: bottom - y });
    const intersect = (a: Box, b: Box) => {
      const result = fromEdges(Math.max(a.x, b.x), Math.max(a.y, b.y), Math.min(a.right, b.right), Math.min(a.bottom, b.bottom));
      return result.width > 0 && result.height > 0 ? result : null;
    };
    const viewport = fromEdges(0, 0, innerWidth, innerHeight);
    const visible = (element: Element) => {
      let result = intersect(box(element), viewport);
      for (let current: Element | null = element; current && result; current = current.parentElement) {
        const style = getComputedStyle(current);
        if (style.display === "none" || style.visibility !== "visible" || Number(style.opacity) === 0 || current.matches("[hidden],.sr-only")) return null;
        // Root scrolling boxes clip to the viewport, not their translated document rect.
        if (current === document.documentElement || current === document.body || current === element) continue;
        const r = box(current);
        const xClip = ["auto", "scroll", "hidden", "clip"].includes(style.overflowX);
        const yClip = ["auto", "scroll", "hidden", "clip"].includes(style.overflowY);
        const clip = fromEdges(
          xClip ? r.x + current.clientLeft : result.x,
          yClip ? r.y + current.clientTop : result.y,
          xClip ? r.x + current.clientLeft + current.clientWidth : result.right,
          yClip ? r.y + current.clientTop + current.clientHeight : result.bottom
        );
        result = intersect(result, clip);
      }
      return result;
    };
    const hit = (element: Element, bounds: Box | null) => bounds ? [0.1, 0.5, 0.9].flatMap(y => [0.1, 0.5, 0.9].map(x => {
      const px = bounds.x + bounds.width * x, py = bounds.y + bounds.height * y;
      const target = document.elementFromPoint(px, py);
      return { x: px, y: py, reachesElement: Boolean(target && element.contains(target)), tag: target?.tagName ?? null, label: target?.closest("[aria-label]")?.getAttribute("aria-label") ?? null };
    })) : [];
    const measure = (element: Element) => {
      const bounds = box(element), usable = visible(element), style = getComputedStyle(element);
      return { bounds, usable, scrollTop: element.scrollTop, scrollLeft: element.scrollLeft, scrollHeight: element.scrollHeight, clientHeight: element.clientHeight, overflowX: style.overflowX, overflowY: style.overflowY, hits: hit(element, usable) };
    };
    const maps = document.querySelectorAll(mapSelector);
    if (maps.length !== 1) throw new Error(`Expected one actual map viewport, found ${maps.length}`);
    const map = maps[0], mapBox = box(map), mapUsable = visible(map);
    const blockers = occluders.flatMap(selector => [...document.querySelectorAll(selector)].map(element => ({ selector, bounds: visible(element) }))).filter(item => item.bounds !== null);
    // Rectangular opaque occlusion estimate. Hit samples remain separate; no 44px PASS is inferred.
    let exposed: Box[] = mapUsable ? [mapUsable] : [];
    for (const blocker of blockers) exposed = exposed.flatMap(part => {
      const cut = intersect(part, blocker.bounds!);
      if (!cut) return [part];
      return [
        fromEdges(part.x, part.y, part.right, cut.y),
        fromEdges(part.x, cut.bottom, part.right, part.bottom),
        fromEdges(part.x, cut.y, cut.x, cut.bottom),
        fromEdges(cut.right, cut.y, part.right, cut.bottom)
      ].filter(piece => piece.width > 0 && piece.height > 0);
    });
    const scrolling = document.scrollingElement;
    return {
      sampledAt: new Date().toISOString(), theme: document.documentElement.getAttribute("data-customer-theme"),
      viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio, visual: visualViewport && { width: visualViewport.width, height: visualViewport.height, offsetTop: visualViewport.offsetTop, offsetLeft: visualViewport.offsetLeft } },
      document: { scrollY, scrollX, scrollHeight: scrolling?.scrollHeight ?? null, clientHeight: scrolling?.clientHeight ?? null, scrollWidth: scrolling?.scrollWidth ?? null, clientWidth: scrolling?.clientWidth ?? null },
      activeElement: { tag: document.activeElement?.tagName ?? null, label: document.activeElement?.getAttribute("aria-label") ?? null },
      map: { ...measure(map), camera: { x: map.scrollLeft, y: map.scrollTop, zoom: map.getAttribute("data-zoom") ?? map.closest("[data-zoom]")?.getAttribute("data-zoom") ?? null }, canvas: [...map.querySelectorAll("canvas")].map(canvas => ({ bounds: box(canvas), bitmapWidth: canvas.width, bitmapHeight: canvas.height })) },
      regions: Object.fromEntries(Object.entries(regions).map(([name, selector]) => [name, [...document.querySelectorAll(selector)].map(measure)])),
      selection: [...map.querySelectorAll("[data-spatial-map-marker]")].map(marker => ({ label: marker.getAttribute("aria-label"), pressed: marker.getAttribute("aria-pressed"), current: marker.getAttribute("aria-current"), dataSelected: marker.getAttribute("data-selected"), ...measure(marker) })),
      exposedMap: { mapBox, mapUsable, blockers, rectangles: exposed, area: exposed.reduce((sum, part) => sum + part.width * part.height, 0), limitation: "Opaque rectangular selectors only; hit samples are not continuous44 proof or OS-keyboard evidence." }
    };
  }, contract);
}

export async function savePhase(page: Page, info: TestInfo, phase: string, contract: GeometryContract, extra: unknown) {
  if (!/^[a-z0-9-]+$/.test(phase)) throw new Error("Evidence phase must be an explicit safe slug");
  const source = process.env.UX_SOURCE_SHA;
  if (!source || !/^[a-f0-9]{40}$/.test(source)) throw new Error("Final full source SHA is required; no historical default");
  const json = info.outputPath(phase + ".json"), png = info.outputPath(phase + ".png");
  // Preserve geometry even if screenshot capture fails, and propagate either failure.
  const metrics = await readGeometry(page, contract);
  await writeFile(json, JSON.stringify({ source, phase, url: page.url(), viewport: page.viewportSize(), metrics, extra }, null, 2));
  await info.attach(phase + "-geometry", { path: json, contentType: "application/json" });
  await page.screenshot({ path: png, fullPage: false });
  await info.attach(phase, { path: png, contentType: "image/png" });
}

export async function rememberMapIdentity(map: Locator) {
  const viewport = await map.elementHandle(), canvas = await map.locator("canvas").first().elementHandle();
  if (!viewport || !canvas) throw new Error("Actual viewport and renderer must be ready before identity capture");
  return {
    assertUnchanged: async () => {
      expect(await viewport.evaluate(element => element.isConnected)).toBe(true);
      expect(await canvas.evaluate(element => element.isConnected)).toBe(true);
      expect(await map.evaluate((element, previous) => element === previous, viewport)).toBe(true);
      expect(await map.locator("canvas").first().evaluate((element, previous) => element === previous, canvas)).toBe(true);
    },
    dispose: async () => { await viewport.dispose(); await canvas.dispose(); }
  };
}

export async function actualCenter(target: Locator) {
  await expect(target).toBeVisible();
  return target.evaluate(element => {
    const r = element.getBoundingClientRect(), x = r.x + r.width / 2, y = r.y + r.height / 2;
    if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight || !element.contains(document.elementFromPoint(x, y))) throw new Error("Native input target is clipped or covered");
    return { x, y };
  });
}

/** Chromium native input, not dispatchEvent/fakePointerEvent; cancel and detach on any failure. */
export async function nativeSwipe(context: BrowserContext, page: Page, target: Locator, delta: { x: number; y: number }) {
  if (Math.hypot(delta.x, delta.y) < 8) throw new Error("Swipe must exceed the actual pan threshold");
  const origin = await actualCenter(target), session = await context.newCDPSession(page);
  const point = (x: number, y: number) => ({ x, y, id: 1, radiusX: 1, radiusY: 1, force: 1 });
  let active = false;
  try {
    await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point(origin.x, origin.y)] }); active = true;
    for (let step = 1; step <= 8; step++) {
      await session.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [point(origin.x + delta.x * step / 8, origin.y + delta.y * step / 8)] });
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    }
    await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] }); active = false;
    return origin;
  } finally {
    try { if (active) await session.send("Input.dispatchTouchEvent", { type: "touchCancel", touchPoints: [] }); }
    finally { await session.detach(); }
  }
}

