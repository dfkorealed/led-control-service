import { expect, type BrowserContext, type CDPSession, type Locator, type Page, type TestInfo } from "@playwright/test";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { inflateSync } from "node:zlib";
import { isAbsolute } from "node:path";

export type NativePngContent = {
  data: string;
  viewportWidth: number;
  viewportHeight: number;
};

export function validateNativePngContent(witness: NativePngContent) {
  if (typeof witness.data !== "string") throw new Error("Missing original PNG data");
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(witness.data)) throw new Error("Malformed PNG base64");
  const bytes = Buffer.from(witness.data, "base64");
  if (bytes.length < 33 || bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a" || bytes.readUInt32BE(8) !== 13 || bytes.toString("ascii", 12, 16) !== "IHDR") throw new Error("Missing PNG signature/IHDR");
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
  if (width !== witness.viewportWidth || height !== witness.viewportHeight || width < 1 || height < 1) throw new Error(`PNG viewport mismatch: ${width}x${height}`);
  // Chromium's public raster frame is RGB/RGBA, 8-bit, non-interlaced. An
  // unexpected encoding is a method limitation, never silently converted.
  const channels = bytes[25] === 2 ? 3 : bytes[25] === 6 ? 4 : 0;
  if (bytes[24] !== 8 || !channels || bytes[26] !== 0 || bytes[27] !== 0 || bytes[28] !== 0) throw new Error("Unsupported original PNG encoding");
  const compressed: Buffer[] = []; let ended = false;
  for (let offset = 8; offset < bytes.length;) {
    if (offset + 12 > bytes.length) throw new Error("Truncated PNG chunk");
    const length = bytes.readUInt32BE(offset), end = offset + length + 12;
    if (end > bytes.length) throw new Error("Truncated PNG payload");
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    if (type === "IDAT") compressed.push(bytes.subarray(offset + 8, end - 4));
    if (type === "IEND") { ended = true; if (end !== bytes.length) throw new Error("Trailing PNG bytes"); }
    offset = end;
  }
  if (!ended || !compressed.length) throw new Error("Incomplete original PNG");
  const stride = width * channels, rawSize = (stride + 1) * height;
  const raw = inflateSync(Buffer.concat(compressed), { maxOutputLength: rawSize });
  if (raw.length !== rawSize) throw new Error("PNG decoded dimensions mismatch");
  const pixels = Buffer.alloc(stride * height);
  for (let row = 0; row < height; row++) {
    const filter = raw[row * (stride + 1)]!;
    if (filter > 4) throw new Error("Invalid PNG row filter");
    for (let column = 0; column < stride; column++) {
      const index = row * stride + column, left = column >= channels ? pixels[index - channels]! : 0;
      const up = row ? pixels[index - stride]! : 0, upperLeft = row && column >= channels ? pixels[index - stride - channels]! : 0;
      const prediction = left + up - upperLeft, distances = [Math.abs(prediction - left), Math.abs(prediction - up), Math.abs(prediction - upperLeft)];
      const paeth = distances[0]! <= distances[1]! && distances[0]! <= distances[2]! ? left : distances[1]! <= distances[2]! ? up : upperLeft;
      const addition = [0, left, up, Math.floor((left + up) / 2), paeth][filter]!;
      pixels[index] = (raw[row * (stride + 1) + column + 1]! + addition) & 255;
    }
  }
  let nonblank = false;
  for (let index = channels; index < pixels.length; index++) if (pixels[index] !== pixels[index % channels]) { nonblank = true; break; }
  if (!nonblank) throw new Error("Blank original PNG");
  return { bytes, width, height, byteLength: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), signature: bytes.subarray(0, 8).toString("hex"), channels, nonblank };
}

export type NativeFinalStateExpectation = {
  description: string;
  // Read-only caller-specific DOM assertions, not a paint fence or pixel oracle.
  observe: () => Promise<unknown>;
};
type SourceManifest = { cwd: string; sourceHashes: Record<string, string | null> };
function verifySourceFrozen(source: SourceManifest) {
  for (const [file, expected] of Object.entries(source.sourceHashes)) {
    const actual = existsSync(`${source.cwd}/${file}`) ? execFileSync("git", ["hash-object", "--", file], { cwd: source.cwd, encoding: "utf8" }).trim() : null;
    if (actual !== expected) throw new Error(`Unfrozen source: ${file}`);
  }
}

