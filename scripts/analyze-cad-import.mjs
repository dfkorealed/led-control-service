#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rm,
  stat
} from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { basename, extname, isAbsolute, join, resolve } from "node:path";
import { tmpdir } from "node:os";

const ANALYZER_VERSION = "cad-import-analysis/2";
const CANDIDATE_RULE_VERSION = "site-drawing-lighting/2";
const HARD_LIMITS = Object.freeze({
  inputBytes: 128 * 1024 * 1024,
  convertedBytes: 256 * 1024 * 1024,
  processOutputBytes: 1024 * 1024,
  jsonOutputBytes: 8 * 1024 * 1024,
  converterTimeoutMs: 30_000,
  parseTimeoutMs: 30_000,
  entityRecords: 1_000_000,
  lineBytes: 1024 * 1024,
  entityBodyPairs: 250_000
});
const SUPPORTED_MAP_ENTITY_TYPES = new Set([
  "LINE",
  "LWPOLYLINE",
  "POLYLINE",
  "CIRCLE",
  "ARC",
  "TEXT",
  "MTEXT",
  "INSERT"
]);
const STRUCTURAL_ENTITY_TYPES = new Set(["ATTRIB", "VERTEX", "SEQEND"]);
const SHELL_EXECUTABLES = new Set([
  "sh", "bash", "zsh", "dash", "fish", "cmd", "cmd.exe", "powershell", "powershell.exe", "pwsh", "pwsh.exe"
]);
const CANDIDATE_RULES = Object.freeze({
  exactBlockAllowlist: ["몰드바등"],
  layerNameTokens: ["조명", "전등", "LIGHT", "LIGHTING", "LAMP", "LED"],
  blockNameTokens: ["조명", "전등", "LIGHT", "LAMP", "LED", "FIXTURE", "LUMINAIRE"],
  denyLayerNameTokens: ["LEDGER", "SCHEDULE", "NOTE", "DECOR", "TITLE BLOCK"],
  denyBlockNameTokens: ["LEDGER", "SCHEDULE", "SCHEDULED NOTE", "NOTE", "DECOR", "TITLE BLOCK"],
  minimumBlockOccurrences: 2
});
const CANDIDATE_PROFILE_DIGEST = createHash("sha256").update(JSON.stringify({
  profileVersion: CANDIDATE_RULE_VERSION,
  exactBlockAllowlist: CANDIDATE_RULES.exactBlockAllowlist,
  layerNameTokens: CANDIDATE_RULES.layerNameTokens,
  blockNameTokens: CANDIDATE_RULES.blockNameTokens,
  minimumBlockOccurrences: CANDIDATE_RULES.minimumBlockOccurrences,
  denyLayerNameTokens: CANDIDATE_RULES.denyLayerNameTokens,
  denyBlockNameTokens: CANDIDATE_RULES.denyBlockNameTokens,
  denyAttributeValueTokens: ["NOT LIGHT", "NON LIGHTING", "DECOR", "IGNORE"],
  denyNearbyTextTokens: ["NOT LIGHT", "NON LIGHTING", "DECOR", "DO NOT IMPORT", "IGNORE"]
})).digest("hex");

function parseArguments(argv) {
  if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) return { help: true };
  const values = new Map();
  const supported = new Set([
    "--input",
    "--ground-truth",
    "--converter",
    "--temp-root",
    "--max-input-bytes",
    "--max-converted-bytes",
    "--max-process-output-bytes",
    "--max-json-output-bytes",
    "--converter-timeout-ms",
    "--parse-timeout-ms",
    "--max-line-bytes",
    "--max-entity-body-pairs"
  ]);
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!supported.has(name) || value === undefined || value.startsWith("--") || values.has(name)) {
      throw new Error(`Invalid argument near ${name ?? "<missing>"}`);
    }
    values.set(name, value);
  }
  if (!values.get("--input")) {
    throw new Error("Usage: node scripts/analyze-cad-import.mjs --input <file.dxf|file.dwg> [--converter <absolute dwgread path>] [--ground-truth <json>]");
  }
  return {
    inputPath: resolve(values.get("--input")),
    groundTruthPath: values.has("--ground-truth") ? resolve(values.get("--ground-truth")) : null,
    converterPath: values.get("--converter") ?? null,
    tempRoot: resolve(values.get("--temp-root") ?? tmpdir()),
    limits: {
      inputBytes: boundedInteger(values.get("--max-input-bytes"), HARD_LIMITS.inputBytes, "input byte limit"),
      convertedBytes: boundedInteger(values.get("--max-converted-bytes"), HARD_LIMITS.convertedBytes, "converted DXF byte limit"),
      processOutputBytes: boundedInteger(values.get("--max-process-output-bytes"), HARD_LIMITS.processOutputBytes, "process output byte limit"),
      jsonOutputBytes: boundedInteger(values.get("--max-json-output-bytes"), HARD_LIMITS.jsonOutputBytes, "JSON output byte limit"),
      converterTimeoutMs: boundedInteger(values.get("--converter-timeout-ms"), HARD_LIMITS.converterTimeoutMs, "converter time limit"),
      parseTimeoutMs: boundedInteger(values.get("--parse-timeout-ms"), HARD_LIMITS.parseTimeoutMs, "parse time limit"),
      entityRecords: HARD_LIMITS.entityRecords,
      lineBytes: boundedInteger(values.get("--max-line-bytes"), HARD_LIMITS.lineBytes, "line byte limit"),
      entityBodyPairs: boundedInteger(values.get("--max-entity-body-pairs"), HARD_LIMITS.entityBodyPairs, "entity body pair limit")
    }
  };
}

