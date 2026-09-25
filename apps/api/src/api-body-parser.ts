import { EDITOR_MAX_BODY_BYTES } from "@led-control/shared";
import { NestExpressApplication } from "@nestjs/platform-express";
import { IncomingMessage } from "node:http";

export function configureApiBodyParser(app: NestExpressApplication) {
  const isJson = (request: IncomingMessage) => /^application\/json(?:\s*;|$)/i.test(request.headers["content-type"] ?? "");
  const isEditor = (request: IncomingMessage) => /^\/floors\/[^/]+\/(?:editor-state\/?|editor-stages(?:\/[^/?]+(?:\/(?:parts\/[0-9]+|commit|prepare))?)?\/?)(?:\?|$)/.test(request.url ?? "");
  const isLandingInquiry = (request: IncomingMessage) => /^\/landing\/inquiries\/?(?:\?|$)/.test(request.url ?? "");
  app.useBodyParser("json", { limit: EDITOR_MAX_BODY_BYTES, type: (req) => isJson(req) && isEditor(req) });
  app.useBodyParser("json", { limit: "4kb", type: (req) => isJson(req) && isLandingInquiry(req) });
  app.useBodyParser("json", { limit: "100kb", type: (req) => isJson(req) && !isEditor(req) && !isLandingInquiry(req) });
  app.use((error: { type?: string }, request: IncomingMessage, response: { status(code: number): { json(body: unknown): void } }, next: (error: unknown) => void) => {
    if (error?.type === "entity.too.large") {
      if (isLandingInquiry(request)) {
        response.status(400).json({ statusCode: 400, code: "LANDING_INQUIRY_INVALID", message: "문의 내용을 확인해 주세요." });
        return;
      }
      response.status(413).json({ statusCode: 413, code: "request_body_too_large", message: "request body exceeds the allowed size" });
      return;
    }
    next(error);
  });
}
