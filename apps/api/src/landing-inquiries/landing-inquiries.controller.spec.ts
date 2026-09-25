import { HTTP_CODE_METADATA, PATH_METADATA } from "@nestjs/common/constants";
import { LandingInquiriesController } from "./landing-inquiries.controller";

describe("LandingInquiriesController", () => {
  const oldEnv = { ...process.env };
  afterEach(() => { process.env = { ...oldEnv }; });
  it("uses distinct authenticated ingress clients and fails closed on forged/direct requests", async () => {
    process.env.NODE_ENV = "production";
    process.env.LANDING_INGRESS_SECRET = "a".repeat(64);
    const submit = jest.fn(async (_input: unknown, ip: string) => ({ ip }));
    const controller = new LandingInquiriesController({ submit } as any);
    for (const ip of ["198.51.100.20", "198.51.100.21"]) {
      expect(await controller.submit({} as any, { ip: "10.0.0.2", headers: { "x-landing-ingress-secret": "a".repeat(64), "x-landing-client-ip": ip, "x-forwarded-for": "spoofed" } } as any)).toEqual({ ip });
    }
    for (const headers of [
      { "x-forwarded-for": "198.51.100.99" },
      { "x-landing-ingress-secret": "b".repeat(64), "x-landing-client-ip": "198.51.100.99" },
      { "x-landing-ingress-secret": "a".repeat(64), "x-landing-client-ip": "198.51.100.20, 198.51.100.99" },
      { "x-landing-ingress-secret": "a".repeat(64), "x-landing-client-ip": ["198.51.100.20"] }
    ]) expect(() => controller.submit({} as any, { ip: "10.0.0.2", headers } as any)).toThrow();
    delete process.env.LANDING_INGRESS_SECRET;
    expect(() => controller.submit({} as any, { ip: "10.0.0.2", headers: {} } as any)).toThrow();
    expect(submit).toHaveBeenCalledTimes(2);
  });

  it("rejects noncanonical ingress secrets including trailing newlines", () => {
    process.env.NODE_ENV = "production";
    const controller = new LandingInquiriesController({ submit: jest.fn() } as any);
    for (const key of ["a".repeat(64) + "\n", "a".repeat(63), "A".repeat(64)]) {
      process.env.LANDING_INGRESS_SECRET = key;
      expect(() => controller.submit({} as any, { headers: { "x-landing-ingress-secret": key, "x-landing-client-ip": "127.0.0.1" } } as any)).toThrow();
    }
  });

  it("exposes a public POST returning HTTP 201 and uses the trusted request IP", async () => {
    const service = { submit: jest.fn().mockResolvedValue({ reference: "K-20260925-ABC", status: "received" }) };
    const controller = new LandingInquiriesController(service as any);
    expect(Reflect.getMetadata(PATH_METADATA, LandingInquiriesController)).toBe("landing/inquiries");
    expect(Reflect.getMetadata(PATH_METADATA, controller.submit)).toBe("/");
    expect(Reflect.getMetadata(HTTP_CODE_METADATA, controller.submit)).toBe(201);
    const input = { idempotencyKey: "key" };
    expect(await controller.submit(input as any, { ip: "127.0.0.1", headers: { "x-forwarded-for": "1.2.3.4" } } as any))
      .toEqual({ reference: "K-20260925-ABC", status: "received" });
    expect(service.submit).toHaveBeenCalledWith(input, "127.0.0.1");
  });
});
