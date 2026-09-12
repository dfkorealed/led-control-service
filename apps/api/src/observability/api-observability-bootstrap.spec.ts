import { RequestContextMiddleware } from "./request-context.middleware";
import { StructuredLoggerService } from "./structured-logger.service";
import {
  createApiNestOptions,
  createBootstrapStructuredLogger,
  installApiObservability,
  reportApiBootstrapFailure
} from "./api-observability-bootstrap";

describe("API observability bootstrap", () => {
  it("preserves TLS while enabling the strict logger before Nest creation", () => {
    const httpsOptions = { cert: Buffer.from("cert"), key: Buffer.from("key") };
    const bootstrapLogger = { log: jest.fn(), error: jest.fn(), warn: jest.fn() };

    expect(createApiNestOptions({ httpsOptions }, bootstrapLogger)).toEqual({
      httpsOptions,
      logger: bootstrapLogger,
      bufferLogs: true,
      autoFlushLogs: true
    });
  });

  it("installs the DI logger before the request context middleware", () => {
    const calls: string[] = [];
    const logger = {} as StructuredLoggerService;
    const middleware = { use: jest.fn() } as unknown as RequestContextMiddleware;
    const app = {
      get: jest.fn((token: unknown) => token === StructuredLoggerService ? logger : middleware),
      useLogger: jest.fn((_logger: unknown) => { calls.push("logger"); }),
      use: jest.fn((_middleware: unknown) => { calls.push("middleware"); })
    };

    installApiObservability(app);

    expect(app.get).toHaveBeenNthCalledWith(1, StructuredLoggerService);
    expect(app.get).toHaveBeenNthCalledWith(2, RequestContextMiddleware);
    expect(calls).toEqual(["logger", "middleware"]);
  });

  it("routes startup failures through the same strict JSON allowlist", () => {
    const lines: string[] = [];
    const logger = createBootstrapStructuredLogger(
      (line) => lines.push(line),
      () => new Date("2026-09-12T00:00:00.000Z")
    );

    logger.error(
      "failed postgres://admin:secret@db.internal/tenant/acme",
      "stack with x-api-key=top-secret",
      "NestFactory"
    );

    expect(JSON.parse(lines[0])).toEqual({
      timestamp: "2026-09-12T00:00:00.000Z",
      level: "error",
      context: "NestFactory",
      operation: "application",
      errorClass: "Error"
    });
    expect(lines[0]).not.toContain("secret");
    expect(lines[0]).not.toContain("postgres://");
    expect(lines[0]).not.toContain("x-api-key");
  });

  it("reports bootstrap rejection without passing the caught error onward", () => {
    const logger = { error: jest.fn() };

    reportApiBootstrapFailure(logger);

    expect(logger.error).toHaveBeenCalledWith(
      { operation: "startup", errorClass: "Error" },
      undefined,
      "NestFactory"
    );
  });
});
