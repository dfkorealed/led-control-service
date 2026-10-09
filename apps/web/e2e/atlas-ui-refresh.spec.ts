import { expect, test, type Locator, type Page, type Request, type TestInfo } from "@playwright/test";
import { createHash } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { createDimmingCommandSchema, type CreateDimmingCommandInput } from "@led-control/shared";
import { mockDashboard } from "../src/test/fixtures";
import { commandDetailClockFixture, installSettingsApiRoutes, type SettingsFixture } from "./support/settings-api";
import { installMockApiBoundary } from "./support/mock-api-boundary";
import { expectMinimumTouchTargets } from "./support/layout-assertions";
import { installFirstScreenStatisticsFixtures, browserReport } from "./support/first-screen-statistics";

type Theme = "light" | "dark";
const themeKey = "led-control.customer-theme.v1";
const sizes = [
  { width: 320, height: 740 }, { width: 390, height: 844 }, { width: 562, height: 1229 },
  { width: 759, height: 768 }, { width: 760, height: 768 }, { width: 761, height: 768 },
  { width: 1024, height: 600 }, { width: 1024, height: 768 },
  { width: 1304, height: 1229 }, { width: 1440, height: 900 }
] as const;
const themes: Theme[] = ["light", "dark"];
const siteId = mockDashboard.site.id, floorId = mockDashboard.floors[0].id;
const gatewayId = mockDashboard.gateways[0].id;
const commandId = "77777777-7777-4777-8777-777777777777";
const fixtures: SettingsFixture[] = mockDashboard.floors[0].fixtures.map(row => ({ ...row }));
const longSite = "고객사 B2 현장 입구 물류센터 조명 관리 구역".repeat(3);

test.beforeEach(async ({ context, baseURL }) => installMockApiBoundary(context, baseURL));

// Independent, literal palette expectations from the approved specification.
const palette = {
  light: { canvas: "rgb(244, 247, 251)", panel: "rgb(255, 255, 255)", text: "rgb(21, 44, 67)" },
  dark: { canvas: "rgb(15, 23, 36)", panel: "rgb(24, 35, 52)", text: "rgb(234, 241, 250)" }
};

async function initTheme(page: Page, theme: Theme, sampleFirstFrame = false) {
  await page.addInitScript(({ key, theme, sampleFirstFrame }) => {
    localStorage.setItem(key, theme);
    if (!sampleFirstFrame) return;
    const samples: unknown[] = [];
    const state = { samples, stopped: false, frames: 0, cleanup: false };
    Object.assign(window, { __atlasFirstFrame: state });
    function sample(kind: string) {
      const root = document.querySelector<HTMLElement>("[data-app-shell]");
      const header = document.querySelector<HTMLElement>("[data-shell-topbar]");
      if (!root || !header) return;
      const rect = header.getBoundingClientRect();
      let visible = document.visibilityState === "visible" && rect.width > 0 && rect.height > 0
        && rect.bottom > 0 && rect.top < innerHeight && rect.right > 0 && rect.left < innerWidth;
      for (let node: Element | null = header; node; node = node.parentElement) {
        const style = getComputedStyle(node);
        visible &&= style.display !== "none" && style.visibility === "visible" && Number(style.opacity) > 0;
      }
      if (!visible) return;
      const mark = header.querySelector<HTMLImageElement>("[data-kinda-logo-mark]");
      samples.push({ kind, frame: state.frames, time: performance.now(), timeOrigin: performance.timeOrigin,
        theme: document.documentElement.getAttribute("data-customer-theme"), url: location.href,
        rootBackground: getComputedStyle(root).backgroundColor, headerBackground: getComputedStyle(header).backgroundColor,
        headerColor: getComputedStyle(header).color, rect: rect.toJSON(), mark: mark && { src: mark.getAttribute("src"), complete: mark.complete, naturalWidth: mark.naturalWidth } });
    }
    const observer = new MutationObserver(() => sample("mutation-before-paint"));
    observer.observe(document, { childList: true, subtree: true, attributes: true });
    const frame = () => {
      if (state.stopped) { observer.disconnect(); state.cleanup = true; return; }
      state.frames++; sample("visible-raf"); requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }, { key: themeKey, theme, sampleFirstFrame });
}

async function json(info: TestInfo, label: string, value: unknown) {
  const body = JSON.stringify(value, null, 2);
  await writeFile(info.outputPath(`${label}.json`), body);
  await info.attach(label, { body, contentType: "application/json" });
  console.log(`ATLAS_METRIC ${label} ${body}`);
}

async function phase(page: Page, info: TestInfo, label: string, metrics: unknown = {}) {
  const pixels = await page.screenshot({ path: info.outputPath(`${label}.png`) });
  await info.attach(label, { body: pixels, contentType: "image/png" });
  await json(info, `${label}-manifest`, { utc: new Date().toISOString(), url: page.url(),
    actual: await page.evaluate(() => ({ width: innerWidth, height: innerHeight, dpr: devicePixelRatio,
      theme: document.documentElement.getAttribute("data-customer-theme"), scrollX, scrollY })),
    png: { byteLength: pixels.length, sha256: createHash("sha256").update(pixels).digest("hex") }, metrics });
}

async function strictOverflow(page: Page, desktopManual = false) {
  const measured = await page.evaluate(() => ({ x: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth, y: document.scrollingElement!.scrollHeight,
    height: innerHeight, scrollY }));
  expect(measured.x).toBeLessThanOrEqual(measured.client);
  if (desktopManual) { expect(measured.y).toBeLessThanOrEqual(measured.height); expect(measured.scrollY).toBe(0); }
  return measured;
}

// Effective RGBA backgrounds are composited over their real ancestor stack.
// SVG text uses actual fill; chart line/axis probes below use actual stroke.
async function colors(root: Locator, mode: "text" | "border" | "focus" | "stroke" | "value" = "text") {
  return root.evaluate((root, mode) => {
    type RGBA = [number, number, number, number];
    const parse = (value: string): RGBA => {
      const rgb = value.match(/^rgba?\(\s*([\d.]+)[, ]+([\d.]+)[, ]+([\d.]+)(?:\s*[,/]\s*([\d.]+))?\s*\)$/);
      const numeric = "([+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:[eE][+-]?\\d+)?)";
      const lab = rgb ? null : value.match(new RegExp(`^oklab\\(\\s*${numeric}\\s+${numeric}\\s+${numeric}(?:\\s*/\\s*${numeric})?\\s*\\)$`));
      const match = rgb ?? lab;
      if (!match) throw Error(`Unresolved actual color: ${value}`);
      const alpha = match[4] === undefined ? 1 : Number(match[4]);
      let channels = [Number(match[1]), Number(match[2]), Number(match[3])];
      if (![...channels, alpha].every(Number.isFinite) || alpha < 0 || alpha > 1) throw Error(`Invalid actual color: ${value}`);
      if (lab) {
        if (channels[0] < 0 || channels[0] > 1) throw Error(`Out-of-range Oklab lightness: ${value}`);
        // W3C full-precision OKLab_to_XYZ -> XYZ_to_lin_sRGB -> gam_sRGB:
        // https://www.w3.org/TR/css-color-4/#color-conversion-code
        // Keep alpha/double channels exact; never quantize through 8-bit Canvas.
        const multiply = (matrix: number[][], vector: number[]) => matrix.map(row => row.reduce((sum, entry, index) => sum + entry * vector[index], 0));
        const lms = multiply([[1, .3963377773761749, .2158037573099136], [1, -.1055613458156586, -.0638541728258133], [1, -.0894841775298119, -1.2914855480194092]], channels).map(value => value ** 3);
        const xyz = multiply([[1.2268798758459243, -.5578149944602171, .2813910456659647], [-.0405757452148008, 1.112286803280317, -.0717110580655164], [-.0763729366746601, -.4214933324022432, 1.5869240198367816]], lms);
        const linear = multiply([[12831 / 3959, -329 / 214, -1974 / 3959], [-851781 / 878810, 1648619 / 878810, 36519 / 878810], [705 / 12673, -2585 / 12673, 705 / 667]], xyz);
        if (linear.some(value => !Number.isFinite(value) || value < 0 || value > 1)) throw Error(`Unsupported out-of-gamut actual color: ${value}`);
        channels = linear.map(value => 255 * (value <= .0031308 ? value * 12.92 : 1.055 * value ** (1 / 2.4) - .055));
      }
      if (channels.some(value => !Number.isFinite(value) || value < 0 || value > 255)) throw Error(`Invalid actual RGB channels: ${value}`);
      return [...channels, alpha] as RGBA;
    };
    const shadowColors = (value: string) => {
      const tokens = value.match(/[a-z][a-z0-9-]*\([^()]*\)/gi) ?? [];
      if (/[()]/.test(value.replace(/[a-z][a-z0-9-]*\([^()]*\)/gi, ""))) throw Error(`Unsupported nested actual focus color: ${value}`);
      return tokens;
    };
    const rejected = (label: string, action: () => unknown, checks: unknown[]) => {
      let error: string | undefined;
      try { action(); } catch (caught) { error = String(caught); }
      checks.push({ label, rejected: error });
      if (!error) throw Error(`Decoder accepted unsupported input: ${label}`);
    };
    const over = (front: RGBA, back: RGBA): RGBA => {
      const a = front[3] + back[3] * (1 - front[3]);
      return [0, 1, 2].map(index => (front[index] * front[3] + back[index] * back[3] * (1 - front[3])) / a).concat(a) as RGBA;
    };
    const background = (node: Element | null): RGBA => {
      const stack: RGBA[] = [];
      for (; node; node = node.parentElement) {
        const style = getComputedStyle(node);
        if (style.backgroundImage !== "none") throw Error(`Background image requires a separate pixel assessment: ${style.backgroundImage}`);
        stack.push(parse(style.backgroundColor));
      }
      // Browser's default document canvas is white only after the complete
      // DOM ancestor stack has been applied; no transparent RGB shortcut.
      return stack.reverse().reduce((back, front) => over(front, back), [255, 255, 255, 1] as RGBA);
    };
    const luminance = (color: RGBA) => color.slice(0, 3).map(value => {
      const channel = value / 255; return channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4;
    }).reduce((total, value, index) => total + value * [.2126, .7152, .0722][index], 0);
    const ratio = (front: RGBA, back: RGBA) => {
      const values = [luminance(over(front, back)), luminance(back)].sort((a, b) => b - a);
      return (values[0] + .05) / (values[1] + .05);
    };
    // Independent inputs catch a decoder that drops alpha, swaps channels,
    // rounds the composite, or silently skips a non-RGB focus slot. The real
    // round3 Oklab exception is the immutable RED; no extra browser is needed.
    const decoderChecks: unknown[] = [];
    const exact = (label: string, actual: number[], expected: number[]) => {
      decoderChecks.push({ label, actual, expected, source: "hand-derived channels/alpha compositing" });
      if (actual.length !== expected.length || actual.some((value, index) => value !== expected[index]))
        throw Error(`Decoder independent exact check: ${label}`);
    };
    const dark: RGBA = [24, 35, 52, 1], light: RGBA = [244, 247, 251, 1];
    exact("opaque RGB", parse("rgb(24, 35, 52)"), dark);
    exact("opaque space RGB", parse("rgb(148 185 255)"), [148, 185, 255, 1]);
    exact("RGB alpha0", over(parse("rgba(200, 100, 50, 0)"), dark), dark);
    exact("Oklab alpha0", over(parse("oklab(.5 0 0 / 0)"), dark), dark);
    const half = parse("oklab(0 0 0 / 0.5)");
    exact("exact half alpha", half, [0, 0, 0, .5]);
    exact("foreground over dark", over(half, dark), [12, 17.5, 26, 1]);
    exact("ancestor over light", over(half, light), [122, 123.5, 125.5, 1]);
    exact("two translucent ancestors", over(half, over(half, dark)), [6, 8.75, 13, 1]);
    exact("opaque inner masks outer", over(light, over(half, dark)), light);
    for (const value of ["oklab(0 0)", "oklab(0 0 0 / 2)", "oklab(NaN 0 0)", "oklab(1e999 0 0)",
      "oklab(none 0 0)", "oklab(0 0 0) tail", "color(srgb 0 0 0)", "unknown(0 0 0)", "oklab(.5 2 2)"])
      rejected(value, () => parse(value), decoderChecks);
    const neutral = parse("oklab(.5 0 0)");
    const neutralExpected = 255 * (1.055 * (.125 ** (1 / 2.4)) - .055);
    decoderChecks.push({ label: "neutral L=.5", actual: neutral, expected: [neutralExpected, neutralExpected, neutralExpected, 1], source: "independent neutral Y=L^3" });
    // Independent direct inverse from the original author, not the decoder's
    // XYZ pipeline: https://bottosson.github.io/posts/oklab/#converting-from-linear-srgb-to-oklab
    const chromatic = parse("oklab(.5 .05 -.05 / .5)");
    const reference = [114.53602405583797, 86.81255331095788, 127.11879427036789, .5];
    // For this bounded input only, |LMS|<.6. Published direct vs W3C composed
    // row coefficient delta <1.041e-7, LMS delta <4e-12; cube derivative <1.08,
    // inverse row sum <7.62 and gamma slope <=12.92. No contrast tolerance.
    const referenceBound = 255 * 12.92 * (.6 ** 3 * 1.041e-7 + 3 * .6 ** 2 * 4e-12 * 7.62 + 128 * Number.EPSILON);
    if (neutral[3] !== 1 || neutral.slice(0, 3).some(value => Math.abs(value - neutralExpected) > referenceBound)) throw Error("Independent neutral reference bound");
    const chromaticErrors = chromatic.slice(0, 3).map((value, index) => value - reference[index]);
    decoderChecks.push({ label: "independent chromatic direct inverse", input: ".5 .05 -.05 / .5", actual: chromatic, reference, errors: chromaticErrors, referenceBound,
      source: "original-author direct polynomial evaluated independently in double; bounded coefficient difference, not float32/Canvas oracle" });
    if (chromatic[3] !== .5 || chromaticErrors.some(value => Math.abs(value) > referenceBound)) throw Error("Independent chromatic reference bound");
    let boundaryError = 0;
    for (const threshold of [3, 4.5]) for (const direction of [-1, 1]) {
      const expected = threshold + direction * .0001, y = .05 * (expected - 1), L = Math.cbrt(y);
      const actual = ratio(parse(`oklab(${L} 0 0)`), [0, 0, 0, 1]);
      const error = actual - expected; boundaryError = Math.max(boundaryError, Math.abs(error));
      decoderChecks.push({ label: "independent analytical threshold side", input: { L, y }, threshold, expected, actual, error, direction,
        source: "black background ratio=(Y+.05)/.05, neutral Y=L^3; .0001 is input separation" });
      if ((actual >= threshold) !== (direction > 0) || Math.abs(error) >= Math.abs(expected - threshold)) throw Error("Numerically uncertain contrast boundary");
    }
    exact("complete shadow tokens", [shadowColors("rgb(1, 2, 3) 0px 0px, oklab(0 0 0 / .5) 0px 0px").length], [2]);
    rejected("unknown focus slot", () => shadowColors("unknown(1 2 3) 0px 0px").forEach(parse), decoderChecks);
    rejected("nested focus slot", () => shadowColors("color-mix(in oklab, rgb(1,2,3), transparent) 0px 0px"), decoderChecks);
    const visible = (node: Element) => {
      const box = node.getBoundingClientRect();
      if (!box.width || !box.height || box.bottom <= 0 || box.top >= innerHeight) return false;
      for (let current: Element | null = node; current; current = current.parentElement) {
        const style = getComputedStyle(current);
        if (current.matches("[hidden],[aria-hidden=true],.sr-only") || style.display === "none" || style.visibility !== "visible" || Number(style.opacity) === 0) return false;
      }
      return true;
    };
    // Native values have no text child; assess their actual paint, not a ghost edge.
    if (mode === "value" && (!(root instanceof HTMLInputElement) || !visible(root)
      || root.closest(":disabled,[aria-disabled=true]") || !root.value.trim())) throw Error("Value contrast requires a visible enabled nonempty native input");
    const nodes = mode === "text" ? [root, ...root.querySelectorAll("*")].filter(node => visible(node)
      && [...node.childNodes].some(child => child.nodeType === Node.TEXT_NODE && child.textContent?.trim())) : [root];
    return nodes.filter(node => !node.closest(":disabled,[aria-disabled=true]")).map((node, index) => {
      const style = getComputedStyle(node), bg = background(mode === "text" || mode === "value" ? node : node.parentElement);
      const svgText = node instanceof SVGElement && ["text", "tspan"].includes(node.tagName.toLowerCase());
      const foreground = mode === "stroke" ? style.stroke : mode === "border" ? style.borderTopColor
        : mode === "focus" ? style.borderTopColor : svgText ? style.fill : style.color;
      const fontSize = parseFloat(style.fontSize), weight = Number(style.fontWeight);
      const large = fontSize >= 24 || (fontSize >= 18.6666666667 && weight >= 700);
      let focusColors: string[] = [];
      if (mode === "focus") {
        if (parseFloat(style.outlineWidth) > 0 && style.outlineStyle !== "none") focusColors.push(style.outlineColor);
        focusColors.push(...shadowColors(style.boxShadow));
        // An unchanged input border is not a focus indicator. Only the actual
        // visible outline/shadow is assessed here, separately from UI borders.
      }
      const actualRatio = mode === "focus" ? Math.max(0, ...focusColors.map(color => ratio(parse(color), bg))) : ratio(parse(foreground), bg);
      const threshold = mode === "text" || mode === "value" ? large ? 3 : 4.5 : 3;
      if (Math.abs(actualRatio - threshold) <= boundaryError) throw Error(`Numerically uncertain actual contrast: ${actualRatio} / ${threshold}`);
      return { text: mode === "value" ? (node as HTMLInputElement).value : node.textContent?.trim(),
        ...(mode === "value" ? { value: (node as HTMLInputElement).value } : {}), tag: node.tagName, fontSize, weight, large, foreground, effectiveBackground: bg,
        focusColors, ratio: actualRatio, threshold, ...(index === 0 ? { decoderChecks, boundaryError } : {}),
        rect: node.getBoundingClientRect().toJSON(), focused: node === document.activeElement,
        focusVisible: node.matches(":focus-visible,[data-focus-visible=true]"), boxShadow: style.boxShadow };
    });
  }, mode);
}

async function assertColors(root: Locator, info: TestInfo, label: string, mode: "text" | "border" | "focus" | "stroke" | "value" = "text") {
  const measured = await colors(root, mode); await json(info, label, measured);
  expect(measured.length, `${label}: real visible applicable targets`).toBeGreaterThan(0);
  for (const sample of measured) {
    expect(sample.ratio, `${label}: ${sample.tag} ${sample.text}`).toBeGreaterThanOrEqual(sample.threshold);
    if (mode === "focus") { expect(sample.focused).toBe(true); expect(sample.focusVisible).toBe(true); }
  }
  return measured;
}

async function hit44(page: Page, selector: string, info: TestInfo, label: string) {
  await expectMinimumTouchTargets(page, selector);
  const hits = await page.locator(selector).evaluateAll(roots => roots.flatMap(root => [root, ...root.querySelectorAll("button,a[href],[role=option],[role=tab],input")]).filter(node => {
    const rect = node.getBoundingClientRect(); return rect.width > 0 && rect.height > 0 && rect.top >= 0 && rect.bottom <= innerHeight && !node.matches(":disabled,[aria-disabled=true]");
  }).map(node => {
    const rect = node.getBoundingClientRect(), clip = { left: 0, top: 0, right: innerWidth, bottom: innerHeight };
    const ancestors = [];
    for (let parent = node.parentElement; parent; parent = parent.parentElement) {
      const style = getComputedStyle(parent), bounds = parent.getBoundingClientRect();
      if (/auto|scroll|hidden|clip/.test(style.overflowX)) { clip.left = Math.max(clip.left, bounds.left); clip.right = Math.min(clip.right, bounds.right); }
      if (/auto|scroll|hidden|clip/.test(style.overflowY)) { clip.top = Math.max(clip.top, bounds.top); clip.bottom = Math.min(clip.bottom, bounds.bottom); }
      ancestors.push({ tag: parent.tagName, overflowX: style.overflowX, overflowY: style.overflowY, rect: bounds.toJSON() });
    }
    const point = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }, hit = document.elementFromPoint(point.x, point.y);
    return { name: node.getAttribute("aria-label") ?? node.textContent, rect: rect.toJSON(), clip, ancestors,
      point, hitsSelf: node === hit || node.contains(hit), continuous44: "passed unchanged layout-assertions helper" };
  }));
  await json(info, label, hits); return hits;
}

