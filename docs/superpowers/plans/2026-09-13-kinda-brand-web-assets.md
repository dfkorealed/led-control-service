# 킨다 브랜드 Web 자산 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** O안 `스위치 플립` 최종 로고 자산을 제작하고 Web의 로그인·고객 셸·운영자 셸·브라우저 메타데이터에서 사용자 노출 `LED Control`을 `킨다`로 교체한다.

**Architecture:** `apps/web/public/brand/kinda-mark.svg`를 마크 기하의 단일 정본으로 두고 반전·단색 SVG는 같은 좌표에 허용된 색만 바꾸며, PNG는 저장소에 이미 있는 Playwright로 정본 SVG에서 생성한다. React의 `KindaLogo`는 마크 이미지를 한글 HTML 텍스트 `킨다` 및 선택적 접점 설명과 조합하며, 별도 `<text>` 기반 가로형 SVG는 만들지 않는다. `primary/surface/text`는 Brand Blue/Paper/Navy에 연결하고 기존 success/warning/danger 의미 토큰은 독립적으로 유지한다.

**Tech Stack:** React 18, TypeScript 5.7, Vite 5, Vitest 2, Testing Library, Playwright 1.49, CSS, SVG, pnpm 9.15

**Spec:** [킨다 시각 아이덴티티 설계](../specs/2026-09-13-kinda-visual-identity-design.md)

## Global Constraints

- 브랜드 주 표기는 한글 `킨다`이며 `KINDA`를 Web 기본 표기로 사용하지 않는다.
- O안 의미는 `라운드 프레임=운영 시스템`, `들린 타일=켜는 동작`, `Coral 면=점등`, `Blue 깊이=디지털 제어`다.
- 팔레트는 Navy `#15324A`, Blue `#256FA1`, Coral `#FF7A5C`, Paper `#F4F8FA`로 고정하고 브랜드 시각 무게는 60/30/10을 기준으로 한다.
- `--primary`, `--surface`, `--text`는 각각 Brand Blue, Paper, Navy를 참조하고 hover `#1D5C86`, soft surface `#E8F2F8`, focus ring `rgba(37, 111, 161, 0.28)`도 Blue 계열로 맞춘다.
- Navy/White `13.23:1`, Blue/White `5.43:1`, Coral/White `2.56:1`, Coral/Navy `5.16:1`, Navy/Paper `12.38:1`의 확인된 명암비와 WCAG AA 일반 텍스트 `4.5:1`, 큰 텍스트·의미 있는 그래픽 `3:1` 기준을 유지한다.
- Coral은 흰 배경 본문, 주요 버튼, 링크, 성공·경고·오류 상태 의미색에 사용하지 않는다. 색상만으로 상태나 행동을 전달하지 않는다.
- 마크 SVG가 형태의 단일 정본이다. PNG를 독립 편집하지 않고 생성 명령으로만 갱신한다.
- 반전·단색 SVG는 정본과 모든 도형 좌표·회전·선 굵기가 같고 색상 속성만 다르게 관리한다. Web 가로형은 별도 `<text>` SVG 없이 `KindaLogo`의 HTML 한글로 표현한다.
- 사용자에게 보이는 `LED Control`만 `킨다`로 바꾼다. `@led-control/web`, 저장소·패키지 이름, API 경로, 환경 변수와 배포 식별자는 변경하지 않는다.
- 모바일 스토어 아이콘, 인쇄 발주, 실물 장비 라벨 제작, API·DB·MQTT·BLE Mesh·firmware 변경은 범위에서 제외한다.
- 메뉴 구조와 기능은 바뀌지 않으므로 `docs/menus/*.md`는 수정하지 않는다.
- 각 행동 변경은 실패하는 테스트를 먼저 확인하고 최소 구현으로 통과시킨다.

## 의존성 및 실행 순서

1. Task 1의 정본 SVG와 생성 PNG가 Task 2 `KindaLogo`의 이미지 입력이다.
2. Task 2의 공통 컴포넌트와 브랜드 CSS가 Task 4·5의 화면 교체 입력이다.
3. Task 3의 메타데이터는 화면 컴포넌트와 독립적이지만 정본 자산 이후에 적용한다.
4. Task 4 로그인 교체 뒤 App 복구 테스트의 기대 문구를 수렴한다.
5. Task 5 고객·운영자 셸 교체 뒤 Task 6에서 모든 Web 회귀와 잔존 문자열을 검사한다.

## 파일 구조