async function geometry(page: Page, cdp: CDPSession) {
  return { utc: new Date().toISOString(), url: page.url(), dom: await page.evaluate(() => ({
    innerWidth, innerHeight, outerWidth, outerHeight, dpr: devicePixelRatio,
    clientWidth: document.documentElement.clientWidth, clientHeight: document.documentElement.clientHeight,
    scrollWidth: document.documentElement.scrollWidth, scrollHeight: document.documentElement.scrollHeight,
    scrollX, scrollY, browserEpochMs: Date.now(),
    visual: visualViewport ? { width: visualViewport.width, height: visualViewport.height, scale: visualViewport.scale, offsetLeft: visualViewport.offsetLeft, offsetTop: visualViewport.offsetTop, pageLeft: visualViewport.pageLeft, pageTop: visualViewport.pageTop } : null
  })), layoutMetrics: await cdp.send("Page.getLayoutMetrics"), frameTree: await cdp.send("Page.getFrameTree"), target: await cdp.send("Target.getTargetInfo") };
}

function geometryIdentity(value: Awaited<ReturnType<typeof geometry>>) {
  const { browserEpochMs: _hostIndependentObservationTime, ...dom } = value.dom;
  const frame = value.frameTree.frameTree.frame;
  return { url: value.url, targetId: value.target.targetInfo.targetId, frameId: frame.id, loaderId: frame.loaderId, frameUrl: frame.url, dom };
}

type SnapshotRequest = {
  label: string; method: "Page.captureScreenshot";
  params: { format: "png"; fromSurface: true; captureBeyondViewport: false; optimizeForSpeed: false };
  intent: unknown; intentPersistedAt?: string; requestStartedAt?: string; responseReceivedAt?: string;
  responseError?: string; responseErrorAt?: string; deadlineExpiredAt?: string; error?: string; persistenceError?: string;
  rawResponsePath?: string; rawResponsePersisted?: boolean; imagePath?: string; originalBytesPersisted?: boolean;
  rawPng?: { byteLength: number; sha256: string; signature: string; ihdrWidth: number | null; ihdrHeight: number | null };
};

export class StatisticsNativeZoomEvidence {
  private zoomReady = false;
  private sessionLive = true;
  private pendingWrites = new Set<Promise<void>>();
  private manifest: Record<string, unknown> = {};
  private constructor(private page: Page, private cdp: CDPSession, private info: TestInfo, readonly profile: string, private targetId: string) {}

