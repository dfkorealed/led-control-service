import { chromium, expect, test as unconfiguredTest, type BrowserContext, type Locator, type Page, type TestInfo } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { energyReportListResponseSchema, type EnergyReportJob } from "@led-control/shared/energy-p2-contracts";
import {
  expectMinimumTouchTargets,
  expectMinimumTouchTargetsAfterScrolling,
  expectNoHorizontalOverflow
} from "./support/layout-assertions";
import { installMockApiBoundary } from "./support/mock-api-boundary";
import { StatisticsNativeZoomEvidence, validateNativePngContent, type NativePngContent } from "./support/statistics-native-zoom-evidence";
import { relative } from "node:path";

// Ordinary cases retain the same fixture precedence. A native persistent case
// uses the base test so it does not also instantiate an unused second browser.
const test = unconfiguredTest.extend({
  page: async ({ page, baseURL }, use) => {
    await installMockApiBoundary(page.context(), baseURL!);
    await installStatisticsFixtures(page);
    await use(page);
  }
});

// Synthetic validator fixtures never count as browser zoom evidence. A missing
// rejection could otherwise promote unrelated, stale or clipped bytes to proof.
const syntheticPng = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAIAAAB7QOjdAAAAD0lEQVR4nGP4z8DAwPAfAAcAAf9+CLHQAAAAAElFTkSuQmCC";
const syntheticPostStatePng = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAIAAAB7QOjdAAAAD0lEQVR4nGNg+M/w/z8DAAn9Av7Z9RhEAAAAAElFTkSuQmCC";
const syntheticBlankPng = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAIAAAB7QOjdAAAAC0lEQVR4nGNgAAMAAAcAAbKGrPQAAAAASUVORK5CYII=";
const syntheticWidePng = "iVBORw0KGgoAAAANSUhEUgAAAAMAAAABCAIAAACUgoPjAAAAEklEQVR4nGNg+M/w/z/DfwYGABX0A/2i5uhtAAAAAElFTkSuQmCC";
const syntheticWitness: NativePngContent = {
  data: syntheticPng, viewportWidth: 2, viewportHeight: 1
};
for (const invalid of [
  { name: "malformed base64", change: { data: "not!base64" } },
  { name: "non PNG bytes", change: { data: Buffer.from("JPEG is not PNG").toString("base64") } },
  { name: "truncated IHDR", change: { data: Buffer.from(syntheticPng, "base64").subarray(0, 20).toString("base64") } },
  { name: "blank original", change: { data: syntheticBlankPng } },
  { name: "full viewport mismatch", change: { viewportWidth: 3 } }
]) unconfiguredTest(`native PNG validator rejects ${invalid.name}`, async () => {
  expect(() => validateNativePngContent({ ...syntheticWitness, ...invalid.change })).toThrow();
});
unconfiguredTest("native PNG validator accepts a fresh full viewport original PNG", async () => {
  expect(() => validateNativePngContent(syntheticWitness)).not.toThrow();
});

// R43/R45 stream clocks are retired for the separately approved R46 primary;
// their original failure/RED/GREEN bytes remain immutable historical evidence.
// Controlled public responses exercise request ordering/retention, not actual200.
for (const scenario of ["ordered single pending candidate", "wrong pixels remain unapproved", "focus restored dialog open", "draft value changed", "draft dialog closed", "draft request emitted", "malformed response retained", "blank response retained", "wrong size response retained", "state drift retained", "target drift retained", "loader drift retained", "URL drift retained", "geometry drift retained", "source drift retained", "persistence failure detaches", "command error detaches", "timeout late response retained", "timeout late rejection handled"] as const) {
  unconfiguredTest(`native PNG snapshot ${scenario}`, async ({ page }, info) => {
    const openDraft = scenario.startsWith("draft ");
    await page.setContent(`<button id="trigger" aria-label="protocol trigger" aria-expanded="${openDraft}">Trigger</button>
      <div role="dialog" aria-label="protocol filter" ${openDraft ? "" : "hidden"}><div role="spinbutton" tabindex="0" aria-label="invalid year">2027</div><button>Next</button></div>
      <select id="zoomLevel"><option value="1">100%</option><option value="2">200%</option></select>
      <script>const trigger=document.querySelector('#trigger'),dialog=document.querySelector('[role=dialog]');
      trigger.addEventListener('click',()=>{dialog.hidden=false;trigger.setAttribute('aria-expanded','true')});
      document.addEventListener('keydown',event=>{if(event.key==='Escape'){${scenario === "focus restored dialog open" ? "" : "dialog.hidden=true;trigger.setAttribute('aria-expanded','false');"}trigger.focus()}});</script>`);
    const toggle = page.getByRole("button", { name: "protocol trigger" });
    const dialog = page.getByRole("dialog", { name: "protocol filter", exact: true });
    const trigger = openDraft ? dialog.getByRole("spinbutton", { name: "invalid year" }) : toggle;
    const profile = info.outputPath("synthetic-profile"); await mkdir(profile, { recursive: true });
    let detached = 0, requests = 0, responded = false, observations = 0, observationEntered = false, observationCompleted = false;
    let releaseObservation: (() => void) | undefined;
    const observationGate = new Promise<void>(resolve => { releaseObservation = resolve; });
    const calls: Array<{ method: string; params: unknown }> = [];
    let lateResolve: ((value: { data: string }) => void) | undefined, lateReject: ((reason: Error) => void) | undefined;
    const sourceFile = info.outputPath("controlled-source.txt"), sourceMetadata = info.outputPath("controlled-source-metadata.json");
    await writeFile(sourceFile, "unchanged controlled source");
    const originalSourceMetadata = process.env.TASK7_SOURCE_METADATA;
    if (scenario === "source drift retained") {
      await writeFile(sourceMetadata, JSON.stringify({ cwd: process.cwd(), sourceHashes: { [relative(process.cwd(), sourceFile)]: execFileSync("git", ["hash-object", sourceFile], { encoding: "utf8" }).trim() } }));
      process.env.TASK7_SOURCE_METADATA = sourceMetadata;
    }
    const cdp = {
      send: async (method: string, params?: unknown) => {
        calls.push({ method, params });
        if (method === "Browser.getVersion") return { protocolVersion: "1.3", product: "Chromium/Test", revision: "synthetic", userAgent: "synthetic", jsVersion: "synthetic" };
        if (method === "Target.getTargetInfo") return { targetInfo: { targetId: responded && scenario === "target drift retained" ? "other-target" : "owned-target", type: "page", title: "synthetic", url: "about:blank", attached: true, canAccessOpener: false } };
        if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "owned-target", loaderId: responded && scenario === "loader drift retained" ? "other-loader" : "loader", url: "about:blank", domainAndRegistry: "", securityOrigin: "://", mimeType: "text/html", secureContextType: "InsecureScheme", crossOriginIsolatedContextType: "NotIsolated", gatedAPIFeatures: [] } } };
        if (method === "Page.captureScreenshot") {
          expect(observationCompleted).toBe(true);
          if (scenario === "command error detaches") throw new Error("Controlled unsupported snapshot");
          if (scenario.startsWith("timeout ")) return new Promise<{ data: string }>((resolve, reject) => { lateResolve = resolve; lateReject = reject; });
          responded = true;
          if (scenario === "source drift retained") await writeFile(sourceFile, "changed controlled source");
          if (scenario === "state drift retained") await page.evaluate(() => {
            (document.querySelector('[role="dialog"]') as HTMLElement).hidden = false;
            document.querySelector("#trigger")!.setAttribute("aria-expanded", "true");
          });
          return { data: scenario === "malformed response retained" ? "not!base64" : scenario === "blank response retained" ? syntheticBlankPng
            : scenario === "wrong size response retained" ? syntheticWidePng : scenario === "wrong pixels remain unapproved" ? syntheticPng : syntheticPostStatePng };
        }
        if (["Page.getLayoutMetrics", "Page.startScreencast", "Page.stopScreencast", "Page.screencastFrameAck"].includes(method)) return {};
        throw new Error(`Unexpected controlled protocol method ${method}`);
      },
      on: () => undefined, off: () => undefined,
      detach: async () => {
        detached++;
        // Deliver while this owned controlled session is still detaching, not
        // after close; wait for actual IO/error retention, never a paint delay.
        if (scenario === "timeout late response retained") {
          lateResolve?.({ data: syntheticPostStatePng });
          await expect.poll(() => existsSync(info.outputPath("synthetic-protocol-response.json"))).toBe(true);
        }
        if (scenario === "timeout late rejection handled") {
          lateReject?.(new Error("Controlled late rejection"));
          await expect.poll(async () => {
            try { return JSON.parse(await readFile(info.outputPath("native-zoom-provenance.json"), "utf8")).snapshotRequests[0].responseError; }
            catch { return undefined; } // The existing manifest may be mid-write.
          }).toContain("Controlled late rejection");
        }
      }
    };
    const controlledPage = {
      url: () => responded && scenario === "URL drift retained" ? "about:blank#other-document" : "about:blank", bringToFront: async () => undefined, reload: async () => undefined,
      evaluate: async () => { const zoom = Number(await page.locator("#zoomLevel").inputValue()); return { innerWidth: 2 / zoom, innerHeight: 1 / zoom,
        outerWidth: 2, outerHeight: 1, dpr: zoom, clientWidth: 2 / zoom, clientHeight: 1 / zoom, scrollWidth: 2 / zoom, scrollHeight: 1 / zoom,
        scrollX: responded && scenario === "geometry drift retained" ? 1 : 0, scrollY: 0, browserEpochMs: Date.now(), visual: { width: 2 / zoom, height: 1 / zoom, scale: 1, offsetLeft: 0, offsetTop: 0, pageLeft: 0, pageTop: 0 } }; },
      mouse: { click: async (x: number, y: number) => { await page.mouse.click(x, y); } },
      keyboard: { press: async (key: string) => {
        await page.keyboard.press(key);
        if (scenario === "draft value changed") await trigger.evaluate(element => { element.textContent = "2028"; });
        if (scenario === "draft dialog closed" && key === "Shift+Tab") await dialog.evaluate(element => { (element as HTMLElement).hidden = true; });
        if (scenario === "draft request emitted") requests++;
      } }
    } as unknown as Page;
    const settings = { goto: async () => undefined, locator: () => page.locator("#zoomLevel"), bringToFront: async () => undefined, url: () => "chrome://settings/appearance" };
    const context = { newCDPSession: async () => cdp, newPage: async () => settings,
      browser: () => ({ newBrowserCDPSession: async () => ({ send: async () => ({ commandLine: `chromium --user-data-dir="${profile}"`, modelName: "synthetic", modelVersion: "synthetic", gpu: { devices: [], driverBugWorkarounds: [] } }), detach: async () => undefined }) }) } as unknown as BrowserContext;
    const blockedFramePath = info.outputPath("unwritable-original-directory");
    if (scenario === "persistence failure detaches") await mkdir(blockedFramePath);
    const evidenceInfo = scenario === "persistence failure detaches"
      ? { ...info, attach: info.attach.bind(info), outputPath: (...segments: string[]) => segments[0] === "synthetic-protocol-original.png" ? blockedFramePath : info.outputPath(...segments) } as TestInfo : info;
    const native = await StatisticsNativeZoomEvidence.create(context, controlledPage, evidenceInfo);
    let failure: unknown, stopFailure: unknown;
    try {
      await native.global200(context);
      const capturing = native.capture("synthetic-protocol", trigger, async () => {
        await expect(dialog).toBeVisible();
      }, openDraft ? ["Tab", "Shift+Tab"] : ["Escape"], {
        description: openDraft ? "unchanged open invalid draft and zero requests" : "named filter closed and collapsed trigger",
        observe: async () => {
          observations++;
          if (scenario === "ordered single pending candidate" && observations === 1) { observationEntered = true; await observationGate; }
          expect(await dialog.isVisible()).toBe(openDraft);
          if (openDraft) { await expect(trigger).toHaveText("2027"); expect(requests).toBe(0); }
          else await expect(toggle).toHaveAttribute("aria-expanded", "false");
          observationCompleted = true;
          return { dialogVisible: openDraft, rawYear: openDraft ? await trigger.textContent() : null, requests };
        }
      });
      if (scenario === "ordered single pending candidate") {
        await expect.poll(() => observationEntered).toBe(true);
        expect(calls.filter(call => call.method === "Page.captureScreenshot")).toEqual([]);
        releaseObservation!();
      }
      await capturing;
    } catch (error) { failure = error; } finally {
      try { await native.stop(); } catch (error) { stopFailure = error; }
      process.env.TASK7_SOURCE_METADATA = originalSourceMetadata;
    }
    const raw = JSON.parse(await readFile(info.outputPath("native-zoom-provenance.json"), "utf8"));
    const screenshotCalls = calls.filter(call => call.method === "Page.captureScreenshot");
    expect(calls.filter(call => /Screencast|screencastFrameAck/.test(call.method))).toEqual([]);
    const forbiddenRequest = scenario === "focus restored dialog open" || openDraft;
    expect(screenshotCalls).toHaveLength(forbiddenRequest ? 0 : 1);
    if (!forbiddenRequest) expect(screenshotCalls[0]!.params).toEqual({ format: "png", fromSurface: true, captureBeyondViewport: false, optimizeForSpeed: false });
    if (scenario === "ordered single pending candidate" || scenario === "wrong pixels remain unapproved") {
      expect(failure).toBeUndefined();
      expect(raw.captures[0].pixelApproval).toMatchObject({ status: "pending", reviewer: "root" });
      expect(raw.captures[0].finalStateBefore.value).toEqual({ dialogVisible: false, rawYear: null, requests: 0 });
      expect(raw.captures[0].finalStateAfter.value).toEqual(raw.captures[0].finalStateBefore.value);
      expect(raw.captures[0].png.sha256).toBe(scenario === "wrong pixels remain unapproved"
        ? "7ee5754129962f30174bd5178d9058ea9900e57f80dbfed6c42ae49e3890142a" : "f58942d84e1901b085e27421af6f9c2e2391dbc274d63d78998d55621ea3bb00");
      expect(raw.lastInput.dispatches.map((dispatch: { kind: string }) => dispatch.kind)).toEqual(["pointer", "key"]);
      expect(raw.lastInput.assertionsCompletedAt).toBeTruthy();
      expect(raw.captures[0]).not.toHaveProperty("frame"); expect(raw.captures[0]).not.toHaveProperty("ack");
      expect(raw.captures[0]).not.toHaveProperty("frameTimestamp");
      expect(observations).toBe(2);
    } else if (scenario === "persistence failure detaches") expect(String(failure)).toContain("EISDIR");
    else if (scenario === "source drift retained") expect(String(failure)).toContain("Unfrozen source");
    else if (["target drift retained", "loader drift retained", "URL drift retained", "geometry drift retained"].includes(scenario)) expect(String(failure)).toContain("Snapshot geometry/target/loader/URL drift");
    else if (scenario === "malformed response retained") expect(String(failure)).toContain("Malformed PNG base64");
    else if (scenario === "blank response retained") expect(String(failure)).toContain("Blank original PNG");
    else if (scenario === "wrong size response retained") expect(String(failure)).toContain("PNG viewport mismatch");
    else if (scenario === "command error detaches") expect(String(failure)).toContain("Controlled unsupported snapshot");
    else if (scenario.startsWith("timeout ")) expect(String(failure)).toContain("NEEDS_CONTEXT: snapshot response deadline");
    else expect(failure).toBeTruthy();
    expect(stopFailure).toBeUndefined(); expect(detached).toBe(1);
    if (!forbiddenRequest && scenario !== "command error detaches" && scenario !== "timeout late rejection handled") {
      expect(typeof raw.snapshotRequests[0].rawResponsePath).toBe("string");
      const response = JSON.parse(await readFile(raw.snapshotRequests[0].rawResponsePath, "utf8"));
      const want = scenario === "malformed response retained" ? "not!base64" : scenario === "blank response retained" ? syntheticBlankPng
        : scenario === "wrong size response retained" ? syntheticWidePng : scenario === "wrong pixels remain unapproved" ? syntheticPng : syntheticPostStatePng;
      expect(response).toEqual({ data: want });
      if (scenario !== "persistence failure detaches") {
        expect(await readFile(raw.snapshotRequests[0].imagePath)).toEqual(Buffer.from(want, "base64"));
      }
    }
    if (scenario === "timeout late rejection handled") expect(raw.snapshotRequests[0].responseError).toContain("Controlled late rejection");
  });
}

