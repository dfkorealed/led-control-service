import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("Prisma domain schema", () => {
  it("declares the MVP 1 lighting control domain models", () => {
    const schema = readFileSync(join(process.cwd(), "prisma/schema.prisma"), "utf8");

    for (const model of [
      "Organization",
      "User",
      "Site",
      "Floor",
      "FloorPlan",
      "Fixture",
      "FixtureGroup",
      "Gateway",
      "MeshNode",
      "Command",
      "EnergyUsage"
    ]) {
      expect(schema).toContain(`model ${model}`);
    }
  });

  it("declares production gateway identity, dispatch, and ordered event records", () => {
    const schema = readFileSync(join(process.cwd(), "prisma/schema.prisma"), "utf8");

    for (const model of [
      "GatewayInventory",
      "GatewayClaimAudit",
      "CommandDispatch",
      "CommandFixtureResult",
      "MqttOutbox",
      "ProcessedGatewayEvent"
    ]) {
      expect(schema).toContain(`model ${model}`);
    }

    for (const field of [
      "claimCodeHash",
      "certificateFingerprint",
      "assignmentVersion",
      "nextCommandSequence",
      "lastStateEventId",
      "lastStateSequence",
      "idempotencyKey"
    ]) {
      expect(schema).toContain(field);
    }
  });
});
