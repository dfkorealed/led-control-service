import { expect, test } from "@playwright/test";
import {
  expectMinimumTouchTargets,
  expectMinimumTouchTargetsAfterScrolling
} from "./support/layout-assertions";

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

test("controls covered by another pointer target fail their reachable-area contract", async ({ page }) => {
  await page.setContent(`
    <main id="root" style="position: relative">
      <button style="width: 44px; height: 44px">가려짐</button>
      <div style="position: absolute; inset: 0; z-index: 2; background: white"></div>
    </main>
  `);

  await expect(expectMinimumTouchTargets(page, "#root")).rejects.toThrow(/Touch targets below 44px/);
});

test("normal visible reachable controls remain eligible", async ({ page }) => {
  await page.setContent(`
    <main id="root">
      <button style="width: 44px; height: 44px">정상</button>
    </main>
  `);

  await expectMinimumTouchTargets(page, "#root");
});

test("a 44px target at a fractional CSS position keeps its full reachable area", async ({ page }) => {
  await page.setContent(`
    <main id="root">
      <button style="position: fixed; left: 20.0625px; top: 20.0625px; width: 44px; height: 44px">fractional target</button>
    </main>
  `);

  await expectMinimumTouchTargets(page, "#root");
});

test("a 42px overlay leaves only a 2x44 strip and fails the reachable-area contract", async ({ page }) => {
  await page.setContent(`
    <main id="root" style="position: relative; width: 100px; height: 100px">
      <button style="position: absolute; left: 0; top: 0; width: 44px; height: 44px">좁은 노출</button>
      <div style="position: absolute; left: 2px; top: 0; z-index: 2; width: 42px; height: 44px"></div>
    </main>
  `);

  await expect(expectMinimumTouchTargets(page, "#root")).rejects.toThrow(/Touch targets below 44px/);
});

test("a fixed bottom navigation covering half a target leaves only 44x22 and fails", async ({ page }) => {
  await page.setContent(`
    <main id="root">
      <button style="position: fixed; left: 20px; bottom: 0; width: 44px; height: 44px">하단 대상</button>
      <nav style="position: fixed; inset: auto 0 0; z-index: 2; height: 22px; background: white">하단 메뉴</nav>
    </main>
  `);

  await expect(expectMinimumTouchTargets(page, "#root")).rejects.toThrow(/Touch targets below 44px/);
});

test("a fully covered target still fails when a normal peer is present", async ({ page }) => {
  await page.setContent(`
    <main id="root" style="position: relative">
      <button style="width: 44px; height: 44px">정상 peer</button>
      <button style="position: absolute; left: 60px; top: 0; width: 44px; height: 44px">완전 가림</button>
      <div style="position: absolute; left: 60px; top: 0; z-index: 2; width: 44px; height: 44px; background: white"></div>
    </main>
  `);

  await expect(expectMinimumTouchTargets(page, "#root")).rejects.toThrow(/완전 가림/);
});

test("a native choice can use a visible second associated label when the first is hidden", async ({ page }) => {
  await page.setContent(`
    <main id="root">
      <input id="multi-label-choice" type="radio" style="position: absolute; opacity: 0">
      <label for="multi-label-choice" hidden>숨긴 첫 label</label>
      <label for="multi-label-choice" style="display: flex; width: 100px; height: 44px">보이는 둘째 label</label>
    </main>
  `);

  await expectMinimumTouchTargets(page, "#root");
});

test("a native choice falls back to its visible input when its only label is hidden", async ({ page }) => {
  await page.setContent(`
    <main id="root">
      <input id="visible-choice" type="checkbox" aria-label="직접 선택" style="width: 44px; height: 44px">
      <label for="visible-choice" hidden>숨긴 label</label>
    </main>
  `);

  await expectMinimumTouchTargets(page, "#root");
});

test("a native choice fails when every associated label and the input are undersized", async ({ page }) => {
  await page.setContent(`
    <main id="root">
      <input id="small-choice" type="checkbox" style="width: 20px; height: 20px">
      <label for="small-choice" style="display: inline-block; width: 30px; height: 44px">좁은 label</label>
      <label for="small-choice" style="display: inline-block; width: 44px; height: 30px">낮은 label</label>
    </main>
  `);

  await expect(expectMinimumTouchTargets(page, "#root")).rejects.toThrow(/Touch targets below 44px/);
});

test("a viewport-fixed target escapes an overflow ancestor without a fixed containing block", async ({ page }) => {
  await page.setContent(`
    <main id="root" style="width: 10px; height: 10px; overflow: hidden">
      <button style="position: fixed; left: 100px; top: 100px; width: 44px; height: 44px">viewport fixed</button>
    </main>
  `);

  await expectMinimumTouchTargets(page, "#root");
});

test("a transformed overflow ancestor clips its fixed descendant", async ({ page }) => {
  await page.setContent(`
    <main id="root" style="position: relative; width: 10px; height: 10px; overflow: hidden; transform: translateZ(0)">
      <button style="position: fixed; left: 100px; top: 100px; width: 44px; height: 44px">contained fixed</button>
    </main>
  `);

  await expect(expectMinimumTouchTargets(page, "#root")).rejects.toThrow(/interactive target/i);
});

test("scrolling touch target helper inspects an undersized target below the viewport", async ({ page }) => {
  await page.setContent(`
    <main id="root" style="height: 60px; overflow-y: auto">
      <button style="width: 44px; height: 44px">첫 대상</button>
      <div style="height: 100px"></div>
      <button style="width: 20px; height: 20px">화면 밖 작은 대상</button>
    </main>
  `);

  await expect(expectMinimumTouchTargetsAfterScrolling(page, "#root")).rejects.toThrow(/화면 밖 작은 대상/);
});

test("scrolling touch target helper tries every associated label for a native choice", async ({ page }) => {
  await page.setContent(`
    <main id="root" style="width: 140px; height: 60px; overflow-y: auto">
      <input id="scroll-choice" type="radio" style="position: absolute; opacity: 0">
      <label for="scroll-choice" style="display: block; width: 30px; height: 44px">첫째</label>
      <label for="scroll-choice" style="display: block; width: 100px; height: 44px">둘째</label>
    </main>
  `);

  await expectMinimumTouchTargetsAfterScrolling(page, "#root");
});

test("scrolling touch target helper fails when a root has no eligible target", async ({ page }) => {
  await page.setContent('<main id="root">정적 콘텐츠</main>');

  await expect(expectMinimumTouchTargetsAfterScrolling(page, "#root")).rejects.toThrow(/interactive target/i);
});