  static async create(context: BrowserContext, page: Page, info: TestInfo) {
    const cdp = await context.newCDPSession(page);
    const preflight: Record<string, unknown> = { utc: new Date().toISOString(), stage: "source-manifest" };
    const persist = () => writeFile(info.outputPath("native-zoom-preflight.json"), JSON.stringify(preflight, null, 2));
    const stage = async (name: string) => { preflight.stage = name; preflight.stageAt = new Date().toISOString(); await persist(); };
    try {
      await persist();
      const sourcePath = process.env.TASK7_SOURCE_METADATA;
      if (!sourcePath) throw new Error("Missing prospective source manifest");
      const source = JSON.parse(await readFile(sourcePath, "utf8"));
      Object.assign(preflight, { sourcePath, source });
      await stage("Browser.getVersion");
      const version = await cdp.send("Browser.getVersion"); preflight.version = version; await persist();
      await stage("Browser.newBrowserCDPSession");
      const browser = context.browser();
      if (!browser) throw new Error("No public browser for owned context");
      const browserSession = await browser.newBrowserCDPSession();
      let commandLine: { method: "SystemInfo.getInfo"; raw: string }, profile: string;
      try {
        await stage("SystemInfo.getInfo");
        const systemInfo = await browserSession.send("SystemInfo.getInfo");
        preflight.systemInfo = systemInfo;
        commandLine = { method: "SystemInfo.getInfo", raw: systemInfo.commandLine };
        preflight.commandLine = commandLine; await persist();
        // SystemInfo supplies the actual raw string, NOT CDP's argv response.
        // Extract only its unambiguous observed profile token; never substitute
        // launcher declarations, process scans or flags to obtain provenance.
        const matches = [...commandLine.raw.matchAll(/(?:^|\s)--user-data-dir=(?:"([^"\r\n]+)"|'([^'\r\n]+)'|([^\s"']+))(?=\s|$)/g)];
        const occurrences = [...commandLine.raw.matchAll(/(?:^|\s)--user-data-dir(?:=|\s|$)/g)];
        if (!commandLine.raw.trim() || matches.length !== 1 || occurrences.length !== 1) throw new Error("Empty or ambiguous observed browser profile");
        profile = matches[0]![1] ?? matches[0]![2] ?? matches[0]![3]!;
        if (!isAbsolute(profile) || !existsSync(profile)) throw new Error("Missing observed owned persistent profile");
        preflight.profile = profile; await persist();
      } finally {
        await browserSession.detach(); preflight.browserSessionDetachedAt = new Date().toISOString(); await persist();
      }
      await stage("Target.getTargetInfo");
      const target = await cdp.send("Target.getTargetInfo"); preflight.target = target; await persist();
      await stage("Page.getFrameTree");
      const frameTree = await cdp.send("Page.getFrameTree"); preflight.frameTree = frameTree; await persist();
      await stage("source-freeze");
      verifySourceFrozen(source);
      const evidence = new StatisticsNativeZoomEvidence(page, cdp, info, profile, target.targetInfo.targetId);
      evidence.manifest = { captureMethod: "Page.captureScreenshot/png/primary", createdAt: new Date().toISOString(), version, commandLine, target, frameTree, profile, preflight,
        process: { pid: process.pid, node: process.version, executable: process.execPath, platform: process.platform, arch: process.arch }, sourcePath, source,
        launch: info.project.use, trace: info.project.use.trace, calls: [], captures: [], snapshotRequests: [] };
      await evidence.persist();
      return evidence;
    } catch (error) {
      preflight.error = { stage: preflight.stage, utc: new Date().toISOString(), message: String(error) }; await persist();
      try { await cdp.detach(); preflight.pageSessionDetachedAt = new Date().toISOString(); }
      catch (cleanupError) { preflight.pageSessionCleanupError = String(cleanupError); }
      await persist();
      throw new Error(`NEEDS_CONTEXT: native preflight ${String(preflight.stage)}: ${String(error)}`);
    }
  }

  private async persist() {
    await writeFile(this.info.outputPath("native-zoom-provenance.json"), JSON.stringify(this.manifest, null, 2));
  }

  async global200(context: BrowserContext) {
    const settings = await context.newPage();
    await settings.goto("chrome://settings/appearance");
    const control = settings.locator("select#zoomLevel");
    await control.selectOption("1"); await expect(control).toHaveValue("1");
    const baselineReadback = await control.inputValue();
    await this.page.bringToFront(); await this.page.reload();
    const before = await geometry(this.page, this.cdp);
    await settings.bringToFront(); await control.selectOption("2"); await expect(control).toHaveValue("2");
    const zoomReadback = await control.inputValue();
    await this.page.bringToFront(); await this.page.reload();
    const after = await geometry(this.page, this.cdp);
    this.manifest.zoom = { baselineReadback, zoomReadback, before, after, settingsUrl: settings.url(), completedAt: new Date().toISOString() };
    await this.persist();
    expect(after.target.targetInfo.targetId).toBe(this.targetId);
    expect(before.target.targetInfo.targetId).toBe(this.targetId);
    expect(after.dom.dpr / before.dom.dpr).toBe(2);
    expect(Math.abs(after.dom.innerWidth * 2 - before.dom.innerWidth)).toBeLessThanOrEqual(1);
    expect(after.dom.outerWidth).toBe(before.dom.outerWidth); expect(after.dom.outerHeight).toBe(before.dom.outerHeight);
    expect(after.dom.visual?.scale).toBe(1); expect(before.dom.visual?.scale).toBe(1);
    this.manifest.primaryReadyAt = new Date().toISOString();
    await this.persist();
    this.zoomReady = true;
    return { before, after };
  }

  async capture(label: string, trigger: Locator, action: () => Promise<void>, keys: string[], finalState: NativeFinalStateExpectation) {
    if (!this.zoomReady) throw new Error("Native zoom not ready");
    await trigger.scrollIntoViewIfNeeded();
    const inputGeometry = await geometry(this.page, this.cdp);
    this.manifest.beforeCapture = { label, inputGeometry, utc: new Date().toISOString() }; await this.persist();
    const bounds = await trigger.boundingBox();
    if (!bounds) throw new Error("Disconnected native input target");
    const input = { startedAt: new Date().toISOString(), target: await trigger.getAttribute("aria-label"), bounds,
      pointer: { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 }, keys,
      dispatches: [] as Array<{ kind: "pointer" | "key"; key?: string; startedAt: string; startedEpochSeconds: number; completedAt: string }>,
      completedAt: "", assertionsCompletedAt: "" };
    this.manifest.lastInput = input;
    // Mark directly before each actual dispatch, not before an awaited write,
    // action assertion or the entire capture. Protocol completion may lag the
    // resulting raster; focus assertions are a separate completion boundary.
    const dispatch = async (kind: "pointer" | "key", perform: () => Promise<void>, key?: string) => {
      const start = Date.now();
      const record = { kind, key, startedAt: new Date(start).toISOString(), startedEpochSeconds: start / 1000, completedAt: "" };
      input.dispatches.push(record);
      await perform(); record.completedAt = new Date().toISOString();
    };
    await dispatch("pointer", () => this.page.mouse.click(input.pointer.x, input.pointer.y));
    await action(); for (const key of keys) await dispatch("key", () => this.page.keyboard.press(key), key);
    input.completedAt = new Date().toISOString();
    await expect(trigger).toBeFocused(); input.assertionsCompletedAt = new Date().toISOString();
    const observe = async () => {
      const observation = { description: finalState.description, startedAt: new Date().toISOString(), completedAt: "", value: undefined as unknown, error: undefined as string | undefined };
      (this.manifest.stateObservations ??= []) as unknown[];
      (this.manifest.stateObservations as unknown[]).push(observation);
      try { observation.value = await finalState.observe(); await expect(trigger).toBeFocused(); observation.completedAt = new Date().toISOString(); }
      catch (error) { observation.error = String(error); await this.persist(); throw error; }
      return observation;
    };
    const finalStateBefore = await observe();
    const before = await geometry(this.page, this.cdp);
    if (before.target.targetInfo.targetId !== this.targetId) throw new Error("Snapshot target drift before request");
    const request: SnapshotRequest = { label, method: "Page.captureScreenshot", params: { format: "png", fromSurface: true, captureBeyondViewport: false, optimizeForSpeed: false },
      intent: { finalStateBefore, before, input } };
    (this.manifest.snapshotRequests as SnapshotRequest[]).push(request);
    await this.persist(); request.intentPersistedAt = new Date().toISOString();
    // Separate prospective PRIMARY, never an on-timeout fallback. Host request
    // ordering is recorded, not forged as a browser frame timestamp or ACK.
    request.requestStartedAt = new Date().toISOString();
    (this.manifest.calls as unknown[]).push({ method: request.method, params: request.params, requestStartedAt: request.requestStartedAt });
    const transport = this.cdp.send("Page.captureScreenshot", request.params).then(response => {
      request.responseReceivedAt = new Date().toISOString();
      if (!this.sessionLive) throw new Error("Snapshot response after owned session detached");
      const saved = this.trackWrite(this.preserveResponse(request, response));
      return { response, saved };
    }, error => {
      request.responseError = String(error); request.responseErrorAt = new Date().toISOString();
      if (this.sessionLive) this.trackWrite(this.persist());
      throw error;
    });
    // The operation deadline does not cancel CDP. Late rejection is handled;
    // payloads actually returned while this session lives are still preserved.
    void transport.catch(() => undefined);
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      const { response, saved } = await Promise.race([transport, new Promise<never>((_, reject) => {
        deadline = setTimeout(() => { request.deadlineExpiredAt = new Date().toISOString(); reject(new Error("NEEDS_CONTEXT: snapshot response deadline")); }, 8000);
      })]);
      if (deadline) clearTimeout(deadline); deadline = undefined;
      await saved;
      const after = await geometry(this.page, this.cdp);
      if (JSON.stringify(geometryIdentity(before)) !== JSON.stringify(geometryIdentity(after))) throw new Error("Snapshot geometry/target/loader/URL drift");
      verifySourceFrozen(this.manifest.source as SourceManifest);
      const finalStateAfter = await observe();
      if (JSON.stringify(finalStateBefore.value) !== JSON.stringify(finalStateAfter.value)) throw new Error("Snapshot final state drift");
      const baseline = (this.manifest.zoom as { before: Awaited<ReturnType<typeof geometry>> }).before.dom;
      const png = validateNativePngContent({ data: response.data, viewportWidth: baseline.innerWidth, viewportHeight: baseline.innerHeight });
      const record = { label, utc: new Date().toISOString(), imagePath: request.imagePath!, inputGeometry, input, request,
        finalStateBefore, finalStateAfter, before, after, targetId: after.target.targetInfo.targetId,
        pixelApproval: { status: "pending", reviewer: "root", expectedState: finalState.description }, png: { ...png, bytes: undefined } };
      (this.manifest.captures as unknown[]).push(record); await this.persist();
      await this.info.attach(label, { path: record.imagePath, contentType: "image/png" });
      return record;
    } catch (error) {
      request.error = String(error);
      try { await this.persist(); } catch (persistenceError) { request.persistenceError = String(persistenceError); }
      throw error;
    } finally { if (deadline) clearTimeout(deadline); }
  }

