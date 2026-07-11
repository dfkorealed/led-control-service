import { ExecutionContext, UnauthorizedException } from "@nestjs/common";
import { DeviceCertificateGuard } from "./device-certificate.guard";

function contextFor(request: Record<string, unknown>) {
  return {
    switchToHttp: () => ({ getRequest: () => request })
  } as ExecutionContext;
}

describe("DeviceCertificateGuard", () => {
  const previousNodeEnv = process.env.NODE_ENV;

  afterEach(() => {
    process.env.NODE_ENV = previousNodeEnv;
  });

  it("accepts an authorized TLS peer and stores its normalized SHA-256 fingerprint", () => {
    const request = {
      headers: {},
      socket: {
        authorized: true,
        getPeerCertificate: () => ({ fingerprint256: "AA:bb:01" })
      }
    };

    expect(new DeviceCertificateGuard().canActivate(contextFor(request))).toBe(true);
    expect(request).toMatchObject({ deviceCertificateFingerprint: "AABB01" });
  });

  it("rejects a test fingerprint header in production", () => {
    process.env.NODE_ENV = "production";
    const request = {
      headers: { "x-test-client-cert-fingerprint": "AA:BB" },
      socket: { authorized: false, getPeerCertificate: () => ({}) }
    };

    expect(() => new DeviceCertificateGuard().canActivate(contextFor(request))).toThrow(UnauthorizedException);
  });

  it("allows the explicit fingerprint header only in tests", () => {
    process.env.NODE_ENV = "test";
    const request = {
      headers: { "x-test-client-cert-fingerprint": "aa:bb:01" },
      socket: { authorized: false, getPeerCertificate: () => ({}) }
    };

    expect(new DeviceCertificateGuard().canActivate(contextFor(request))).toBe(true);
    expect(request).toMatchObject({ deviceCertificateFingerprint: "AABB01" });
  });
});