async function installCustomer(page: Page, controlOnly = false) {
  const api = await installSettingsApiRoutes(page, controlOnly ? "viewer" : "admin", {
    ids: { siteId, floorId, gatewayId }, fixtures, readyMapDocument: true, commandId
  });
  const dashboard = structuredClone(mockDashboard);
  dashboard.capabilities = { read: true, control: true, manage: !controlOnly, commission: !controlOnly };
  dashboard.floors = [{ ...dashboard.floors[0], mapRevision: 7, mapConfigured: true }];
  dashboard.groups = [];
  await page.route(`**/api/sites/${siteId}/dashboard*`, route => {
    if (route.request().method() !== "GET") return route.fallback();
    api.requests.push(`GET /sites/${siteId}/dashboard`); return route.fulfill({ json: dashboard });
  });
  await page.route("**/api/sites", route => route.request().method() === "GET"
    ? route.fulfill({ json: [{ id: siteId, name: longSite, customerName: "고객사" }] }) : route.fallback());
  await page.route("**/api/commands?**", route => route.request().method() === "GET" ? route.fulfill({ json: {
    items: [], nextCursor: null, generatedAt: commandDetailClockFixture.generatedAt, retainedFrom: commandDetailClockFixture.retainedFrom, retentionEnabled: false
  } }) : route.fallback());
  return { api, dashboard };
}

async function header(page: Page, theme: Theme, info: TestInfo, width: number, portals = true) {
  const root = page.locator("[data-shell-topbar]"); await expect(root).toBeVisible();
  // Mobile branding is in the topbar; desktop keeps its existing sidebar mark.
  // Do not require a duplicate desktop header logo or fall back outside its owner.
  const logoOwner = width < 760 ? root : page.locator("[data-shell-navigation=desktop]");
  const logo = logoOwner.locator("[data-kinda-logo-mark]"); await expect(logo).toBeVisible();
  await expect(logo).toHaveAttribute("src", theme === "dark" ? "/brand/kinda-mark-reversed.svg" : "/brand/kinda-mark.svg");
  const logoBox = (await logo.boundingBox())!; expect(logoBox.width).toBe(32); expect(logoBox.height).toBe(32);
  const site = root.getByRole("button", { name: /현장 선택/ }); const box = (await site.boundingBox())!;
  expect(box.width).toBe(width < 760 ? width < 360 ? 128 : 144 : 256); expect(box.height).toBeGreaterThanOrEqual(44);
  await json(info, "header-geometry", { logoBox, logo: { owner: width < 760 ? "topbar" : "desktop-navigation",
    ownerBox: await logoOwner.boundingBox(), src: await logo.getAttribute("src"), visible: await logo.isVisible() }, site: box, width, theme });
  await hit44(page, "[data-shell-topbar] button", info, "header-continuous44");
  for (const [index, icon] of (await root.locator("[data-shell-actions] button svg").all()).entries())
    await assertColors(icon, info, `header-essential-svg-stroke3-${index}`, "stroke");
  if (!portals) return;
  await site.focus(); await page.keyboard.press("Enter");
  const option = page.getByRole("option", { name: `고객사 · ${longSite}`, exact: true }); await expect(option).toBeVisible();
  await assertColors(option, info, "actual-option-body45");
  await hit44(page, "[role=listbox]", info, "option-continuous44");
  await phase(page, info, "normal-open-options");
  await page.keyboard.press("Escape"); await expect(site).toBeFocused();
  await assertColors(site, info, "actual-site-essential-border3", "border");
  await assertColors(site, info, "actual-keyboard-site-focus3", "focus");
  await root.getByRole("button", { name: /^알람센터/ }).click();
  const alarm = page.getByRole("dialog", { name: "알람센터", exact: true }); await expect(alarm).toBeVisible();
  await assertColors(alarm, info, "actual-alarm-body45");
  await hit44(page, "[role=dialog]", info, "alarm-continuous44");
  await phase(page, info, "normal-open-alarm");
  await alarm.getByRole("button", { name: "알람센터 닫기", exact: true }).click();
}

