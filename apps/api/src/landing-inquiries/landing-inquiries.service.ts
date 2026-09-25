import { ConflictException, Injectable, ServiceUnavailableException } from "@nestjs/common";
import { createHash, randomBytes } from "node:crypto";
import { PrismaService } from "../prisma/prisma.service";
import { LandingInquiryRateLimitService } from "./landing-inquiry-rate-limit.service";
import { type LandingInquiryInput, canonicalInquiryPayload, parseLandingInquiry } from "./landing-inquiry.dto";
import { InjectLandingMailConnection, type LandingMailConnection } from "./landing-mail-connection";

const RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

@Injectable()
export class LandingInquiriesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly rateLimit: LandingInquiryRateLimitService,
    @InjectLandingMailConnection() private readonly mail: LandingMailConnection
  ) {}

  async submit(input: LandingInquiryInput, ip: string): Promise<{ reference: string; status: "received" }> {
    const normalized = parseLandingInquiry(input);
    const payloadHash = createHash("sha256").update(canonicalInquiryPayload(normalized)).digest("hex");
    let existing;
    try {
      existing = await this.prisma.landingInquiry.findUnique({ where: { idempotencyKey: normalized.idempotencyKey } });
    } catch {
      throw this.storageUnavailable();
    }
    if (existing) return this.existingResult(existing.payloadHash, payloadHash, existing.reference);

    let connected = false;
    try { connected = (await this.mail.getConnectionStatus()).connected; } catch { /* Fail closed without leaking provider details. */ }
    if (!connected) throw new ServiceUnavailableException({ code: "LANDING_MAIL_UNAVAILABLE", message: "온라인 상담 접수가 일시 중단되었습니다. 잠시 후 다시 시도해 주세요." });

    await this.rateLimit.consume(ip);
    const createdAt = new Date();
    const reference = `K-${createdAt.toISOString().slice(0, 10).replace(/-/g, "")}-${randomBytes(6).toString("hex").toUpperCase()}`;
    try {
      const row = await this.prisma.$transaction((tx) => tx.landingInquiry.create({ data: {
        idempotencyKey: normalized.idempotencyKey, payloadHash, reference,
        companyName: normalized.companyName, contactName: normalized.contactName,
        email: normalized.email, phone: normalized.phone, audience: normalized.audience,
        message: normalized.message, consentVersion: normalized.consentVersion,
        consentAt: createdAt, createdAt, expiresAt: new Date(createdAt.getTime() + RETENTION_MS),
        deliveryStatus: "queued", nextAttemptAt: createdAt
      } }));
      return { reference: row.reference, status: "received" };
    } catch (error) {
      // A concurrent identical POST can win the unique key after our initial lookup.
      if ((error as { code?: string })?.code === "P2002") {
        let winner;
        try {
          winner = await this.prisma.landingInquiry.findUnique({ where: { idempotencyKey: normalized.idempotencyKey } });
        } catch {
          throw this.storageUnavailable();
        }
        if (winner) return this.existingResult(winner.payloadHash, payloadHash, winner.reference);
      }
      throw this.storageUnavailable();
    }
  }

  private existingResult(storedHash: string, payloadHash: string, reference: string): { reference: string; status: "received" } {
    if (storedHash !== payloadHash) throw new ConflictException({ code: "LANDING_IDEMPOTENCY_CONFLICT", message: "이미 다른 내용으로 접수된 요청입니다." });
    return { reference, status: "received" };
  }

  private storageUnavailable() {
    return new ServiceUnavailableException({ code: "LANDING_STORAGE_UNAVAILABLE", message: "온라인 상담 접수가 일시 중단되었습니다. 잠시 후 다시 시도해 주세요." });
  }
}
