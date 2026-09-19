import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { open, statfs, unlink, type FileHandle } from "node:fs/promises";
import { dirname } from "node:path";
import { Transform } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { pipeline } from "node:stream/promises";
import { createGunzip, createGzip } from "node:zlib";
import { computeCadBounds, createCadSplineSampler, iterateCadDocumentExpansion } from "./cad-geometry";
import { CAD_MAX_DETECTED_REGIONS } from "./cad-region-detector";
import { CAD_IMPORT_TEMP_FILESYSTEM_OVERHEAD_BYTES, CAD_RENDERED_SVG_MAX_BYTES, CAD_RENDERED_SVG_RAW_MAX_BYTES } from "./cad-resource-limits";
import { CAD_MAX_PARSED_ENTITIES, CAD_MAX_SPLINE_SAMPLES_PER_DOCUMENT } from "./cad-runtime-contract";
import { createCadSvgEntitySerializer, type CadSvgFileResult } from "./cad-svg-renderer";
import type { CadBounds, NormalizedCadDocument } from "./cad-types";
import { cadViewportScale, cadViewportSvgTransform, createCadViewport } from "./cad-viewport";

export interface CadRegionPreviewTarget {
  regionId: string;
  bounds: CadBounds;
  outputPath: string;
}

interface PreviewOptions {
  maxOpenFiles?: number;
  maxBufferedBytes?: number;
  maxTotalRawBytes?: number;
  maxTotalOutputBytes?: number;
  maxRoutingSteps?: number;
  maxDurationMs?: number;
  maxRetainedDefinitions?: number;
  maxOutputBytes?: number;
  compactFallback?: { path: string; bounds: CadBounds; rendered: CadSvgFileResult };
  checkBudget?: () => void;
}

interface PreviewState {
  target: CadRegionPreviewTarget;
  rawPath: string;
  viewport: { width: number; height: number };
  pointRadius: number;
  pieces: string[];
  bufferedBytes: number;
  rawBytes: number;
  occurrences: number;
  definitions: Set<number>;
}

interface RegionNode {
  bounds: CadBounds;
  indexes?: number[];
  left?: RegionNode;
  right?: RegionNode;
}

function overlaps(a: CadBounds, b: CadBounds): boolean {
  return a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY;
}

function buildRegionIndex(targets: readonly CadRegionPreviewTarget[], indexes: number[]): RegionNode {
  const bounds = { ...targets[indexes[0]].bounds };
  for (const index of indexes) {
    const b = targets[index].bounds;
    bounds.minX = Math.min(bounds.minX, b.minX);
    bounds.minY = Math.min(bounds.minY, b.minY);
    bounds.maxX = Math.max(bounds.maxX, b.maxX);
    bounds.maxY = Math.max(bounds.maxY, b.maxY);
  }
  if (indexes.length <= 8) return { bounds, indexes };
  const axis = bounds.maxX - bounds.minX >= bounds.maxY - bounds.minY ? "X" : "Y";
  indexes.sort((a, b) => targets[a].bounds[`min${axis}`] + targets[a].bounds[`max${axis}`] -
    targets[b].bounds[`min${axis}`] - targets[b].bounds[`max${axis}`]);
  const middle = Math.floor(indexes.length / 2);
  return { bounds, left: buildRegionIndex(targets, indexes.slice(0, middle)), right: buildRegionIndex(targets, indexes.slice(middle)) };
}

