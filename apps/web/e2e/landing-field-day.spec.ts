import { expect, test } from "@playwright/test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

test("public landing follows the approved five scenes without auth", async ({ page }) => {
  const auth: string[] = [];
  page.on("request", request => { if (request.url().includes("/api/auth/me")) auth.push(request.url()); });
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: /현장의 하루.*한눈에 이어지다/ })).toBeVisible();
  for (const [id, name] of [
    ["monitoring", /찾는 조명은.*도면 위에/], ["control", /필요한 만큼.*밝기를 맞추다/],
    ["statistics", /운영의 흐름을.*그래프로 보다/], ["report", /정리한 기록을.*보고서로/],
    ["map-editor", /도면도 조명도.*직접, 쉽게 배치/]
  ] as const) await expect(page.locator(`#${id}`).getByRole("heading", { name })).toBeVisible();
  await expect(page.getByRole("link", { name: /로그인/ })).toHaveAttribute("href", "/login");
  expect(auth).toEqual([]);
});

test("hero contact is borderless and header opens separate public pages", async ({ page }) => {
  await page.goto("/");
  const heroContact = page.locator(".hero-contact");
  await expect(heroContact).toHaveCSS("border-top-width", "0px");
  await expect(heroContact).toHaveCSS("border-bottom-width", "0px");
  for (const [label, path] of [["주요 기능", "/features"], ["요금제", "/pricing"]] as const) {
    await page.getByRole("link", { name: label, exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`${path}$`));
    await expect(page.locator(".site-header")).toBeVisible();
  }
});

test("features and pricing are public on direct load, reload, and browser history", async ({ page }) => {
  const auth: string[] = [];
  page.on("request", request => { if (request.url().includes("/api/auth/me")) auth.push(request.url()); });
  await page.goto("/features");
  await expect(page).toHaveTitle("주요 기능 | 킨다");
  await expect(page.getByRole("heading", { level: 1, name: "현장 운영에 필요한 네 가지 흐름" })).toBeVisible();
  for (const id of ["monitoring", "control", "statistics", "map-editor"]) {
    await expect(page.locator(`#feature-${id}`).getByRole("heading")).toBeVisible();
    await expect(page.locator(`#feature-${id} .feature-detail__preview`)).toBeVisible();
  }
  await page.reload();
  await expect(page.getByRole("heading", { level: 1, name: "현장 운영에 필요한 네 가지 흐름" })).toBeVisible();
  await page.getByRole("link", { name: "요금제", exact: true }).click();
  await expect(page).toHaveURL(new RegExp("/pricing$"));
  await expect(page).toHaveTitle("요금제 | 킨다");
  await expect(page.getByRole("heading", { level: 1, name: "현장에 맞는 운영 방식을 선택하세요." })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("button", { name: "Plus 도입 상담" })).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(new RegExp("/features$"));
  expect(auth).toEqual([]);
});

for (const width of [320, 390]) {
  test(`new public pages remain readable at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 840 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    for (const path of ["/features", "/pricing"]) {
      await page.goto(path);
      await expect(page.getByRole("main")).toBeVisible();
      await expect(page.getByRole("contentinfo").getByText("(주)디에프코리아")).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.getByRole("link", { name: "주요 기능", exact: true }).focus();
      await expect(page.getByRole("link", { name: "주요 기능", exact: true })).toBeFocused();
    }
  });
}

test("features and pricing have no serious accessibility violations", async ({ page }) => {
  for (const width of [320, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    for (const path of ["/features", "/pricing"]) {
      await page.goto(path);
      await page.addScriptTag({ path: require.resolve("axe-core/axe.min.js") });
      const violations = await page.evaluate(async () => {
        const axe = (window as unknown as { axe: { run(): Promise<{ violations: { id: string; impact: string; nodes: { target: string[] }[] }[] }> } }).axe;
        return (await axe.run()).violations.filter(item => item.impact === "serious" || item.impact === "critical")
          .map(item => ({ id: item.id, targets: item.nodes.map(node => node.target) }));
      });
      expect(violations, `${path} at ${width}px`).toEqual([]);
    }
  }
});

test("feature and pricing sections each fill at least one viewport", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1200 });
  for (const [path, id] of [["/features", "features"], ["/pricing", "pricing"]] as const) {
    await page.goto(path);
    const height = await page.locator(`#${id}`).evaluate(element => element.getBoundingClientRect().height);
    expect(height).toBeGreaterThanOrEqual(1200);
  }
});

