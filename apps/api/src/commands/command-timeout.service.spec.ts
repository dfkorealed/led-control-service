import { CommandTimeoutService } from "./command-timeout.service";

describe("CommandTimeoutService", () => {
  it("closes published and accepted dispatches after their production deadlines", async () => {
    const prisma: any = {
      commandDispatch: {
        findMany: jest.fn().mockResolvedValue([
          { id: "published-1", commandId: "command-1", status: "published" },
          { id: "accepted-1", commandId: "command-2", status: "accepted" }
        ]),
        updateMany: jest.fn().mockResolvedValue({ count: 1 })
      },
      commandFixtureResult: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      command: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      mqttOutbox: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) }
    };
    prisma.$transaction = jest.fn(async (callback: (tx: any) => Promise<unknown>) => callback(prisma));
    const service = new CommandTimeoutService(prisma);
    const now = new Date("2026-07-11T00:01:00.000Z");

    await expect(service.closeExpired(now)).resolves.toEqual({ timedOut: 2 });
    expect(prisma.commandFixtureResult.updateMany).toHaveBeenCalledTimes(2);
    expect(prisma.command.updateMany).toHaveBeenCalledTimes(2);
  });
});