/** One expansion feeds every preview; SVG viewport clipping handles overlapping region bounds. */
export async function renderCadRegionPreviewFiles(
  document: NormalizedCadDocument,
  targets: readonly CadRegionPreviewTarget[],
  options: PreviewOptions = {}
): Promise<{
  previews: Array<CadSvgFileResult & { regionId: string }>;
  expandedOccurrences: number;
  routedOccurrences: number;
  peakOpenFiles: number;
  peakBufferedBytes: number;
  totalRawBytes: number;
  totalOutputBytes: number;
}> {
  const maxOpenFiles = options.maxOpenFiles ?? 16;
  const maxBufferedBytes = options.maxBufferedBytes ?? 8 * 1024 * 1024;
  let maxTotalRawBytes = options.maxTotalRawBytes ?? 256 * 1024 * 1024;
  const maxTotalOutputBytes = options.maxTotalOutputBytes ?? 32 * 1024 * 1024;
  const maxRoutingSteps = options.maxRoutingSteps ?? 50_000_000;
  const maxDurationMs = options.maxDurationMs ?? 30_000;
  const maxRetainedDefinitions = options.maxRetainedDefinitions ?? 50_000;
  const maxOutputBytes = options.maxOutputBytes ?? CAD_RENDERED_SVG_MAX_BYTES;
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1 || maxOutputBytes > CAD_RENDERED_SVG_MAX_BYTES) {
    throw new Error("Invalid CAD preview per-file output budget");
  }
  if (!Number.isSafeInteger(maxRetainedDefinitions) || maxRetainedDefinitions < 0) throw new Error("Invalid CAD preview definition budget");
  for (const limit of [maxOpenFiles, maxBufferedBytes, maxTotalRawBytes, maxTotalOutputBytes, maxRoutingSteps, maxDurationMs]) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("Invalid CAD preview budget");
  }
  if (targets.length > CAD_MAX_DETECTED_REGIONS || new Set(targets.map(t => t.outputPath)).size !== targets.length ||
      new Set(targets.map(t => t.regionId)).size !== targets.length) throw new Error("Invalid CAD preview targets");
  const started = performance.now();
  const checkBudget = () => {
    options.checkBudget?.();
    if (performance.now() - started > maxDurationMs) throw new Error("CAD preview time limit exceeded");
  };
  let routingSteps = 0;
  const chargeRouting = () => {
    if (++routingSteps % 1024 === 0) checkBudget();
    if (routingSteps > maxRoutingSteps) throw new Error("CAD preview routing work limit exceeded");
  };
  const states: PreviewState[] = targets.map(target => {
    const b = target.bounds;
    if (![b.minX, b.minY, b.maxX, b.maxY].every(Number.isFinite) || b.minX >= b.maxX || b.minY >= b.maxY) {
      throw new Error("Invalid CAD preview bounds");
    }
    const { width, height } = createCadViewport(b);
    return { target, rawPath: `${target.outputPath}.raw`, viewport: { width, height }, pointRadius: 3 / cadViewportScale(b),
      pieces: [], bufferedBytes: 0, rawBytes: 0, occurrences: 0, definitions: new Set() };
  });
  const handles = new Map<number, FileHandle>();
  const dirty = new Set<number>();
  const createdRaw = new Set<string>();
  const createdOutput = new Set<string>();
  let bufferedBytes = 0;
  let peakBufferedBytes = 0;
  let peakOpenFiles = 0;
  let totalRawBytes = 0;
  let totalOutputBytes = 0;
  let expandedOccurrences = 0;
  let routedOccurrences = 0;
  const getHandle = async (index: number) => {
    let handle = handles.get(index);
    if (handle) handles.delete(index);
    else {
      if (handles.size >= maxOpenFiles) {
        const [oldIndex, oldHandle] = handles.entries().next().value!;
        await oldHandle.close();
        handles.delete(oldIndex);
      }
      const path = states[index].rawPath;
      handle = await open(path, createdRaw.has(path) ? "a" : "wx", 0o600);
      createdRaw.add(path);
    }
    handles.set(index, handle);
    peakOpenFiles = Math.max(peakOpenFiles, handles.size);
    return handle;
  };
  const flush = async (index: number) => {
    checkBudget();
    const state = states[index];
    if (!state.bufferedBytes) return;
    const content = state.pieces.join("");
    await (await getHandle(index)).writeFile(content, "utf8");
    bufferedBytes -= state.bufferedBytes;
    state.pieces = [];
    state.bufferedBytes = 0;
    dirty.delete(index);
  };
  const append = async (index: number, piece: string) => {
    const bytes = Buffer.byteLength(piece, "utf8");
    const state = states[index];
    if (state.rawBytes + bytes > CAD_RENDERED_SVG_RAW_MAX_BYTES || totalRawBytes + bytes > maxTotalRawBytes) {
      throw new Error("CAD preview aggregate raw output limit exceeded");
    }
    state.rawBytes += bytes;
    totalRawBytes += bytes;
    if (bytes > maxBufferedBytes) {
      await flush(index);
      await (await getHandle(index)).writeFile(piece, "utf8");
      return;
    }
    while (bufferedBytes + bytes > maxBufferedBytes) await flush(dirty.values().next().value!);
    state.pieces.push(piece);
    state.bufferedBytes += bytes;
    bufferedBytes += bytes;
    peakBufferedBytes = Math.max(peakBufferedBytes, bufferedBytes);
    dirty.add(index);
    if (state.bufferedBytes >= 64 * 1024) await flush(index);
  };
  const previews: Array<CadSvgFileResult & { regionId: string }> = [];
  try {
    if (targets.length > 0) {
      // Keep headroom for compression and filesystem overhead on the shared
      // 512 MiB import volume, including DWG/DXF/fallback files already present.
      const disk = await statfs(dirname(targets[0].outputPath));
      maxTotalRawBytes = Math.min(maxTotalRawBytes,
        disk.bavail * disk.bsize - CAD_IMPORT_TEMP_FILESYSTEM_OVERHEAD_BYTES - maxTotalOutputBytes);
      if (maxTotalRawBytes < 1) throw new Error("CAD preview temporary disk budget unavailable");
      const tree = buildRegionIndex(targets, targets.map((_, i) => i));
      for (let i = 0; i < states.length; i++) {
        const state = states[i];
        const { width, height } = state.viewport;
        await append(i, `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="CAD region preview"><rect width="100%" height="100%" fill="#fff"/><g fill="none" stroke="#1f2937" stroke-width="0.2" vector-effect="non-scaling-stroke" transform="${cadViewportSvgTransform(state.target.bounds)}">`);
      }
      const sampleSpline = createCadSplineSampler(CAD_MAX_SPLINE_SAMPLES_PER_DOCUMENT);
      const serialize = createCadSvgEntitySerializer(new Map(), 1, CAD_MAX_SPLINE_SAMPLES_PER_DOCUMENT, checkBudget);
      const definitionIds = new WeakMap<object, number>();
      let nextDefinitionId = 0;
      let retainedDefinitions = 0;
      const coordinate = (value: number) => String(Math.round(value * 1_000_000) / 1_000_000);
      for (const item of iterateCadDocumentExpansion(document, { maxRenderedEntities: CAD_MAX_PARSED_ENTITIES, maxBlockDepth: 32, checkBudget })) {
        if (!item) continue;
        expandedOccurrences++;
        const bounds = computeCadBounds([item], checkBudget, undefined, sampleSpline);
        const matches: number[] = [];
        const visit = (node: RegionNode) => {
          chargeRouting();
          if (!overlaps(bounds, node.bounds)) return;
          if (node.indexes) {
            for (const i of node.indexes) {
              chargeRouting();
              if (overlaps(bounds, targets[i].bounds)) matches.push(i);
            }
          } else { visit(node.left!); visit(node.right!); }
        };
        visit(tree);
        if (!matches.length) continue;
        const m = item.matrix;
        const opening = `<g transform="matrix(${[m.a, m.b, m.c, m.d, m.e, m.f].map(coordinate).join(" ")})">`;
        const shape = item.entity.type === "point" ? null : serialize(item.entity);
        for (const i of matches) {
          chargeRouting();
          let definition = "";
          let body = shape ?? serialize(item.entity, states[i].pointRadius);
          if (shape !== null) {
            let id = definitionIds.get(item.entity);
            if (id === undefined && retainedDefinitions < maxRetainedDefinitions) {
              id = nextDefinitionId++;
              definitionIds.set(item.entity, id);
            }
            if (id !== undefined) {
              const known = states[i].definitions.has(id);
              if (!known && retainedDefinitions < maxRetainedDefinitions) {
                states[i].definitions.add(id);
                retainedDefinitions++;
                definition = `<defs><g id="preview-shape-${id}">${shape}</g></defs>`;
              }
              // Cache saturation changes serialization only, never geometry or
              // region membership. Existing references remain valid; new shapes
              // are emitted directly without retaining more dictionary entries.
              if (known || definition) body = `<use href="#preview-shape-${id}"/>`;
            }
          }
          await append(i, definition + opening + body + "</g>");
          states[i].occurrences++;
          routedOccurrences++;
        }
      }
      for (let i = 0; i < states.length; i++) { await append(i, "</g></svg>"); await flush(i); }
    }
    for (const handle of handles.values()) await handle.close();
    handles.clear();
    // One compressor and one input/output pair at a time. No per-region gzip
    // buffers survive into the next preview, even for thousands of regions.
    for (const state of states) {
      checkBudget();
      let hash = createHash("sha256");
      let sizeBytes = 0;
      let rawSizeBytes = state.rawBytes;
      const perFileLimit = new Error("CAD preview per-file compressed output limit exceeded");
      const createMeter = () => new Transform({ transform(chunk: Buffer, _encoding, callback) {
        sizeBytes += chunk.length;
        totalOutputBytes += chunk.length;
        if (totalOutputBytes > maxTotalOutputBytes) {
          callback(new Error("CAD preview aggregate compressed output limit exceeded"));
          return;
        }
        if (sizeBytes > maxOutputBytes) {
          callback(perFileLimit);
          return;
        }
        hash.update(chunk);
        callback(null, chunk);
      } });
      const createOutput = () => {
        const output = createWriteStream(state.target.outputPath, { flags: "wx", mode: 0o600 });
        output.once("open", () => createdOutput.add(state.target.outputPath));
        return output;
      };
      try {
        await pipeline(createReadStream(state.rawPath), createGzip({ level: 9 }), createMeter(), createOutput());
      } catch (error) {
        if (error !== perFileLimit || !options.compactFallback) throw error;
        // A dense region may serialize larger when its INSERT hierarchy is
        // flattened. Reframe the already-rendered compact document instead of
        // increasing limits, dropping geometry, or expanding the CAD again.
        await unlink(state.target.outputPath);
        createdOutput.delete(state.target.outputPath);
        totalOutputBytes -= sizeBytes;
        sizeBytes = 0;
        hash = createHash("sha256");
        const reframed = reframeCompactSvg(options.compactFallback, state.target.bounds, checkBudget);
        await pipeline(createReadStream(options.compactFallback.path), createGunzip(), reframed.stream, reframed.points,
          createGzip({ level: 9 }), createMeter(), createOutput());
        rawSizeBytes = reframed.rawBytes();
      }
      await unlink(state.rawPath);
      createdRaw.delete(state.rawPath);
      previews.push({ regionId: state.target.regionId, viewport: state.viewport, sizeBytes, rawSizeBytes,
        sha256: hash.digest("hex"), renderedOccurrences: state.occurrences, contentEncoding: "gzip" });
    }
    checkBudget();
    return { previews, expandedOccurrences, routedOccurrences, peakOpenFiles, peakBufferedBytes, totalRawBytes, totalOutputBytes };
  } catch (error) {
    for (const handle of handles.values()) await handle.close().catch(() => undefined);
    for (const path of [...createdRaw, ...createdOutput]) await unlink(path).catch(() => undefined);
    throw error;
  }
}

