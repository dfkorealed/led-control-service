import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { assertSiteUserCapacity, runSiteUserTransaction, SITE_USER_LIMIT } from "./site-user-policy";

describe("shared site user admission policy", () => {
  it("waits for the advisory gate before letting the caller lock Site and count", async () => {
    let release!: () => void;
    const tx = { $executeRaw: jest.fn().mockImplementation(() => new Promise<void>((resolve) => { release = resolve; })) };
    const prisma = { $transaction: jest.fn((operation) => operation(tx)) };
    const operation = jest.fn().mockResolvedValue("admitted");
    const result = runSiteUserTransaction(prisma as unknown as PrismaService, operation);
    expect(operation).not.toHaveBeenCalled();
    release();
    await expect(result).resolves.toBe("admitted");
    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), expect.objectContaining({ isolationLevel: "Serializable" }));
  });

  it.each(["P2034", "40001", "40P01"])("restarts the entire transaction for %s and bounds attempts", async (code) => {
    const tx = { $executeRaw: jest.fn().mockResolvedValue(1) };
    const prisma = { $transaction: jest.fn((operation) => operation(tx)) };
    const operation = jest.fn().mockRejectedValue({ code });
    await expect(runSiteUserTransaction(prisma as unknown as PrismaService, operation))
      .rejects.toMatchObject({ response: { code: "SITE_USER_CHANGED" } });
    expect(operation).toHaveBeenCalledTimes(3);
    expect(tx.$executeRaw).toHaveBeenCalledTimes(3);
  });

  it("recounts after serialization failure, returning the limit error without retrying it", async () => {
    const tx = { $executeRaw: jest.fn().mockResolvedValue(1), user: { count: jest.fn().mockResolvedValueOnce(99).mockResolvedValue(100) } };
    const prisma = { $transaction: jest.fn((operation) => operation(tx)) };
    const operation = async (client: Prisma.TransactionClient) => {
      await assertSiteUserCapacity(client, "site", "org");
      throw { code: "P2034" };
    };
    await expect(runSiteUserTransaction(prisma as unknown as PrismaService, operation))
      .rejects.toMatchObject({ response: { code: "USER_LIMIT_REACHED" } });
    expect(tx.user.count).toHaveBeenCalledTimes(2);
    expect(SITE_USER_LIMIT).toBe(100);
    expect(tx.user.count.mock.calls[0][0].where.status).toBeUndefined();
  });
});