test("scene examples respond to controls and replay on return", async ({ page }) => {
  await page.goto("/");
  await page.locator("#monitoring").scrollIntoViewIfNeeded();
  await page.getByRole("button", { name: "주차 구역 조명 04 선택" }).click();
  await expect(page.locator("#monitoring").getByRole("status")).toContainText("주차 구역 조명 04");
  await page.locator("#control").scrollIntoViewIfNeeded();
  const slider = page.getByRole("slider", { name: "출입구 그룹 밝기" });
  await slider.click({ position: { x: 80, y: 4 } });
  const manualValue = await slider.inputValue();
  expect(Number(manualValue)).toBeGreaterThan(25);
  await expect(page.locator("#control").getByRole("status")).toContainText(`${manualValue}%`);
  await page.waitForTimeout(250);
  await expect(slider).toHaveValue(manualValue);
  await page.getByRole("button", { name: /밝기 적용/ }).click();
  await expect(page.locator("#control").getByRole("status")).toContainText(`${manualValue}%`);
  await page.locator("#report").scrollIntoViewIfNeeded();
  await page.getByRole("button", { name: "XLSX" }).click();
  await expect(page.locator("#report").getByRole("status")).toContainText("XLSX");
  await expect(page.locator("#report").getByRole("button", { name: "CSV" })).toHaveCount(0);
  await page.locator("#map-editor").scrollIntoViewIfNeeded();
  await page.getByRole("button", { name: "조명 배치" }).click();
  await expect(page.locator("#map-editor").getByText("배치된 조명 3개")).toBeVisible();
  await page.getByRole("button", { name: "배치 취소" }).click();
  await expect(page.locator("#map-editor").getByText("배치된 조명 2개")).toBeVisible();
});

test("consultation opens in a modal on the same URL", async ({ page }) => {
  await page.goto("/");
  const initialUrl = page.url();
  const triggers = [
    page.getByRole("button", { name: "도입 상담", exact: true }).first(),
    page.getByRole("button", { name: "도입 상담", exact: true }).last(),
    page.getByRole("button", { name: "도입 상담하기", exact: true })
  ];
  for (const trigger of triggers) {
    await trigger.click();
    await expect(page.getByRole("dialog", { name: "도입 상담" })).toBeVisible();
    await expect(page.getByRole("textbox", { name: "회사명" })).toBeVisible();
    expect(page.url()).toBe(initialUrl);
    await page.getByRole("button", { name: "상담 팝업 닫기" }).click();
    await expect(page.getByRole("dialog", { name: "도입 상담" })).toHaveCount(0);
    await expect(trigger).toBeFocused();
  }
});