// Controlled public protocol responses characterize metadata collection only:
// these cases create no browser/zoom/frame and never qualify native evidence.
for (const scenario of ["initial persistence failure", "error-record persistence failure", "error-record persistence and detach failure"] as const) {
  unconfiguredTest(`native create IO ${scenario} preserves original failure and independent cleanup`, async ({}, info) => {
    const blocked = info.outputPath("blocked-preflight-directory"); await mkdir(blocked);
    const initialFailure = scenario === "initial persistence failure";
    const original = new Error("Controlled original Browser.getVersion failure");
    let blockWrites = initialFailure, pageDetached = 0, contextClosed = 0, queries = 0;
    const events: string[] = [];
    const context = {
      newCDPSession: async () => ({
        send: async (method: string) => {
          queries++; expect(method).toBe("Browser.getVersion");
          blockWrites = true; throw original;
        },
        detach: async () => {
          pageDetached++; events.push("page-detach");
          // Restore this fixture's real output only after detach is attempted,
          // so the final evidence write can retain the earlier actual EISDIR.
          if (!initialFailure) blockWrites = false;
          if (scenario === "error-record persistence and detach failure") throw new Error("Controlled Page detach failure");
        }
      }),
      close: async () => { contextClosed++; events.push("context-close"); }
    } as unknown as BrowserContext;
    const evidenceInfo = { ...info, outputPath: (...segments: string[]) =>
      segments[0] === "native-zoom-preflight.json" && blockWrites ? blocked : info.outputPath(...segments)
    } as TestInfo;
    let native: StatisticsNativeZoomEvidence | undefined;
    let failure: (Error & { cause?: Error & { code?: string } }) | undefined;
    try { native = await StatisticsNativeZoomEvidence.create(context, {} as Page, evidenceInfo); }
    catch (error) { failure = error as typeof failure; }
    finally { try { await native?.stop(); } finally { await context.close(); } }
    expect(pageDetached).toBe(1); expect(contextClosed).toBe(1);
    expect(events).toEqual(["page-detach", "context-close"]);
    expect(native).toBeUndefined(); expect(failure?.message).toContain("NEEDS_CONTEXT");
    expect(queries).toBe(initialFailure ? 0 : 1);
    if (initialFailure) {
      expect(failure?.cause?.code).toBe("EISDIR");
      expect(failure?.message).toContain("EISDIR");
    } else {
      expect(failure?.cause).toBe(original);
      expect(failure?.message).toContain("Controlled original Browser.getVersion failure");
      const raw = JSON.parse(await readFile(info.outputPath("native-zoom-preflight.json"), "utf8"));
      expect(raw.error).toMatchObject({ stage: "Browser.getVersion", message: "Error: Controlled original Browser.getVersion failure" });
      expect(raw.persistenceErrors).toEqual([expect.objectContaining({ stage: "error-record", message: expect.stringContaining("EISDIR") })]);
      if (scenario === "error-record persistence and detach failure") expect(raw.pageSessionCleanupError).toContain("Controlled Page detach failure");
      else expect(raw.pageSessionDetachedAt).toBeTruthy();
    }
  });
}

for (const scenario of ["actual command string", "unsupported", "empty command", "ambiguous profile"] as const) {
  unconfiguredTest(`native preflight preserves staged evidence for ${scenario}`, async ({}, info) => {
    const profile = info.outputPath("synthetic-profile"); await mkdir(profile, { recursive: true });
    const commandLine = scenario === "empty command" ? "" : scenario === "ambiguous profile"
      ? `chromium --user-data-dir=${profile} --user-data-dir=/another-profile`
      : `chromium --user-data-dir="${profile}" --window-size=1440,900`;
    let pageDetached = 0, browserDetached = 0;
    const version = { protocolVersion: "1.3", product: "Chromium/Test", revision: "synthetic", userAgent: "synthetic", jsVersion: "synthetic" };
    const pageSession = {
      send: async (method: string) => {
        if (method === "Browser.getVersion") return version;
        if (method === "Browser.getBrowserCommandLine") throw new Error("Command line not returned because --enable-automation not set.");
        if (method === "Target.getTargetInfo") return { targetInfo: { targetId: "owned-target", type: "page", title: "statistics", url: "http://127.0.0.1:16627/statistics", attached: true, canAccessOpener: false } };
        if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "owned-frame", loaderId: "loader", url: "http://127.0.0.1:16627/statistics", domainAndRegistry: "", securityOrigin: "http://127.0.0.1:16627", mimeType: "text/html", secureContextType: "SecureLocalhost", crossOriginIsolatedContextType: "NotIsolated", gatedAPIFeatures: [] } } };
        throw new Error(`Unexpected page method: ${method}`);
      }, detach: async () => { pageDetached++; }, off: () => undefined
    };
    const browserSession = {
      send: async (method: string) => {
        if (method !== "SystemInfo.getInfo") throw new Error(`Unexpected browser method: ${method}`);
        // The version must already be on disk BEFORE this fallible query.
        expect(existsSync(info.outputPath("native-zoom-preflight.json"))).toBe(true);
        const partial = JSON.parse(await readFile(info.outputPath("native-zoom-preflight.json"), "utf8"));
        expect(partial.version.product).toBe("Chromium/Test");
        if (scenario === "unsupported") throw new Error("SystemInfo unsupported");
        return { commandLine, modelName: "synthetic", modelVersion: "synthetic", gpu: { devices: [], driverBugWorkarounds: [] } };
      }, detach: async () => { browserDetached++; }
    };
    const context = { newCDPSession: async () => pageSession, browser: () => ({ newBrowserCDPSession: async () => browserSession }) } as unknown as BrowserContext;
    let native: StatisticsNativeZoomEvidence | undefined, failure: unknown;
    try { native = await StatisticsNativeZoomEvidence.create(context, {} as Page, info); } catch (error) { failure = error; }
    if (scenario === "actual command string") {
      expect(failure).toBeUndefined();
      const raw = JSON.parse(await readFile(info.outputPath("native-zoom-preflight.json"), "utf8"));
      expect(raw.commandLine).toEqual({ method: "SystemInfo.getInfo", raw: commandLine });
      expect(raw.profile).toBe(profile); expect(raw.target.targetInfo.targetId).toBe("owned-target");
      expect(raw.frameTree.frameTree.frame.id).toBe("owned-frame");
      await native!.stop();
    } else {
      expect(String(failure)).toContain("NEEDS_CONTEXT");
      expect(existsSync(info.outputPath("native-zoom-preflight.json"))).toBe(true);
      const raw = JSON.parse(await readFile(info.outputPath("native-zoom-preflight.json"), "utf8"));
      expect(raw.version.product).toBe("Chromium/Test"); expect(raw.error.stage).toBe("SystemInfo.getInfo");
      if (scenario !== "unsupported") expect(raw.systemInfo.commandLine).toBe(commandLine);
    }
    expect(browserDetached).toBe(1); expect(pageDetached).toBe(1);
  });
}

const generatedAt = "2026-08-26T00:00:00.000Z";
type RendererBrowserFixtures = {
  metadata: {
    schemaVersion: 2;
    displayManifest: Array<{ path: string; value: unknown }>;
    files: Record<"pdf", { byteLength: number; sha256: string }>;
  };
  pdf: { bytes: string; manifest: Array<{ path: string; value: unknown }> };
};
let downloadFixtureServer: Server | undefined;
test.afterEach(async ({}, info) => {
  if (process.env.E2E_REPORT_DOWNLOAD_ORIGIN) {
    const response = await fetch(`${process.env.E2E_REPORT_DOWNLOAD_ORIGIN}/__task7/report.pdf`, { method: "DELETE" });
    expect(response.status).toBe(204);
  }
  if (downloadFixtureServer) {
    downloadFixtureServer.closeAllConnections();
    await new Promise<void>((resolve, reject) => downloadFixtureServer!.close(error => error ? reject(error) : resolve()));
    const connections = await new Promise<number>((resolve, reject) => downloadFixtureServer!.getConnections((error, count) => error ? reject(error) : resolve(count)));
    await info.attach("owned-file-fixture-cleanup", { body: JSON.stringify({ pid: process.pid, utc: new Date().toISOString(), listening: downloadFixtureServer.listening, connections }), contentType: "application/json" });
    expect(downloadFixtureServer.listening).toBe(false); expect(connections).toBe(0);
    downloadFixtureServer = undefined;
  }
});

async function installStatisticsFixtures(page: Page) {
  await page.route("**/auth/me", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({
      user: {
        id: "user-1",
        organizationId: "organization-1",
        organizationType: "customer",
        loginId: "demo_admin",
        name: "Customer Admin",
        role: "admin",
        status: "active",
        mustChangePassword: false
      }
    })
  }));
  await page.route("**/sites/default/dashboard**", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify(dashboard("site-1"))
  }));
  await page.route("**/sites/*/dashboard**", (route) => {
    const siteId = new URL(route.request().url()).pathname.split("/")[3];
    return route.fulfill({ contentType: "application/json", body: JSON.stringify(dashboard(siteId)) });
  });
  await page.route("**/energy/sites/*/summary", (route) => {
    const siteId = new URL(route.request().url()).pathname.split("/")[4];
    return route.fulfill({ contentType: "application/json", body: JSON.stringify(summary(siteId)) });
  });
  await page.route("**/energy/sites/*/series?**", (route) => {
    const url = new URL(route.request().url());
    const siteId = url.pathname.split("/")[4];
    const granularity = url.searchParams.get("granularity") === "month" ? "month" : "day";
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(series(siteId, granularity, url.searchParams.get("from") ?? "", url.searchParams.get("to") ?? ""))
    });
  });
  await page.route("**/energy/sites/*/comparisons?**", (route) => {
    const url = new URL(route.request().url());
    const siteId = url.pathname.split("/")[4];
    const preset = comparisonPreset(url.searchParams.get("preset"));
    const outcome = siteId === "site-overuse"
      ? "overuse"
      : siteId === "site-empty" ? "unavailable" : "saving";
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(comparison(preset, outcome))
    });
  });
  await page.route("**/energy/sites/*/comparisons/range?**", (route) => {
    const url = new URL(route.request().url());
    return route.fulfill({ json: customComparison(url.searchParams.get("from") ?? "", url.searchParams.get("to") ?? "",
      url.pathname.split("/")[4]) });
  });
  // Large daily ticks reproduce the clipped leading digits found in visual QA.
  await page.route("**/energy/sites/*/rankings?**", (route) => {
    const url = new URL(route.request().url());
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(ranking(
        url.searchParams.get("dimension") ?? "floor",
        url.searchParams.get("metric") ?? "usage",
        url.searchParams.get("sort") ?? "desc",
        url.searchParams.get("from") ?? "2026-08-01",
        url.searchParams.get("to") ?? "2026-08-31",
        url.pathname.split("/")[4]
      ))
    });
  });
  await page.route("**/energy/sites/*/heatmap?**", route => route.fulfill({ json: heatmap(new URL(route.request().url())) }));
  await page.route("**/energy/sites/*/heatmap/observed-mean?**", route => route.fulfill({ json: observedMeanHeatmap(new URL(route.request().url())) }));
  await page.route("**/energy/sites/*/reports*", route => route.fulfill({ json: { reports: [], nextCursor: null, totalCount: 0 } }));
  await page.route("**/energy/sites/*/report-targets", route => route.fulfill({ json: {
    siteId: reportSiteId, timeZone: "Asia/Seoul", lastCompletedDate: "2026-09-11", targets: [
      { scope: "site", identityId: reportSiteId, label: "보고서 현장" },
      { scope: "fixture", identityId: "30000000-0000-4000-8000-000000000021", label: "조명 💡 이력" },
      { scope: "group", identityId: "30000000-0000-4000-8000-000000000031", label: "과거 그룹" }
    ]
  } }));
}

const reportSiteId = "30000000-0000-4000-8000-000000000001";
function heatmap(url: URL) {
  return { siteId: url.pathname.split("/")[4], timeZone: "Asia/Seoul", generatedAt, metric: url.searchParams.get("metric") ?? "energy",
    scope: url.searchParams.get("scope") ?? "floor", identityId: url.searchParams.get("identityId"),
    range: { from: url.searchParams.get("from"), to: url.searchParams.get("to") },
    cells: Array.from({ length: 168 }, (_, index) => ({ weekday: Math.floor(index / 24), hour: index % 24,
      value: index === 1 ? null : index === 0 ? 0 : url.searchParams.get("metric") === "brightness" ? 50 : 0.5 })) };
}
function observedMeanHeatmap(url: URL) {
  const base = heatmap(url);
  return { ...base, cells: base.cells.map((cell, index) => ({ ...cell,
    knownSeconds: index === 1 ? 1800 : 3600,
    expectedSeconds: 3600,
    observedLocalDays: 1,
    eligibleLocalDays: 1,
    coverageRate: index === 1 ? 0.5 : 1
  })) };
}
function browserReport(
  status: EnergyReportJob["status"],
  request: EnergyReportJob["request"] = {
    from: "2026-09-01", to: "2026-09-07", scope: "site", identityId: reportSiteId, format: "pdf"
  }
): EnergyReportJob {
  return { reportId: "30000000-0000-4000-8000-000000000041", siteId: reportSiteId,
    request, status,
    progressPercent: status === "processing" ? 40 : status === "completed" || status === "expired" ? 100 : 0,
    createdAt: generatedAt, startedAt: status === "queued" ? null : generatedAt,
    completedAt: status === "completed" || status === "expired" ? generatedAt : null,
    expiresAt: status === "completed" || status === "expired" ? "2026-09-19T00:00:00.000Z" : null,
    failureCode: status === "failed" ? "REPORT_GENERATION_FAILED" : null,
    target: { scope: request.scope, identityId: request.identityId, label: request.scope === "site" ? "보고서 현장" : `${request.scope} 이력 대상` },
    requestedAt: generatedAt,
    failure: status === "failed" ? { code: "generation_failed", message: "보고서를 생성하지 못했습니다.", action: "잠시 후 다시 생성해 주세요." } : null };
}

test("creates a PDF report, polls state, downloads actual renderer bytes, and retries", async ({ page }, info) => {
  test.setTimeout(60_000);
  const fixtures = JSON.parse(execFileSync("pnpm", ["--filter", "@led-control/api", "exec", "tsx", "test/support/render-report-browser-fixtures.ts"],
    { encoding: "utf8", maxBuffer: 30 * 1024 * 1024 })) as RendererBrowserFixtures;
  expect(fixtures.metadata.schemaVersion).toBe(2);
  const pdfBytes = Buffer.from(fixtures.pdf.bytes, "base64");
  expect(fixtures.metadata.files.pdf.byteLength).toBe(pdfBytes.byteLength);
  expect(fixtures.metadata.files.pdf.sha256).toBe(createHash("sha256").update(pdfBytes).digest("hex"));
  expect(fixtures.pdf.manifest).toEqual(fixtures.metadata.displayManifest);
  expect(fixtures.metadata.displayManifest).not.toEqual([]);
  await page.clock.install();
  // Chromium's anchor downloads can bypass request interception. A loopback server
  // provides deterministic file bytes without relying on a real worker or S3 account.
  let downloadOrigin = process.env.E2E_REPORT_DOWNLOAD_ORIGIN;
  if (downloadOrigin) {
    // A strict task-owned fixture can host the bytes on its already reserved
    // loopback port. Ordinary runs retain the existing ephemeral fixture.
    const uploaded = await fetch(`${downloadOrigin}/__task7/report.pdf`, { method: "POST", body: pdfBytes });
    expect(uploaded.status).toBe(201);
    downloadOrigin += "/__task7";
  } else {
  downloadFixtureServer = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/pdf",
      "content-disposition": "attachment; filename=\"report.pdf\"" });
    response.end(pdfBytes);
  });
  await new Promise<void>(resolve => downloadFixtureServer!.listen(0, "127.0.0.1", resolve));
  const address = downloadFixtureServer.address();
  if (!address || typeof address === "string") throw new Error("missing fixture port");
  downloadOrigin = `http://127.0.0.1:${address.port}`;
  }
  let records: EnergyReportJob[] = [];
  let downloadRequests = 0;
  const requests: unknown[] = [];
  await page.route("**/energy/sites/*/reports*", async route => {
    if (route.request().method() === "POST") {
      const request = route.request().postDataJSON(); requests.push(request);
      const job = browserReport("queued", request);
      records = [job]; await route.fulfill({ status: 202, json: job });
    } else await route.fulfill({ json: { reports: records, nextCursor: null, totalCount: records.length } });
  });
  await page.route("**/energy/sites/*/reports/*/download", async route => {
    downloadRequests++;
    const job = records[0];
    const downloadUrl = `${downloadOrigin}/report.${job.request.format}?signature=fresh-${downloadRequests}`;
    await page.route(downloadUrl, fileRoute => fileRoute.request().method() === "GET" ? fileRoute.continue() : fileRoute.abort("blockedbyclient"));
    await info.attach("owned-file-fixture-start", { body: JSON.stringify({ downloadUrl, port: new URL(downloadUrl).port, pid: process.pid, utc: new Date().toISOString() }), contentType: "application/json" });
    return route.fulfill({ json: { reportId: job.reportId, format: job.request.format, expiresInSeconds: 300,
      downloadUrl } });
  });
  await page.goto(`/statistics/reports?siteId=${reportSiteId}`);
  await expect(page.getByText("요청한 보고서가 없습니다.")).toBeVisible();
  const reportHistory = page.getByRole("region", { name: "요청한 보고서" });
  await page.getByRole("button", { name: "보고서 만들기" }).click();
  const dialog = page.getByRole("dialog", { name: "에너지 사용량 보고서 만들기" });
  await setDatePicker(dialog, "기간 시작", "2026-09-01");
  await setDatePicker(dialog, "기간 종료", "2026-09-07");
  await expect(dialog.getByRole("button", { name: "파일 형식" })).toHaveCount(0);
  await dialog.getByRole("button", { name: "보고서 요청" }).click();
  await expect(reportHistory.getByText("대기 중", { exact: true }).first()).toBeVisible();
  expect(downloadRequests).toBe(0);
  records = [browserReport("processing")];
  await page.clock.runFor(3000);
  await expect(reportHistory.getByText("생성 중 40%").first()).toBeVisible();
  await expect(reportHistory.getByRole("progressbar", { name: /보고서 생성 진행률/ }).first()).toHaveAttribute("aria-valuenow", "40");
  records = [browserReport("completed")];
  await page.clock.runFor(3000);
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: /보고서 다운로드$/ }).click();
  const file = await download;
  expect(file.suggestedFilename()).toBe("report.pdf");
  expect(await readFile((await file.path())!)).toEqual(pdfBytes);
  await expect(page.getByRole("region", { name: "에너지 보고서" })).not.toContainText(/예상|추정|coverage|known|unknown|forecast|baseline|탄소|배출|최적화/i);
  expect(requests).toEqual([browserReport("queued").request]);
  for (const status of ["failed", "expired"] as const) {
    records = [browserReport(status)];
    await page.reload();
    await expect(reportHistory.getByText(status === "failed" ? "생성 실패" : "만료됨", { exact: true }).first()).toBeVisible();
    await page.getByRole("button", { name: /보고서 다시 생성$/ }).click();
    await expect(reportHistory.getByText("대기 중", { exact: true }).first()).toBeVisible();
    expect(requests.at(-1)).toEqual(browserReport("queued").request);
  }
  expect(downloadRequests).toBe(1);
  await expect(page.getByRole("navigation", { name: "통계 메뉴" }).getByRole("link")).toHaveText(["개요", "사용 분석", "보고서"]);
});

