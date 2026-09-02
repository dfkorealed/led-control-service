import { expect, test } from "@playwright/test";
import { expectMinimumTouchTargets } from "./support/layout-assertions";

test("touch target helper inspects every visible enabled interactive descendant", async ({ page }) => {
  await page.setContent(`
    <main id="root">
      <button style="width: 44px; height: 44px">충분함</button>
      <a href="#target" style="display: block; width: 20px; height: 20px">너무 작음</a>
      <button disabled style="width: 10px; height: 10px">비활성</button>
      <button hidden style="width: 10px; height: 10px">숨김</button>
    </main>
  `);

  await expect(expectMinimumTouchTargets(page, "#root")).rejects.toThrow(/너무 작음/);
});

test("touch target helper fails when a root contains no eligible target", async ({ page }) => {
  await page.setContent('<main id="root" style="width: 200px; height: 200px">정적 콘텐츠</main>');

  await expect(expectMinimumTouchTargets(page, "#root")).rejects.toThrow(/interactive target/i);
});

test("touch target helper can exclude compact spatial markers while retaining the alternate selector", async ({ page }) => {
  await page.setContent(`
    <main id="root">
      <button data-spatial-map-marker="true" style="width: 24px; height: 24px">지도 마커</button>
      <label style="display: flex; min-width: 44px; min-height: 44px">
        조명 선택
        <select aria-label="조명 선택" style="min-width: 44px; min-height: 44px"><option>조명 1</option></select>
      </label>
    </main>
  `);

  await expectMinimumTouchTargets(page, "#root", { excludeSpatialMapMarkers: true });
});

test("transparent radio uses its 44px implicit label as the effective hit target", async ({ page }) => {
  await page.setContent(`
    <main id="root">
      <label style="display: flex; width: 100px; height: 44px">
        <input type="radio" style="position: absolute; opacity: 0">
        일괄 설정
      </label>
    </main>
  `);

  await expectMinimumTouchTargets(page, "#root");
});

test("transparent checkbox fails when its explicit label is undersized", async ({ page }) => {
  await page.setContent(`
    <main id="root">
      <input id="compact-choice" type="checkbox" style="position: absolute; opacity: 0">
      <label for="compact-choice" style="display: block; width: 40px; height: 44px">선택</label>
    </main>
  `);

  await expect(expectMinimumTouchTargets(page, "#root")).rejects.toThrow(/Touch targets below 44px/);
});

test("controls fully clipped by an overflow ancestor are not eligible targets", async ({ page }) => {
  await page.setContent(`
    <main id="root" style="position: relative; width: 100px; height: 100px; overflow: hidden">
      <button style="position: absolute; left: 150px; width: 44px; height: 44px">잘림</button>
    </main>
  `);

  await expect(expectMinimumTouchTargets(page, "#root")).rejects.toThrow(/interactive target/i);
});

test("controls hidden by an ancestor are not eligible targets", async ({ page }) => {
  await page.setContent(`
    <main id="root" style="opacity: 0">
      <button style="width: 44px; height: 44px">숨김</button>
    </main>
  `);

  await expect(expectMinimumTouchTargets(page, "#root")).rejects.toThrow(/interactive target/i);
});

test("fully offscreen controls are not eligible targets", async ({ page }) => {
  await page.setContent(`
    <main id="root">
      <button style="position: fixed; left: -10000px; width: 44px; height: 44px">화면 밖</button>
    </main>
  `);

  await expect(expectMinimumTouchTargets(page, "#root")).rejects.toThrow(/interactive target/i);
});

test("partially clipped controls use the reachable viewport intersection", async ({ page }) => {
  await page.setContent(`
    <main id="root">
      <button style="position: fixed; left: -10px; top: 20px; width: 44px; height: 44px">일부 잘림</button>
    </main>
  `);

  await expect(expectMinimumTouchTargets(page, "#root")).rejects.toThrow(/Touch targets below 44px/);
});

test("controls covered by another pointer target are not eligible", async ({ page }) => {
  await page.setContent(`
    <main id="root" style="position: relative">
      <button style="width: 44px; height: 44px">가려짐</button>
      <div style="position: absolute; inset: 0; z-index: 2; background: white"></div>
    </main>
  `);

  await expect(expectMinimumTouchTargets(page, "#root")).rejects.toThrow(/interactive target/i);
});

test("normal visible reachable controls remain eligible", async ({ page }) => {
  await page.setContent(`
    <main id="root">
      <button style="width: 44px; height: 44px">정상</button>
    </main>
  `);

  await expectMinimumTouchTargets(page, "#root");
});
