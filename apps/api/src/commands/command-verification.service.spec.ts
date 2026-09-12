import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { AuthenticatedUser } from "../auth/auth.types";
import { CommandVerificationService } from "./command-verification.service";

const ids = {
  command: "11111111-1111-4111-8111-111111111111",
  site: "22222222-2222-4222-8222-222222222222",
  fixture: "33333333-3333-4333-8333-333333333333",
  gateway: "44444444-4444-4444-8444-444444444444",
  dispatch: "55555555-5555-4555-8555-555555555555",
  request: "66666666-6666-4666-8666-666666666666"
};
const user = { id: "viewer", role: "viewer" } as AuthenticatedUser;
const now = new Date("2026-09-12T00:00:00.000Z");
const input = { clientRequestId: ids.request };

function harness() {
  const command: any = {
    id: ids.command, siteId: ids.site, outcome: "unknown", brightness: 75,
    targetFixtureIds: [ids.fixture],
    dispatches: [{ id: "original-dispatch", commandId: ids.command, gatewayId: ids.gateway,
      kind: "dimming", status: "timed_out", verificationAttempt: null, clientRequestId: null }]
  };
  const tx: any = {
    $queryRaw: jest.fn().mockResolvedValue([{ id: ids.command }]),
    command: { findUnique: jest.fn().mockImplementation(async () => command) },
    commandDispatch: {
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockImplementation(async ({ data }) => ({ id: ids.dispatch, ...data }))
    },
    gateway: { update: jest.fn().mockResolvedValue({ id: ids.gateway, siteId: ids.site, nextCommandSequence: 9n }) },
    commandFixtureResult: { createMany: jest.fn().mockResolvedValue({ count: 1 }) },
    mqttOutbox: { create: jest.fn().mockResolvedValue({ id: "outbox" }) }
  };
  const prisma: any = {
    command: { findUnique: jest.fn().mockResolvedValue({ siteId: ids.site }) },
    $transaction: jest.fn(async (callback) => callback(tx))
  };
  const access = {
    assert: jest.fn().mockResolvedValue({ id: ids.site }),
    assertControlInTransaction: jest.fn().mockResolvedValue({ id: ids.site })
  };
  const automation = { lockMutation: jest.fn().mockResolvedValue(undefined) };
  const service = new CommandVerificationService(prisma, access as never, automation as never, { now: () => now });
  return { command, tx, prisma, access, automation, service };
}

