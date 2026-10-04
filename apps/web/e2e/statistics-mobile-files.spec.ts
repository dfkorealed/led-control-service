import { expect, test, type Page } from "@playwright/test";
import { installSettingsApiRoutes } from "./support/settings-api";
import { expectNoHorizontalOverflow } from "./support/layout-assertions";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";

const siteId = "99999999-9999-4999-8999-000000000001";
const reportId = "99999999-9999-4999-8999-000000000041";
const signedUrl = "https://files.example.test/report.pdf?signature=not-for-ui";
const requestedAt = "2026-10-03T00:00:00.000Z";
type Message = { type: string; documentId: string; requestId: string; byteLength?: number; mimeType?: string; fileName?: string; index?: number; dataBase64?: string };

async function setup(page: Page, native = true, targetLabel = "모바일 통계 현장") {
  await installSettingsApiRoutes(page, "admin", { ids: { siteId }, fixtures: [] });
  await page.route("**/energy/sites/*/report-targets", route => route.fulfill({ json: {
    siteId, timeZone: "Asia/Seoul", lastCompletedDate: "2026-09-30",
    targets: [{ scope: "site", identityId: siteId, label: "모바일 통계 현장" }]
  } }));
  await page.route("**/energy/sites/*/reports?*", route => route.fulfill({ json: {
    reports: [{ reportId, siteId, request: { from: "2026-09-01", to: "2026-09-30", scope: "site", identityId: siteId, format: "pdf" },
      status: "completed", progressPercent: 100, createdAt: requestedAt, startedAt: requestedAt, completedAt: requestedAt,
      expiresAt: "2026-10-10T00:00:00.000Z", failureCode: null, requestedAt,
      target: { scope: "site", identityId: siteId, label: targetLabel }, failure: null }], nextCursor: null, totalCount: 1
  } }));
  let descriptors = 0;
  await page.route("**/energy/sites/*/reports/*/download", route => {
    descriptors++;
    return route.fulfill({ json: { reportId, format: "pdf", downloadUrl: signedUrl, expiresInSeconds: 300 } });
  });
  await page.route(signedUrl, route => route.fulfill({ contentType: "application/pdf",
    headers: { "access-control-allow-origin": "*" }, body: "%PDF-1.7\ntransport-fixture" }));
  await page.route("**/energy/sites/*/exports/csv?*", route => route.fulfill({ contentType: "text/csv", body: "date,kwh\n2026-09-01,0" }));
  if (native) await page.addInitScript(() => {
    type Envelope = { type: string; requestId: string; documentId: string; index?: number; dataBase64?: string };
    const state = { messages: [] as Envelope[], received: 0, end: null as Envelope | null };
    Object.assign(window, { __statisticsFiles: state,
      __LED_CONTROL_NATIVE_DOCUMENT_ID__: "statistics-document",
      __LED_CONTROL_NATIVE_ENVIRONMENT__: { version: 1, type: "mobile.bootstrap", documentId: "statistics-document",
        requestId: "statistics-bootstrap", mobile: true, state: "active", online: true },
      ReactNativeWebView: { postMessage: (raw: string) => {
        const message = JSON.parse(raw) as Envelope;
        if (!message.type.startsWith("file.")) return;
        state.messages.push(message);
        let reply: Record<string, unknown> | null = null;
        if (message.type === "file.begin") { state.received = 0; reply = { type: "file.ack", nextIndex: 0, receivedBytes: 0 }; }
        if (message.type === "file.chunk") {
          state.received += atob(message.dataBase64!).length;
          reply = { type: "file.ack", nextIndex: message.index! + 1, receivedBytes: state.received };
        }
        if (message.type === "file.end") state.end = message;
        if (message.type === "file.cancel") reply = { type: "file.result", status: "cancelled" };
        if (reply) queueMicrotask(() => window.dispatchEvent(new CustomEvent("led-control:native-message", {
          detail: { version: 1, documentId: message.documentId, requestId: message.requestId, ...reply }
        })));
      } }
    });
  });
  await page.goto(`/statistics/reports?siteId=${siteId}`);
  await expect(page.getByRole("heading", { name: "보고서", exact: true })).toBeVisible();
  return { descriptors: () => descriptors };
}

async function messages(page: Page): Promise<Message[]> {
  return page.evaluate(() => (window as unknown as { __statisticsFiles: { messages: Message[] } }).__statisticsFiles.messages);
}
async function handoff(page: Page) {
  await page.evaluate(() => {
    const state = (window as unknown as { __statisticsFiles: { end: Message | null } }).__statisticsFiles;
    if (!state.end) throw new Error("No pending fixture handoff");
    window.dispatchEvent(new CustomEvent("led-control:native-message", {
      detail: { version: 1, documentId: state.end.documentId, requestId: state.end.requestId, type: "file.result", status: "handoff" }
    }));
  });
}
async function expectTouchButton(page: Page, name: string) {
  const button = page.getByRole("button", { name, exact: true });
  const box = await button.boundingBox();
  expect(box?.width).toBeGreaterThanOrEqual(44); expect(box?.height).toBeGreaterThanOrEqual(44);
}

