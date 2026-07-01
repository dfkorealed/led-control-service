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
});