function boundedInteger(rawValue, hardMaximum, label) {
  if (rawValue === undefined) return hardMaximum;
  if (!/^\d+$/.test(rawValue)) throw new Error(`Invalid ${label}`);
  const value = Number(rawValue);
  if (!Number.isSafeInteger(value) || value < 1 || value > hardMaximum) throw new Error(`Invalid ${label}`);
  return value;
}

async function assertRegularFile(path, label, maxBytes) {
  const identity = await lstat(path).catch((error) => {
    throw new Error(`${label} is unavailable: ${error.message}`);
  });
  if (!identity.isFile() || identity.isSymbolicLink()) throw new Error(`${label} must be a regular file`);
  if (identity.size > maxBytes) throw new Error(`${label} size limit exceeded`);
  return identity;
}

async function sha256(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function validateConverter(path) {
  if (!path || !isAbsolute(path) || path.includes("\0") || SHELL_EXECUTABLES.has(basename(path).toLowerCase())) {
    throw new Error("DWG converter is required as a safe absolute executable path");
  }
  const target = await realpath(path).catch((error) => {
    throw new Error(`DWG converter is unavailable: ${error.message}`);
  });
  const identity = await stat(target);
  if (!identity.isFile()) throw new Error("DWG converter must resolve to a regular file");
  await access(target, fsConstants.X_OK).catch((error) => {
    throw new Error(`DWG converter is not executable: ${error.message}`);
  });
  return path;
}

function killProcessTree(child) {
  if (child.pid !== undefined) {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch (error) {
      if (error.code !== "ESRCH") child.kill("SIGKILL");
    }
  } else {
    child.kill("SIGKILL");
  }
}

function runBoundedProcess(executable, argv, options) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(executable, argv, {
      detached: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let processOutputBytes = 0;
    let stdout = "";
    let stderr = "";
    let failure = null;
    let closed = false;
    const fail = (error) => {
      if (failure) return;
      failure = error;
      killProcessTree(child);
    };
    const timer = setTimeout(() => fail(new Error(`${options.label} time limit exceeded`)), options.timeoutMs);
    const outputPoller = options.outputPath ? setInterval(async () => {
      try {
        const output = await lstat(options.outputPath);
        if (!output.isFile() || output.isSymbolicLink()) fail(new Error("Converted DXF must be a regular file"));
        else if (output.size > options.maxConvertedBytes) fail(new Error("Converted DXF size limit exceeded"));
      } catch (error) {
        if (error.code !== "ENOENT") fail(error);
      }
    }, 20) : null;
    const finish = (code, signal) => {
      if (closed) return;
      closed = true;
      clearTimeout(timer);
      if (outputPoller) clearInterval(outputPoller);
      if (failure) rejectPromise(failure);
      else if (code !== 0) rejectPromise(new Error(`${options.label} exited with code ${code ?? "null"}${signal ? ` (${signal})` : ""}${stderr.trim() ? `: ${stderr.trim()}` : ""}`));
      else resolvePromise({ stdout, stderr });
    };
    const capture = (chunk, destination) => {
      processOutputBytes += chunk.byteLength;
      if (processOutputBytes > options.maxProcessOutputBytes) {
        fail(new Error(`${options.label} process output limit exceeded`));
        return;
      }
      if (destination === "stdout") stdout += chunk.toString("utf8");
      else stderr += chunk.toString("utf8");
    };
    child.stdout.on("data", (chunk) => capture(chunk, "stdout"));
    child.stderr.on("data", (chunk) => capture(chunk, "stderr"));
    child.once("error", (error) => fail(new Error(`${options.label} failed to launch: ${error.message}`)));
    child.once("close", finish);
  });
}

async function convertDwg(inputPath, converterPath, tempRoot, limits) {
  const executable = await validateConverter(converterPath);
  await mkdir(tempRoot, { recursive: true });
  const temporaryDirectory = await mkdtemp(join(tempRoot, "cad-import-analysis-"));
  const outputPath = join(temporaryDirectory, "converted.dxf");
  try {
    const versionResult = await runBoundedProcess(executable, ["--version"], {
      label: "DWG converter",
      timeoutMs: limits.converterTimeoutMs,
      maxProcessOutputBytes: limits.processOutputBytes
    });
    await runBoundedProcess(executable, ["-O", "DXF", "-o", outputPath, inputPath], {
      label: "DWG converter",
      timeoutMs: limits.converterTimeoutMs,
      maxProcessOutputBytes: limits.processOutputBytes,
      outputPath,
      maxConvertedBytes: limits.convertedBytes
    });
    const output = await assertRegularFile(outputPath, "Converted DXF", limits.convertedBytes);
    return {
      dxfPath: outputPath,
      outputBytes: output.size,
      temporaryDirectory,
      converter: {
        executable: await realpath(executable),
        version: firstNonEmptyLine(`${versionResult.stdout}\n${versionResult.stderr}`) ?? "unknown"
      }
    };
  } catch (error) {
    await rm(temporaryDirectory, { recursive: true, force: true });
    throw error;
  }
}

