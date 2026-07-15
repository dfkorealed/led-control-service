import { ExecutionContext, UnauthorizedException } from "@nestjs/common";
import { ManufacturingAuthGuard } from "./manufacturing-auth.guard";

const manufacturingCaFingerprint = "AA".repeat(32);

function contextFor(request: Record<string, unknown>) {
  return {
    switchToHttp: () => ({ getRequest: () => request })
  } as ExecutionContext;
}

describe("ManufacturingAuthGuard", () => {
  it("accepts only an authorized peer issued by the configured manufacturing CA", () => {
    const request = {
      headers: {},
      socket: {
        authorized: true,
        getPeerCertificate: () => ({
          subject: { CN: "station-01", O: "DF Korea" },
          issuerCertificate: { fingerprint256: fingerprintWithColons(manufacturingCaFingerprint.toLowerCase()) }
        })
      }
    };

    expect(new ManufacturingAuthGuard(manufacturingCaFingerprint).canActivate(contextFor(request))).toBe(true);
    expect(request).toMatchObject({ manufacturingStationIdentity: expect.stringContaining("CN=station-01") });
  });

  it("rejects an authorized device certificate issued by another trusted CA", () => {
    const request = {
      headers: {},
      socket: {
        authorized: true,
        getPeerCertificate: () => ({
          subject: { CN: "gateway-01" },
          issuerCertificate: { fingerprint256: fingerprintWithColons("DD".repeat(32)) }
        })
      }
    };

    expect(() => new ManufacturingAuthGuard(manufacturingCaFingerprint).canActivate(contextFor(request))).toThrow(UnauthorizedException);
    expect(request).not.toHaveProperty("manufacturingStationIdentity");
  });

  it("rejects headers and peer data when TLS authorization is false", () => {
    const request = {
      headers: {
        "x-manufacturing-station": "station-header",
        "x-client-cert-issuer-fingerprint": manufacturingCaFingerprint
      },
      socket: {
        authorized: false,
        getPeerCertificate: () => ({
          subject: { CN: "station-header" },
          issuerCertificate: { fingerprint256: fingerprintWithColons(manufacturingCaFingerprint) }
        })
      }
    };

    expect(() => new ManufacturingAuthGuard(manufacturingCaFingerprint).canActivate(contextFor(request))).toThrow(UnauthorizedException);
  });

  it("fails closed when the manufacturing CA is not configured", () => {
    const request = {
      headers: {},
      socket: {
        authorized: true,
        getPeerCertificate: () => ({
          subject: { CN: "station-01" },
          issuerCertificate: { fingerprint256: fingerprintWithColons(manufacturingCaFingerprint) }
        })
      }
    };

    expect(() => new ManufacturingAuthGuard(null).canActivate(contextFor(request))).toThrow(UnauthorizedException);
  });
});

function fingerprintWithColons(value: string) {
  return value.match(/.{2}/g)?.join(":") ?? value;
}
