import { Inject, Injectable, LoggerService } from "@nestjs/common";
import { RequestContext } from "./request-context.middleware";
import { OBSERVABILITY_CLOCK } from "./readiness.service";

export const STRUCTURED_LOG_WRITER = Symbol("STRUCTURED_LOG_WRITER");

type LogLevel = "info" | "error" | "warn" | "debug" | "verbose" | "fatal";
type HttpLog = { method: string; route: string; statusCode: number; durationMs: number };
const sensitiveKeys = new Set([
  "authorization",
  "cookie",
  "body",
  "query",
  "stack",
  "deviceid",
  "deviceuuid",
  "deviceserial",
  "rawdeviceidentifier",
  "serialnumber"
]);

@Injectable()
export class StructuredLoggerService implements LoggerService {
  constructor(
    private readonly requestContext: RequestContext,
    @Inject(STRUCTURED_LOG_WRITER) private readonly writeLine: (line: string) => void,
    @Inject(OBSERVABILITY_CLOCK) private readonly clock: () => Date
  ) {}

  log(message: unknown, context?: string) { this.write("info", message, context); }
  warn(message: unknown, context?: string) { this.write("warn", message, context); }
  debug(message: unknown, context?: string) { this.write("debug", message, context); }
  verbose(message: unknown, context?: string) { this.write("verbose", message, context); }
  fatal(message: unknown, context?: string) { this.write("fatal", message, context); }
  error(message: unknown, _trace?: string, context?: string) { this.write("error", message, context); }

  logHttpRequest(fields: HttpLog) {
    this.emit({
      timestamp: this.clock().toISOString(),
      level: "info",
      context: "HTTP",
      ...(this.requestIdField()),
      method: fields.method,
      route: fields.route,
      statusCode: fields.statusCode,
      durationMs: fields.durationMs
    });
  }

  private write(level: LogLevel, message: unknown, context?: string) {
    this.emit({
      timestamp: this.clock().toISOString(),
      level,
      context: context ?? "Application",
      ...(this.requestIdField()),
      message: sanitize(message)
    });
  }

  private requestIdField() {
    const requestId = this.requestContext.getRequestId();
    return requestId ? { requestId } : {};
  }

  private emit(entry: Record<string, unknown>) {
    this.writeLine(`${JSON.stringify(entry)}\n`);
  }
}

function sanitize(value: unknown, depth = 0): unknown {
  if (depth > 4) return "[redacted]";
  if (value instanceof Error) return { name: value.name };
  if (Array.isArray(value)) return value.slice(0, 20).map(item => sanitize(item, depth + 1));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value)
      .filter(([key]) => !sensitiveKeys.has(key.toLowerCase()))
      .slice(0, 40)
      .map(([key, item]) => [key, sanitize(item, depth + 1)]));
  }
  if (["string", "number", "boolean"].includes(typeof value) || value === null) return value;
  return String(value);
}
