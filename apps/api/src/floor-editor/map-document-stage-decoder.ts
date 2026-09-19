import { MapOp, mapOpSchema } from "@led-control/shared";
import { setImmediate } from "node:timers/promises";
import { MAP_STAGE_MAX_PARTS, MAP_STAGE_PART_BYTES, MAP_STAGE_TOTAL_BYTES } from "./map-document-stage-contracts";

interface DecodeOptions {
  signal?: AbortSignal;
  deadline?: number;
  operationBytes?: number;
  totalBytes?: number;
  maxOperations?: number;
}
const OPERATION_BYTES = 8 * 1024 * 1024 + 4096;
const MAX_OPERATIONS = 1_000_000;
const whitespace = (byte: number) => byte === 32 || byte === 9 || byte === 10 || byte === 13;

/** Frame only one object, then let JSON.parse + the shared schema validate it.
 * Framing operates on bytes so split UTF8 is preserved, invalid UTF8 is fatal,
 * and no concatenation/JS geometry array scales with the entire upload. */
export async function* decodeStageOperations(parts: AsyncIterable<Buffer>, options: DecodeOptions = {}): AsyncGenerator<MapOp> {
  const limit = (value: number | undefined, maximum: number) => {
    const result = value ?? maximum;
    if (!Number.isSafeInteger(result) || result < 1 || result > maximum) throw new Error("invalid stage decoder budget");
    return result;
  };
  const operationLimit = limit(options.operationBytes, OPERATION_BYTES);
  const totalLimit = limit(options.totalBytes, MAP_STAGE_TOTAL_BYTES);
  const countLimit = limit(options.maxOperations, MAX_OPERATIONS);
  const deadline = Math.min(options.deadline ?? Infinity, Date.now() + 5 * 60_000);
  const check = () => {
    options.signal?.throwIfAborted();
    if (Date.now() > deadline) throw new Error("stage decoder deadline exceeded");
  };
  let state: "start" | "first" | "value" | "object" | "comma" | "end" = "start";
  let total = 0, partCount = 0, count = 0, depth = 0, string = false, escape = false, length = 0;
  let slices: Buffer[] = [];
  for await (const part of parts) {
    check();
    total += part.length;
    if (++partCount > MAP_STAGE_MAX_PARTS || part.length < 1 || part.length > MAP_STAGE_PART_BYTES) throw new Error("stage part budget exceeded");
    if (total > totalLimit) throw new Error("stage total byte budget exceeded");
    let start = state === "object" ? 0 : -1;
    for (let i = 0; i < part.length; i++) {
      if (i % 65536 === 0) { check(); await setImmediate(); }
      const byte = part[i];
      if (state !== "object") {
        if (whitespace(byte)) continue;
        if (state === "start" && byte === 91) { state = "first"; continue; }
        if ((state === "first" || state === "comma") && byte === 93) { state = "end"; continue; }
        if (state === "comma" && byte === 44) { state = "value"; continue; }
        if ((state === "first" || state === "value") && byte === 123) {
          state = "object"; start = i; depth = 0; length = 0;
        } else throw new Error("invalid stage JSON array framing");
      }
      if (++length > operationLimit) throw new Error("stage operation byte budget exceeded");
      if (string) {
        if (escape) escape = false;
        else if (byte === 92) escape = true;
        else if (byte === 34) string = false;
      } else if (byte === 34) string = true;
      else if (byte === 123 || byte === 91) {
        if (++depth > 64) throw new Error("stage JSON depth budget exceeded");
      } else if (byte === 125 || byte === 93) {
        if (--depth === 0) {
          if (++count > countLimit) throw new Error("stage operation count budget exceeded");
          slices.push(part.subarray(start, i + 1));
          const text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(slices, length));
          slices = []; start = -1; state = "comma";
          yield mapOpSchema.parse(JSON.parse(text));
        }
      }
    }
    if (start >= 0) slices.push(Buffer.from(part.subarray(start)));
  }
  check();
  if (state !== "end") throw new Error("incomplete stage JSON array");
}
