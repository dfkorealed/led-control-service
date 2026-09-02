import { expect, type Page } from "@playwright/test";

const interactiveTargetSelector = [
  "button",
  "a[href]",
  "input:not([type='hidden'])",
  "select",
  "textarea",
  "[role='button']",
  "[role='link']",
  "[role='tab']",
  "[role='menuitem']",
  "[role='checkbox']",
  "[role='radio']",
  "[role='switch']",
  "[role='option']",
  "[tabindex]:not([tabindex='-1'])"
].join(",");

export async function expectNoHorizontalOverflow(page: Page) {
  const metrics = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth
  }));

  expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.clientWidth + 1);
}

export async function expectMinimumTouchTargets(
  page: Page,
  rootSelector: string,
  { excludeSpatialMapMarkers = false }: { excludeSpatialMapMarkers?: boolean } = {}
) {
  const targets = await page.locator(rootSelector).evaluateAll((roots, args) => {
    const targetElements = roots.flatMap((root) => [
      ...(root.matches(args.interactiveTargetSelector) ? [root] : []),
      ...root.querySelectorAll(args.interactiveTargetSelector)
    ]);

    return [...new Set(targetElements)].flatMap((element) => {
      if (args.excludeSpatialMapMarkers && element.closest("[data-spatial-map-marker='true']")) return [];
      if (element.matches(":disabled") || element.getAttribute("aria-disabled") === "true") return [];
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      const visuallyHidden = element.closest(".sr-only,[hidden],[aria-hidden='true']")
        || (style.position === "absolute" && (style.clip !== "auto" || style.clipPath !== "none") && rect.width <= 1 && rect.height <= 1);
      if (visuallyHidden || style.display === "none" || style.visibility === "hidden" || style.opacity === "0" || rect.width === 0 || rect.height === 0) return [];

      let hitTarget = element;
      if (element.matches("input[type='checkbox'], input[type='radio']")) {
        const explicitLabel = element.id
          ? document.querySelector(`label[for="${CSS.escape(element.id)}"]`)
          : null;
        hitTarget = element.closest("label") ?? explicitLabel ?? element;
      }
      const hitRect = hitTarget.getBoundingClientRect();
      const label = element.getAttribute("aria-label")
        ?? (element.id ? document.querySelector(`label[for="${CSS.escape(element.id)}"]`)?.textContent?.trim() : null)
        ?? element.textContent?.trim()
        ?? element.tagName;
      return [{ label, width: hitRect.width, height: hitRect.height }];
    });
  }, { interactiveTargetSelector, excludeSpatialMapMarkers });

  expect(targets.length, `Expected at least one visible enabled interactive target within ${rootSelector}`).toBeGreaterThan(0);
  const undersized = targets.filter(({ width, height }) => width < 44 || height < 44);
  expect(undersized, `Touch targets below 44px within ${rootSelector}`).toEqual([]);
}