for (const scenario of [
  { name: "reversed", dates: "requestedFrom=2026-09-20&requestedTo=2026-09-01", from: "2026-09-20", edits: [[5, "21"]] },
  { name: "impossible", dates: "requestedFrom=2026-02-31&requestedTo=2026-09-01", from: "2026-09-20", edits: [[5, "21"], [2, "20"], [1, "9"]] },
  { name: "partial", dates: "requestedFrom=2026-09-01", from: "2026-09-01", edits: [[5, "21"], [4, "9"], [3, "2026"]] }
] as const) test(`Task7 ${scenario.name} initial report date URL preserves raw input and query silence until manual repair`, async ({ page }, info) => {
  await page.clock.install();
  const historyRequests: Array<Record<string, string>> = [];
  const forbiddenRequests: string[] = [];
  page.on("request", request => {
    const url = new URL(request.url());
    if (/\/energy\/sites\/[^/]+\/(reports|exports\/csv)(\/|$)/.test(url.pathname) && request.method() !== "GET") forbiddenRequests.push(`${request.method()} ${url.pathname}`);
    if (url.pathname.endsWith("/exports/csv")) forbiddenRequests.push(`${request.method()} ${url.pathname}`);
  });
  await page.route("**/energy/sites/*/reports?**", route => {
    historyRequests.push(Object.fromEntries(new URL(route.request().url()).searchParams));
    return route.fulfill({ json: { reports: [browserReport("failed")], nextCursor: null, totalCount: 1 } });
  });
  const rawPath = `/statistics/reports?siteId=${reportSiteId}&query=original&limit=50&${scenario.dates}`;
  await page.goto(rawPath);
  const rawUrl = page.url();
  await expect(page.getByText("URL의 요청 기간을 직접 수정하거나 필터를 초기화해 주세요.")).toBeVisible();
  await expect(page.getByRole("navigation", { name: "페이지 이동" })).toHaveCount(0);
  await expect(page.getByRole("region", { name: "요청한 보고서", exact: true })).toHaveCount(0);
  await expect(page.getByText("보고서가 없습니다.", { exact: true })).toHaveCount(0);
  await page.getByRole("searchbox", { name: "보고서 검색" }).fill(" repaired search ");
  await page.clock.runFor(300);
  const filters = page.getByRole("search", { name: "보고서 이력 필터" });
  await chooseOption(page, filters, "상태", "생성 실패");
  const dialog = await openFilter(page, "보고서 조건");
  const segments = dialog.getByRole("group", { name: "요청 기간" }).getByRole("spinbutton");
  const originalSegments = await segments.allTextContents();
  await info.attach("raw-date-before-blur", { body: JSON.stringify({ utc: new Date().toISOString(), originalSegments, url: page.url(), historyRequests }), contentType: "application/json" });
  await dialog.getByRole("button", { name: "필터 닫기" }).click();
  await openFilter(page, "보고서 조건");
  await expect(segments).toHaveText(originalSegments);
  expect(page.url()).toBe(rawUrl); expect(historyRequests).toEqual([]); expect(forbiddenRequests).toEqual([]);
  for (const [index, value] of scenario.edits) {
    await segments.nth(index).fill(value);
    await info.attach("manual-date-edit", { body: JSON.stringify({ utc: new Date().toISOString(), index, value, segments: await segments.allTextContents(), url: page.url(), historyRequests }), contentType: "application/json" });
  }
  await dialog.getByRole("button", { name: "필터 닫기" }).click();
  await expect(page.getByRole("region", { name: "요청한 보고서", exact: true })).toBeVisible();
  expect(historyRequests.length).toBeGreaterThan(0);
  expect(historyRequests.every(query => query.requestedFrom === scenario.from && query.requestedTo === "2026-09-21")).toBe(true);
  expect(historyRequests.at(-1)).toEqual({ limit: "50", query: "repaired search", status: "failed", requestedFrom: scenario.from, requestedTo: "2026-09-21" });
  await page.goBack();
  await expect(page.getByText("URL의 요청 기간을 직접 수정하거나 필터를 초기화해 주세요.")).toBeVisible();
  expect(page.url()).toBe(rawUrl);
  const recoveredRequests = historyRequests.length;
  await page.clock.runFor(300);
  expect(historyRequests).toHaveLength(recoveredRequests);
  await page.goForward();
  await expect(page.getByRole("region", { name: "요청한 보고서", exact: true })).toBeVisible();
  expect(forbiddenRequests).toEqual([]);
  await expectNoHorizontalOverflow(page);
  await info.attach("invalid-report-url-recovery", { body: JSON.stringify({ utc: new Date().toISOString(), scenario: scenario.name, rawUrl, originalSegments, historyRequests, forbiddenRequests }), contentType: "application/json" });
});

test("Task7 valid history preserves a physically blurred partial request range without URL or query publication", async ({ page }, info) => {
  const historyRequests: string[] = [];
  await page.route("**/energy/sites/*/reports?**", route => {
    historyRequests.push(route.request().url());
    return route.fulfill({ json: { reports: [browserReport("failed")], nextCursor: null, totalCount: 1 } });
  });
  await page.goto(`/statistics/reports?siteId=${reportSiteId}&limit=50&requestedFrom=2026-09-01&requestedTo=2026-09-21`);
  await expect(page.getByRole("region", { name: "요청한 보고서", exact: true })).toBeVisible();
  const initialRequests = historyRequests.length, initialUrl = page.url();
  let dialog = await openFilter(page, "보고서 조건");
  let segments = dialog.getByRole("group", { name: "요청 기간" }).getByRole("spinbutton");
  await segments.nth(0).click(); for (let index = 0; index < 4; index++) await page.keyboard.press("Backspace");
  await segments.nth(3).click();
  await expect(segments).toHaveText(["연도", "9", "1", "2026", "9", "21"]);
  await dialog.getByRole("button", { name: "필터 닫기" }).click();
  dialog = await openFilter(page, "보고서 조건");
  segments = dialog.getByRole("group", { name: "요청 기간" }).getByRole("spinbutton");
  await expect(segments).toHaveText(["연도", "9", "1", "2026", "9", "21"]);
  expect(page.url()).toBe(initialUrl); expect(historyRequests).toHaveLength(initialRequests);
  await info.attach("working-range-physical-comparison", { body: JSON.stringify({ utc: new Date().toISOString(), initialUrl, segments: await segments.allTextContents(), historyRequests }), contentType: "application/json" });
});

for (const action of ["full-clear", "reset"] as const) test(`Task7 invalid partial history recovers only after deliberate ${action}`, async ({ page }, info) => {
  const historyRequests: Array<Record<string, string>> = [];
  await page.route("**/energy/sites/*/reports?**", route => {
    historyRequests.push(Object.fromEntries(new URL(route.request().url()).searchParams));
    return route.fulfill({ json: { reports: [browserReport("failed")], nextCursor: null, totalCount: 1 } });
  });
  await page.goto(`/statistics/reports?siteId=${reportSiteId}&query=original&limit=50&requestedFrom=2026-09-01`);
  const rawUrl = page.url();
  const dialog = await openFilter(page, "보고서 조건");
  const segments = dialog.getByRole("group", { name: "요청 기간" }).getByRole("spinbutton");
  await expect(segments).toHaveText(["2026", "9", "1", "연도", "월", "일"]);
  expect(page.url()).toBe(rawUrl); expect(historyRequests).toEqual([]);
  if (action === "reset") await dialog.getByRole("button", { name: "필터 초기화" }).click();
  else {
    for (const [index, count] of [[0, 4], [1, 1], [2, 1]]) {
      await segments.nth(index).click();
      for (let key = 0; key < count; key++) await page.keyboard.press("Backspace");
      if (index < 2) { expect(page.url()).toBe(rawUrl); expect(historyRequests).toEqual([]); }
    }
  }
  await dialog.getByRole("button", { name: "필터 닫기" }).click();
  await expect(page.getByRole("region", { name: "요청한 보고서", exact: true })).toBeVisible();
  expect(historyRequests).toEqual([{ limit: action === "reset" ? "20" : "50", query: "original" }]);
  const url = new URL(page.url());
  expect(url.searchParams.has("requestedFrom")).toBe(false); expect(url.searchParams.has("requestedTo")).toBe(false);
  await info.attach("deliberate-invalid-history-recovery", { body: JSON.stringify({ utc: new Date().toISOString(), action, rawUrl, repairedUrl: page.url(), historyRequests }), contentType: "application/json" });
});

test("Task7 independent report creation stays usable under invalid history without querying or normalizing its URL", async ({ page }, info) => {
  const historyRequests: string[] = [], createRequests: unknown[] = [];
  await page.route("**/energy/sites/*/reports**", route => {
    if (route.request().method() === "POST") {
      const request = route.request().postDataJSON(); createRequests.push(request);
      return route.fulfill({ status: 202, json: browserReport("queued", request) });
    }
    historyRequests.push(route.request().url());
    return route.fulfill({ json: { reports: [browserReport("failed")], nextCursor: null, totalCount: 1 } });
  });
  await page.goto(`/statistics/reports?siteId=${reportSiteId}&requestedFrom=2026-02-31&requestedTo=2026-09-01`);
  const rawUrl = page.url();
  await page.getByRole("button", { name: "보고서 만들기" }).click();
  const dialog = page.getByRole("dialog", { name: "에너지 사용량 보고서 만들기" });
  await expect(dialog.getByRole("button", { name: "보고서 요청" })).toBeEnabled();
  await expect(dialog.getByRole("button", { name: "CSV 내보내기" })).toBeEnabled();
  await dialog.getByRole("button", { name: "보고서 요청" }).click();
  await expect(dialog).toHaveCount(0);
  expect(createRequests).toEqual([{ from: "2026-08-13", to: "2026-09-11", scope: "site", identityId: reportSiteId, format: "pdf" }]);
  expect(historyRequests).toEqual([]); expect(page.url()).toBe(rawUrl);
  await expect(page.getByText("URL의 요청 기간을 직접 수정하거나 필터를 초기화해 주세요.")).toBeVisible();
  await info.attach("independent-create-invalid-history", { body: JSON.stringify({ utc: new Date().toISOString(), rawUrl, createRequests, historyRequests }), contentType: "application/json" });
});

