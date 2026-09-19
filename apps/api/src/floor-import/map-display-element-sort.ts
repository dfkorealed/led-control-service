import { randomUUID } from "node:crypto";
import { closeSync, openSync, readSync, rmSync, writeSync } from "node:fs";
import { join } from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";
import type { MapElement } from "@led-control/shared";

const CHUNK = 2 * 1024 * 1024, MAX_RECORD = 8 * 1024 * 1024, MAX_DECODED = 512 * 1024 * 1024;
const compare = (a: MapElement, b: MapElement) => a.zIndex - b.zIndex || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
type Run = { path: string; bytes: number };

/** Checkpoint input order is not a storage contract. External two-way merge
 * sorting keeps only two bounded decode frames and their current elements; no
 * whole-document JS array or source scan regeneration. Scratch shares the page
 * writer's physical ledger and is removed on cancellation/consumer failure. */
export async function* sortMapDisplayElements(input: AsyncIterable<MapElement>, directory: string,
  claim: (delta: number) => void, check: () => void, expectedCount: number): AsyncGenerator<MapElement> {
  const owned = new Set<Run>();
  const remove = (run: Run) => { rmSync(run.path, { force: true }); claim(-run.bytes); owned.delete(run); };
  function write(elements: Iterable<MapElement>): Run {
    const run = { path: join(directory, `${randomUUID()}.ordered-elements`), bytes: 0 };
    owned.add(run);
    const fd = openSync(run.path, "wx", 0o600); let chunks: Buffer[] = [], size = 0;
    const flush = () => {
      if (!size) return;
      const compressed = gzipSync(Buffer.concat(chunks, size), { level: 1 });
      const header = Buffer.alloc(8); header.writeUInt32LE(compressed.length); header.writeUInt32LE(size, 4);
      claim(8 + compressed.length); run.bytes += 8 + compressed.length;
      for (const buffer of [header, compressed]) {
        let offset = 0; while (offset < buffer.length) offset += writeSync(fd, buffer, offset, buffer.length - offset);
      }
      chunks = []; size = 0;
    };
    try {
      for (const element of elements) {
        check(); const bytes = Buffer.from(JSON.stringify(element) + "\n");
        if (bytes.length > MAX_RECORD) throw new Error("map display element record budget exceeded");
        if (size && size + bytes.length > CHUNK) flush();
        chunks.push(bytes); size += bytes.length;
      }
      flush(); return run;
    } finally { closeSync(fd); }
  }
  function* read(run: Run): Generator<MapElement> {
    const fd = openSync(run.path, "r"); let total = 0;
    const exact = (n: number) => {
      const bytes = Buffer.allocUnsafe(n); let offset = 0;
      while (offset < n) { const size = readSync(fd, bytes, offset, n - offset, null); if (!size) throw new Error("truncated map display sort frame"); offset += size; }
      total += n; return bytes;
    };
    try {
      while (total < run.bytes) {
        check(); const header = exact(8), compressed = header.readUInt32LE(), decoded = header.readUInt32LE(4);
        if (!decoded || decoded > MAX_RECORD || compressed > decoded + 65536 || compressed > run.bytes - total) throw new Error("invalid map display sort frame");
        const bytes = gunzipSync(exact(compressed), { maxOutputLength: decoded });
        if (bytes.length !== decoded) throw new Error("map display sort frame size mismatch");
        let start = 0;
        for (let end = bytes.indexOf(10); end >= 0; end = bytes.indexOf(10, start)) {
          check(); yield JSON.parse(bytes.subarray(start, end).toString("utf8")) as MapElement; start = end + 1;
        }
        if (start !== bytes.length) throw new Error("unfinished map display sort record");
      }
    } finally { closeSync(fd); }
  }
  function* merge(a: Run, b: Run) {
    const left = read(a), right = read(b);
    try {
      let l = left.next(), r = right.next();
      while (!l.done || !r.done) {
        if (r.done || !l.done && compare(l.value, r.value) <= 0) { yield l.value!; l = left.next(); }
        else { yield r.value; r = right.next(); }
      }
    } finally { left.return(undefined); right.return(undefined); }
  }
  try {
    let buffer: MapElement[] = [], bytes = 0, total = 0, count = 0, runs: Run[] = [];
    for await (const element of input) {
      check(); const size = Buffer.byteLength(JSON.stringify(element)) + 1;
      if (++count > 500_000 || size > MAX_RECORD || (total += size) > MAX_DECODED) throw new Error("map display canonical sort budget exceeded");
      if (bytes && bytes + size > CHUNK) { buffer.sort(compare); runs.push(write(buffer)); buffer = []; bytes = 0; }
      buffer.push(element); bytes += size;
    }
    if (count !== expectedCount) throw new Error("map display canonical count mismatch");
    if (!runs.length) { buffer.sort(compare); for (const element of buffer) { check(); yield element; } return; }
    if (buffer.length) { buffer.sort(compare); runs.push(write(buffer)); buffer = []; }
    while (runs.length > 1) {
      const next: Run[] = [];
      for (let i = 0; i < runs.length; i += 2) {
        if (i + 1 === runs.length) { next.push(runs[i]); continue; }
        next.push(write(merge(runs[i], runs[i + 1]))); remove(runs[i]); remove(runs[i + 1]);
      }
      runs = next;
    }
    for (const element of read(runs[0])) { check(); yield element; }
  } finally { for (const run of owned) remove(run); }
}