function firstNonEmptyLine(value) {
  return value.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? null;
}

async function isValidUtf8(path, limits, startedAt) {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytesRead = 0;
  try {
    for await (const chunk of createReadStream(path)) {
      bytesRead += chunk.byteLength;
      if (bytesRead > limits.convertedBytes) throw new Error("DXF input size limit exceeded");
      if (performance.now() - startedAt > limits.parseTimeoutMs) throw new Error("DXF parse time limit exceeded");
      decoder.decode(chunk, { stream: true });
    }
    decoder.decode();
    return true;
  } catch (error) {
    if (error instanceof TypeError) return false;
    throw error;
  }
}

async function detectDxfEncoding(path, limits, startedAt) {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(64 * 1024);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const header = buffer.subarray(0, bytesRead).toString("latin1");
    if (/AutoCAD Binary DXF/i.test(header)) throw new Error("Binary DXF is not supported by this analyzer");
    if (await isValidUtf8(path, limits, startedAt)) return { decoder: new TextDecoder("utf-8"), textEncoding: "UTF-8" };
    if (/ANSI_949/i.test(header)) return { decoder: new TextDecoder("euc-kr"), textEncoding: "EUC-KR" };
    if (/ANSI_1252/i.test(header)) return { decoder: new TextDecoder("windows-1252"), textEncoding: "WINDOWS-1252" };
    throw new Error("DXF text encoding is neither valid UTF-8 nor a supported declared code page");
  } finally {
    await handle.close();
  }
}

async function* readDxfPairs(path, limits, startedAt, decoder) {
  let pending = "";
  let codeLine = null;
  let lineNumber = 0;
  let bytesRead = 0;
  const emitLine = (rawLine) => {
    lineNumber++;
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (Buffer.byteLength(line, "utf8") > limits.lineBytes) throw new Error("DXF line byte limit exceeded");
    if (codeLine === null) {
      if (!/^[+-]?\d+$/.test(line.trim())) throw new Error(`Malformed DXF group code at line ${lineNumber}`);
      const code = Number(line.trim());
      if (!Number.isSafeInteger(code) || code < 0 || code > 1071) throw new Error(`Malformed DXF group code at line ${lineNumber}`);
      codeLine = { code, line: lineNumber };
      return null;
    }
    const pair = { ...codeLine, value: line };
    codeLine = null;
    return pair;
  };

  for await (const chunk of createReadStream(path)) {
    bytesRead += chunk.byteLength;
    if (bytesRead > limits.convertedBytes) throw new Error("DXF input size limit exceeded");
    if (performance.now() - startedAt > limits.parseTimeoutMs) throw new Error("DXF parse time limit exceeded");
    pending += decoder.decode(chunk, { stream: true });
    let newline = pending.indexOf("\n");
    while (newline >= 0) {
      const pair = emitLine(pending.slice(0, newline));
      pending = pending.slice(newline + 1);
      if (pair) yield pair;
      newline = pending.indexOf("\n");
    }
    if (Buffer.byteLength(pending, "utf8") > limits.lineBytes + 1) throw new Error("DXF line byte limit exceeded");
  }
  pending += decoder.decode();
  if (pending.length > 0) {
    const pair = emitLine(pending);
    if (pair) yield pair;
  }
  if (codeLine !== null) throw new Error("Malformed DXF pair at EOF");
}

function createCounterEntry() {
  return { entityCount: 0, insertCount: 0, candidateCount: 0 };
}

function increment(map, key, amount = 1) {
  map.set(key, (map.get(key) ?? 0) + amount);
}

function firstPairValue(pairs, code) {
  return pairs.find((pair) => pair.code === code)?.value.trim() ?? null;
}