| 파일 | 책임 |
| --- | --- |
| `apps/web/public/brand/kinda-mark.svg` | O안 스위치 플립 마크의 유일한 벡터 정본 |
| `apps/web/public/brand/kinda-mark-reversed.svg` | Navy 면용 White 프레임 변형 |
| `apps/web/public/brand/kinda-mark-monochrome.svg` | 단색 출력·회색조 확인용 변형 |
| `apps/web/public/brand/kinda-mark-512.png` | SVG에서 생성한 투명 배경 범용 PNG |
| `apps/web/public/brand/favicon-32.png` | SVG에서 생성한 브라우저 PNG fallback |
| `apps/web/scripts/render-brand-assets.mjs` | 정본 SVG를 두 PNG로 재현 가능하게 생성 |
| `apps/web/src/components/brand/KindaLogo.tsx` | 마크와 HTML 텍스트 `킨다`를 조합하는 공통 컴포넌트 |
| `apps/web/src/components/brand/*.test.tsx` | 자산 계약과 로고 접근성·표기 회귀 |
| `apps/web/src/brand-metadata.test.ts` | 제목·파비콘·theme color 계약 |
| `apps/web/index.html` | 브라우저 제목과 파비콘 선언 |
| `apps/web/src/styles.css` | 브랜드 토큰과 접점별 로고 배치 |
| `AuthView.tsx`, `CustomerShell.tsx`, `OperatorShell.tsx` | 로그인·고객·운영자 핵심 브랜드 접점 |

---

### Task 1: O안 스위치 플립 정본 SVG와 PNG 생성

**Files:**

- Create: `apps/web/src/components/brand/brand-assets.test.ts`
- Create: `apps/web/public/brand/kinda-mark.svg`
- Create: `apps/web/public/brand/kinda-mark-reversed.svg`
- Create: `apps/web/public/brand/kinda-mark-monochrome.svg`
- Create: `apps/web/public/brand/kinda-mark-512.png`
- Create: `apps/web/public/brand/favicon-32.png`
- Create: `apps/web/scripts/render-brand-assets.mjs`
- Modify: `apps/web/package.json`

**Interfaces:**

- Consumes: 팔레트 Navy `#15324A`, Blue `#256FA1`, Coral `#FF7A5C`와 O안 형태 의미.
- Produces: public URL `/brand/kinda-mark.svg`, `/brand/kinda-mark-reversed.svg`, `/brand/kinda-mark-monochrome.svg`, `/brand/kinda-mark-512.png`, `/brand/favicon-32.png` 및 `pnpm --filter @led-control/web brand:assets` 명령.

- [x] **Step 1: 정본·파생 자산 계약의 실패 테스트를 작성한다.**

```ts
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
```

- [x] **Step 2: 자산 테스트가 파일 부재로 실패하는지 확인한다.**

Run: `pnpm --filter @led-control/web test -- src/components/brand/brand-assets.test.ts`

Expected: `ENOENT: no such file or directory, open 'public/brand/kinda-mark.svg'`로 실패한다.

- [x] **Step 3: 다음 SVG를 마크 정본으로 추가한다.**

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" fill="none" role="img" aria-labelledby="kinda-mark-title">
  <title id="kinda-mark-title">킨다 스위치 플립 마크</title>
  <g id="switch-flip-artwork" transform="translate(2 5)">
    <rect id="operation-frame" x="7" y="7" width="40" height="40" rx="10" fill="none" stroke="#15324A" stroke-width="7"/>
    <g id="raised-tile" transform="rotate(12 32 23)">
      <rect id="digital-depth" x="25" y="8" width="22" height="22" rx="5" fill="#256FA1"/>
      <rect id="lit-tile" x="30" y="3" width="22" height="22" rx="5" fill="#FF7A5C"/>
    </g>
  </g>
</svg>
```

54px mockup의 frame `x=7, y=7, 40×40, border=7, radius=10`, Coral flap `x=30, y=3, 22×22`, Blue offset `x=-5, y=+5`와 flap local transform-origin `2px 20px`의 absolute pivot `(32,23)`, 시계 방향 `12°`를 그대로 보존한다. 정사각 `64×64` viewBox에서 앱 아이콘 안전 여백과 중앙 배치를 유지하도록 scale 없이 artwork 전체에 `translate(2 5)`만 적용한다. 정본과 같은 좌표를 사용하는 반전형을 다음처럼 추가한다.

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" fill="none" role="img" aria-labelledby="kinda-reversed-title">
  <title id="kinda-reversed-title">킨다 스위치 플립 반전 마크</title>
  <g id="switch-flip-artwork" transform="translate(2 5)">
    <rect id="operation-frame" x="7" y="7" width="40" height="40" rx="10" fill="none" stroke="#FFFFFF" stroke-width="7"/>
    <g id="raised-tile" transform="rotate(12 32 23)">
      <rect id="digital-depth" x="25" y="8" width="22" height="22" rx="5" fill="#256FA1"/>
      <rect id="lit-tile" x="30" y="3" width="22" height="22" rx="5" fill="#FF7A5C"/>
    </g>
  </g>
</svg>
```