async function firstFrame(page: Page, theme: Theme, info: TestInfo) {
  await expect.poll(() => page.evaluate(() => (window as unknown as { __atlasFirstFrame: { samples: { kind: string }[] } }).__atlasFirstFrame.samples.some(row => row.kind === "visible-raf"))).toBe(true);
  const samples = await page.evaluate(() => {
    const state = (window as unknown as { __atlasFirstFrame: { samples: Array<{ kind: string; theme: string; rootBackground: string; headerBackground: string; headerColor: string }>; stopped: boolean } }).__atlasFirstFrame;
    state.stopped = true; return state.samples;
  });
  await json(info, "first-visible-customer-samples", samples);
  const first = samples.find(row => row.kind === "visible-raf")!;
  expect(first.theme).toBe(theme); expect(first.rootBackground).toBe(palette[theme].canvas);
  expect(first.headerBackground).toBe(palette[theme].panel);
  for (const sample of samples) { expect(sample.theme).toBe(theme); expect(sample.rootBackground).toBe(palette[theme].canvas); }
}

for (const theme of themes) test(`ATLAS acceptance first visible ${theme} 390x844`, async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 844 }); await initTheme(page, theme, true);
  const { api } = await installCustomer(page); await page.goto(`/settings?siteId=${siteId}`);
  await firstFrame(page, theme, info); await phase(page, info, "normal-first-visible-customer");
  await header(page, theme, info, 390);
  await assertColors(page.locator("[data-shell-content]"), info, "settings-visible-body45");
  await phase(page, info, "normal-first-customer", await strictOverflow(page));
  expect(api.dimmingRequests).toEqual([]); expect(api.atomicSavePayloads).toEqual([]);
});

for (const size of sizes) for (const theme of themes) for (const menu of ["settings", "monitoring", "statistics"] as const) {
  test(`ATLAS acceptance ${menu} ${theme} ${size.width}x${size.height}`, async ({ page }, info) => {
    await page.setViewportSize(size); await initTheme(page, theme);
    const { api } = await installCustomer(page);
    if (menu === "statistics") await installFirstScreenStatisticsFixtures(page);
    await page.goto(`/${menu}?siteId=${siteId}&keep=value#atlas`);
    await expect(page.locator("html")).toHaveAttribute("data-customer-theme", theme);
    if (menu !== "statistics") await header(page, theme, info, size.width, size.width === 320 || size.width === 1440);
    const compact = size.width < 760;
    await expect(page.locator(`[data-shell-navigation=${compact ? "compact" : "desktop"}]`)).toBeVisible();
    await expect(page.locator(`[data-shell-navigation=${compact ? "desktop" : "compact"}]`)).toHaveCount(0);
    if (!compact) expect((await page.locator("[data-shell-navigation=desktop]").boundingBox())!.width).toBe(size.width < 1024 ? 80 : 220);
    if (menu === "monitoring") {
      const viewport = page.getByTestId("monitoring-map-viewport"), canvas = viewport.locator("canvas");
      await expect(canvas.first()).toBeVisible(); const handles = await canvas.elementHandles(), count = await canvas.count();
      await page.getByRole("button", { name: "지도 확대", exact: true }).click();
      await expect(viewport).toHaveAttribute("data-zoom", "1.1");
      await page.getByRole("button", { name: theme === "dark" ? "라이트 모드로 변경" : "다크 모드로 변경", exact: true }).click();
      expect(await canvas.count()).toBe(count);
      for (const [index, handle] of handles.entries()) expect(await canvas.nth(index).evaluate((node, original) => node === original, handle)).toBe(true);
      await expect(viewport).toHaveAttribute("data-zoom", "1.1");
      await page.getByRole("button", { name: theme === "dark" ? "다크 모드로 변경" : "라이트 모드로 변경", exact: true }).click();
      await page.getByRole("button", { name: "지도 전체 보기", exact: true }).click();
      await expect(page.locator("[data-shell-topbar]")).toBeHidden();
      await phase(page, info, "normal-monitoring-full-view");
      await page.getByRole("button", { name: "전체 보기 종료", exact: true }).click();
      expect(await canvas.count()).toBe(count);
      for (const [index, handle] of handles.entries()) expect(await canvas.nth(index).evaluate((node, original) => node === original, handle)).toBe(true);
      await expect(viewport).toHaveAttribute("data-zoom", "1.1");
    }
    await assertColors(page.locator("[data-shell-content]"), info, `${menu}-visible-body45`);
    if (menu === "statistics") {
      const svgText = page.locator("[data-shell-content] svg text");
      await expect(svgText.first()).toBeVisible();
      await assertColors(page.locator("[data-shell-content]"), info, "chart-actual-svg-text-fill45");
      for (const [index, line] of (await page.locator(".recharts-line-curve").all()).entries())
        await assertColors(line, info, `chart-actual-line-stroke3-${index}`, "stroke");
    }
    await phase(page, info, `normal-${menu}`, await strictOverflow(page)); expect(api.dimmingRequests).toEqual([]);
  });
}

async function canvases(page: Page) {
  const map = page.getByTestId("target-selection-map-viewport"); await expect(map).toBeVisible();
  const nodes = map.locator("canvas"); await expect(nodes.first()).toBeVisible();
  return { map, nodes, handles: await nodes.elementHandles(), count: await nodes.count(), zoom: await map.getAttribute("data-zoom") };
}

async function operationalMapGeometry(before: Awaited<ReturnType<typeof canvases>>, info: TestInfo, label: string, desktop: boolean) {
  const geometry = await before.nodes.evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().toJSON()));
  const viewport = await before.map.evaluate(node => {
    const style = getComputedStyle(node);
    return { rect: node.getBoundingClientRect().toJSON(), clientHeight: node.clientHeight, clientWidth: node.clientWidth,
      overflowX: style.overflowX, overflowY: style.overflowY, minHeight: style.minHeight,
      testId: node.getAttribute("data-testid"), tag: node.tagName };
  });
  await json(info, label, { viewport, drawnCanvas: geometry,
    publicSelector: '[data-testid="target-selection-map-viewport"]', childSelector: "canvas", canvasCount: before.count, zoom: before.zoom });
  await expect(before.map).toBeVisible();
  // Task7's 240px contract targets the interaction viewport, not aspect-fitted CAD pixels.
  if (desktop) { expect(viewport.rect.height).toBeGreaterThanOrEqual(240); expect(viewport.clientHeight).toBeGreaterThanOrEqual(240); }
  for (const [index, rect] of geometry.entries()) {
    expect(rect.width).toBeGreaterThan(0); expect(rect.height).toBeGreaterThan(0);
    await expect(before.nodes.nth(index)).toBeVisible();
  }
  return { geometry, viewport };
}

async function preserveCanvases(page: Page, before: Awaited<ReturnType<typeof canvases>>) {
  expect(await before.nodes.count()).toBe(before.count);
  for (const [index, handle] of before.handles.entries()) expect(await before.nodes.nth(index).evaluate((node, original) => node === original, handle)).toBe(true);
  await expect(before.map).toHaveAttribute("data-zoom", before.zoom!);
}

