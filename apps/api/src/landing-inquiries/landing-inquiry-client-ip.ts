import { ServiceUnavailableException } from "@nestjs/common";
import { timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";

type InquiryRequest = { ip?: string; headers?: Record<string, string | string[] | undefined> };

export function landingInquiryClientIp(request: InquiryRequest): string {
  if (process.env.NODE_ENV !== "production") return request.ip || "unknown";
  const secret = process.env.LANDING_INGRESS_SECRET;
  const provided = request.headers?.["x-landing-ingress-secret"];
  const ip = request.headers?.["x-landing-client-ip"];
  // The public device TCP listener reaches this API without HTTP header rewriting.
  // Global trust-proxy would trust forged XFF there. Only Web's authenticated,
  // overwritten headers identify a visitor for this public intake route.
  if (!secret || !/^[a-f0-9]{64}$/.test(secret) || typeof provided !== "string" ||
      !/^[a-f0-9]{64}$/.test(provided) || !timingSafeEqual(Buffer.from(secret, "hex"), Buffer.from(provided, "hex")) ||
      typeof ip !== "string" || isIP(ip) === 0) {
    throw new ServiceUnavailableException({ code: "LANDING_INGRESS_UNAVAILABLE", message: "온라인 상담 접수가 일시 중단되었습니다. 잠시 후 다시 시도해 주세요." });
  }
  return ip;
}