describe("CommandVerificationService", () => {
  it("creates the Get dispatch, pending results and outbox atomically after locked authorization", async () => {
    const { service, tx, prisma, automation, access } = harness();
    const response = await service.requestStatusCheck(user, ids.command, input);
    expect(response).toEqual({
      dispatchId: expect.any(String), dispatchIds: [expect.any(String)], verificationAttempt: 1, terminalStatusUrl: `/commands/${ids.command}`
    });
    expect(access.assert).toHaveBeenCalledWith(user, ids.site, "control");
    expect(access.assertControlInTransaction).toHaveBeenCalledWith(tx, user, ids.site);
    expect(automation.lockMutation).toHaveBeenCalledWith(tx);
    expect(automation.lockMutation.mock.invocationCallOrder[0]).toBeLessThan(access.assertControlInTransaction.mock.invocationCallOrder[0]);
    expect(tx.$queryRaw).toHaveBeenCalledTimes(2);
    expect(tx.$queryRaw.mock.calls[0][0].text).toMatch(/FROM "CommandDispatch"[\s\S]*FOR UPDATE/);
    expect(tx.$queryRaw.mock.calls[1][0].text).toMatch(/FROM "Command"[\s\S]*FOR UPDATE/);
    expect(access.assertControlInTransaction.mock.invocationCallOrder[0]).toBeLessThan(tx.$queryRaw.mock.invocationCallOrder[0]);
    expect(tx.$queryRaw.mock.invocationCallOrder[1]).toBeLessThan(tx.command.findUnique.mock.invocationCallOrder[0]);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.gateway.update).toHaveBeenCalledWith({
      where: { id: ids.gateway }, data: { nextCommandSequence: { increment: 1 } },
      select: { id: true, siteId: true, nextCommandSequence: true }
    });
    expect(tx.commandDispatch.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      commandId: ids.command, gatewayId: ids.gateway, kind: "status_check", verificationAttempt: 1,
      clientRequestId: ids.request, sequence: 9, deliveryMode: "unicast"
    }) });
    expect(tx.commandFixtureResult.createMany).toHaveBeenCalledWith({
      data: [{ dispatchId: response.dispatchId, fixtureId: ids.fixture }]
    });
    expect(tx.mqttOutbox.create).toHaveBeenCalledWith({ data: {
      dispatchId: response.dispatchId,
      topic: `sites/${ids.site}/gateways/${ids.gateway}/commands/status-check`,
      payload: {
        commandId: ids.command, originalCommandId: ids.command, dispatchId: response.dispatchId,
        idempotencyKey: expect.any(String), sequence: 9, siteId: ids.site, gatewayId: ids.gateway,
        targetFixtureIds: [ids.fixture], expectedBrightness: 75, verificationAttempt: 1, requestedAt: now.toISOString()
      }
    } });
  });

  it.each(["absent", "outside_scope", "read_only", "revoked_in_transaction"])("rejects %s without creating a dispatch", async (scenario) => {
    const { service, prisma, tx, access } = harness();
    if (scenario === "absent") prisma.command.findUnique.mockResolvedValue(null);
    if (scenario === "outside_scope") access.assert.mockRejectedValue(new NotFoundException("site not found"));
    if (scenario === "read_only") access.assert.mockRejectedValue(new ForbiddenException("site capability denied"));
    if (scenario === "revoked_in_transaction") access.assertControlInTransaction.mockRejectedValue(new NotFoundException("site not found"));
    const pending = service.requestStatusCheck(user, ids.command, input);
    if (scenario === "read_only") await expect(pending).rejects.toBeInstanceOf(ForbiddenException);
    else await expect(pending).rejects.toMatchObject({ message: "command not found" });
    expect(tx.commandDispatch.create).not.toHaveBeenCalled();
  });

  it.each([null, "pending", "applied", "not_applied", "partially_applied"])("rejects outcome %s", async (outcome) => {
    const { service, command, tx } = harness();
    command.outcome = outcome;
    await expect(service.requestStatusCheck(user, ids.command, input)).rejects.toMatchObject({ status: 409 });
    expect(tx.commandDispatch.create).not.toHaveBeenCalled();
  });

  it("returns the same request after terminal convergence without creating another Get", async () => {
    const { service, command, tx } = harness();
    command.outcome = "applied";
    const previous = { id: ids.dispatch, commandId: ids.command, kind: "status_check", verificationAttempt: 2 };
    command.dispatches.push(previous);
    tx.commandDispatch.findUnique.mockResolvedValue(previous);
    await expect(service.requestStatusCheck(user, ids.command, input)).resolves.toEqual({
      dispatchId: ids.dispatch, dispatchIds: [ids.dispatch], verificationAttempt: 2, terminalStatusUrl: `/commands/${ids.command}`
    });
    expect(tx.commandDispatch.create).not.toHaveBeenCalled();
    expect(tx.gateway.update).not.toHaveBeenCalled();
  });

  it("rejects a global request ID belonging to a different command without exposing that command", async () => {
    const { service, tx } = harness();
    tx.commandDispatch.findUnique.mockResolvedValue({ id: "secret-dispatch", commandId: "secret-command", kind: "status_check" });
    await expect(service.requestStatusCheck(user, ids.command, input)).rejects.toMatchObject({
      response: { code: "client_request_id_payload_conflict" }, status: 409
    });
    expect(tx.commandDispatch.create).not.toHaveBeenCalled();
  });

  it.each(["pending", "published", "accepted"])("blocks another check while the previous check is %s", async (status) => {
    const { service, command, tx } = harness();
    command.dispatches.push({ kind: "status_check", verificationAttempt: 1, status });
    await expect(service.requestStatusCheck(user, ids.command, input)).rejects.toMatchObject({
      response: { code: "status_check_in_progress" }, status: 409
    });
    expect(tx.commandDispatch.create).not.toHaveBeenCalled();
  });

  it.each([1, 2, 3])("allocates attempt %s after prior checks finish", async (attempt) => {
    const { service, command } = harness();
    for (let previous = 1; previous < attempt; previous++) {
      command.dispatches.push({ kind: "status_check", verificationAttempt: previous, status: "timed_out" });
    }
    await expect(service.requestStatusCheck(user, ids.command, input)).resolves.toMatchObject({ verificationAttempt: attempt });
  });

  it("refuses a fourth check", async () => {
    const { service, command, tx } = harness();
    for (let attempt = 1; attempt <= 3; attempt++) {
      command.dispatches.push({ kind: "status_check", verificationAttempt: attempt, status: "timed_out" });
    }
    await expect(service.requestStatusCheck(user, ids.command, input)).rejects.toMatchObject({
      response: { code: "status_check_attempts_exhausted" }, status: 409
    });
    expect(tx.commandDispatch.create).not.toHaveBeenCalled();
  });

  it("propagates outbox failure from the owning transaction", async () => {
    const { service, tx, prisma } = harness();
    const failure = new Error("outbox insert failed");
    tx.mqttOutbox.create.mockRejectedValue(failure);
    await expect(service.requestStatusCheck(user, ids.command, input)).rejects.toBe(failure);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it("checks all 65 fixtures using two dispatches in the same logical attempt and transaction", async () => {
    const { service, command, tx } = harness();
    const fixtures = Array.from({ length: 65 }, (_, index) => `33333333-3333-4333-8333-${String(index).padStart(12, "0")}`);
    command.targetFixtureIds = [...fixtures].reverse();
    tx.gateway.update.mockResolvedValueOnce({ id: ids.gateway, siteId: ids.site, nextCommandSequence: 9n })
      .mockResolvedValueOnce({ id: ids.gateway, siteId: ids.site, nextCommandSequence: 10n });
    const response = await service.requestStatusCheck(user, ids.command, input);
    expect(response).toMatchObject({ verificationAttempt: 1, dispatchIds: [expect.any(String), expect.any(String)] });
    const writes = tx.commandDispatch.create.mock.calls.map(([{ data }]: any) => data);
    expect(writes.map((data: any) => data.verificationAttempt)).toEqual([1, 1]);
    expect(writes.map((data: any) => data.clientRequestId)).toEqual([ids.request, null]);
    expect(writes.map((data: any) => data.sequence)).toEqual([9, 10]);
    const payloads = tx.mqttOutbox.create.mock.calls.map(([{ data }]: any) => data.payload);
    expect(payloads.map((payload: any) => payload.targetFixtureIds.length)).toEqual([64, 1]);
    expect(payloads.flatMap((payload: any) => payload.targetFixtureIds)).toEqual(fixtures);
    expect(tx.commandFixtureResult.createMany.mock.calls.map(([{ data }]: any) => data.length)).toEqual([64, 1]);
  });

  it("replays all chunks of the anchored attempt even after its outcome converged", async () => {
    const { service, command, tx } = harness();
    const anchor = { id: ids.dispatch, commandId: ids.command, kind: "status_check", verificationAttempt: 1 };
    command.outcome = "applied";
    command.dispatches.push(anchor, { ...anchor, id: "chunk-2" });
    tx.commandDispatch.findUnique.mockResolvedValue(anchor);
    await expect(service.requestStatusCheck(user, ids.command, input)).resolves.toMatchObject({
      dispatchId: ids.dispatch, dispatchIds: [ids.dispatch, "chunk-2"], verificationAttempt: 1
    });
    expect(tx.commandDispatch.create).not.toHaveBeenCalled();
  });

  it("counts verification attempts instead of counting their chunks", async () => {
    const { service, command } = harness();
    command.dispatches.push(
      { kind: "status_check", verificationAttempt: 1, status: "timed_out" },
      { kind: "status_check", verificationAttempt: 1, status: "succeeded" },
      { kind: "status_check", verificationAttempt: 1, status: "timed_out" }
    );
    await expect(service.requestStatusCheck(user, ids.command, input)).resolves.toMatchObject({ verificationAttempt: 2 });
  });
});