async function pcOwnerWheel(page: Page, target: Locator, info: TestInfo, label: string, attempt: number, measured: { box: { bottom: number }; clip: { bottom: number } }) {
  const delta = measured.box.bottom > measured.clip.bottom ? 180 : -180;
  const selected = await target.evaluateHandle((node, direction) => {
    const describe = (element: Element) => ({ tag: element.tagName, id: element.id,
      attributes: Object.fromEntries([...element.attributes].filter(attribute => /^(data-|aria-)|^role$/.test(attribute.name)).map(attribute => [attribute.name, attribute.value])) });
    const metrics = (element: Element) => { const style = getComputedStyle(element); return { ...describe(element),
      rect: element.getBoundingClientRect().toJSON(), clientHeight: element.clientHeight, clientWidth: element.clientWidth,
      scrollHeight: element.scrollHeight, scrollWidth: element.scrollWidth, scrollTop: element.scrollTop,
      range: element.scrollHeight - element.clientHeight,
      overflowY: style.overflowY, overflowX: style.overflowX, overscrollY: style.overscrollBehaviorY }; };
    const delivery = (hit: Element | null, owner: HTMLElement) => {
      const nodes: Element[] = []; for (let element = hit; element; element = element.parentElement) { nodes.push(element); if (element === owner) break; }
      const pathMetrics = nodes.map(metrics);
      // Hidden is a scroll container; clip is not. Containment may block a
      // descendant even with zero range, so do not infer delivery from ancestry.
      const blocked = nodes.filter(element => element !== owner).some(element => {
        const style = getComputedStyle(element), range = element.scrollHeight - element.clientHeight;
        return (/auto|scroll|hidden/.test(style.overflowY) && /contain|none/.test(style.overscrollBehaviorY))
          || (/auto|scroll/.test(style.overflowY) && range > 0);
      });
      return { directOwner: hit === owner, ownerConnected: owner.isConnected, ownerInPath: nodes.includes(owner),
        canvasInPath: nodes.some(element => element.tagName === "CANVAS"), blocked, pathMetrics };
    };
    const canvas = document.querySelector('[data-testid="target-selection-map-viewport"]')!.getBoundingClientRect();
    const header = document.querySelector("[data-shell-topbar]")?.getBoundingClientRect();
    const ancestors: HTMLElement[] = []; for (let parent = node.parentElement; parent; parent = parent.parentElement) ancestors.push(parent);
    const diagnosis = ancestors.map(metrics);
    for (const [index, owner] of ancestors.entries()) {
      const before = metrics(owner), range = owner.scrollHeight - owner.clientHeight;
      if (!/auto|scroll/.test(before.overflowY) || range <= 0 || (direction > 0 ? owner.scrollTop >= range : owner.scrollTop <= 0)) continue;
      const rect = owner.getBoundingClientRect();
      const clip = { left: Math.max(0, rect.left + owner.clientLeft), right: Math.min(innerWidth, rect.left + owner.clientLeft + owner.clientWidth),
        top: Math.max(header?.bottom ?? 0, rect.top + owner.clientTop), bottom: Math.min(innerHeight, rect.top + owner.clientTop + owner.clientHeight) };
      for (const ancestor of ancestors.slice(index + 1)) {
        const bounds = ancestor.getBoundingClientRect(), style = getComputedStyle(ancestor);
        if (/auto|scroll|hidden|clip/.test(style.overflowY)) { clip.top = Math.max(clip.top, bounds.top + ancestor.clientTop); clip.bottom = Math.min(clip.bottom, bounds.top + ancestor.clientTop + ancestor.clientHeight); }
        if (/auto|scroll|hidden|clip/.test(style.overflowX)) { clip.left = Math.max(clip.left, bounds.left + ancestor.clientLeft); clip.right = Math.min(clip.right, bounds.left + ancestor.clientLeft + ancestor.clientWidth); }
      }
      const hits: unknown[] = [];
      if (owner.clientWidth < 44 || owner.clientHeight < 44 || clip.right - clip.left < 44 || clip.bottom - clip.top < 44) {
        Object.assign(diagnosis[index], { effectiveClip: clip, rejected: "owner visible viewport/client below44" }); continue;
      }
      // Native wheel may target an unblocked descendant of the scroll owner.
      // This is one input POINT; actionable target full44/grid/click stays in trustedReach.
      for (let y = clip.top + 2; y < clip.bottom; y += 4) for (let x = clip.left + 2; x < clip.right; x += 4) {
        if (!(x < canvas.left || x >= canvas.right)) continue;
        const hit = document.elementFromPoint(x, y);
        const chain = delivery(hit, owner), candidate = { point: { x, y }, hit: hit ? describe(hit) : null, ...chain };
        hits.push(candidate);
        if (hit && chain.ownerConnected && chain.ownerInPath && !chain.blocked && !chain.canvasInPath) return { owner, node, index, receipt: { before, range, clip, point: { x, y },
          pointSource: "finite4px effective-clip unblocked owner delivery", candidates: hits,
          hit: describe(hit), canvas: canvas.toJSON(), outsideCanvas: true, hitsSelf: true, delivery: chain, documentY: scrollY, diagnosis }, metrics, delivery, stopWheel: null as (() => void) | null };
      }
      Object.assign(diagnosis[index], { effectiveClip: clip, rejectedPoints: hits });
    }
    return { owner: null, node, index: -1, receipt: { diagnosis, canvas: canvas.toJSON(), documentY: scrollY }, metrics, delivery, stopWheel: null as (() => void) | null };
  }, delta);
  try {
    const packet = await selected.evaluate(state => state.receipt);
    await json(info, `${label}-wheel-packet-${attempt}`, { compact: false, packet, target: measured });
    expect("point" in packet).toBe(true);
    if (!("point" in packet)) throw Error(`No actual PC unblocked-owner noncanvas wheel point for ${label}`);
    expect(packet.documentY).toBe(0); expect(packet.hitsSelf).toBe(true); expect(packet.outsideCanvas).toBe(true);
    expect(packet.before.clientWidth).toBeGreaterThanOrEqual(44); expect(packet.before.clientHeight).toBeGreaterThanOrEqual(44);
    expect(packet.clip.right - packet.clip.left).toBeGreaterThanOrEqual(44); expect(packet.clip.bottom - packet.clip.top).toBeGreaterThanOrEqual(44);
    expect(packet.delivery.ownerConnected).toBe(true); expect(packet.delivery.ownerInPath).toBe(true);
    expect(packet.delivery.blocked).toBe(false); expect(packet.delivery.canvasInPath).toBe(false);
    const zoom = await page.getByTestId("target-selection-map-viewport").getAttribute("data-zoom");
    await selected.evaluate(state => {
      Object.assign(window, { __atlasWheel: [] });
      const listener = (event: WheelEvent) => {
        const map = document.querySelector('[data-testid="target-selection-map-viewport"]')!, canvas = map.getBoundingClientRect();
        const path = event.composedPath(), hit = document.elementFromPoint(event.clientX, event.clientY);
        (window as unknown as { __atlasWheel: unknown[] }).__atlasWheel.push({ trusted: event.isTrusted,
          x: event.clientX, y: event.clientY, deltaY: event.deltaY, target: (event.target as Element)?.tagName,
          canvas: canvas.toJSON(), horizontalOutside: event.clientX < canvas.left || event.clientX >= canvas.right,
          mapNotInPath: !path.includes(map), hit: hit ? { tag: hit.tagName, id: hit.id, insideMap: map === hit || map.contains(hit) } : null,
          directOwnerDelivery: hit === state.owner && event.target === state.owner && !!state.owner?.isConnected,
          ownerInPath: path.includes(state.owner!), owner: state.owner ? state.metrics(state.owner) : null,
          hitDelivery: state.owner ? state.delivery(hit, state.owner) : null,
          targetDelivery: state.owner ? state.delivery(event.target instanceof Element ? event.target : null, state.owner) : null,
          path: path.filter((item): item is Element => item instanceof Element).map(element => ({ tag: element.tagName, id: element.id,
            attributes: Object.fromEntries([...element.attributes].filter(attribute => /^(data-|aria-)|^role$/.test(attribute.name)).map(attribute => [attribute.name, attribute.value])) })) });
      };
      state.stopWheel = () => window.removeEventListener("wheel", listener, true);
      window.addEventListener("wheel", listener, { once: true, capture: true, passive: true });
    });
    await page.mouse.move(packet.point.x, packet.point.y); await page.mouse.wheel(0, delta);
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    const after = await selected.evaluate(state => {
      const ancestors: HTMLElement[] = []; for (let parent = state.node.parentElement; parent; parent = parent.parentElement) ancestors.push(parent);
      const hit = "point" in state.receipt ? document.elementFromPoint(state.receipt.point.x, state.receipt.point.y) : null;
      return { sameOwner: ancestors[state.index] === state.owner && !!state.owner?.isConnected, sameTarget: state.node.isConnected,
        hitDelivery: state.owner ? state.delivery(hit, state.owner) : null,
        owner: state.owner ? state.metrics(state.owner) : null, documentY: scrollY };
    });
    const wheel = await page.evaluate(() => (window as unknown as { __atlasWheel: { trusted: boolean; horizontalOutside: boolean; mapNotInPath: boolean; directOwnerDelivery: boolean; ownerInPath: boolean;
      hitDelivery: { ownerConnected: boolean; ownerInPath: boolean; blocked: boolean; canvasInPath: boolean } | null;
      targetDelivery: { ownerConnected: boolean; ownerInPath: boolean; blocked: boolean; canvasInPath: boolean } | null }[] }).__atlasWheel);
    await json(info, `${label}-wheel-${attempt}`, { packet, delta, wheel, after, zoomBefore: zoom,
      zoomAfter: await page.getByTestId("target-selection-map-viewport").getAttribute("data-zoom") });
    expect(after.sameOwner).toBe(true); expect(after.sameTarget).toBe(true); expect(after.documentY).toBe(0);
    expect(wheel.length).toBeGreaterThan(0); expect(wheel.every(row => row.trusted)).toBe(true);
    expect(wheel.every(row => row.horizontalOutside)).toBe(true); expect(wheel.every(row => row.mapNotInPath)).toBe(true);
    // Both event-time paths must reach this original connected owner without a
    // capturing scroll boundary. Direct-owner equality is diagnostic only.
    expect(wheel.every(row => [row.hitDelivery, row.targetDelivery].every(chain =>
      chain?.ownerConnected && chain.ownerInPath && !chain.blocked && !chain.canvasInPath))).toBe(true);
    expect(wheel.every(row => row.ownerInPath)).toBe(true);
    expect(after.owner).not.toBeNull();
    if (delta > 0) expect(after.owner!.scrollTop).toBeGreaterThan(packet.before.scrollTop);
    else expect(after.owner!.scrollTop).toBeLessThan(packet.before.scrollTop);
    await expect(page.getByTestId("target-selection-map-viewport")).toHaveAttribute("data-zoom", zoom!);
    await strictOverflow(page, true);
  } finally { await selected.evaluate(state => state.stopWheel?.()); await selected.dispose(); }
}

// Trusted browser input only. Re-measure each packet because chrome may move
// with its actual scroll owner. Scripted scrolling is never a native witness.
async function trustedReach(page: Page, target: Locator, info: TestInfo, label: string) {
  for (let attempt = 0; attempt < 12; attempt++) {
    const measured = await target.evaluate(node => {
      const box = node.getBoundingClientRect(), header = document.querySelector("[data-shell-topbar]")?.getBoundingClientRect();
      const nav = document.querySelector("[data-shell-navigation=compact]")?.getBoundingClientRect();
      const clip = { left: 0, right: innerWidth, top: header?.bottom ?? 0, bottom: nav?.top ?? innerHeight };
      const owners = [];
      for (let parent = node.parentElement; parent; parent = parent.parentElement) {
        const style = getComputedStyle(parent), bounds = parent.getBoundingClientRect();
        if (/auto|scroll|hidden|clip/.test(style.overflowY)) { clip.top = Math.max(clip.top, bounds.top); clip.bottom = Math.min(clip.bottom, bounds.bottom); }
        if (/auto|scroll|hidden|clip/.test(style.overflowX)) { clip.left = Math.max(clip.left, bounds.left); clip.right = Math.min(clip.right, bounds.right); }
        if (/auto|scroll/.test(style.overflowY)) owners.push({ tag: parent.tagName, scrollTop: parent.scrollTop, height: parent.clientHeight, content: parent.scrollHeight, box: bounds.toJSON() });
      }
      const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 }, hit = document.elementFromPoint(center.x, center.y);
      return { box: box.toJSON(), clip, owners, center, hitsSelf: hit === node || node.contains(hit), y: scrollY };
    });
    await json(info, `${label}-attempt-${attempt}`, measured);
    const visibleW = Math.min(measured.box.right, measured.clip.right) - Math.max(measured.box.left, measured.clip.left);
    const visibleH = Math.min(measured.box.bottom, measured.clip.bottom) - Math.max(measured.box.top, measured.clip.top);
    if (visibleW >= 44 && visibleH >= 44 && measured.hitsSelf) {
      if (!(await target.isDisabled())) {
        const selector = await target.evaluate(node => node.id ? `#${CSS.escape(node.id)}`
          : node.hasAttribute("aria-label") ? `${node.tagName.toLowerCase()}[aria-label=${JSON.stringify(node.getAttribute("aria-label"))}]`
            : `${node.tagName.toLowerCase()}:text-is(${JSON.stringify(node.textContent?.trim())})`);
        await hit44(page, selector, info, `${label}-continuous44`);
      }
      return measured.center;
    }
    if (page.viewportSize()!.width >= 760) { await pcOwnerWheel(page, target, info, label, attempt, measured); continue; }
    const chrome = page.getByRole("button", { name: "구역 현황", exact: true });
    const compact = page.viewportSize()!.width < 760;
    // Mobile owns natural document scrolling. Its panel may be wholly below
    // the viewport; only actual visible non-canvas header padding is a witness.
    const wheelTarget = compact ? page.locator("[data-shell-topbar]") : chrome;
    if (compact) await expect(wheelTarget).toBeVisible();
    const packet = await wheelTarget.evaluate((element, mobile) => {
      const rect = element.getBoundingClientRect(), canvas = document.querySelector("[data-testid=target-selection-map-viewport]")!.getBoundingClientRect();
      const point = mobile ? { x: rect.left + 4, y: rect.top + 12 }
        : { x: rect.x + rect.width / 2, y: Math.min(innerHeight - 12, Math.max(100, rect.y + 12)) };
      const hit = document.elementFromPoint(point.x, point.y);
      const owner = document.scrollingElement;
      return { point, rect: rect.toJSON(), canvas: canvas.toJSON(), hitsSelf: element === hit || element.contains(hit), outsideCanvas: point.x < canvas.left || point.x > canvas.right || point.y < canvas.top || point.y > canvas.bottom,
        header: document.querySelector("[data-shell-topbar]")?.getBoundingClientRect().toJSON(),
        nav: document.querySelector("[data-shell-navigation=compact]")?.getBoundingClientRect().toJSON(),
        insideChrome: point.x >= rect.left && point.x < rect.right && point.y >= rect.top && point.y < rect.bottom,
        insideViewport: point.x >= 0 && point.x < innerWidth && point.y >= 0 && point.y < innerHeight,
        documentY: scrollY, owner: { tag: owner?.tagName, top: owner?.scrollTop, height: owner?.clientHeight, content: owner?.scrollHeight,
          isDocument: owner === document.documentElement || owner === document.body } };
    }, compact);
    await json(info, `${label}-wheel-packet-${attempt}`, { compact, packet, target: measured });
    expect(packet.hitsSelf).toBe(true); expect(packet.outsideCanvas).toBe(true);
    if (compact) { expect(packet.insideChrome).toBe(true); expect(packet.insideViewport).toBe(true); expect(packet.owner.isDocument).toBe(true); }
    const zoom = await page.getByTestId("target-selection-map-viewport").getAttribute("data-zoom");
    await page.evaluate(() => {
      Object.assign(window, { __atlasWheel: [] });
      window.addEventListener("wheel", event => (window as unknown as { __atlasWheel: unknown[] }).__atlasWheel.push({ trusted: event.isTrusted,
        x: event.clientX, y: event.clientY, deltaY: event.deltaY, target: (event.target as Element)?.tagName }), { once: true, capture: true, passive: true });
    });
    const delta = measured.box.bottom > measured.clip.bottom ? 180 : -180;
    await page.mouse.move(packet.point.x, packet.point.y); await page.mouse.wheel(0, delta);
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    const wheel = await page.evaluate(() => (window as unknown as { __atlasWheel: { trusted: boolean }[] }).__atlasWheel);
    const documentY = await page.evaluate(() => scrollY);
    await json(info, `${label}-wheel-${attempt}`, { packet, delta, wheel, zoomBefore: zoom,
      zoomAfter: await page.getByTestId("target-selection-map-viewport").getAttribute("data-zoom"), documentY });
    expect(wheel.length).toBeGreaterThan(0); expect(wheel.every(row => row.trusted)).toBe(true);
    await expect(page.getByTestId("target-selection-map-viewport")).toHaveAttribute("data-zoom", zoom!);
    if (compact) { if (delta > 0) expect(documentY).toBeGreaterThan(packet.documentY); else expect(documentY).toBeLessThan(packet.documentY); }
    if (page.viewportSize()!.width >= 760) await strictOverflow(page, true);
  }
  throw Error(`Trusted wheel cannot expose ${label} with its complete44px intersection`);
}