test.use({ hasTouch: true, isMobile: true });
for (const width of [320, 390]) {
  test(`${width}px report dates remain whole with long names and 200 percent text`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 740 });
    await setup(page, true, "매우 긴 통계 대상 현장 이름 입구 물류센터 조명 관리 구역");
    const card = page.getByRole("list", { name: "모바일 보고서 생성 이력" }).getByRole("listitem");
    await expect(card.getByRole("heading")).toContainText("매우 긴 통계 대상");
    const period = card.locator("dt").filter({ hasText: /^기간$/ }).locator("..").locator("dd");
    const initialFontSize = await period.evaluate(node => parseFloat(getComputedStyle(node).fontSize));
    for (const scale of [100, 200]) {
      await page.evaluate(value => { document.documentElement.style.fontSize = `${value}%`; }, scale);
      expect(await period.evaluate(node => parseFloat(getComputedStyle(node).fontSize))).toBe(initialFontSize * scale / 100);
      await expect(period).toContainText("2026-09-01"); await expect(period).toContainText("2026-09-30");
      const dates = await period.evaluate(node => {
        return ["2026-09-01", "2026-09-30"].map(date => {
          const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
          let text: Node | null;
          while ((text = walker.nextNode())) {
            const offset = text.textContent!.indexOf(date);
            if (offset < 0) continue;
            const range = document.createRange(); range.setStart(text, offset); range.setEnd(text, offset + date.length);
            return Array.from(range.getClientRects()).map(rect => ({ left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom }));
          }
          return [];
        });
      });
      for (const rects of dates) {
        expect(rects).toHaveLength(1);
        expect(rects[0].left).toBeGreaterThanOrEqual(0); expect(rects[0].right).toBeLessThanOrEqual(width);
      }
      await expectNoHorizontalOverflow(page);
      await page.screenshot({ path: info.outputPath(`statistics-period-${width}-${scale}.png`), fullPage: true });
    }
  });

  test(`${width}px PDF native bytes stay pending until handoff without browser download`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 740 }); const api = await setup(page);
    const browserDownloads: string[] = []; page.on("download", download => browserDownloads.push(download.suggestedFilename()));
    const button = page.getByRole("list", { name: "모바일 보고서 생성 이력" }).getByRole("button", { name: "모바일 통계 현장 보고서 다운로드" });
    await button.tap();
    await expect.poll(async () => (await messages(page)).at(-1)?.type).toBe("file.end");
    await expect(button).toBeDisabled();
    const sent = await messages(page);
    expect(sent[0]).toMatchObject({ type: "file.begin", mimeType: "application/pdf", byteLength: 26 });
    expect(sent[0].fileName).toMatch(/\.pdf$/);
    const bytes = Buffer.concat(sent.filter(message => message.type === "file.chunk").map(message => Buffer.from(message.dataBase64!, "base64")));
    expect(bytes.toString()).toBe("%PDF-1.7\ntransport-fixture");
    expect(api.descriptors()).toBe(1);
    await expectTouchButton(page, "파일 준비 취소"); await expectNoHorizontalOverflow(page);
    await handoff(page);
    await expect(page.getByText("공유창을 닫았습니다.", { exact: true })).toBeVisible();
    await expect(button).toBeEnabled(); expect(browserDownloads).toEqual([]);
    await page.screenshot({ path: info.outputPath(`statistics-report-handoff-${width}.png`), fullPage: true });
  });

  test(`${width}px CSV cancellation preserves period and target for retry`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 740 }); await setup(page);
    await page.getByRole("button", { name: "보고서 만들기", exact: true }).tap();
    const dialog = page.getByRole("dialog", { name: "에너지 사용량 보고서 만들기" });
    await dialog.getByRole("button", { name: "CSV 내보내기", exact: true }).tap();
    await expect.poll(async () => (await messages(page)).at(-1)?.type).toBe("file.end");
    const before = await dialog.innerText();
    await expectTouchButton(page, "파일 준비 취소");
    await dialog.getByRole("button", { name: "파일 준비 취소", exact: true }).tap();
    await expect(dialog.getByText("파일 공유를 취소했습니다.", { exact: true })).toBeVisible();
    expect(await dialog.getByText("파일 공유를 취소했습니다.", { exact: true }).evaluate(node => {
      const rect = node.getBoundingClientRect();
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      return hit === node || node.contains(hit);
    })).toBe(true);
    await expect(dialog.getByRole("button", { name: "대상", exact: true })).toContainText("모바일 통계 현장");
    await expect(dialog.getByRole("button", { name: "CSV 내보내기", exact: true })).toBeEnabled();
    const action = dialog.getByRole("button", { name: "CSV 내보내기", exact: true });
    const actionBox = await action.boundingBox(), dialogBox = await dialog.boundingBox();
    expect(actionBox!.y + actionBox!.height).toBeLessThanOrEqual(dialogBox!.y + dialogBox!.height);
    if (width === 320) {
      const body = dialog.locator("[data-dialog-body]");
      const port = (await body.boundingBox())!;
      const beforeScroll = await body.evaluate(node => node.scrollTop);
      const cdp = await page.context().newCDPSession(page);
      try {
        const touch = (y: number) => [{ x: port.x + port.width / 2, y, id: 1 }];
        await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: touch(port.y + port.height - 20) });
        for (let step = 1; step <= 8; step++) {
          await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: touch(port.y + port.height - 20 - (port.height - 40) * step / 8) });
        }
        await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
        await expect.poll(() => body.evaluate(node => node.scrollTop)).toBeGreaterThan(beforeScroll);
        const target = (await dialog.getByRole("button", { name: "대상", exact: true }).boundingBox())!;
        expect(target.y + target.height).toBeLessThanOrEqual(port.y + port.height);
      } finally { await cdp.detach(); }
    }
    expect(before).toContain("기간 시작"); await expectNoHorizontalOverflow(page);
    await page.screenshot({ path: info.outputPath(`statistics-csv-cancelled-${width}.png`), fullPage: true });
  });
}