단색형도 같은 좌표를 유지하고 Navy 한 색만 사용한다.

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" fill="none" role="img" aria-labelledby="kinda-monochrome-title">
  <title id="kinda-monochrome-title">킨다 스위치 플립 단색 마크</title>
  <g id="switch-flip-artwork" transform="translate(2 5)">
    <rect id="operation-frame" x="7" y="7" width="40" height="40" rx="10" fill="none" stroke="#15324A" stroke-width="7"/>
    <g id="raised-tile" transform="rotate(12 32 23)">
      <rect id="digital-depth" x="25" y="8" width="22" height="22" rx="5" fill="#15324A"/>
      <rect id="lit-tile" x="30" y="3" width="22" height="22" rx="5" fill="#15324A"/>
    </g>
  </g>
</svg>
```

- [x] **Step 4: 기존 Playwright만 사용하는 PNG 생성기를 추가한다.**

```js
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { chromium } from "@playwright/test";

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const brandDir = path.join(webRoot, "public", "brand");
const svg = await readFile(path.join(brandDir, "kinda-mark.svg"), "utf8");
const outputs = [
  { size: 32, name: "favicon-32.png" },
  { size: 512, name: "kinda-mark-512.png" }
];

const browser = await chromium.launch();
try {
  for (const output of outputs) {
    const page = await browser.newPage({ viewport: { width: output.size, height: output.size } });
    await page.setContent(`<!doctype html><style>
      html, body { margin: 0; width: ${output.size}px; height: ${output.size}px; background: transparent; }
      svg { display: block; width: ${output.size}px; height: ${output.size}px; }
    </style>${svg}`);
    await page.locator("svg").screenshot({
      path: path.join(brandDir, output.name),
      omitBackground: true
    });
    await page.close();
  }
} finally {
  await browser.close();
}
```

`apps/web/package.json`의 `scripts`에 다음 항목을 추가한다.

```json
"brand:assets": "node scripts/render-brand-assets.mjs"
```

- [x] **Step 5: PNG를 생성하고 자산 계약을 통과시킨다.**

Run: `pnpm --filter @led-control/web brand:assets`

Expected: 종료 코드 `0`이며 두 PNG 파일이 생성된다.

Run: `pnpm --filter @led-control/web test -- src/components/brand/brand-assets.test.ts`

Expected: 정본 기하, 변형 색상, 16px 식별성과 PNG signature 계약이 모두 통과한다.

- [x] **Step 6: 정본과 생성기를 커밋한다.**

```bash
git add apps/web/package.json apps/web/public/brand apps/web/scripts/render-brand-assets.mjs apps/web/src/components/brand/brand-assets.test.ts
git commit -m "feat(web): add kinda switch flip assets"
```

### Task 2: 재사용 가능한 `KindaLogo`와 브랜드 토큰

**Files:**

- Create: `apps/web/src/components/brand/KindaLogo.tsx`
- Create: `apps/web/src/components/brand/KindaLogo.test.tsx`
- Modify: `apps/web/src/styles.css`

**Interfaces:**

- Consumes: Task 1의 `/brand/kinda-mark.svg`.
- Produces: `KindaLogo({ context?: string, className?: string, compact?: boolean }): JSX.Element`와 `.kinda-logo*` CSS 계약.

- [x] **Step 1: 마크·한글 텍스트·접근성 이름의 실패 테스트를 작성한다.**

```tsx
import { readFileSync } from "node:fs";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { KindaLogo } from "./KindaLogo";

