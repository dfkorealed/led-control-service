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

  it("emits only allowlisted operation and error classification from structured application errors", () => {
    const { context, logger, lines } = harness();

    context.run("request-456", () => logger.error({
      operation: "dependency",
      error: new TypeError("postgres://admin:db-secret@tenant-host/internal"),
      message: "password=message-secret tenantId=tenant-secret",
      password: "password-secret",
      tenantId: "tenant-secret",
      url: "https://api-user:url-secret@private.example/path-secret?token=query-secret",
      headers: { "x-api-key": "api-key-secret" },
      path: "/sites/tenant-secret/devices/raw-device-secret",
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
      operation: "dependency",
      errorClass: "TypeError"
    });
    expect(lines[0]).not.toMatch(/message-secret|password-secret|tenant-secret|url-secret|api-key-secret|path-secret|cookie-secret|auth-secret|body-secret|query-secret|raw-device-serial-secret|stack-secret|trace-secret/);
  });

  it.each([
    "Authorization: Bearer auth-secret password=password-secret https://user:url-secret@private.example/?tenantId=tenant-secret",
    new Error("cookie=cookie-secret body=body-secret query=query-secret stack=stack-secret"),
    { arbitrary: "headers.x-api-key=api-key-secret deviceId=raw-device-secret" }
  ])("never emits raw application message payloads: %p", message => {
    const { logger, lines } = harness();

    logger.error(message, "trace-secret", "TenantSecretService");

    expect(JSON.parse(lines[0])).toEqual({
      timestamp,
      level: "error",
      context: "Application",
      operation: "application",
      errorClass: "Error"
    });
    expect(lines[0]).not.toMatch(/auth-secret|password-secret|url-secret|tenant-secret|cookie-secret|body-secret|query-secret|stack-secret|api-key-secret|raw-device-secret|trace-secret/);
  });
});