test("searches and paginates 101 server records, restores filters, and returns to page one after creation", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const fixture = await installReportHistoryFixture(page);
  fixture.expectNextListQuery({ limit: "20" });
  await page.goto(`/statistics/reports?siteId=${reportSiteId}`);

  const pagination = page.getByRole("navigation", { name: "페이지 이동" });
  await expect(pagination.getByRole("status")).toContainText("1~20 / 101건");
  await expect(page.getByRole("table", { name: "보고서 생성 이력" }).locator("tbody tr")).toHaveCount(20);

  fixture.expectNextListQuery({ limit: "20", cursor: "offset-20" });
  await pagination.getByRole("button", { name: "다음 페이지" }).click();
  await expect(pagination.getByRole("status")).toContainText("21~40 / 101건");
  await expect(page.getByRole("table", { name: "보고서 생성 이력" }).getByText("부산 보고서 021")).toBeVisible();
  const pageTwoUrl = new URL(page.url());
  expect(pageTwoUrl.href.length).toBeLessThan(200);
  expect([...pageTwoUrl.searchParams.keys()].sort()).toEqual(["limit", "siteId"]);

  fixture.expectNextListQuery({ limit: "20", cursor: "offset-20" });
  await page.reload();
  await expect(pagination.getByRole("status")).toContainText("21~40 / 101건");
  await expect(page.getByRole("table", { name: "보고서 생성 이력" }).getByText("부산 보고서 021")).toBeVisible();

  fixture.expectNextListQuery({ limit: "20" });
  await pagination.getByRole("button", { name: "이전 페이지" }).click();
  await expect(pagination.getByRole("status")).toContainText("1~20 / 101건");
  await expect(page.getByRole("table", { name: "보고서 생성 이력" }).getByText("서울 본사")).toBeVisible();

  fixture.expectNextListQuery({ limit: "20", cursor: "offset-20" });
  await page.goBack();
  await expect(pagination.getByRole("status")).toContainText("21~40 / 101건");
  fixture.expectNextListQuery({ limit: "20" });
  await page.goForward();
  await expect(pagination.getByRole("status")).toContainText("1~20 / 101건");

  fixture.expectNextListQuery({ limit: "50" });
  await chooseOption(page, pagination, "페이지당 항목 수", "50개");
  await expect(pagination.getByRole("status")).toContainText("1~50 / 101건");
  fixture.expectNextListQuery({ limit: "100" });
  await chooseOption(page, pagination, "페이지당 항목 수", "100개");
  await expect(pagination.getByRole("status")).toContainText("1~100 / 101건");

  const filters = page.getByRole("search", { name: "보고서 이력 필터" });
  fixture.expectNextListQuery({ limit: "100", query: "서울" });
  await filters.getByRole("searchbox", { name: "보고서 검색" }).fill(" 서울 ");
  await expect(pagination.getByRole("status")).toContainText("1~8 / 8건");
  fixture.expectNextListQuery({ limit: "100", query: "서울", status: "completed" });
  await chooseOption(page, filters, "상태", "완료");
  await expect(pagination.getByRole("status")).toContainText("1~7 / 7건");
  await expect(filters.getByRole("button", { name: "파일 형식" })).toHaveCount(0);
  fixture.expectNextListQuery({ limit: "100", query: "서울", status: "completed", scope: "site" });
  await chooseOption(page, filters, "범위", "현장");
  await expect(pagination.getByRole("status")).toContainText("1~5 / 5건");
  fixture.expectNextListQuery({
    limit: "100",
    query: "서울",
    status: "completed",
    scope: "site",
    requestedFrom: "2026-09-08",
    requestedTo: "2026-09-10"
  });
  await setDateRangePicker(filters, "요청 기간", "2026-09-08", "2026-09-10");
  await expect(pagination.getByRole("status")).toContainText("1~3 / 3건");
  await expect(page.getByRole("table", { name: "보고서 생성 이력" }).getByText("서울 본사")).toBeVisible();
  await expect(page.getByRole("table", { name: "보고서 생성 이력" })).not.toContainText(/조건 불일치/);
  await expect(page).toHaveURL(/query=%EC%84%9C%EC%9A%B8/);

  fixture.expectNextListQuery({
    limit: "100",
    query: "서울",
    status: "completed",
    scope: "site",
    requestedFrom: "2026-09-08",
    requestedTo: "2026-09-10"
  });
  await page.reload();
  await expect(filters.getByRole("searchbox", { name: "보고서 검색" })).toHaveValue("서울");
  await expect(filters.getByRole("button", { name: "범위: 현장 조건 제거" })).toBeVisible();
  const restoredUrl = page.url();
  const restoredFilters = await openFilter(page, "보고서 조건");
  await expect(restoredFilters.getByRole("button", { name: "상태", exact: true })).toContainText("완료");
  await expect(restoredFilters.getByRole("button", { name: "범위", exact: true })).toContainText("현장");
  await restoredFilters.getByRole("button", { name: "필터 닫기" }).click();
  await expect(page).toHaveURL(restoredUrl);
  await expect(pagination.getByRole("status")).toContainText("1~3 / 3건");

  fixture.expectNextListQuery({
    limit: "100",
    status: "completed",
    scope: "site",
    requestedFrom: "2026-09-08",
    requestedTo: "2026-09-10"
  });
  await filters.getByRole("button", { name: "검색: 서울 조건 제거" }).click();
  await expect(filters.getByRole("searchbox", { name: "보고서 검색" })).toHaveValue("");
  await expect(pagination.getByRole("status")).toContainText("1~4 / 4건");
  await expect(page.getByRole("table", { name: "보고서 생성 이력" }).getByText("부산 검색 조건 불일치")).toBeVisible();

  fixture.expectNextListQuery({
    limit: "100",
    query: "서울",
    status: "completed",
    scope: "site",
    requestedFrom: "2026-09-08",
    requestedTo: "2026-09-10"
  });
  await filters.getByRole("searchbox", { name: "보고서 검색" }).fill("서울");
  await expect(pagination.getByRole("status")).toContainText("1~3 / 3건");

  fixture.expectNextListQuery({ limit: "100" });
  await filters.getByRole("button", { name: "전체 초기화" }).click();
  await expect(pagination.getByRole("status")).toContainText("1~100 / 101건");
  await expect(filters.getByLabel("활성 조건", { exact: true })).toHaveCount(0);
  await expect(filters.getByRole("searchbox", { name: "보고서 검색" })).toHaveValue("");
  const resetFilters = await openFilter(page, "보고서 조건");
  await expect(resetFilters.getByRole("button", { name: "상태", exact: true })).toContainText("전체 상태");
  await expect(resetFilters.getByRole("button", { name: "범위", exact: true })).toContainText("전체 범위");
  await expect(resetFilters.getByRole("group", { name: "요청 기간" })).toBeVisible();
  await resetFilters.getByRole("button", { name: "필터 닫기" }).click();
  expect(new URL(page.url()).searchParams.get("limit")).toBe("100");
  expect([...new URL(page.url()).searchParams.keys()].sort()).toEqual(["limit", "siteId"]);

  fixture.expectNextListQuery({ limit: "100", cursor: "offset-100" });
  await pagination.getByRole("button", { name: "다음 페이지" }).click();
  await expect(pagination.getByRole("status")).toContainText("101~101 / 101건");
  await expect(page.getByRole("table", { name: "보고서 생성 이력" }).getByText("부산 보고서 101")).toBeVisible();
  fixture.expectNextListQuery({ limit: "100" });
  await page.getByRole("button", { name: "보고서 만들기" }).click();
  await page.getByRole("dialog", { name: "에너지 사용량 보고서 만들기" }).getByRole("button", { name: "보고서 요청" }).click();
  await expect(pagination.getByRole("status")).toContainText("1~100 / 102건");
  await expect(page.getByRole("region", { name: "요청한 보고서" }).getByText("대기 중", { exact: true }).first()).toBeVisible();
  expect(fixture.createdRequests).toHaveLength(1);

  fixture.expectNextListQuery({ limit: "100", query: "존재하지 않는 대상" });
  await filters.getByRole("searchbox", { name: "보고서 검색" }).fill("존재하지 않는 대상");
  await expect(page.getByText("요청한 보고서가 없습니다.")).toBeVisible();
  await expect(pagination.getByRole("status")).toContainText("0건");
  fixture.expectAllListQueriesObserved();
});

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 1024, height: 768 },
  { width: 390, height: 844 },
  { width: 320, height: 740 }
] as const) {
  test(`report history uses the accessible responsive surface at ${viewport.width}x${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await installReportHistoryFixture(page);
    await page.goto(`/statistics/reports?siteId=${reportSiteId}&query=%EC%84%9C%EC%9A%B8&scope=site&requestedFrom=2026-09-07&requestedTo=2026-09-11`);

    const tableWidth = await page.getByRole("region", { name: "요청한 보고서" }).evaluate(element => element.clientWidth);
    if (tableWidth >= 950) {
      await expect(page.getByRole("table", { name: "보고서 생성 이력" })).toBeVisible();
      await expect(page.getByRole("list", { name: "보고서 생성 이력" })).toBeHidden();
    } else {
      await expect(page.getByRole("list", { name: "보고서 생성 이력" })).toBeVisible();
      await expect(page.getByRole("table", { name: "보고서 생성 이력" })).toBeHidden();
    }

    await expectNoHorizontalOverflow(page);
    const filters = page.getByRole("search", { name: "보고서 이력 필터" });
    const pagination = page.getByRole("navigation", { name: "페이지 이동" });
    const dateTrigger = filters.getByRole("button", { name: /보고서 조건 상세 필터/ });
    await expect(filters.getByRole("button", { name: "범위: 현장 조건 제거" })).toBeVisible();
    const visibleHistory = tableWidth >= 950
      ? page.getByRole("table", { name: "보고서 생성 이력" })
      : page.getByRole("list", { name: "보고서 생성 이력" });
    const touchTargets = [
      filters.getByRole("searchbox", { name: "보고서 검색" }),
      dateTrigger,
      visibleHistory.getByRole("button", { name: /보고서 다운로드$/ }).first(),
      visibleHistory.getByRole("button", { name: /보고서 다시 생성$/ }).first(),
      visibleHistory.getByRole("button", { name: /실패 상세 보기$/ }).first(),
      filters.getByRole("button", { name: "전체 초기화" }),
      ...await filters.getByRole("button", { name: /조건 제거$/ }).all()
    ];
    for (const target of touchTargets) {
      await expectLocatorTouchTarget(target, `${viewport.width}px visible interactive target`);
    }
    await dateTrigger.click();
    const dateDialog = page.getByRole("dialog", { name: "보고서 조건" });
    for (const label of ["상태", "범위", "페이지 크기"]) await expectLocatorTouchTarget(dateDialog.getByRole("button", { name: label, exact: true }), `${viewport.width}px ${label}`);
    await expect(dateDialog.getByRole("group", { name: "요청 기간" })).toBeVisible();
    for (const target of await dateDialog.getByRole("group", { name: "요청 기간" }).getByRole("spinbutton").all()) {
      await expectLocatorTouchTarget(target, `${viewport.width}px request-date segment`);
    }
    await dateDialog.press("Escape");
    await expect(dateTrigger).toBeFocused();
    const reset = filters.getByRole("button", { name: "전체 초기화" });
    await reset.focus();
    await expect(reset).toBeFocused();
    expect(await reset.evaluate((element) => getComputedStyle(element).boxShadow)).not.toBe("none");

    await visibleHistory.getByRole("button", { name: "서울 상태 조건 불일치 실패 상세 보기" }).click();
    await expect(page.getByRole("region", { name: "서울 상태 조건 불일치 실패 안내" })).toContainText("보고서를 생성하지 못했습니다.");
    await reset.click();
    await expect(pagination.getByRole("status")).toContainText("1~20 / 101건");
    const next = pagination.getByRole("button", { name: "다음 페이지" });
    await expectLocatorTouchTarget(next, `${viewport.width}px enabled next-page target`);
    await next.click();
    await expect(pagination.getByRole("status")).toContainText("21~40 / 101건");
    await expectLocatorTouchTarget(
      pagination.getByRole("button", { name: "이전 페이지" }),
      `${viewport.width}px enabled previous-page target`
    );
    await expectNoHorizontalOverflow(page);
  });
}

test("Atlas desktop statistics surfaces keep filter rows compact and all heatmap hours visible", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/statistics/reports?siteId=${reportSiteId}`);
  const reportFilters = page.getByRole("search", { name: "보고서 이력 필터" });
  const reportControls = [
    reportFilters.getByRole("searchbox", { name: "보고서 검색" }),
    reportFilters.getByRole("button", { name: /보고서 조건 상세 필터/ })
  ];
  const reportRects = await Promise.all(reportControls.map((control) => control.boundingBox()));
  expect(reportRects.every(Boolean)).toBe(true);
  expect(Math.max(...reportRects.map((rect) => rect!.y)) - Math.min(...reportRects.map((rect) => rect!.y))).toBeLessThanOrEqual(2);
  const reportsImage = testInfo.outputPath("statistics-reports-1440.png");
  await page.screenshot({ path: reportsImage, fullPage: true });
  await testInfo.attach("statistics-reports-1440", { path: reportsImage, contentType: "image/png" });

  await page.route("**/energy/sites/*/rankings?**", (route) => {
    const url = new URL(route.request().url());
    const model = ranking(url.searchParams.get("dimension") ?? "floor", url.searchParams.get("metric") ?? "usage",
      url.searchParams.get("sort") ?? "desc", url.searchParams.get("from") ?? "", url.searchParams.get("to") ?? "",
      url.pathname.split("/")[4]);
    model.ranked[0].dailyPoints = [
      { period: "2026-08-24", estimatedKwh: 1_000_000, dataStatus: "available" },
      { period: "2026-08-25", estimatedKwh: 900_000, dataStatus: "available" }
    ];
    return route.fulfill({ json: model });
  });
  await page.goto(`/statistics/analysis?siteId=${reportSiteId}`);
  const filterCard = page.getByRole("region", { name: "사용량 분석 조건" });
  await expect(filterCard.getByRole("button", { name: /사용량 분석 조건 상세 필터/ })).toBeVisible();
  const compactBounds = (await filterCard.boundingBox())!;
  await testInfo.attach("compact-analysis-bounds", { body: JSON.stringify({ utc: new Date().toISOString(), compactBounds, summary: await filterCard.innerText() }), contentType: "application/json" });
  expect(compactBounds.height).toBeLessThan(125);
  const analysisFilters = await openFilter(page, "사용량 분석 조건");
  for (const control of [analysisFilters.getByRole("group", { name: "분석 단위" }), analysisFilters.getByRole("button", { name: "순위 기준" }), analysisFilters.getByRole("group", { name: "시작일" }), analysisFilters.getByRole("group", { name: "종료일" }), analysisFilters.getByRole("button", { name: /높은 순|낮은 순/ })]) await expect(control).toBeVisible();
  await analysisFilters.getByRole("button", { name: "필터 닫기" }).click();

  const detail = page.getByRole("complementary", { name: /상세$/ });
  expect((await detail.boundingBox())!.height, "desktop ranking detail should not create a large empty ranking column").toBeLessThanOrEqual(460);
  const chart = detail.locator(".recharts-wrapper");
  const chartLeft = (await chart.boundingBox())!.x;
  const yTicks = chart.locator('svg text[orientation="left"]');
  expect(await yTicks.count()).toBeGreaterThan(0);
  for (const tick of await yTicks.all()) {
    expect((await tick.boundingBox())!.x).toBeGreaterThanOrEqual(chartLeft);
    const leftEdge = await tick.evaluate((element) => {
      const label = element as SVGTextElement;
      return Number(label.getAttribute("x")) - label.getComputedTextLength();
    });
    expect(leftEdge, "numeric Y-axis glyphs remain inside the SVG viewport").toBeGreaterThanOrEqual(0);
  }
  const heatmapPanel = page.getByRole("region", { name: "시간대별 사용량" });
  const scroller = heatmapPanel.getByLabel("시간대별 사용량 표를 가로로 스크롤");
  const hour23 = heatmapPanel.getByRole("group", { name: "시간대별 에너지 사용량" }).getByText("23", { exact: true });
  const panelRect = (await scroller.boundingBox())!;
  const lastHourRect = (await hour23.boundingBox())!;
  expect(lastHourRect.x + lastHourRect.width).toBeLessThanOrEqual(panelRect.x + panelRect.width + 1);
  await expectNoHorizontalOverflow(page);
  const analysisImage = testInfo.outputPath("statistics-analysis-1440.png");
  await page.screenshot({ path: analysisImage, fullPage: true });
  await testInfo.attach("statistics-analysis-1440", { path: analysisImage, contentType: "image/png" });
});

test("selects analytics fixture/group history and bounds dates to the site's completed day", async ({ page }) => {
  const requests: Array<{ scope: string; identityId: string; to: string }> = [];
  await page.route("**/energy/sites/*/reports*", async route => {
    if (route.request().method() === "POST") {
      const request = route.request().postDataJSON(); requests.push(request);
      await route.fulfill({ status: 202, json: browserReport("queued", request) });
    } else await route.fulfill({ json: { reports: [], nextCursor: null, totalCount: 0 } });
  });
  await page.goto(`/statistics/reports?siteId=${reportSiteId}`);
  for (const [scope, identityId] of [["fixture", "30000000-0000-4000-8000-000000000021"], ["group", "30000000-0000-4000-8000-000000000031"]]) {
    await page.getByRole("button", { name: "보고서 만들기" }).click();
    const dialog = page.getByRole("dialog", { name: "에너지 사용량 보고서 만들기" });
    await expectDatePicker(dialog, "기간 종료", "2026-09-11");
    const endDate = dialog.getByRole("group", { name: "기간 종료" });
    const endDay = endDate.getByRole("spinbutton").nth(2);
    await endDay.focus();
    await page.keyboard.press("ArrowUp");
    await expect(dialog.getByRole("button", { name: "보고서 요청" })).toBeDisabled();
    await endDate.getByRole("button").click();
    await expect(page.getByRole("button", { name: /2026년 9월 12일/ })).toHaveAttribute("aria-disabled", "true");
    await page.keyboard.press("Escape");
    await endDay.focus();
    await page.keyboard.press("ArrowDown");
    await expect(dialog.getByRole("button", { name: "보고서 요청" })).toBeEnabled();
    await chooseOption(page, dialog, "범위", scope === "fixture" ? "조명" : "그룹");
    await expect(dialog.getByRole("button", { name: "대상" })).toContainText(scope === "fixture" ? "조명 💡 이력" : "과거 그룹");
    await dialog.getByRole("button", { name: "보고서 요청" }).click();
    await expect(dialog).not.toBeVisible();
    expect(requests.at(-1)).toMatchObject({ scope, identityId, to: "2026-09-11" });
  }
});

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 1024, height: 768 },
  { width: 390, height: 844 },
  { width: 320, height: 740 }
] as const) {
  test(`heatmap and report controls remain usable without document overflow at ${viewport.width}px`, async ({ page }, testInfo) => {
    const { width } = viewport;
    await page.setViewportSize(viewport);
    await page.goto(`/statistics/analysis?siteId=${reportSiteId}`);
    const rankingBounds = await page.getByRole("region", { name: "사용량 순위" }).boundingBox();
    const detailBounds = await page.getByRole("complementary", { name: /상세$/ }).boundingBox();
    expect(rankingBounds).not.toBeNull();
    expect(detailBounds).not.toBeNull();
    if (width >= 1024) {
      expect(Math.abs(rankingBounds!.y - detailBounds!.y), `${width}px analysis cards share one row`).toBeLessThanOrEqual(2);
      expect(detailBounds!.x, `${width}px detail follows ranking horizontally`).toBeGreaterThan(rankingBounds!.x + rankingBounds!.width - 2);
    } else {
      expect(detailBounds!.y, `${width}px detail stacks below ranking`).toBeGreaterThan(rankingBounds!.y + rankingBounds!.height - 2);
    }
    const energyGrid = page.getByRole("group", { name: "시간대별 에너지 사용량" });
    await expect(energyGrid.getByRole("button")).toHaveCount(168);
    const sunday00 = energyGrid.getByRole("button", { name: /일요일 00시, 평균 0 kWh, 수집률 100%/ });
    await sunday00.focus();
    await page.keyboard.press("ArrowRight");
    const sunday01 = energyGrid.getByRole("button", { name: /일요일 01시, 평균 산정 불가, 수집률 50%/ });
    await expect(sunday01).toBeFocused();
    await expect(sunday01).toHaveAttribute("aria-pressed", "true");
    await page.keyboard.press("End");
    const sunday23 = energyGrid.getByRole("button", { name: /일요일 23시, 평균 0.5 kWh/ });
    await expect(sunday23).toBeFocused();
    await page.keyboard.press("ArrowDown");
    const monday23 = energyGrid.getByRole("button", { name: /월요일 23시, 평균 0.5 kWh/ });
    await expect(monday23).toBeFocused();
    await page.keyboard.press("Home");
    const monday00 = energyGrid.getByRole("button", { name: /월요일 00시, 평균 0.5 kWh/ });
    await expect(monday00).toBeFocused();
    await page.keyboard.press("ArrowLeft");
    await expect(monday00).toBeFocused();
    await expect(page.getByRole("status").filter({ hasText: "월요일 00시, 평균 0.5 kWh" })).toBeVisible();
    await energyGrid.getByRole("button", { name: /일요일 00시, 평균 0 kWh/ }).click();
    await expect(page.getByRole("status").filter({ hasText: "일요일 00시, 평균 0 kWh" })).toBeVisible();
    const missing = energyGrid.getByRole("button", { name: /일요일 01시, 평균 산정 불가/ });
    await missing.focus(); await page.keyboard.press("Enter");
    await expect(missing).toHaveAttribute("aria-pressed", "true");
    const heatmapFilters = await openFilter(page, "히트맵 지표");
    await heatmapFilters.getByRole("button", { name: "밝기", exact: true }).click();
    await heatmapFilters.getByRole("button", { name: "필터 닫기" }).click();
    const brightnessGrid = page.getByRole("group", { name: "시간대별 밝기" });
    await expect(brightnessGrid).toBeVisible();
    const cells = await brightnessGrid.getByRole("button").evaluateAll(elements => elements.map(element => {
      const rect = element.getBoundingClientRect(); return { width: rect.width, height: rect.height };
    }));
    expect(cells.every(cell => cell.width >= 44 && cell.height >= 44)).toBe(true);
    await expectNoHorizontalOverflow(page);
    await openFilter(page, "히트맵 지표");
    for (const metricButton of await heatmapFilters.getByRole("button", { name: /^(에너지|밝기)$/ }).all()) {
      const bounds = await metricButton.boundingBox();
      expect(bounds?.width).toBeGreaterThanOrEqual(44); expect(bounds?.height).toBeGreaterThanOrEqual(44);
    }
    await expectMinimumTouchTargetsAfterScrolling(page, '[role="dialog"][aria-label="히트맵 지표"]');
    await heatmapFilters.getByRole("button", { name: "필터 닫기" }).click();
    for (const index of [0, 23, 167]) {
      const cell = brightnessGrid.getByRole("button").nth(index);
      await cell.evaluate((element) => element.scrollIntoView({ block: "center", inline: "center" }));
      const bounds = await cell.boundingBox();
      expect(bounds?.width).toBeGreaterThanOrEqual(44); expect(bounds?.height).toBeGreaterThanOrEqual(44);
      const marker = `heatmap-touch-${index}`;
      await cell.evaluate((element, value) => element.setAttribute("data-e2e-heatmap-touch", value), marker);
      await expectMinimumTouchTargets(page, `[data-e2e-heatmap-touch='${marker}']`);
      await cell.evaluate((element) => element.removeAttribute("data-e2e-heatmap-touch"));
    }
    const heatmapPath = testInfo.outputPath(`heatmap-${width}.png`);
    await page.screenshot({ path: heatmapPath });
    await testInfo.attach(`heatmap-${width}`, { path: heatmapPath, contentType: "image/png" });
    const narrowTargetLabel = "320픽셀에서도 온전히 보이는 매우 긴 보고서 대상 이름";
    if (width === 320) {
      await page.route("**/energy/sites/*/reports*", route => route.fulfill({ json: { reports: [{
        ...browserReport("completed"),
        target: { scope: "site", identityId: reportSiteId, label: narrowTargetLabel }
      }], nextCursor: null, totalCount: 1 } }));
    }
    await page.getByRole("link", { name: "보고서", exact: true }).click();
    if (width === 320) {
      const report = page.getByRole("listitem").filter({ has: page.getByText(narrowTargetLabel, { exact: true }) });
      await expect(report).toBeVisible();
      await expect(report.getByRole("button", { name: `${narrowTargetLabel} 보고서 다운로드` })).toBeVisible();
      const wrapping = await report.locator("dl").evaluate((metadata) => {
        const bounds = metadata.getBoundingClientRect();
        const itemBounds = Array.from(metadata.children, child => child.getBoundingClientRect());
        return {
          display: getComputedStyle(metadata).display,
          rowCount: new Set(itemBounds.map(item => Math.round(item.top))).size,
          insideCard: itemBounds.every(item => item.right <= bounds.right + 1)
        };
      });
      expect(wrapping).toMatchObject({ display: "grid", insideCard: true });
      expect(wrapping.rowCount).toBeGreaterThanOrEqual(2);
      await expectNoHorizontalOverflow(page);
    }
    await page.getByRole("button", { name: "보고서 만들기" }).click();
    const dialog = page.getByRole("dialog", { name: "에너지 사용량 보고서 만들기" });
    await expect(dialog.getByRole("button", { name: "CSV 내보내기" })).toBeVisible();
    await expectNoHorizontalOverflow(page);
    const controls = dialog.getByRole("button").or(dialog.getByRole("spinbutton"));
    for (const control of await controls.all()) {
      await control.scrollIntoViewIfNeeded();
      const bounds = await control.boundingBox();
      expect(bounds?.width).toBeGreaterThanOrEqual(44); expect(bounds?.height).toBeGreaterThanOrEqual(44);
    }
    await expectMinimumTouchTargetsAfterScrolling(page, "[role='dialog'][aria-modal='true']");
    const reportPath = testInfo.outputPath(`report-dialog-${width}.png`);
    await page.screenshot({ path: reportPath });
    await testInfo.attach(`report-dialog-${width}`, { path: reportPath, contentType: "image/png" });
  });
}