async function nativeClick(page: Page, target: Locator, info: TestInfo, label: string) {
  const point = await trustedReach(page, target, info, label); await page.mouse.click(point.x, point.y);
}

async function selectFirstFixture(page: Page, drawer: Locator, info: TestInfo) {
  const input = drawer.getByRole("checkbox", { name: `${fixtures[0].name} 선택`, exact: true });
  await expect(input).toBeVisible(); await expect(input).toBeEnabled(); await expect(input).not.toBeChecked();
  const original = await input.elementHandle();
  // Measure the native input's associated label with the unchanged grid helper;
  // pointer activation targets that visible label, not the covered input or a
  // reconstructed strict text selector for its nested inline label text.
  const label = input.locator("xpath=ancestor::label"); await expect(label).toHaveCount(1);
  const originalLabel = await label.elementHandle();
  const selector = await input.evaluate(node => node.id ? `#${CSS.escape(node.id)}` : ""); expect(selector).not.toBe("");
  const exactInput = page.locator(selector); await expect(exactInput).toHaveCount(1);
  expect(await exactInput.evaluate((node, before) => node === before, original)).toBe(true);
  expect(await input.evaluate((node, associated) => [...((node as HTMLInputElement).labels ?? [])].includes(associated as HTMLLabelElement), originalLabel)).toBe(true);
  await json(info, "fixture-native-choice-root", { selector, inputId: await input.getAttribute("id"), unique: await exactInput.count(), associatedLabel: true });
  await hit44(page, selector, info, "fixture-native-choice-continuous44");
  await label.evaluate(node => node.addEventListener("click", event => {
    Object.assign(window, { __atlasChoiceClick: { trusted: event.isTrusted, targetTag: (event.target as Element).tagName,
      labelContainsTarget: node.contains(event.target as Node) } });
  }, { once: true, capture: true }));
  await label.click(); await expect(input).toBeChecked();
  const click = await page.evaluate(() => (window as unknown as { __atlasChoiceClick: { trusted: boolean; labelContainsTarget: boolean } }).__atlasChoiceClick);
  expect(click.trusted).toBe(true); expect(click.labelContainsTarget).toBe(true);
  expect(await input.evaluate((node, before) => node === before, original)).toBe(true);
  expect(await label.evaluate((node, before) => node === before, originalLabel)).toBe(true);
  await json(info, "fixture-label-selection", { inputId: await input.getAttribute("id"), checked: await input.isChecked(),
    enabled: await input.isEnabled(), labelBox: await label.boundingBox(), sameInput: true, sameLabel: true, click });
}

for (const size of sizes) for (const theme of themes) test(`ATLAS acceptance manual control-only ${theme} ${size.width}x${size.height}`, async ({ page }, info) => {
  await page.setViewportSize(size); await initTheme(page, theme); const { api, dashboard } = await installCustomer(page, true);
  await page.goto(`/control?siteId=${siteId}&mode=manual&keep=value#atlas`);
  await json(info, "actual-control-only-capability", dashboard.capabilities);
  await expect(page.getByRole("button", { name: "구역 현황", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "구역 관리", exact: true })).toHaveCount(0);
  await expect(page.getByRole("tab", { name: "스케줄 제어", exact: true })).toHaveCount(0);
  await expect(page.getByRole("tab", { name: "이벤트 제어", exact: true })).toHaveCount(0);
  await expect(page.getByRole("tab", { name: "그룹/구역", exact: true })).toBeVisible();
  const before = await canvases(page);
  const { geometry, viewport } = await operationalMapGeometry(before, info, "manual-map-viewport-and-drawn-canvas", size.width >= 760);
  const tools = page.getByRole("group", { name: "지도 선택 도구", exact: true });
  for (const name of ["이동", "개별 선택", "영역 선택"]) await expect(tools.getByRole("button", { name, exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /선택 도구 열기|밝기 실행 설정 열기/ })).toHaveCount(0);
  await nativeClick(page, page.getByRole("button", { name: "조명 목록 열기", exact: true }), info, "list-opener");
  const drawer = page.getByRole("dialog", { name: "조명 목록", exact: true });
  await selectFirstFixture(page, drawer, info);
  await drawer.getByRole("button", { name: "선택 완료", exact: true }).click();
  const selected = page.getByRole("button", { name: new RegExp(`^${fixtures[0].name} `) }); await expect(selected).toHaveAttribute("aria-pressed", "true");
  const input = page.getByRole("textbox", { name: "밝기 수치", exact: true });
  await trustedReach(page, input, info, "brightness"); await input.fill("30"); await input.press("Enter");
  await expect(page.getByRole("slider", { name: "밝기", exact: true })).toHaveValue("30");
  await page.getByRole("button", { name: theme === "light" ? "다크 모드로 변경" : "라이트 모드로 변경", exact: true }).click();
  await preserveCanvases(page, before); await expect(selected).toHaveAttribute("aria-pressed", "true");
  await expect(input).toHaveValue("30"); expect(api.dimmingRequests).toEqual([]);
  await assertColors(input, info, "manual-native-value-contrast", "value");
  const originalInput = await input.elementHandle();
  if (!originalInput) throw Error("Missing original brightness input");
  await input.evaluate(node => node.addEventListener("keydown", event => {
    Object.assign(window, { __atlasValueKey: { trusted: event.isTrusted, key: event.key,
      sameTarget: event.target === node, inputId: node.id, value: (node as HTMLInputElement).value } });
  }, { once: true, capture: true }));
  // ArrowLeft establishes keyboard modality without changing the existing draft.
  await input.focus(); await input.press("ArrowLeft");
  const key = await page.evaluate(() => (window as unknown as { __atlasValueKey: {
    trusted: boolean; key: string; sameTarget: boolean; inputId: string; value: string } }).__atlasValueKey);
  const sameInput = await input.evaluate((node, original) => node === original, originalInput);
  await json(info, "manual-native-value-key", { key, sameInput, inputId: await input.getAttribute("id") });
  expect(key.trusted).toBe(true); expect(key.key).toBe("ArrowLeft"); expect(key.sameTarget).toBe(true);
  expect(key.value).toBe("30"); expect(sameInput).toBe(true); expect(key.inputId).toBe(await input.getAttribute("id"));
  await assertColors(input, info, "manual-native-input-focus3", "focus");
  await preserveCanvases(page, before); await expect(selected).toHaveAttribute("aria-pressed", "true");
  await expect(input).toHaveValue("30"); expect(api.dimmingRequests).toEqual([]);
  await phase(page, info, "normal-manual-selection-draft", { canvas: geometry, drawnCanvas: geometry, viewport,
    overflow: await strictOverflow(page, size.width >= 760) });
});

function status(stage: "accepted" | "completed" | "failed" | "verification_required" | "verified_not_applied", long = false) {
  return { id: commandId, siteId, stage, outcome: stage === "completed" ? "applied" : stage === "verification_required" ? "unknown" : stage === "verified_not_applied" || stage === "failed" ? "not_applied" : "pending",
    targetType: "fixtures", targetFixtureIds: [fixtures[0].id], brightness: 30, verificationAttemptCount: 0, dispatchCount: 1,
    totalFixtureCount: 1, completedFixtureCount: stage === "accepted" ? 0 : 1, createdAt: commandDetailClockFixture.createdAt,
    generatedAt: commandDetailClockFixture.generatedAt, retainedFrom: commandDetailClockFixture.retainedFrom, retentionEnabled: false,
    errorMessage: stage === "failed" || long ? "실제 상태를 확인해야 합니다. ".repeat(long ? 30 : 1) : null,
    dispatches: [{ id: "original-dispatch", kind: "dimming", status: stage === "accepted" ? "accepted" : stage === "completed" ? "completed" : stage === "failed" ? "failed" : "timed_out",
      gateway: { id: gatewayId, name: "Gateway B2" }, errorMessage: null, results: [{ fixtureId: fixtures[0].id, fixtureName: fixtures[0].name,
        status: stage === "completed" ? "succeeded" : stage === "accepted" ? "pending" : stage === "failed" ? "failed" : "timed_out", brightness: 70, errorMessage: null }] }] };
}

for (const size of sizes.filter(size => size.width >= 760)) for (const theme of themes) for (const stage of ["accepted", "completed", "failed", "verification_required"] as const) {
  test(`ATLAS acceptance PC safety ${stage} ${theme} ${size.width}x${size.height}`, async ({ page }, info) => {
    await page.setViewportSize(size); await initTheme(page, theme); const { api } = await installCustomer(page, true);
    const original = status(stage, stage === "verification_required");
    const requestIds = new Map<Request, number>(), requestHistory: unknown[] = [];
    const requestId = (request: Request) => {
      if (!requestIds.has(request)) requestIds.set(request, requestIds.size + 1);
      return requestIds.get(request)!;
    };
    const observedCommand = (request: Request) => {
      const path = new URL(request.url()).pathname;
      return path === "/api/commands" || path === `/api/commands/${commandId}`;
    };
    const record = (kind: string, request: Request, extra: object = {}) => requestHistory.push({ kind,
      requestId: requestId(request), method: request.method(), url: request.url(), ...extra });
    page.on("request", request => { if (observedCommand(request)) record("public-request", request); });
    page.on("requestfinished", request => { if (observedCommand(request)) record("public-requestfinished", request); });
    page.on("requestfailed", request => { if (observedCommand(request)) record("public-requestfailed", request, { failure: request.failure() }); });
    const listBody = { items: [original], nextCursor: null, generatedAt: original.generatedAt,
      retainedFrom: original.retainedFrom, retentionEnabled: false };
    await page.route("**/api/commands?**", async route => {
      const request = route.request(); if (request.method() !== "GET") return route.fallback();
      record("list-callback", request, { suppliedBody: listBody });
      await json(info, `pc-list-${requestId(request)}-callback`, requestHistory);
      await route.fulfill({ json: listBody }); record("list-fulfill-ack", request);
      await json(info, `pc-list-${requestId(request)}-fulfill-ack`, requestHistory);
    });
    await page.route(`**/api/commands/${commandId}`, async route => {
      const request = route.request(); if (request.method() !== "GET") return route.fallback();
      record("detail-callback", request, { suppliedBody: original });
      await json(info, `pc-detail-${requestId(request)}-callback`, requestHistory);
      await route.fulfill({ json: original }); record("detail-fulfill-ack", request);
      await json(info, `pc-detail-${requestId(request)}-fulfill-ack`, requestHistory);
    });
    try {
      await page.goto(`/control?siteId=${siteId}`); await nativeClick(page, page.getByRole("button", { name: new RegExp(commandId) }), info, "recent-command");
      await expect(page.getByRole("status", { name: "명령 진행 상태", exact: true })).toContainText(
        stage === "accepted" ? "명령 처리 중" : stage === "completed" ? "성공" : stage === "failed" ? "실패" : "실제 상태 확인 필요");
      await nativeClick(page, page.getByRole("button", { name: "상세 보기", exact: true }), info, "details");
      const detail = page.getByRole("region", { name: "최근 결과 상세", exact: true }); await expect(detail).toContainText(fixtures[0].id);
      await nativeClick(page, page.getByRole("button", { name: "상세 접기", exact: true }), info, "collapse");
      if (stage === "verification_required") await trustedReach(page, page.getByRole("button", { name: "실제 상태 확인", exact: true }), info, "verification-action");
      const actual = await canvases(page);
      const { geometry: bounds, viewport } = await operationalMapGeometry(actual, info, "PC-safety-map-viewport-and-drawn-canvas", true);
      await assertColors(page.locator("[data-control-panel]"), info, "safety-visible-body45");
      await phase(page, info, "normal-PC-safety", { stage, bounds, drawnCanvas: bounds, viewport,
        overflow: await strictOverflow(page, true) }); expect(api.dimmingRequests).toEqual([]);
    } finally {
      // Callback ACK is not a parser receipt; preserve canceled StrictMode GET identities even on failure.
      await json(info, "pc-command-request-history", requestHistory);
    }
  });
}