test("pricing cards open consultation and return focus to the selected plan", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/pricing");
  await expect(page.locator("#pricing")).toBeInViewport();
  for (const plan of ["Basic", "Plus"]) {
    const opener = page.getByRole("button", { name: `${plan} 도입 상담` });
    await opener.click();
    await expect(page.getByRole("dialog", { name: "도입 상담" })).toBeVisible();
    await page.getByRole("button", { name: "상담 팝업 닫기" }).click();
    await expect(opener).toBeFocused();
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("plan inquiry keeps the selected plan in editable copy and the submitted message", async ({ page }) => {
  const posted: Record<string, unknown>[] = [];
  await page.route("**/api/landing/inquiries", async route => {
    posted.push(route.request().postDataJSON());
    await route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify({ reference: "KI-PLAN", status: "received" }) });
  });
  await page.goto("/pricing");
  await page.getByRole("button", { name: "Basic 도입 상담" }).click();
  const dialog = page.getByRole("dialog", { name: "도입 상담" });
  await expect(dialog.getByText("선택한 요금제: Basic")).toBeVisible();
  const message = dialog.getByRole("textbox", { name: "문의 내용" });
  await expect(message).toHaveValue("Basic 요금제 도입 상담을 받고 싶습니다.");
  await dialog.getByRole("button", { name: "상담 팝업 닫기" }).click();
  await page.getByRole("button", { name: "Plus 도입 상담" }).click();
  await expect(dialog.getByText("선택한 요금제: Plus")).toBeVisible();
  await expect(message).toHaveValue("Plus 요금제 도입 상담을 받고 싶습니다.");
  await message.fill("설치 규모를 상담받고 싶습니다.");
  await dialog.getByRole("textbox", { name: "회사명" }).fill("설비 주식회사");
  await dialog.getByRole("textbox", { name: "담당자 이름" }).fill("김담당");
  await dialog.getByRole("textbox", { name: "회신 이메일" }).fill("manager@example.com");
  await dialog.getByRole("checkbox", { name: /개인정보 수집·이용에 동의/ }).press("Space");
  await dialog.getByRole("button", { name: "상담 문의 보내기" }).click();
  await expect(dialog.getByText(/KI-PLAN/)).toBeVisible();
  expect(posted).toHaveLength(1);
  expect(posted[0].message).toBe("선택한 요금제: Plus\n설치 규모를 상담받고 싶습니다.");
  await dialog.getByRole("button", { name: "상담 팝업 닫기" }).click();
  await page.getByRole("button", { name: "도입 상담", exact: true }).first().click();
  await expect(dialog.getByRole("textbox", { name: "문의 내용" })).toBeEmpty();
  await expect(dialog.getByText(/선택한 요금제:/)).toHaveCount(0);
});

test("a scene replays on return and reduced motion settles to its final state", async ({ page }) => {
  await page.goto("/");
  const monitoring = page.locator("#monitoring");
  for (const id of ["monitoring", "control", "statistics", "report", "map-editor"]) {
    const scene = page.locator(`#${id}`);
    await scene.scrollIntoViewIfNeeded();
    await expect(scene).toHaveClass(/is-playing/);
  }
  await page.locator("#map-editor").scrollIntoViewIfNeeded();
  await monitoring.scrollIntoViewIfNeeded();
  await expect(monitoring).toHaveClass(/is-playing/);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.locator("#report").scrollIntoViewIfNeeded();
  await monitoring.scrollIntoViewIfNeeded();
  await expect(monitoring).toHaveClass(/is-complete/);
  await expect(monitoring.getByRole("button", { name: "통로 조명 02 선택" })).toHaveAttribute("aria-pressed", "true");
});

test("map tool drops a fixture and the placed fixture moves", async ({ page }) => {
  await page.goto("/");
  const scene = page.locator("#map-editor");
  await scene.scrollIntoViewIfNeeded();
  const tool = page.getByRole("button", { name: "조명 배치" });
  const canvas = scene.locator(".map-canvas");
  await tool.dragTo(canvas, { targetPosition: { x: 160, y: 120 }, sourcePosition: { x: 35, y: 18 } });
  await expect(scene.getByText("배치된 조명 3개")).toBeVisible();
  const marker = scene.getByRole("button", { name: "배치한 조명 이동" });
  await expect(marker).not.toHaveClass(/is-auto-moving/);
  const before = await marker.evaluate(element => getComputedStyle(element).left);
  await marker.focus();
  await page.keyboard.press("ArrowRight");
  await expect.poll(() => marker.evaluate(element => getComputedStyle(element).left)).not.toBe(before);
  await expect(scene.getByRole("status")).toContainText("위치를 조정");
  await marker.dragTo(canvas, { targetPosition: { x: 210, y: 145 } });
  await expect(scene.getByRole("status")).toContainText("위치를 조정");
});

