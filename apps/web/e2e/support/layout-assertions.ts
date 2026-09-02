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
    interface VisibleRect {
      top: number;
      right: number;
      bottom: number;
      left: number;
      width: number;
      height: number;
    }

    function intersectRects(first: VisibleRect, second: VisibleRect): VisibleRect | null {
      const top = Math.max(first.top, second.top);
      const right = Math.min(first.right, second.right);
      const bottom = Math.min(first.bottom, second.bottom);
      const left = Math.max(first.left, second.left);
      if (right <= left || bottom <= top) return null;
      return { top, right, bottom, left, width: right - left, height: bottom - top };
    }

    function isVisibleThroughAncestors(element: Element) {
      for (let current: Element | null = element; current; current = current.parentElement) {
        const style = getComputedStyle(current);
        if (
          current.matches(".sr-only,[hidden],[aria-hidden='true']")
          || style.display === "none"
          || style.visibility === "hidden"
          || style.visibility === "collapse"
          || Number(style.opacity) === 0
        ) return false;
      }
      return true;
    }

    function usableVisibleRect(element: Element): VisibleRect | null {
      if (!isVisibleThroughAncestors(element)) return null;
      const bounds = element.getBoundingClientRect();
      let visibleRect = intersectRects(
        {
          top: bounds.top,
          right: bounds.right,
          bottom: bounds.bottom,
          left: bounds.left,
          width: bounds.width,
          height: bounds.height
        },
        {
          top: 0,
          right: document.documentElement.clientWidth,
          bottom: document.documentElement.clientHeight,
          left: 0,
          width: document.documentElement.clientWidth,
          height: document.documentElement.clientHeight
        }
      );
      if (!visibleRect) return null;

      for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
        const style = getComputedStyle(ancestor);
        const clipsX = ["auto", "hidden", "clip", "scroll"].includes(style.overflowX);
        const clipsY = ["auto", "hidden", "clip", "scroll"].includes(style.overflowY);
        if (!clipsX && !clipsY) continue;
        const bounds = ancestor.getBoundingClientRect();
        const clipRect = {
          top: clipsY ? bounds.top + ancestor.clientTop : visibleRect.top,
          right: clipsX ? bounds.left + ancestor.clientLeft + ancestor.clientWidth : visibleRect.right,
          bottom: clipsY ? bounds.top + ancestor.clientTop + ancestor.clientHeight : visibleRect.bottom,
          left: clipsX ? bounds.left + ancestor.clientLeft : visibleRect.left,
          width: 0,
          height: 0
        };
        clipRect.width = clipRect.right - clipRect.left;
        clipRect.height = clipRect.bottom - clipRect.top;
        visibleRect = intersectRects(visibleRect, clipRect);
        if (!visibleRect) return null;
      }
      return visibleRect;
    }

    function isPointerReachable(element: Element, rect: VisibleRect) {
      const insetX = Math.min(1, rect.width / 2);
      const insetY = Math.min(1, rect.height / 2);
      const points = [
        [rect.left + rect.width / 2, rect.top + rect.height / 2],
        [rect.left + insetX, rect.top + insetY],
        [rect.right - insetX, rect.top + insetY],
        [rect.left + insetX, rect.bottom - insetY],
        [rect.right - insetX, rect.bottom - insetY]
      ];
      return points.some(([x, y]) => {
        const pointerTarget = document.elementFromPoint(x, y);
        return pointerTarget === element || (pointerTarget ? element.contains(pointerTarget) : false);
      });
    }

    const targetElements = roots.flatMap((root) => [
      ...(root.matches(args.interactiveTargetSelector) ? [root] : []),
      ...root.querySelectorAll(args.interactiveTargetSelector)
    ]);

    return [...new Set(targetElements)].flatMap((element) => {
      if (args.excludeSpatialMapMarkers && element.closest("[data-spatial-map-marker='true']")) return [];
      if (element.matches(":disabled") || element.getAttribute("aria-disabled") === "true") return [];
      let hitTarget = element;
      const isNativeChoice = element instanceof HTMLInputElement
        && (element.type === "checkbox" || element.type === "radio");
      if (isNativeChoice) hitTarget = element.labels?.[0] ?? element;
      const hitRect = usableVisibleRect(hitTarget);
      if (!hitRect || !isPointerReachable(hitTarget, hitRect)) return [];
      const label = element.getAttribute("aria-label")
        ?? (isNativeChoice ? element.labels?.[0]?.textContent?.trim() : null)
        ?? element.textContent?.trim()
        ?? element.tagName;
      return [{ label, width: hitRect.width, height: hitRect.height }];
    });
  }, { interactiveTargetSelector, excludeSpatialMapMarkers });

  expect(targets.length, `Expected at least one visible enabled interactive target within ${rootSelector}`).toBeGreaterThan(0);
  const undersized = targets.filter(({ width, height }) => width < 44 || height < 44);
  expect(undersized, `Touch targets below 44px within ${rootSelector}`).toEqual([]);
}
