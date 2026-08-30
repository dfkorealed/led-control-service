import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SYSTEMD_TIMESYNC_MARKER,
  SystemClockTrustProvider
} from "./clock-trust-provider";

describe("SystemClockTrustProvider", () => {
  it("requires the systemd synchronized marker to be a file", async () => {
    const missing = new SystemClockTrustProvider(SYSTEMD_TIMESYNC_MARKER, {
      stat: async () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); }
    });
    const directory = new SystemClockTrustProvider(SYSTEMD_TIMESYNC_MARKER, {
      stat: async () => ({ mtimeMs: 100, isFile: () => false })
    });

    await expect(missing.isTrusted(new Date("2026-08-30T01:00:00.000Z"))).resolves.toBe(false);
    await expect(directory.isTrusted(new Date("2026-08-30T01:00:00.000Z"))).resolves.toBe(false);
  });

  it("stays untrusted after a five-minute rollback until the marker mtime advances", async () => {
    let markerMtimeMs = 100;
    const provider = new SystemClockTrustProvider(SYSTEMD_TIMESYNC_MARKER, {
      stat: async () => ({ mtimeMs: markerMtimeMs, isFile: () => true })
    });

    await expect(provider.isTrusted(new Date("2026-08-30T01:10:00.000Z"))).resolves.toBe(true);
    await expect(provider.isTrusted(new Date("2026-08-30T01:04:59.999Z"))).resolves.toBe(false);
    await expect(provider.isTrusted(new Date("2026-08-30T01:05:10.000Z"))).resolves.toBe(false);

    markerMtimeMs = 101;
    await expect(provider.isTrusted(new Date("2026-08-30T01:05:11.000Z"))).resolves.toBe(true);
  });

  it("does not freeze schedules for a backward adjustment smaller than five minutes", async () => {
    const provider = new SystemClockTrustProvider(SYSTEMD_TIMESYNC_MARKER, {
      stat: async () => ({ mtimeMs: 100, isFile: () => true })
    });

    await provider.isTrusted(new Date("2026-08-30T01:10:00.000Z"));

    await expect(provider.isTrusted(new Date("2026-08-30T01:05:00.001Z"))).resolves.toBe(true);
  });

  it("fences the marker observed at rollback even when it advanced before rollback detection", async () => {
    let markerMtimeMs = 100;
    const provider = new SystemClockTrustProvider(SYSTEMD_TIMESYNC_MARKER, {
      stat: async () => ({ mtimeMs: markerMtimeMs, isFile: () => true })
    });
    await expect(provider.isTrusted(new Date("2026-08-30T01:10:00.000Z"))).resolves.toBe(true);

    markerMtimeMs = 110;
    await expect(provider.isTrusted(new Date("2026-08-30T01:04:00.000Z"))).resolves.toBe(false);
    await expect(provider.isTrusted(new Date("2026-08-30T01:04:01.000Z"))).resolves.toBe(false);

    markerMtimeMs = 111;
    await expect(provider.isTrusted(new Date("2026-08-30T01:04:02.000Z"))).resolves.toBe(true);
  });

  it("recovers after a cold-boot marker appears inside an already mounted timesync directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "timesync-marker-"));
    const directory = join(root, "timesync");
    const marker = join(directory, "synchronized");
    try {
      await mkdir(directory);
      const provider = new SystemClockTrustProvider(marker);

      await expect(provider.isTrusted(new Date("2026-08-30T01:00:00.000Z"))).resolves.toBe(false);
      await writeFile(marker, "");
      await expect(provider.isTrusted(new Date("2026-08-30T01:00:01.000Z"))).resolves.toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
