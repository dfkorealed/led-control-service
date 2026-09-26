import { CommandLegacyGetAckService } from "./command-legacy-get-ack.service";
import { CommandSafetyDigest } from "./command-safety-digest";

const key = Buffer.alloc(32, 0x71).toString("base64url");

describe("CommandLegacyGetAckService purged dispatch ownership", () => {
  afterEach(() => { delete process.env.COMMAND_LEGACY_GET_ACK_FENCE_ENABLED; });

  it("keeps default no-key legacy ACK behavior untouched while the fence flag is off", async () => {
    const prisma: any = { legacyStatusCheckDispatchFence: {
      count: jest.fn(), findFirst: jest.fn()
    } };
    const service = new CommandLegacyGetAckService(prisma, new CommandSafetyDigest());
    await expect(service.tryStoreDeviceStatusAck({ dispatchId: "old-get" })).resolves.toBe(false);
    expect(prisma.legacyStatusCheckDispatchFence.count).not.toHaveBeenCalled();
  });

  it("consumes owned duplicate or malformed ACKs but not a different dispatch", async () => {
    process.env.COMMAND_LEGACY_GET_ACK_FENCE_ENABLED = "1";
    const digest = new CommandSafetyDigest({ activeVersion: 1, keys: { 1: key } });
    const owned = digest.sign("legacy-status-check-dispatch", ["old-get"]);
    const prisma: any = { legacyStatusCheckDispatchFence: {
      count: jest.fn().mockResolvedValue(0),
      findFirst: jest.fn(async ({ where }: any) =>
        where.OR.some((row: any) => row.dispatchDigest === owned.value) ? { id: "fence" } : null)
    } };
    const service = new CommandLegacyGetAckService(prisma, digest);
    await expect(service.tryStoreAcceptanceAck({ dispatchId: "old-get" })).resolves.toBe(true);
    await expect(service.tryStoreDeviceStatusAck({ dispatchId: "old-get" })).resolves.toBe(true);
    await expect(service.tryStoreDeviceStatusAck({ dispatchId: "new-get" })).resolves.toBe(false);
  });

  it("fails closed if any retained dispatch fence needs an unavailable old key", async () => {
    process.env.COMMAND_LEGACY_GET_ACK_FENCE_ENABLED = "1";
    const prisma: any = { legacyStatusCheckDispatchFence: {
      count: jest.fn().mockResolvedValue(1), findFirst: jest.fn()
    } };
    const service = new CommandLegacyGetAckService(prisma,
      new CommandSafetyDigest({ activeVersion: 2, keys: { 2: key } }));
    await expect(service.tryStoreDeviceStatusAck({ dispatchId: "old-get" }))
      .rejects.toThrow("command safety HMAC key unavailable");
    expect(prisma.legacyStatusCheckDispatchFence.findFirst).not.toHaveBeenCalled();
  });
});
