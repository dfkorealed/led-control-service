import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { SerialTaskQueue } from "../runtime/serial-task-queue";

const GAP_BLOCK_BYTES = 4_096;
const GAP_BLOCK_COUNT = 2;
const GAP_MAGIC = Buffer.from("ATGAP001", "ascii");
const GAP_HEADER_BYTES = GAP_MAGIC.length + 8 + 4 + 32;
export const AUTOMATION_TELEMETRY_GAP_JOURNAL_BYTES = GAP_BLOCK_BYTES * GAP_BLOCK_COUNT;

export type AutomationTelemetryGapProvenance =
  | "automation_handoff_capacity"
  | "automation_handoff_storage"
  | "automation_state_storage"
  | "automation_state_gap"
  | "fixture_state_outbox";

export interface AutomationTelemetryGapInput {
  handoffId: string;
  recordsHash: string;
  provenance: AutomationTelemetryGapProvenance;
  revision: number;
  firstDroppedAt: string;
  lastDroppedAt: string;
  droppedCount: number;
}

export interface AutomationTelemetryGapJournalState {
  version: 1;
  generation: number;
  gapHandoffId: string;
  gapRecordsHash: `sha256:${string}`;
  revision: number;
  firstDroppedAt: string;
  lastDroppedAt: string;
  droppedCount: number;
  lastSourceHandoffId: string;
  lastSourceRecordsHash: string;
  lastSourceDroppedCount: number;
  provenance: AutomationTelemetryGapProvenance;
  // Persist one cumulative source independently from the last writer so
  // interleaved fixed-journal handoffs cannot make an older state replay add it twice.
  cumulativeSourceHandoffId: string | null;
  cumulativeSourceRecordsHash: string | null;
  cumulativeSourceDroppedCount: number;
  cumulativeSourceProvenance: AutomationTelemetryGapProvenance | null;
}

export interface AutomationTelemetryGapJournalLike {
  initialize(): Promise<void>;
  read(): Promise<AutomationTelemetryGapJournalState | null>;
  record(input: AutomationTelemetryGapInput): Promise<AutomationTelemetryGapJournalState>;
  clear(gapHandoffId: string, gapRecordsHash: string): Promise<boolean>;
}

export class AutomationTelemetryGapJournal implements AutomationTelemetryGapJournalLike {
  private readonly queue = new SerialTaskQueue();
  private state: AutomationTelemetryGapJournalState | null | undefined;
  private activeSlot = -1;

  constructor(
    private readonly path: string,
    private readonly createHandoffId: () => string = randomUUID
  ) {}

  initialize() {
    return this.queue.run(async () => { await this.load(); });
  }

  read() {
    return this.queue.run(async () => structuredClone(await this.load()));
  }

  record(input: AutomationTelemetryGapInput) {
    return this.queue.run(async () => {
      validateGapInput(input);
      const current = await this.load();
      const trackedSource = findTrackedSource(current, input.handoffId);
      if (trackedSource) {
        if (trackedSource.recordsHash === input.recordsHash) return structuredClone(current!);
        if (trackedSource.provenance !== input.provenance ||
          input.droppedCount === trackedSource.droppedCount) {
          throw new Error("automation telemetry gap handoff conflict");
        }
        if (input.droppedCount < trackedSource.droppedCount) return structuredClone(current!);
      }

      const previousSourceCount = trackedSource?.droppedCount ?? 0;
      const addedCount = input.droppedCount - previousSourceCount;
      const cumulativeSource = isCumulativeGapProvenance(input.provenance);
      const nextWithoutHash = {
        version: 1 as const,
        generation: (current?.generation ?? 0) + 1,
        gapHandoffId: this.createHandoffId(),
        revision: current ? Math.max(current.revision, input.revision) : input.revision,
        firstDroppedAt: current ? earlierTimestamp(current.firstDroppedAt, input.firstDroppedAt) : input.firstDroppedAt,
        lastDroppedAt: current ? laterTimestamp(current.lastDroppedAt, input.lastDroppedAt) : input.lastDroppedAt,
        droppedCount: Math.min(Number.MAX_SAFE_INTEGER, (current?.droppedCount ?? 0) + addedCount),
        lastSourceHandoffId: input.handoffId,
        lastSourceRecordsHash: input.recordsHash,
        lastSourceDroppedCount: input.droppedCount,
        provenance: input.provenance,
        cumulativeSourceHandoffId: cumulativeSource
          ? input.handoffId
          : current?.cumulativeSourceHandoffId ?? null,
        cumulativeSourceRecordsHash: cumulativeSource
          ? input.recordsHash
          : current?.cumulativeSourceRecordsHash ?? null,
        cumulativeSourceDroppedCount: cumulativeSource
          ? input.droppedCount
          : current?.cumulativeSourceDroppedCount ?? 0,
        cumulativeSourceProvenance: cumulativeSource
          ? input.provenance
          : current?.cumulativeSourceProvenance ?? null
      };
      const next: AutomationTelemetryGapJournalState = {
        ...nextWithoutHash,
        gapRecordsHash: gapRecordsHash(nextWithoutHash)
      };
      await this.writeState(next);
      return structuredClone(next);
    });
  }