describe("KindaLogo", () => {
  it("마크와 한글 브랜드명을 하나의 접근성 이름으로 조합한다", () => {
    render(<KindaLogo context="관제 센터" />);
    const logo = screen.getByRole("img", { name: "킨다 관제 센터" });
    expect(within(logo).getByText("킨다")).toBeInTheDocument();
    expect(within(logo).getByText("관제 센터")).toBeInTheDocument();
    expect(logo.querySelector("img")).toHaveAttribute("src", "/brand/kinda-mark.svg");
    expect(logo.querySelector("img")).toHaveAttribute("alt", "");
  });

  it("compact 변형도 HTML 브랜드명을 제거하지 않는다", () => {
    render(<KindaLogo compact />);
    const logo = screen.getByRole("img", { name: "킨다" });
    expect(logo).toHaveAttribute("data-compact", "true");
    expect(within(logo).getByText("킨다")).toBeInTheDocument();
  });

  it("brand token을 주요 UI alias에 연결하고 상태 token은 분리한다", () => {
    const styles = readFileSync("src/styles.css", "utf8");
    expect(styles).toContain("--primary: var(--brand-blue);");
    expect(styles).toContain("--primary-hover: #1d5c86;");
    expect(styles).toContain("--primary-soft: #e8f2f8;");
    expect(styles).toContain("--surface: var(--brand-paper);");
    expect(styles).toContain("--text: var(--brand-navy);");
    expect(styles).toContain("--focus-ring: 0 0 0 3px rgba(37, 111, 161, 0.28);");
    expect(styles).toContain(".ui-button-primary:hover:not(:disabled)");
    expect(styles).toContain("background: var(--primary-hover);");
    expect(styles).toContain("--success: #15803d;");
    expect(styles).toContain("--warning: #b45309;");
    expect(styles).toContain("--danger: #dc2626;");
  });
});
```

- [x] **Step 2: 컴포넌트 테스트가 import 오류로 실패하는지 확인한다.**

Run: `pnpm --filter @led-control/web test -- src/components/brand/KindaLogo.test.tsx`

Expected: `Failed to resolve import "./KindaLogo"`로 실패한다.

- [x] **Step 3: 공통 로고 컴포넌트를 최소 구현한다.**

```tsx
export interface KindaLogoProps {
  context?: string;
  className?: string;
  compact?: boolean;
}

export function KindaLogo({ context, className, compact = false }: KindaLogoProps) {
  const classes = ["kinda-logo", className].filter(Boolean).join(" ");
  const accessibleName = context ? `킨다 ${context}` : "킨다";

  return (
    <div className={classes} data-compact={compact || undefined} role="img" aria-label={accessibleName}>
      <img className="kinda-logo-mark" src="/brand/kinda-mark.svg" alt="" aria-hidden="true" width="42" height="42" />
      <span className="kinda-logo-copy" aria-hidden="true">
        <strong>킨다</strong>
        {context ? <span>{context}</span> : null}
      </span>
    </div>
  );
}
```

- [x] **Step 4: 브랜드 토큰과 접점 공통 CSS를 추가하고 기존 브랜드 임시 규칙을 제거한다.**

`:root`의 브랜드·주요 UI alias는 다음처럼 정의한다. 기존 `--success`, `--warning`, `--danger`는 각각 `#15803d`, `#b45309`, `#dc2626`으로 유지해 브랜드 Coral과 분리한다.

```css
color: var(--brand-navy);
background: var(--brand-paper);
--brand-navy: #15324a;
--brand-blue: #256fa1;
--brand-coral: #ff7a5c;
--brand-paper: #f4f8fa;
--primary: var(--brand-blue);
--primary-hover: #1d5c86;
--primary-soft: #e8f2f8;
--surface: var(--brand-paper);
--text: var(--brand-navy);
--focus-ring: 0 0 0 3px rgba(37, 111, 161, 0.28);
```

Blue/White는 `5.43:1`이고 hover `#1D5C86`/White는 일반 텍스트 기준을 넘는다. focus는 Blue 계열 외곽선에 형태 변화인 ring을 함께 사용하며 Coral을 상호작용색으로 사용하지 않는다.

기본 주요 버튼과 hover는 다음처럼 Brand Blue alias만 사용한다.

```css
.ui-button-primary {
  border: 1px solid var(--primary);
  background: var(--primary);
  color: #fff;
}

.ui-button-primary:hover:not(:disabled) {
  border-color: var(--primary-hover);
  background: var(--primary-hover);
}

.ui-button:focus-visible {
  outline: 0;
  box-shadow: var(--focus-ring);
}
```

기존 `.brand`, `.brand-mark`, `.brand > div`, `.auth-brand-panel .auth-brand`, `.auth-brand`, `.operator-brand` 규칙을 제거하고 다음 단일 규칙군으로 교체한다.

```css
.kinda-logo {
  display: inline-flex;
  align-items: center;
  gap: 12px;
  color: var(--brand-navy);
}

.kinda-logo-mark {
  display: block;
  width: 42px;
  height: 42px;
  flex: 0 0 42px;
}

.kinda-logo-copy {
  display: grid;
  gap: 2px;
  min-width: 0;
}

.kinda-logo-copy strong {
  color: var(--brand-navy);
  font-size: 18px;
  font-weight: 900;
  line-height: 1;
}

.kinda-logo-copy > span {
  color: var(--brand-blue);
  font-size: 12px;
  font-weight: 800;
}

.sidebar .kinda-logo {
  flex-direction: column;
  gap: 0;
  margin-bottom: 25px;
}

.sidebar .kinda-logo-copy {
  display: none;
}

.auth-brand {
  margin-bottom: 28px;
}

.operator-brand {
  margin: 0;
}
```

