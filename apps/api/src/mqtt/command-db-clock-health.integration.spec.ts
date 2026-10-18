import { PrismaClient } from "@prisma/client";
import { isIP } from "node:net";
import { disposablePostgres } from "../../test/support/disposable-postgres";
import { CommandDbClockHealth, type CommandDbClockEvidence } from "./command-db-clock-health.service";

const enabled = process.env.COMMAND_RETENTION_TEST === "1";

(enabled ? describe : describe.skip)("clock primary host identity on disposable PostgreSQL", () => {
  let cluster: Awaited<ReturnType<typeof disposablePostgres>>;
  let db: PrismaClient;

  beforeAll(async () => {
    cluster = await disposablePostgres();
    db = new PrismaClient({ datasourceUrl: cluster.database() });
  }, 30_000);
  afterAll(async () => { await db?.$disconnect(); cluster?.stop(); });

  async function attest(): Promise<CommandDbClockEvidence> {
    const [row] = await db.$queryRaw<Array<{
      issuedAt: Date; startedAt: Date; address: string; inetText: string; port: number;
    }>>`SELECT clock_timestamp() AS "issuedAt", pg_postmaster_start_time() AS "startedAt",
      host(inet_server_addr()) AS address, inet_server_addr()::text AS "inetText", inet_server_port() AS port`;
    expect(isIP(row.address)).toBe(4);
    expect(row.inetText).toBe(`${row.address}/32`);
    return {
      issuedAt: row.issuedAt, offsetMs: 0, stepGeneration: 1, clearedStepGeneration: 1,
      failoverGeneration: 1, clearedFailoverGeneration: 1,
      primary: { startedAt: row.startedAt, address: row.address, port: row.port }
    };
  }

  it("accepts the canonical host from real PostgreSQL without an inet netmask", async () => {
    const evidence = await attest();
    const health = new CommandDbClockHealth({ read: async () => evidence });
    await expect(db.$transaction(tx => health.assertHealthy(tx))).resolves.toBeInstanceOf(Date);
  });

  it.each(["address", "port", "startedAt", "stale", "offset", "generation"])("still rejects mismatching %s evidence", async kind => {
    const evidence = await attest();
    if (kind === "address") evidence.primary.address = "127.0.0.2";
    if (kind === "port") evidence.primary.port = evidence.primary.port === 65535 ? 65534 : evidence.primary.port! + 1;
    if (kind === "startedAt") evidence.primary.startedAt = new Date(evidence.primary.startedAt.getTime() - 1_000);
    if (kind === "stale") evidence.issuedAt = new Date(evidence.issuedAt.getTime() - 2_000);
    if (kind === "offset") evidence.offsetMs = 101;
    if (kind === "generation") evidence.clearedStepGeneration = 0;
    const health = new CommandDbClockHealth({ read: async () => evidence });
    await expect(db.$transaction(tx => health.assertHealthy(tx))).rejects.toThrow("not current for primary");
  });
});
