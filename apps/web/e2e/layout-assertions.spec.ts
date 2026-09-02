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
