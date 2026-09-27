import { commandHistoryRetentionReady } from "./command-history-rollout";

const now = new Date("2026-05-31T12:00:00.000Z");

describe("Command history rollout gate", () => {
  afterEach(() => {
    delete process.env.COMMAND_HISTORY_RETENTION_ENABLED;
    delete process.env.COMMAND_RECOVERY_ACTIONS_ENABLED;
    delete process.env.COMMAND_RECOVERY_PUBLISHER_READY;
  });

  it("does not hide raw unknown on read flag alone before Get/ACK recovery is ready", async () => {
    process.env.COMMAND_HISTORY_RETENTION_ENABLED = "1";
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
});
