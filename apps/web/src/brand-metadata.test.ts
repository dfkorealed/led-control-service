import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("킨다 브라우저 메타데이터", () => {
  it("한글 제목과 정본 기반 파비콘을 선언한다", () => {
    const html = readFileSync("index.html", "utf8");
    expect(html).toContain("<title>킨다 | 스마트 조명 운영</title>");
    expect(html).toContain(
      '<link rel="icon" type="image/svg+xml" href="/brand/kinda-mark.svg" />',
    );
    expect(html).toContain(
      '<link rel="icon" type="image/png" sizes="32x32" href="/brand/favicon-32.png" />',
    );
    expect(html).toContain('<meta name="theme-color" content="#15324A" />');
    expect(html).not.toContain("LED Control");
  });
});