for (const theme of themes) test(`ATLAS acceptance short NONMANAGER frozen UNCERTAIN recovery ${theme}`, async ({ page }, info) => {
  await page.setViewportSize({ width: 1024, height: 600 }); await initTheme(page, theme); await installCustomer(page, true);
  const posts: CreateDimmingCommandInput[] = [], checks: unknown[] = []; let stage: "verification_required" | "verified_not_applied" = "verification_required";
  const receipts: unknown[] = [];
  const record = (kind: string, detail: object = {}) => receipts.push({ sequence: receipts.length + 1,
    utc: new Date().toISOString(), kind, ...detail, posts: structuredClone(posts), checks: structuredClone(checks) });
  await page.route("**/api/commands/dimming", async route => {
    if (route.request().method() !== "POST") return route.fallback();
    const request = route.request(), payload = createDimmingCommandSchema.parse(request.postDataJSON());
    posts.push(payload);
    const received = { method: request.method(), url: request.url(), payload, ordinal: posts.length };
    record("dimming-callback", received);
    if (posts.length === 1) { await route.abort("failed"); record("dimming-abort-ack", received); return; }
    await route.fulfill({ json: { id: commandId, dispatchCount: 1, selectedTargetCount: 1, transmissionCount: 1, deliveryMode: "unicast", terminalStatusUrl: `/commands/${commandId}` } });
    record("dimming-fulfill-ack", received);
  });
  await page.route(`**/api/commands/${commandId}`, async route => {
    const request = route.request(), received = { method: request.method(), url: request.url(), payload: request.postDataJSON(), suppliedStage: stage };
    record("detail-callback", received);
    await route.fulfill({ json: status(stage, true) }); record("detail-fulfill-ack", received);
  });
  await page.route(`**/api/commands/${commandId}/status-checks`, async route => {
    const request = route.request(), payload = request.postDataJSON(); checks.push(payload);
    const received = { method: request.method(), url: request.url(), payload, ordinal: checks.length };
    record("check-callback", received);
    if (checks.length === 1) { await route.abort("failed"); record("check-abort-ack", received); return; }
    stage = "verified_not_applied";
    await route.fulfill({ json: { dispatchId: "check-dispatch", dispatchIds: ["check-dispatch"], verificationAttempt: 1, terminalStatusUrl: `/commands/${commandId}` } });
    record("check-fulfill-ack", received);
  });
  try {
    await page.goto(`/control?siteId=${siteId}`);
    await nativeClick(page, page.getByRole("button", { name: "조명 목록 열기", exact: true }), info, "uncertain-list");
    const drawer = page.getByRole("dialog", { name: "조명 목록", exact: true });
    await selectFirstFixture(page, drawer, info);
    await drawer.getByRole("button", { name: "선택 완료", exact: true }).click();
    const input = page.getByRole("textbox", { name: "밝기 수치", exact: true }); await trustedReach(page, input, info, "uncertain-input");
    await input.fill("30"); await input.press("Enter");
    const apply = page.getByRole("button", { name: "1개 조명에 밝기 적용", exact: true });
    await expect(apply).toBeVisible(); await expect(apply).toBeEnabled(); record("ready", { action: "explicit-apply" });
    record("action", { action: "explicit-apply" }); await nativeClick(page, apply, info, "explicit-apply");
    const retry = page.getByRole("button", { name: "동일 요청 확인(새 제어 아님)", exact: true });
    await expect(retry).toBeVisible(); await expect(retry).toBeEnabled();
    await expect.poll(() => posts).toHaveLength(1); record("ready", { action: "frozen-original" });
    const frozen = structuredClone(posts[0]), storage = await page.evaluate(() => JSON.stringify(Object.entries(sessionStorage))), before = await canvases(page);
    expect(frozen).toMatchObject({ siteId, brightness: 30 }); expect(frozen.clientRequestId).toMatch(/^[a-f0-9-]{36}$/);
    await page.getByRole("button", { name: theme === "dark" ? "라이트 모드로 변경" : "다크 모드로 변경", exact: true }).click();
    await preserveCanvases(page, before); expect(posts).toEqual([frozen]);
    expect(await page.evaluate(() => JSON.stringify(Object.entries(sessionStorage)))).toBe(storage);
    await expect(input).toBeDisabled(); await phase(page, info, "normal-frozen-uncertain", { frozen, storage, overflow: await strictOverflow(page, true) });
    // A native click completes browser input, not the asynchronous route/ACK/UI.
    // Poll only actual receipts within the original expect budget; never replay input.
    await expect(retry).toBeVisible(); await expect(retry).toBeEnabled(); expect(posts).toEqual([frozen]);
    record("ready", { action: "same-request-query" }); record("action", { action: "same-request-query" });
    await nativeClick(page, retry, info, "same-request-query"); await expect.poll(() => posts).toEqual([frozen, frozen]);
    const progress = page.getByRole("status", { name: "명령 진행 상태", exact: true });
    await expect(progress).toContainText("실제 상태 확인 필요");
    const check = page.getByRole("button", { name: "실제 상태 확인", exact: true });
    await expect(check).toBeVisible(); await expect(check).toBeEnabled();
    expect(posts).toEqual([frozen, frozen]); record("ready", { action: "status-check", publicState: await progress.innerText() });
    record("action", { action: "status-check" }); await nativeClick(page, check, info, "status-check");
    await expect.poll(() => checks).toHaveLength(1);
    const firstCheck = structuredClone(checks[0]);
    expect(firstCheck).toEqual({ clientRequestId: expect.stringMatching(/^[a-f0-9-]{36}$/) });
    const sameCheck = page.getByRole("button", { name: "동일 상태 확인 요청 조회", exact: true });
    await expect(sameCheck).toBeVisible(); await expect(sameCheck).toBeEnabled(); await expect(input).toBeDisabled();
    expect(checks).toEqual([firstCheck]); expect(posts).toEqual([frozen, frozen]);
    record("ready", { action: "same-status-check", publicState: await progress.innerText() });
    record("action", { action: "same-status-check" }); await nativeClick(page, sameCheck, info, "same-status-check");
    await expect.poll(() => checks).toHaveLength(2); expect(checks).toEqual([firstCheck, firstCheck]);
    expect(checks[1]).toEqual(checks[0]); expect(posts).toEqual([frozen, frozen]);
    await expect(progress).toContainText("미적용 확인");
    const reapply = page.getByRole("button", { name: "안전하게 다시 적용", exact: true });
    await expect(reapply).toBeVisible(); await expect(reapply).toBeEnabled(); await expect(input).toBeEnabled();
    record("ready", { action: "safe-reapply", publicState: await progress.innerText() });
    await input.fill("100"); await input.press("Enter"); await expect(input).toHaveValue("100");
    expect(posts).toEqual([frozen, frozen]); expect(checks).toEqual([firstCheck, firstCheck]);
    record("action", { action: "safe-reapply", currentDraft: await input.inputValue() }); await nativeClick(page, reapply, info, "safe-reapply");
    await expect.poll(() => posts).toHaveLength(3);
    expect(posts).toHaveLength(3); expect(posts.slice(0, 2)).toEqual([frozen, frozen]);
    expect(posts[2]).toMatchObject({ siteId, brightness: 30, target: { type: "fixtures", fixtureIds: [fixtures[0].id] } });
    expect(posts[2].clientRequestId).not.toBe(frozen.clientRequestId);
    expect(posts[2].clientRequestId).toMatch(/^[a-f0-9-]{36}$/); expect(checks).toEqual([firstCheck, firstCheck]);
    record("received-safe-original", { frozen, firstCheck });
    await phase(page, info, "normal-safe-original-target", { frozen, posts, checks, overflow: await strictOverflow(page, true) });
  } finally {
    // Route abort/fulfill ACK records transport handling, not parser or UI completion.
    await json(info, "uncertain-original-request-receipts", receipts);
  }
});

for (const theme of themes) for (const requested of [759.5, 760, 760.5]) test(`ATLAS acceptance requested fractional ${requested} ${theme}`, async ({ page, baseURL }, info) => {
  await page.setViewportSize({ width: 1024, height: 768 }); await initTheme(page, theme); await installCustomer(page);
  await page.goto(`/settings?siteId=${siteId}`);
  await page.evaluate(({ requested, url }) => { const frame = document.createElement("iframe"); frame.title = "fractional customer viewport";
    frame.style.width = `${requested}px`; frame.style.height = "768px"; frame.style.border = "0"; frame.src = url; document.body.append(frame);
  }, { requested, url: `${baseURL}/settings?siteId=${siteId}` });
  const frame = page.frameLocator("iframe[title='fractional customer viewport']"); await expect(frame.locator("[data-shell-topbar]")).toBeVisible();
  const actual = await frame.locator("html").evaluate(() => ({ width: innerWidth, clientWidth: document.documentElement.clientWidth,
    height: innerHeight, compact: matchMedia("(width < 760px)").matches, theme: document.documentElement.getAttribute("data-customer-theme") }));
  const requestedRect = await page.locator("iframe").boundingBox(); await json(info, "fractional-requested-observed", { requested, requestedRect, actual,
    physicalFractionalVerified: actual.width === requested && !Number.isInteger(actual.width) });
  expect(actual.compact).toBe(actual.width < 760); expect(actual.theme).toBe(theme);
  await expect(frame.locator(`[data-shell-navigation=${actual.compact ? "compact" : "desktop"}]`)).toBeVisible();
  await phase(page, info, "normal-fractional-observation", { requested, actual });
});

