import { PrismaClient } from "@prisma/client";
import { disposablePostgres } from "../../test/support/disposable-postgres";

const enabled = process.env.GATEWAY_RECOMMISSION_DISPOSABLE_POSTGRES === "1";

(enabled ? describe : describe.skip)("gateway recommission migration on disposable PostgreSQL", () => {
  let cluster: Awaited<ReturnType<typeof disposablePostgres>>;
  let db: PrismaClient;

  beforeAll(async () => {
    cluster = await disposablePostgres();
    const url = cluster.database();
    const deployed = cluster.deploy(url);
    expect(deployed.status).toBe(0);
    db = new PrismaClient({ datasourceUrl: url });
    await db.$connect();
  }, 30_000);

  afterAll(async () => { await db?.$disconnect(); cluster?.stop(); });

  it("enforces the named status domain and one active reset fence per inventory", async () => {
    const constraints = await db.$queryRaw<Array<{ conname: string }>>`
      SELECT conname FROM pg_constraint
      WHERE conrelid = '"GatewayRecommissionJob"'::regclass AND conname = 'GatewayRecommissionJob_status_check'
    `;
    expect(constraints).toEqual([{ conname: "GatewayRecommissionJob_status_check" }]);
    const insert = (id: string, inventoryId: string, status: string) => db.$executeRawUnsafe(
      `INSERT INTO "GatewayRecommissionJob" ("id", "siteId", "inventoryId", "gatewayId", "serialNumber", "resetDigest", "targetSnapshot", "objectKeys", "status", "updatedAt")
       VALUES ('${id}', 'site-1', '${inventoryId}', 'gateway-1', 'GW-001', 'digest', '{}', '[]', '${status}', now())`
    );
    await expect(insert("job-1", "inventory-1", "prepared")).resolves.toBe(1);
    await expect(insert("job-2", "inventory-1", "mqtt_revoked")).rejects.toThrow();
    await expect(insert("job-3", "inventory-2", "not-a-status")).rejects.toThrow();
    await expect(insert("job-4", "inventory-1", "finalized")).resolves.toBe(1);
  });
});
