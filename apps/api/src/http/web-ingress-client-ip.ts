import { timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";

export type WebIngressRequest = {
  ip?: string;
  headers?: Record<string, string | string[] | undefined>;
};

type WebIngressEnvironment = { LANDING_INGRESS_SECRET?: string };

/**
 * Returns a client address only when the Web proxy proves it overwrote both
 * headers with the deployment's shared ingress secret. Raw device TLS reaches
 * the same API process, so global trust-proxy and unauthenticated XFF are unsafe.
 */
export function trustedWebClientIp(
  request: WebIngressRequest,
  env: WebIngressEnvironment = process.env
): string | null {
  const configured = env.LANDING_INGRESS_SECRET;
  const provided = request.headers?.["x-web-ingress-secret"];
  const clientIp = request.headers?.["x-web-client-ip"];
  if (
    !isCanonicalSecret(configured) ||
    !isCanonicalSecret(provided) ||
    !timingSafeEqual(Buffer.from(configured, "hex"), Buffer.from(provided, "hex")) ||
    typeof clientIp !== "string" ||
    isIP(clientIp) === 0
  ) {
    return null;
  }
  return clientIp;
}

function isCanonicalSecret(value: string | string[] | undefined): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}
