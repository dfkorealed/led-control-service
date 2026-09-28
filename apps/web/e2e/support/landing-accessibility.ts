import type { Page } from "@playwright/test";
import type { AxeResults, Result, NodeResult } from "axe-core";

export async function runLandingAxe(page: Page): Promise<AxeResults> {
  return page.evaluate(async () => (window as unknown as { axe: { run(): Promise<AxeResults> } }).axe.run());
}

type LandingAxeInput = { violations: (Pick<Result, "id" | "impact"> & { nodes: Pick<NodeResult, "target">[] })[] };

export async function classifyLandingAxe(page: Page, raw: LandingAxeInput) {
  return page.evaluate(raw => {
    const incidental: { id: string; impact: string | null; target: (string | string[])[]; role: string }[] = [];
    const remaining: { id: string; impact: string | null; target: (string | string[])[] }[] = [];
    const noInteraction = (element: Element) => {
      const nodes = [element, ...element.querySelectorAll("*")];
      return nodes.every(node => node instanceof HTMLElement && node.tabIndex === -1 &&
        !node.matches("a,button,input,select,textarea,label,summary,[role],[tabindex],[contenteditable]") &&
        ![...node.attributes].some(attr => /^on|^aria-(?!hidden$)/.test(attr.name)) &&
        !node.onclick && !node.onkeydown && !node.onpointerdown);
    };
    const hasHeading = (section: Element) => {
      const id = section.getAttribute("aria-labelledby");
      const heading = id ? document.getElementById(id) : null;
      return heading?.tagName === "H2" && section.contains(heading) && !!heading.textContent?.trim() &&
        !heading.closest("[aria-hidden='true']") && hasVisiblePaint(heading);
    };
    const hasVisiblePaint = (element: Element) => {
      const style = getComputedStyle(element), rect = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility === "visible" &&
        Number(style.opacity) > 0 && rect.width > 0 && rect.height > 0;
    };
    const decorationRole = (element: Element): string | null => {
      // Manual SC 1.4.3 ruling: only these existing incidental picture roles qualify.
      // Hidden ownership alone is insufficient; readable notices/hints always block.
      if (element.tagName !== "SPAN" || element.matches(".demo-disclaimer,.map-save") ||
        element.children.length || !noInteraction(element) || !hasVisiblePaint(element)) return null;
      if (element.matches(".scene-watermark")) {
        const section = element.parentElement;
        const kind = section?.getAttribute("data-demo");
        const ids: Record<string, string> = { monitoring: "monitoring", control: "control", statistics: "statistics", report: "report", map: "map-editor" };
        if (!kind || section?.id !== ids[kind] || !section.matches(`.scene.scene--${kind}`) ||
          element.textContent !== kind || element.getAttribute("aria-hidden") !== "true" ||
          !hasHeading(section) || getComputedStyle(element).pointerEvents !== "none" || getComputedStyle(element).position !== "absolute") return null;
        return "scene-watermark";
      }
      if (element.matches(".control-visual__caption")) {
        const picture = element.parentElement;
        const section = picture?.closest("#control.scene.scene--control");
        if (!picture?.matches(".control-demo > .control-content > .control-visual") ||
          picture.getAttribute("aria-hidden") !== "true" || !noInteraction(picture) || !hasVisiblePaint(picture) ||
          element.textContent !== "출입구 그룹 · 조명 4개" || !section || !hasHeading(section)) return null;
        // One pendant plus glow/beam/floor is significant visual content. The fixed
        // illustrative count 4 is NOT separately repeated by the control UI.
        for (const part of ["lamp", "glow", "beam", "floor"]) {
          const shapes = picture.querySelectorAll(`:scope > .control-visual__${part}`);
          if (shapes.length !== 1 || !hasVisiblePaint(shapes[0])) return null;
        }
        const captionStyle = getComputedStyle(element);
        const pictureRect = picture.getBoundingClientRect(), captionRect = element.getBoundingClientRect();
        if (getComputedStyle(picture).position !== "relative" || captionStyle.position !== "absolute" ||
          captionStyle.left !== "20px" || captionStyle.bottom !== "19px" ||
          captionRect.left < pictureRect.left || captionRect.right > pictureRect.right ||
          captionRect.top < pictureRect.top || captionRect.bottom > pictureRect.bottom) return null;
        const demo = picture.closest(".control-demo")!;
        const slider = demo.querySelector<HTMLInputElement>("input#brightness-range[type='range']");
        if (demo.querySelector(".demo-title strong")?.textContent !== "조명 제어" ||
          demo.querySelector(".demo-title small")?.textContent !== "출입구 그룹" ||
          !slider?.labels || ![...slider.labels].some(label => label.textContent === "출입구 그룹 밝기") ||
          ![...demo.querySelectorAll("button")].some(button => button.textContent?.trim() === "밝기 적용 →")) return null;
        return "control-picture-caption";
      }
      return null;
    };
    for (const violation of raw.violations) {
      if (violation.impact !== "serious" && violation.impact !== "critical") continue;
      for (const node of violation.nodes) {
        const item = { id: violation.id, impact: violation.impact, target: node.target };
        let role: string | null = null;
        // Exact single-document target only; nested frames/shadow targets fail closed.
        if (violation.id === "color-contrast" && violation.impact === "serious" &&
          node.target.length === 1 && typeof node.target[0] === "string") {
          const matches = document.querySelectorAll(node.target[0]);
          if (matches.length === 1) role = decorationRole(matches[0]);
        }
        if (role) incidental.push({ ...item, role });
        else remaining.push(item);
      }
    }
    return { incidental, remaining };
  }, raw);
}