for (const theme of themes) for (const state of ["loading", "error", "empty"] as const) test(`ATLAS acceptance site ${state} ${theme} 320x740`, async ({ page, baseURL }, info) => {
  await page.setViewportSize({ width: 320, height: 740 }); await initTheme(page, theme); await installCustomer(page);
  let release: () => void = () => {}; const pending = new Promise<void>(resolve => { release = resolve; });
  const url = new URL("/api/sites", baseURL).href;
  const matches = (request: Request) => request.method() === "GET" && request.url() === url;
  const requests = new Map<Request, number>();
  const events: Array<Record<string, unknown>> = [], completed: Array<{ id: number; status: number; error: string | null }> = [];
  const failures: Array<{ id: number | undefined; error: string | null }> = [], issues: string[] = [];
  const routeTasks: Promise<void>[] = [], finishTasks: Promise<void>[] = [];
  let routeCount = 0, fulfillAcks = 0, wake: () => void = () => {}, routeReady: () => void = () => {};
  const firstRoute = new Promise<void>(resolve => { routeReady = resolve; });
  let changed = new Promise<void>(resolve => { wake = resolve; });
  const record = (kind: string, values: Record<string, unknown> = {}) => events.push({ sequence: events.length + 1, utc: new Date().toISOString(), kind, ...values });
  const notify = () => { const previous = wake; changed = new Promise<void>(resolve => { wake = resolve; }); previous(); };
  const problem = (error: unknown) => { issues.push(String(error)); record("observer-error", { error: String(error) }); routeReady(); notify(); };
  const onRequest = (request: Request) => { if (!matches(request)) return;
    const id = requests.size + 1; requests.set(request, id); record("request", { id, method: request.method(), url: request.url() }); };
  const onResponse = (response: NonNullable<Awaited<ReturnType<Request["response"]>>>) => {
    if (!matches(response.request())) return;
    const id = requests.get(response.request()); record("response", { id, status: response.status() });
    if (id === undefined) { problem("Site response without observed request"); return; }
    // Headers and route.fulfill ACK are not body completion or query/React readiness.
    finishTasks.push(response.finished().then(error => {
      const receipt = { id, status: response.status(), error: error?.message ?? null };
      completed.push(receipt); record("response-finished", receipt);
      if (error) issues.push(error.message); notify();
    }).catch(problem));
  };
  const onFailed = (request: Request) => { if (!matches(request)) return;
    const receipt = { id: requests.get(request), error: request.failure()?.errorText ?? null };
    failures.push(receipt); record("requestfailed", receipt); problem(`Site request failed: ${receipt.error}`); };
  const onClose = () => problem("Page closed before site observer cleanup");
  page.on("request", onRequest); page.on("response", onResponse); page.on("requestfailed", onFailed); page.on("close", onClose);
  await page.route("**/api/sites", route => {
    const task = (async () => {
      const id = requests.get(route.request()); routeCount++; record("route-callback", { id }); routeReady();
      if (!matches(route.request()) || id === undefined) problem("Unexpected site route request");
      if (state === "loading") await pending;
      await route.fulfill(state === "error" ? { status: 503, json: { message: "sites unavailable" } } : { json: [] });
      fulfillAcks++; record("route-fulfill-ack", { id });
    })().catch(problem);
    routeTasks.push(task); return task;
  });
  const awaitCompleted = async (count: number) => {
    while (completed.length < count && issues.length === 0) await changed;
    await Promise.all(routeTasks);
    expect(issues).toEqual([]); expect(failures).toEqual([]);
    expect(requests.size).toBe(count); expect(routeCount).toBe(count); expect(fulfillAcks).toBe(count);
    expect(completed).toEqual(Array.from({ length: count }, (_, index) => ({ id: index + 1, status: state === "error" ? 503 : 200, error: null })));
  };
  let bodyFailed = false;
  try {
    await page.goto(`/settings?siteId=${siteId}`);
    // useSites retains its installed three exponential-backoff retries. Only the
    // error case waits for four completed 503s before the original 5s UI assertion.
    if (state === "error") await awaitCompleted(4);
    else if (state === "empty") await awaitCompleted(1);
    else { await firstRoute; expect(issues).toEqual([]); expect(completed).toEqual([]); }
    const label = state === "loading" ? "현장 목록 확인 중" : state === "error" ? "현장 목록 확인 불가" : "접근 가능한 현장 없음";
    const button = page.locator("[data-shell-topbar]").getByRole("button", { name: label, exact: true }); await expect(button).toBeVisible();
    record("public-ui-ready", { label, requests: requests.size, completed: completed.length, fulfillAcks, disabled: await button.isDisabled() });
    const box = (await button.boundingBox())!; expect(box.width).toBe(128); expect(box.height).toBeGreaterThanOrEqual(44);
    await hit44(page, "[data-shell-actions] button", info, "site-state-enabled44");
    await phase(page, info, "normal-site-state", { state, box, disabled: await button.isDisabled(), overflow: await strictOverflow(page) });
    if (state === "loading") { expect(completed).toEqual([]); expect(fulfillAcks).toBe(0); }
    else await awaitCompleted(state === "error" ? 4 : 1);
  } catch (error) { bodyFailed = true; throw error; }
  finally {
    record("cleanup-release", { bodyFailed }); release();
    try {
      // Loading stays held through all original checks; its 200 completion is
      // observed only during cleanup. Never replace a primary failure with cleanup.
      if (!bodyFailed) await awaitCompleted(state === "error" ? 4 : 1);
    } finally {
      page.off("request", onRequest); page.off("response", onResponse); page.off("requestfailed", onFailed); page.off("close", onClose);
      routeReady(); wake();
      await Promise.all([...routeTasks, ...finishTasks]);
      record("observer-cleanup", { requests: requests.size, routeCount, fulfillAcks, completed: completed.length });
      try {
        await json(info, "site-state-lifecycle", { state, theme, url, bodyFailed, requests: requests.size, routeCount, fulfillAcks, completed, failures, issues, events });
      } catch (error) {
        // Keep the pending body error's identity; report evidence failure separately.
        if (!bodyFailed) throw error;
        console.error("ATLAS_SITE_STATE_SECONDARY_EVIDENCE_ERROR", error);
      }
    }
  }
});

test("ATLAS acceptance stored preference reload cross-tab failure and customer cleanup", async ({ page, context }, info) => {
  await initTheme(page, "dark", true); await installCustomer(page); await page.goto(`/settings?siteId=${siteId}`);
  await firstFrame(page, "dark", info); await page.reload(); await firstFrame(page, "dark", info);
  const other = await context.newPage(); await other.goto(`/settings?siteId=${siteId}`);
  await other.evaluate(key => localStorage.setItem(key, "light"), themeKey);
  await expect(page.locator("html")).toHaveAttribute("data-customer-theme", "light");
  await other.evaluate(key => localStorage.removeItem(key), themeKey);
  await expect(page.locator("html")).toHaveAttribute("data-customer-theme", "light"); await other.close();
  await page.evaluate(key => { const original = Storage.prototype.setItem; Storage.prototype.setItem = function (name, value) {
    if (name === key) throw new DOMException("fixture write failure", "QuotaExceededError"); return original.call(this, name, value);
  }; }, themeKey);
  await page.getByRole("button", { name: "다크 모드로 변경", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-customer-theme", "dark");
  await page.goto("/login"); await expect(page.locator("html")).not.toHaveAttribute("data-customer-theme", /light|dark/);
  await phase(page, info, "normal-noncustomer-default");
});

for (const theme of themes) test(`ATLAS acceptance MFA enrollment draft survives theme ${theme}`, async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 844 }); await initTheme(page, theme); await installCustomer(page);
  const requests: Array<{ method: string; path: string; body: unknown }> = [];
  await page.route("**/api/auth/**", route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (path === "/api/auth/me") return route.fallback();
    requests.push({ method: request.method(), path, body: request.method() === "GET" ? null : request.postDataJSON() });
    if (path === "/api/auth/mfa" && request.method() === "GET") return route.fulfill({ json: { enabled: false, enabledAt: null } });
    if (path === "/api/auth/sessions" && request.method() === "GET") return route.fulfill({ json: { sessions: [] } });
    if (path === "/api/auth/mfa/enrollment" && request.method() === "POST") return route.fulfill({ json: {
      enrollmentToken: "atlas-enrollment", secret: "ATLASFIXTURESECRET", otpauthUri: "otpauth://totp/LED%20Control:atlas?secret=ATLASFIXTURESECRET", expiresAt: "2099-10-07T00:00:00.000Z"
    } });
    return route.fulfill({ status: 404, json: { message: "Unhandled security fixture route" } });
  });
  await page.goto(`/settings/security?siteId=${siteId}`); await expect(page).toHaveURL(`/settings/security?siteId=${siteId}`);
  await expect(page.getByRole("heading", { name: "계정 보안", exact: true })).toBeVisible();
  const setup = page.getByRole("button", { name: "2단계 인증 설정", exact: true }); await expect(setup).toBeVisible(); await expect(setup).toBeEnabled();
  // Sessions load independently; settle their public state before the no-extra-request baseline.
  await expect(page.getByText("표시할 활성 세션이 없습니다.", { exact: true })).toBeVisible(); await setup.click();
  await expect(page.getByRole("form", { name: "2단계 인증 설정", exact: true })).toBeVisible();
  await expect(page.getByText("ATLASFIXTURESECRET", { exact: true })).toBeVisible();
  const input = page.getByLabel("인증 앱 코드", { exact: true }); await expect(input).toBeVisible(); await expect(input).toBeEditable();
  await input.fill("654321"); const handle = await input.elementHandle();
  const before = structuredClone(requests); await page.getByRole("button", { name: theme === "dark" ? "라이트 모드로 변경" : "다크 모드로 변경", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-customer-theme", theme === "dark" ? "light" : "dark");
  expect(await input.evaluate((node, original) => node === original, handle)).toBe(true); await expect(input).toHaveValue("654321");
  await expect(page.getByText("ATLASFIXTURESECRET", { exact: true })).toBeVisible(); expect(requests).toEqual(before);
  const posts = requests.filter(row => row.method === "POST"); expect(posts).toHaveLength(1);
  expect(posts[0]).toEqual({ method: "POST", path: "/api/auth/mfa/enrollment", body: {} });
  expect(await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }))).not.toContain("ATLASFIXTURESECRET");
  await phase(page, info, "normal-MFA-draft", { requests });
});

async function toggleFromCustomerTab(page: Page, target: Theme) {
  const other = await page.context().newPage();
  try {
    await installCustomer(other); await other.goto(`${new URL(page.url()).origin}/settings?siteId=${siteId}`);
    await other.getByRole("button", { name: target === "dark" ? "다크 모드로 변경" : "라이트 모드로 변경", exact: true }).click();
    await expect(page.locator("html")).toHaveAttribute("data-customer-theme", target);
  } finally { await other.close(); }
}

