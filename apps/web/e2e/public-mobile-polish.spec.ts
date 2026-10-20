import { expect, test } from "@playwright/test";

for (const width of [320, 390, 504]) {
  test(`mobile ${width}: the full illustration clears both actions and the hero footer`, async ({ page }) => {
    // Keep the release contract at six cases while covering the reported 627px viewport
    // and both sides of the 720px stacked-layout breakpoint in the widest mobile case.
    for (const viewportWidth of width === 504 ? [504, 627, 720, 721, 768] : [width]) {
      await page.setViewportSize({ width: viewportWidth, height: 844 });
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.goto("/");
      const bounds = await page.locator("#top").evaluate(hero => {
        const rectangle = (selector: string) => hero.querySelector(selector)!.getBoundingClientRect();
        const actions = rectangle(".hero-actions");
        const art = rectangle(".hero-art");
        const pieces = [".hero-art__ring", ".hero-art__panel--back", ".hero-art__panel--front"].map(rectangle);
        const footer = rectangle(".hero-footer");
        return {
          clearance: Math.min(art.top, ...pieces.map(piece => piece.top)) - actions.bottom,
          actionsOverlap: [art, ...pieces].some(piece => piece.left < actions.right && piece.right > actions.left && piece.top < actions.bottom && piece.bottom > actions.top),
          footerClearance: footer.top - Math.max(art.bottom, ...pieces.map(piece => piece.bottom)),
          fits: document.documentElement.scrollWidth <= innerWidth
        };
      });
      if (viewportWidth <= 720) expect(bounds.clearance, `CTA/art clearance at ${viewportWidth}px`).toBeGreaterThanOrEqual(56);
      expect(bounds.actionsOverlap, `CTA/art overlap at ${viewportWidth}px`).toBe(false);
      expect(bounds.footerClearance).toBeGreaterThanOrEqual(32);
      expect(bounds.fits).toBe(true);
      if (viewportWidth === 504) await page.screenshot({ path: ".local/mobile-polish-504.png", fullPage: false });
    }
    for (const viewportWidth of width === 504 ? [504, 637, 720, 721, 768, 1440] : [width]) {
      await page.setViewportSize({ width: viewportWidth, height: 1226 });
      for (const [route, kicker] of [["/features", "KINDA / FEATURES"], ["/pricing", "KINDA / PLANS"]]) {
        await page.goto(route);
        const intro = page.getByText(kicker, { exact: true });
        const headerBottom = await page.locator(".site-header").evaluate(node => node.getBoundingClientRect().bottom);
        expect((await intro.boundingBox())!.y - headerBottom, `${route} kicker/header clearance at ${viewportWidth}px`).toBeGreaterThanOrEqual(32);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        if (viewportWidth === 637) await page.screenshot({ path: `.local/inner-page-${route.slice(1)}-637.png` });
      }
    }
    await page.goto("/features#feature-control");
    await expect.poll(() => page.locator("#feature-control").evaluate(node => node.getBoundingClientRect().top)).toBeGreaterThanOrEqual(80);
    expect((await page.locator("#feature-control").boundingBox())!.y).toBeLessThan(160);
  });
}

test("reduced motion keeps the hero illustration and mouse depth static", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  const art = page.locator(".hero-art");
  expect(await art.evaluate(node => [...node.querySelectorAll("*")].every(child => getComputedStyle(child).animationName === "none" && parseFloat(getComputedStyle(child).transitionDuration) <= .00001))).toBe(true);
  const stage = art.locator(".hero-art__stage");
  const bounds = (await stage.boundingBox())!;
  await page.mouse.move(bounds.x + bounds.width * .8, bounds.y + bounds.height * .3);
  expect(await stage.evaluate(node => node.style.getPropertyValue("--hero-depth-x"))).toBe("0px");
});

