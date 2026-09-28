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

  it.each(["completed", "failed"])("preserves bounded retention metrics for %s events without raw data", status => {
    const { logger, lines } = harness();
    logger.warn({ event: "command_detail_retention_batch", status, examined: 100, redacted: 1,
      overdueCount: 1500, oldestAgeSeconds: 123456.5, skippedByReason: { command_unresolved: 99 },
      blockedByReason: { legacy_ack_attribution_unverifiable: 1401 },
      error: new Error("SQL password=secret"), commandId: "secret-id", sql: "secret query" }, "CommandDetailRetentionService");
    expect(JSON.parse(lines[0])).toEqual({ timestamp, level: "warn", context: "CommandDetailRetentionService",
      operation: "background_job", event: "command_detail_retention_batch", status,
      examined: 100, redacted: 1, overdueCount: 1500, oldestAgeSeconds: 123456.5,
      skippedByReason: { command_unresolved: 99 }, blockedByReason: { legacy_ack_attribution_unverifiable: 1401 } });
    expect(lines[0]).not.toContain("secret");
  });

  it("drops invalid counters, unknown reason keys and unrecognized retention event/context", () => {
    const { logger, lines } = harness();
    logger.log({ event: "command_detail_retention_batch", status: "completed", examined: 1001,
      redacted: -1, overdueCount: "secret", oldestAgeSeconds: Infinity,
      skippedByReason: { command_unresolved: 1001, secret: 1 },
      blockedByReason: { legacy_ack_attribution_unverifiable: 2, command_unresolved: NaN,
        raw_copy_cleanup_failed: -1, secret: 1 }, commandId: "secret" }, "CommandDetailRetentionService");
    expect(JSON.parse(lines[0])).toEqual({ timestamp, level: "info", context: "CommandDetailRetentionService",
      operation: "background_job", event: "command_detail_retention_batch", status: "completed",
      skippedByReason: {}, blockedByReason: { legacy_ack_attribution_unverifiable: 2 } });
    for (const [event, context, status] of [
      ["secret", "CommandDetailRetentionService", "completed"],
      ["command_detail_retention_batch", "secret", "completed"],
      ["command_detail_retention_batch", "CommandDetailRetentionService", "secret"]
    ]) logger.log({ event, status, examined: 1 }, context);
    for (const line of lines.slice(1)) expect(JSON.parse(line)).not.toHaveProperty("event");
    expect(lines.join("")).not.toContain("secret");
  });

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

  it("keeps only a bounded numeric landing prune count and never arbitrary payloads", () => {
    const { logger, lines } = harness();
    logger.log({ operation: "landing_inquiry_prune", deletedCount: 0, email: "private@example.com" }, "LandingMailWorker");
    expect(JSON.parse(lines[0])).toEqual({ timestamp, level: "info", context: "LandingMailWorker", operation: "landing_inquiry_prune", deletedCount: 0 });
    for (const deletedCount of [-1, 101, 1.5, "secret", Infinity]) {
      logger.log({ operation: "landing_inquiry_prune", deletedCount, message: "private" }, "LandingMailWorker");
      expect(JSON.parse(lines.at(-1)!)).not.toHaveProperty("deletedCount");
    }
    expect(lines.join("")).not.toMatch(/private|secret/);
  });

  it("retains only bounded CAD diagnostic fields, never raw CAD text or credentials", () => {
    const { logger, lines } = harness();
    logger.error({ operation: "background_job", diagnosticCode: "CAD_CORE_TIMEOUT", phase: "parse",
      jobId: "a6b6130c-3819-4947-94fe-fa5d9dfad506", attemptCount: 3,
      error: new Error("/private/source.dxf password=secret CAD-TEXT"), message: "CAD-TEXT" },
    undefined, "FloorImportWorkerService");
    expect(JSON.parse(lines[0])).toEqual({ timestamp, level: "error", context: "FloorImportWorkerService",
      operation: "background_job", errorClass: "Error", diagnosticCode: "CAD_CORE_TIMEOUT",
      phase: "parse", jobId: "a6b6130c-3819-4947-94fe-fa5d9dfad506", attemptCount: 3 });
    logger.error({ operation: "background_job", diagnosticCode: "CAD_CORE_TIMEOUT secret",
      phase: "parse secret", jobId: "/private/secret", attemptCount: 999, message: "secret" },
    undefined, "FloorImportWorkerService");
    expect(JSON.parse(lines[1])).toEqual({ timestamp, level: "error", context: "FloorImportWorkerService",
      operation: "background_job", errorClass: "Error" });
    expect(lines.join("")).not.toMatch(/secret|CAD-TEXT|private|source\.dxf/);
  });
});