// Ordinary-browser transport only, matching statistics-mobile-files. This
// owned exact URL is the sole exception to the unchanged mock-origin boundary.
async function pendingPdfFile(page: Page, info: TestInfo) {
  const bytes = Buffer.from("%PDF-1.7\nbrowser-transport-fixture");
  let release: () => void = () => {}; const gate = new Promise<void>(resolve => { release = resolve; });
  const requests: Array<{ utc: string; method: string; url: string; requestClosed: number; aborted: number; prematureClose: number;
    finished: number; errors: string[]; response: ServerResponse }> = [];
  const unexpected: Array<{ method?: string; path?: string }> = [];
  const server = createServer(async (request, response) => {
    if (request.method !== "GET" || request.url !== "/report.pdf") {
      unexpected.push({ method: request.method, path: request.url }); response.writeHead(405); response.end(); return;
    }
    const row = { utc: new Date().toISOString(), method: request.method, url: `http://${request.headers.host}${request.url}`,
      requestClosed: 0, aborted: 0, prematureClose: 0, finished: 0, errors: [] as string[], response };
    requests.push(row);
    request.on("aborted", () => row.aborted++); request.on("close", () => row.requestClosed++);
    request.on("error", error => row.errors.push(String(error))); response.on("error", error => row.errors.push(String(error)));
    response.on("finish", () => row.finished++);
    // IncomingMessage normal close is not a PDF abort. Only premature response
    // closure before writableFinished is classified as transport disconnect.
    response.on("close", () => { if (!response.writableFinished) row.prematureClose++; });
    // Explicit body-pending boundary: attachment headers release the browser's
    // pending document navigation, but no payload byte/end is sent until gate.
    response.writeHead(200, { "content-type": "application/pdf", "content-disposition": "attachment; filename=report.pdf" });
    response.flushHeaders();
    await gate;
    if (!response.destroyed) {
      response.end(bytes);
    }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw Error("Missing owned PDF port");
  const downloadUrl = `http://127.0.0.1:${address.port}/report.pdf`;
  const snapshot = () => ({ port: address.port, downloadUrl, count: requests.length, unexpected,
    requests: requests.map(({ response, ...row }) => ({ ...row, headersSent: response.headersSent,
      destroyed: response.destroyed, writableEnded: response.writableEnded, writableFinished: response.writableFinished })) });
  const cleanup = async () => {
    release(); server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    const connections = await new Promise<number>((resolve, reject) => server.getConnections((error, count) => error ? reject(error) : resolve(count)));
    await json(info, "owned-PDF-file-cleanup", { utc: new Date().toISOString(), pid: process.pid, listening: server.listening,
      address: server.address(), connections, ...snapshot() });
    expect(server.listening).toBe(false); expect(server.address()).toBeNull(); expect(connections).toBe(0);
  };
  try {
    await page.route(downloadUrl, route => route.request().method() === "GET" ? route.continue() : route.abort("blockedbyclient"));
    await json(info, "owned-PDF-file-start", { utc: new Date().toISOString(), pid: process.pid, ...snapshot() });
    return { bytes, downloadUrl, release, snapshot, cleanup };
  } catch (error) { await cleanup(); throw error; }
}

for (const theme of themes) test(`ATLAS acceptance PDF pending job and CSV draft survive theme ${theme}`, async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 844 }); await initTheme(page, theme); await installFirstScreenStatisticsFixtures(page);
  const job = browserReport("processing"), completed = browserReport("completed");
  // Keep Sep19 fixture expiry unchanged: this completed-status action requests
  // a fresh on-demand descriptor, not a cached URL or patched fixture clock.
  const deliveryJob = { ...completed, reportId: "30000000-0000-4000-8000-000000000042",
    target: { ...completed.target, label: "완료 PDF 전달 대상" } };
  const writes: unknown[] = [], exports: string[] = [];
  await page.route("**/energy/sites/*/reports?**", route => route.request().method() === "GET"
    ? route.fulfill({ json: { reports: [job, deliveryJob], nextCursor: null, totalCount: 2 } }) : route.fallback());
  page.on("request", request => { if (request.method() === "POST") writes.push({ url: request.url(), body: request.postData() }); if (request.url().includes("/exports/csv")) exports.push(request.url()); });
  await page.goto(`/statistics/reports?siteId=${job.siteId}`); const card = page.getByRole("list", { name: "보고서 생성 이력", exact: true });
  await expect(card).toContainText("2026-09-01"); await expect(card).toContainText("2026-09-07"); const handle = await card.elementHandle();
  await expect(card).toContainText("생성 중 40%");
  const before = JSON.stringify(writes); await page.getByRole("button", { name: theme === "dark" ? "라이트 모드로 변경" : "다크 모드로 변경", exact: true }).click();
  expect(await card.evaluate((node, original) => node === original, handle)).toBe(true); expect(JSON.stringify(writes)).toBe(before); expect(exports).toEqual([]);
  const file = await pendingPdfFile(page, info);
  let releaseDescriptor: () => void = () => {}; const descriptorGate = new Promise<void>(resolve => { releaseDescriptor = resolve; });
  const descriptorUrl = `${new URL(page.url()).origin}/api/energy/sites/${job.siteId}/reports/${deliveryJob.reportId}/download`;
  const descriptorRequests: Request[] = [], finished: Request[] = [], failed: Array<{ sameOriginal: boolean; failure: unknown }> = [], downloads: string[] = [];
  page.on("requestfinished", request => { if (request.url() === descriptorUrl) finished.push(request); });
  page.on("requestfailed", request => { if (request.url() === descriptorUrl) failed.push({ sameOriginal: request === descriptorRequests[0], failure: request.failure() }); });
  page.on("download", download => downloads.push(download.url()));
  try {
  await page.route(descriptorUrl, async route => {
    if (route.request().method() !== "GET") return route.fallback();
    descriptorRequests.push(route.request()); await descriptorGate;
    await route.fulfill({ json: { reportId: deliveryJob.reportId, format: "pdf", downloadUrl: file.downloadUrl, expiresInSeconds: 300 } });
  });
    const originalUrl = page.url(), processingRow = card.getByRole("listitem").filter({ hasText: job.target.label });
    const deliveryRow = card.getByRole("listitem").filter({ hasText: deliveryJob.target.label });
    const button = deliveryRow.getByRole("button", { name: "완료 PDF 전달 대상 보고서 다운로드", exact: true });
    const processingHandle = await processingRow.elementHandle(), deliveryHandle = await deliveryRow.elementHandle(), buttonHandle = await button.elementHandle();
    const sameState = async () => {
      const identity = { list: await card.evaluate((node, original) => node === original, handle),
        processing: await processingRow.evaluate((node, original) => node === original, processingHandle),
        delivery: await deliveryRow.evaluate((node, original) => node === original, deliveryHandle),
        button: await button.evaluate((node, original) => node === original, buttonHandle) };
      expect(identity).toEqual({ list: true, processing: true, delivery: true, button: true });
      expect(page.url()).toBe(originalUrl); expect(new URL(page.url()).searchParams.get("siteId")).toBe(job.siteId);
      await expect(processingRow).toContainText("생성 중 40%");
      for (const row of [processingRow, deliveryRow]) { await expect(row).toContainText("2026-09-01"); await expect(row).toContainText("2026-09-07"); }
      expect(JSON.stringify(writes)).toBe(before); expect(exports).toEqual([]);
      return { identity, originalUrl, siteId: job.siteId, processingJobId: job.reportId, deliveryJobId: deliveryJob.reportId,
        actualTheme: await page.locator("html").getAttribute("data-customer-theme"),
        processingText: await processingRow.innerText(), deliveryText: await deliveryRow.innerText(), buttonDisabled: await button.isDisabled() };
    };
    const descriptorState = () => ({ url: descriptorUrl, requests: descriptorRequests.map((request, index) => ({ ordinal: index + 1,
      method: request.method(), url: request.url(), sameOriginal: request === descriptorRequests[0] })),
      finished: finished.map(request => ({ sameOriginal: request === descriptorRequests[0], url: request.url() })), failed, downloads });
    await button.click(); await expect.poll(() => descriptorRequests.length).toBe(1);
    await expect(button).toBeDisabled(); await expect(page.getByRole("button", { name: "파일 준비 취소", exact: true })).toBeVisible();
    expect(finished).toEqual([]); expect(failed).toEqual([]); expect(downloads).toEqual([]); expect(file.snapshot().count).toBe(0);
    await toggleFromCustomerTab(page, theme);
    await expect(button).toBeDisabled(); await expect(page.getByRole("button", { name: "파일 준비 취소", exact: true })).toBeVisible();
    expect(descriptorRequests).toHaveLength(1); expect(finished).toEqual([]); expect(failed).toEqual([]); expect(downloads).toEqual([]); expect(file.snapshot().count).toBe(0);
    await phase(page, info, "normal-PDF-descriptor-pending", { ...await sameState(), descriptor: descriptorState(), file: file.snapshot(),
      deliveryJob, expiryNote: "unchanged fixture expiry; fresh on-demand descriptor pending", writes, exports });
    // Download starts at attachment headers; this same object remains pending
    // until the owned body gate releases its original 34 bytes below.
    const downloadPending = page.waitForEvent("download"); downloadPending.catch(() => {});
    const responsePending = page.waitForResponse(response => response.request() === descriptorRequests[0]);
    releaseDescriptor(); const descriptorResponse = await responsePending;
    expect(descriptorResponse.status()).toBe(200);
    const descriptor = await descriptorResponse.json();
    expect(descriptor).toEqual({ reportId: deliveryJob.reportId, format: "pdf", downloadUrl: file.downloadUrl, expiresInSeconds: 300 });
    await expect.poll(() => finished.length).toBe(1); expect(finished[0]).toBe(descriptorRequests[0]); expect(failed).toEqual([]);
    await expect.poll(() => file.snapshot().count).toBe(1);
    const delivered = await downloadPending; expect(delivered.url()).toBe(descriptor.downloadUrl);
    const downloadStarted = { utc: new Date().toISOString(), url: delivered.url(), completedBody: false };
    await json(info, "PDF-download-start-body-pending", { ...downloadStarted, descriptor: descriptorState(), file: file.snapshot() });
    const pendingFile = () => {
      const receipt = file.snapshot(); expect(receipt.count).toBe(1); expect(receipt.unexpected).toEqual([]);
      expect(receipt.requests[0]).toMatchObject({ method: "GET", url: descriptor.downloadUrl, headersSent: true,
        destroyed: false, writableEnded: false, writableFinished: false, aborted: 0, prematureClose: 0, finished: 0, errors: [] });
      expect(descriptorRequests).toHaveLength(1); expect(finished).toHaveLength(1); expect(failed).toEqual([]); expect(downloads).toEqual([file.downloadUrl]);
      return receipt;
    };
    pendingFile(); await toggleFromCustomerTab(page, theme === "dark" ? "light" : "dark");
    await phase(page, info, "normal-PDF-file-body-pending", { ...await sameState(), descriptor, request: descriptorState(),
      downloadStarted, boundary: "attachment headers sent; original body gated", file: pendingFile(), writes, exports });
    // Ordinary browser anchor handoff can finish product busy state before the
    // byte GET. Do not demand disabled/cancel or a private AbortSignal here.
    file.release();
    expect(delivered.url()).toBe(descriptor.downloadUrl); expect(await delivered.failure()).toBeNull();
    const deliveredPath = await delivered.path(); expect(deliveredPath).not.toBeNull();
    const bytes = await readFile(deliveredPath!); expect(bytes).toEqual(file.bytes); expect(bytes.length).toBe(34);
    expect(downloads).toEqual([file.downloadUrl]); expect(descriptorRequests).toHaveLength(1); expect(finished).toHaveLength(1); expect(failed).toEqual([]);
    expect(file.snapshot().count).toBe(1); expect(file.snapshot().requests[0]).toMatchObject({ aborted: 0, prematureClose: 0, finished: 1, errors: [] });
    await phase(page, info, "normal-PDF-delivered-original-bytes", { ...await sameState(), descriptor, request: descriptorState(), file: file.snapshot(),
      delivered: { url: delivered.url(), failure: null, path: deliveredPath, byteLength: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }, writes, exports });
  await page.getByRole("button", { name: "보고서 만들기", exact: true }).click();
  const dialog = page.getByRole("dialog"); await expect(dialog).toBeVisible();
  const values = await dialog.locator("input").evaluateAll(nodes => nodes.map(node => ({ id: node.id, value: node.value }))), dialogHandle = await dialog.elementHandle();
  // The real modal traps focus and makes the header inert. A genuine storage
  // event from another same-origin tab changes theme without bypassing it.
  await toggleFromCustomerTab(page, theme);
  expect(await dialog.evaluate((node, original) => node === original, dialogHandle)).toBe(true);
  expect(await dialog.locator("input").evaluateAll(nodes => nodes.map(node => ({ id: node.id, value: node.value })))).toEqual(values);
  expect(JSON.stringify(writes)).toBe(before); expect(exports).toEqual([]); await phase(page, info, "normal-report-draft", { job, values, writes, exports });
  let release: () => void = () => {}; const pending = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/energy/sites/*/exports/csv?**", async route => { await pending;
    await route.fulfill({ contentType: "text/csv", body: "date,kwh\n2026-09-01,0\n" }); });
  try {
    await dialog.getByRole("button", { name: "CSV 내보내기", exact: true }).click();
    await expect.poll(() => exports.length).toBe(1); const frozenExport = exports[0];
    await toggleFromCustomerTab(page, theme === "dark" ? "light" : "dark");
    expect(await dialog.evaluate((node, original) => node === original, dialogHandle)).toBe(true);
    expect(await dialog.locator("input").evaluateAll(nodes => nodes.map(node => ({ id: node.id, value: node.value })))).toEqual(values);
    expect(exports).toEqual([frozenExport]); expect(JSON.stringify(writes)).toBe(before);
    await expect(dialog.getByRole("button", { name: "파일 준비 취소", exact: true })).toBeVisible();
    await phase(page, info, "normal-CSV-pending-same-operation", { job, values, frozenExport, writes });
    const download = page.waitForEvent("download"); release(); const file = await download;
    const path = await file.path(); expect(path).not.toBeNull(); expect((await readFile(path!)).toString()).toContain("2026-09-01,0");
    const csvBytes = await readFile(path!); expect(csvBytes).toEqual(Buffer.from("date,kwh\n2026-09-01,0\n"));
    await json(info, "CSV-original-bytes", { url: file.url(), failure: await file.failure(), byteLength: csvBytes.length,
      sha256: createHash("sha256").update(csvBytes).digest("hex"), frozenExport, exports, writes });
    expect(exports).toEqual([frozenExport]);
  } finally { release(); }
  } finally { releaseDescriptor(); await file.cleanup(); }
});
