import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import type { FloorEditorState } from "../src/features/floor-editor/editor-types";
import { captureProductSourceHashes, installPerformanceProbe, runEditorCameraPath } from "./support/map-performance";
import {
  expectMinimumTouchTargets,
  expectMinimumTouchTargetsAfterScrolling,
  expectNoHorizontalOverflow
} from "./support/layout-assertions";

const editorState: FloorEditorState = {
  floor: {
    id: "floor-b2",
    siteId: "site-2",
    name: "B2",
    level: -2,
    mapRevision: 7,
    floorPlan: {
      imageUrl: "/demo/floor-b2.svg",
      sourceType: "image",
      originalFileUrl: "/demo/floor-b2.svg",
      renderedImageUrl: "/demo/floor-b2.svg",
      width: 1200,
      height: 800,
      version: 1
    }
  },
  fixtures: [{
    id: "fixture-1", name: "B2-L01", x: 120, y: 140, size: 20, ratedWatt: 40,
    brightness: 70, status: "online"
  }],
  objects: [],
  lightSlots: []
};

test.beforeEach(async ({ page }) => {
  await mockEditorApi(page);
});

test("performance harness samples actual camera movement without editing map data", async ({ page }, testInfo) => {
  await installPerformanceProbe(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/settings/floor-plans/floor-b2/edit?siteId=site-2");
  const canvas = page.getByTestId("floor-editor-canvas");
  await expect(canvas).toBeVisible();
  const before = await canvas.getAttribute("data-zoom");
  const result = await runEditorCameraPath(page);
  expect(result.frames.count).toBeGreaterThanOrEqual(120);
  expect(result.frames.p95Ms).toBeGreaterThan(0);
  expect(result.checkpoints[0].zoom).toBeGreaterThan(Number(before));
  expect(result.checkpoints[1].panX).toBeGreaterThan(result.checkpoints[0].panX);
  expect(result.checkpoints[2].panX).toBeCloseTo(result.checkpoints[0].panX, 0);
  expect(result.checkpoints[3].zoom).toBeCloseTo(Number(before), 2);
  expect(result.longTasks).not.toBeNull();
  await testInfo.attach("camera-performance.json", {
    body: JSON.stringify(result, null, 2), contentType: "application/json"
  });
});

for (const viewport of [
  { name: "desktop", width: 1440, height: 900 },
  { name: "tablet", width: 1024, height: 768 },
  { name: "mobile", width: 390, height: 844 },
  { name: "compact", width: 320, height: 740 }
]) {
  test(`floor editor remains usable on ${viewport.name}`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    await page.goto("/settings/floor-plans/floor-b2/edit?siteId=site-2");
    const sourceHashesBefore = await captureProductSourceHashes();
    const narrow = viewport.width < 1280;
    const toolsToggle = page.getByRole("button", { name: "도구 및 조명 패널" });
    const informationToggle = page.getByRole("button", { name: "편집 정보 패널" });

    await expect(page.getByRole("heading", { name: "B2 맵 편집" })).toBeVisible();
    if (narrow) await toolsToggle.click();
    await expect(page.getByRole("toolbar", { name: "맵 편집 도구" })).toBeVisible();
    await expect(page.getByLabel("B2 편집 캔버스")).toBeVisible();
    if (narrow) {
      await toolsToggle.click();
      await informationToggle.click();
    }
    await expect(page.getByRole("complementary", { name: "맵 편집 정보" })).toBeVisible();
    await expect(page.getByRole("complementary", { name: "속성 패널" })).toBeVisible();
    await page.getByRole("tab", { name: "자료" }).click();
    await expect(page.getByRole("region", { name: "맵 버전" })).toBeVisible();

    const layout = await page.evaluate(() => {
      const bounds = (selector: string) => {
        const box = document.querySelector(selector)?.getBoundingClientRect();
        return box ? { x: box.x, y: box.y, width: box.width, height: box.height, bottom: box.bottom, right: box.right } : null;
      };
      return {
        viewportWidth: window.innerWidth, viewportHeight: window.innerHeight,
        bodyWidth: document.body.scrollWidth, bodyHeight: document.body.scrollHeight,
        documentHeight: document.documentElement.scrollHeight,
        verticalOverflowPx: Math.max(0, document.documentElement.scrollHeight - window.innerHeight),
        shellWidth: document.querySelector<HTMLElement>('[data-testid="floor-editor-layout"]')?.parentElement?.getBoundingClientRect().width ?? 0,
        canvas: bounds('[data-testid="floor-editor-canvas"]'),
        toolbar: bounds('[aria-label="맵 편집 도구"]'),
        information: bounds('[aria-label="맵 편집 정보"]'),
        properties: bounds('[aria-label="속성 패널"]')
      };
    });
    const evidenceDirectory = resolve(import.meta.dirname, "../../../.local/cad-native-qa");
    await mkdir(evidenceDirectory, { recursive: true });
    const layoutPath = resolve(evidenceDirectory, `u1-layout-${viewport.width}.json`);
    await writeFile(layoutPath, JSON.stringify({ viewport, layout, sourceHashesBefore,
      sourceHashesAfter: await captureProductSourceHashes(),
      scope: "기존 이미지 fixture 편집기 관측. 좁은 화면은 정보 패널을 명시적으로 연 상태. U12 이후 측정이며 U1 개선/변경 전 기준선이 아님"
    }, null, 2));
    await testInfo.attach(`layout-${viewport.width}`, { path: layoutPath, contentType: "application/json" });
    expect(layout.bodyWidth).toBeLessThanOrEqual(layout.viewportWidth);
    expect(layout.shellWidth).toBeGreaterThan(viewport.width < 500 ? viewport.width - 40 : 800);
    await expectNoHorizontalOverflow(page);
    if (viewport.width <= 760) {
      await informationToggle.click();
      await toolsToggle.click();
      await page.getByRole("toolbar", { name: "맵 편집 도구" }).scrollIntoViewIfNeeded();
      await expectMinimumTouchTargets(page, '[aria-label="맵 편집 도구"]');
      await expectMinimumTouchTargetsAfterScrolling(page, '[data-field]:has(input[type="checkbox"])');
      await toolsToggle.click();
      await page.evaluate(() => window.scrollTo(0, 0));
      await expectMinimumTouchTargets(page, '[data-shell-navigation="compact"]');
      await expectMinimumTouchTargetsAfterScrolling(page, '[aria-label="설정 메뉴"]');
      await informationToggle.click();
    }
    await expectMinimumTouchTargetsAfterScrolling(page, '[data-testid="editor-revision-list"]');
    if (viewport.width <= 760) await expectMinimumTouchTargetsAfterScrolling(page, "[data-app-shell]");
    const path = resolve(evidenceDirectory, `u1-editor-panels-${viewport.width}.png`);
    await page.screenshot({ path, fullPage: true });
    await testInfo.attach(`editor-panels-${viewport.width}`, { path, contentType: "image/png" });
  });
}

