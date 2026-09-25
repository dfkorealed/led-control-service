import { BadRequestException, Controller, Get, Header, Query, UseGuards } from "@nestjs/common";
import { Roles } from "../access/roles.decorator";
import { RolesGuard } from "../access/roles.guard";
import { SessionAuthGuard } from "../auth/session-auth.guard";
import { PrismaService } from "../prisma/prisma.service";

function decodeCursor(value: unknown): { createdAt: Date; id: string } | undefined {
  if (value === undefined) return undefined;
  const invalid = () => new BadRequestException("조회 커서가 유효하지 않습니다.");
  if (typeof value !== "string" || value.length > 256 || !/^[A-Za-z0-9_-]+$/.test(value)) throw invalid();
  try {
    const decoded: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (!Array.isArray(decoded) || decoded.length !== 2) throw invalid();
    const [timestamp, id] = decoded;
    if (typeof timestamp !== "string" || typeof id !== "string" || !/^[a-f0-9-]{36}$/.test(id)) throw invalid();
    const createdAt = new Date(timestamp);
    if (!Number.isFinite(createdAt.getTime()) || createdAt.toISOString() !== timestamp) throw invalid();
    return { createdAt, id };
  } catch { throw invalid(); }
}

@UseGuards(SessionAuthGuard, RolesGuard)
@Roles("operator")
@Controller("operator/landing-inquiries")
export class OperatorLandingInquiriesController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  @Header("Cache-Control", "no-store")
  async list(@Query("limit") inputLimit?: string, @Query("cursor") inputCursor?: string) {
    const limit = inputLimit === undefined ? 20 : Number(inputLimit);
    if ((inputLimit !== undefined && (typeof inputLimit !== "string" || !/^\d+$/.test(inputLimit))) ||
      !Number.isInteger(limit) || limit < 1 || limit > 50) throw new BadRequestException("조회 개수는 1~50이어야 합니다.");
    const cursor = decodeCursor(inputCursor);
    const rows = await this.prisma.landingInquiry.findMany({
      where: { expiresAt: { gt: new Date() }, ...(cursor ? { OR: [
        { createdAt: { lt: cursor.createdAt } }, { createdAt: cursor.createdAt, id: { lt: cursor.id } }
      ] } : {}) },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: limit + 1,
      select: { id: true, reference: true, companyName: true, contactName: true, email: true, phone: true,
        audience: true, message: true, createdAt: true, expiresAt: true, deliveryStatus: true, attemptCount: true,
        lastErrorCode: true, providerAcceptedAt: true }
    });
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return { items: page.map(({ id: _id, ...item }) => item),
      nextCursor: rows.length > limit && last ? Buffer.from(JSON.stringify([last.createdAt.toISOString(), last.id])).toString("base64url") : null };
  }
}
