import { PrismaClient } from "@prisma/client";
import { disposablePostgres } from "../../test/support/disposable-postgres";
import { CommandClockResponderService } from "./command-clock-responder.service";
import { CommandDbClockHealth, type CommandDbClockEvidence } from "./command-db-clock-health.service";

const enabled = process.env.COMMAND_RETENTION_TEST === "1";
const scope = {
  siteId: "11111111-1111-4111-8111-111111111111",
  gatewayId: "22222222-2222-4222-8222-222222222222"
};
const request = { ...scope, nonce: "33333333-3333-4333-8333-333333333333" };

(enabled ? describe : describe.skip)("command clock responder on disposable primary PostgreSQL", () => {
  let cluster: Awaited<ReturnType<typeof disposablePostgres>>;
  let db: PrismaClient;
  let evidence: CommandDbClockEvidence | null = null;
  let responder: CommandClockResponderService;

  beforeAll(async () => {
    cluster = await disposablePostgres();
    const url = cluster.database();
    const deployed = cluster.deploy(url);
    expect(deployed.stderr + deployed.stdout).not.toMatch(/Error:|P30\d\d/);
    expect(deployed.status).toBe(0);
    db = new PrismaClient({ datasourceUrl: `${url}?connection_limit=1` });
    responder = new CommandClockResponderService(db as never, new CommandDbClockHealth({ read: async () => evidence }));
    await db.$executeRaw`INSERT INTO "CommandPublishEpoch" ("generation") VALUES (91)`;
  }, 30_000);
  afterAll(async () => { await db?.$disconnect(); cluster?.stop(); });

  async function attest() {
    const [row] = await db.$queryRaw<Array<{
      issuedAt: Date; primaryStartedAt: Date; serverAddress: string | null; serverPort: number | null
    }>>`SELECT clock_timestamp() AS "issuedAt", pg_postmaster_start_time() AS "primaryStartedAt",
      inet_server_addr()::text AS "serverAddress", inet_server_port() AS "serverPort"`;
    evidence = {
      issuedAt: row.issuedAt, offsetMs: 0, stepGeneration: 1, clearedStepGeneration: 1,
      failoverGeneration: 1, clearedFailoverGeneration: 1,
      primary: { startedAt: row.primaryStartedAt, address: row.serverAddress, port: row.serverPort }
    };
  }

  it("returns DB clock and active epoch only while the matching primary is attested", async () => {
    expect(await responder.respond(scope, request)).toBeNull();
    await attest();
    const response = await responder.respond(scope, request);
    expect(response).toEqual({ ...request, dbNow: expect.any(String), publishEpoch: 91 });
    expect(Math.abs(Date.parse(response!.dbNow) - evidence!.issuedAt.getTime())).toBeLessThan(1_000);
    await db.$executeRaw`UPDATE "CommandPublishEpoch" SET "status" = 'quiescing' WHERE "generation" = 91`;
    await attest();
    expect(await responder.respond(scope, request)).toBeNull();
  });
});
