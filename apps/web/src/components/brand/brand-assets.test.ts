import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const svgPath = "public/brand/kinda-mark.svg";
const reversedPath = "public/brand/kinda-mark-reversed.svg";
const monochromePath = "public/brand/kinda-mark-monochrome.svg";
const geometryIds = ["switch-flip-artwork", "operation-frame", "raised-tile", "digital-depth", "lit-tile"];
const geometryAttributes = ["x", "y", "width", "height", "rx", "transform", "stroke-width"];

function readSvg(path: string) {
  return readFileSync(path, "utf8");
}

function geometry(source: string) {
  const document = new DOMParser().parseFromString(source, "image/svg+xml");
  return geometryIds.map((id) => {
    const element = document.getElementById(id);
    expect(element, `${id} geometry`).not.toBeNull();
    return {
      id,
      tag: element!.tagName,
      attributes: geometryAttributes.map((name) => [name, element!.getAttribute(name)])
    };
  });
}

function colors(source: string) {
  return new Set(source.match(/#[0-9A-F]{6}/g) ?? []);
}

describe("킨다 브랜드 자산", () => {
  it("54px mockup 비례와 12도 스위치 플립 기하를 정본에 보존한다", () => {
    const svg = readSvg(svgPath);
    expect(svg).toContain('viewBox="0 0 64 64"');
    expect(svg).toContain('id="switch-flip-artwork" transform="translate(2 5)"');
    expect(svg).toContain('id="operation-frame" x="7" y="7" width="40" height="40" rx="10"');
    expect(svg).toContain('stroke-width="7"');
    expect(svg).toContain('id="raised-tile" transform="rotate(12 32 23)"');
    expect(svg).toContain('id="digital-depth" x="25" y="8" width="22" height="22" rx="5"');
    expect(svg).toContain('id="lit-tile" x="30" y="3" width="22" height="22" rx="5"');
    expect(colors(svg)).toEqual(new Set(["#15324A", "#256FA1", "#FF7A5C"]));
    expect(svg).not.toMatch(/<text|<filter|<linearGradient|<radialGradient/);
  });

  it.each([reversedPath, monochromePath])("%s는 정본과 기하가 같고 색상만 다르다", (path) => {
    expect(geometry(readSvg(path))).toEqual(geometry(readSvg(svgPath)));
    expect(readSvg(path)).not.toMatch(/<text|<filter|<linearGradient|<radialGradient/);
  });

  it("반전과 단색 자산은 허용된 색만 사용한다", () => {
    expect(colors(readSvg(reversedPath))).toEqual(new Set(["#FFFFFF", "#256FA1", "#FF7A5C"]));
    expect(colors(readSvg(monochromePath))).toEqual(new Set(["#15324A"]));
  });

  it("회전한 타일을 자르지 않고 16px에서도 frame·offset·flap을 식별한다", () => {
    const radians = (12 * Math.PI) / 180;
    const corners = [[25, 8], [47, 8], [47, 30], [25, 30], [30, 3], [52, 3], [52, 25], [30, 25]];
    const rotated = corners.map(([x, y]) => [
      2 + 32 + (x - 32) * Math.cos(radians) - (y - 23) * Math.sin(radians),
      5 + 23 + (x - 32) * Math.sin(radians) + (y - 23) * Math.cos(radians)
    ]);
    expect(Math.min(...rotated.map(([x]) => x))).toBeGreaterThanOrEqual(0);
    expect(Math.max(...rotated.map(([x]) => x))).toBeLessThanOrEqual(64);
    expect(Math.min(...rotated.map(([, y]) => y))).toBeGreaterThanOrEqual(0);
    expect(Math.max(...rotated.map(([, y]) => y))).toBeLessThanOrEqual(64);
    expect((7 / 64) * 16).toBeGreaterThanOrEqual(1.75);
    expect((5 / 64) * 16).toBeGreaterThanOrEqual(1.25);
    expect((22 / 64) * 16).toBeGreaterThanOrEqual(5.5);
  });

  it.each(["public/brand/kinda-mark-512.png", "public/brand/favicon-32.png"])(
    "%s PNG를 정본 SVG 옆에 제공한다",
    (path) => {
      expect(existsSync(path)).toBe(true);
      expect([...readFileSync(path).subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    }
  );
});
