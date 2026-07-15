import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ApplianceHealth } from "./appliance-health";

it("records unassigned, healthy, and unhealthy appliance states atomically", async () => {
  const file = path.join(await mkdtemp(path.join(tmpdir(), "gateway-health-")), "health.json");
  const health = new ApplianceHealth(file, () => new Date("2026-07-13T00:00:00.000Z"));
  await health.startingUnassigned();
  await expect(health.read()).resolves.toMatchObject({ status: "starting-unassigned", assignment: false, mqtt: false });
  await health.healthy();
  await expect(health.read()).resolves.toMatchObject({ status: "healthy", assignment: true, mesh: true, mqtt: true, mapping: true });
  await health.unhealthy("mqtt_disconnected");
  await expect(health.read()).resolves.toMatchObject({ status: "unhealthy", reason: "mqtt_disconnected", mqtt: false });
});