test("map settings drive absolute grid snapping and contextual shape properties", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/settings/floor-plans/floor-b2/edit?siteId=site-2");

  const properties = page.getByRole("complementary", { name: "속성 패널" });
  await expect(properties.getByRole("heading", { name: "맵 설정" })).toBeVisible();
  await properties.getByLabel("격자 간격").fill("20");
  await properties.getByRole("button", { name: "맵 설정 적용" }).click();
  await expect(page.getByLabel("격자 스냅")).toBeChecked();

  const canvas = page.getByLabel("B2 편집 캔버스");
  await expect(canvas).toHaveAttribute("data-snap", "true");
  await expect(canvas).toHaveAttribute("data-grid-size", "20");
  await expect.poll(() => canvas.evaluate((element) => getComputedStyle(element).backgroundImage)).toBe("none");
  await expect.poll(() => canvas.evaluate((element) => {
    const konva = (window as unknown as { Konva?: { stages: Array<{ container(): HTMLDivElement; findOne(selector: string): unknown }> } }).Konva;
    const stage = konva?.stages.find((candidate) => candidate.container().closest('[data-testid="floor-editor-canvas"]') === element);
    return Boolean(stage?.findOne(".map-grid"));
  })).toBe(true);
  const box = await canvas.boundingBox();
  if (!box) throw new Error("editor canvas has no layout box");

  await page.getByRole("button", { name: "사각형" }).click();
  await page.mouse.move(box.x + 203, box.y + 163);
  await page.mouse.down();
  await page.mouse.move(box.x + 297, box.y + 242);
  await page.mouse.up();

  await expect(properties.getByRole("heading", { name: "네모" })).toBeVisible();
  await expect(properties.getByLabel("X")).toHaveValue("200");
  await expect(properties.getByLabel("Y")).toHaveValue("160");
  await expect(properties.getByLabel("너비")).toHaveValue("100");
  await expect(properties.getByLabel("높이")).toHaveValue("80");
  await expect(properties.getByLabel("채우기 색상")).toBeVisible();
  await expect(properties.getByLabel("텍스트 내용")).toHaveCount(0);

  await page.mouse.move(box.x + 250, box.y + 200);
  await page.mouse.down();
  await page.mouse.move(box.x + 273, box.y + 217);
  await expect(properties.getByLabel("X")).toHaveValue("200");
  await expect(properties.getByLabel("Y")).toHaveValue("160");
  await page.mouse.up();
  await expect(properties.getByLabel("X")).toHaveValue("220");
  await expect(properties.getByLabel("Y")).toHaveValue("180");
});