  private trackWrite(write: Promise<void>) {
    this.pendingWrites.add(write);
    void write.then(() => this.pendingWrites.delete(write), () => this.pendingWrites.delete(write));
    return write;
  }

  private async preserveResponse(request: SnapshotRequest, response: unknown) {
    request.rawResponsePath = this.info.outputPath(`${request.label}-response.json`);
    try {
      // Raw textual/base64 response remains lossless even if decoding/PNG checks
      // reject it. Save original bytes BEFORE state/source/geometry validation.
      await writeFile(request.rawResponsePath, JSON.stringify(response) ?? "undefined"); request.rawResponsePersisted = true;
      const data = (response as { data?: unknown })?.data;
      if (typeof data !== "string") throw new Error("Missing original PNG data");
      const original = Buffer.from(data, "base64"); request.imagePath = this.info.outputPath(`${request.label}-original.png`);
      request.rawPng = { byteLength: original.length, sha256: createHash("sha256").update(original).digest("hex"), signature: original.subarray(0, 8).toString("hex"),
        ihdrWidth: original.length >= 24 ? original.readUInt32BE(16) : null, ihdrHeight: original.length >= 24 ? original.readUInt32BE(20) : null };
      await writeFile(request.imagePath, original); request.originalBytesPersisted = true;
      await this.persist();
    } catch (error) { request.persistenceError = String(error); throw error; }
  }

