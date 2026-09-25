import { HTTP_CODE_METADATA, PATH_METADATA } from "@nestjs/common/constants";
import { LandingInquiriesController } from "./landing-inquiries.controller";

describe("LandingInquiriesController", () => {
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