  clear(gapHandoffId: string, gapRecordsHash: string) {
    return this.queue.run(async () => {
      const current = await this.load();
      if (!current || current.gapHandoffId !== gapHandoffId || current.gapRecordsHash !== gapRecordsHash) {
        return false;
      }
      await this.writeState(null, current.generation + 1);
      return true;
    });
  }

  private async load() {
    if (this.state !== undefined) return this.state;
    await ensurePreallocatedFile(this.path, AUTOMATION_TELEMETRY_GAP_JOURNAL_BYTES);
    const file = await open(this.path, "r");
    try {
      const candidates: Array<{ slot: number; generation: number; state: AutomationTelemetryGapJournalState | null }> = [];
      let nonzeroBlocks = 0;
      for (let slot = 0; slot < GAP_BLOCK_COUNT; slot += 1) {
        const block = Buffer.alloc(GAP_BLOCK_BYTES);
        await file.read(block, 0, block.length, slot * GAP_BLOCK_BYTES);
        if (!block.every((byte) => byte === 0)) nonzeroBlocks += 1;
        const decoded = decodeBlock(block);
        if (decoded) candidates.push({ slot, ...decoded });
      }
      if (candidates.length === 0) {
        const metadata = await stat(this.path);
        if (metadata.size !== AUTOMATION_TELEMETRY_GAP_JOURNAL_BYTES) {
          throw new Error("automation telemetry gap journal size is invalid");
        }
        if (nonzeroBlocks > 0) throw new Error("automation telemetry gap journal is corrupt");
        this.state = null;
        this.activeSlot = -1;
        return this.state;
      }
      candidates.sort((left, right) => right.generation - left.generation);
      const latest = candidates[0]!;
      this.state = latest.state;
      this.activeSlot = latest.slot;
      return this.state;
    } finally {
      await file.close();
    }
  }

  private async writeState(state: AutomationTelemetryGapJournalState | null, generation = state?.generation ?? 0) {
    const nextSlot = (this.activeSlot + 1) % GAP_BLOCK_COUNT;
    const file = await open(this.path, "r+");
    try {
      const block = encodeBlock(state, generation);
      await writeAll(file, block, nextSlot * GAP_BLOCK_BYTES);
      await file.sync();
    } finally {
      await file.close();
    }
    this.state = state;
    this.activeSlot = nextSlot;
  }
}

function encodeBlock(state: AutomationTelemetryGapJournalState | null, generation: number) {
  const payload = Buffer.from(JSON.stringify(state), "utf8");
  if (payload.length > GAP_BLOCK_BYTES - GAP_HEADER_BYTES) {
    throw new Error("automation telemetry gap journal payload exceeded fixed block");
  }
  const block = Buffer.alloc(GAP_BLOCK_BYTES);
  GAP_MAGIC.copy(block, 0);
  block.writeBigUInt64BE(BigInt(generation), GAP_MAGIC.length);
  block.writeUInt32BE(payload.length, GAP_MAGIC.length + 8);
  const digest = createHash("sha256")
    .update(block.subarray(GAP_MAGIC.length, GAP_MAGIC.length + 8))
    .update(payload)
    .digest();
  digest.copy(block, GAP_MAGIC.length + 12);
  payload.copy(block, GAP_HEADER_BYTES);
  return block;
}