- [x] **Step 5: 공통 컴포넌트 회귀를 통과시킨다.**

Run: `pnpm --filter @led-control/web test -- src/components/brand/KindaLogo.test.tsx src/components/brand/brand-assets.test.ts src/components/ui/ui-primitives.test.tsx`

Expected: 브랜드 자산·컴포넌트와 기존 버튼·카드·상태 UI primitive 회귀가 모두 통과한다.

Run: `pnpm --filter @led-control/web typecheck`

Expected: 종료 코드 `0`이다.

- [x] **Step 6: 공통 브랜드 컴포넌트를 커밋한다.**

```bash
git add apps/web/src/components/brand apps/web/src/styles.css
git commit -m "feat(web): add kinda logo component"
```

### Task 3: 브라우저 제목과 파비콘

**Files:**

- Create: `apps/web/src/brand-metadata.test.ts`
- Modify: `apps/web/index.html`

**Interfaces:**

- Consumes: Task 1의 SVG와 PNG public URL.
- Produces: 브라우저 제목 `킨다 | 스마트 조명 운영`, SVG 우선 파비콘, 32px PNG fallback과 Navy theme color.

- [x] **Step 1: 메타데이터 실패 테스트를 작성한다.**

```ts
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("킨다 브라우저 메타데이터", () => {
  it("한글 제목과 정본 기반 파비콘을 선언한다", () => {
    const html = readFileSync("index.html", "utf8");
    expect(html).toContain("<title>킨다 | 스마트 조명 운영</title>");
    expect(html).toContain('<link rel="icon" type="image/svg+xml" href="/brand/kinda-mark.svg" />');
    expect(html).toContain('<link rel="icon" type="image/png" sizes="32x32" href="/brand/favicon-32.png" />');
    expect(html).toContain('<meta name="theme-color" content="#15324A" />');
    expect(html).not.toContain("LED Control");
  });
});
```

- [x] **Step 2: 기존 제목 때문에 실패하는지 확인한다.**

Run: `pnpm --filter @led-control/web test -- src/brand-metadata.test.ts`

Expected: `킨다 | 스마트 조명 운영` 기대가 실패한다.

- [x] **Step 3: `index.html`의 `head`를 다음처럼 교체한다.**

```html
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="theme-color" content="#15324A" />
  <link rel="icon" type="image/svg+xml" href="/brand/kinda-mark.svg" />
  <link rel="icon" type="image/png" sizes="32x32" href="/brand/favicon-32.png" />
  <title>킨다 | 스마트 조명 운영</title>
</head>
```

- [x] **Step 4: 메타데이터 테스트와 production 복사를 검증한다.**

Run: `pnpm --filter @led-control/web test -- src/brand-metadata.test.ts`

Expected: 메타데이터 테스트가 통과한다.

Run: `pnpm --filter @led-control/web build`

Expected: 종료 코드 `0`이며 `apps/web/dist/brand/kinda-mark.svg`, `apps/web/dist/brand/kinda-mark-512.png`, `apps/web/dist/brand/favicon-32.png`가 존재한다.

- [x] **Step 5: 브라우저 메타데이터를 커밋한다.**

```bash
git add apps/web/index.html apps/web/src/brand-metadata.test.ts
git commit -m "feat(web): brand browser metadata as kinda"
```

### Task 4: 로그인 브랜드 접점 교체

**Files:**

- Modify: `apps/web/src/features/auth/AuthView.test.tsx`
- Modify: `apps/web/src/features/auth/AuthView.tsx`
- Modify: `apps/web/src/App.test.tsx`
- Modify: `apps/web/src/App.recovery.test.tsx`

**Interfaces:**

- Consumes: Task 2의 `KindaLogo`.
- Produces: 접근성 영역 `킨다 소개`, 로그인 제목 `킨다 로그인`, HTML 텍스트 기반 기본 로고.

- [ ] **Step 1: 로그인 브랜드 실패 테스트를 먼저 추가한다.**

`AuthView.test.tsx`의 Testing Library import에 `within`을 추가하고 다음 case를 넣는다.

```tsx
it("킨다 브랜드와 한글 로그인 제목을 표시한다", () => {
  renderView();
  const introduction = screen.getByRole("region", { name: "킨다 소개" });
  expect(within(introduction).getByRole("img", { name: "킨다" })).toBeVisible();
  expect(screen.getByRole("heading", { name: "킨다 로그인" })).toBeVisible();
  expect(screen.queryByText("LED Control")).not.toBeInTheDocument();
});
```

- [ ] **Step 2: 로그인 테스트가 기존 표기로 실패하는지 확인한다.**