test.describe("Task7 physical filter hit and overlay lifecycle", () => {
  test.use({ hasTouch: true });
  for (const width of [320, 390]) test(`${width}px filter triggers retain real 44px hit, nested focus and query silence`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 740 });
    const queries: string[] = [];
    page.on("request", request => { if (/\/api\/energy\//.test(request.url())) queries.push(request.url()); });
    const measurements: unknown[] = [];
    for (const [route, labels] of [["overview", ["절감 비교 기간", "사용량 조회 단위"]], ["analysis", ["사용량 분석 조건", "히트맵 지표"]], ["reports", ["보고서 조건"]]] as const) {
      await page.goto(`/statistics/${route}?siteId=${reportSiteId}`);
      if (route === "overview") await expect(page.getByRole("img", { name: /일별 상태 기반 추정/ })).toBeVisible();
      if (route === "analysis") await expect(page.getByRole("group", { name: "시간대별 에너지 사용량" })).toBeVisible();
      if (route === "reports") await expect(page.getByText("요청한 보고서가 없습니다.")).toBeVisible();
      for (const label of labels) {
        const trigger = page.getByRole("button", { name: new RegExp(`${label} 상세 필터`) });
        await expectMinimumTouchTargetsAfterScrolling(page, `section[aria-label="${label}"]`);
        measurements.push({ route, label, bounds: await trigger.boundingBox() });
        const before = queries.length;
        await trigger.tap();
        const dialog = page.getByRole("dialog", { name: label, exact: true });
        await expect(dialog).toBeVisible();
        if (label === "사용량 분석 조건") {
          await dialog.getByRole("button", { name: "순위 기준", exact: true }).click();
          await expect(page.getByRole("listbox")).toBeVisible();
          await page.keyboard.press("Escape");
          await expect(page.getByRole("listbox")).toHaveCount(0);
          await expect(dialog.getByRole("button", { name: "순위 기준", exact: true })).toBeFocused();
          const calendar = dialog.getByRole("group", { name: "시작일", exact: true }).getByRole("button");
          await calendar.click();
          await expect(page.getByRole("grid")).toBeVisible();
          await page.keyboard.press("Escape");
          await expect(page.getByRole("grid")).toHaveCount(0);
          await expect(calendar).toBeFocused();
          expect(await page.evaluate(async () => {
            const overlays = await import(/* @vite-ignore */ "/src/components/ui/overlays/overlay-stack.ts");
            return overlays.closeTopOverlay();
          })).toBe(true);
        } else await page.keyboard.press("Escape");
        await expect(dialog).toHaveCount(0);
        await expect(trigger).toBeFocused();
        expect(queries.length).toBe(before);
        await expectNoHorizontalOverflow(page);
      }
    }
    await info.attach("real-filter-hit-and-lifecycle", { body: JSON.stringify({ width, utc: new Date().toISOString(), measurements, queries }), contentType: "application/json" });
  });
});