function decodeBlock(block: Buffer) {
  if (block.every((byte) => byte === 0)) return null;
  if (!block.subarray(0, GAP_MAGIC.length).equals(GAP_MAGIC)) return null;
  const generation = Number(block.readBigUInt64BE(GAP_MAGIC.length));
  const length = block.readUInt32BE(GAP_MAGIC.length + 8);
  if (!Number.isSafeInteger(generation) || length > GAP_BLOCK_BYTES - GAP_HEADER_BYTES) return null;
  const payload = block.subarray(GAP_HEADER_BYTES, GAP_HEADER_BYTES + length);
  const expected = createHash("sha256")
    .update(block.subarray(GAP_MAGIC.length, GAP_MAGIC.length + 8))
    .update(payload)
    .digest();
  if (!block.subarray(GAP_MAGIC.length + 12, GAP_HEADER_BYTES).equals(expected)) return null;
  try {
    const value = JSON.parse(payload.toString("utf8"));
    return { generation, state: value === null ? null : parseJournalState(value, generation) };
  } catch {
    return null;
  }
}

function parseJournalState(value: unknown, generation: number): AutomationTelemetryGapJournalState {
  if (!isRecord(value) || value.version !== 1 || value.generation !== generation ||
    typeof value.gapHandoffId !== "string" || typeof value.gapRecordsHash !== "string" ||
    !Number.isSafeInteger(value.revision) || typeof value.firstDroppedAt !== "string" ||
    typeof value.lastDroppedAt !== "string" || !Number.isSafeInteger(value.droppedCount) ||
    typeof value.lastSourceHandoffId !== "string" || typeof value.lastSourceRecordsHash !== "string" ||
    !Number.isSafeInteger(value.lastSourceDroppedCount) || !isGapProvenance(value.provenance)) {
    throw new Error("invalid automation telemetry gap journal");
  }
  const parsed = value as unknown as AutomationTelemetryGapJournalState;
  validateGapInput({
    handoffId: parsed.lastSourceHandoffId,
    recordsHash: parsed.lastSourceRecordsHash,
    provenance: parsed.provenance,
    revision: parsed.revision,
    firstDroppedAt: parsed.firstDroppedAt,
    lastDroppedAt: parsed.lastDroppedAt,
    droppedCount: parsed.lastSourceDroppedCount
  });
  const cumulativeSource = parseCumulativeSource(value);
  if (parsed.droppedCount < parsed.lastSourceDroppedCount ||
    parsed.droppedCount < cumulativeSource.droppedCount ||
    parsed.gapRecordsHash !== gapRecordsHash({
      ...parsed,
      gapRecordsHash: undefined
    })) {
    throw new Error("invalid automation telemetry gap journal hash");
  }
  return {
    ...parsed,
    cumulativeSourceHandoffId: cumulativeSource.handoffId,
    cumulativeSourceRecordsHash: cumulativeSource.recordsHash,
    cumulativeSourceDroppedCount: cumulativeSource.droppedCount,
    cumulativeSourceProvenance: cumulativeSource.provenance
  };
}

function parseCumulativeSource(value: Record<string, unknown>) {
  const fields = [
    value.cumulativeSourceHandoffId,
    value.cumulativeSourceRecordsHash,
    value.cumulativeSourceDroppedCount,
    value.cumulativeSourceProvenance
  ];
  if (fields.every((field) => field === undefined) || (
    value.cumulativeSourceHandoffId === null && value.cumulativeSourceRecordsHash === null &&
    value.cumulativeSourceDroppedCount === 0 && value.cumulativeSourceProvenance === null
  )) {
    return { handoffId: null, recordsHash: null, droppedCount: 0, provenance: null };
  }
  if (typeof value.cumulativeSourceHandoffId !== "string" ||
    !/^sha256:[a-f0-9]{64}$/.test(String(value.cumulativeSourceRecordsHash)) ||
    !Number.isSafeInteger(value.cumulativeSourceDroppedCount) ||
    Number(value.cumulativeSourceDroppedCount) <= 0 ||
    !isCumulativeGapProvenance(value.cumulativeSourceProvenance)) {
    throw new Error("invalid automation telemetry cumulative gap source");
  }
  return {
    handoffId: value.cumulativeSourceHandoffId,
    recordsHash: value.cumulativeSourceRecordsHash as string,
    droppedCount: value.cumulativeSourceDroppedCount as number,
    provenance: value.cumulativeSourceProvenance
  };
}

