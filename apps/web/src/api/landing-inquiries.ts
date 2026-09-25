import { apiGet, apiPost } from "./client";

export interface LandingInquiryInput {
  idempotencyKey: string;
  companyName: string;
  contactName: string;
  email: string;
  phone: string;
  audience: "facility" | "partner" | null;
  message: string;
  consent: true;
  consentVersion: "landing-2026-09-v1-90d";
  website: "";
}

export function submitLandingInquiry(input: LandingInquiryInput, signal?: AbortSignal): Promise<{ reference: string; status: "received" }> {
  return apiPost("/landing/inquiries", input, { signal, timeoutMs: 15_000 });
}

export type LandingDeliveryStatus = "queued" | "retry_wait" | "provider_accepted" | "delivery_uncertain" | "failed";

export interface OperatorLandingInquiry {
  reference: string;
  companyName: string;
  contactName: string;
  email: string;
  phone: string;
  audience: "facility" | "partner" | null;
  message: string;
  createdAt: string;
  expiresAt: string;
  deliveryStatus: LandingDeliveryStatus;
  attemptCount: number;
  lastErrorCode: string | null;
  providerAcceptedAt: string | null;
}

export interface OperatorLandingInquiryPage {
  items: OperatorLandingInquiry[];
  nextCursor: string | null;
}

export const operatorLandingInquiriesQueryKey = ["operator", "landing-inquiries"] as const;
export const landingMailStatusQueryKey = ["operator", "landing-mail", "status"] as const;

export function listOperatorLandingInquiries(cursor?: string): Promise<OperatorLandingInquiryPage> {
  const query = new URLSearchParams({ limit: "20" });
  if (cursor) query.set("cursor", cursor);
  return apiGet(`/operator/landing-inquiries?${query.toString()}`);
}

export function getLandingMailStatus(): Promise<{ connected: boolean }> {
  return apiGet("/operator/landing-mail/status");
}

export async function requestLandingMailAuthorization(navigate: (url: string) => void = (url) => window.location.assign(url)): Promise<void> {
  const result = await apiPost<{ authorizationUrl: string }>("/operator/landing-mail/authorize", {});
  let url: URL;
  try { url = new URL(result.authorizationUrl); }
  catch { throw new Error("Invalid NAVER WORKS authorization URL"); }
  // Only the fixed official authorization endpoint may receive this navigation.
  if (url.protocol !== "https:" || url.hostname !== "auth.worksmobile.com" || url.port || url.username || url.password ||
    url.pathname !== "/oauth2/v2.0/authorize" || url.hash || url.searchParams.get("scope") !== "mail" ||
    url.searchParams.get("response_type") !== "code" || !url.searchParams.get("state")) {
    throw new Error("Invalid NAVER WORKS authorization URL");
  }
  navigate(result.authorizationUrl);
}