function finiteNumber(value) {
  if (value === null || value === "" || !/^[+-]?(?:(?:\d+(?:\.\d*)?)|(?:\.\d+))(?:[eE][+-]?\d+)?$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && Math.abs(parsed) <= 1_000_000_000 ? parsed : null;
}

function stableNameCompare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function tokenGroups(value) {
  return value.normalize("NFKC").toUpperCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

function includesTokenSequence(tokens, phrase) {
  const expected = tokenGroups(phrase);
  for (let index = 0; index <= tokens.length - expected.length; index++) {
    if (expected.every((token, offset) => token === tokens[index + offset])) return true;
  }
  return false;
}

function matchesAny(value, phrases) {
  const tokens = tokenGroups(value);
  return phrases.some((phrase) => includesTokenSequence(tokens, phrase));
}

function coordinateKey(position) {
  const normalize = (value) => Object.is(value, -0) ? 0 : value;
  return `${normalize(position.x)},${normalize(position.y)},${normalize(position.z)}`;
}

async function analyzeDxf(path, limits) {
  const startedAt = performance.now();
  const { decoder, textEncoding } = await detectDxfEncoding(path, limits, startedAt);
  let section = null;
  let awaitingSectionName = false;
  let currentEntity = null;
  let currentBlock = null;
  let polylineActive = false;
  let polylineVertexCount = 0;
  let attributeSequenceActive = false;
  let attributeCount = 0;
  let rawEntityRecordCount = 0;
  let paperSpaceEntityCount = 0;
  let dxfVersion = null;
  let codePage = null;
  let headerVariable = null;
  let sawEof = false;
  const modelEntities = [];
  const blockDefinitionCounts = new Map();
  const blockDefinitionInserts = new Map();

  const finalizeEntity = () => {
    if (!currentEntity) return;
    const entity = currentEntity;
    currentEntity = null;
    if (entity.type === "BLOCK") {
      currentBlock = firstPairValue(entity.pairs, 2) ?? firstPairValue(entity.pairs, 3) ?? "<unnamed>";
      if (!blockDefinitionCounts.has(currentBlock)) blockDefinitionCounts.set(currentBlock, 0);
      return;
    }
    rawEntityRecordCount++;
    if (rawEntityRecordCount > limits.entityRecords) throw new Error("DXF entity record limit exceeded");
    if (entity.type === "POLYLINE") {
      polylineActive = true;
      polylineVertexCount = 0;
    } else if (entity.type === "VERTEX") {
      if (!polylineActive) throw new Error("Orphan DXF VERTEX entity");
      polylineVertexCount++;
    } else if (entity.type === "ATTRIB") {
      if (!attributeSequenceActive) throw new Error("Orphan DXF ATTRIB entity");
      attributeCount++;
    }
    if (STRUCTURAL_ENTITY_TYPES.has(entity.type)) return;
    if (entity.type === "INSERT") {
      const sequenceFlags = entity.pairs.filter((pair) => pair.code === 66);
      if (sequenceFlags.length > 1) throw new Error("Duplicate DXF INSERT group 66 attribute sequence flag");
      const sequenceFlag = sequenceFlags.length === 0 ? 0 : Number(sequenceFlags[0].value.trim());
      if (!Number.isSafeInteger(sequenceFlag) || (sequenceFlag !== 0 && sequenceFlag !== 1)) {
        throw new Error("Invalid DXF INSERT group 66 attribute sequence flag");
      }
      attributeSequenceActive = sequenceFlag === 1;
      attributeCount = 0;
    }
    const parsed = {
      type: entity.type,
      layer: firstPairValue(entity.pairs, 8) ?? "0",
      blockName: entity.type === "INSERT" ? firstPairValue(entity.pairs, 2) : null,
      position: entity.type === "INSERT" ? {
        x: finiteNumber(firstPairValue(entity.pairs, 10)),
        y: finiteNumber(firstPairValue(entity.pairs, 20)),
        z: finiteNumber(firstPairValue(entity.pairs, 30) ?? "0")
      } : null,
      rotation: entity.type === "INSERT" ? finiteNumber(firstPairValue(entity.pairs, 50) ?? "0") : null,
      scale: entity.type === "INSERT" ? {
        x: finiteNumber(firstPairValue(entity.pairs, 41) ?? "1"),
        y: finiteNumber(firstPairValue(entity.pairs, 42) ?? "1"),
        z: finiteNumber(firstPairValue(entity.pairs, 43) ?? "1")
      } : null
    };
    const group67 = firstPairValue(entity.pairs, 67);
    const group410 = firstPairValue(entity.pairs, 410)?.toUpperCase() ?? null;
    const isModelSpace = (group67 === null || group67 === "0") && (group410 === null || group410 === "MODEL");
    if (entity.section === "ENTITIES" && isModelSpace) modelEntities.push(parsed);
    else if (entity.section === "ENTITIES") paperSpaceEntityCount++;
    else if (entity.section === "BLOCKS" && currentBlock) {
      increment(blockDefinitionCounts, currentBlock);
      if (parsed.type === "INSERT") {
        const entries = blockDefinitionInserts.get(currentBlock) ?? [];
        entries.push(parsed);
        blockDefinitionInserts.set(currentBlock, entries);
      }
    }
  };

  for await (const pair of readDxfPairs(path, limits, startedAt, decoder)) {
    if (performance.now() - startedAt > limits.parseTimeoutMs) throw new Error("DXF parse time limit exceeded");
    if (sawEof) throw new Error("Malformed DXF content after EOF");
    if (pair.code === 0) {
      finalizeEntity();
      const marker = pair.value.trim().toUpperCase();
      if (marker === "SECTION") {
        if (section || awaitingSectionName || currentBlock) throw new Error("Malformed nested DXF SECTION");
        section = null;
        awaitingSectionName = true;
      } else if (marker === "ENDSEC") {
        if (!section || currentBlock) throw new Error("Malformed or premature DXF ENDSEC");
        if (polylineActive || attributeSequenceActive) throw new Error("Unterminated DXF entity sequence before ENDSEC");
        section = null;
        currentBlock = null;
      } else if (marker === "EOF") {
        if (section || awaitingSectionName || currentBlock) throw new Error("Malformed DXF EOF before ENDSEC/ENDBLK");
        sawEof = true;
      } else if (section === "BLOCKS" && marker === "BLOCK") {
        if (currentBlock) throw new Error("Malformed nested DXF BLOCK");
        currentEntity = { type: marker, section, pairs: [] };
      } else if (section === "BLOCKS" && marker === "ENDBLK") {
        if (!currentBlock) throw new Error("Orphan DXF ENDBLK entity");
        if (polylineActive || attributeSequenceActive) throw new Error("Unterminated DXF entity sequence before ENDBLK");
        currentBlock = null;
      } else if (marker === "SEQEND") {
        if (polylineActive) {
          if (polylineVertexCount < 2) throw new Error("Malformed DXF POLYLINE sequence");
          polylineActive = false;
          polylineVertexCount = 0;
        } else if (attributeSequenceActive) {
          if (attributeCount === 0) throw new Error("DXF INSERT group 66=1 requires ATTRIB before SEQEND");
          attributeSequenceActive = false;
          attributeCount = 0;
        } else throw new Error("Orphan DXF SEQEND entity");
      } else if (marker === "ATTRIB") {
        if (!attributeSequenceActive) throw new Error("Orphan DXF ATTRIB entity");
        currentEntity = { type: marker, section, pairs: [] };
      } else if (marker === "VERTEX") {
        if (!polylineActive) throw new Error("Orphan DXF VERTEX entity");
        currentEntity = { type: marker, section, pairs: [] };
      } else if (section === "ENTITIES" || section === "BLOCKS") {
        if (polylineActive) throw new Error("DXF POLYLINE sequence requires SEQEND");
        if (attributeSequenceActive) throw new Error("DXF INSERT attribute sequence requires SEQEND");
        currentEntity = { type: marker, section, pairs: [] };
      } else if (section === null) {
        throw new Error(`Malformed DXF top-level marker: ${marker}`);
      }
      continue;
    }
    if (awaitingSectionName) {
      if (pair.code !== 2) throw new Error("Malformed DXF SECTION name");
      section = pair.value.trim().toUpperCase();
      awaitingSectionName = false;
      headerVariable = null;
    } else if (currentEntity) {
      currentEntity.pairs.push(pair);
      if (currentEntity.pairs.length > limits.entityBodyPairs) throw new Error("DXF entity body pair limit exceeded");
    } else if (section === "HEADER") {
      if (pair.code === 9) headerVariable = pair.value.trim().toUpperCase();
      else if (headerVariable === "$ACADVER" && pair.code === 1) dxfVersion = pair.value.trim();
      else if (headerVariable === "$DWGCODEPAGE" && pair.code === 3) codePage = pair.value.trim();
    }
  }
  finalizeEntity();
  if (!sawEof) throw new Error("Malformed DXF: EOF marker is missing");
  if (section || awaitingSectionName || currentBlock || polylineActive || attributeSequenceActive) {
    throw new Error("Malformed DXF: unterminated SECTION, BLOCK, or entity sequence");
  }

  return buildStatistics(
    modelEntities, blockDefinitionCounts, blockDefinitionInserts,
    rawEntityRecordCount, paperSpaceEntityCount, dxfVersion, codePage, textEncoding
  );
}

function expandInsertStatistics(modelEntities, blockDefinitionCounts, blockDefinitionInserts) {
  let expandedInsertOccurrenceCount = 0;
  let nestedInsertOccurrenceCount = 0;
  let unresolvedBlockReferenceCount = 0;
  let cyclicBlockReferenceCount = 0;
  let maximumExpansionDepth = 0;
  const worldCoordinates = new Set();
  const multiply = (left, right) => ({
    a: left.a * right.a + left.c * right.b,
    b: left.b * right.a + left.d * right.b,
    c: left.a * right.c + left.c * right.d,
    d: left.b * right.c + left.d * right.d,
    e: left.a * right.e + left.c * right.f + left.e,
    f: left.b * right.e + left.d * right.f + left.f
  });
  const matrixFor = (insert) => {
    const radians = (insert.rotation ?? 0) * Math.PI / 180;
    const x = insert.scale?.x ?? 1;
    const y = insert.scale?.y ?? 1;
    return { a: Math.cos(radians) * x, b: Math.sin(radians) * x, c: -Math.sin(radians) * y, d: Math.cos(radians) * y, e: insert.position.x, f: insert.position.y };
  };
  const visit = (insert, parent, stack, depth) => {
    if (!insert.blockName || !insert.position || Object.values(insert.position).some((value) => value === null)) return;
    const world = multiply(parent, matrixFor(insert));
    expandedInsertOccurrenceCount++;
    if (depth > 0) nestedInsertOccurrenceCount++;
    maximumExpansionDepth = Math.max(maximumExpansionDepth, depth);
    worldCoordinates.add(coordinateKey({ x: world.e, y: world.f, z: insert.position.z }));
    if (!blockDefinitionCounts.has(insert.blockName)) {
      unresolvedBlockReferenceCount++;
      return;
    }
    const children = blockDefinitionInserts.get(insert.blockName) ?? [];
    if (stack.includes(insert.blockName)) {
      cyclicBlockReferenceCount++;
      return;
    }
    if (depth >= 32) return;
    for (const child of children) visit(child, world, [...stack, insert.blockName], depth + 1);
  };
  const identity = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
  for (const insert of modelEntities.filter((entity) => entity.type === "INSERT")) visit(insert, identity, [], 0);
  return {
    expandedInsertOccurrenceCount,
    nestedInsertOccurrenceCount,
    uniqueWorldCoordinateCount: worldCoordinates.size,
    maximumExpansionDepth,
    unresolvedBlockReferenceCount,
    cyclicBlockReferenceCount
  };
}

function buildStatistics(modelEntities, blockDefinitionCounts, blockDefinitionInserts, rawEntityRecordCount, paperSpaceEntityCount, dxfVersion, codePage, textEncoding) {
  const entityTypes = new Map();
  const layers = new Map();
  const blockInsertCounts = new Map();
  const insertCoordinates = new Set();
  const inserts = [];
  let extractedInsertCount = 0;
  let nonZeroRotationInsertCount = 0;
  let nonUnitScaleInsertCount = 0;
  let supportedEntityCount = 0;

  for (const entity of modelEntities) {
    increment(entityTypes, entity.type);
    const layer = layers.get(entity.layer) ?? createCounterEntry();
    layer.entityCount++;
    if (SUPPORTED_MAP_ENTITY_TYPES.has(entity.type)) supportedEntityCount++;
    if (entity.type === "INSERT") {
      layer.insertCount++;
      const validPosition = entity.position && Object.values(entity.position).every((value) => value !== null);
      if (entity.blockName) increment(blockInsertCounts, entity.blockName);
      if (entity.blockName && validPosition) {
        extractedInsertCount++;
        insertCoordinates.add(coordinateKey(entity.position));
      }
      if (entity.rotation !== null && entity.rotation !== 0) nonZeroRotationInsertCount++;
      if (entity.scale && Object.values(entity.scale).some((value) => value !== 1)) nonUnitScaleInsertCount++;
      inserts.push({ ...entity, validPosition });
    }
    layers.set(entity.layer, layer);
  }

  const candidates = [];
  for (const insert of inserts) {
    if (!insert.blockName || !insert.validPosition) continue;
    if (matchesAny(insert.layer, CANDIDATE_RULES.denyLayerNameTokens) || matchesAny(insert.blockName, CANDIDATE_RULES.denyBlockNameTokens)) continue;
    const exactBlockMatch = CANDIDATE_RULES.exactBlockAllowlist.includes(insert.blockName.normalize("NFKC").toUpperCase());
    if (!matchesAny(insert.layer, CANDIDATE_RULES.layerNameTokens) ||
        (!exactBlockMatch && !matchesAny(insert.blockName, CANDIDATE_RULES.blockNameTokens))) continue;
    if ((blockInsertCounts.get(insert.blockName) ?? 0) < CANDIDATE_RULES.minimumBlockOccurrences) continue;
    candidates.push(insert);
    layers.get(insert.layer).candidateCount++;
  }

  const candidateBlockCounts = new Map();
  const candidateLayerCounts = new Map();
  const candidateCoordinates = new Set();
  for (const candidate of candidates) {
    increment(candidateBlockCounts, candidate.blockName);
    increment(candidateLayerCounts, candidate.layer);
    candidateCoordinates.add(coordinateKey(candidate.position));
  }
  const allBlockNames = new Set([...blockDefinitionCounts.keys(), ...blockInsertCounts.keys()]);
  const candidateBlocks = new Set(candidateBlockCounts.keys());

  return {
    dxfVersion,
    codePage,
    textEncoding,
    statistics: {
      rawEntityRecordCount,
      modelSpaceEntityCount: modelEntities.length,
      paperSpaceEntityCount,
      insertCount: inserts.length,
      uniqueInsertCoordinateCount: insertCoordinates.size,
      entityTypes: [...entityTypes].sort(([left], [right]) => stableNameCompare(left, right)).map(([type, count]) => ({ type, count })),
      layers: [...layers].sort(([left], [right]) => stableNameCompare(left, right)).map(([name, counts]) => ({ name, ...counts })),
      blocks: [...allBlockNames].sort(stableNameCompare).map((name) => ({
        name,
        definitionEntityCount: blockDefinitionCounts.get(name) ?? 0,
        insertCount: blockInsertCounts.get(name) ?? 0,
        candidateCount: candidateBlocks.has(name) ? candidateBlockCounts.get(name) : 0
      }))
    },
    candidates: {
      ruleVersion: CANDIDATE_RULE_VERSION,
      profileVersion: CANDIDATE_RULE_VERSION,
      profileDigest: CANDIDATE_PROFILE_DIGEST,
      rules: CANDIDATE_RULES,
      count: candidates.length,
      uniqueCoordinateCount: candidateCoordinates.size,
      byLayer: [...candidateLayerCounts].sort(([left], [right]) => stableNameCompare(left, right)).map(([name, count]) => ({ name, count })),
      byBlock: [...candidateBlockCounts].sort(([left], [right]) => stableNameCompare(left, right)).map(([name, count]) => ({ name, count }))
    },
    extraction: {
      extractedInsertCount,
      nonZeroRotationInsertCount,
      nonUnitScaleInsertCount,
      expansion: expandInsertStatistics(modelEntities, blockDefinitionCounts, blockDefinitionInserts),
      supportedEntityCount
    }
  };
}

function roundMetric(value) {
  return Math.round(value * 1_000_000) / 1_000_000;
}

async function readGroundTruth(path) {
  if (!path) return null;
  await assertRegularFile(path, "Ground truth", 64 * 1024);
  let parsed;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error(`Ground truth JSON is invalid: ${error.message}`);
  }
  const expectedKeys = ["falseNegative", "falsePositive", "truePositive"];
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object" ||
      Object.keys(parsed).sort(stableNameCompare).join(",") !== expectedKeys.join(",") ||
      expectedKeys.some((key) => !Number.isSafeInteger(parsed[key]) || parsed[key] < 0)) {
    throw new Error("Ground truth must contain only non-negative integer truePositive, falsePositive, and falseNegative values");
  }
  return parsed;
}

