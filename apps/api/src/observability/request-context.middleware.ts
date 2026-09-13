import { Inject, Injectable, NestMiddleware } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { performance } from "node:perf_hooks";
import { ObservabilityMetrics } from "./observability-metrics.service";

const safeRequestId = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
export const OBSERVABILITY_HTTP_LOGGER = Symbol("OBSERVABILITY_HTTP_LOGGER");
export interface HttpRequestLogger {
  logHttpRequest(fields: { method: string; route: string; statusCode: number; durationMs: number }): void;
}

interface HttpRequest {
  header(name: string): string | undefined;
  method: string;
  route?: { path?: unknown };
  baseUrl: string;
  path: string;
}

interface HttpResponse {
  statusCode: number;
  setHeader(name: string, value: string): void;
  once(event: "finish" | "close", listener: () => void): unknown;
}

@Injectable()
export class RequestContext {
  private readonly storage = new AsyncLocalStorage<{ requestId: string }>();

  run<T>(requestId: string, callback: () => T): T {
    return this.storage.run({ requestId }, callback);
  }

  getRequestId(): string | undefined {
    return this.storage.getStore()?.requestId;
  }
}

@Injectable()
export class RequestContextMiddleware implements NestMiddleware {
  constructor(
    private readonly context: RequestContext,
    private readonly metrics: ObservabilityMetrics,
    @Inject(OBSERVABILITY_HTTP_LOGGER) private readonly logger: HttpRequestLogger
  ) {}

  use(request: HttpRequest, response: HttpResponse, next: () => void) {
    const supplied = request.header("x-request-id")?.trim();
    const requestId = supplied && safeRequestId.test(supplied) ? supplied : randomUUID();
    const startedAt = performance.now();
    let completed = false;
    response.setHeader("X-Request-Id", requestId);

    const complete = () => {
      if (completed) return;
      completed = true;
      const durationMs = Math.round((performance.now() - startedAt) * 100) / 100;
      this.context.run(requestId, () => {
        this.metrics.recordHttp(response.statusCode, durationMs);
        this.logger.logHttpRequest({
          method: request.method,
          route: routeTemplate(request),
          statusCode: response.statusCode,
          durationMs
        });
      });
    };
    response.once("finish", complete);
    response.once("close", complete);
    this.context.run(requestId, next);
  }
}

function routeTemplate(request: HttpRequest) {
  const routePath = request.route?.path;
  if (typeof routePath === "string") return `${request.baseUrl}${routePath}` || "/";
  // Parser and 404 failures may not expose a route template. A fixed fallback keeps
  // tenant slugs and raw device identifiers out of both logs and metric dimensions.
  return "/:unmatched";
}