Run: `pnpm --filter @led-control/web test -- src/features/auth/AuthView.test.tsx`

Expected: `킨다 소개` 영역 또는 `킨다 로그인` 제목을 찾지 못해 실패한다.

- [ ] **Step 3: `AuthView`의 브랜드 영역과 제목만 교체한다.**

상단 import에 다음을 추가한다.

```tsx
import { KindaLogo } from "../../components/brand/KindaLogo";
```

브랜드 영역과 로그인 제목은 다음 형태로 바꾸며 기존 소개 카피·폼·MFA 동작은 유지한다.

```tsx
<section className="auth-brand-panel" aria-label="킨다 소개">
  <KindaLogo className="auth-brand" />
  <h1>빛을 더 안정적으로,<br />현장을 더 선명하게.</h1>
  <p>주차장 LED 조명의 상태, 제어, 에너지 사용량을 하나의 차분한 운영 화면에서 확인하세요.</p>
</section>
```

```tsx
<h2>킨다 로그인</h2>
```

- [ ] **Step 4: App 인증·복구 테스트의 사용자 노출 제목을 정확히 수렴한다.**

`App.test.tsx`와 `App.recovery.test.tsx`의 모든 role 기반 제목 기대에서 문자열만 다음처럼 교체한다. 인증 흐름, 부정 assertion, 비동기 대기 방식은 바꾸지 않는다.

```tsx
screen.getByRole("heading", { name: "킨다 로그인" });
await screen.findByRole("heading", { name: "킨다 로그인" });
screen.queryByRole("heading", { name: "킨다 로그인" });
```

- [ ] **Step 5: 로그인 focused 회귀를 통과시킨다.**

Run: `pnpm --filter @led-control/web test -- src/features/auth/AuthView.test.tsx src/App.test.tsx src/App.recovery.test.tsx`

Expected: 세 테스트 파일이 모두 통과하며 인증·MFA·복구 case가 유지된다.

- [ ] **Step 6: 로그인 접점을 커밋한다.**

```bash
git add apps/web/src/features/auth/AuthView.tsx apps/web/src/features/auth/AuthView.test.tsx apps/web/src/App.test.tsx apps/web/src/App.recovery.test.tsx
git commit -m "feat(web): brand login as kinda"
```

### Task 5: 고객·운영자 셸 브랜드 접점 교체

**Files:**

- Modify: `apps/web/src/features/shells/CustomerShell.test.tsx`
- Modify: `apps/web/src/features/shells/CustomerShell.tsx`
- Modify: `apps/web/src/features/operator/OperatorShell.test.tsx`
- Modify: `apps/web/src/features/operator/OperatorShell.tsx`

**Interfaces:**

- Consumes: Task 2의 `KindaLogo`.
- Produces: 고객 셸 접근성 이름 `킨다 관제 센터`, 운영자 셸 접근성 이름 `킨다 서비스 운영`.

- [ ] **Step 1: 두 셸의 실패 테스트를 먼저 추가한다.**

`CustomerShell.test.tsx`의 기존 desktop `matchMedia` 조건에서 다음 case를 추가한다.

```tsx
it("데스크톱 셸에 킨다 관제 센터 브랜드를 표시한다", () => {
  renderShell("/monitoring?siteId=site");
  expect(screen.getByRole("img", { name: "킨다 관제 센터" })).toBeVisible();
  expect(screen.queryByText("LED Control")).not.toBeInTheDocument();
});
```

`OperatorShell.test.tsx`에 다음 case를 추가한다.

```tsx
it("운영자 헤더에 킨다 서비스 운영 브랜드를 표시한다", async () => {
  renderShell();
  expect(screen.getByRole("img", { name: "킨다 서비스 운영" })).toBeVisible();
  expect(screen.queryByText("LED Control")).not.toBeInTheDocument();
  expect(await screen.findByRole("heading", { name: "현장 관리자 계정" })).toBeVisible();
});
```

- [ ] **Step 2: 두 셸 테스트가 기존 LC 마크와 이름 때문에 실패하는지 확인한다.**

Run: `pnpm --filter @led-control/web test -- src/features/shells/CustomerShell.test.tsx src/features/operator/OperatorShell.test.tsx`

Expected: 두 `KindaLogo` 접근성 이름을 찾지 못해 실패한다.

- [ ] **Step 3: 고객 셸 rail의 기존 브랜드 블록을 교체한다.**

상단 import에 다음을 추가한다.

```tsx
import { KindaLogo } from "../../components/brand/KindaLogo";
```

desktop sidebar의 기존 `.brand` 블록을 다음으로 교체한다.

```tsx
<KindaLogo context="관제 센터" compact />
```