function detectionMetrics(groundTruth) {
  if (!groundTruth) return {
    groundTruthProvided: false,
    truePositive: null,
    falsePositive: null,
    falseNegative: null,
    precision: null,
    recall: null,
    f1: null
  };
  const { truePositive, falsePositive, falseNegative } = groundTruth;
  const precisionDenominator = truePositive + falsePositive;
  const recallDenominator = truePositive + falseNegative;
  const precision = precisionDenominator === 0 ? null : roundMetric(truePositive / precisionDenominator);
  const recall = recallDenominator === 0 ? null : roundMetric(truePositive / recallDenominator);
  const f1Denominator = 2 * truePositive + falsePositive + falseNegative;
  const f1 = f1Denominator === 0 ? null : roundMetric((2 * truePositive) / f1Denominator);
  return { groundTruthProvided: true, truePositive, falsePositive, falseNegative, precision, recall, f1 };
}

function buildReport(source, analysis, groundTruth) {
  const insertCount = analysis.statistics.insertCount;
  const modelEntityCount = analysis.statistics.modelSpaceEntityCount;
  return {
    schemaVersion: 2,
    analyzerVersion: ANALYZER_VERSION,
    source: {
      fileName: source.fileName,
      format: source.format,
      bytes: source.bytes,
      sha256: source.sha256,
      dxfVersion: analysis.dxfVersion,
      dxfCodePage: analysis.codePage,
      dxfTextEncoding: analysis.textEncoding,
      convertedDxfBytes: source.convertedDxfBytes,
      converter: source.converter
    },
    statistics: analysis.statistics,
    candidates: analysis.candidates,
    accuracy: {
      directModelSpaceInsertNameAndFiniteOriginRate: {
        extractedInsertCount: analysis.extraction.extractedInsertCount,
        directModelSpaceInsertCount: insertCount,
        rate: insertCount === 0 ? null : roundMetric(analysis.extraction.extractedInsertCount / insertCount),
        nonZeroRotationInsertCount: analysis.extraction.nonZeroRotationInsertCount,
        nonUnitScaleInsertCount: analysis.extraction.nonUnitScaleInsertCount,
        basis: "직접 model-space INSERT의 block 이름과 유한 원점 추출 비율이며 nested transform 또는 조명 검출 recall이 아님"
      },
      nestedInsertExpansion: {
        ...analysis.extraction.expansion,
        basis: "block INSERT를 world 좌표로 전개한 진단 통계이며 검출 정확도가 아님"
      },
      supportedEntityMapGeometry: {
        supportedEntityCount: analysis.extraction.supportedEntityCount,
        modelSpaceEntityCount: modelEntityCount,
        expectedCoverage: modelEntityCount === 0 ? null : roundMetric(analysis.extraction.supportedEntityCount / modelEntityCount),
        basis: "지원 entity 기준 예상치이며 렌더 결과의 시각적 정답률이 아님"
      },
      detection: detectionMetrics(groundTruth),
      bleIdentityMapping: {
        accuracy: 0,
        autoRegistration: false,
        createsFixture: false,
        createsMeshNode: false
      }
    },
    ai: {
      provider: "disabled",
      ioCalls: 0,
      replaceableProviderContract: "LightingSymbolDetector"
    },
    importPolicy: {
      newFormats: ["dwg", "dxf"],
      newPdfImport: false,
      existingPdfReadCompatibility: true,
      candidatesRemainUnregistered: true
    }
  };
}

