import { expect, test as base } from "@playwright/test";
import { installDesignMemoryBoundary, test as designTest } from "./support/design-system-fixture";
const main = process.env.TASK5_ENTRY === "main";
const service = main || process.env.WEB_DEPLOY_MODE === "service";
const test = main ? designTest : base.extend<{ _publicBoundary: void }>({
  _publicBoundary: [async ({ browser, context, baseURL }, use) => {
    const cleanups = [await installDesignMemoryBoundary(context, baseURL!)];
    const newContext = browser.newContext.bind(browser);
    browser.newContext = async options => {
      const owned = await newContext({ ...options, serviceWorkers: "block" });
      const remove = await installDesignMemoryBoundary(owned, baseURL!);
      let active = true;
      const cleanup = async () => { if (active) { active = false; await remove(); } };
      const close = owned.close.bind(owned);
      owned.close = async options => { try { await cleanup(); } finally { await close(options); } };
      cleanups.push(cleanup);
      return owned;
    };
    try { await use(); } finally {
      browser.newContext = newContext;
      for (const close of cleanups) await close();
    }
  }, { auto: true }]
});
test.use({ serviceWorkers: "block" });

test("manual production contexts report every blocked live channel before closing", async ({ browser, baseURL }) => {
  test.skip(main, "Production strict boundary has no dev HMR exception");
  const context = await browser.newContext({ baseURL, serviceWorkers: "block" });
  const page = await context.newPage();
  try {
    await page.goto("/");
    expect(await page.evaluate(async () => {
      let socket = "sent";
      try { new WebSocket(location.origin.replace("http", "ws")); } catch { socket = "blocked"; }
      return { api: await fetch("/api/task5-unconfigured").then(r => r.status), external: await fetch("https://blocked.invalid/", { method: "POST" }).then(() => "sent", () => "blocked"), socket, beacon: navigator.sendBeacon("https://blocked.invalid/", "fixture") };
    })).toEqual({ api: 404, external: "blocked", socket: "blocked", beacon: false });
    const error = await context.close().then(() => "", error => String(error));
    for (const channel of ["API GET /api/task5-unconfigured", "EXTERNAL POST https://blocked.invalid/", "WebSocket", "sendBeacon"]) expect(error).toContain(channel);
    expect(browser.contexts()).not.toContain(context);
  } finally { if (browser.contexts().includes(context)) await context.close(); }
});

test("production public pages use the selected login mode, preserve contact, and make no API requests", async ({ page }) => {
  const api: string[] = [];
  page.on("request", request => { if (new URL(request.url()).pathname.startsWith("/api/")) api.push(request.url()); });
  for (const path of ["/", "/features", "/pricing"]) {
    expect((await page.goto(path))!.status()).toBe(200);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    expect((await page.reload())!.status()).toBe(200);
    if (service) await expect(page.getByRole("link", { name: /로그인/ })).toHaveAttribute("href", "/login");
    else await expect(page.getByRole("button", { name: "준비 중", exact: true })).toBeDisabled();
    await page.getByRole("button", { name: /도입 상담/ }).first().click();
    const dialog = page.getByRole("dialog", { name: "도입 상담" });
    await expect(dialog.getByRole("link", { name: "032-528-2953" })).toHaveAttribute("href", "tel:0325282953");
    await expect(dialog.getByRole("link", { name: "kymkjh2002@dfkorealed.com" })).toHaveAttribute("href", "mailto:kymkjh2002@dfkorealed.com");
    await expect(dialog.locator("form,input,textarea,select")).toHaveCount(0);
    await expect(dialog).toHaveCSS("padding", "20px");
    await page.keyboard.press("Escape");
  }
  expect(api).toEqual([]);
});

test("public consultation has a real 44px touch target and restores focus after closing", async ({ browser, baseURL }) => {
  for (const width of [320, 390]) {
    const context = await browser.newContext({ baseURL, viewport: { width, height: width === 320 ? 600 : 844 }, isMobile: true, hasTouch: true, serviceWorkers: "block" });
    try {
      const page = await context.newPage();
      for (const path of ["/", "/features", "/pricing"]) {
        await page.goto(path);
        const opener = page.getByRole("button", { name: "도입 상담", exact: true }).first();
        const box = (await opener.boundingBox())!;
        expect(box.width).toBeGreaterThanOrEqual(44); expect(box.height).toBeGreaterThanOrEqual(44);
        expect(await opener.evaluate(el => {
          const r = el.getBoundingClientRect();
          return [[4, 4], [r.width - 4, 4], [4, r.height - 4], [r.width - 4, r.height - 4], [r.width / 2, r.height / 2]].every(([x, y]) => { const hit = document.elementFromPoint(r.x + x, r.y + y); return hit === el || !!hit && el.contains(hit); });
        })).toBe(true);
        await opener.tap();
        const close = page.getByRole("button", { name: "상담 팝업 닫기" });
        const closeBox = (await close.boundingBox())!;
        expect(closeBox.width).toBeGreaterThanOrEqual(52); expect(closeBox.height).toBeGreaterThanOrEqual(52);
        await close.tap(); await expect(opener).toBeFocused();
      }
    } finally { await context.close(); }
  }
});

