import { RequestContext } from "./request-context.middleware";
import { StructuredLoggerService } from "./structured-logger.service";

describe("StructuredLoggerService", () => {
  const timestamp = "2026-09-12T01:02:03.004Z";

  function harness() {
    const lines: string[] = [];
    const context = new RequestContext();
    const logger = new StructuredLoggerService(context, line => lines.push(line), () => new Date(timestamp));
    return { context, logger, lines };
  }

  it("writes one JSON line with the bounded HTTP request fields", () => {
    const { context, logger, lines } = harness();

    context.run("request-123", () => logger.logHttpRequest({
      method: "GET",
      route: "/sites/:siteId/fixtures",
      statusCode: 200,
      durationMs: 7.25
    }));

    expect(lines).toHaveLength(1);
    expect(lines[0].endsWith("\n")).toBe(true);
    expect(JSON.parse(lines[0])).toEqual({
      timestamp,
      level: "info",
      context: "HTTP",
      requestId: "request-123",
      method: "GET",
      route: "/sites/:siteId/fixtures",
      statusCode: 200,
      durationMs: 7.25
    });
  });

  it("redacts cookie, authorization, body, query, and stack from application errors", () => {
    const { context, logger, lines } = harness();

    context.run("request-456", () => logger.error({
      message: "request rejected",
      cookie: "led_session=cookie-secret",
      authorization: "Bearer auth-secret",
      body: { password: "body-secret" },
      query: { token: "query-secret" },
      deviceId: "raw-device-serial-secret",
      stack: "stack-secret"
    }, "trace-secret", "AuthController"));

    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toEqual({
      timestamp,
      level: "error",
      context: "AuthController",
      requestId: "request-456",
      message: { message: "request rejected" }
    });
    expect(lines[0]).not.toMatch(/cookie-secret|auth-secret|body-secret|query-secret|raw-device-serial-secret|stack-secret|trace-secret/);
  });
});
