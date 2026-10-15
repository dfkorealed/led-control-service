import type { NestExpressApplication } from "@nestjs/platform-express";
import type { IncomingMessage, ServerResponse } from "node:http";

const SAFE_HTTP_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export function installGatewayDeploymentReadOnly(
  app: NestExpressApplication,
  env: NodeJS.ProcessEnv
): void {
  const mode = env.GATEWAY_DEPLOYMENT_READ_ONLY;
  if (mode === undefined || mode === "0") return;
  if (mode !== "1") throw new Error("Invalid GATEWAY_DEPLOYMENT_READ_ONLY: expected 0 or 1");

  // HTTP admission only: existing accepted workers/recovery still need a separate drain.
  app.use((request: IncomingMessage, response: ServerResponse, next: () => void) => {
    response.setHeader("X-Kinda-Read-Only", "1");
    if (SAFE_HTTP_METHODS.has(request.method ?? "")) {
      next();
      return;
    }
    response.statusCode = 503;
    response.setHeader("Retry-After", "60");
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.end(JSON.stringify({ statusCode: 503, code: "gateway_deployment_read_only" }));
  });
}
