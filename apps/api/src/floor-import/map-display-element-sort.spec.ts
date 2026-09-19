import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MapElement } from "@led-control/shared";
import { sortMapDisplayElements } from "./map-display-element-sort";

const element = (i: number): MapElement => ({ id: `e${String(i).padStart(3, "0")}`, type: "text", layerId: "layer", groupId: null,
  zIndex: i % 3, visible: true, locked: false, provenance: null,
  transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 },
  style: { strokeColor: "#000000", fillColor: null, strokeWidth: 1, opacity: 1 },
  geometry: { text: "a".repeat(60_000), position: { x: 0, y: 0 }, width: 10, height: 10, fontSize: 10 } });

describe("bounded checkpoint paint-key sort", () => {
  let directory: string;
  beforeEach(() => { directory = mkdtempSync(join(tmpdir(), "display-sort-test-")); });
  afterEach(() => rmSync(directory, { recursive: true, force: true }));
  it("merges multiple compressed runs by ordinal paint key and releases the physical ledger", async () => {
    const input = Array.from({ length: 90 }, (_, i) => element(89 - i));
    let physical = 0, peak = 0; const ids: string[] = [];
    for await (const e of sortMapDisplayElements((async function* () { yield* input; })(), directory,
      delta => { physical += delta; peak = Math.max(peak, physical); }, () => {}, input.length)) ids.push(e.id);
    expect(ids).toEqual([...input].sort((a, b) => a.zIndex - b.zIndex || (a.id < b.id ? -1 : 1)).map(e => e.id));
    expect(peak).toBeGreaterThan(0); expect(physical).toBe(0); expect(readdirSync(directory)).toEqual([]);
  });
  it("cleans runs on early return, count mismatch and cancellation", async () => {
    const input = (async function* () { for (let i = 60; i > 0; i--) yield element(i); });
    for await (const _element of sortMapDisplayElements(input(), directory, () => {}, () => {}, 60)) break;
    expect(readdirSync(directory)).toEqual([]);
    const consume = async (count: number, check = () => {}) => {
      for await (const _element of sortMapDisplayElements(input(), directory, () => {}, check, count)) { /* consume validation */ }
    };
    await expect(consume(61)).rejects.toThrow(/count/); expect(readdirSync(directory)).toEqual([]);
    let checked = 0;
    await expect(consume(60, () => { if (++checked > 80) throw Error("cancelled"); })).rejects.toThrow("cancelled");
    expect(readdirSync(directory)).toEqual([]);
  });
});