test.describe("touch", () => {
  test.use({ hasTouch: true, viewport: { width: 390, height: 844 } });
  test("touch preserves native scrolling and keeps the email popup usable with focus return", async ({ page }) => {
    const api: string[] = [];
    page.on("request", request => { if (new URL(request.url()).pathname.startsWith("/api/")) api.push(request.url()); });
    await page.goto("/");
    const stage = page.locator(".hero-art__stage");
    expect(await stage.evaluate(node => getComputedStyle(node).touchAction)).toBe("auto");
    await page.evaluate(() => scrollTo(0, 180));
    expect(await page.evaluate(() => scrollY)).toBeGreaterThan(0);
    const trigger = page.locator(".hero-contact");
    await trigger.tap();
    const dialog = page.getByRole("dialog", { name: "도입 상담" });
    const card = dialog.getByLabel("이메일 도입 상담");
    await expect(dialog.locator("[data-dialog-header]")).toHaveCount(0);
    await expect(card.getByRole("button", { name: "상담 팝업 닫기" })).toBeVisible();
    await expect(card.getByRole("button", { name: "상담 팝업 닫기" })).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    await expect(card.getByRole("button", { name: "상담 팝업 닫기" })).toHaveCSS("color", "rgb(255, 255, 255)");
    await expect(card).toHaveCSS("background-color", "rgb(21, 50, 74)");
    await expect(dialog).toHaveCSS("padding", "0px");
    await expect(dialog).toHaveCSS("border-width", "0px");
    await expect(dialog).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    await expect(dialog.locator('a[href^="tel:"]')).toHaveCount(0);
    await expect(dialog.getByRole("link", { name: "이메일로 상담하기" })).toBeVisible();
    await expect(dialog.getByRole("link", { name: "이메일로 상담하기" })).toHaveAttribute("href", "mailto:kymkjh2002@dfkorealed.com");
    await page.screenshot({ path: ".local/contact-polish-390.png", fullPage: false });
    const focusable = dialog.locator('button, a[href]');
    await focusable.last().focus();
    await page.keyboard.press("Tab");
    await expect(focusable.first()).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await expect(page.getByRole("contentinfo").getByRole("link", { name: "032-528-2953" })).toHaveAttribute("href", "tel:0325282953");
    await expect(page.getByRole("contentinfo").getByRole("navigation", { name: "회사 페이지" })).toHaveCount(0);
    expect(api).toEqual([]);
    await page.goto("/pricing");
    for (const plan of ["Basic"]) {
      const planTrigger = page.getByRole("button", { name: `${plan} 도입 상담` });
      await planTrigger.tap();
      await expect(dialog.getByLabel("이메일 도입 상담").getByText(`선택한 요금제: ${plan}`)).toBeVisible();
      await dialog.getByRole("button", { name: "상담 팝업 닫기" }).tap();
      await expect(planTrigger).toBeFocused();
    }
  });
});

test("desktop mouse adds shallow depth, resets on leave and cancels off-screen; the hero animation replays on return", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/");
  await page.mouse.move(2, 2);
  const stage = page.locator(".hero-art__stage");
  const ring = page.locator(".hero-art__ring");
  await expect(ring).toHaveClass(/animate-landing-hero-ring/);
  const bounds = (await stage.boundingBox())!;
  await page.mouse.move(bounds.x + bounds.width * .8, bounds.y + bounds.height * .3);
  await expect.poll(() => stage.evaluate(node => node.style.getPropertyValue("--hero-depth-x"))).not.toBe("");
  expect(Math.abs(parseFloat(await stage.evaluate(node => node.style.getPropertyValue("--hero-depth-x"))))).toBeLessThanOrEqual(6);
  await page.mouse.move(2, 2);
  await expect.poll(() => stage.evaluate(node => node.style.getPropertyValue("--hero-depth-x"))).toBe("0px");
  await page.locator("#control").scrollIntoViewIfNeeded();
  await expect(ring).not.toHaveClass(/animate-landing-hero-ring/);
  expect(await page.locator(".hero-art__pin > span").evaluate(node => getComputedStyle(node).animationName)).toBe("none");
  await page.evaluate(() => scrollTo(0, 0));
  await expect(ring).toHaveClass(/animate-landing-hero-ring/);
});