test("unknown, concept, opposite-mode assets and private archive URLs remain real 404", async ({ request, baseURL }) => {
  test.skip(main, "The ordinary Vite entry retains its development fallback");
  // Direct, read-only probes of this owned static origin prove real HTTP status;
  // browser /api routing is intentionally synthetic and cannot prove this.
  expect(new URL(baseURL!).port).toBe("15342");
  for (const path of ["/unknown", "/settings/nope", "/concepts/field-day.html", "/features/", "/published/r1/index.html", "/releases/r1/manifest.json", "/.env", "/.git/config", "/assets/.private.js", `/assets/${service ? "landing" : "service"}/app-12345678.js`, ...(!service ? ["/login", "/monitoring", "/api/auth/me"] : [])]) {
    const response = await request.get(`${baseURL}${path}`);
    expect(response.status(), path).toBe(404);
    expect(await response.text()).toContain("페이지를 찾을 수 없습니다.");
  }
});

test("404 uses canonical CSS and functional roles without JavaScript", async ({ browser, baseURL, request }) => {
  test.skip(main, "Real static 404 is checked against both production modes");
  const context = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 1440, height: 900 }, serviceWorkers: "block" });
  try {
    const page = await context.newPage();
    const response = await page.goto(`${baseURL}/unknown-page`);
    expect(response!.status()).toBe(404);
    await expect(page.getByRole("heading", { level: 1 })).toHaveCSS("font-size", "26px");
    const css = await page.locator('link[rel="stylesheet"]').getAttribute("href");
    expect(css).toMatch(new RegExp(`^/assets/${service ? "service" : "landing"}/.+\\.css$`));
    expect((await request.get(`${baseURL}${css}`)).status()).toBe(200);
    await expect(page.locator("script,style,[style]")).toHaveCount(0);
    for (const width of [320, 390, 1024, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await expect(page.getByRole("heading", { level: 1 })).toHaveCSS("font-size", width < 760 ? "24px" : "26px");
      await expect(page.getByRole("main")).toHaveCSS("gap", "20px");
      await expect(page.getByRole("main")).toHaveCSS("padding", width < 760 ? "16px" : "20px");
      await expect(page.getByText("주소를 확인하거나 킨다 홈으로 이동해 주세요.")).toHaveCSS("font-size", "14px");
      const home = page.getByRole("link", { name: "킨다 홈으로" });
      const box = (await home.boundingBox())!;
      expect(box.width).toBeGreaterThanOrEqual(44); expect(box.height).toBeGreaterThanOrEqual(44);
      expect(await home.evaluate(element => { const r = element.getBoundingClientRect(); return document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) === element; })).toBe(true);
    }
    await page.getByRole("link", { name: "킨다 홈으로" }).focus();
    await page.keyboard.press("Enter"); await expect(page).toHaveURL(`${baseURL}/`);
  } finally { await context.close(); }
});

test("actual private entry keeps bootstrap status, failure and reload on the shared presentation", async ({ browser, baseURL }) => {
  test.skip(!service, "The landing entry must never include mobile bootstrap");
  const context = await browser.newContext({ baseURL, userAgent: "Task5 mock browser LEDControlNative/1", viewport: { width: 390, height: 844 }, serviceWorkers: "block" });
  try {
    const page = await context.newPage();
    await page.clock.install();
    await page.goto("/");
    await expect(page.getByRole("status")).toContainText("앱 연결을 준비하고 있습니다.");
    await expect(page.getByRole("status")).toHaveCSS("gap", "20px");
    await expect(page.getByRole("status")).toHaveCSS("padding", "16px");
    await page.clock.fastForward(10_001);
    const failure = page.getByRole("alert");
    await expect(failure).toContainText("앱 연결을 준비하지 못했습니다. 다시 시도해 주세요.");
    await expect(failure).toHaveCSS("gap", "20px");
    await expect(failure).toHaveCSS("padding", "16px");
    const reconnect = page.getByRole("button", { name: "다시 연결" });
    const box = (await reconnect.boundingBox())!;
    expect(box.width).toBeGreaterThanOrEqual(44); expect(box.height).toBeGreaterThanOrEqual(44);
    await reconnect.click();
    await expect(page.getByRole("status")).toContainText("앱 연결을 준비하고 있습니다.");
  } finally { await context.close(); }
});