function reframeCompactSvg(
  source: NonNullable<PreviewOptions["compactFallback"]>, bounds: CadBounds, checkBudget: () => void
): { stream: Transform; points: Transform; rawBytes: () => number } {
  const viewport = createCadViewport(bounds);
  const header = (width: number, height: number) =>
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"`;
  const group = (b: CadBounds) =>
    `</defs><g fill="none" stroke="#1f2937" stroke-width="0.2" vector-effect="non-scaling-stroke" transform="${cadViewportSvgTransform(b)}">`;
  // These two markers are emitted by our compact renderer, never supplied XML.
  // UTF-8 decoding plus a marker-length carry handles arbitrary stream boundaries
  // without parsing or retaining the multi-megabyte geometry body.
  const replacements = [
    [header(source.rendered.viewport.width, source.rendered.viewport.height), header(viewport.width, viewport.height)],
    [group(source.bounds), group(bounds)]
  ];
  const decoder = new StringDecoder("utf8");
  let carry = "";
  let phase = 0;
  let rawBytes = 0;
  const consume = (text: string, final: boolean) => {
    checkBudget();
    carry += text;
    let output = "";
    while (phase < replacements.length) {
      const [needle, replacement] = replacements[phase];
      const at = carry.indexOf(needle);
      if (at < 0) {
        const retain = final ? 0 : Math.min(carry.length, needle.length - 1);
        output += carry.slice(0, carry.length - retain);
        carry = carry.slice(carry.length - retain);
        if (final) throw new Error("Invalid compact CAD preview source structure");
        break;
      }
      output += carry.slice(0, at) + replacement;
      carry = carry.slice(at + needle.length);
      phase++;
    }
    if (phase === replacements.length) { output += carry; carry = ""; }
    return Buffer.from(output, "utf8");
  };
  const pointDecoder = new StringDecoder("utf8");
  const marker = '<path data-cad-entity="point" d="';
  const radius = 3 / cadViewportScale(bounds);
  let pointCarry = "";
  const rewritePoints = (text: string, final: boolean) => {
    pointCarry += text;
    let output = "";
    while (pointCarry.length > 0) {
      const start = pointCarry.indexOf(marker);
      if (start < 0) {
        const emit = final ? pointCarry.length : Math.max(0, pointCarry.length - marker.length + 1);
        output += pointCarry.slice(0, emit);
        pointCarry = pointCarry.slice(emit);
        break;
      }
      output += pointCarry.slice(0, start);
      pointCarry = pointCarry.slice(start);
      const end = pointCarry.indexOf("/>");
      if (end < 0) {
        if (final || pointCarry.length > 1024) throw new Error("Invalid compact CAD point marker");
        break;
      }
      // Point crosses are presentation-sized, not drawing geometry. Resize only
      // our trusted point tag so changing viewport does not magnify its marker.
      const match = /^<path data-cad-entity="point" d="M([\d.e+-]+) ([\d.e+-]+)h([\d.e+-]+)M([\d.e+-]+) ([\d.e+-]+)v([\d.e+-]+)"\/>$/.exec(pointCarry.slice(0, end + 2));
      if (!match) throw new Error("Invalid compact CAD point marker");
      const x = Number(match[4]);
      const y = Number(match[2]);
      const number = (value: number) => String(Math.round(value * 1_000_000) / 1_000_000);
      output += `${marker}M${number(x - radius)} ${number(y)}h${number(radius * 2)}M${number(x)} ${number(y - radius)}v${number(radius * 2)}"/>`;
      pointCarry = pointCarry.slice(end + 2);
    }
    const bytes = Buffer.from(output, "utf8");
    rawBytes += bytes.length;
    if (rawBytes > CAD_RENDERED_SVG_RAW_MAX_BYTES) throw new Error("CAD preview reframed raw output limit exceeded");
    return bytes;
  };
  return {
    stream: new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        try { callback(null, consume(decoder.write(chunk), false)); } catch (error) { callback(error as Error); }
      },
      flush(callback) {
        try { callback(null, consume(decoder.end(), true)); } catch (error) { callback(error as Error); }
      }
    }),
    points: new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        try { callback(null, rewritePoints(pointDecoder.write(chunk), false)); } catch (error) { callback(error as Error); }
      },
      flush(callback) {
        try { callback(null, rewritePoints(pointDecoder.end(), true)); } catch (error) { callback(error as Error); }
      }
    }),
    rawBytes: () => rawBytes
  };
}