function percentage(value) {
  return value === null ? "미확정" : `${roundMetric(value * 100)}%`;
}

function formatDistribution(entries) {
  if (entries.length === 0) return "없음";
  return [...entries]
    .sort((left, right) => right.count - left.count || stableNameCompare(left.name, right.name))
    .slice(0, 10)
    .map(({ name, count }) => `${name.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim()} ${count}`)
    .join(", ");
}

function koreanSummary(report) {
  const detection = report.accuracy.detection;
  return [
    "CAD 가져오기 분석 요약",
    `- 원본: ${report.source.fileName} (${report.source.format.toUpperCase()}, SHA256 ${report.source.sha256})`,
    `- 버전: analyzer ${report.analyzerVersion}, DXF ${report.source.dxfVersion ?? "미상"}, converter ${report.source.converter?.version ?? "직접 DXF"}`,
    `- entity/INSERT/고유 좌표: ${report.statistics.modelSpaceEntityCount}/${report.statistics.insertCount}/${report.statistics.uniqueInsertCoordinateCount}`,
    `- 조명 후보/후보 고유 좌표: ${report.candidates.count}/${report.candidates.uniqueCoordinateCount}`,
    `- 후보 layer별: ${formatDistribution(report.candidates.byLayer)}`,
    `- 후보 block별: ${formatDistribution(report.candidates.byBlock)}`,
    `- 직접 model-space INSERT 이름+유한 원점 비율: ${percentage(report.accuracy.directModelSpaceInsertNameAndFiniteOriginRate.rate)} (nested/조명 recall 아님)`,
    `- nested/world INSERT: ${report.accuracy.nestedInsertExpansion.nestedInsertOccurrenceCount}/${report.accuracy.nestedInsertExpansion.expandedInsertOccurrenceCount}, unresolved/cyclic ${report.accuracy.nestedInsertExpansion.unresolvedBlockReferenceCount}/${report.accuracy.nestedInsertExpansion.cyclicBlockReferenceCount}`,
    `- 지원 entity 기준 맵 기하 재현 예상: ${percentage(report.accuracy.supportedEntityMapGeometry.expectedCoverage)}`,
    `- 검출 precision/recall/F1: ${percentage(detection.precision)}/${percentage(detection.recall)}/${percentage(detection.f1)}${detection.groundTruthProvided ? "" : " (ground truth 없음)"}`,
    "- 실제 BLE 장비 identity 매핑: 0% (자동 등록 없음, Fixture/MeshNode 생성 없음)",
    "- AI: disabled adapter, I/O 호출 0회, LightingSymbolDetector provider 교체 가능",
    "- PDF: 신규 import 제외, 기존 PDF 읽기 호환 유지"
  ].join("\n");
}

