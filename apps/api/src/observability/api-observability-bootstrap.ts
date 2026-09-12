import { LoggerService, NestApplicationOptions } from "@nestjs/common";
import { RequestContext, RequestContextMiddleware } from "./request-context.middleware";
import { StructuredLoggerService } from "./structured-logger.service";

export function createBootstrapStructuredLogger(
  writeLine: (line: string) => void = (line) => { process.stdout.write(line); },
  clock: () => Date = () => new Date()
) {
  return new StructuredLoggerService(new RequestContext(), writeLine, clock);
}

export function createApiNestOptions<T extends object>(
  options: T,
  bootstrapLogger: LoggerService
): T & NestApplicationOptions {
  return {
    ...options,
    logger: bootstrapLogger,
    bufferLogs: true,
    autoFlushLogs: true
  };
}

export function reportApiBootstrapFailure(logger: Pick<LoggerService, "error">) {
  logger.error(
    { operation: "startup", errorClass: "Error" },
    undefined,
    "NestFactory"
  );
}

export function installApiObservability(
  app: {
    get(token: typeof StructuredLoggerService | typeof RequestContextMiddleware): StructuredLoggerService | RequestContextMiddleware;
    useLogger(logger: LoggerService): unknown;
    use(middleware: (...args: never[]) => unknown): unknown;
  }
) {
  const logger = app.get(StructuredLoggerService) as StructuredLoggerService;
  app.useLogger(logger);
  const requestContext = app.get(RequestContextMiddleware) as RequestContextMiddleware;
  app.use(requestContext.use.bind(requestContext));
}