  async stop() {
    let firstError: unknown;
    const errors: Array<{ stage: string; message: string }> = [];
    const attempt = async (stage: string, operation: () => Promise<unknown>) => {
      try { await operation(); } catch (error) { firstError ??= error; errors.push({ stage, message: String(error) }); }
    };
    // A deadline leaves CDP work pending, but cleanup never waits indefinitely
    // for that transport. Detach independently, then settle writes of responses
    // actually delivered while the owned session was alive, including late IO.
    try { await attempt("persist-before-detach", () => this.persist()); }
    finally {
      await attempt("Page-session-detach", async () => { await this.cdp.detach(); this.manifest.pageSessionDetachedAt = new Date().toISOString(); });
      this.sessionLive = false;
      await attempt("settle-returned-response-writes", async () => { await Promise.all([...this.pendingWrites]); });
    }
    this.manifest.sessionCleanupErrors = errors;
    await attempt("persist-cleanup", () => this.persist());
    if (firstError) throw firstError;
  }

  async recordContextCleanup() {
    this.manifest.cleanup = { utc: new Date().toISOString(), profile: this.profile, profileExists: existsSync(this.profile) };
    await this.persist(); expect(existsSync(this.profile)).toBe(false);
    await this.info.attach("native-zoom-provenance", { path: this.info.outputPath("native-zoom-provenance.json"), contentType: "application/json" });
  }
}
