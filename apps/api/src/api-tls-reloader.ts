import { createHash } from "node:crypto";
import { watch as watchFile } from "node:fs";
import { basename, dirname } from "node:path";
import { createApiHttpsOptions } from "./api-tls-options";

type ApiTlsContext = NonNullable<ReturnType<typeof createApiHttpsOptions>["httpsOptions"]>;
type WatchDirectory = (path: string, listener: (event: string, filename: string) => void) => { close(): void };
type Logger = Pick<Console, "error">;
type Schedule = (listener: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
type Cancel = (timer: ReturnType<typeof setTimeout>) => void;

export function startApiTlsCrlReload({
  crlPath,
  initialOptions,
  load,
  server,
  logger = console,
  watch = defaultWatch,
  schedule = setTimeout,
  cancel = clearTimeout
}: {
  crlPath: string;
  initialOptions: ApiTlsContext;
  load: () => ApiTlsContext;
  server: { setSecureContext(options: ApiTlsContext): void };
  logger?: Logger;
  watch?: WatchDirectory;
  schedule?: Schedule;
  cancel?: Cancel;
}) {
  let checksum = checksumOf(initialOptions.crl);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const filename = basename(crlPath);
  const watcher = watch(dirname(crlPath), (_event, changedFilename) => {
    if (changedFilename !== filename) return;
    if (timer) cancel(timer);
    timer = schedule(reload, 200);
  });

  function reload() {
    timer = undefined;
    try {
      const next = load();
      const nextChecksum = checksumOf(next.crl);
      if (nextChecksum === checksum) return;
      server.setSecureContext(next);
      checksum = nextChecksum;
    } catch {
      logger.error("[tls] HTTPS secure context reload failed; retaining the existing context.");
    }
  }

  return {
    close() {
      if (timer) cancel(timer);
      watcher.close();
    }
  };
}

function defaultWatch(path: string, listener: (event: string, filename: string) => void) {
  return watchFile(path, { persistent: false }, (event, filename) => {
    if (filename) listener(event, filename.toString());
  });
}

function checksumOf(content: Buffer) {
  return createHash("sha256").update(content).digest("hex");
}
