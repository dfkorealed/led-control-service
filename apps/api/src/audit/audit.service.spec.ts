import { BadRequestException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "./audit.service";

describe("AuditService", () => {
  const prisma = { auditLog: { create: jest.fn().mockResolvedValue({ id: "audit-1" }) } };

  beforeEach(() => jest.clearAllMocks());

  async function createService() {
    const moduleRef = await Test.createTestingModule({
      providers: [AuditService, { provide: PrismaService, useValue: prisma }]
    }).compile();
    return moduleRef.get(AuditService);
  }

  it("records audit data through the supplied transaction client", async () => {
    const service = await createService();
    const transaction = { auditLog: { create: jest.fn().mockResolvedValue({ id: "audit-transaction-1" }) } };

    await expect(service.record({
      organizationId: "organization-1", siteId: "site-1", actorId: "user-1", action: "site.updated",
      targetType: "site", targetId: "site-1", outcome: "success", metadata: { source: "settings" }, transaction
    })).resolves.toEqual({ id: "audit-transaction-1" });
    expect(transaction.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: "site.updated", metadata: { source: "settings" } })
    });
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it.each(["claimCode", "password", "passwordHash", "currentPassword", "newPassword", "privateKey", "certificatePem"])("rejects %s in audit metadata", async (key) => {
    const service = await createService();

    await expect(service.record({
      action: "gateway.claimed", targetType: "gateway", outcome: "success", metadata: { [key]: "secret" }
    })).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it("rejects forbidden keys nested in metadata arrays", async () => {
    const service = await createService();

    await expect(service.record({
      action: "gateway.claimed", targetType: "gateway", outcome: "success", metadata: {
        attempts: [{ certificatePem: "secret" }]
      }
    })).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it("rejects forbidden keys nested in multiple metadata array levels", async () => {
    const service = await createService();

    await expect(service.record({
      action: "gateway.claimed", targetType: "gateway", outcome: "success", metadata: {
        attempts: [[{ privateKey: "secret" }]]
      }
    })).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it.each(["PASSWORD", "PasswordHash", "CURRENTpassword", "newPASSWORD", "PRIVATEkey", "CLAIMcode", "CertificatePEM"])(
    "rejects %s case-insensitively at any nesting depth",
    async (key) => {
      const service = await createService();

      await expect(service.record({
        action: "operator.site_admin_created", targetType: "User", outcome: "success", metadata: { outer: [{ inner: { [key]: "secret" } }] }
      })).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.auditLog.create).not.toHaveBeenCalled();
    }
  );
});
