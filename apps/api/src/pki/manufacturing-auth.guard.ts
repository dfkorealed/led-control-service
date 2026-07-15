import { CanActivate, ExecutionContext, Inject, Injectable, UnauthorizedException } from "@nestjs/common";
import { timingSafeEqual } from "node:crypto";

export const MANUFACTURING_CA_FINGERPRINT = Symbol("MANUFACTURING_CA_FINGERPRINT");

interface PeerCertificate {
  subject?: Record<string, string | string[]>;
  issuerCertificate?: { fingerprint256?: string };
}

export interface ManufacturingCertificateRequest {
  headers: Record<string, string | string[] | undefined>;
  socket?: {
    authorized?: boolean;
    getPeerCertificate?: (detailed?: boolean) => PeerCertificate;
  };
  manufacturingStationIdentity?: string;
}

@Injectable()
export class ManufacturingAuthGuard implements CanActivate {
  constructor(@Inject(MANUFACTURING_CA_FINGERPRINT) private readonly manufacturingCaFingerprint: string | null) {}

  canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<ManufacturingCertificateRequest>();
    if (!request.socket?.authorized || !this.manufacturingCaFingerprint) return this.reject();

    const peer = request.socket.getPeerCertificate?.(true);
    const actualIssuer = normalizeFingerprint(peer?.issuerCertificate?.fingerprint256);
    const expectedIssuer = normalizeFingerprint(this.manufacturingCaFingerprint);
    const stationIdentity = formatSubject(peer?.subject);
    if (!actualIssuer || !expectedIssuer || !sameFingerprint(actualIssuer, expectedIssuer) || !stationIdentity) {
      return this.reject();
    }

    request.manufacturingStationIdentity = stationIdentity;
    return true;
  }

  private reject(): never {
    throw new UnauthorizedException("manufacturing mTLS certificate required");
  }
}

function normalizeFingerprint(value: string | undefined): string | null {
  if (!value) return null;
  const normalized = value.replace(/:/g, "").trim().toUpperCase();
  return /^[0-9A-F]{64}$/.test(normalized) ? normalized : null;
}

function sameFingerprint(left: string, right: string) {
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function formatSubject(subject: PeerCertificate["subject"]): string | null {
  if (!subject || typeof subject !== "object") return null;
  const parts = Object.entries(subject)
    .sort(([left], [right]) => left.localeCompare(right))
    .flatMap(([key, value]) => (Array.isArray(value) ? value : [value]).map((item) => `${key}=${item}`));
  return parts.length > 0 ? parts.join(",") : null;
}