- [ ] **Step 4: 운영자 헤더의 기존 브랜드 블록을 교체한다.**

상단 import에 다음을 추가한다.

```tsx
import { KindaLogo } from "../../components/brand/KindaLogo";
```

기존 `.brand.operator-brand` 블록을 다음으로 교체한다.

```tsx
<KindaLogo className="operator-brand" context="서비스 운영" />
```

- [ ] **Step 5: 셸 focused 회귀와 CSS 잔존 selector를 검증한다.**

Run: `pnpm --filter @led-control/web test -- src/features/shells/CustomerShell.test.tsx src/features/operator/OperatorShell.test.tsx`

Expected: 두 테스트 파일이 모두 통과한다.

Run: `rg -n '\.brand-mark|className="brand' apps/web/src`

Expected: 출력이 없다.

- [ ] **Step 6: 두 셸 접점을 커밋한다.**

```bash
git add apps/web/src/features/shells/CustomerShell.tsx apps/web/src/features/shells/CustomerShell.test.tsx apps/web/src/features/operator/OperatorShell.tsx apps/web/src/features/operator/OperatorShell.test.tsx
git commit -m "feat(web): brand application shells as kinda"
```

### Task 6: Chromium 회귀, 잔존 문자열과 상태 문서 수렴

**Files:**

- Modify: `apps/web/e2e/calm-operations-auth-operator.spec.ts`
- Modify: `apps/web/e2e/calm-operations-shell.spec.ts`
- Modify: `apps/web/e2e/app-shell-recovery.spec.ts`
- Modify: `apps/web/e2e/settings-floor-editor.spec.ts`
- Modify: `apps/web/e2e/site-user-management-real.spec.ts`
- Modify: `docs/project-status.md`
- Do not modify: `docs/menus/monitoring.md`
- Do not modify: `docs/menus/control.md`
- Do not modify: `docs/menus/statistics.md`
- Do not modify: `docs/menus/settings.md`

**Interfaces:**

- Consumes: Task 1~5의 정본 자산, 메타데이터와 세 브랜드 접점.
- Produces: 1440/1024/390/320 Chromium 증거, 사용자 노출 `LED Control` 0건과 완료 상태 기록.

- [ ] **Step 1: E2E 기대를 새 브랜드 계약으로 수렴한다.**

모든 `LED Control 로그인` role 기대를 `킨다 로그인`으로 바꾸고, `calm-operations-shell.spec.ts`의 `.brand-mark` 기대는 다음으로 교체한다.

```ts
await expect(page.getByRole("img", { name: "킨다 관제 센터" })).toBeVisible();
```

`calm-operations-auth-operator.spec.ts`의 로그인과 operator 진입 구간에 다음 기대를 추가한다.

```ts
await expect(page).toHaveTitle("킨다 | 스마트 조명 운영");
await expect(page.getByRole("img", { name: "킨다" })).toBeVisible();
await expect(page.getByRole("heading", { name: "킨다 로그인" })).toBeVisible();
const loginButton = page.getByRole("button", { name: "로그인", exact: true });
await expect(loginButton).toHaveCSS("background-color", "rgb(37, 111, 161)");
await loginButton.hover();
await expect(loginButton).toHaveCSS("background-color", "rgb(29, 92, 134)");
expect(await page.evaluate(() => {
  const root = getComputedStyle(document.documentElement);
  return {
    primary: root.getPropertyValue("--primary").trim(),
    surface: root.getPropertyValue("--surface").trim(),
    text: root.getPropertyValue("--text").trim(),
    focus: root.getPropertyValue("--focus-ring").trim()
  };
})).toEqual({
  primary: "var(--brand-blue)",
  surface: "var(--brand-paper)",
  text: "var(--brand-navy)",
  focus: "0 0 0 3px rgba(37, 111, 161, 0.28)"
});
```

```ts
await expect(page.getByRole("img", { name: "킨다 서비스 운영" })).toBeVisible();
```

Run: `pnpm --filter @led-control/web exec playwright test e2e/calm-operations-auth-operator.spec.ts e2e/calm-operations-shell.spec.ts --project=chromium --workers=1`

Expected: Task 4·5의 구현을 통해 새 제목과 로고 기대가 모든 지정 viewport에서 통과한다.

- [ ] **Step 2: 나머지 인증 E2E 문자열을 새 사용자 표기로 수렴한다.**

`app-shell-recovery.spec.ts`, `settings-floor-editor.spec.ts`, `site-user-management-real.spec.ts`에서 role 기반 로그인 제목만 다음 문자열로 교체한다.

```ts
page.getByRole("heading", { name: "킨다 로그인" })
```