function gapRecordsHash(value: object) {
  const normalized = Object.fromEntries(Object.entries(value).filter(([key]) => key !== "gapRecordsHash"));
  return `sha256:${createHash("sha256").update(JSON.stringify(normalized)).digest("hex")}` as const;
}

function validateGapInput(input: AutomationTelemetryGapInput) {
  if (input.handoffId.length === 0 || input.handoffId.length > 512 ||
    !/^sha256:[a-f0-9]{64}$/.test(input.recordsHash) || !isGapProvenance(input.provenance) ||
    !Number.isSafeInteger(input.revision) || input.revision < 0 ||
    Number.isNaN(Date.parse(input.firstDroppedAt)) || Number.isNaN(Date.parse(input.lastDroppedAt)) ||
    Date.parse(input.firstDroppedAt) > Date.parse(input.lastDroppedAt) ||
    !Number.isSafeInteger(input.droppedCount) || input.droppedCount <= 0) {
    throw new Error("invalid automation telemetry gap");
  }
}

async function ensurePreallocatedFile(path: string, bytes: number) {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  try {
    const metadata = await stat(path);
    if (metadata.size !== bytes) throw new Error("automation telemetry gap journal size is invalid");
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const file = await open(path, "wx", 0o600);
  try {
    const block = Buffer.alloc(GAP_BLOCK_BYTES);
    for (let position = 0; position < bytes; position += block.length) {
      await writeAll(file, block, position);
    }
    await file.sync();
  } catch (error) {
    await file.close();
    await rm(path, { force: true });
    throw error;
  }
  await file.close();
  await syncDirectory(directory);
}

async function syncDirectory(directory: string) {
  const directoryHandle = await open(directory, "r");
  try {
    await directoryHandle.sync();
  } finally {
    await directoryHandle.close();
  }
}

function earlierTimestamp(left: string, right: string) {
  return Date.parse(left) <= Date.parse(right) ? left : right;
}

async function writeAll(
  file: Awaited<ReturnType<typeof open>>,
  buffer: Buffer,
  position: number
) {
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesWritten } = await file.write(
      buffer,
      offset,
      buffer.length - offset,
      position + offset
    );
    if (bytesWritten <= 0) throw new Error("automation telemetry fixed write made no progress");
    offset += bytesWritten;
  }
}

function laterTimestamp(left: string, right: string) {
  return Date.parse(left) >= Date.parse(right) ? left : right;
}

function findTrackedSource(
  current: AutomationTelemetryGapJournalState | null,
  handoffId: string
) {
  if (!current) return null;
  if (current.cumulativeSourceHandoffId === handoffId) {
    return {
      recordsHash: current.cumulativeSourceRecordsHash!,
      droppedCount: current.cumulativeSourceDroppedCount,
      provenance: current.cumulativeSourceProvenance!
    };
  }
  if (current.lastSourceHandoffId === handoffId) {
    return {
      recordsHash: current.lastSourceRecordsHash,
      droppedCount: current.lastSourceDroppedCount,
      provenance: current.provenance
    };
  }
  return null;
}

function isCumulativeGapProvenance(value: unknown): value is AutomationTelemetryGapProvenance {
  return value === "automation_state_gap" || value === "fixture_state_outbox";
}

function isGapProvenance(value: unknown): value is AutomationTelemetryGapProvenance {
  return value === "automation_handoff_capacity" || value === "automation_handoff_storage" ||
    value === "automation_state_storage" || value === "automation_state_gap" ||
    value === "fixture_state_outbox";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
