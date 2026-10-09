import { installFirstScreenStatisticsFixtures, browserReport } from "./support/first-screen-statistics";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { installSettingsApiRoutes } from "./support/settings-api";
import { expectNoHorizontalOverflow } from "./support/layout-assertions";

for (const width of [320, 390, 430, 1280]) test(`common header and eager account at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: width === 320 ? 568 : width === 390 ? 844 : 932 });
  await installSettingsApiRoutes(page, "viewer", { readyMapDocument: true });
  await page.goto("/settings?siteId=site-1");
  const header = page.locator("[data-shell-topbar]");
  const site = header.locator("[data-shell-context] button");
  const bell = header.getByRole("button", { name: /^알람센터/ });
  await expect(site).toBeVisible(); await expect(bell).toBeVisible();
  if (width < 760) {
    const siteBox = (await site.boundingBox())!; const bellBox = (await bell.boundingBox())!;
    expect(Math.abs(siteBox.y + siteBox.height / 2 - bellBox.y - bellBox.height / 2)).toBeLessThan(3);
    expect(siteBox.height).toBeGreaterThanOrEqual(44); expect(bellBox.height).toBeGreaterThanOrEqual(44);
  }
  await expect(page.getByRole("button", { name: "로그아웃", exact: true })).toBeVisible();
  await bell.click();
  await expect(page.getByRole("dialog", { name: "알람센터" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "최근 알림" })).toBeVisible();
  await page.getByRole("button", { name: "알람센터 닫기", exact: true }).click();
  await expectNoHorizontalOverflow(page);
});

test("monitoring always-visible aggregate and single center during full view", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await installSettingsApiRoutes(page, "admin", { readyMapDocument: true });
  await page.goto("/monitoring?siteId=site-1");
  await expect(page.getByRole("region", { name: "현장 전체", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "현장 전체 보기", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "지도 전체 보기", exact: true }).click();
  await expect(page.locator("[data-shell-topbar]")).toBeHidden();
  await expect(page.getByRole("button", { name: "전체 보기 종료", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "알람센터", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "알람센터" })).toHaveCount(1);
  await page.getByRole("button", { name: "알람센터 닫기", exact: true }).click();
  await page.getByRole("button", { name: "전체 보기 종료", exact: true }).click();
  await expect(page.locator("[data-shell-topbar]")).toBeVisible();
  await expectNoHorizontalOverflow(page);
});

for (const width of [320, 390, 562]) for (const theme of ["light", "dark"]) test(`keeps real header branding and bounded site control in both themes: ${width}/${theme}`, async ({ page }) => {
  await page.setViewportSize({ width, height: 844 });
  await page.addInitScript(value => localStorage.setItem("led-control.customer-theme.v1", value), theme);
  await installSettingsApiRoutes(page, "viewer", { readyMapDocument: true });
  await page.goto("/settings?siteId=site-1");
  const header = page.locator("[data-shell-topbar]");
  const logo = header.getByRole("img", { name: "킨다", exact: true });
  await expect(logo).toBeVisible();
  await expect(logo.locator("img")).toHaveAttribute("src", theme === "dark" ? "/brand/kinda-mark-reversed.svg" : "/brand/kinda-mark.svg");
  const site = header.getByRole("button", { name: /현장 선택/ });
  const bounds = (await site.boundingBox())!;
  expect(bounds.width).toBe(width < 360 ? 128 : 144); expect(bounds.height).toBeGreaterThanOrEqual(44);
  console.log(JSON.stringify({ width, theme, site: bounds }));
  await site.click(); await expect(page.getByRole("option", { name: "고객사 · 고객사 B2 현장", exact: true })).toBeVisible();
  await page.keyboard.press("Escape"); await expect(site).toBeFocused();
  const toggle = header.getByRole("button", { name: theme === "light" ? "다크 모드로 변경" : "라이트 모드로 변경" });
  await toggle.focus(); await page.keyboard.press("Enter");
  await expect(page.locator("html")).toHaveAttribute("data-customer-theme", theme === "light" ? "dark" : "light");
  await page.keyboard.press("Space"); await expect(page.locator("html")).toHaveAttribute("data-customer-theme", theme);
  await expect(header.getByRole("button", { name: /^알람센터/ })).toBeVisible();
  await expectNoHorizontalOverflow(page);
});

test("wide customer rail preserves keyboard labels and actual dark primary foreground", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await installSettingsApiRoutes(page, "admin", { readyMapDocument: true });
  const posts: string[] = [];
  page.on("request", request => { if (request.method() === "POST") posts.push(new URL(request.url()).pathname); });
  await page.goto("/control?siteId=site-1");
  const rail = page.locator('[data-shell-navigation="desktop"]');
  expect((await rail.boundingBox())!.width).toBe(220);
  await page.getByRole("button", { name: "사이드바 접기" }).click();
  expect((await rail.boundingBox())!.width).toBe(80);
  const settings = rail.getByRole("link", { name: "설정", exact: true });
  await settings.focus(); await expect(rail.getByRole("tooltip", { name: "설정", exact: true })).toBeVisible();
  await page.keyboard.press("Escape"); await expect(rail.getByRole("tooltip", { name: "설정", exact: true })).toHaveCount(0);
  await expect(settings).toBeFocused();
  await page.getByRole("button", { name: "다크 모드로 변경" }).click();
  const apply = page.getByRole("button", { name: "밝기 적용", exact: true });
  await expect(apply).toBeVisible(); expect(await apply.evaluate(element => getComputedStyle(element).color)).toBe("rgb(15, 23, 36)");
  await page.setViewportSize({ width: 1023, height: 900 });
  expect((await rail.boundingBox())!.width).toBe(80);
  await expect(page.getByRole("button", { name: "사이드바 펼치기" })).toHaveCount(0);
  expect(posts.filter(path => path.includes("dimming"))).toEqual([]);
  await expectNoHorizontalOverflow(page);
});

for (const [width, compact] of [[759, true], [760, false], [761, false]] as const) test(`customer navigation uses the real integer viewport ${width}`, async ({ page }) => {
  await page.setViewportSize({ width, height: 900 });
  await installSettingsApiRoutes(page, "viewer", { readyMapDocument: true });
  await page.goto("/settings?siteId=site-1");
  console.log(JSON.stringify(await page.evaluate(() => ({ innerWidth, clientWidth: document.documentElement.clientWidth, compact: matchMedia("(width < 760px)").matches }))));
  await expect(page.locator(`[data-shell-navigation="${compact ? "compact" : "desktop"}"]`)).toBeVisible();
  await expect(page.locator(`[data-shell-navigation="${compact ? "desktop" : "compact"}"]`)).toHaveCount(0);
});

for (const width of [760, 760.5]) test(`records Chromium normalized iframe viewport requested ${width}`, async ({ page, baseURL }) => {
  await installSettingsApiRoutes(page, "viewer", { readyMapDocument: true });
  await page.goto("/settings?siteId=site-1");
  // Playwright's layout viewport is integer-normalized. The iframe preserves the
  // requested CSS width for observation, but this test records observed integer
  // behavior and is not evidence of physical fractional viewport support.
  await page.evaluate(({ width, url }) => {
    const frame = document.createElement("iframe"); frame.title = "fractional customer viewport";
    frame.style.width = `${width}px`; frame.style.height = "900px"; frame.style.border = "0"; frame.src = url; document.body.append(frame);
  }, { width, url: `${baseURL}/settings?siteId=site-1` });
  const frame = page.frameLocator('iframe[title="fractional customer viewport"]');
  await expect(frame.getByRole("heading", { name: "설정", level: 2, exact: true })).toBeVisible();
  const actual = await frame.locator("html").evaluate(() => ({ innerWidth, clientWidth: document.documentElement.clientWidth, compact: matchMedia("(width < 760px)").matches }));
  console.log(JSON.stringify({ requested: width, actual }));
  expect(actual.innerWidth).toBeGreaterThanOrEqual(760); expect(actual.compact).toBe(false);
  await expect(frame.locator('[data-shell-navigation="desktop"]')).toBeVisible();
  await expect(frame.locator('[data-shell-navigation="compact"]')).toHaveCount(0);
});

type CompactMapGeometry = {
  documentY: number; mapClientHeight: number; zoom: string | null; viewport: { x: number; y: number; width: number; height: number; top: number; right: number; bottom: number; left: number };
  surface: { x: number; y: number; width: number; height: number; top: number; right: number; bottom: number; left: number };
  mapScroll: { left: number; top: number }; surfaceCamera: { left: number; top: number; width: number; height: number; scaleX: number; scaleY: number };
  header: { x: number; y: number; width: number; height: number; top: number; right: number; bottom: number; left: number } | null;
  nav: { x: number; y: number; width: number; height: number; top: number; right: number; bottom: number; left: number } | null;
  clip: { left: number; top: number; right: number; bottom: number }; visible: number; surfaceVisible: number; viewportHit: boolean;
};

async function compactMapGeometry(map: Locator): Promise<CompactMapGeometry> {
  return map.evaluate(node => {
    const rect = (element: Element) => {
      const box = element.getBoundingClientRect();
      return { x: box.x, y: box.y, width: box.width, height: box.height, top: box.top, right: box.right, bottom: box.bottom, left: box.left };
    };
    const viewport = rect(node), surfaceNode = node.querySelector("[data-floor-map-surface]");
    if (!surfaceNode) throw Error("Missing floor-map surface");
    const surface = rect(surfaceNode), headerNode = document.querySelector("[data-shell-topbar]"), navNode = document.querySelector("[data-shell-navigation=compact]");
    const header = headerNode ? rect(headerNode) : null, nav = navNode ? rect(navNode) : null;
    const clip = { left: 0, top: header?.bottom ?? 0, right: innerWidth, bottom: nav?.top ?? innerHeight };
    for (let parent = node.parentElement; parent; parent = parent.parentElement) {
      const style = getComputedStyle(parent), bounds = rect(parent);
      if (/auto|scroll|hidden|clip/.test(style.overflowY)) { clip.top = Math.max(clip.top, bounds.top); clip.bottom = Math.min(clip.bottom, bounds.bottom); }
      if (/auto|scroll|hidden|clip/.test(style.overflowX)) { clip.left = Math.max(clip.left, bounds.left); clip.right = Math.min(clip.right, bounds.right); }
    }
    const visible = (box: typeof viewport) => Math.max(0, Math.min(box.right, clip.right) - Math.max(box.left, clip.left)) > 0
      ? Math.max(0, Math.min(box.bottom, clip.bottom) - Math.max(box.top, clip.top)) : 0;
    const center = { x: viewport.x + viewport.width / 2, y: viewport.y + viewport.height / 2 }, hit = document.elementFromPoint(center.x, center.y);
    return { documentY: scrollY, mapClientHeight: (node as HTMLElement).clientHeight, zoom: node.getAttribute("data-zoom"), mapScroll: { left: (node as HTMLElement).scrollLeft, top: (node as HTMLElement).scrollTop },
      surfaceCamera: { left: surface.left - viewport.left, top: surface.top - viewport.top, width: surface.width, height: surface.height, scaleX: surface.width / viewport.width, scaleY: surface.height / viewport.height }, viewport, surface, header, nav, clip,
      visible: visible(viewport), surfaceVisible: visible(surface), viewportHit: hit === node || node.contains(hit) };
  });
}

async function nativeDocumentWheel(page: Page, map: Locator, direction: 1 | -1) {
  const before = await compactMapGeometry(map);
  const header = page.locator("[data-shell-topbar]");
  await expect(header).toBeVisible();
  const packet = await header.evaluate(headerNode => {
    const rect = (element: Element) => {
      const box = element.getBoundingClientRect();
      return { x: box.x, y: box.y, width: box.width, height: box.height, top: box.top, right: box.right, bottom: box.bottom, left: box.left };
    };
    const header = rect(headerNode), canvas = rect(document.querySelector("[data-testid=target-selection-map-viewport]")!);
    const point = { x: header.left + 4, y: header.top + 12 }, hit = document.elementFromPoint(point.x, point.y), owner = document.scrollingElement;
    return { point, header, canvas, documentY: scrollY, hitHeader: hit === headerNode || headerNode.contains(hit), outsideCanvas: point.x < canvas.left || point.x > canvas.right || point.y < canvas.top || point.y > canvas.bottom,
      documentOwner: owner === document.documentElement || owner === document.body };
  });
  expect(packet.hitHeader).toBe(true); expect(packet.outsideCanvas).toBe(true); expect(packet.documentOwner).toBe(true);
  const zoom = await map.getAttribute("data-zoom");
  expect(zoom).not.toBeNull();
  await page.evaluate(() => {
    (window as typeof window & { compactManualWheel?: { trusted: boolean }[] }).compactManualWheel = [];
    window.addEventListener("wheel", event => (window as typeof window & { compactManualWheel: { trusted: boolean }[] }).compactManualWheel!.push({ trusted: event.isTrusted }), { once: true, capture: true, passive: true });
  });
  await page.mouse.move(packet.point.x, packet.point.y); await page.mouse.wheel(0, 180 * direction);
  if (direction > 0) await expect.poll(() => page.evaluate(() => scrollY)).toBeGreaterThan(packet.documentY);
  else await expect.poll(() => page.evaluate(() => scrollY)).toBeLessThan(packet.documentY);
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  const wheel = await page.evaluate(() => (window as typeof window & { compactManualWheel: { trusted: boolean }[] }).compactManualWheel);
  expect(wheel.length).toBeGreaterThan(0); expect(wheel.every(event => event.trusted)).toBe(true);
  await expect(map).toHaveAttribute("data-zoom", zoom!);
  const after = await compactMapGeometry(map);
  expect(after.mapScroll).toEqual(before.mapScroll); expect(after.surfaceCamera).toEqual(before.surfaceCamera);
}

async function acquireCompactManualMap(page: Page, map: Locator, minimum: number) {
  for (let attempt = 0; attempt < 12; attempt++) {
    const geometry = await compactMapGeometry(map);
    if (geometry.visible >= minimum && geometry.surfaceVisible > 0 && geometry.viewportHit) return geometry;
    // Compact manual control is document flow: only trusted input on visible
    // non-map header chrome may acquire the below-fold workspace.
    await nativeDocumentWheel(page, map, 1);
  }
  throw Error(`Compact manual map did not reach its ${minimum}px safe intersection`);
}

async function compactNativePoint(page: Page, target: Locator, map: Locator) {
  for (let attempt = 0; attempt < 12; attempt++) {
    const point = await target.evaluate(node => {
      const rect = (element: Element) => {
        const box = element.getBoundingClientRect();
        return { x: box.x, y: box.y, width: box.width, height: box.height, top: box.top, right: box.right, bottom: box.bottom, left: box.left };
      };
      const box = rect(node), header = document.querySelector("[data-shell-topbar]"), nav = document.querySelector("[data-shell-navigation=compact]"), modal = node.closest('[role="dialog"], [aria-modal="true"]');
      const clip = { left: 0, top: modal ? 0 : Math.max(header ? rect(header).bottom : 0, 0), right: innerWidth, bottom: modal ? innerHeight : Math.min(nav ? rect(nav).top : innerHeight, innerHeight) };
      for (let parent = node.parentElement; parent; parent = parent.parentElement) {
        const style = getComputedStyle(parent), bounds = rect(parent);
        if (/auto|scroll|hidden|clip/.test(style.overflowY)) { clip.top = Math.max(clip.top, bounds.top); clip.bottom = Math.min(clip.bottom, bounds.bottom); }
        if (/auto|scroll|hidden|clip/.test(style.overflowX)) { clip.left = Math.max(clip.left, bounds.left); clip.right = Math.min(clip.right, bounds.right); }
      }
      const visible = { left: Math.max(box.left, clip.left), top: Math.max(box.top, clip.top), right: Math.min(box.right, clip.right), bottom: Math.min(box.bottom, clip.bottom) };
      const width = Math.max(0, visible.right - visible.left), height = Math.max(0, visible.bottom - visible.top);
      const hitRegion = width >= 44 && height >= 44 ? { left: visible.left + (width - 44) / 2, top: visible.top + (height - 44) / 2 } : null;
      const points = hitRegion ? [[hitRegion.left + 1, hitRegion.top + 1], [hitRegion.left + 43, hitRegion.top + 1], [hitRegion.left + 1, hitRegion.top + 43], [hitRegion.left + 43, hitRegion.top + 43], [hitRegion.left + 22, hitRegion.top + 22]] : [];
      const hits = points.map(([x, y]) => document.elementFromPoint(x, y)), hitSelf = hits.length === 5 && hits.every(hit => hit === node || node.contains(hit));
      const mapHit = hits.some(hit => Boolean(hit?.closest('[data-testid="target-selection-map-viewport"]'))), modalHit = !modal || hits.every(hit => Boolean(hit && modal.contains(hit)));
      const center = hitRegion ? { x: hitRegion.left + 22, y: hitRegion.top + 22 } : { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      const direction: 1 | -1 = box.top >= clip.bottom ? 1 : box.bottom <= clip.top ? -1 : box.y + box.height / 2 >= (clip.top + clip.bottom) / 2 ? 1 : -1;
      return { center, width, height, hitSelf, mapHit, modal: Boolean(modal), modalHit, direction };
    });
    if (point.width >= 44 && point.height >= 44 && point.hitSelf && point.modalHit && !point.mapHit) return point.center;
    if (point.modal) throw Error("Modal target is not reachable inside its foreground layer");
    await nativeDocumentWheel(page, map, point.direction);
  }
  throw Error("Compact direct control did not reach a safe 44px native target");
}

async function compactNativeClick(page: Page, target: Locator, map: Locator) {
  const point = await compactNativePoint(page, target, map); await page.mouse.click(point.x, point.y);
}

for (const [width, height] of [[320, 568], [390, 844], [430, 932], [1280, 900]]) {
  for (const menu of ["monitoring", "control"]) {
    if (menu === "control" && width < 760) continue;
    test(`${menu} actual map first screen at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await installSettingsApiRoutes(page, "admin", { readyMapDocument: true });
    await page.goto(`/${menu}?siteId=site-1`);
    const map = page.getByTestId(menu === "monitoring" ? "monitoring-map-viewport" : "target-selection-map-viewport");
    await expect(map).toBeVisible();
    const viewport = (await map.boundingBox())!;
    await expect(map.locator("[data-floor-map-surface]")).toBeVisible();
    const bounds = (await map.locator("[data-floor-map-surface]").boundingBox())!;
    const nav = width < 760 ? await page.locator('[data-shell-navigation="compact"]').boundingBox() : null;
    const header = (await page.locator("[data-shell-topbar]").boundingBox())!;
    const visible = Math.max(0, Math.min(viewport.y + viewport.height, nav?.y ?? height) - Math.max(header.y + header.height, viewport.y));
    console.log(JSON.stringify({ menu, width, height, header, viewport, surface: bounds, nav, visible, surfaceVisible: Math.max(0, Math.min(bounds.y + bounds.height, viewport.y + viewport.height, (nav?.y ?? height)) - Math.max(0, bounds.y, viewport.y)) }));
    if (width < 760) {
      expect((await page.getByRole("button", { name: /^알람센터/ }).boundingBox())!.height).toBeGreaterThanOrEqual(52);
      const marker = map.locator("[data-spatial-map-marker]").first();
      expect((await marker.boundingBox())!.height).toBeGreaterThanOrEqual(48);
      if (menu === "control") {
        const tab = page.getByRole("tab", { name: "수동 제어" });
        expect((await tab.boundingBox())!.height).toBeGreaterThanOrEqual(44);
        expect((await tab.boundingBox())!.width).toBeGreaterThanOrEqual(112);
      }
    }
    expect(visible).toBeGreaterThanOrEqual(width === 320 ? 120 : 240);
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
    await expectNoHorizontalOverflow(page);
    await page.screenshot({ path: `../../.superpowers/sdd/2026-10-06-mobile-first-screen/task-2-${menu}-${width}.png` });
    });
  }
}

