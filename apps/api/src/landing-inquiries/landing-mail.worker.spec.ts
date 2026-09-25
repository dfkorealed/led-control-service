import { Logger } from "@nestjs/common";
import { RequestContext } from "../observability/request-context.middleware";
import { StructuredLoggerService } from "../observability/structured-logger.service";
import { LandingMailWorker } from "./landing-mail.worker";

describe("landing mail worker timestamps and production logs", () => {
  afterEach(() => { jest.useRealTimers(); Logger.overrideLogger(false); });

  it("preserves a numeric prune count through the actual Nest structured logger", async () => {
    const lines: string[] = [];
    Logger.overrideLogger(new StructuredLoggerService(new RequestContext(), line => lines.push(line), () => new Date(0)));
    const worker = new LandingMailWorker({ $executeRaw: async () => 27 } as any, {} as any);
    expect(await worker.pruneExpired()).toBe(27);
    expect(lines.map(line => JSON.parse(line))).toEqual([{
      timestamp: "1970-01-01T00:00:00.000Z", level: "info", context: "LandingMailWorker",
      operation: "landing_inquiry_prune", deletedCount: 27
    }]);
  });

  it("records acceptance after the provider returns, not when the row is claimed", async () => {
    jest.useFakeTimers().setSystemTime(new Date("2026-09-25T00:00:00Z"));
    const updateMany = jest.fn(async (_args: unknown) => ({ count: 1 }));
    const db = { $executeRaw: jest.fn(async () => 0),
      $queryRaw: jest.fn().mockResolvedValueOnce([{ id: "test-id", reference: "K-1", companyName: "C", contactName: "N",
        email: "test@example.com", phone: "", message: "hello", attemptCount: 1 }]).mockResolvedValue([]),
      landingInquiry: { updateMany } };
    const worker = new LandingMailWorker(db as any, { send: async () => { jest.setSystemTime(new Date("2026-09-25T00:00:07Z")); } } as any);
    await worker.deliverDue();
    expect(updateMany.mock.calls[0]?.[0]).toMatchObject({ data: { providerAcceptedAt: new Date("2026-09-25T00:00:07Z") } });
  });
});