test("ordinary entry preserves existing concept archive URLs and local link targets", async ({ page }) => {
  test.skip(!main, "Archives are intentionally excluded from public deployments");
  const paths = ["/concepts/index.html", "/concepts/editorial.html", "/concepts/control-room.html", "/concepts/toss-inspired-landing.html", "/concepts/field-day-design-system.html", "/concepts/field-day.html"];
  for (const path of paths) {
    expect((await page.goto(path))!.status(), path).toBe(200);
    await expect(page).toHaveURL(new RegExp(`${path.replaceAll(".", "\\.")}$`));
  }
  await page.goto("/concepts/index.html");
  const linked = await page.locator("a[href]").evaluateAll(links => links.map(link => new URL((link as HTMLAnchorElement).href).pathname));
  for (const path of ["/concepts/editorial.html", "/concepts/control-room.html", "/concepts/field-day.html"]) expect(linked).toContain(path);
});

for (const width of [320, 390, 1024, 1440, 429, 430, 430.5, 431, 719, 720, 720.5, 721, 1049, 1050, 1050.5, 1051]) {
  test(`public brand and contact at actual CSS width ${width}`, async ({ page }) => {
    const height = width === 320 ? 600 : width === 390 ? 844 : width === 1024 ? 768 : 900;
    await page.setViewportSize({ width: Number.isInteger(width) ? width : width * 2, height: Number.isInteger(width) ? height : 1800 });
    for (const motion of ["no-preference", "reduce"] as const) {
      await page.emulateMedia({ reducedMotion: motion });
      for (const route of ["/", "/features", "/pricing"]) {
        await page.goto(route);
        // Chromium rounds unscaled frame viewports to integers. At zoom:2 the
        // physical frame is integral while its CSS viewport remains fractional;
        // exact-width media matching below verifies this rather than relabeling.
        const target = Number.isInteger(width) ? page : await (async () => {
          await page.evaluate(({ width, route }) => { const frame = document.createElement("iframe"); frame.title = "Fractional viewport"; frame.style.cssText = `position:fixed;inset:0;border:0;width:${width}px;height:900px;z-index:9999;zoom:2`; frame.src = route; document.body.append(frame); }, { width, route });
          const handle = await page.locator('iframe[title="Fractional viewport"]').elementHandle();
          return (await handle!.contentFrame())!;
        })();
        const heading = target.getByRole("heading", { level: 1 }); await expect(heading).toBeVisible();
        const measured = await target.evaluate(width => ({ width: document.documentElement.getBoundingClientRect().width, exact: matchMedia(`(width:${width}px)`).matches, narrow: matchMedia("(max-width:430px)").matches, stack: matchMedia("(max-width:720px)").matches, wide: matchMedia("(max-width:1050px)").matches }), width);
        expect(measured).toEqual({ width, exact: true, narrow: width <= 430, stack: width <= 720, wide: width <= 1050 });
        console.log(JSON.stringify({ entry: main ? "main" : service ? "service" : "landing", route, motion, ...measured }));
        const frame = target.locator(".header-inner");
        await expect(frame).toHaveCSS("min-height", width <= 720 ? "96px" : "82px");
        expect(await target.locator(".header-nav").evaluate(nav => {
          const box = nav.getBoundingClientRect();
          const children = [...nav.children].map(child => child.getBoundingClientRect());
          return children.every((child, index) => child.left >= box.left && child.right <= box.right && child.top >= box.top && child.bottom <= box.bottom && (index === 0 || children[index - 1].right <= child.left));
        }), "Header actions must remain contained and separate after the contact hit correction").toBe(true);
        if (service) await expect(target.getByRole("link", { name: /로그인/ })).toHaveAttribute("href", "/login");
        else await expect(target.getByRole("button", { name: "준비 중", exact: true })).toBeDisabled();
        expect(await target.locator(".landing-page").evaluate(el => getComputedStyle(el).fontFamily)).toMatch(/^Inter,.*Pretendard.*Noto Sans KR/);
        await expect(target.locator("#main")).toHaveCSS("scroll-margin-top", "100px");
        if (route === "/") {
          const expected = width <= 430 ? Math.max(46, Math.min(width * .11, 57)) : width <= 720 ? Math.max(48, Math.min(width * .10, 72)) : Math.max(55, Math.min(width * .053, 78));
          const typography = await heading.evaluate(el => { const css = getComputedStyle(el); return { size: parseFloat(css.fontSize), spacing: parseFloat(css.letterSpacing) }; });
          expect(typography.size).toBeCloseTo(expected, 2);
          await expect(heading).toHaveCSS("font-weight", "850");
          // Chromium serializes CSSOM numbers to six significant digits. Match
          // that serialization of the approved -.085em against actual font-size;
          // this does not round viewport, geometry, hit or contrast thresholds.
          const serializedSpacing = Number((-.085 * typography.size).toPrecision(6));
          expect(typography.spacing).toBe(serializedSpacing);
          console.log(JSON.stringify({ entry: main ? "main" : service ? "service" : "landing", width, motion, typography, approvedSpacing: -.085 * typography.size, serializedSpacing }));
          if (motion === "reduce") expect(await heading.evaluate(el => getComputedStyle(el).animationName)).toBe("none");
        }
        const trigger = route === "/pricing" ? target.getByRole("button", { name: "Plus 도입 상담", exact: true }) : target.getByRole("button", { name: "도입 상담", exact: true }).first();
        await trigger.focus(); await trigger.press("Enter");
        const dialog = target.getByRole("dialog", { name: "도입 상담" }); await expect(dialog).toBeVisible();
        await expect(dialog).toHaveCSS("padding", width < 760 ? "16px" : "20px");
        await expect(dialog.getByRole("link", { name: "032-528-2953" })).toHaveAttribute("href", "tel:0325282953");
        await expect(dialog.getByRole("link", { name: "kymkjh2002@dfkorealed.com" })).toHaveAttribute("href", "mailto:kymkjh2002@dfkorealed.com");
        if (route === "/pricing") await expect(dialog).toContainText("선택한 요금제: Plus");
        await page.keyboard.press("Tab"); expect(await dialog.evaluate(el => el.contains(document.activeElement))).toBe(true);
        await page.keyboard.press("Escape"); await expect(trigger).toBeFocused();
      }
    }
  });
}

