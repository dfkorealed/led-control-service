import type { Prisma } from "@prisma/client";
import { CommandDbClockHealth, type CommandDbClockEvidence } from "./command-db-clock-health.service";

const dbNow = new Date("2026-09-26T12:00:00.000Z");
const primaryStartedAt = new Date("2026-09-25T01:00:00.000Z");
const observedPrimary = { startedAt: primaryStartedAt, address: "127.0.0.1", port: 5432 };
const healthy: CommandDbClockEvidence = {
  issuedAt: new Date("2026-09-26T11:59:59.500Z"),
  offsetMs: 50,
  stepGeneration: 2,
  clearedStepGeneration: 2,
  failoverGeneration: 3,
  clearedFailoverGeneration: 3,
  primary: observedPrimary
};

function transaction(row = { dbNow, isReplica: false, primaryStartedAt, serverAddress: "127.0.0.1", serverPort: 5432 }) {
  return { $queryRaw: jest.fn().mockResolvedValue([row]) } as unknown as Prisma.TransactionClient;
}

describe("CommandDbClockHealth", () => {
  it("denies without an attestation source in the production default", async () => {
    await expect(new CommandDbClockHealth().assertHealthy(transaction())).rejects.toThrow();
  });

  it.each([
    ["missing evidence", null],
    ["stale evidence", { ...healthy, issuedAt: new Date("2026-09-26T11:59:58.999Z") }],
    ["future evidence", { ...healthy, issuedAt: new Date("2026-09-26T12:00:00.101Z") }],
    ["large positive offset", { ...healthy, offsetMs: 101 }],
    ["large negative offset", { ...healthy, offsetMs: -101 }],
    ["uncleared clock step", { ...healthy, stepGeneration: 3 }],
    ["uncleared primary switch", { ...healthy, failoverGeneration: 4 }],
    ["other primary", { ...healthy, primary: { ...observedPrimary, startedAt: new Date("2026-09-25T02:00:00.000Z") } }]
  ])("denies %s", async (_name, evidence) => {
    await expect(new CommandDbClockHealth({ read: async () => evidence }).assertHealthy(transaction())).rejects.toThrow();
  });

  it("denies a standby even with matching evidence", async () => {
    const tx = transaction({ dbNow, isReplica: true, primaryStartedAt, serverAddress: "127.0.0.1", serverPort: 5432 });
    await expect(new CommandDbClockHealth({ read: async () => healthy }).assertHealthy(tx)).rejects.toThrow();
  });

  it("checks evidence age at the DB observation after the evidence read", async () => {
    let observedAt = dbNow;
    const tx = { $queryRaw: jest.fn(async () => [{
      dbNow: observedAt, isReplica: false, primaryStartedAt, serverAddress: "127.0.0.1", serverPort: 5432
    }]) } as unknown as Prisma.TransactionClient;
    const source = { read: async () => {
      observedAt = new Date("2026-09-26T12:00:02.000Z");
      return healthy;
    } };
    await expect(new CommandDbClockHealth(source).assertHealthy(tx)).rejects.toThrow();
  });

  it("accepts attested current primary evidence at the 100ms offset boundary", async () => {
    await expect(new CommandDbClockHealth({ read: async () => ({ ...healthy, offsetMs: -100 }) })
      .assertHealthy(transaction())).resolves.toEqual(dbNow);
  });
});