test("signed PDF expiry remains distinguishable from native write errors", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 740 }); await setup(page);
  await page.route(signedUrl, route => route.fulfill({ status: 403, headers: { "access-control-allow-origin": "*" }, body: "expired signature" }));
  await page.getByRole("list", { name: "모바일 보고서 생성 이력" }).getByRole("button", { name: "모바일 통계 현장 보고서 다운로드" }).tap();
  await expect(page.getByRole("alert")).toContainText("만료");
  expect(await messages(page)).toEqual([]);
  await expect(page.getByText(/not-for-ui|expired signature/)).toHaveCount(0);
});

test("native PDF network failure and size overflow never silently download in a browser", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 740 }); await setup(page);
  await page.route(signedUrl, route => route.abort("failed"));
  const button = page.getByRole("list", { name: "모바일 보고서 생성 이력" }).getByRole("button", { name: "모바일 통계 현장 보고서 다운로드" });
  await button.tap(); await expect(page.getByRole("alert")).toContainText("네트워크");
  await page.route(signedUrl, route => route.fulfill({ headers: { "content-length": "20971521", "access-control-allow-origin": "*" }, contentType: "application/pdf", body: "oversized" }));
  await button.tap(); await expect(page.getByRole("alert")).toContainText("20MiB");
  expect(await messages(page)).toEqual([]); await expectNoHorizontalOverflow(page);
});

test("ordinary browsers still download PDF and CSV bytes through their original paths", async ({ page }) => {
  const bytes = Buffer.from("%PDF-1.7\nbrowser-transport-fixture");
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/pdf", "content-disposition": "attachment; filename=report.pdf" });
    response.end(bytes);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing file fixture port");
    await page.setViewportSize({ width: 390, height: 740 }); await setup(page, false);
    await page.route("**/energy/sites/*/reports/*/download", route => route.fulfill({ json: {
      reportId, format: "pdf", downloadUrl: `http://127.0.0.1:${address.port}/report.pdf`, expiresInSeconds: 300
    } }));
    const pdf = page.waitForEvent("download");
    await page.getByRole("list", { name: "모바일 보고서 생성 이력" }).getByRole("button", { name: "모바일 통계 현장 보고서 다운로드" }).tap();
    const pdfPath = await (await pdf).path();
    if (!pdfPath) throw new Error("Missing PDF download");
    expect(await readFile(pdfPath)).toEqual(bytes);
    await page.getByRole("button", { name: "보고서 만들기", exact: true }).tap();
    const csv = page.waitForEvent("download");
    await page.getByRole("dialog").getByRole("button", { name: "CSV 내보내기", exact: true }).tap();
    const csvPath = await (await csv).path();
    if (!csvPath) throw new Error("Missing CSV download");
    expect(await readFile(csvPath, "utf8")).toBe("date,kwh\n2026-09-01,0");
    await expect(page.getByRole("dialog")).toHaveCount(0);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