test("map replay animates the placed fixture through an intermediate position", async ({ page }) => {
  await page.goto("/");
  const scene = page.locator("#map-editor");
  await scene.scrollIntoViewIfNeeded();
  await scene.getByRole("button", { name: "맵 편집 예시 다시 보기" }).click();
  const marker = scene.getByRole("button", { name: "배치한 조명 이동" });
  await expect(marker).toBeVisible();
  await expect(marker).toHaveClass(/is-auto-moving/);
  await expect(marker).toHaveCSS("touch-action", "none");
  const positions = await marker.evaluate(async element => {
    const readings: number[] = [];
    const until = performance.now() + 1150;
    while (performance.now() < until) {
      readings.push(parseFloat(getComputedStyle(element).left));
      await new Promise(requestAnimationFrame);
    }
    return readings;
  });
  const min = Math.min(...positions);
  const max = Math.max(...positions);
  expect(max - min).toBeGreaterThan(15);
  expect(positions.some(value => value > min + 4 && value < max - 4)).toBe(true);
});

test("a touch gesture can reposition a placed map fixture", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  try {
    await page.goto("/");
    const scene = page.locator("#map-editor");
    await scene.scrollIntoViewIfNeeded();
    await scene.getByRole("button", { name: "조명 배치" }).click();
    const marker = scene.getByRole("button", { name: "배치한 조명 이동" });
    await expect(marker).toBeVisible();
    const before = await marker.evaluate(element => getComputedStyle(element).left);
    const bounds = await marker.boundingBox();
    const canvas = await scene.locator(".map-canvas").boundingBox();
    expect(bounds).not.toBeNull();
    expect(canvas).not.toBeNull();
    if (!bounds || !canvas) return;
    const start = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
    const finish = { x: canvas.x + canvas.width * .45, y: canvas.y + canvas.height * .45 };
    const client = await context.newCDPSession(page);
    await client.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [start] });
    await client.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [finish] });
    await client.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await expect.poll(() => marker.evaluate(element => getComputedStyle(element).left)).not.toBe(before);
    await expect(scene.getByRole("status")).toContainText("위치를 조정");
  } finally {
    await context.close();
  }
});

