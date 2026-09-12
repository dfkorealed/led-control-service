import { RequestContextMiddleware } from "./request-context.middleware";
import { StructuredLoggerService } from "./structured-logger.service";
import { createApiRuntimeLifecycle } from "../api-lifecycle";
import {
  createApiNestOptions,
  createBootstrapStructuredLogger,
  installApiObservability,
  reportApiBootstrapFailure,
  runApiBootstrap
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

  it("closes an initialized runtime exactly once when listen rejects without leaking the caught error", async () => {
    const order: string[] = [];
    const app = { close: jest.fn(async () => { order.push("app"); }) };
    const runtime = createApiRuntimeLifecycle(app, code => { order.push(`exit-${code}`); });
    runtime.setToken({ stop: () => { order.push("token"); } });
    runtime.setCrl({ close: () => { order.push("crl"); } });
    const lines: string[] = [];
    const logger = createBootstrapStructuredLogger(
      line => { lines.push(line); },
      () => new Date("2026-09-12T00:00:00.000Z")
    );
    const listen = jest.fn().mockRejectedValue(
      new Error("listen EADDRINUSE postgres://admin:secret@tenant.internal stack-secret")
    );
    const fallbackExit = jest.fn();

    await runApiBootstrap(async registerRuntime => {
      registerRuntime(runtime);
      await listen();
    }, logger, fallbackExit);

    expect(order).toEqual(["exit-1", "crl", "token", "app"]);
    expect(app.close).toHaveBeenCalledTimes(1);
    expect(listen).toHaveBeenCalledTimes(1);
    expect(fallbackExit).not.toHaveBeenCalled();
    expect(JSON.parse(lines[0])).toEqual({
      timestamp: "2026-09-12T00:00:00.000Z",
      level: "error",
      context: "NestFactory",
      operation: "startup",
      errorClass: "Error"
    });
    expect(lines[0]).not.toMatch(/EADDRINUSE|postgres:\/\/|admin|secret|tenant\.internal|stack-secret/);
  });
});
