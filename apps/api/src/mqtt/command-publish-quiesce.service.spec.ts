import { PrismaClient } from "@prisma/client";
import { disposablePostgres } from "../../test/support/disposable-postgres";
import { CommandPublishQuiesceService } from "./command-publish-quiesce.service";

(process.env.COMMAND_RETENTION_TEST === "1" ? describe : describe.skip)("CommandPublishQuiesceService", () => {
  let cluster: Awaited<ReturnType<typeof disposablePostgres>>;
  let db: PrismaClient;
  let peer: PrismaClient;
  let generation = 0;
  beforeAll(async () => {
    cluster = await disposablePostgres();
    const url = cluster.database();
    expect(cluster.deploy(url).status).toBe(0);
    db = new PrismaClient({ datasourceUrl: url });
    peer = new PrismaClient({ datasourceUrl: url });
  }, 30_000);
  beforeEach(async () => {
    await db.commandPublishEpoch.create({ data: { generation: ++generation } });
    await db.commandPublishMember.createMany({ data: ["a", "offline"].map(workerId => ({
      generation, workerId, brokerIdentity: `command-set-${generation}`
    })) });
  });
  afterEach(async () => {
    for (const status of ["fenced", "retired"] as const) {
      await db.commandPublishEpoch.update({ where: { generation }, data: { status } });
    }
  });
  afterAll(async () => { await Promise.all([db?.$disconnect(), peer?.$disconnect()]); cluster?.stop(); });

  it("commits quiesce before local drain, holds no permit during close, and never expires a missing ACK into safety", async () => {
    const draining = deferred();
    const finish = deferred();
    const publisher = { publishWorkerId: "a", stopAndDrain: async () => { draining.resolve(); await finish.promise; } };
    const egress = { memberIdentity: { generation, workerId: "a", brokerIdentity: `command-set-${generation}` },
      close: jest.fn(async () => {}) };
    const service = new CommandPublishQuiesceService(db as never, publisher as never, egress as never);
    const pending = service.begin();
    await draining.promise;
    expect((await peer.commandPublishEpoch.findUniqueOrThrow({ where: { generation } })).status).toBe("quiescing");
    const [permit] = await peer.$transaction(tx => tx.$queryRaw<Array<{ acquired: boolean }>>`
      SELECT pg_try_advisory_xact_lock(${8052026092501n}) AS acquired`);
    expect(permit.acquired).toBe(true);
    expect(await peer.commandPublishMember.count({ where: { generation, quiesceAckAt: { not: null } } })).toBe(0);
    finish.resolve();
    const result = await pending;
    expect(result).toEqual({ generation, allMembersAcknowledged: false, pendingWorkerIds: ["offline"], brokerFenced: false });
    expect(egress.close).toHaveBeenCalledTimes(1);
    const later = await new CommandPublishQuiesceService(peer as never).begin();
    expect(later).toEqual(result);
    expect((await db.commandPublishEpoch.findUniqueOrThrow({ where: { generation } })).status).toBe("quiescing");
  });

  it("keeps a member unacknowledged when its local drain fails", async () => {
    const publisher = { publishWorkerId: "a", stopAndDrain: async () => { throw new Error("in-flight unknown"); } };
    const egress = { memberIdentity: { generation, workerId: "a", brokerIdentity: `command-set-${generation}` }, close: jest.fn() };
    const service = new CommandPublishQuiesceService(db as never, publisher as never, egress as never);
    await expect(service.begin()).rejects.toThrow("in-flight unknown");
    expect(await db.commandPublishMember.count({ where: { generation, quiesceAckAt: { not: null } } })).toBe(0);
    expect(egress.close).not.toHaveBeenCalled();
  });

  it("serializes simultaneous coordinators without advancing quiescing to fenced", async () => {
    const results = await Promise.all([
      new CommandPublishQuiesceService(db as never).begin(), new CommandPublishQuiesceService(peer as never).begin()
    ]);
    expect(results[0]).toEqual(results[1]);
    expect(results[0].allMembersAcknowledged).toBe(false);
    expect((await db.commandPublishEpoch.findUniqueOrThrow({ where: { generation } })).status).toBe("quiescing");
  });
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
