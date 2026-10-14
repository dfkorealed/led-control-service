describe("temporary terminal detail retention", () => {
  const old = process.env.COMMAND_DETAIL_REDACTION_ENABLED;
  afterEach(() => { if (old === undefined) delete process.env.COMMAND_DETAIL_REDACTION_ENABLED; else process.env.COMMAND_DETAIL_REDACTION_ENABLED = old; });
  it("uses the existing OFF policy without accessing storage", async () => {
    process.env.COMMAND_DETAIL_REDACTION_ENABLED = "0";
    const { TemporaryControlRetention } = require("./temporary-control-retention");
    expect(await new TemporaryControlRetention({}).runBatch()).toBe(0);
  });
  it("rejects unbounded batch sizes before querying storage", async () => {
    process.env.COMMAND_DETAIL_REDACTION_ENABLED = "1";
    const { TemporaryControlRetention } = require("./temporary-control-retention");
    await expect(new TemporaryControlRetention({}).runBatch(1001)).rejects.toThrow("batch limit");
  });
});