실제 백엔드가 필요한 `site-user-management-real.spec.ts`의 실행 방식과 opt-in gate는 바꾸지 않는다.

- [ ] **Step 3: 사용자 노출 범위의 구 브랜드와 기술 식별자 경계를 정적으로 검사한다.**

Run: `rg -n 'LED Control|>LC<' apps/web/src apps/web/e2e apps/web/index.html`

Expected: 출력이 없다.

Run: `rg -n '"name": "@led-control/web"' apps/web/package.json`

Expected: 기존 기술 패키지 이름이 1건 출력된다.

Run: `git diff --name-only -- docs/menus`

Expected: 출력이 없다.

- [ ] **Step 4: 자산 재현성과 전체 Web 단위 검증을 실행한다.**

Run: `pnpm --filter @led-control/web brand:assets && git diff --exit-code -- apps/web/public/brand/kinda-mark-512.png apps/web/public/brand/favicon-32.png`

Expected: 생성 명령 종료 코드가 `0`이고 두 PNG에 재생성 diff가 없다.

Run: `pnpm --filter @led-control/web test`

Expected: 전체 Web Vitest가 통과한다.

Run: `pnpm --filter @led-control/web typecheck && pnpm --filter @led-control/web build`

Expected: 두 명령 모두 종료 코드 `0`이고 Vite가 brand public 자산을 `dist/brand`로 복사한다.

- [ ] **Step 5: 핵심 접점 Chromium 회귀를 실행한다.**

Run: `pnpm --filter @led-control/web exec playwright test e2e/calm-operations-auth-operator.spec.ts e2e/calm-operations-shell.spec.ts e2e/app-shell-recovery.spec.ts e2e/settings-floor-editor.spec.ts --project=chromium --workers=1`

Expected: 네 spec이 모든 기존 viewport·인증 복구·셸·맵 편집 계약과 새 브랜드 기대를 통과한다. 자동 Chromium은 Web software 증거이며 실제 모바일 WebView나 장비 검증으로 기록하지 않는다.

- [ ] **Step 6: 프로젝트 상태의 현재 행을 실행 완료로 갱신한다.**

작업 상태 표 최상단의 `킨다 O안 스위치 플립 브랜드 적용` 행을 다음 내용으로 교체한다.

```markdown
| 킨다 O안 스위치 플립 브랜드 적용 | 완료(소프트웨어) | 스위치 플립 SVG 정본과 재현 가능한 PNG·파비콘, HTML 한글 `킨다`를 조합한 공통 `KindaLogo`, 브라우저 메타데이터, 로그인·고객·운영자 셸의 사용자 노출 브랜드 교체를 완료했다. 브랜드 자산·메타데이터·화면 단위 테스트, 전체 Web Vitest, typecheck, production build와 핵심 접점 Chromium 회귀를 통과했다. 기술 package 이름과 API·DB·MQTT·BLE Mesh·firmware는 변경하지 않았고 모바일 스토어 아이콘, 인쇄 발주, 실물 장비 라벨, 실제 모바일 WebView·HIL은 범위 밖이다. [설계](superpowers/specs/2026-09-13-kinda-visual-identity-design.md) · [실행 계획](superpowers/plans/2026-09-13-kinda-brand-web-assets.md) |
```

- [ ] **Step 7: 최종 diff와 문서 경계를 검증한다.**

Run: `git diff --check`

Expected: 출력 없이 종료 코드 `0`이다.

Run: `git status --short`

Expected: 계획에 열거한 Web 파일과 `docs/project-status.md`만 변경되고 `docs/menus/*.md`는 없다.

- [ ] **Step 8: E2E와 완료 상태를 커밋한다.**

```bash
git add apps/web/e2e docs/project-status.md
git commit -m "test(web): verify kinda brand surfaces"
```

## 최종 완료 조건

- O안 스위치 플립 SVG가 유일한 마크 정본이고 PNG 재생성이 byte-for-byte 안정적이다.
- 로그인, desktop 고객 셸, 운영자 셸과 브라우저 제목에서 `킨다`가 노출된다.
- 320px 모바일에서 로그인·운영자 화면의 로고가 overflow를 만들지 않고, 고객 bottom navigation 동작은 변하지 않는다.
- 사용자 노출 Web 범위에서 `LED Control`과 임시 `LC` 마크가 남지 않는다.
- 기술 package 이름과 프로토콜 식별자, 메뉴 동작과 네 메뉴 현황 문서는 변경되지 않는다.
- Coral은 마크의 점등 면에만 제한되고 텍스트·주요 행동·상태 의미색으로 확장되지 않는다.
- 전체 Web Vitest, typecheck, production build, 핵심 접점 Chromium, 자산 재현성과 `git diff --check`가 통과한다.