test("Task7 heatmap metric loading retains its live filter and focus", async ({ page }, info) => {
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/energy/sites/*/heatmap/observed-mean?**", async route => {
    const url = new URL(route.request().url());
    if (url.searchParams.get("metric") === "brightness") await pending;
    await route.fulfill({ json: observedMeanHeatmap(url) });
  });
  try {
    await page.goto(`/statistics/analysis?siteId=${reportSiteId}`);
    await expect(page.getByRole("group", { name: "시간대별 에너지 사용량" })).toBeVisible();
    const filter = await openFilter(page, "히트맵 지표");
    const metric = filter.getByRole("button", { name: "밝기", exact: true });
    await metric.click();
    await expect(page.getByText("시간대별 사용량을 계산하는 중", { exact: true })).toBeVisible();
    release();
    await expect(page.locator('[role="group"][aria-label="시간대별 밝기"]')).toBeVisible();
    await info.attach("heatmap-loading-focus", { body: JSON.stringify(await page.evaluate(() => ({ utc: new Date().toISOString(), tag: document.activeElement?.tagName, label: document.activeElement?.getAttribute("aria-label"), text: document.activeElement?.textContent, dialog: document.activeElement?.closest('[role="dialog"]')?.getAttribute("aria-label") }))), contentType: "application/json" });
    await expect(filter).toBeVisible();
    await expect(metric).toBeFocused();
    await filter.getByRole("button", { name: "필터 닫기" }).click();
    await expect(page.getByRole("button", { name: /히트맵 지표 상세 필터/ })).toBeFocused();
  } finally { release(); }
});

test("navigates to usage analysis and drills into fixture, floor, and group rankings", async ({ page }) => {
  await page.goto(`/statistics/overview?siteId=${reportSiteId}`);
  await page.getByRole("link", { name: "사용 분석" }).click();
  await expect(page).toHaveURL(new RegExp(`/statistics/analysis\\?siteId=${reportSiteId}$`));
  await expect(page.getByRole("region", { name: "사용량 분석 결과" })).toBeVisible();
  await expect(page.getByRole("region", { name: "사용량 순위" })).toContainText("B1 주차장");
  await expect(page.getByRole("complementary", { name: "B1 주차장 상세" })).toBeVisible();

  const groupRequest = page.waitForRequest((request) => request.url().includes("dimension=group"));
  const analysisFilters = await openFilter(page, "사용량 분석 조건");
  await analysisFilters.getByRole("button", { name: "그룹", exact: true }).click();
  await analysisFilters.getByRole("button", { name: "필터 닫기" }).click();
  await groupRequest;
  await page.getByRole("button", { name: "그룹 중복 안내" }).click();
  await expect(page.getByRole("dialog", { name: "그룹 중복 안내" })).toContainText("그룹 합계는 현장 총계와 다를 수 있습니다.");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "그룹 중복 안내" })).not.toBeVisible();
  await expect(page.getByRole("button", { name: "그룹 중복 안내" })).toBeFocused();
  await expectNoHorizontalOverflow(page);
});

test("returns focus to a retained report warning after its retry action", async ({ page }) => {
  let retryRequests = 0;
  let finishRetry: () => void = () => undefined;
  const pendingRetry = new Promise<void>((resolve) => { finishRetry = resolve; });
  await page.route("**/energy/sites/*/reports*", async (route) => {
    if (new URL(route.request().url()).searchParams.has("cursor")) {
      retryRequests++;
      if (retryRequests === 3) await pendingRetry;
      return route.fulfill({ status: 500, json: { message: "failed" } });
    }
    return route.fulfill({ json: { reports: [browserReport("completed")], nextCursor: "next-page", totalCount: 2 } });
  });

  await page.goto(`/statistics/reports?siteId=${reportSiteId}`);
  await expect(page.getByRole("navigation", { name: "페이지 이동" }).getByRole("button", { name: "다음 페이지" })).toBeEnabled();
  await page.getByRole("navigation", { name: "페이지 이동" }).getByRole("button", { name: "다음 페이지" }).click();
  const warning = page.getByRole("button", { name: "목록 갱신 실패 안내" });
  await warning.click();
  await page.getByRole("dialog", { name: "목록 갱신 실패 안내" }).getByRole("button", { name: "다시 시도" }).click();
  await expect.poll(() => retryRequests).toBeGreaterThanOrEqual(3);
  await warning.click();
  const busyDetails = page.getByRole("dialog", { name: "목록 갱신 실패 안내" });
  await expect(busyDetails.getByRole("status")).toHaveText("확인 중");
  await expect(busyDetails.getByRole("button", { name: "다시 시도" })).toHaveCount(0);
  expect(retryRequests).toBe(3);
  await page.keyboard.press("Escape");
  finishRetry();
  await expect(warning).toBeFocused();
});

test("moves focus to the report list after a successful warning retry", async ({ page }) => {
  let cursorRequests = 0;
  await page.route("**/energy/sites/*/reports*", (route) => {
    if (new URL(route.request().url()).searchParams.has("cursor")) {
      cursorRequests++;
      if (cursorRequests <= 2) return route.fulfill({ status: 500, json: { message: "failed" } });
      return route.fulfill({ json: { reports: [browserReport("completed")], nextCursor: null, totalCount: 2 } });
    }
    return route.fulfill({ json: { reports: [browserReport("completed")], nextCursor: "next-page", totalCount: 2 } });
  });

  await page.goto(`/statistics/reports?siteId=${reportSiteId}`);
  await page.getByRole("navigation", { name: "페이지 이동" }).getByRole("button", { name: "다음 페이지" }).click();
  await page.getByRole("button", { name: "목록 갱신 실패 안내" }).click();
  await page.getByRole("dialog", { name: "목록 갱신 실패 안내" }).getByRole("button", { name: "다시 시도" }).click();
  await expect(page.getByRole("button", { name: "목록 갱신 실패 안내" })).toHaveCount(0);
  await expect(page.getByRole("region", { name: "요청한 보고서" })).toBeFocused();
});

test("keeps search focus when a pending warning retry later succeeds", async ({ page }) => {
  let cursorRequests = 0;
  let finishRetry: () => void = () => undefined;
  const pendingRetry = new Promise<void>((resolve) => { finishRetry = resolve; });
  await page.route("**/energy/sites/*/reports*", async (route) => {
    if (new URL(route.request().url()).searchParams.has("cursor")) {
      cursorRequests++;
      if (cursorRequests <= 2) return route.fulfill({ status: 500, json: { message: "failed" } });
      await pendingRetry;
      return route.fulfill({ json: { reports: [browserReport("completed")], nextCursor: null, totalCount: 2 } });
    }
    return route.fulfill({ json: { reports: [browserReport("completed")], nextCursor: "next-page", totalCount: 2 } });
  });

  await page.goto(`/statistics/reports?siteId=${reportSiteId}`);
  await page.getByRole("navigation", { name: "페이지 이동" }).getByRole("button", { name: "다음 페이지" }).click();
  await page.getByRole("button", { name: "목록 갱신 실패 안내" }).click();
  await page.getByRole("dialog", { name: "목록 갱신 실패 안내" }).getByRole("button", { name: "다시 시도" }).click();
  await expect.poll(() => cursorRequests).toBeGreaterThanOrEqual(3);
  const search = page.getByRole("searchbox", { name: "보고서 검색" });
  await search.focus();
  finishRetry();
  await expect(page.getByRole("button", { name: "목록 갱신 실패 안내" })).toHaveCount(0);
  await expect(search).toBeFocused();
});

test("shows energy cards, daily and monthly lines, partial coverage and savings", async ({ page }) => {
  await page.goto("/statistics?siteId=site-1");

  await expect(page.getByRole("heading", { name: "기준 대비 에너지 절감" })).toBeVisible();
  await expect(page).toHaveURL(/\/statistics\/overview\?siteId=site-1$/);
  await expect(page.getByRole("navigation", { name: "통계 메뉴" })).toBeVisible();
  await expect(page.getByRole("group", { name: "에너지 절감률" })).toContainText("35 %");
  await expect(page.getByRole("img", { name: "기준 대비 에너지 사용량 비교 차트" })).toBeVisible();
  await expect(page.getByLabel("오늘 전력 사용량")).toContainText("4.25 kWh");
  await expect(page.getByLabel("이번 달 누적 전력 사용량")).toContainText("수집 공백 있음");
  await expect(page.getByRole("region", { name: "상태 기반 추정 사용량" })).toBeVisible();
  await expect(page.getByRole("complementary", { name: "비용 비교" })).toBeVisible();
  await expect(page.getByText("이번 달 예상 비용")).toBeVisible();
  await expect(page.getByText("25,600원")).toBeVisible();
  await expect(page.getByText("22,016원")).toBeVisible();
  await expect(page.getByRole("img", { name: /일별 상태 기반 추정/ })).toBeVisible();
  await expect(page.getByText(/2026년 8월 26일: 4.25 kWh, 680원, 수집 공백 2시간 0분/)).toBeAttached();

  const partialDot = page.getByRole("region", { name: "상태 기반 추정 사용량" }).locator(".recharts-line-dots circle").nth(1);
  await partialDot.hover();
  await expect(page.getByText("수집 공백 2시간 0분", { exact: true })).toBeVisible();

  const trendFilters = await openFilter(page, "사용량 조회 단위");
  await trendFilters.getByRole("button", { name: "월별" }).click();
  await expect(page.getByRole("button", { name: "월별" })).toHaveAttribute("aria-pressed", "true");
  await trendFilters.getByRole("button", { name: "필터 닫기" }).click();
  await expect(page.getByRole("img", { name: /월별 상태 기반 추정/ })).toBeVisible();
  await expect(page.getByText(/2026년 7월: 140 kWh/)).toBeAttached();

  const comparisonRequest = page.waitForRequest((request) => request.url().includes("/comparisons?preset=last_7_days"));
  const comparisonFilters = await openFilter(page, "절감 비교 기간");
  await comparisonFilters.getByRole("group", { name: "절감 비교 프리셋" }).getByRole("button", { name: "최근 7일", exact: true }).click();
  await comparisonRequest;
  await openFilter(page, "절감 비교 기간");
  await expect(comparisonFilters.getByRole("group", { name: "절감 비교 프리셋" }).getByRole("button", { name: "최근 7일", exact: true })).toHaveAttribute("aria-pressed", "true");
  await comparisonFilters.getByRole("button", { name: "필터 닫기" }).click();
  await expect(page).toHaveURL(/\/statistics\/overview\?siteId=site-1$/);
});

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 1024, height: 768 },
  { width: 390, height: 844 },
  { width: 320, height: 740 }
] as const) {
  test(`completed comparison picker and analysis range stay coherent at ${viewport.width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    await page.goto(`/statistics/overview?siteId=${reportSiteId}`);
    const opener = page.getByRole("button", { name: /절감 비교 기간 상세 필터/ });
    await opener.focus(); await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog", { name: "절감 비교 기간" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("group", { name: "완료 기간 시작일과 종료일" }).getByRole("spinbutton").first()).toBeFocused();
    await page.keyboard.press("ArrowRight");
    await expect(dialog.getByRole("group", { name: "완료 기간 시작일과 종료일" }).getByRole("spinbutton").nth(1)).toBeFocused();
    await dialog.getByRole("group", { name: "빠른 기간 선택" }).getByRole("button", { name: "최근 7일" }).click();
    const customRequest = page.waitForRequest((request) => request.url().includes("/comparisons/range?from=2026-08-19&to=2026-08-25"));
    await dialog.getByRole("button", { name: "선택 기간 적용" }).click();
    await customRequest;
    await expect(dialog).not.toBeVisible();
    await expect(opener).toBeFocused();
    await expect(opener).toHaveAccessibleName("절감 비교 기간 상세 필터, 활성 조건 1개");
    await expect(page.getByRole("region", { name: "절감 비교 기간", exact: true }).getByText("2026-08-19 ~ 2026-08-25", { exact: true })).toBeVisible();
    await expect(page.getByRole("group", { name: "오늘 전력 사용량" })).toContainText("4.25 kWh");
    await expect(page.getByRole("heading", { name: "이번 달 비용 비교" })).toBeVisible();
    await expectNoHorizontalOverflow(page);

    await page.route("**/energy/sites/*/rankings?**", (route) => {
      const url = new URL(route.request().url());
      const from = url.searchParams.get("from") ?? "";
      const to = url.searchParams.get("to") ?? "";
      const model = ranking(url.searchParams.get("dimension") ?? "floor", url.searchParams.get("metric") ?? "usage",
        url.searchParams.get("sort") ?? "desc", from, to, url.pathname.split("/")[4]);
      if (from === "2026-08-10" && to === "2026-08-20") {
        model.siteTotalKwh = 42;
        model.siteTotalCost = 6720;
        model.ranked[0].estimatedKwh = 31.5;
        model.ranked[0].metricValue = 31.5;
      }
      return route.fulfill({ json: model });
    });
    await page.getByRole("link", { name: "사용 분석" }).click();
    const analysis = page.getByRole("region", { name: "사용량 분석 결과" });
    await expect(analysis.getByRole("region", { name: "시간대별 사용량" })).toContainText("2026-08-01 ~ 2026-08-25");
    const rankingRequest = page.waitForRequest((request) => request.url().includes("/rankings?") &&
      request.url().includes("from=2026-08-10") && request.url().includes("to=2026-08-20"));
    const meanRequest = page.waitForRequest((request) => request.url().includes("/heatmap/observed-mean?") &&
      request.url().includes("from=2026-08-10") && request.url().includes("to=2026-08-20"));
    await setDatePicker(analysis, "시작일", "2026-08-10");
    await setDatePicker(analysis, "종료일", "2026-08-20");
    await rankingRequest;
    await meanRequest;
    await expect(analysis.getByRole("group", { name: "현장 사용량" })).toContainText("42 kWh");
    await expect(analysis.getByRole("complementary", { name: "B1 주차장 상세" })).toContainText("31.5 kWh");
    await expect(analysis.getByRole("region", { name: "시간대별 사용량" })).toContainText("2026-08-10 ~ 2026-08-20");
    const meanCells = analysis.getByRole("group", { name: "시간대별 에너지 사용량" });
    await expect(meanCells.getByRole("button", { name: /일요일 00시, 평균 0 kWh, 수집률 100%/ })).toBeVisible();
    await expect(meanCells.getByRole("button", { name: /일요일 01시, 평균 산정 불가, 수집률 50%/ })).toBeVisible();
    await expectNoHorizontalOverflow(page);
  });
}

test("changing the analysis period clears old results while the new request is pending and after failure", async ({ page }) => {
  let releaseNewRange!: () => void;
  const newRangeGate = new Promise<void>((resolve) => { releaseNewRange = resolve; });
  await page.route("**/energy/sites/*/rankings?**", async (route) => {
    const url = new URL(route.request().url());
    const from = url.searchParams.get("from") ?? "";
    const to = url.searchParams.get("to") ?? "";
    if (from === "2026-08-10" && to === "2026-08-20") {
      await newRangeGate;
      await route.fulfill({ status: 503, json: { message: "temporarily unavailable" } });
      return;
    }
    await route.fulfill({ json: ranking(url.searchParams.get("dimension") ?? "floor",
      url.searchParams.get("metric") ?? "usage", url.searchParams.get("sort") ?? "desc", from, to,
      url.pathname.split("/")[4]) });
  });
  try {
    await page.goto(`/statistics/analysis?siteId=${reportSiteId}`);
    const analysis = page.getByRole("region", { name: "사용량 분석 결과" });
    await expect(analysis.getByRole("group", { name: "현장 사용량" })).toContainText("20 kWh");
    await expect(analysis.getByRole("region", { name: "시간대별 사용량" })).toBeVisible();

    await setDatePicker(analysis, "시작일", "2026-08-10");
    const nextRequest = page.waitForRequest((request) => request.url().includes("/rankings?") &&
      request.url().includes("from=2026-08-10") && request.url().includes("to=2026-08-20"));
    await setDatePicker(analysis, "종료일", "2026-08-20");
    await nextRequest;
    await expect(analysis.getByRole("group", { name: "현장 사용량" })).not.toBeVisible();
    await expect(analysis.getByRole("region", { name: "사용량 순위" })).not.toBeVisible();
    await expect(analysis.getByRole("complementary", { name: "B1 주차장 상세" })).not.toBeVisible();
    await expect(analysis.getByRole("region", { name: "시간대별 사용량" })).not.toBeVisible();

    releaseNewRange();
    await expect(analysis.getByText("사용량 분석을 불러오지 못했습니다.")).toBeVisible();
    await expect(analysis.getByRole("group", { name: "현장 사용량" })).not.toBeVisible();
    await expect(analysis.getByRole("region", { name: "시간대별 사용량" })).not.toBeVisible();
  } finally {
    releaseNewRange();
  }
});

test("hides a cached analysis after same-period refetch fails and restores it on retry", async ({ page }) => {
  let floorRequests = 0;
  await page.route("**/energy/sites/*/rankings?**", (route) => {
    const url = new URL(route.request().url());
    const dimension = url.searchParams.get("dimension") ?? "floor";
    if (dimension === "floor") {
      floorRequests += 1;
      if (floorRequests === 2 || floorRequests === 3) {
        return route.fulfill({ status: 503, json: { message: "temporarily unavailable" } });
      }
    }
    return route.fulfill({ json: ranking(dimension, url.searchParams.get("metric") ?? "usage",
      url.searchParams.get("sort") ?? "desc", url.searchParams.get("from") ?? "",
      url.searchParams.get("to") ?? "", url.pathname.split("/")[4]) });
  });

  await page.goto(`/statistics/analysis?siteId=${reportSiteId}`);
  const analysis = page.getByRole("region", { name: "사용량 분석 결과" });
  await expect(analysis.getByRole("group", { name: "현장 사용량" })).toContainText("20 kWh");
  const analysisFilters = await openFilter(page, "사용량 분석 조건");
  await analysisFilters.getByRole("button", { name: "조명", exact: true }).click();
  await analysisFilters.getByRole("button", { name: "필터 닫기" }).click();
  await expect(analysis.getByRole("region", { name: "사용량 순위" })).toContainText("B1-L01");
  await openFilter(page, "사용량 분석 조건");
  await analysisFilters.getByRole("button", { name: "층", exact: true }).click();
  await analysisFilters.getByRole("button", { name: "필터 닫기" }).click();
  await expect(analysis.getByText("사용량 분석을 불러오지 못했습니다.")).toBeVisible();
  expect(floorRequests).toBe(3);
  await expect(analysis.getByRole("group", { name: "현장 사용량" })).not.toBeVisible();
  await expect(analysis.getByRole("region", { name: "사용량 순위" })).not.toBeVisible();
  await expect(analysis.getByRole("complementary", { name: "B1 주차장 상세" })).not.toBeVisible();
  await expect(analysis.getByRole("region", { name: "시간대별 사용량" })).not.toBeVisible();

  await analysis.getByRole("button", { name: "다시 시도" }).click();
  await expect(analysis.getByRole("group", { name: "현장 사용량" })).toContainText("20 kWh");
  await expect(analysis.getByRole("region", { name: "시간대별 사용량" })).toBeVisible();
});

for (const mismatch of ["site", "range"] as const) {
  test(`rejects a custom comparison response for another ${mismatch}`, async ({ page }) => {
    await page.route("**/energy/sites/*/comparisons/range?**", (route) => {
      const url = new URL(route.request().url());
      const from = url.searchParams.get("from") ?? "";
      const to = url.searchParams.get("to") ?? "";
      const response = mismatch === "site"
        ? customComparison(from, to, "30000000-0000-4000-8000-000000000099")
        : customComparison("2026-08-01", "2026-08-07", reportSiteId);
      return route.fulfill({ json: response });
    });
    await page.goto(`/statistics/overview?siteId=${reportSiteId}`);
    await page.getByRole("button", { name: /절감 비교 기간 상세 필터/ }).click();
    const dialog = page.getByRole("dialog", { name: "절감 비교 기간" });
    await dialog.getByRole("group", { name: "빠른 기간 선택" }).getByRole("button", { name: "최근 7일" }).click();
    await dialog.getByRole("button", { name: "선택 기간 적용" }).click();

    const comparison = page.locator('section[aria-labelledby="statistics-comparison-title"]');
    await expect(comparison.getByText("절감 비교를 불러오지 못했습니다.")).toBeVisible();
    await expect(comparison.getByRole("group", { name: "기준 및 동기간 비교" })).not.toBeVisible();
    await expect(page.getByRole("group", { name: "오늘 전력 사용량" })).toContainText("4.25 kWh");
  });
}

for (const viewport of [
  { width: 390, height: 844 },
  { width: 320, height: 740 },
  { width: 760, height: 900 }
] as const) {
  test(`${viewport.width}px control modes use the statistics underline navigation visual with optional icons`, async ({ page }) => {
    await page.setViewportSize(viewport);
    const emptyPage = { items: [], nextCursor: null };
    await page.route("**/api/sites/*/automation/schedules**", (route) => route.fulfill({ json: emptyPage }));
    await page.route("**/api/sites/*/automation/vehicle-event-rules**", (route) => route.fulfill({ json: emptyPage }));
    await page.goto("/control?siteId=site-1&mode=manual");

    const controlNavigation = page.getByRole("tablist", { name: "제어 방식" });
    const controlTabs = controlNavigation.getByRole("tab");
    await expect(controlTabs).toHaveCount(3);
    expect(await controlTabs.locator("svg").count()).toBe(3);

    const controlMetrics = await controlNavigation.evaluate((element) => ({
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth
    }));
    if (viewport.width === 320) {
      expect(controlMetrics.scrollWidth).toBeGreaterThan(controlMetrics.clientWidth);
    } else {
      expect(controlMetrics.scrollWidth).toBeGreaterThanOrEqual(controlMetrics.clientWidth);
    }
    for (const tab of await controlTabs.all()) {
      const bounds = await tab.boundingBox();
      expect(bounds).not.toBeNull();
      expect(bounds!.height).toBeGreaterThanOrEqual(44);
    }
    let controlVisual: Awaited<ReturnType<typeof underlineNavigationVisual>> | undefined;
    for (const [mode, label] of [["manual", "수동 제어"], ["schedule", "스케줄 제어"], ["event", "이벤트 제어"]] as const) {
      const selectedTab = controlNavigation.getByRole("tab", { name: label });
      if (mode !== "manual") await selectedTab.click();
      await expect(page).toHaveURL(new RegExp(`[?&]mode=${mode}(?:&|$)`));
      await expect(selectedTab).toHaveAttribute("aria-selected", "true");
      const modePanel = page.locator(`#control-mode-panel-${mode}`);
      await expect(modePanel).toBeVisible();

      const alignment = await underlineNavigationAlignment(controlNavigation);
      expect(Math.abs(alignment.wrapperHeight - alignment.trackHeight), `${mode} wrapper/track height`).toBeLessThanOrEqual(1);
      expect(Math.abs(alignment.trackHeight - alignment.tabHeight), `${mode} track/tab height`).toBeLessThanOrEqual(1);
      expect(Math.abs(alignment.wrapperBottom - alignment.trackBottom), `${mode} bottom alignment`).toBeLessThanOrEqual(1);
      await expect.poll(async () => {
        const currentAlignment = await underlineNavigationAlignment(controlNavigation);
        const panelTop = await modePanel.evaluate((element) => element.getBoundingClientRect().top);
        return Math.abs(panelTop - currentAlignment.wrapperBottom - 16);
      }, { message: `${mode} navigation/panel gap` }).toBeLessThanOrEqual(1);
      controlVisual ??= await underlineNavigationVisual(controlNavigation, selectedTab);
    }
    await expectNoHorizontalOverflow(page);

    await page.goto("/statistics/overview?siteId=site-1#summary");
    const statisticsNavigation = page.getByRole("navigation", { name: "통계 메뉴" });
    const selectedStatisticsLink = statisticsNavigation.getByRole("link", { name: "개요" });
    await expect(statisticsNavigation.getByRole("link")).toHaveCount(3);
    await expect(selectedStatisticsLink).toHaveAttribute("aria-current", "page");
    await expect(selectedStatisticsLink).toHaveAttribute("href", "/statistics/overview?siteId=site-1#summary");
    expect(await statisticsNavigation.locator("svg").count()).toBe(0);

    const statisticsVisual = await underlineNavigationVisual(statisticsNavigation, selectedStatisticsLink);
    expect(controlVisual).toEqual(statisticsVisual);
    await expectNoHorizontalOverflow(page);
  });
}

test("underline navigation keeps keyboard focus visible inside its overflow edge", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/control?siteId=site-1&mode=manual");

  const controlTab = page.getByRole("tab", { name: "수동 제어" });
  await controlTab.focus();
  await expect(controlTab).toBeFocused();
  expect(await controlTab.evaluate((element) => getComputedStyle(element).boxShadow)).not.toBe("none");

  await page.goto("/statistics/overview?siteId=site-1");
  const statisticsLink = page.getByRole("link", { name: "개요" });
  await statisticsLink.focus();
  await expect(statisticsLink).toBeFocused();
  expect(await statisticsLink.evaluate((element) => getComputedStyle(element).boxShadow)).not.toBe("none");
});

test("shows negative savings as overuse without clamping", async ({ page }) => {
  await page.goto("/statistics?siteId=site-overuse");

  await expect(page.getByRole("group", { name: "기준 대비 초과 사용" })).toContainText("-10 %");
  await expect(page.getByRole("group", { name: "기준 초과 전력" })).toContainText("10 kWh");
  await expect(page.getByText("초과 사용", { exact: true })).toBeVisible();
});

test("retries comparison failures without hiding existing usage cards", async ({ page }) => {
  let allowComparison = false;
  await page.route("**/energy/sites/site-comparison-retry/comparisons?**", (route) => {
    return allowComparison
      ? route.fulfill({ contentType: "application/json", body: JSON.stringify(comparison("current_month", "saving")) })
      : route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ message: "failed" }) });
  });

  await page.goto("/statistics?siteId=site-comparison-retry");
  await expect(page.getByLabel("오늘 전력 사용량")).toContainText("4.25 kWh");
  await expect(page.getByText("절감 비교를 불러오지 못했습니다.")).toBeVisible();
  allowComparison = true;
  await page.getByRole("button", { name: "절감 비교 다시 시도" }).click();
  await expect(page.getByRole("group", { name: "에너지 절감률" })).toContainText("35 %");
});

test("shows the no-data state without zero usage cards", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 740 });
  await page.route("**/energy/sites/site-empty/summary", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify(noDataSummary("site-empty"))
  }));

  await page.goto("/statistics?siteId=site-empty");
  await expect(page.getByText("아직 상태 기반 사용량을 표시할 수 없습니다.")).toBeVisible();
  await expect(page.getByText("조명 상태가 수집되면 통계가 표시됩니다.")).toBeVisible();
  await expect(page.getByLabel("오늘 전력 사용량")).toHaveCount(0);
  await expectMinimumTouchTargetsAfterScrolling(page, '[aria-label="기준 대비 사용량 비교"]');
  await page.getByRole("button", { name: "산정 불가 기간 안내" }).click();
  await expect(page.getByRole("dialog", { name: "산정 불가 기간 안내" })).toContainText("기준 사용량만 표시합니다.");
  await expectNoHorizontalOverflow(page);
});

test("retries a summary failure and keeps cards during a series failure", async ({ page }) => {
  let allowSummary = false;
  let allowDaySeries = false;
  await page.route("**/energy/sites/site-retry/summary", (route) => {
    return allowSummary
      ? route.fulfill({ contentType: "application/json", body: JSON.stringify(summary("site-retry")) })
      : route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ message: "failed" }) });
  });
  await page.route("**/energy/sites/site-retry/series?**", (route) => {
    const url = new URL(route.request().url());
    const granularity = url.searchParams.get("granularity") === "month" ? "month" : "day";
    if (granularity === "day" && !allowDaySeries) {
      return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ message: "failed" }) });
    }
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(series("site-retry", granularity, url.searchParams.get("from") ?? "", url.searchParams.get("to") ?? ""))
    });
  });

  await page.goto("/statistics?siteId=site-retry");
  await expect(page.getByText("전력 통계를 불러오지 못했습니다.")).toBeVisible();
  allowSummary = true;
  await page.getByRole("button", { name: "전력 통계 다시 시도" }).click();
  await expect(page.getByLabel("오늘 전력 사용량")).toContainText("4.25 kWh");
  await expect(page.getByText("사용량 추이를 불러오지 못했습니다.")).toBeVisible();
  allowDaySeries = true;
  await page.getByRole("button", { name: "사용량 추이 다시 시도" }).click();
  await expect(page.getByRole("img", { name: /일별 상태 기반 추정/ })).toBeVisible();
});

test("packs the statistics report from the top in a tall viewport", async ({ page }) => {
  const viewport = { width: 1440, height: 2400 };
  await page.setViewportSize(viewport);
  await page.goto("/statistics");
  await expect(page.getByRole("heading", { name: "기준 대비 에너지 절감" })).toBeVisible();

  const [shellRect, headingRect, reportRect] = await Promise.all([
    page.getByRole("region", { name: "통계", exact: true }).boundingBox(),
    page.getByRole("heading", { name: "기준 대비 에너지 절감" }).boundingBox(),
    page.getByRole("group", { name: "사용량 및 비용" }).boundingBox()
  ]);
  if (!shellRect || !headingRect || !reportRect) throw new Error("statistics report layout is incomplete");
  const layout = {
    headingOffset: headingRect.y - shellRect.y,
    remainingViewportSpace: viewport.height - (reportRect.y + reportRect.height)
  };

  expect(layout.headingOffset).toBeGreaterThan(0);
  expect(layout.headingOffset).toBeLessThan(100);
  expect(
    layout.remainingViewportSpace,
    "intrinsic statistics content should leave proportional space below it instead of stretching to the viewport bottom"
  ).toBeGreaterThan(viewport.height * 0.1);
});

