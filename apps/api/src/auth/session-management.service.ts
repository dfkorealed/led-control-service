import { Injectable, NotFoundException, UnauthorizedException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { createHash } from "node:crypto";
import { AuditService } from "../audit/audit.service";
import { PrismaService } from "../prisma/prisma.service";

interface SessionOwner {
  id: string;
  organizationId: string;
}

@Injectable()
export class SessionManagementService {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService) {}

  async list(user: SessionOwner, currentSessionToken: string) {
    const currentHash = this.hashToken(currentSessionToken);
    const sessions = await this.db().session.findMany({
      where: { userId: user.id, revokedAt: null, expiresAt: { gt: new Date() } },
      select: {
        id: true, tokenHash: true, rememberMe: true, userAgent: true, ipAddress: true,
        mfaVerifiedAt: true, createdAt: true, expiresAt: true
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }]
    });
    return {
      sessions: sessions.map(({ tokenHash, mfaVerifiedAt, ...session }: any) => ({
        ...session,
        current: tokenHash === currentHash,
        mfaVerified: Boolean(mfaVerifiedAt)
      }))
    };
  }

  async revoke(user: SessionOwner, currentSessionToken: string, sessionId: string) {
    return this.db().$transaction(async (tx: Prisma.TransactionClient) => {
      await this.lockUser(tx, user.id);
      const currentSession = await this.assertCurrentFamily(tx, user.id, currentSessionToken);
      const session = await tx.session.findFirst({
        where: { id: sessionId, userId: user.id },
        select: { id: true, tokenHash: true, familyId: true }
      });
      if (!session) throw new NotFoundException({ code: "SESSION_NOT_FOUND", message: "Session not found" });
      await tx.session.updateMany({
        where: { userId: user.id, familyId: session.familyId, revokedAt: null },
        data: { revokedAt: new Date() }
      });
      const currentSessionRevoked = session.familyId === currentSession.familyId;
      await this.audit.record({
        transaction: tx, organizationId: user.organizationId, actorId: user.id,
        action: "auth.session_revoked", targetType: "Session", targetId: session.id, outcome: "success",
        metadata: { currentSessionRevoked }
      });
      return { ok: true as const, currentSessionRevoked };
    });
  }

  async revokeOthers(user: SessionOwner, currentSessionToken: string) {
    return this.db().$transaction(async (tx: Prisma.TransactionClient) => {
      await this.lockUser(tx, user.id);
      const currentSession = await this.assertCurrentFamily(tx, user.id, currentSessionToken);
      const revoked = await tx.session.updateMany({
        where: { userId: user.id, revokedAt: null, familyId: { not: currentSession.familyId } },
        data: { revokedAt: new Date() }
      });
      await this.audit.record({
        transaction: tx, organizationId: user.organizationId, actorId: user.id,
        action: "auth.other_sessions_revoked", targetType: "User", targetId: user.id, outcome: "success",
        metadata: { revokedSessionCount: revoked.count }
      });
      return { ok: true as const, revokedSessionCount: revoked.count };
    });
  }

  hashToken(token: string) {
    return createHash("sha256").update(token).digest("hex");
  }

  private async lockUser(tx: Prisma.TransactionClient, userId: string) {
    const rows = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`SELECT "id" FROM "User" WHERE "id" = ${userId} FOR UPDATE`);
    if (rows.length === 0) throw new UnauthorizedException("Authentication required");
  }

  private async assertCurrentFamily(tx: Prisma.TransactionClient, userId: string, token: string) {
    const session = await tx.session.findUnique({
      where: { tokenHash: this.hashToken(token) },
      select: { id: true, userId: true, familyId: true, revokedAt: true, expiresAt: true }
    });
    if (!session || session.userId !== userId || session.expiresAt <= new Date()) {
      throw new UnauthorizedException("Authentication required");
    }
    if (!session.revokedAt) return session;
    const successor = await tx.session.findFirst({
      where: { userId, familyId: session.familyId, revokedAt: null, expiresAt: { gt: new Date() } },
      select: { id: true }
    });
    if (!successor) throw new UnauthorizedException("Authentication required");
    return session;
  }

  private db() {
    return this.prisma as any;
  }
}