test("service direct nested reload enforces session and shows authorization failure without exposing shell", async ({ page }) => {
  test.skip(!service, "Only service includes the existing authenticated application");
  let status = 401;
  let calls = 0;
  await page.route("**/api/**", route => {
    if (!new URL(route.request().url()).pathname.startsWith("/api/")) return route.fallback();
    calls++; return route.fulfill({ status, json: { message: "mock session denied" } });
  });
  for (const path of ["/login", "/statistics/analysis", "/settings/floor-plans/floor-1/edit"]) {
    expect((await page.goto(path))!.status()).toBe(200);
    await expect(page.getByRole("heading", { name: "킨다 로그인" })).toBeVisible();
    expect((await page.reload())!.status()).toBe(200);
    await expect(page.getByRole("heading", { name: "킨다 로그인" })).toBeVisible();
  }
  expect(calls).toBeGreaterThanOrEqual(6);
  status = 403;
  await page.goto("/monitoring");
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(page.getByRole("heading", { name: "킨다 로그인" })).toHaveCount(0);
});

test("service login preserves same-origin credentials and operator role on direct reload at mobile width", async ({ page }) => {
  test.skip(!service, "Only service includes authentication");
  await page.setViewportSize({ width: 390, height: 844 });
  let authenticated = false;
  const user = { id:"operator-public", role:"operator", loginId:"operator", name:"운영자", organizationId:"provider-1", organizationType:"service_provider", status:"active", mustChangePassword:false };
  await page.route("**/api/**", async route => {
    const path = new URL(route.request().url()).pathname;
    if (!path.startsWith("/api/")) return route.fallback();
    if(path === "/api/auth/login") {
      expect(route.request().method()).toBe("POST");
      expect(route.request().postDataJSON()).toMatchObject({loginId:"operator",password:"test-password"});
      authenticated = true;
      return route.fulfill({json:{user},headers:{"Set-Cookie":"session=mock; Path=/; HttpOnly; SameSite=Lax"}});
    }
    if(path === "/api/auth/me") {
      if (authenticated) expect(route.request().headers().cookie).toContain("session=mock");
      return route.fulfill(authenticated ? {json:{user}} : {status:401,json:{message:"Unauthorized"}});
    }
    if(path === "/api/operator/site-admins") return route.fulfill({json:[]});
    return route.fulfill({status:404,json:{message:"Unconfigured mock API"}});
  });
  await page.goto("/login");
  await page.getByLabel("아이디").fill("operator");
  await page.getByLabel("비밀번호", {exact:true}).fill("test-password");
  await page.getByRole("button", {name:"로그인",exact:true}).click();
  await expect(page.getByRole("heading", {name:"현장 관리자 계정"})).toBeVisible();
  expect((await page.reload())!.status()).toBe(200);
  await expect(page.getByRole("heading", {name:"현장 관리자 계정"})).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