unconfiguredTest("Task7 native Chromium 200 percent keeps statistic filters, periods and keyboard reachable", async ({}, testInfo) => {
  test.setTimeout(60000);
  const context = await chromium.launchPersistentContext("", {
    channel: "chromium", viewport: null, deviceScaleFactor: undefined, args: ["--window-size=1440,900"]
  });
  let native: StatisticsNativeZoomEvidence | undefined;
  try {
    const page = context.pages()[0]!;
    await installMockApiBoundary(context, testInfo.project.use.baseURL!);
    await installStatisticsFixtures(page);
    // This persistent page owns separate route handlers from the default test
    // page. Complete its known shell lookup without permitting unknown API calls.
    await page.route("**/api/sites", route => route.fulfill({ json: [dashboard(reportSiteId).site] }));
    await page.goto(`${testInfo.project.use.baseURL}/statistics/overview?siteId=${reportSiteId}`);
    native = await StatisticsNativeZoomEvidence.create(context, page, testInfo);
    await native.global200(context);
    await expect(page.getByText("핵심 절감 분석", { exact: true })).toHaveCount(0);
    const current = page.getByRole("region", { name: "오늘 사용량과 비용" });
    await expect(current.getByText("상태 기반 추정", { exact: true })).toHaveCount(0);
    await expect(current.getByText("KPI 수집 공백", { exact: true })).toHaveCount(0);
    await expect(current).toContainText("마지막 집계 2026-08-26 09:00:00");
    const pickerButton = page.getByRole("button", { name: /절감 비교 기간 상세 필터/ });
    await pickerButton.focus(); await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog", { name: "절감 비교 기간" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("group", { name: "완료 기간 시작일과 종료일" }).getByRole("spinbutton").first()).toBeFocused();
    await page.keyboard.press("Escape"); await expect(pickerButton).toBeFocused();
    await expectNoHorizontalOverflow(page);
    await page.getByRole("link", { name: "사용 분석", exact: true }).click();
    const filters = page.getByRole("region", { name: "사용량 분석 조건" });
    const analysisTrigger = filters.getByRole("button", { name: /사용량 분석 조건 상세 필터/ });
    await analysisTrigger.focus(); await page.keyboard.press("Enter");
    const analysisDialog = page.getByRole("dialog", { name: "사용량 분석 조건", exact: true });
    await expect(analysisDialog.getByRole("group", { name: "시작일", exact: true })).toBeVisible();
    // Reset belongs inside the new public Popover, never duplicates outside it.
    await expect(filters.getByRole("button", { name: /초기화/ })).toHaveCount(0);
    await expectMinimumTouchTargetsAfterScrolling(page, '[role="dialog"][aria-label="사용량 분석 조건"]');
    await page.keyboard.press("Escape"); await expect(analysisTrigger).toBeFocused();
    await expectMinimumTouchTargetsAfterScrolling(page, '[aria-label="사용량 분석 조건"]');
    await expectNoHorizontalOverflow(page);
    await page.getByRole("link", { name: "보고서", exact: true }).click();
    const historyFilters = page.getByRole("search", { name: "보고서 이력 필터" });
    const reportTrigger = historyFilters.getByRole("button", { name: /보고서 조건 상세 필터/ });
    await reportTrigger.focus(); await page.keyboard.press("Enter");
    const reportDialog = page.getByRole("dialog", { name: "보고서 조건", exact: true });
    await expect(reportDialog.getByRole("group", { name: "요청 기간", exact: true })).toBeVisible();
    await expectMinimumTouchTargetsAfterScrolling(page, '[role="dialog"][aria-label="보고서 조건"]');
    await page.keyboard.press("Escape");
    await expect(reportTrigger).toBeFocused();
    await expectMinimumTouchTargetsAfterScrolling(page, '[role="search"][aria-label="보고서 이력 필터"]');
    await expectNoHorizontalOverflow(page);
    await expect(page.getByText("현장 목록을 확인하지 못했습니다.", { exact: true })).toHaveCount(0);
    await native.capture("Task7-native-200-report", reportTrigger, async () => { await expect(reportDialog).toBeVisible(); }, ["Escape"], {
      description: "보고서 조건 dialog closed, trigger collapsed and focused",
      observe: async () => {
        await expect(reportDialog).not.toBeVisible();
        await expect(reportTrigger).toHaveAttribute("aria-expanded", "false");
        return { dialogName: "보고서 조건", visible: await reportDialog.isVisible(), expanded: await reportTrigger.getAttribute("aria-expanded") };
      }
    });
  } finally {
    try { await native?.stop(); } finally { await context.close(); await native?.recordContextCleanup(); }
  }
});

test("Task7 quick periods remain independent while zero, missing and isolated chart points stay truthful", async ({ page }) => {
  await page.route("**/energy/sites/*/summary", route => {
    const value = summary(reportSiteId);
    return route.fulfill({ json: { ...value,
      today: { ...value.today, estimatedKwh: 0, estimatedCost: 0 },
      monthToDate: { ...value.monthToDate, estimatedKwh: 0, estimatedCost: 0, knownSeconds: 0, dataStatus: "no_data" }
    } });
  });
  await page.route("**/energy/sites/*/series?**", route => {
    const params = new URL(route.request().url()).searchParams;
    const value = series(reportSiteId, "day", params.get("from")!, params.get("to")!);
    return route.fulfill({ json: { ...value, points: value.points.map((point, index) => ({ ...point,
      estimatedKwh: 0, estimatedCost: 0, knownSeconds: index === 1 ? 86400 : 0,
      unknownSeconds: index === 1 ? 0 : 86400, dataStatus: index === 1 ? "available" : "no_data"
    })) } });
  });
  await page.route("**/energy/sites/*/comparisons?**", route => {
    const preset = comparisonPreset(new URL(route.request().url()).searchParams.get("preset"));
    const base = comparison(preset, "saving");
    const range = preset === "last_7_days" ? { from: "2026-08-19", to: "2026-08-25", completedThrough: "2026-08-25" }
      : preset === "current_year" ? { from: "2026-01-01", to: "2026-12-31", completedThrough: "2026-08-25" } : base.range;
    return route.fulfill({ json: { ...base, siteId: reportSiteId, range } });
  });
  await page.goto(`/statistics/overview?siteId=${reportSiteId}`);
  await expect(page.getByRole("group", { name: "오늘 전력 사용량" })).toContainText("0 kWh");
  await expect(page.getByRole("group", { name: "이번 달 누적 전력 사용량" })).toContainText("—");
  const chart = page.getByRole("region", { name: "상태 기반 추정 사용량" });
  await expect(chart.getByText("2026-08-01 ~ 2026-08-31", { exact: true })).toBeVisible();
  await expect(chart.locator(".recharts-line-dots circle")).toHaveCount(1);
  const data = chart.getByRole("list", { name: "차트 데이터 및 수집 상태" });
  await expect(data).toContainText("2026년 8월 26일: 0 kWh");
  await expect(data).toContainText("2026년 8월 25일: 수집 데이터 없음");
  await expect(chart.getByText("결측 포함", { exact: true })).toBeVisible();
  const picker = (await openFilter(page, "절감 비교 기간")).getByRole("group", { name: "절감 비교 프리셋" });
  await picker.getByRole("button", { name: "최근 7일", exact: true }).click();
  await expect(page.getByRole("region", { name: "절감 비교 기간", exact: true }).getByText("2026-08-19 ~ 2026-08-25", { exact: true })).toBeVisible();
  await expect(chart.getByText("2026-08-01 ~ 2026-08-31", { exact: true })).toBeVisible();
  await openFilter(page, "절감 비교 기간");
  await picker.getByRole("button", { name: "올해", exact: true }).click();
  await expect(page.getByRole("region", { name: "절감 비교 기간", exact: true }).getByText("2026-01-01 ~ 2026-12-31", { exact: true })).toBeVisible();
  await expect(page.getByText("핵심 절감 분석", { exact: true })).toHaveCount(0);
  await expectNoHorizontalOverflow(page);
});

test("keeps KPI helper ranges readable without oversized cards at 320px", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 740 });
  await page.goto("/statistics");

  const cards = page.getByRole("group", { name: "에너지 요약" }).locator("[data-metric-card]");
  await expect(cards).toHaveCount(3);
  for (const card of await cards.all()) {
    const layout = await card.evaluate((element) => {
      const helper = element.querySelector("p");
      if (!helper) throw new Error("KPI helper is missing");
      const cardBounds = element.getBoundingClientRect();
      const helperBounds = helper.getBoundingClientRect();
      const lineHeight = Number.parseFloat(getComputedStyle(helper).lineHeight);
      return {
        cardHeight: cardBounds.height,
        cardWidth: element.clientWidth,
        contentWidth: element.scrollWidth,
        helperRight: helperBounds.right,
        cardRight: cardBounds.right,
        helperBottom: helperBounds.bottom,
        cardBottom: cardBounds.bottom,
        helperLines: helperBounds.height / lineHeight
      };
    });
    expect(layout.contentWidth).toBeLessThanOrEqual(layout.cardWidth + 1);
    expect(layout.helperRight).toBeLessThanOrEqual(layout.cardRight + 1);
    expect(layout.helperBottom).toBeLessThanOrEqual(layout.cardBottom + 1);
    expect(layout.helperLines).toBeLessThanOrEqual(3.1);
    expect(layout.cardHeight).toBeLessThanOrEqual(230);
  }

  const chart = page.getByRole("region", { name: "상태 기반 추정 사용량" });
  await expect(chart.getByText("결측·수집 공백")).toBeVisible();
  await expect(chart.getByText("선이 끊긴 기간은 수집 데이터가 없으며, 수집 공백이 있는 기간은 추정값이 불완전할 수 있습니다.")).toHaveCount(0);
  await expectNoHorizontalOverflow(page);
});

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 1024, height: 768 },
  { width: 390, height: 844 },
  { width: 320, height: 740 }
] as const) {
  test(`keeps the statistics report responsive at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto(`/statistics?siteId=${reportSiteId}`);
    await expect(page.getByRole("heading", { name: "기준 대비 에너지 절감" })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "통계 메뉴" })).toBeVisible();
    await expect(page.getByRole("region", { name: "기준 대비 사용량 비교" })).toBeVisible();
    await expect(page.getByRole("complementary", { name: "동기간 비교" })).toBeVisible();

    const expectedColumns = viewport.width === 320 ? 1 : viewport.width === 390 ? 2 : 3;
    expect(await gridColumnCount(page)).toBe(expectedColumns);
    await expectReportPanelLayout(page, viewport.width <= 760);
    await expect(page.getByRole("region", { name: "상태 기반 추정 사용량" })).toBeVisible();
    await expect(page.getByRole("complementary", { name: "비용 비교" })).toBeVisible();
    const firstAxisLabel = page.getByRole("region", { name: "상태 기반 추정 사용량" }).locator(".recharts-cartesian-axis-tick-value").first();
    await expect(firstAxisLabel).toBeVisible();
    expect(await firstAxisLabel.evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize))).toBeGreaterThanOrEqual(11);
    const trendFilters = await openFilter(page, "사용량 조회 단위");
    await expect(trendFilters.getByRole("button", { name: "일별" })).toBeVisible();
    await expect(trendFilters.getByRole("button", { name: "월별" })).toBeVisible();
    await trendFilters.getByRole("button", { name: "필터 닫기" }).click();
    await expectStatisticsSpacing(page, viewport.width <= 760);
    await expectComparisonPanelLayout(page, viewport.width <= 760);
    const comparisonOverflow = await page.getByRole("region", { name: "기준 대비 사용량 비교" }).evaluate((element) => ({
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth
    }));
    expect(comparisonOverflow.scrollWidth).toBeLessThanOrEqual(comparisonOverflow.clientWidth);
    await expectNoHorizontalOverflow(page);
    if (viewport.width <= 760) {
      await page.getByRole("heading", { name: "상태 기반 추정 사용량" }).scrollIntoViewIfNeeded();
      await expect(page.getByRole("button", { name: /사용량 조회 단위 상세 필터/ })).toBeInViewport();
      await expectMinimumTouchTargets(page, "[data-app-shell]");
    }

    await page.getByRole("link", { name: "사용 분석" }).click();
    await expect(page.getByRole("region", { name: "사용량 분석 결과" })).toBeVisible();
    await expect(page.getByRole("region", { name: "사용량 순위" })).toBeVisible();
    await expectNoHorizontalOverflow(page);
  });
}

async function expectStatisticsSpacing(page: Page, compact: boolean) {
  const screenGap = await page.getByRole("region", { name: "에너지 통계" }).evaluate((element) => {
    return getComputedStyle(element).rowGap;
  });
  expect(screenGap).toBe("20px");

  const summary = page.getByRole("group", { name: "에너지 요약" });
  const summaryGap = await summary.evaluate((element) => {
    return getComputedStyle(element).gap;
  });
  expect(summaryGap).toBe("16px");

  const chartPanel = page.getByRole("region", { name: "상태 기반 추정 사용량" });
  const panelPadding = await chartPanel.evaluate((element) => {
    return getComputedStyle(element).paddingTop;
  });
  expect(panelPadding).toBe(compact ? "16px" : "24px");

  const chartPanelGap = await chartPanel.evaluate((element) => {
    return getComputedStyle(element).gap;
  });
  expect(chartPanelGap).toBe("16px");

  const metricCardSpacing = await summary.locator("[data-metric-card]").first().evaluate((element) => {
    const styles = getComputedStyle(element);
    return { minHeight: styles.minHeight, paddingBottom: styles.paddingBottom };
  });
  expect(metricCardSpacing).toEqual({ minHeight: "0px", paddingBottom: "16px" });

  const statusPosition = await summary.getByRole("group", { name: "오늘 전력 사용량" }).locator("[data-tone=success]").evaluate((element) => {
    return getComputedStyle(element).position;
  });
  expect(statusPosition).toBe("static");

  if (compact) {
    const metricLabelWidth = await summary.locator("[data-metric-label]").first().evaluate((element) => {
      return element.getBoundingClientRect().width;
    });
    expect(metricLabelWidth).toBeGreaterThanOrEqual(100);

    const [chartTitle, chartTabs] = await Promise.all([
      page.getByRole("heading", { name: "상태 기반 추정 사용량" }).boundingBox(),
      chartPanel.getByRole("button", { name: /사용량 조회 단위 상세 필터/ }).boundingBox()
    ]);
    expect(chartTitle).not.toBeNull();
    expect(chartTabs).not.toBeNull();
    if (chartTitle && chartTabs) {
      expect(chartTabs.y).toBeGreaterThanOrEqual(chartTitle.y + chartTitle.height);
    }
  }
}

async function installReportHistoryFixture(page: Page) {
  let records = reportHistoryRecords();
  energyReportListResponseSchema.parse({ reports: records.slice(0, 20), nextCursor: "offset-20", totalCount: records.length });
  const createdRequests: EnergyReportJob["request"][] = [];
  let expectedListQuery: URLSearchParams | undefined;
  let lastObservedListQuery: string | undefined;
  await page.route("**/energy/sites/*/reports*", async (route) => {
    if (route.request().method() === "POST") {
      const request = route.request().postDataJSON() as EnergyReportJob["request"];
      createdRequests.push(request);
      const created = historyReport(1_000, {
        status: "queued",
        scope: request.scope,
        label: "새 보고서",
        requestedAt: "2026-09-11T12:00:00.000Z",
        request
      });
      records = [created, ...records];
      await route.fulfill({ status: 202, json: created });
      return;
    }

    const url = new URL(route.request().url());
    const actualListQuery = url.searchParams.toString();
    if (expectedListQuery) {
      const expectedQueryString = expectedListQuery.toString();
      if (actualListQuery === expectedQueryString) {
        expectedListQuery = undefined;
      } else if (actualListQuery !== lastObservedListQuery) {
        expect(
          [...url.searchParams.entries()],
          `normalized report query for ${url.pathname}`
        ).toEqual([...expectedListQuery.entries()]);
      }
    }
    lastObservedListQuery = actualListQuery;
    const query = (url.searchParams.get("query") ?? "").trim().toLocaleLowerCase("ko-KR");
    const status = url.searchParams.get("status");
    const scope = url.searchParams.get("scope");
    const requestedFrom = url.searchParams.get("requestedFrom");
    const requestedTo = url.searchParams.get("requestedTo");
    const filtered = records.filter((record) => {
      const requestedDate = record.requestedAt.slice(0, 10);
      return (!query || record.target.label.toLocaleLowerCase("ko-KR").includes(query))
        && (!status || record.status === status)
        && (!scope || record.request.scope === scope)
        && (!requestedFrom || requestedDate >= requestedFrom)
        && (!requestedTo || requestedDate <= requestedTo);
    });
    const limit = Number(url.searchParams.get("limit") ?? 20);
    const cursor = url.searchParams.get("cursor");
    const offset = cursor?.startsWith("offset-") ? Number(cursor.slice("offset-".length)) : 0;
    const reports = filtered.slice(offset, offset + limit);
    const response = energyReportListResponseSchema.parse({
      reports,
      nextCursor: offset + reports.length < filtered.length ? `offset-${offset + reports.length}` : null,
      totalCount: filtered.length
    });
    await route.fulfill({ json: response });
  });
  return {
    createdRequests,
    expectNextListQuery(query: Record<string, string>) {
      expect(expectedListQuery, "previous expected report query was observed").toBeUndefined();
      expectedListQuery = new URLSearchParams(query);
    },
    expectAllListQueriesObserved() {
      expect(expectedListQuery, "all expected report queries were observed").toBeUndefined();
    }
  };
}

test("opens a legacy XLSX history URL on the first PDF page", async ({ page }) => {
  const fixture = await installReportHistoryFixture(page);
  fixture.expectNextListQuery({ limit: "20", scope: "site" });
  await page.goto(`/statistics/reports?siteId=${reportSiteId}&format=xlsx&reportPage=3&scope=site`);
  await expect(page.getByRole("navigation", { name: "페이지 이동" }).getByRole("status")).toContainText("1~20 /");
  await expect(page).toHaveURL(new RegExp(`\\?limit=20&scope=site&siteId=${reportSiteId}$`));
  await expect(page.getByRole("search", { name: "보고서 이력 필터" }).getByRole("button", { name: "파일 형식" })).toHaveCount(0);
  fixture.expectAllListQueriesObserved();
});

test("exports the selected range as raw CSV without a report format", async ({ page }) => {
  const requests: URL[] = [];
  await page.route("**/energy/sites/*/exports/csv?**", async route => {
    requests.push(new URL(route.request().url()));
    await route.fulfill({ contentType: "text/csv", body: "date,kwh\n2026-09-01,1\n" });
  });
  await page.goto(`/statistics/reports?siteId=${reportSiteId}`);
  await page.getByRole("button", { name: "보고서 만들기" }).click();
  const dialog = page.getByRole("dialog", { name: "에너지 사용량 보고서 만들기" });
  const download = page.waitForEvent("download");
  await dialog.getByRole("button", { name: "CSV 내보내기" }).click();
  const file = await download;
  expect(file.suggestedFilename()).toBe("energy-export.csv");
  expect(await readFile((await file.path())!, "utf8")).toBe("date,kwh\n2026-09-01,1\n");
  expect(requests).toHaveLength(1);
  expect(Object.fromEntries(requests[0].searchParams)).toEqual({
    from: "2026-08-13", to: "2026-09-11", scope: "site", identityId: reportSiteId
  });
  expect(requests[0].searchParams.has("format")).toBe(false);
});

function reportHistoryRecords(): EnergyReportJob[] {
  return Array.from({ length: 101 }, (_, index) => {
    if (index < 3) {
      return historyReport(index, {
        status: "completed",
        scope: "site",
        label: ["서울 본사", "서울 강남", "서울 연구소"][index],
        requestedAt: `2026-09-${String(10 - index).padStart(2, "0")}T09:00:00.000Z`
      });
    }
    if (index === 3) {
      return historyReport(index, {
        status: "completed",
        scope: "site",
        label: "부산 검색 조건 불일치",
        requestedAt: "2026-09-10T09:00:00.000Z"
      });
    }
    if (index === 4) return historyReport(index, {
      status: "failed", scope: "site", label: "서울 상태 조건 불일치", requestedAt: "2026-09-10T09:00:00.000Z"
    });
    if (index === 5) return historyReport(index, {
      status: "completed", scope: "floor", label: "서울 범위 조건 불일치 2", requestedAt: "2026-09-10T09:00:00.000Z"
    });
    if (index === 6) return historyReport(index, {
      status: "completed", scope: "floor", label: "서울 범위 조건 불일치", requestedAt: "2026-09-10T09:00:00.000Z"
    });
    if (index === 7) return historyReport(index, {
      status: "completed", scope: "site", label: "서울 시작일 조건 불일치", requestedAt: "2026-09-07T09:00:00.000Z"
    });
    if (index === 8) return historyReport(index, {
      status: "completed", scope: "site", label: "서울 종료일 조건 불일치", requestedAt: "2026-09-11T09:00:00.000Z"
    });
    const scopes = ["site", "floor", "group", "fixture"] as const;
    return historyReport(index, {
      status: index % 19 === 0 ? "processing" : index % 17 === 0 ? "queued" : "completed",
      scope: scopes[index % scopes.length],
      label: `부산 보고서 ${String(index + 1).padStart(3, "0")}`,
      requestedAt: new Date(Date.parse("2026-09-07T08:00:00.000Z") - index * 3_600_000).toISOString()
    });
  });
}

function historyReport(index: number, options: {
  status: EnergyReportJob["status"];
  scope: EnergyReportJob["request"]["scope"];
  label: string;
  requestedAt: string;
  request?: EnergyReportJob["request"];
}): EnergyReportJob {
  const identityId = options.scope === "site"
    ? reportSiteId
    : `50000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`;
  const request = options.request ?? {
    from: "2026-08-01",
    to: "2026-08-31",
    scope: options.scope,
    identityId,
    format: "pdf" as const
  };
  const report = browserReport(options.status, request);
  return {
    ...report,
    reportId: `40000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    createdAt: options.requestedAt,
    requestedAt: options.requestedAt,
    startedAt: options.status === "queued" ? null : options.requestedAt,
    completedAt: options.status === "completed" || options.status === "expired" ? options.requestedAt : null,
    expiresAt: options.status === "completed" ? "2026-10-01T00:00:00.000Z"
      : options.status === "expired" ? "2026-09-01T00:00:00.000Z" : null,
    target: { scope: request.scope, identityId: request.identityId, label: options.label }
  };
}

