import { LandingInquiryRateLimitService } from "./landing-inquiry-rate-limit.service";

describe("LandingInquiryRateLimitService", () => {
  it("limits a hashed IP bucket without putting the raw IP in Redis", async () => {
    const evalScript = jest.fn().mockResolvedValueOnce([1, 900]).mockResolvedValueOnce([0, 899]);
    const service = new LandingInquiryRateLimitService({ getClient: () => ({ eval: evalScript }) } as any);
    await service.consume("192.0.2.10");
    await expect(service.consume("192.0.2.10")).rejects.toMatchObject({ status: 429 });
    expect(evalScript.mock.calls[0][2]).not.toContain("192.0.2.10");
    expect(evalScript.mock.calls[0][2]).toBe(evalScript.mock.calls[1][2]);
  });

  it("fails closed if Redis throws or gives an invalid result", async () => {
    for (const result of [new Error("down"), "bad"]) {
      const evalScript = jest.fn();
      if (result instanceof Error) evalScript.mockRejectedValue(result);
      else evalScript.mockResolvedValue(result);
      const service = new LandingInquiryRateLimitService({ getClient: () => ({ eval: evalScript }) } as any);
      await expect(service.consume("192.0.2.10")).rejects.toMatchObject({ status: 503 });
    }
  });
});
