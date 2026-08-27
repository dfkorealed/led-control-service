import { BadRequestException, Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";

const forbiddenMetadataKeys = new Set([
  "password",
  "passwordhash",
  "currentpassword",
  "newpassword",
  "privatekey",
  "claimcode",
  "certificatepem"
]);

type AuditTransaction = {
  auditLog: Pick<Prisma.TransactionClient["auditLog"], "create">;
};

export interface AuditRecordInput {
  organizationId?: string;
  siteId?: string;
  actorId?: string;
  action: string;
  targetType: string;
  targetId?: string;
  outcome: string;
  metadata?: Record<string, unknown>;
  ipAddress?: string;
  userAgent?: string;
  transaction?: AuditTransaction;
}

@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  async record({ transaction, metadata, ...input }: AuditRecordInput) {
    this.assertSafeMetadata(metadata);
    const client = transaction ?? this.prisma;

    return client.auditLog.create({
      data: {
        ...input,
        metadata: metadata as Prisma.InputJsonValue | undefined
      }
    });
  }

  private assertSafeMetadata(metadata: Record<string, unknown> | undefined) {
    if (!metadata) return;

    for (const [key, value] of Object.entries(metadata)) {
      if (forbiddenMetadataKeys.has(key.toLowerCase())) {
        throw new BadRequestException(`audit metadata must not include ${key}`);
      }
      this.assertSafeMetadataValue(value);
    }
  }

  private assertSafeMetadataValue(value: unknown) {
    if (Array.isArray(value)) {
      for (const item of value) this.assertSafeMetadataValue(item);
      return;
    }
    if (value && typeof value === "object") this.assertSafeMetadata(value as Record<string, unknown>);
  }
}