function dashboard(siteId: string) {
  return {
    capabilities: { read: true, control: true, manage: true, commission: true },
    site: {
      id: siteId,
      name: "테스트 주차장",
      customerName: "테스트 고객사",
      installationStatus: "installed",
      address: "서울시 강남구",
      tariffKwhRate: 160,
      timeZone: "Asia/Seoul"
    },
    summary: { totalFixtures: 10, onlineFixtures: 10, faultFixtures: 0, averageBrightness: 60 },
    floors: [],
    groups: [],
    gateways: []
  };
}

function summary(siteId: string) {
  return {
    siteId,
    timeZone: "Asia/Seoul",
    source: "state_based_estimate",
    generatedAt,
    today: { estimatedKwh: 4.25, estimatedCost: 680, knownSeconds: 43200, unknownSeconds: 0, dataStatus: "available" },
    monthToDate: { estimatedKwh: 120.5, estimatedCost: 19280, knownSeconds: 2073600, unknownSeconds: 7200, dataStatus: "partial" },
    yearToDate: { estimatedKwh: 900, estimatedCost: 144000, knownSeconds: 20000000, unknownSeconds: 7200, dataStatus: "partial" },
    monthForecast: { estimatedKwh: 160, estimatedCost: 25600, observedKnownSeconds: 2073600, reason: "available" },
    baseline24Hours: { estimatedKwh: 297.6, estimatedCost: 47616, fixtureCount: 10, daysInMonth: 31 },
    estimatedSavings: { kwh: 137.6, cost: 22016 },
    lastAggregatedAt: generatedAt
  };
}

function noDataSummary(siteId: string) {
  const period = { estimatedKwh: 0, estimatedCost: 0, knownSeconds: 0, unknownSeconds: 86400, dataStatus: "no_data" };
  return {
    ...summary(siteId),
    today: period,
    monthToDate: period,
    yearToDate: period,
    monthForecast: { estimatedKwh: null, estimatedCost: null, observedKnownSeconds: 0, reason: "insufficient_state" },
    estimatedSavings: { kwh: null, cost: null }
  };
}

function series(siteId: string, granularity: "day" | "month", from: string, to: string) {
  return {
    siteId,
    timeZone: "Asia/Seoul",
    source: "state_based_estimate",
    generatedAt,
    granularity,
    from,
    to,
    points: granularity === "day"
      ? [
          { source: "state_based_estimate", period: "2026-08-25", estimatedKwh: 4.1, estimatedCost: 656, knownSeconds: 86400, unknownSeconds: 0, dataStatus: "available" },
          { source: "state_based_estimate", period: "2026-08-26", estimatedKwh: 4.25, estimatedCost: 680, knownSeconds: 79200, unknownSeconds: 7200, dataStatus: "partial" },
          { source: "state_based_estimate", period: "2026-08-27", estimatedKwh: null, estimatedCost: null, knownSeconds: 0, unknownSeconds: 86400, dataStatus: "no_data" }
        ]
      : [
          { source: "state_based_estimate", period: "2026-07", estimatedKwh: 140, estimatedCost: 22400, knownSeconds: 2678400, unknownSeconds: 0, dataStatus: "available" },
          { source: "state_based_estimate", period: "2026-08", estimatedKwh: 120.5, estimatedCost: 19280, knownSeconds: 2073600, unknownSeconds: 7200, dataStatus: "partial" }
        ]
  };
}

type ComparisonOutcome = "saving" | "overuse" | "unavailable";
type ComparisonPreset = "last_7_days" | "current_month" | "current_year";

function comparisonPreset(value: string | null): ComparisonPreset {
  return value === "last_7_days" || value === "current_year" ? value : "current_month";
}

function comparison(preset: ComparisonPreset, outcome: ComparisonOutcome) {
  const unavailable = outcome === "unavailable";
  const overuse = outcome === "overuse";
  const period = preset === "current_year" ? "2026-08" : "2026-08-25";
  const estimatedKwh = unavailable ? null : overuse ? 110 : 65;
  return {
    siteId: "00000000-0000-4000-8000-000000000003",
    timeZone: "Asia/Seoul",
    source: "state_based_estimate",
    generatedAt,
    preset,
    range: { from: "2026-08-01", to: "2026-08-31", completedThrough: "2026-08-25" },
    summary: {
      baselineKwh: 100,
      estimatedKwh,
      savingsKwh: unavailable ? null : overuse ? -10 : 35,
      savingsCost: unavailable ? null : overuse ? -1_600 : 5_600,
      savingsRatePercent: unavailable ? null : overuse ? -10 : 35,
      outcome,
      forecastReason: preset === "current_month"
        ? unavailable ? "insufficient_state" : "available"
        : "not_applicable"
    },
    priorComparisons: [],
    points: [{
      period,
      baselineKwh: 100,
      estimatedKwh,
      phase: unavailable ? "unavailable" : preset === "current_month" ? "forecast" : "observed",
      knownSeconds: unavailable ? 0 : 79_200,
      unknownSeconds: unavailable ? 86_400 : 7_200,
      coverageRate: unavailable ? null : 0.9167,
      dataStatus: unavailable ? "no_data" : "partial"
    }]
  };
}

function customComparison(from: string, to: string, siteId = reportSiteId) {
  const { preset: _preset, ...base } = comparison("last_7_days", "saving");
  return { ...base, siteId, selection: { kind: "custom", from, to },
    range: { from, to, completedThrough: to },
    summary: { ...base.summary, forecastReason: "not_applicable" },
    points: base.points.map((point) => ({ ...point, period: from, phase: "observed" })) };
}

function ranking(dimension: string, metric: string, sort: string, from: string, to: string, siteId = reportSiteId) {
  const name = dimension === "group" ? "출입구 그룹" : dimension === "fixture" ? "B1-L01" : "B1 주차장";
  return {
    siteId,
    timeZone: "Asia/Seoul",
    source: "state_based_estimate",
    generatedAt,
    dimension,
    metric,
    sort,
    range: { from, to },
    siteTotalKwh: 20,
    siteTotalCost: 3200,
    overlappingMemberships: dimension === "group",
    legacyExcludedBefore: null,
    ranked: [{
      identityId: "30000000-0000-4000-8000-000000000020",
      operationalId: "30000000-0000-4000-8000-000000000020",
      name,
      rank: 1,
      fixtureCount: 8,
      estimatedKwh: 12.5,
      estimatedCost: 2000,
      contributionRate: 0.625,
      perFixtureAverageKwh: 1.5625,
      metricValue: metric === "cost" ? 2000 : metric === "contribution" ? 0.625 : metric === "per_fixture_average" ? 1.5625 : 12.5,
      knownSeconds: 691200,
      unknownSeconds: 0,
      coverageRate: 1,
      dataStatus: "available",
      historyQuality: "observed",
      unrankedReason: null,
      previousPeriod: { estimatedKwh: 14, changeRatePercent: -10.71, rank: 1 },
      dailyPoints: [{ period: to, estimatedKwh: 1.3, dataStatus: "available" }],
      fixtures: [{ identityId: "30000000-0000-4000-8000-000000000002", name: "B1-L01", estimatedKwh: 2.1 }]
    }],
    unranked: []
  };
}

async function gridColumnCount(page: Page) {
  return page.getByRole("group", { name: "에너지 요약" }).locator(":scope > *").evaluateAll((elements) => {
    return new Set(elements.map((element) => Math.round(element.getBoundingClientRect().x))).size;
  });
}

async function chooseOption(page: Page, container: Locator, label: string, option: string) {
  const history = label === "페이지당 항목 수" || await container.getAttribute("aria-label") === "보고서 이력 필터";
  const target = history ? await openFilter(page, "보고서 조건") : container;
  await target.getByRole("button", { name: label === "페이지당 항목 수" ? "페이지 크기" : label, exact: true }).click();
  await page.getByRole("option", { name: option, exact: true }).click();
  if (history) await target.getByRole("button", { name: "필터 닫기" }).click();
}

async function openFilter(page: Page, label: string) {
  const dialog = page.getByRole("dialog", { name: label, exact: true });
  if (!await dialog.isVisible()) await page.getByRole("button", { name: new RegExp(`${label} 상세 필터`) }).click();
  await expect(dialog).toBeVisible();
  return dialog;
}

async function expectLocatorTouchTarget(target: Locator, label: string) {
  await target.scrollIntoViewIfNeeded();
  await expect(target, `${label} is enabled`).toBeEnabled();
  const bounds = await target.boundingBox();
  expect(bounds, `${label} exists`).not.toBeNull();
  expect(bounds!.width, `${label} width`).toBeGreaterThanOrEqual(44);
  expect(bounds!.height, `${label} height`).toBeGreaterThanOrEqual(44);
}

async function setDatePicker(container: Locator, label: string, value: string) {
  const analysis = label === "시작일" || label === "종료일";
  const target = analysis ? await openFilter(container.page(), "사용량 분석 조건") : container;
  const [year, month, day] = value.split("-");
  const segments = target.getByRole("group", { name: label }).getByRole("spinbutton");
  await segments.nth(2).fill(String(Number(day)));
  await segments.nth(1).fill(String(Number(month)));
  await segments.nth(0).fill(year);
  if (analysis) await target.getByRole("button", { name: "필터 닫기" }).click();
}

async function setDateRangePicker(container: Locator, label: string, start: string, end: string) {
  const dialog = await openFilter(container.page(), "보고서 조건");
  const segments = dialog.getByRole("group", { name: label }).getByRole("spinbutton");
  for (const [offset, value] of [[0, start], [3, end]] as const) {
    const [year, month, day] = value.split("-");
    await segments.nth(offset + 2).fill(String(Number(day)));
    await segments.nth(offset + 1).fill(String(Number(month)));
    await segments.nth(offset).fill(year);
  }
  await dialog.getByRole("button", { name: "필터 닫기", exact: true }).click();
}

async function expectDatePicker(container: Locator, label: string, value: string) {
  const analysis = label === "시작일" || label === "종료일";
  const target = analysis ? await openFilter(container.page(), "사용량 분석 조건") : container;
  const [year, month, day] = value.split("-").map(Number);
  const segments = target.getByRole("group", { name: label }).getByRole("spinbutton");
  await expect(segments.nth(0)).toHaveAttribute("aria-valuenow", String(year));
  await expect(segments.nth(1)).toHaveAttribute("aria-valuenow", String(month));
  await expect(segments.nth(2)).toHaveAttribute("aria-valuenow", String(day));
  if (analysis) await target.getByRole("button", { name: "필터 닫기" }).click();
}

async function underlineNavigationVisual(container: Locator, item: Locator) {
  const [containerVisual, itemVisual] = await Promise.all([
    container.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        backgroundColor: style.backgroundColor,
        borderBottomWidth: style.borderBottomWidth,
        borderLeftWidth: style.borderLeftWidth,
        borderRadius: style.borderRadius,
        borderRightWidth: style.borderRightWidth,
        borderTopWidth: style.borderTopWidth,
        padding: style.padding
      };
    }),
    item.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        backgroundColor: style.backgroundColor,
        borderBottomColor: style.borderBottomColor,
        borderBottomWidth: style.borderBottomWidth,
        borderRadius: style.borderRadius,
        boxShadow: style.boxShadow,
        color: style.color,
        height: element.getBoundingClientRect().height,
        padding: style.padding
      };
    })
  ]);
  return { container: containerVisual, item: itemVisual };
}

async function underlineNavigationAlignment(container: Locator) {
  return container.evaluate((element) => {
    const track = element.querySelector<HTMLElement>("[data-navigation-track]") ?? element;
    const selected = element.querySelector<HTMLElement>("[role='tab'][aria-selected='true']");
    if (!selected) throw new Error("underline navigation layout is incomplete");
    const wrapperRect = element.getBoundingClientRect();
    const trackRect = track.getBoundingClientRect();
    const tabRect = selected.getBoundingClientRect();
    return {
      wrapperHeight: wrapperRect.height,
      wrapperBottom: wrapperRect.bottom,
      trackHeight: trackRect.height,
      trackBottom: trackRect.bottom,
      tabHeight: tabRect.height
    };
  });
}

async function expectReportPanelLayout(page: Page, stacked: boolean) {
  const [chart, costs] = await Promise.all([
    page.getByRole("region", { name: "상태 기반 추정 사용량" }).boundingBox(),
    page.getByRole("complementary", { name: "비용 비교" }).boundingBox()
  ]);
  expect(chart).not.toBeNull();
  expect(costs).not.toBeNull();
  if (!chart || !costs) return;

  if (stacked) {
    expect(costs.y).toBeGreaterThanOrEqual(chart.y + chart.height - 1);
  } else {
    expect(costs.x).toBeGreaterThanOrEqual(chart.x + chart.width - 1);
  }
}

async function expectComparisonPanelLayout(page: Page, stacked: boolean) {
  const [chart, comparisonPanel] = await Promise.all([
    page.getByRole("region", { name: "기준 대비 사용량 비교" }).boundingBox(),
    page.getByRole("complementary", { name: "동기간 비교" }).boundingBox()
  ]);
  expect(chart).not.toBeNull();
  expect(comparisonPanel).not.toBeNull();
  if (!chart || !comparisonPanel) return;

  if (stacked) {
    expect(comparisonPanel.y).toBeGreaterThanOrEqual(chart.y + chart.height - 1);
  } else {
    expect(comparisonPanel.x).toBeGreaterThanOrEqual(chart.x + chart.width - 1);
  }
}
