import { Injectable } from "@nestjs/common";
import { LandingMailOAuthService } from "./landing-mail-oauth.service";
import type { LandingMailMessage } from "./landing-mail-renderer";

export type LandingMailErrorCode = "MAIL_CONFIGURATION_INVALID" | "MAIL_OAUTH_UNAVAILABLE" | "MAIL_RATE_LIMITED" | "MAIL_REJECTED" | "MAIL_ACCEPTANCE_UNKNOWN";
export class LandingMailDeliveryError extends Error {
  constructor(public readonly outcome: "retryable" | "permanent" | "uncertain", public readonly code: LandingMailErrorCode) { super(code); }
}

@Injectable()
export class LandingMailTransport {
  constructor(private readonly oauth: LandingMailOAuthService) {}

  async send(message: LandingMailMessage): Promise<"provider_accepted"> {
    const sender = process.env.LANDING_NAVER_WORKS_SENDER?.trim();
    if (!sender || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(sender)) {
      throw new LandingMailDeliveryError("permanent", "MAIL_CONFIGURATION_INVALID");
    }
    const endpoint = `https://www.worksapis.com/v1.0/users/${encodeURIComponent(sender)}/mail`;
    const body = JSON.stringify({ to: "kymkjh2002@dfkorealed.com", subject: message.subject.replace(/[\r\n]/g, " "),
      body: message.html, contentType: "html", userName: "킨다 상담", isSaveSentMail: true,
      isSaveTracking: true, isSendSeparately: false });
    let response = await this.request(endpoint, await this.token(false), body);
    // A 401 explicitly rejected the request, so one refresh/retry cannot duplicate acceptance.
    if (response.status === 401) response = await this.request(endpoint, await this.token(true), body);
    if (response.status === 202) return "provider_accepted";
    if (response.status === 429) throw new LandingMailDeliveryError("retryable", "MAIL_RATE_LIMITED");
    if (response.status >= 400 && response.status < 500) throw new LandingMailDeliveryError("permanent", "MAIL_REJECTED");
    // The provider has no idempotency key. Even 5xx may follow acceptance: never resend automatically.
    throw new LandingMailDeliveryError("uncertain", "MAIL_ACCEPTANCE_UNKNOWN");
  }

  private async token(forceRefresh: boolean): Promise<string> {
    try { return await this.oauth.getAccessToken(forceRefresh); }
    catch { throw new LandingMailDeliveryError("retryable", "MAIL_OAUTH_UNAVAILABLE"); }
  }

  private async request(endpoint: string, token: string, body: string): Promise<Response> {
    try {
      return await fetch(endpoint, { method: "POST", redirect: "error", signal: AbortSignal.timeout(10_000),
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body });
    } catch { throw new LandingMailDeliveryError("uncertain", "MAIL_ACCEPTANCE_UNKNOWN"); }
  }
}
