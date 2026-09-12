import { TotpService } from "./totp.service";

describe("TotpService", () => {
  const service = new TotpService();
  const rfcSecret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

  it.each([
    [59, "94287082"],
    [1_111_111_109, "07081804"],
    [1_111_111_111, "14050471"],
    [1_234_567_890, "89005924"],
    [2_000_000_000, "69279037"],
    [20_000_000_000, "65353130"]
  ])("matches the RFC 6238 SHA-1 vector at %s seconds", (seconds, expected) => {
    expect(service.codeAt(rfcSecret, seconds * 1_000, 8)).toBe(expected);
  });

  it("accepts only a numeric six-digit code inside the configured clock window", () => {
    const now = 1_700_000_000_000;
    const code = service.codeAt(rfcSecret, now);

    expect(service.verify(rfcSecret, code, now)).toBe(true);
    expect(service.verify(rfcSecret, service.codeAt(rfcSecret, now - 30_000), now)).toBe(true);
    expect(service.verify(rfcSecret, service.codeAt(rfcSecret, now - 60_000), now)).toBe(false);
    expect(service.verify(rfcSecret, "12345a", now)).toBe(false);
  });

  it("generates a Base32 secret and a standards-compatible otpauth URI", () => {
    const secret = service.generateSecret();
    const uri = service.buildUri(secret, "admin_01");

    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(uri).toContain("otpauth://totp/");
    expect(uri).toContain(`secret=${secret}`);
    expect(uri).toContain("digits=6");
    expect(uri).toContain("period=30");
  });
});
