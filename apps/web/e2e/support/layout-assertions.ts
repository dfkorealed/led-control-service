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

export async function expectMinimumTouchTargetsAfterScrolling(
  page: Page,
  rootSelector: string,
  { excludeSpatialMapMarkers = false }: { excludeSpatialMapMarkers?: boolean } = {}
) {
  const targets = page.locator(rootSelector).locator(interactiveTargetSelector);
  const targetCount = await targets.count();
  let inspectedTargetCount = 0;

  for (let index = 0; index < targetCount; index += 1) {
    const target = targets.nth(index);
    const marker = `touch-contract-${index}`;
    const candidateCount = await target.evaluate((element, { dataMarker, excludeSpatialMapMarkers: excludeMarkers }) => {
      if (element.matches(":disabled") || element.getAttribute("aria-disabled") === "true") return 0;
      if (excludeMarkers && element.closest("[data-spatial-map-marker='true']")) return 0;
      const candidates = element instanceof HTMLInputElement
        && (element.type === "checkbox" || element.type === "radio")
        ? [...(element.labels ?? []), element]
        : [element];
      element.setAttribute("data-e2e-touch-contract", dataMarker);
      return [...new Set(candidates)].length;
    }, { dataMarker: marker, excludeSpatialMapMarkers });
    let targetWasInspected = false;
    let targetPassed = false;
    let lastCandidateFailure: unknown;

    try {
      // Associated labels and the input fallback can occupy different positions in a scroll root.
      // Measure immediately after scrolling each candidate, and defer its assertion failure so a
      // later candidate can satisfy the native choice without changing target-by-target scrolling.
      for (let candidateIndex = 0; candidateIndex < candidateCount; candidateIndex += 1) {
        const candidateWasScrolled = await target.evaluate((element, currentCandidateIndex) => {
          const candidates = element instanceof HTMLInputElement
            && (element.type === "checkbox" || element.type === "radio")
            ? [...new Set([...(element.labels ?? []), element])]
            : [element];
          const scrollTarget = candidates[currentCandidateIndex];
          if (!scrollTarget) return false;

          for (let current: Element | null = scrollTarget; current; current = current.parentElement) {
            const style = getComputedStyle(current);
            if (
              current.matches(".sr-only,[hidden],[aria-hidden='true']")
              || style.display === "none"
              || style.visibility === "hidden"
              || style.visibility === "collapse"
              || Number(style.opacity) === 0
            ) return false;
          }
          const rect = scrollTarget.getBoundingClientRect();
          if (rect.width <= 0 || rect.height <= 0) return false;

          scrollTarget.scrollIntoView({ block: "center", inline: "center" });
          return true;
        }, candidateIndex);
        if (!candidateWasScrolled) continue;

        targetWasInspected = true;
        try {
          await expectMinimumTouchTargets(
            page,
            `[data-e2e-touch-contract="${marker}"]`,
            { excludeSpatialMapMarkers }
          );
          targetPassed = true;
          break;
        } catch (error) {
          lastCandidateFailure = error;
        }
      }
    } finally {
      await page.locator(`[data-e2e-touch-contract="${marker}"]`).evaluateAll((elements) => {
        elements.forEach((element) => element.removeAttribute("data-e2e-touch-contract"));
      });
    }

    if (targetWasInspected) inspectedTargetCount += 1;
    if (targetWasInspected && !targetPassed) {
      throw lastCandidateFailure ?? new Error(`Unable to measure touch target ${index} within ${rootSelector}`);
    }
  }

  expect(
    inspectedTargetCount,
    `Expected at least one visible enabled interactive target within ${rootSelector}`
  ).toBeGreaterThan(0);
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

    interface PixelSegment {
      size: number;
      sample: number;
    }

    interface ReachableMeasurement {
      width: number;
      height: number;
      hasMinimumArea: boolean;
      geometryWidth: number;
      geometryHeight: number;
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

    function establishesFixedContainingBlock(element: Element) {
      const style = getComputedStyle(element);
      const willChange = style.willChange.split(",").map((value) => value.trim());
      const containment = style.contain.split(" ");
      return style.transform !== "none"
        || style.perspective !== "none"
        || style.filter !== "none"
        || style.backdropFilter !== "none"
        || willChange.some((value) => ["transform", "perspective", "filter", "backdrop-filter"].includes(value))
        || containment.some((value) => ["layout", "paint", "strict", "content"].includes(value))
        || style.contentVisibility !== "visible";
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

      const isFixed = getComputedStyle(element).position === "fixed";
      const hasFixedContainingBlock = isFixed
        && [...generateAncestors(element)].some(establishesFixedContainingBlock);
      for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
        // A viewport-fixed box escapes ancestor overflow unless an ancestor establishes
        // the fixed containing block (for example via transform/filter/perspective).
        if (isFixed && !hasFixedContainingBlock) continue;
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

    function* generateAncestors(element: Element) {
      for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) yield ancestor;
    }

    function pixelSegments(start: number, end: number): PixelSegment[] {
      const segments: PixelSegment[] = [];
      for (let segmentStart = start; segmentStart < end;) {
        const segmentEnd = Math.min(segmentStart + 1, end);
        segments.push({
          size: segmentEnd - segmentStart,
          sample: segmentStart + (segmentEnd - segmentStart) / 2
        });
        segmentStart = segmentEnd;
      }
      return segments;
    }

    function measureReachableArea(element: Element, rect: VisibleRect): ReachableMeasurement {
      const columns = pixelSegments(rect.left, rect.right);
      const rows = pixelSegments(rect.top, rect.bottom);
      const hitGrid = rows.map((row) => columns.map((column) => {
        const pointerTarget = document.elementFromPoint(column.sample, row.sample);
        return pointerTarget === element || (pointerTarget ? element.contains(pointerTarget) : false);
      }));

      let maximumWidth = 0;
      for (const row of hitGrid) {
        let width = 0;
        row.forEach((reachable, columnIndex) => {
          width = reachable ? width + columns[columnIndex].size : 0;
          maximumWidth = Math.max(maximumWidth, width);
        });
      }

      let maximumHeight = 0;
      columns.forEach((_, columnIndex) => {
        let height = 0;
        rows.forEach((row, rowIndex) => {
          height = hitGrid[rowIndex][columnIndex] ? height + row.size : 0;
          maximumHeight = Math.max(maximumHeight, height);
        });
      });

      for (let topRow = 0; topRow < rows.length; topRow += 1) {
        const reachableColumns = columns.map(() => true);
        let height = 0;
        for (let bottomRow = topRow; bottomRow < rows.length; bottomRow += 1) {
          height += rows[bottomRow].size;
          reachableColumns.forEach((_, columnIndex) => {
            reachableColumns[columnIndex] &&= hitGrid[bottomRow][columnIndex];
          });
          if (height < 44) continue;

          let width = 0;
          for (let columnIndex = 0; columnIndex < columns.length; columnIndex += 1) {
            width = reachableColumns[columnIndex] ? width + columns[columnIndex].size : 0;
            if (width >= 44) {
              return {
                width: maximumWidth,
                height: maximumHeight,
                hasMinimumArea: true,
                geometryWidth: rect.width,
                geometryHeight: rect.height
              };
            }
          }
          // More rows can only remove reachable columns, so this top edge cannot
          // produce a 44x44 candidate after its first 44px-high slice fails.
          break;
        }
      }

      return {
        width: maximumWidth,
        height: maximumHeight,
        hasMinimumArea: false,
        geometryWidth: rect.width,
        geometryHeight: rect.height
      };
    }

    const targetElements = roots.flatMap((root) => [
      ...(root.matches(args.interactiveTargetSelector) ? [root] : []),
      ...root.querySelectorAll(args.interactiveTargetSelector)
    ]);

    return [...new Set(targetElements)].flatMap((element) => {
      if (args.excludeSpatialMapMarkers && element.closest("[data-spatial-map-marker='true']")) return [];
      if (element.matches(":disabled") || element.getAttribute("aria-disabled") === "true") return [];
      const isNativeChoice = element instanceof HTMLInputElement
        && (element.type === "checkbox" || element.type === "radio");
      const associatedLabels = isNativeChoice ? [...(element.labels ?? [])] : [];
      const hitCandidates = isNativeChoice ? [...associatedLabels, element] : [element];
      const measurements = [...new Set(hitCandidates)].flatMap((hitTarget) => {
        const hitRect = usableVisibleRect(hitTarget);
        if (!hitRect) return [];
        return [measureReachableArea(hitTarget, hitRect)];
      });
      if (measurements.length === 0) return [];
      const passingMeasurement = measurements.find(({ hasMinimumArea }) => hasMinimumArea);
      const bestMeasurement = passingMeasurement ?? measurements.reduce((best, measurement) => {
        const bestMinimumDimension = Math.min(best.width, best.height);
        const measurementMinimumDimension = Math.min(measurement.width, measurement.height);
        if (measurementMinimumDimension !== bestMinimumDimension) {
          return measurementMinimumDimension > bestMinimumDimension ? measurement : best;
        }
        return measurement.width * measurement.height > best.width * best.height ? measurement : best;
      });
      const label = element.getAttribute("aria-label")
        ?? (isNativeChoice ? associatedLabels.map((labelElement) => labelElement.textContent?.trim()).find(Boolean) : null)
        ?? element.textContent?.trim()
        ?? element.tagName;
      return [{ label, ...bestMeasurement }];
    });
  }, { interactiveTargetSelector, excludeSpatialMapMarkers });

  expect(targets.length, `Expected at least one visible enabled interactive target within ${rootSelector}`).toBeGreaterThan(0);
  const undersized = targets.filter(({ hasMinimumArea }) => !hasMinimumArea);
  expect(undersized, `Touch targets below 44px within ${rootSelector}`).toEqual([]);
}
