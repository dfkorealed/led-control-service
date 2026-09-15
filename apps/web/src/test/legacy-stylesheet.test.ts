import { afterEach, expect, it } from "vitest";
import { prepareLegacyStylesheetForJsdom } from "./legacy-stylesheet";

afterEach(() => { document.head.replaceChildren(); document.body.replaceChildren(); });

it("lets JSDOM apply compatibility declarations together with existing unlayered rules", () => {
  const style = document.createElement("style");
  style.textContent = prepareLegacyStylesheetForJsdom('@import "ignored.css";\n@layer components {\n  .example { padding: 8px; }\n}\n.example { margin: 4px; }');
  document.head.append(style);
  const element = document.createElement("div");
  element.className = "example";
  document.body.append(element);
  expect(getComputedStyle(element).padding).toBe("8px");
  expect(getComputedStyle(element).margin).toBe("4px");
});

it("retains nested responsive rules while flattening repeated component layers", () => {
  const style = document.createElement("style");
  style.textContent = prepareLegacyStylesheetForJsdom('@layer components {\n  @media (min-width: 760px) {\n    .example { padding: 8px; }\n  }\n}\n@layer components {\n  .example { margin: 4px; }\n}');
  document.head.append(style);
  expect(style.sheet?.cssRules).toHaveLength(2);
  const media = style.sheet?.cssRules[0] as CSSMediaRule;
  expect(media.conditionText).toBe("(min-width: 760px)");
  expect(media.cssRules).toHaveLength(1);
});
