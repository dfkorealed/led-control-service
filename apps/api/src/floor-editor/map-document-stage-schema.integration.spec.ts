import { PrismaClient } from "@prisma/client";

const url = process.env.U6B_TEST_DATABASE_URL;
(url ? describe : describe.skip)("U6b stage schema clean/upgrade", () => {
  const prisma = new PrismaClient(url ? { datasourceUrl: url } : undefined);
  beforeAll(async () => {
    const target = new URL(url!);
    if (!/^\/led_u6b_test_/.test(target.pathname) || target.hostname !== "127.0.0.1" || target.port === "5432") throw Error("isolated DB required");
    const [row] = await prisma.$queryRaw<Array<{ name: string }>>`SELECT current_database() AS name`;
    expect(`/${row.name}`).toBe(target.pathname);
  });
  afterAll(async () => { await prisma.$disconnect(); });
  it("persists worker fencing, immutable request authority, result receipt and bounded upload intent", async () => {
    const rows = await prisma.$queryRaw<Array<{ column_name: string }>>`SELECT column_name FROM information_schema.columns WHERE table_name = 'FloorMapStage'`;
    expect(rows.map(row => row.column_name)).toEqual(expect.arrayContaining([
      "leaseFence", "requestHash", "metadata", "expectedPartCount", "expectedDecodedBytes", "workerToken", "workerExpiresAt", "result", "errorCode",
      "preparedGenerationId", "commitRequested"
    ]));
    const statuses = await prisma.$queryRaw<Array<{ value: string }>>`SELECT unnest(enum_range(NULL::"FloorMapStageStatus"))::text AS value`;
    expect(statuses.map(row => row.value)).toEqual(expect.arrayContaining(["queued", "processing", "cancelled"]));
  });
  it("preserves upgrade assets and terminal history while fencing only legacy upload states", async () => {
    if (process.env.U6B_TEST_MODE !== "upgrade") return;
    const rows = await prisma.$queryRaw<Array<{ id: string; status: string; leaseFence: number; requestHash: string; metadata: unknown }>>`
      SELECT "id", "status"::text, "leaseFence", "requestHash", "metadata" FROM "FloorMapStage" WHERE "floorId"='u6b-legacy-floor' ORDER BY "id"`;
    expect(rows.map(row => [row.id, row.status])).toEqual([
      ["u6b-committed", "committed"], ["u6b-failed", "failed"], ["u6b-preparing", "expired"], ["u6b-ready", "expired"]
    ]);
    expect(rows.every(row => row.leaseFence === 0 && row.requestHash === "0".repeat(64) && JSON.stringify(row.metadata) === "{}")).toBe(true);
    expect(await prisma.floorMapStagePart.count({ where: { floorId: "u6b-legacy-floor" } })).toBe(4);
    expect(await prisma.floorMapRevisionAsset.count({ where: { floorId: "u6b-legacy-floor" } })).toBe(1);
    expect(await prisma.floorAsset.count({ where: { floorId: "u6b-legacy-floor" } })).toBe(4);
  });
});