test("wheel always zooms while the move tool pans the map", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/settings/floor-plans/floor-b2/edit?siteId=site-2");
  const canvas = page.getByLabel("B2 편집 캔버스");
  const box = await canvas.boundingBox();
  if (!box) throw new Error("editor canvas has no layout box");

  await page.mouse.move(box.x + 500, box.y + 300);
  await page.mouse.wheel(0, 120);
  await expect.poll(async () => Number(await canvas.getAttribute("data-zoom"))).toBeLessThan(1);

  await page.getByRole("button", { name: "100%" }).click();
  await page.mouse.move(box.x + 500, box.y + 300);
  await page.mouse.wheel(0, -8);
  await expect.poll(async () => Number(await canvas.getAttribute("data-zoom"))).toBeGreaterThan(1);

  await page.getByRole("button", { name: "100%" }).click();
  await page.getByRole("button", { name: "이동" }).click();
  await page.mouse.move(box.x + 500, box.y + 300);
  await expect(canvas).toHaveCSS("cursor", "grab");
  await page.mouse.down();
  await page.mouse.move(box.x + 540, box.y + 330);
  await expect(canvas).toHaveCSS("cursor", "grabbing");
  await page.mouse.up();
  await expect(canvas).toHaveCSS("cursor", "grab");
  await expect(canvas).toHaveAttribute("data-pan-x", "40");
  await expect(canvas).toHaveAttribute("data-pan-y", "30");
});

test("object movement shows presentation-style alignment guides", async ({ page }) => {
  await page.unroute("**/*");
  await mockEditorApi(page, {
    ...editorState,
    objects: [
      mapObject("object-1", 100, 100, 100, 80),
      mapObject("object-2", 300, 100, 100, 80)
    ]
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/settings/floor-plans/floor-b2/edit?siteId=site-2");
  const canvas = page.getByLabel("B2 편집 캔버스");
  const box = await canvas.boundingBox();
  if (!box) throw new Error("editor canvas has no layout box");

  await page.mouse.move(box.x + 150, box.y + 140);
  await page.mouse.down();
  await page.mouse.move(box.x + 247, box.y + 185);
  await expect(canvas).toHaveAttribute("data-active-guides", "vertical,horizontal");
  await page.mouse.up();

  await expect(canvas).toHaveAttribute("data-active-guides", "");
  const properties = page.getByRole("complementary", { name: "속성 패널" });
  await expect(properties.getByLabel("X")).toHaveValue("200");
  await expect(properties.getByLabel("Y")).toHaveValue("140");
});

function mapObject(id: string, x: number, y: number, width: number, height: number) {
  return {
    id, floorId: "floor-b2", type: "rectangle" as const, x, y, width, height, points: null,
    rotation: 0, strokeColor: "#2563eb", fillColor: "#dbeafe", strokeWidth: 2,
    text: "", fontSize: null, zIndex: 1, locked: false, visible: true
  };
}

type MockEditorState = Omit<typeof editorState, "objects"> & { objects: ReturnType<typeof mapObject>[] };

async function mockEditorApi(page: Page, state: MockEditorState = editorState) {
  await page.route("**/*", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (!pathname.startsWith("/api/")) return route.continue();
    const path = pathname.replace(/^\/api/, "");
    if (path === "/auth/me") {
      return route.fulfill({ json: { user: {
        id: "user-1", organizationId: "org-1", organizationType: "customer", loginId: "demo_admin",
        name: "관리자", role: "admin", status: "active"
      } } });
    }
    if (path === "/sites") return route.fulfill({ json: [{ id: "site-2", name: "물류센터", customerName: "고객사" }] });
    if (path === "/sites/site-2/dashboard") {
      return route.fulfill({ json: {
        capabilities: { read: true, control: true, manage: true, commission: true },
        site: {
          id: "site-2",
          name: "물류센터",
          customerName: "고객사",
          installationStatus: "installed",
          address: "서울시 강남구",
          tariffKwhRate: 160,
          timeZone: "Asia/Seoul"
        },
        summary: { totalFixtures: 1, onlineFixtures: 1, faultFixtures: 0, averageBrightness: 70 },
        floors: [{ id: "floor-b2", name: "B2", level: -2, floorPlan: state.floor.floorPlan, meshControlGroups: [], fixtures: [] }],
        groups: [],
        gateways: []
      } });
    }
    if (path === "/floors/floor-b2/editor-state") return route.fulfill({ json: state });
    if (path === "/floors/floor-b2/editor-lease") return route.fulfill({ json: { editable: true, token: "test-lease", fence: 1 } });
    if (path === "/floors/floor-b2/editor-revisions") {
      return route.fulfill({ json: { items: [{
        revision: 7,
        snapshotSha256: "hash-7",
        changeSummary: { floorPlanChanged: true },
        restoredFromRevision: null,
        createdAt: "2026-08-06T03:00:00.000Z",
        actor: { displayName: "관리자" }
      }], nextCursor: null } });
    }
    return route.fulfill({ status: 404, json: { message: `Unhandled mock route: ${path}` } });
  });
}