function helpText() {
  return `CAD import analyzer (development analysis only)

Usage:
  node scripts/analyze-cad-import.mjs --input <file.dxf|file.dwg> [options]

Input and converter:
  --input <path>                       Direct ASCII DXF or DWG input
  --converter <absolute-path>          Required for DWG (trusted installed command, e.g. dwgread)
  --temp-root <path>                   Converter temporary directory root
  --ground-truth <json>                Optional TP/FP/FN count JSON

Bounds (values may only lower the built-in hard maximum):
  --max-input-bytes <n>                Original input bytes
  --max-converted-bytes <n>            Converted DXF and temporary disk bytes
  --max-process-output-bytes <n>        Converter stdout+stderr bytes
  --max-json-output-bytes <n>           Analyzer JSON bytes
  --max-line-bytes <n>                  Single decoded DXF line bytes
  --max-entity-body-pairs <n>           Pairs retained for one entity
  --converter-timeout-ms <n>            Converter wall time
  --parse-timeout-ms <n>                DXF parse wall time

Output:
  stdout is deterministic JSON; stderr is a Korean summary. Ground truth must contain only
  non-negative integer truePositive, falsePositive, and falseNegative counts. DWG conversion
  uses spawn argv without a shell. The converter is trusted local tooling and is not bundled
  with or added as a runtime dependency of the product. Missing converters fail closed.
`;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(helpText());
    return;
  }
  const extension = extname(options.inputPath).toLowerCase();
  if (extension !== ".dxf" && extension !== ".dwg") throw new Error("Only DXF and DWG inputs are supported");
  const sourceIdentity = await assertRegularFile(options.inputPath, "CAD input", options.limits.inputBytes);
  const originalSha256 = await sha256(options.inputPath);
  const groundTruth = await readGroundTruth(options.groundTruthPath);
  let converted = null;
  try {
    if (extension === ".dwg") {
      converted = await convertDwg(options.inputPath, options.converterPath, options.tempRoot, options.limits);
    }
    const dxfPath = converted?.dxfPath ?? options.inputPath;
    const analysis = await analyzeDxf(dxfPath, options.limits);
    const report = buildReport({
      fileName: basename(options.inputPath),
      format: extension.slice(1),
      bytes: sourceIdentity.size,
      sha256: originalSha256,
      convertedDxfBytes: converted?.outputBytes ?? null,
      converter: converted?.converter ?? null
    }, analysis, groundTruth);
    const json = `${JSON.stringify(report, null, 2)}\n`;
    if (Buffer.byteLength(json, "utf8") > options.limits.jsonOutputBytes) throw new Error("JSON output size limit exceeded");
    process.stdout.write(json);
    process.stderr.write(`${koreanSummary(report)}\n`);
  } finally {
    if (converted?.temporaryDirectory) await rm(converted.temporaryDirectory, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`CAD analysis failed: ${error.message}\n`);
  process.exitCode = 1;
});
