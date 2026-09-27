import { CommandSafetyDigest } from "./command-safety-digest";
import { runDisposableProtectedCommandRetentionBatch } from "./command-retention-worker";
import { runDisposableRetentionCli } from "./command-retention-worker.cli";

const digest = new CommandSafetyDigest({ activeVersion: 1,
  keys: { 1: Buffer.alloc(32, 0x74).toString("base64url") } });

describe("protected Command retention worker hard gate", () => {
  afterEach(() => {
    delete process.env.COMMAND_RETENTION_TEST;
    delete process.env.COMMAND_RUNTIME_DB_ROLE;
  });

  it("rejects production and a malformed batch without touching any database", async () => {
    const prisma: any = { $queryRaw: jest.fn(), $transaction: jest.fn() };
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      await expect(runDisposableProtectedCommandRetentionBatch(prisma, digest,
        { maxCandidates: 1, disposableToken: "11111111-1111-4111-8111-111111111111" }))
        .rejects.toThrow("disposable protected retention only");
    } finally {
      process.env.NODE_ENV = previous;
    }
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
    process.env.COMMAND_RETENTION_TEST = "1";
    process.env.COMMAND_RUNTIME_DB_ROLE = "runtime_test";
    await expect(runDisposableProtectedCommandRetentionBatch(prisma, digest,
      { maxCandidates: 26, disposableToken: "11111111-1111-4111-8111-111111111111" }))
      .rejects.toThrow("invalid retention batch limit");
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it("rejects a production CLI invocation before reading a database credential", async () => {
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    process.env.COMMAND_PURGE_WORKER_DATABASE_URL = "invalid-secret-url";
    process.env.COMMAND_RETENTION_TEST = "1";
    try {
      await expect(runDisposableRetentionCli()).rejects.toThrow("disposable protected retention only");
    } finally {
      process.env.NODE_ENV = previous;
      delete process.env.COMMAND_PURGE_WORKER_DATABASE_URL;
    }
  });
});
