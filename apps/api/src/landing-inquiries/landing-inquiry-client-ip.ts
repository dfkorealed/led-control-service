import { ServiceUnavailableException } from "@nestjs/common";
import { trustedWebClientIp, type WebIngressRequest } from "../http/web-ingress-client-ip";

export function landingInquiryClientIp(request: WebIngressRequest): string {
  if (process.env.NODE_ENV !== "production") return request.ip || "unknown";
  // The public device TCP listener reaches this API without HTTP header rewriting.
  // Global trust-proxy would trust forged XFF there. Only Web's authenticated,
  // overwritten headers identify a visitor for this public intake route.
  const ip = trustedWebClientIp(request);
  if (!ip) {
    throw new ServiceUnavailableException({ code: "LANDING_INGRESS_UNAVAILABLE", message: "온라인 상담 접수가 일시 중단되었습니다. 잠시 후 다시 시도해 주세요." });
  }
  return ip;
}
