import { commandHistoryGetDbClockRequested, commandHistoryGetReadBoundary, commandHistoryRetentionReady,
  inspectCommandHistoryReadiness } from "./command-history-rollout";

const now = new Date("2026-05-31T12:00:00.000Z");

describe("Command history rollout gate", () => {
  afterEach(() => {
    delete process.env.COMMAND_HISTORY_RETENTION_ENABLED;
    delete process.env.COMMAND_RECOVERY_ACTIONS_ENABLED;
    delete process.env.COMMAND_RECOVERY_PUBLISHER_READY;
  });

  it("does not hide raw unknown on read flag alone before Get/ACK recovery is ready", async () => {
    process.env.COMMAND_HISTORY_RETENTION_ENABLED = "1";
    expect(commandHistoryGetDbClockRequested()).toBe(true);
    const db = { $queryRaw: jest.fn() };
    await expect(commandHistoryRetentionReady(db as never, "site-1", now)).resolves.toBe(false);
    expect(db.$queryRaw).not.toHaveBeenCalled();
  });

  it("falls back to legacy recovery at the 1ms cutoff crossing until an uncertain case exists", async () => {
    process.env.COMMAND_HISTORY_RETENTION_ENABLED = "1";
    process.env.COMMAND_RECOVERY_ACTIONS_ENABLED = "1";
    process.env.COMMAND_RECOVERY_PUBLISHER_READY = "1";
    const db = { $queryRaw: jest.fn().mockResolvedValueOnce([{ id: "old-unheld-unknown" }]).mockResolvedValueOnce([]) };
    await expect(commandHistoryRetentionReady(db as never, "site-1", now)).resolves.toBe(false);
    await expect(commandHistoryRetentionReady(db as never, "site-1", now)).resolves.toBe(true);
    expect(db.$queryRaw.mock.calls[0][0].values).toEqual(["site-1", new Date("2026-02-28T12:00:00.000Z")]);
    expect(db.$queryRaw.mock.calls[0][0].strings.join(" ")).toContain('command."createdAt" <');
  });

  it("fails closed on a missing DB clock and returns an independent UTC read boundary", async () => {
    process.env.COMMAND_HISTORY_RETENTION_ENABLED = "1";
    const db = { $queryRaw: jest.fn().mockResolvedValueOnce([]) };
    await expect(commandHistoryGetReadBoundary(db as never, "site-1")).rejects.toThrow("DB clock unavailable");
    expect(db.$queryRaw).toHaveBeenCalledTimes(1);
    const clock = { generatedAt: now, retainedFrom: new Date("2026-02-28T12:00:00.000Z") };
    db.$queryRaw.mockResolvedValueOnce([clock]);
    await expect(commandHistoryGetReadBoundary(db as never, "site-1")).resolves.toMatchObject({
      ...clock, retentionEnabled: true
    });
    expect(db.$queryRaw).toHaveBeenCalledTimes(2);
    expect(db.$queryRaw.mock.calls[1][0].strings.join(" ")).toContain("transaction_timestamp()");
  });

  it("reports zero unheld old pending/unknown rows and permits read activation", async () => {
    const clock = { generatedAt: now, retainedFrom: new Date("2026-02-28T12:00:00.000Z") };
    const db = { $queryRaw: jest.fn().mockResolvedValue([{ ...clock, unheldCount: 0n, sampleIds: [] }]) };
    await expect(inspectCommandHistoryReadiness(db as never)).resolves.toEqual({ ...clock, unheldCount: 0, sampleIds: [] });
    const sql = db.$queryRaw.mock.calls[0][0].strings.join(" ");
    expect(sql).toContain('command."createdAt" < boundary."retainedFrom"');
    expect(sql).toContain("transaction_timestamp() AT TIME ZONE 'UTC'");
    expect(sql).toContain("'pending', 'unknown'");
  });

  it("fails closed and exposes only opaque IDs when an old unheld command exists or the DB fails", async () => {
    const db = { $queryRaw: jest.fn().mockResolvedValueOnce([{ generatedAt: now,
      retainedFrom: new Date("2026-02-28T12:00:00.000Z"), unheldCount: 1n, sampleIds: ["opaque-id"] }])
      .mockRejectedValueOnce(new Error("db unavailable")) };
    await expect(inspectCommandHistoryReadiness(db as never)).rejects.toThrow("unheld old commands: 1");
    await expect(inspectCommandHistoryReadiness(db as never)).rejects.toThrow("db unavailable");
  });
});
