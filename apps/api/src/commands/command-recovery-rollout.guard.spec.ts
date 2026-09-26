import { CommandRecoveryRolloutGuard } from "./command-recovery-rollout.guard";

describe("Command recovery compiled-route rollout gate", () => {
  afterEach(() => {
    delete process.env.COMMAND_HISTORY_RETENTION_ENABLED;
    delete process.env.COMMAND_RECOVERY_ACTIONS_ENABLED;
    delete process.env.COMMAND_RECOVERY_PUBLISHER_READY;
    delete process.env.COMMAND_RETENTION_PURGE_ENABLED;
  });

  it("refuses app startup when env flags alone would hide the legacy Get path without a registered recovery POST", () => {
    process.env.COMMAND_HISTORY_RETENTION_ENABLED = "1";
    process.env.COMMAND_RECOVERY_ACTIONS_ENABLED = "1";
    process.env.COMMAND_RECOVERY_PUBLISHER_READY = "1";
    expect(() => new CommandRecoveryRolloutGuard().onModuleInit()).toThrow("recovery POST route is not registered");
  });

  it("preserves the legacy app startup with all recovery actions OFF", () => {
    expect(() => new CommandRecoveryRolloutGuard().onModuleInit()).not.toThrow();
  });

  it("rejects physical purge env independently of the read and recovery flags", () => {
    process.env.COMMAND_RETENTION_PURGE_ENABLED = "1";
    expect(() => new CommandRecoveryRolloutGuard().onModuleInit())
      .toThrow("command physical purge is not certified");
  });
});
