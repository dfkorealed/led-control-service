import { randomUUID } from "node:crypto";
import { HttpException } from "@nestjs/common";
import { LandingInquiriesService } from "./landing-inquiries.service";
import type { LandingInquiryInput } from "./landing-inquiry.dto";

const valid = (): LandingInquiryInput => ({
  idempotencyKey: randomUUID(), companyName: " 테스트 시설 ", contactName: " 홍길동 ",
  email: " owner@example.com ", phone: "", audience: "facility", message: " B2 주차장 도입 상담 ",
  consent: true, consentVersion: "landing-2026-09-v1-90d", website: ""
});

function setup(connected = true) {
  const rows = new Map<string, any>();
  const findUnique = jest.fn(async ({ where }: any) => rows.get(where.idempotencyKey) ?? null);
  const create = jest.fn(async ({ data }: any) => { rows.set(data.idempotencyKey, data); return data; });
  const transaction = jest.fn(async (fn: any) => fn({ landingInquiry: { create } }));
  const prisma = { landingInquiry: { findUnique }, $transaction: transaction };
  const rate = { consume: jest.fn().mockResolvedValue(undefined) };
  const mail = { getConnectionStatus: jest.fn().mockResolvedValue({ connected }) };
  const service = new LandingInquiriesService(prisma as any, rate as any, mail as any);
  return { service, findUnique, create, transaction, rate, mail, rows };
}

async function statusOf(action: Promise<unknown>) {
  try { await action; } catch (error) { return (error as HttpException).getStatus(); }
  return undefined;
}

describe("LandingInquiriesService", () => {
  it("stores a valid inquiry with a server reference and 90-day expiry", async () => {
    const ctx = setup();
    const input = valid();
    const result = await ctx.service.submit(input, "127.0.0.1");
    expect(result).toEqual({ reference: expect.stringMatching(/^K-\d{8}-/), status: "received" });
    expect(ctx.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      companyName: "테스트 시설", contactName: "홍길동", email: "owner@example.com",
      message: "B2 주차장 도입 상담", deliveryStatus: "queued", reference: result.reference
    }) });
    const data = ctx.create.mock.calls[0][0].data;
    expect(data.expiresAt.getTime() - data.createdAt.getTime()).toBe(90 * 24 * 60 * 60 * 1000);
    expect(data).not.toHaveProperty("recipient");
    expect(ctx.transaction).toHaveBeenCalledTimes(1);
  });

  it("returns the original reference for a normalized exact retry without consuming rate or mail readiness", async () => {
    const ctx = setup();
    const input = valid();
    const first = await ctx.service.submit(input, "127.0.0.1");
    ctx.rate.consume.mockClear();
    ctx.mail.getConnectionStatus.mockClear();
    expect(await ctx.service.submit({ ...input, companyName: "테스트 시설" }, "127.0.0.1")).toEqual(first);
    expect(ctx.rate.consume).not.toHaveBeenCalled();
    expect(ctx.mail.getConnectionStatus).not.toHaveBeenCalled();
    expect(ctx.create).toHaveBeenCalledTimes(1);
  });

  it("rejects changed content under an existing idempotency key", async () => {
    const ctx = setup();
    const input = valid();
    await ctx.service.submit(input, "127.0.0.1");
    ctx.rate.consume.mockClear();
    expect(await statusOf(ctx.service.submit({ ...input, message: "다른 문의" }, "127.0.0.1"))).toBe(409);
    expect(ctx.rate.consume).not.toHaveBeenCalled();
    expect(ctx.create).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["empty company", { companyName: "" }], ["bad email", { email: "invalid" }],
    ["oversize field", { message: "x".repeat(2001) }], ["missing consent", { consent: false }],
    ["old consent", { consentVersion: "old" }], ["honeypot", { website: "bot" }],
    ["client recipient", { recipient: "attacker@example.com" }]
  ])("rejects %s before any DB read", async (_name, change) => {
    const ctx = setup();
    expect(await statusOf(ctx.service.submit({ ...valid(), ...change } as any, "127.0.0.1"))).toBe(400);
    expect(ctx.findUnique).not.toHaveBeenCalled();
    expect(ctx.transaction).not.toHaveBeenCalled();
    expect(ctx.rate.consume).not.toHaveBeenCalled();
  });

  it("rejects a request body over the byte budget before DB read", async () => {
    const ctx = setup();
    expect(await statusOf(ctx.service.submit({ ...valid(), companyName: "가".repeat(2000) }, "127.0.0.1"))).toBe(400);
    expect(ctx.findUnique).not.toHaveBeenCalled();
  });

  it("does not save PII when the mail connection is unavailable", async () => {
    const ctx = setup(false);
    expect(await statusOf(ctx.service.submit(valid(), "127.0.0.1"))).toBe(503);
    expect(ctx.rate.consume).not.toHaveBeenCalled();
    expect(ctx.transaction).not.toHaveBeenCalled();
  });

  it("does not save PII when the IP bucket is exhausted or Redis is down", async () => {
    for (const code of [429, 503]) {
      const ctx = setup();
      ctx.rate.consume.mockRejectedValue(new HttpException("unavailable", code));
      expect(await statusOf(ctx.service.submit(valid(), "127.0.0.1"))).toBe(code);
      expect(ctx.transaction).not.toHaveBeenCalled();
    }
  });

  it("returns a safe 503 for a DB read failure without exposing the underlying error", async () => {
    const ctx = setup();
    ctx.findUnique.mockRejectedValue(new Error("owner@example.com private db detail"));
    let error: HttpException | undefined;
    try { await ctx.service.submit(valid(), "127.0.0.1"); } catch (caught) { error = caught as HttpException; }
    expect(error?.getStatus()).toBe(503);
    expect(JSON.stringify(error?.getResponse())).not.toContain("owner@example.com");
    expect(ctx.transaction).not.toHaveBeenCalled();
  });
});
