import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import { AuthService } from "../auth/auth.service";
import { PrismaService } from "../prisma/prisma.service";
import { OperatorLandingInquiriesController } from "./operator-landing-inquiries.controller";

describe("operator landing inquiries HTTP boundary", () => {
  let app: INestApplication;
  let base: string;
  const findMany = jest.fn();
  beforeAll(async () => {
    const module = await Test.createTestingModule({ controllers: [OperatorLandingInquiriesController], providers: [
      { provide: PrismaService, useValue: { landingInquiry: { findMany } } },
      { provide: AuthService, useValue: { getUserBySessionToken: async (role: string) => ({ id: "operator-1", role, mustChangePassword: false }) } }
    ] }).compile();
    app = module.createNestApplication(); await app.listen(0, "127.0.0.1"); base = await app.getUrl();
  });
  afterAll(async () => { await app?.close(); });
  beforeEach(() => { findMany.mockReset().mockResolvedValue([]); });
  const headers = { Cookie: `${AuthService.sessionCookieName}=operator` };
  it("rejects anonymous and customer access before querying PII", async () => {
    expect((await fetch(base + "/operator/landing-inquiries")).status).toBe(401);
    for (const role of ["admin", "viewer"]) {
      expect((await fetch(base + "/operator/landing-inquiries", { headers: { Cookie: `${AuthService.sessionCookieName}=${role}` } })).status).toBe(403);
    }
    expect(findMany).not.toHaveBeenCalled();
    const response = await fetch(base + "/operator/landing-inquiries", { headers });
    expect(response.status).toBe(200); expect(await response.json()).toEqual({ items: [], nextCursor: null });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
  it.each(["limit=0", "limit=51", "limit=abc", "limit=1.5", "limit=2&limit=3", "cursor=bad", "cursor=" + "x".repeat(300)])("rejects malformed bounded pagination: %s", async (query) => {
    const response = await fetch(base + "/operator/landing-inquiries?" + query, { headers });
    expect(response.status).toBe(400); expect(findMany).not.toHaveBeenCalled();
  });
  it("projects only needed contact/status fields and builds a stable next cursor", async () => {
    const createdAt = new Date("2026-09-25T00:00:00Z");
    const row = { id: "00000000-0000-4000-8000-000000000002", reference: "K-2", createdAt, email: "reply@example.com" };
    findMany.mockResolvedValue([row, { ...row, id: "00000000-0000-4000-8000-000000000001" }]);
    const response = await fetch(base + "/operator/landing-inquiries?limit=1", { headers });
    const body = await response.json() as { items: Record<string, unknown>[]; nextCursor: string };
    expect(body.items).toEqual([{ reference: "K-2", createdAt: createdAt.toISOString(), email: "reply@example.com" }]);
    expect(body.nextCursor).toEqual(expect.any(String));
    const args = findMany.mock.calls[0][0];
    expect(args.take).toBe(2); expect(args.select.payloadHash).toBeUndefined(); expect(args.select.idempotencyKey).toBeUndefined();
    expect(args.orderBy).toEqual([{ createdAt: "desc" }, { id: "desc" }]);
    findMany.mockResolvedValue([]);
    const next = await fetch(base + "/operator/landing-inquiries?limit=1&cursor=" + body.nextCursor, { headers });
    expect(next.status).toBe(200);
    expect(findMany.mock.calls[1][0].where).toMatchObject({ OR: [
      { createdAt: { lt: createdAt } }, { createdAt, id: { lt: row.id } }
    ], expiresAt: { gt: expect.any(Date) } });
  });
});
