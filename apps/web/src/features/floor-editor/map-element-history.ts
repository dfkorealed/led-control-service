import type { MapOp } from "@led-control/shared";

const MAX_ENTRIES = 100;
const MAX_BYTES = 32 * 1_024 * 1_024;
const encoder = new TextEncoder();

export class MapElementHistoryCapacityError extends Error {
  readonly code = "MAP_HISTORY_ENTRY_TOO_LARGE";
  readonly maxBytes = MAX_BYTES;

  constructor(readonly requiredBytes: number) {
    super("Map history entry requires external inverse storage");
    this.name = "MapElementHistoryCapacityError";
  }
}

interface HistoryEntry {
  forward: MapOp[];
  inverse: MapOp[];
  byteSize: number;
  before: symbol;
  after: symbol;
}

function decodedBytes(operations: MapOp[]): number {
  // Exact uncompressed UTF-8 JSON array bytes, including brackets and commas.
  // Encode one validated operation at a time, not a second giant batch string.
  let size = 2 + Math.max(0, operations.length - 1);
  for (const operation of operations) size += encoder.encode(JSON.stringify(operation)).byteLength;
  return size;
}

/**
 * Command-only history. Inputs must be validated, with a complete inverse in
 * replay order (including structure operations); this class does not apply ops.
 * Call execute before publishing the local edit so capacity failure is atomic.
 */
export class MapElementHistory {
  #entries: HistoryEntry[] = [];
  #cursor = 0;
  #byteSize = 0;
  // Tokens survive eviction and cannot alias a fork at the same cursor index.
  #current = Symbol();
  #saved = this.#current;

  get canUndo(): boolean { return this.#cursor > 0; }
  get canRedo(): boolean { return this.#cursor < this.#entries.length; }
  get isDirty(): boolean { return this.#current !== this.#saved; }
  get byteSize(): number { return this.#byteSize; }

  execute(forward: MapOp[], inverse: MapOp[]): void {
    if (forward.length === 0 && inverse.length === 0) return;
    if (forward.length === 0 || inverse.length === 0) {
      throw new RangeError("Map history requires both forward and inverse commands");
    }

    const byteSize = decodedBytes(forward) + decodedBytes(inverse);
    if (byteSize > MAX_BYTES) throw new MapElementHistoryCapacityError(byteSize);

    // Prepare both private snapshots before mutating redo, accounting or state.
    const entry: HistoryEntry = {
      forward: structuredClone(forward), inverse: structuredClone(inverse), byteSize,
      before: this.#current, after: Symbol()
    };
    for (const removed of this.#entries.splice(this.#cursor)) this.#byteSize -= removed.byteSize;
    this.#entries.push(entry);
    this.#byteSize += byteSize;
    this.#current = entry.after;
    while (this.#entries.length > MAX_ENTRIES || this.#byteSize > MAX_BYTES) {
      this.#byteSize -= this.#entries.shift()!.byteSize;
    }
    this.#cursor = this.#entries.length;
  }

  undo(): MapOp[] | null {
    if (!this.canUndo) return null;
    const entry = this.#entries[this.#cursor - 1];
    const operations = structuredClone(entry.inverse);
    this.#cursor--;
    this.#current = entry.before;
    return operations;
  }

  redo(): MapOp[] | null {
    if (!this.canRedo) return null;
    const entry = this.#entries[this.#cursor];
    const operations = structuredClone(entry.forward);
    this.#cursor++;
    this.#current = entry.after;
    return operations;
  }

  /** Mark only the current local state as saved; U8b must fence async saves. */
  adoptSavedBaseline(): void {
    this.#saved = this.#current;
  }

  /** Start a clean scope; clearing is not a way to retain unsaved dirty state. */
  clear(): void {
    this.#entries = [];
    this.#cursor = 0;
    this.#byteSize = 0;
    this.#current = Symbol();
    this.#saved = this.#current;
  }
}