test("pending consultation keeps focus and blocks dismissal until the response", async ({ page }) => {
  let accept!: () => void;
  const release = new Promise<void>(resolve => { accept = resolve; });
  const posted: unknown[] = [];
  await page.route("**/api/landing/inquiries", async route => {
    posted.push(route.request().postDataJSON());
    await release;
    await route.fulfill({ status: 201, json: { reference: "KI-FOCUS", status: "received" } });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "도입 상담", exact: true }).first().click();
  const dialog = page.getByRole("dialog", { name: "도입 상담" });
  await dialog.getByRole("textbox", { name: "회사명" }).fill("시설 관리사");
  await dialog.getByRole("textbox", { name: "담당자 이름" }).fill("홍길동");
  await dialog.getByRole("textbox", { name: "회신 이메일" }).fill("buyer@example.com");
  await dialog.getByRole("textbox", { name: "문의 내용" }).fill("조명 관제 도입 상담");
  await dialog.getByRole("checkbox", { name: /개인정보 수집·이용에 동의/ }).press("Space");
  const submit = dialog.getByRole("button", { name: "상담 문의 보내기" });
  await submit.click();
  await expect(dialog.getByRole("status")).toContainText("접수하고 있습니다");
  await expect(dialog.getByRole("button", { name: "접수 중" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Enter");
  expect(posted).toHaveLength(1);
  accept();
  await expect(dialog.getByText(/KI-FOCUS/)).toBeVisible();
  await expect(dialog.getByRole("link", { name: "이메일로 직접 문의하기" })).toHaveCount(0);
});

test("legacy contact bookmark opens the modal and clears the old fragment", async ({ page }) => {
  await page.goto("/#contact");
  await expect(page.getByRole("dialog", { name: "도입 상담" })).toBeVisible();
  await expect(page).toHaveURL(/\/$/);
});

test("legacy contact fragment clears a previously selected plan", async ({ page }) => {
  await page.goto("/pricing");
  await page.getByRole("button", { name: "Plus 도입 상담" }).click();
  const dialog = page.getByRole("dialog", { name: "도입 상담" });
  await expect(dialog.getByText("선택한 요금제: Plus")).toBeVisible();
  await dialog.getByRole("button", { name: "상담 팝업 닫기" }).click();
  await page.evaluate(() => { window.location.hash = "contact"; });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText(/선택한 요금제:/)).toHaveCount(0);
  await expect(dialog.getByRole("textbox", { name: "문의 내용" })).toBeEmpty();
});


test("hero animation restarts on return and reduced motion leaves the complete artwork", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto("/");
  const pointer = page.locator(".hero-art__pointer");
  await expect(pointer).toHaveCSS("animation-name", "hero-pointer-drift");
  await expect(page.locator(".hero-art__panel--front b").nth(5)).toHaveCSS("animation-delay", "0.75s");
  await page.locator("#map-editor").scrollIntoViewIfNeeded();
  await expect(pointer).toHaveCSS("animation-name", "none");
  await page.evaluate(() => scrollTo(0, 0));
  await expect(pointer).toHaveCSS("animation-name", "hero-pointer-drift");
  await expect.poll(() => pointer.evaluate(element => element.getAnimations().some(animation => Number(animation.currentTime) < 1000))).toBe(true);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(pointer).toHaveCSS("animation-name", "none");
  await expect(pointer).toHaveCSS("transform", "none");
  for (const bar of await page.locator(".hero-art__panel--front b").all()) {
    await expect(bar).toHaveCSS("opacity", "1");
    await expect(bar).toHaveCSS("transform", "none");
  }
});

test("public shell and hero preserve all three inclusive layout boundaries", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  for (const width of [429, 430, 431, 719, 720, 721, 1049, 1050, 1051]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/");
    await expect(page.locator(".header-nav")).toHaveCSS("font-size", width <= 430 ? "11px" : width <= 720 ? "12px" : "13px");
    await expect(page.locator(".hero")).toHaveCSS("min-height", width <= 430 ? "760px" : width <= 720 ? "790px" : "900px");
    const columns = await page.locator(".hero-inner").evaluate(element => getComputedStyle(element).gridTemplateColumns.split(" ").map(Number.parseFloat));
    expect(columns).toHaveLength(width <= 720 ? 1 : 2);
    if (width > 720) expect(columns[0] / columns[1]).toBeCloseTo(width <= 1050 ? 1.25 : 1.08 / .92, 2);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
});


test("landing button hover keeps its original transform transition", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto("/");
  const cta = page.getByRole("link", { name: /하루 따라가기/ });
  await expect(cta).toHaveCSS("transition-property", "transform, background, border-color");
  await expect(cta).toHaveCSS("transition-duration", "0.2s");
  await cta.hover();
  await expect(cta).toHaveCSS("transform", "matrix(1, 0, 0, 1, 0, -2)");
  await expect(cta).toHaveCSS("background-color", "rgb(255, 255, 255)");
});

