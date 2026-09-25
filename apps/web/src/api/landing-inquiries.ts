import { apiPost } from "./client";

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
