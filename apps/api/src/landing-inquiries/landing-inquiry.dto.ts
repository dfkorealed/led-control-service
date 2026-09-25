import { BadRequestException } from "@nestjs/common";
import { z } from "zod";

export const LANDING_CONSENT_VERSION = "landing-2026-09-v1-90d";
const BODY_LIMIT_BYTES = 4096;

const inquirySchema = z.object({
  idempotencyKey: z.string().uuid(),
  companyName: z.string().trim().min(1).max(120),
  contactName: z.string().trim().min(1).max(80),
  email: z.string().trim().email().max(254),
  phone: z.string().trim().max(30).optional().default(""),
  audience: z.enum(["facility", "partner"]).optional().nullable().default(null),
  message: z.string().trim().min(1).max(2000),
  consent: z.literal(true),
  consentVersion: z.literal(LANDING_CONSENT_VERSION),
  website: z.literal("")
}).strict();

export type LandingInquiryInput = z.input<typeof inquirySchema>;
export type NormalizedLandingInquiry = z.output<typeof inquirySchema>;

export function parseLandingInquiry(input: unknown): NormalizedLandingInquiry {
  try {
    if (Buffer.byteLength(JSON.stringify(input), "utf8") > BODY_LIMIT_BYTES) throw new Error("body too large");
    const parsed = inquirySchema.safeParse(input);
    if (!parsed.success) throw new Error("invalid body");
    return parsed.data;
  } catch {
    throw new BadRequestException({ code: "LANDING_INQUIRY_INVALID", message: "문의 내용을 확인해 주세요." });
  }
}

// This explicit order is part of the idempotency contract; optional fields are normalized above.
export function canonicalInquiryPayload(input: NormalizedLandingInquiry) {
  return JSON.stringify({
    companyName: input.companyName, contactName: input.contactName, email: input.email,
    phone: input.phone, audience: input.audience, message: input.message,
    consent: input.consent, consentVersion: input.consentVersion, website: input.website
  });
}