test("hero keyboard re-entry preserves inquiry and CTA nodes and focus", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto("/");
  const pointer = page.locator(".hero-art__pointer");
  const contact = page.locator(".hero-contact");
  const cta = page.getByRole("link", { name: /하루 따라가기/ });
  await expect(pointer).toHaveCSS("animation-name", "hero-pointer-drift");
  const contactNode = await contact.elementHandle();
  const ctaNode = await cta.elementHandle();
  expect(contactNode).not.toBeNull();
  expect(ctaNode).not.toBeNull();
  const artStyles = () => page.locator(".hero-art, .hero-art__ring, .hero-art__panel, .hero-art__pointer").evaluateAll(elements => elements.map(element => {
    const style = getComputedStyle(element);
    return { width: style.width, height: style.height, backgroundImage: style.backgroundImage, borderRadius: style.borderRadius, clipPath: style.clipPath };
  }));
  const originalArtStyles = await artStyles();

  const monitoring = page.locator("#monitoring");
  await monitoring.scrollIntoViewIfNeeded();
  await expect(monitoring).toHaveClass(/is-playing/);
  const replay = page.getByRole("button", { name: "모니터링 예시 다시 보기" });
  await replay.focus();
  await page.locator("#map-editor").scrollIntoViewIfNeeded();
  await expect(replay).toBeFocused();
  await expect(pointer).toHaveCSS("animation-name", "none");
  await page.keyboard.press("Shift+Tab");
  await expect(pointer).toHaveCSS("animation-name", "hero-pointer-drift");
  await expect(contact).toBeFocused();
  expect(await contactNode!.evaluate(element => element.isConnected && element === document.activeElement)).toBe(true);
  await page.keyboard.press("Shift+Tab");
  await expect(cta).toBeFocused();
  expect(await ctaNode!.evaluate(element => element.isConnected && element === document.activeElement)).toBe(true);
  expect(await artStyles()).toEqual(originalArtStyles);
});

test("feature and pricing preserve preview geometry and inclusive page boundaries", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  for (const width of [320, 390, 1024, 1440, 429, 430, 431, 719, 720, 721, 1049, 1050, 1051]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/features");
    await expect(page.locator("#features-title")).toHaveCSS("font-weight", "400");
    await expect(page.locator("#feature-monitoring h2")).toHaveCSS("font-weight", "400");
    const preview = page.locator("#features .feature-preview").first();
    await expect(preview).toHaveAttribute("aria-hidden", "true");
    await expect(preview).toHaveCSS("width", `${width <= 430 ? 100 : width <= 720 ? 145 : width <= 1050 ? 130 : 172}px`);
    await expect(preview).toHaveCSS("height", `${width <= 430 ? 118 : width <= 720 ? 145 : width <= 1050 ? 130 : 172}px`);
    await expect(preview).toHaveCSS("border-radius", "18px");
    const expanded = page.locator("#feature-monitoring .feature-preview");
    await expect(expanded).toHaveCSS("height", `${width <= 430 ? 220 : width <= 720 ? 270 : 330}px`);
    await expect(page.locator("#feature-monitoring")).toHaveCSS("scroll-margin-top", "100px");
    await page.getByRole("link", { name: "모니터링 자세히 보기" }).click();
    await expect(page).toHaveURL(/#feature-monitoring$/);
    await expect(page.locator("#feature-monitoring")).toBeInViewport();
    await page.goto("/pricing");
    await expect(page.locator("#pricing-title")).toHaveCSS("font-weight", "400");
    for (const plan of ["Basic", "Plus"]) {
      const button = page.getByRole("button", { name: `${plan} 도입 상담` });
      await expect(button).toHaveCSS("min-height", "48px");
      await expect(button).toHaveCSS("font-size", "14px");
      await expect(button).toHaveCSS("line-height", "16.8px");
      await expect(button).toHaveCSS("border-radius", "12px");
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
});

test("pricing buttons retain transform transition and plan selection during hover", async ({ page }) => {
  await page.goto("/pricing");
  for (const plan of ["Basic", "Plus"]) {
    const button = page.getByRole("button", { name: `${plan} 도입 상담` });
    await expect(button).toHaveCSS("transition-property", "transform, background, border-color");
    expect(await button.evaluate(element => getComputedStyle(element).transitionDuration.split(", ").every(duration => duration === "0.2s"))).toBe(true);
    expect(await button.evaluate(element => getComputedStyle(element).transitionTimingFunction.split(", ").every(timing => timing === "ease"))).toBe(true);
    await button.hover();
    await expect(button).toHaveCSS("transform", "matrix(1, 0, 0, 1, 0, -2)");
    await button.click();
    await expect(page.getByRole("dialog").getByText(`선택한 요금제: ${plan}`)).toBeVisible();
    await page.getByRole("button", { name: "상담 팝업 닫기" }).click();
    await expect(button).toBeFocused();
  }
});
