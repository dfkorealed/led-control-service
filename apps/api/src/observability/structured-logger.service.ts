import { Inject, Injectable, LoggerService } from "@nestjs/common";
import { RequestContext } from "./request-context.middleware";
import { OBSERVABILITY_CLOCK } from "./readiness.service";
import { safeCadImportDiagnosticFields } from "../floor-import/cad-import-diagnostics";
import { safeCommandDetailRetentionFields } from "../retention/command-detail-retention-diagnostics";

export const STRUCTURED_LOG_WRITER = Symbol("STRUCTURED_LOG_WRITER");

type LogLevel = "info" | "error" | "warn" | "debug" | "verbose" | "fatal";
type HttpLog = { method: string; route: string; statusCode: number; durationMs: number };
const applicationOperations = new Set([
  "application",
  "startup",
  "shutdown",
  "dependency",
  "request",
  "background_job",
  "message_processing",
  "persistence"
]);
const errorClasses = new Set([
  "Error",
  "TypeError",
  "RangeError",
  "SyntaxError",
  "ReferenceError",
  "AbortError",
  "TimeoutError",
  "ConnectionError",
  "ValidationError"
]);
const safeContexts = new Set([
  "Application",
  "NestFactory",
  "InstanceLoader",
  "RoutesResolver",
  "RouterExplorer",
  "NestApplication",
  "AuthController",
  "MeshGroupSyncWorker",
  "FixtureFreshnessService",
  "ProvisioningScanOutboxPublisherService",
  "AutomationOutboxPublisherService",
  "ProvisioningDeviceOutboxPublisherService",
  "OutboxPublisherService",
  "MqttService",
  "RedisProvider",
  "EnergyReportCleanupService",
  "EnergyRetentionService",
  "EnergyReportWorkerService",
  "FloorImportWorkerService",
  "CommandDetailRetentionService"
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
      context: context && safeContexts.has(context) ? context : "Application",
      ...(this.requestIdField()),
      ...classifyApplicationEvent(message, level, context)
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

function classifyApplicationEvent(message: unknown, level: LogLevel, context?: string) {
  const record = message && typeof message === "object" && !Array.isArray(message)
    ? message as Record<string, unknown>
    : undefined;
  const requestedOperation = record?.operation;
  const retention = safeCommandDetailRetentionFields(record, context);
  const operation = "event" in retention ? "background_job" : typeof requestedOperation === "string" && applicationOperations.has(requestedOperation)
    ? requestedOperation
    : classifyLegacyOperation(typeof message === "string" ? message : "");
  if (level !== "error" && level !== "fatal") return { operation, ...retention };

  const error = message instanceof Error ? message : record?.error;
  const requestedClass = error instanceof Error ? error.name : record?.errorClass;
  const errorClass = typeof requestedClass === "string" && errorClasses.has(requestedClass) ? requestedClass : "Error";
  return { operation, errorClass, ...retention,
    ...(operation === "background_job" ? safeCadImportDiagnosticFields(record) : {}) };
}

function classifyLegacyOperation(message: string) {
  if (/shutdown|close/i.test(message)) return "shutdown";
  if (/startup|starting|initialized|mapped|route/i.test(message)) return "startup";
  if (/mqtt|outbox|publish|message|puback|ack/i.test(message)) return "message_processing";
  if (/worker|sweep|cleanup|prune|report/i.test(message)) return "background_job";
  if (/database|redis|storage|dependency/i.test(message)) return "dependency";
  return "application";
}
