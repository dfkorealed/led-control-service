import type { INestApplication } from "@nestjs/common";

export function enableApiShutdownHooks(app: Pick<INestApplication, "enableShutdownHooks">) {
  app.enableShutdownHooks();
}
