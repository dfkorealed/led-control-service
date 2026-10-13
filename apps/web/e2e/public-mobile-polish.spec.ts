import { expect, test } from "@playwright/test";

for (const width of [320, 390, 504]) {
  test(`mobile ${width}: the full illustration clears both actions and the hero footer`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
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
        footerClearance: footer.top - Math.max(art.bottom, ...pieces.map(piece => piece.bottom)),
        fits: document.documentElement.scrollWidth <= innerWidth
      };
    });
    expect(bounds.clearance).toBeGreaterThanOrEqual(32);
    expect(bounds.footerClearance).toBeGreaterThanOrEqual(32);
    expect(bounds.fits).toBe(true);
    if (width === 504) await page.screenshot({ path: ".local/mobile-polish-504.png", fullPage: false });
  });
}

test("keyboard previews change the pin and graph without remounting the focused control; reduced motion is static", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  const art = page.locator(".hero-art");
  const initialBars = await art.locator(".hero-art__bar").evaluateAll(bars => bars.map(bar => (bar as HTMLElement).style.height));
  const initialPin = await art.locator(".hero-art__pin").getAttribute("style");
  const control = page.getByRole("button", { name: "제어 미리보기" });
  await control.focus();
  await page.keyboard.press("Enter");
  await expect(control).toHaveAttribute("aria-pressed", "true");
  await expect(control).toBeFocused();
  await expect(art).toHaveAttribute("data-preview", "CONTROL");
  expect(await art.locator(".hero-art__bar").evaluateAll(bars => bars.map(bar => (bar as HTMLElement).style.height))).not.toEqual(initialBars);
  expect(await art.locator(".hero-art__pin").getAttribute("style")).not.toBe(initialPin);
  expect(await art.evaluate(node => [...node.querySelectorAll("*")].every(child => getComputedStyle(child).animationName === "none" && parseFloat(getComputedStyle(child).transitionDuration) <= .00001))).toBe(true);
  const stage = art.locator(".hero-art__stage");
  const bounds = (await stage.boundingBox())!;
  await page.mouse.move(bounds.x + bounds.width * .8, bounds.y + bounds.height * .3);
  expect(await stage.evaluate(node => node.style.getPropertyValue("--hero-depth-x"))).toBe("0px");
});

test.describe("touch", () => {
  test.use({ hasTouch: true, viewport: { width: 390, height: 844 } });
  test("touch changes previews, preserves native scrolling, and keeps the email popup usable with focus return", async ({ page }) => {
    const api: string[] = [];
    page.on("request", request => { if (new URL(request.url()).pathname.startsWith("/api/")) api.push(request.url()); });
    await page.goto("/");
    await page.getByRole("button", { name: "통계 미리보기" }).tap();
    await expect(page.locator(".hero-art")).toHaveAttribute("data-preview", "STATISTICS");
    const stage = page.locator(".hero-art__stage");
    expect(await stage.evaluate(node => getComputedStyle(node).touchAction)).toBe("auto");
    await page.evaluate(() => scrollTo(0, 180));
    expect(await page.evaluate(() => scrollY)).toBeGreaterThan(0);
    const trigger = page.locator(".hero-contact");
    await trigger.tap();
    const dialog = page.getByRole("dialog", { name: "도입 상담" });
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
  });
});

test("desktop mouse adds shallow depth, resets on leave and cancels off-screen; the hero animation replays on return", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/");
  // Selection must remain legible under hover, including touch browsers that retain hover after a tap.
  const selectedBackground = await page.locator(".hero-art__bar.bg-brand-coral").first().evaluate(node => getComputedStyle(node).backgroundColor);
  for (const label of ["모니터링", "제어", "통계"]) {
    const preview = page.getByRole("button", { name: `${label} 미리보기` });
    await preview.hover();
    await preview.click();
    await expect(preview).toHaveAttribute("aria-pressed", "true");
    await expect(preview).toHaveCSS("background-color", selectedBackground);
    const contrast = await preview.evaluate(node => {
      const luminance = (color: string) => {
        const channels = color.match(/[\d.]+/g)!.slice(0, 3).map(value => Number(value) / 255);
        const linear = channels.map(channel => channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4);
        return linear[0] * .2126 + linear[1] * .7152 + linear[2] * .0722;
      };
      const style = getComputedStyle(node);
      const foreground = luminance(style.color), background = luminance(style.backgroundColor);
      return (Math.max(foreground, background) + .05) / (Math.min(foreground, background) + .05);
    });
    expect(contrast).toBeGreaterThanOrEqual(4.5);
  }
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
