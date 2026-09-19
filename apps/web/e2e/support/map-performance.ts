import { expect, type Page, type Request } from "@playwright/test";
import { summarizeFrameTimes } from "../../src/features/map-scene/map-performance";

type Probe = {
  samples: number[];
  sampling: boolean;
  previous: number | null;
  longTasks: Array<{ startTime: number; duration: number }> | null;
};
declare global {
  interface Window { __mapPerformance: Probe }
}

export async function captureProductSourceHashes() {
  const paths = [
    "src/features/shells/CustomerShell.tsx", "src/features/settings/floor-plans/FloorEditorRoute.tsx",
    "src/features/floor-editor/FloorEditorView.tsx", "src/features/floor-editor/FloorEditorCanvas.tsx",
    "src/features/cad-scene/CadSceneRenderer.ts", "src/features/cad-scene/cad-scene-camera.ts",
    "src/features/cad-scene/cad-scene-worker.ts"
  ];
  const hashes: Record<string, string> = {};
  for (const path of paths) {
    hashes[path] = createHash("sha256").update(await readFile(resolve(import.meta.dirname, "../..", path))).digest("hex");
  }
  return { capturedAt: new Date().toISOString(), hashes,
    fingerprint: createHash("sha256").update(JSON.stringify(hashes)).digest("hex") };
}

export async function installPerformanceProbe(page: Page) {
  await page.addInitScript(() => {
    const probe: Probe = window.__mapPerformance = {
      samples: [], sampling: false, previous: null,
      longTasks: PerformanceObserver.supportedEntryTypes.includes("longtask") ? [] : null
    };
    if (probe.longTasks) {
      new PerformanceObserver(list => {
        for (const entry of list.getEntries()) {
          probe.longTasks!.push({ startTime: entry.startTime, duration: entry.duration });
        }
      }).observe({ type: "longtask", buffered: true });
    }
    const tick = (time: number) => {
      if (probe.sampling && probe.previous !== null) probe.samples.push(time - probe.previous);
      probe.previous = probe.sampling ? time : null;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

export async function readLongTasks(page: Page) {
  return page.evaluate(() => window.__mapPerformance.longTasks);
}

export async function runEditorCameraPath(page: Page) {
  const canvas = page.getByTestId("floor-editor-canvas");
  await page.getByRole("button", { name: "이동", exact: true }).click();
  await canvas.evaluate(element => element.scrollIntoView({ block: "center" }));
  const box = await canvas.boundingBox();
  if (!box) throw new Error("Camera path requires a visible editor canvas");
  const x = box.x + box.width / 2, y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  const startedAt = await page.evaluate(() => {
    window.__mapPerformance.samples = [];
    window.__mapPerformance.previous = null;
    window.__mapPerformance.sampling = true;
    return performance.now();
  });
  const checkpoints: Array<{ phase: string; zoom: number; panX: number; panY: number }> = [];
  const frame = () => page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
  const checkpoint = async (phase: string) => checkpoints.push(await canvas.evaluate((element, phase) => ({
    phase, zoom: Number(element.dataset.zoom), panX: Number(element.dataset.panX), panY: Number(element.dataset.panY)
  }), phase));
  try {
    // 고정 경로 v1: 4회 확대, 폭의 15% 왕복 드래그(각 64단계), 4회 축소.
    // 정지 프레임으로 120개를 채우지 않고 모든 단계에 실제 입력을 보낸다.
    for (let step = 0; step < 4; step++) { await page.mouse.wheel(0, -100); await frame(); }
    await checkpoint("zoom-in");
    await page.mouse.down();
    for (let step = 1; step <= 64; step++) {
      await page.mouse.move(x + box.width * 0.15 * step / 64, y);
      await frame();
    }
    // 제품은 이동 종료 시에만 확정 pan dataset을 갱신한다.
    await page.mouse.up();
    await checkpoint("pan-right");
    await page.mouse.down();
    for (let step = 1; step <= 64; step++) {
      await page.mouse.move(x + box.width * 0.15 * (1 - step / 64), y);
      await frame();
    }
    await page.mouse.up();
    await checkpoint("pan-return");
    for (let step = 0; step < 4; step++) { await page.mouse.wheel(0, 100); await frame(); }
    await checkpoint("zoom-out");
  } finally {
    await page.mouse.up();
    await page.evaluate(() => { window.__mapPerformance.sampling = false; });
  }
  const observation = await page.evaluate(startedAt => ({
    samples: window.__mapPerformance.samples,
    longTasks: window.__mapPerformance.longTasks?.filter(entry => entry.startTime >= startedAt) ?? null,
    elapsedMs: performance.now() - startedAt
  }), startedAt);
  const frames = summarizeFrameTimes(observation.samples);
  expect(frames.count, "movement must contain at least 120 measured rAF intervals").toBeGreaterThanOrEqual(120);
  return { pathVersion: 1, ...observation, frames, checkpoints };
}

export function observeHttpRequests(page: Page) {
  const records: Array<{
    url: string; method: string; status: number | null; failed: boolean;
    responseBodyBytes: number | null; responseHeaderBytes: number | null;
  }> = [];
  const indexes = new WeakMap<Request, number>();
  const pending = new Set<Promise<void>>();
  page.on("request", request => {
    indexes.set(request, records.length);
    records.push({ url: request.url(), method: request.method(), status: null, failed: false,
      responseBodyBytes: null, responseHeaderBytes: null });
  });
  page.on("requestfailed", request => {
    const index = indexes.get(request);
    if (index !== undefined) records[index].failed = true;
  });
  page.on("requestfinished", request => {
    const operation = (async () => {
      const index = indexes.get(request);
      if (index === undefined) return;
      try {
        records[index].status = (await request.response())?.status() ?? null;
        const sizes = await request.sizes();
        records[index].responseBodyBytes = sizes.responseBodySize;
        records[index].responseHeaderBytes = sizes.responseHeadersSize;
      } catch {
        // 취소되거나 계측이 지원되지 않는 응답은 0바이트로 성공 처리하지 않는다.
      }
    })();
    pending.add(operation);
    void operation.finally(() => pending.delete(operation));
  });
  return {
    mark: () => records.length,
    async snapshot(since = 0) {
      await Promise.all(pending);
      const selected = records.slice(since).map(record => ({ ...record }));
      const measured = selected.filter(record => record.responseBodyBytes !== null);
      return {
        requestCount: selected.length,
        failedRequestCount: selected.filter(record => record.failed).length,
        measuredResponseCount: measured.length,
        unmeasuredResponseCount: selected.length - measured.length,
        responseBodyBytes: measured.length ? measured.reduce((sum, record) => sum + record.responseBodyBytes!, 0) : null,
        responseHeaderBytes: measured.length ? measured.reduce((sum, record) => sum + record.responseHeaderBytes!, 0) : null,
        records: selected
      };
    }
  };
}
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