for (const [width, height] of [[320, 568], [390, 844], [430, 932]]) test(`control compact manual map acquired after trusted document reach at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height });
  await installSettingsApiRoutes(page, "admin", { readyMapDocument: true });
  await page.goto("/control?siteId=site-1");
  const map = page.getByTestId("target-selection-map-viewport");
  await expect(map).toBeVisible(); await expect(map.locator("[data-floor-map-surface]")).toBeVisible();
  expect(await map.count()).toBe(1); expect(await map.locator("[data-floor-map-surface]").count()).toBe(1);
  const originalMap = await map.elementHandle(), originalSurface = await map.locator("[data-floor-map-surface]").elementHandle();
  if (!originalMap || !originalSurface) throw Error("Missing original compact map identity");
  const initial = await compactMapGeometry(map);
  console.log(JSON.stringify({ phase: "initial", menu: "control", width, height, ...initial }));
  expect(initial.documentY).toBe(0);
  expect((await page.getByRole("button", { name: /^알람센터/ }).boundingBox())!.height).toBeGreaterThanOrEqual(52);
  const marker = map.locator("[data-spatial-map-marker]").first();
  expect((await marker.boundingBox())!.height).toBeGreaterThanOrEqual(48);
  const tab = page.getByRole("tab", { name: "수동 제어" });
  expect((await tab.boundingBox())!.height).toBeGreaterThanOrEqual(44); expect((await tab.boundingBox())!.width).toBeGreaterThanOrEqual(112);
  const geometry = await acquireCompactManualMap(page, map, width === 320 ? 120 : 240);
  expect(await map.count()).toBe(1); expect(await map.locator("[data-floor-map-surface]").count()).toBe(1);
  expect(await map.evaluate((node, original) => node === original, originalMap)).toBe(true);
  expect(await map.locator("[data-floor-map-surface]").evaluate((node, original) => node === original, originalSurface)).toBe(true);
  expect(geometry.zoom).toBe(initial.zoom); expect(geometry.mapScroll).toEqual(initial.mapScroll); expect(geometry.surfaceCamera).toEqual(initial.surfaceCamera);
  expect(geometry.mapClientHeight).toBeGreaterThanOrEqual(240); expect(geometry.viewport.height).toBeGreaterThanOrEqual(240);
  expect(geometry.visible).toBeGreaterThanOrEqual(width === 320 ? 120 : 240);
  console.log(JSON.stringify({ phase: "compact-manual-acquired", menu: "control", width, height, ...geometry }));
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: `../../.superpowers/sdd/2026-10-06-mobile-first-screen/task-2-control-${width}.png` });
});


test("compact direct controls and resize preserve pending command UUID without replay", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const posts: string[] = [];
  page.on("request", request => { if (request.method() === "POST") posts.push(new URL(request.url()).pathname); });
  const api = await installSettingsApiRoutes(page, "admin", { readyMapDocument: true,
    ids: { siteId: "99999999-9999-4999-8999-999999999901", floorId: "99999999-9999-4999-8999-999999999902", gatewayId: "99999999-9999-4999-8999-999999999903" },
    fixtures: [{ id: "99999999-9999-4999-8999-999999999904", name: "선택 조명", x: 120, y: 140, ratedWatt: 40, brightness: 70,
      status: "online", statusReason: "reported", health: null, rssi: -60, hopCount: 1, commandSuccessRate: 1,
      lastSeenAt: "2026-10-06T00:00:00.000Z", gateway: { id: "99999999-9999-4999-8999-999999999903", name: "Gateway", connectionStatus: "online" },
      controllable: true, controlBlockReason: null }] });
  await page.goto("/control?siteId=99999999-9999-4999-8999-999999999901");
  const map = page.getByTestId("target-selection-map-viewport");
  const tools = page.getByRole("group", { name: "지도 선택 도구", exact: true }), listOpen = page.getByRole("button", { name: "조명 목록 열기", exact: true });
  await expect(tools).toBeVisible(); await expect(page.getByRole("textbox", { name: "밝기 수치", exact: true })).toBeVisible(); await expect(page.locator("[data-control-submit]")).toBeVisible();
  for (const name of ["선택 도구 열기", "선택 도구 접기", "밝기 실행 설정 열기", "밝기 실행 설정 접기"]) await expect(page.getByRole("button", { name, exact: true })).toHaveCount(0);
  await compactNativeClick(page, listOpen, map);
  const drawer = page.getByRole("dialog", { name: "조명 목록" });
  const choice = drawer.getByRole("checkbox").first();
  const choiceLabel = choice.locator("xpath=ancestor::label[1]");
  await compactNativeClick(page, choiceLabel, map);
  await expect(choice).toBeChecked();
  expect(api.dimmingRequests).toHaveLength(0);
  await compactNativeClick(page, drawer.getByRole("button", { name: "조명 목록 닫기" }), map);
  await expect(listOpen).toBeFocused();
  const brightness = page.getByRole("textbox", { name: "밝기 수치", exact: true });
  await compactNativePoint(page, brightness, map); await brightness.fill("70"); await brightness.press("Enter");
  await expect(brightness).toHaveValue("70");
  expect(api.dimmingRequests).toHaveLength(0);
  const apply = page.locator("[data-control-submit]"); await expect(apply).toBeEnabled(); await compactNativeClick(page, apply, map);
  await expect.poll(() => api.dimmingRequests.length).toBe(1);
  const originalPayload = structuredClone(api.dimmingRequests[0]), uuid = originalPayload.clientRequestId;
  // 단일 조명 선택은 배열 대상이 아닌 기존 fixture/unicast 계약을 사용한다.
  expect(originalPayload).toMatchObject({ siteId: "99999999-9999-4999-8999-999999999901", brightness: 70,
    target: { type: "fixture", fixtureId: "99999999-9999-4999-8999-999999999904" } });
  await expect(page.getByRole("status", { name: "명령 진행 상태" })).toBeVisible();
  await expect(brightness).toBeDisabled(); await expect(apply).toBeDisabled();
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(brightness).toBeVisible(); await expect(brightness).toBeDisabled(); await expect(apply).toBeDisabled();
  expect(api.dimmingRequests[0]).toEqual(originalPayload);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(tools).toBeVisible(); await expect(brightness).toBeVisible(); await expect(brightness).toBeDisabled(); await expect(apply).toBeDisabled();
  for (const name of ["선택 도구 열기", "선택 도구 접기", "밝기 실행 설정 열기", "밝기 실행 설정 접기"]) await expect(page.getByRole("button", { name, exact: true })).toHaveCount(0);
  expect(api.dimmingRequests).toHaveLength(1);
  expect(api.dimmingRequests[0]).toEqual(originalPayload); expect(api.dimmingRequests[0].clientRequestId).toBe(uuid);
  expect(posts).toEqual(["/api/commands/dimming"]);
});

for (const [width, height] of [[320, 568], [390, 844], [430, 932], [1280, 900]]) {
  for (const menu of ["overview", "analysis", "reports"]) test(`statistics ${menu} first screen at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await installSettingsApiRoutes(page, "admin", { ids: { siteId: "30000000-0000-4000-8000-000000000001" } });
    await installFirstScreenStatisticsFixtures(page);
    await page.route("**/energy/sites/*/reports?**", route => route.fulfill({ json: { reports: [browserReport("completed")], nextCursor: null, totalCount: 1 } }));
    await page.goto(`/statistics/${menu}?siteId=30000000-0000-4000-8000-000000000001`);
    const graphic = menu === "overview" ? page.getByRole("img", { name: "기준 대비 에너지 사용량 비교 차트" })
      : menu === "analysis" ? page.getByRole("region", { name: "사용량 순위", exact: true }).locator("ol")
      : page.getByRole("button", { name: /PDF.*다운로드|다운로드/ }).first();
    await expect(graphic).toBeVisible();
    const box = (await graphic.boundingBox())!;
    const nav = width < 760 ? await page.locator('[data-shell-navigation="compact"]').boundingBox() : null;
    const header = (await page.locator("[data-shell-topbar]").boundingBox())!;
    const visible = Math.max(0, Math.min(box.y + box.height, nav?.y ?? height) - Math.max(header.y + header.height, box.y));
    console.log(JSON.stringify({ menu, width, height, box, nav, header, visible }));
    expect(visible).toBeGreaterThanOrEqual(menu === "reports" ? 44 : width === 320 ? 120 : 240);
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
    await expectNoHorizontalOverflow(page);
    if (menu === "analysis" && width < 760) {
      const conditions = page.getByRole("region", { name: "사용량 분석 조건", exact: true });
      const triggerBox = (await conditions.getByRole("button", { name: /상세 필터/ }).boundingBox())!;
      const summaryBox = (await conditions.getByText(/층 · 사용량/).boundingBox())!;
      expect(summaryBox.x).toBeGreaterThanOrEqual(triggerBox.x + triggerBox.width);
    }
    const tab = page.getByRole("navigation", { name: "통계 메뉴" }).getByRole("link").first();
    expect((await tab.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    const typography = await tab.evaluate(element => ({ fontSize: getComputedStyle(element).fontSize, lineHeight: getComputedStyle(element).lineHeight }));
    expect(typography).toEqual({ fontSize: "13px", lineHeight: "20px" });
    console.log(JSON.stringify({ menu, width, typography }));
    // Recharts' existing entry animation lasts 1.5s; preserve the settled original graphic.
    if (menu === "overview") await page.waitForTimeout(1600);
    await page.screenshot({ path: `../../.superpowers/sdd/2026-10-06-mobile-first-screen/task-3-${menu}-${width}.png` });
    if (menu === "analysis") {
      const second = graphic.getByRole("button").nth(1);
      await second.click();
      await expect(second).toHaveAttribute("aria-pressed", "true");
      await expect(page.getByRole("complementary", { name: "B1 주차장 2 상세", exact: true })).toBeVisible();
    }
  });
}
