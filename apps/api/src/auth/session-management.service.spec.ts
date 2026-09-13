import { NotFoundException, UnauthorizedException } from "@nestjs/common";
import { AuditService } from "../audit/audit.service";
import { PrismaService } from "../prisma/prisma.service";
import { SessionManagementService } from "./session-management.service";

const user = { id: "user-1", organizationId: "org-1" };

describe("SessionManagementService", () => {
  function fixture() {
    const now = new Date("2026-09-12T00:00:00Z");
    const expiresAt = new Date(Date.now() + 60_000);
    const rows = [{
      id: "session-current", tokenHash: "current-hash", rememberMe: false, ipAddress: "203.0.113.7",
      userAgent: "browser", familyId: "family-current", mfaVerifiedAt: now, createdAt: now, expiresAt
    }];
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([{ id: user.id }]),
      session: {
        findUnique: jest.fn().mockResolvedValue({ id: "session-current", userId: user.id, familyId: "family-current", revokedAt: null, expiresAt }),
        findFirst: jest.fn().mockResolvedValue(rows[0]),
        updateMany: jest.fn().mockResolvedValue({ count: 1 })
      },
      auditLog: { create: jest.fn() }
    };
    const prisma = {
      session: { findMany: jest.fn().mockResolvedValue(rows) },
      $transaction: jest.fn(async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx))
    };
    const audit = { record: jest.fn() };
    const service = new SessionManagementService(prisma as unknown as PrismaService, audit as unknown as AuditService);
    jest.spyOn(service, "hashToken").mockReturnValue("current-hash");
    return { service, prisma, tx, rows, audit };
  }

  it("lists only live owned sessions and marks the current token without exposing hashes", async () => {
    const { service, prisma } = fixture();
    const result = await service.list(user, "current-token");
    expect(prisma.session.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { userId: user.id, revokedAt: null, expiresAt: { gt: expect.any(Date) } }
    }));
    expect(result.sessions[0]).toEqual(expect.objectContaining({ id: "session-current", current: true, mfaVerified: true }));
    expect(result.sessions[0]).not.toHaveProperty("tokenHash");
  });

  it("revokes an owned session and reports when it is the current session", async () => {
    const { service, tx, audit } = fixture();
    await expect(service.revoke(user, "current-token", "session-current")).resolves.toEqual({ ok: true, currentSessionRevoked: true });
    expect(tx.session.findFirst).toHaveBeenCalledWith({
      where: { id: "session-current", userId: user.id },
      select: { id: true, tokenHash: true, familyId: true }
    });
    expect(tx.session.updateMany).toHaveBeenCalledWith({
      where: { userId: user.id, familyId: "family-current", revokedAt: null }, data: { revokedAt: expect.any(Date) }
    });
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: "auth.session_revoked", transaction: tx }));
  });

  it("does not reveal or revoke another user's session", async () => {
    const { service, tx } = fixture();
    tx.session.findFirst.mockResolvedValue(null);
    await expect(service.revoke(user, "current-token", "foreign-session")).rejects.toBeInstanceOf(NotFoundException);
    expect(tx.session.updateMany).not.toHaveBeenCalled();
  });

  it("rejects a session-management mutation when the guard-validated current token was revoked concurrently", async () => {
    const { service, tx } = fixture();
    tx.session.findUnique.mockResolvedValue({ userId: user.id, familyId: "family-current", revokedAt: new Date(), expiresAt: new Date(Date.now() + 60_000) });
    tx.session.findFirst.mockResolvedValue(null);
    await expect(service.revokeOthers(user, "current-token")).rejects.toBeInstanceOf(UnauthorizedException);
    expect(tx.session.updateMany).not.toHaveBeenCalled();
  });

  it("revokes every other live owned session while retaining the current token", async () => {
    const { service, tx, audit } = fixture();
    tx.session.updateMany.mockResolvedValue({ count: 3 });
    await expect(service.revokeOthers(user, "current-token")).resolves.toEqual({ ok: true, revokedSessionCount: 3 });
    expect(tx.session.updateMany).toHaveBeenCalledWith({
      where: { userId: user.id, revokedAt: null, familyId: { not: "family-current" } },
      data: { revokedAt: expect.any(Date) }
    });
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({
      action: "auth.other_sessions_revoked", metadata: { revokedSessionCount: 3 }, transaction: tx
    }));
    expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(tx.session.findUnique.mock.invocationCallOrder[0]);
  });

  it("follows a concurrently rotated current family for revocation-only operations", async () => {
    const { service, tx } = fixture();
    tx.session.findUnique.mockResolvedValue({
      id: "session-old", userId: user.id, familyId: "family-current", revokedAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000)
    });
    tx.session.findFirst
      .mockResolvedValueOnce({ id: "session-successor" })
      .mockResolvedValueOnce({ id: "session-old", tokenHash: "old-hash", familyId: "family-current" });

    await expect(service.revoke(user, "current-token", "session-old"))
      .resolves.toEqual({ ok: true, currentSessionRevoked: true });
    expect(tx.session.updateMany).toHaveBeenCalledWith({
      where: { userId: user.id, familyId: "family-current", revokedAt: null },
      data: { revokedAt: expect.any(Date) }
    });
  });
});
