import { CommandsService } from "./commands.service";
import { CommandVerificationService } from "./command-verification.service";
import { CommandStatusService } from "./command-status.service";
import { CommandPurgeCandidateBlocked, stageExpiredCommandCandidate } from "./command-purge-staging";

const user = { id: "user" } as never;
const input = { siteId: "site", clientRequestId: "key", target: { type: "fixture", fixtureId: "fixture" }, brightness: 50 } as const;
const access = { assert: jest.fn(), assertControlInTransaction: jest.fn() };
const automation = { lockMutation: jest.fn() };

function harness() {
  const command = { id: "command", siteId: "site", createdAt: new Date("2026-09-01"),
    updatedAt: new Date("2026-09-01"), contentRedactedAt: new Date("2026-09-02"),
    targetType: null, targetId: null, targetFixtureIds: null, brightness: null, requestFingerprint: null,
    requestedBy: "user", clientRequestId: "key", dispatches: [], manualOverride: null };
  const tx = { $queryRaw: jest.fn().mockResolvedValue([]),
    command: { findUnique: jest.fn().mockResolvedValue(command), create: jest.fn() },
    commandDispatch: { findUnique: jest.fn(), create: jest.fn() },
    mqttOutbox: { create: jest.fn() } };
  const db = { ...tx, $transaction: jest.fn(async (fn) => fn(tx)) };
  return { command, tx, db };
}

describe("Command content redaction consumers", () => {
  afterEach(() => { delete process.env.COMMAND_HISTORY_RETENTION_ENABLED; });
  it("blocks legacy purge staging before replay or hold writes for redacted content", async () => {
    const tx = { $executeRaw: jest.fn(), $queryRaw: jest.fn().mockResolvedValue([{ id: "command" }]),
      command: { findUniqueOrThrow: jest.fn().mockResolvedValue({ contentRedactedAt: new Date(), brightness: null }) } };
    await expect(stageExpiredCommandCandidate(tx as never, "command", new Date(), {} as never))
      .rejects.toBeInstanceOf(CommandPurgeCandidateBlocked);
  });
  it("rejects a redacted Set replay before payload comparison or dispatch creation", async () => {
    const { db, tx } = harness();
    // The shared checkout also has an uncommitted optional HMAC constructor dependency.
    const service = Reflect.construct(CommandsService, [db, {}, access, {}, automation, {}, {}]) as CommandsService;
    await expect(service.createDimmingCommand(user, input)).rejects.toMatchObject({ status: 409,
      response: { code: "command_request_expired" } });
    expect(tx.command.create).not.toHaveBeenCalled();
    expect(tx.mqttOutbox.create).not.toHaveBeenCalled();
  });
  it("rejects a redacted status check before Get idempotency lookup", async () => {
    const { db, tx } = harness();
    const service = new CommandVerificationService(db as never, access as never, automation as never,
      { now: () => new Date("1900-01-01") });
    await expect(service.requestStatusCheck(user, "command", { clientRequestId: "key" }))
      .rejects.toMatchObject({ status: 410, response: { code: "command_expired" } });
    expect(tx.commandDispatch.findUnique).not.toHaveBeenCalled();
    expect(tx.mqttOutbox.create).not.toHaveBeenCalled();
  });
  it("returns content-free expiry for an authorized redacted detail with rollout disabled", async () => {
    const { db } = harness();
    const service = new CommandStatusService(db as never, access as never);
    await expect(service.getCommand(user, "command")).rejects.toMatchObject({ status: 410,
      response: { code: "command_expired" } });
  });
  it("uses transaction DB cutoff for old Get with only the read flag enabled", async () => {
    process.env.COMMAND_HISTORY_RETENTION_ENABLED = "1";
    const { db, tx, command } = harness();
    Object.assign(command, { contentRedactedAt: null, createdAt: new Date("2026-05-31T23:59:59.999Z") });
    tx.$queryRaw.mockResolvedValue([{ generatedAt: new Date("2026-09-01"), retainedFrom: new Date("2026-06-01") }]);
    const service = new CommandVerificationService(db as never, access as never, automation as never,
      { now: () => new Date("1900-01-01") });
    await expect(service.requestStatusCheck(user, "command", { clientRequestId: "key" }))
      .rejects.toMatchObject({ status: 410, response: { code: "command_expired" } });
    expect(tx.mqttOutbox.create).not.toHaveBeenCalled();
  });
});
