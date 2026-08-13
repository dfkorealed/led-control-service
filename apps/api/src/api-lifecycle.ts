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

export function createApiRuntimeLifecycle(
  app: { close(): Promise<void> },
  setExitCode: (code: number) => void = code => { process.exitCode = code; }
) {
  let tokenLifecycle: { stop(): void } | undefined;
  let crlLifecycle: { close(): void } | undefined;
  let cleaned = false;

  function cleanup() {
    if (cleaned) return;
    cleaned = true;
    crlLifecycle?.close();
    tokenLifecycle?.stop();
  }

  return {
    setToken(lifecycle: { stop(): void }) { tokenLifecycle = lifecycle; },
    setCrl(lifecycle: { close(): void }) { crlLifecycle = lifecycle; },
    bind(server: { once(event: "close", listener: () => void): unknown }) { server.once("close", cleanup); },
    async failClosed() {
      setExitCode(1);
      cleanup();
      await app.close();
    }
  };
}
