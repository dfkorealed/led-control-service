import "reflect-metadata";
import { Controller, Get, INestApplication, Param } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { ObservabilityMetrics } from "./observability-metrics.service";
import { OBSERVABILITY_HTTP_LOGGER, RequestContext, RequestContextMiddleware } from "./request-context.middleware";

@Controller("context")
class ContextController {
  constructor(private readonly context: RequestContext) {}

  @Get(":delayMs")
  async current(@Param("delayMs") delayMs: string) {
    await new Promise(resolve => setTimeout(resolve, Number(delayMs)));
    return { requestId: this.context.getRequestId() };
  }
}

describe("RequestContext", () => {
  it("isolates concurrent asynchronous request IDs", async () => {
    const context = new RequestContext();
    let release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });

    const first = context.run("request-a", async () => { await barrier; return context.getRequestId(); });
    const second = context.run("request-b", async () => { await barrier; return context.getRequestId(); });
    release();

    await expect(Promise.all([first, second])).resolves.toEqual(["request-a", "request-b"]);
    expect(context.getRequestId()).toBeUndefined();
  });
});

describe("RequestContextMiddleware HTTP boundary", () => {
  let app: INestApplication;
  let baseUrl: string;
  const httpLogger = { logHttpRequest: jest.fn() };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [ContextController],
      providers: [
        RequestContext,
        RequestContextMiddleware,
        { provide: ObservabilityMetrics, useValue: { recordHttp: jest.fn() } },
        { provide: OBSERVABILITY_HTTP_LOGGER, useValue: httpLogger }
      ]
    }).compile();
    app = moduleRef.createNestApplication();
    const middleware = moduleRef.get(RequestContextMiddleware);
    app.use(middleware.use.bind(middleware));
    await app.listen(0, "127.0.0.1");
    baseUrl = await app.getUrl();
  });

  afterAll(async () => app.close());
  beforeEach(() => httpLogger.logHttpRequest.mockClear());

  it("accepts a safe X-Request-Id and propagates it through response and async controller work", async () => {
    const response = await fetch(`${baseUrl}/context/1`, { headers: { "X-Request-Id": "edge.trace_01:retry-2" } });

    expect(response.headers.get("x-request-id")).toBe("edge.trace_01:retry-2");
    expect(await response.json()).toEqual({ requestId: "edge.trace_01:retry-2" });
  });

  it.each([
    "../../tenant?authorization=secret",
    "has whitespace",
    "a".repeat(129)
  ])("replaces unsafe X-Request-Id %p with a generated UUID", async invalidRequestId => {
    const response = await fetch(`${baseUrl}/context/1`, { headers: { "X-Request-Id": invalidRequestId } });
    const responseRequestId = response.headers.get("x-request-id");

    expect(responseRequestId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(responseRequestId).not.toBe(invalidRequestId);
    expect(await response.json()).toEqual({ requestId: responseRequestId });
  });

  it("preserves context isolation across overlapping real HTTP requests", async () => {
    const [slow, fast] = await Promise.all([
      fetch(`${baseUrl}/context/10`, { headers: { "X-Request-Id": "slow-request" } }),
      fetch(`${baseUrl}/context/1`, { headers: { "X-Request-Id": "fast-request" } })
    ]);

    expect(await slow.json()).toEqual({ requestId: "slow-request" });
    expect(await fast.json()).toEqual({ requestId: "fast-request" });
  });

  it("normalizes an unmatched path instead of logging tenant, query, or device identifiers", async () => {
    const response = await fetch(`${baseUrl}/sites/tenant-secret/devices/raw-device-secret?token=query-secret`, {
      headers: { "X-Request-Id": "safe-404-request" }
    });
    await response.text();
    await new Promise(resolve => setImmediate(resolve));

    expect(httpLogger.logHttpRequest).toHaveBeenCalledWith(expect.objectContaining({
      route: "/:unmatched",
      statusCode: 404
    }));
    expect(JSON.stringify(httpLogger.logHttpRequest.mock.calls)).not.toMatch(/tenant-secret|raw-device-secret|query-secret/);
  });
});
