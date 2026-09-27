import { CommandDetailRetentionService } from "./command-detail-retention.service";
import { ConsoleLogger, Logger } from "@nestjs/common";
import { StructuredLoggerService } from "../observability/structured-logger.service";
import { RequestContext } from "../observability/request-context.middleware";

describe("command detail retention admission", () => {
  const original = process.env.COMMAND_DETAIL_REDACTION_ENABLED;
  afterEach(() => {
    if (original === undefined) delete process.env.COMMAND_DETAIL_REDACTION_ENABLED;
    else process.env.COMMAND_DETAIL_REDACTION_ENABLED = original;
  });
  it.each([undefined, "0", "true"])("does no database work when flag is %s", async flag => {
    if (flag === undefined) delete process.env.COMMAND_DETAIL_REDACTION_ENABLED;
    else process.env.COMMAND_DETAIL_REDACTION_ENABLED = flag;
    // Any DB access throws, including a read that could expose uninstalled schema.
    const db = new Proxy({}, { get() { throw new Error("database accessed while OFF"); } });
    const worker = new CommandDetailRetentionService(db as never);
    expect(await worker.runBatch()).toEqual({ examined: 0, redacted: 0, skippedByReason: {}, overdueCount: 0 });
    await worker.onModuleDestroy();
  });
  it.each([0, -1, 1.5, NaN, Infinity, 1001])("rejects unbounded/invalid budget %s before DB access", async budget => {
    process.env.COMMAND_DETAIL_REDACTION_ENABLED = "1";
    const worker = new CommandDetailRetentionService({} as never);
    await expect(worker.runBatch(budget)).rejects.toThrow("maxCandidates");
  });
  it("emits the failed batch through the real production logger without database errors", async () => {
    process.env.COMMAND_DETAIL_REDACTION_ENABLED = "1";
    const lines: string[] = [];
    Logger.overrideLogger(new StructuredLoggerService(new RequestContext(), line => lines.push(line), () => new Date()));
    const worker = new CommandDetailRetentionService({ $queryRaw: async () => {
      throw new Error("SELECT secret FROM private_database");
    } } as never);
    try {
      await expect(worker.runBatch()).rejects.toThrow("SELECT secret");
      expect(JSON.parse(lines[0])).toMatchObject({ level: "warn", context: "CommandDetailRetentionService",
        operation: "background_job", event: "command_detail_retention_batch", status: "failed",
        examined: 0, redacted: 0, skippedByReason: {}, overdueCount: 0 });
      expect(lines.join("")).not.toMatch(/secret|SELECT|private_database/);
    } finally { Logger.overrideLogger(new ConsoleLogger()); }
  });
});
