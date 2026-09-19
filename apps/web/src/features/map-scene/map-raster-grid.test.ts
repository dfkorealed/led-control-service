import { describe, expect, it } from "vitest";
import { mapRasterGrid } from "./map-raster-grid";

describe("half-open camera-influence raster ownership", () => {
  it.each([1, 1.5, 2])("coalesces subpixel source cells at minimum zoom, DPR %s", resolution => {
    const grid = mapRasterGrid({ width: 1024, height: 1024, tileSize: 512 },
      { centerX: 512, centerY: 512, zoom: 0.001, viewportWidth: 320, viewportHeight: 320 }, resolution);
    const pixels = new Set<string>();
    for (const job of grid.jobs) {
      expect(job.width).toBeGreaterThan(0); expect(job.height).toBeGreaterThan(0);
      expect(job.width).toBeLessThanOrEqual(513); expect(job.height).toBeLessThanOrEqual(513);
      for (let y = job.top; y < job.top + job.height; y++) for (let x = job.left; x < job.left + job.width; x++) {
        const key = `${x}:${y}`; expect(pixels.has(key)).toBe(false); pixels.add(key);
      }
    }
    expect(pixels.has(`${Math.floor(160 * resolution)}:${Math.floor(160 * resolution)}`)).toBe(true);
    expect(grid.margin).toBeGreaterThanOrEqual(2500);
    expect(grid.jobs.length).toBeLessThanOrEqual(4);
  });
});
