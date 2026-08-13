import type { INestApplication } from "@nestjs/common";

export function enableApiShutdownHooks(app: Pick<INestApplication, "enableShutdownHooks">) {
  app.enableShutdownHooks();
}

export function bindLifecycleToServerClose(
  server: { once(event: "close", listener: () => void): unknown },
  lifecycle: { stop(): void }
) {
  server.once("close", () => lifecycle.stop());
}
