import { createHash } from "node:crypto";
import { watch as watchFile } from "node:fs";
import { basename, dirname } from "node:path";
import { createApiHttpsOptions } from "./api-tls-options";

type ApiTlsContext = NonNullable<ReturnType<typeof createApiHttpsOptions>["httpsOptions"]>;
type WatchDirectory = (path: string, listener: (event: string, filename: string) => void) => { close(): void };
type Logger = Pick<Console, "error">;
type Schedule = (listener: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
type Cancel = (timer: ReturnType<typeof setTimeout>) => void;
type Repeat = (listener: () => void, intervalMs: number) => ReturnType<typeof setInterval>;
type CancelRepeat = (timer: ReturnType<typeof setInterval>) => void;

export function startApiTlsCrlReload({
  crlPaths,
  initialOptions,
  load,
  server,
  logger = console,
  watch = defaultWatch,
  schedule = setTimeout,
  cancel = clearTimeout,
  repeat = setInterval,
  cancelRepeat = clearInterval,
  pollIntervalMs = 1_000
}: {
  crlPaths: string[];
  initialOptions: ApiTlsContext;
  load: () => ApiTlsContext;
  server: { setSecureContext(options: ApiTlsContext): void };
  logger?: Logger;
  watch?: WatchDirectory;
  schedule?: Schedule;
  cancel?: Cancel;
  repeat?: Repeat;
  cancelRepeat?: CancelRepeat;
  pollIntervalMs?: number;
}) {
  let checksum = checksumOf(initialOptions.crl);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const watchedFiles = new Set(crlPaths.map((path) => `${dirname(path)}/${basename(path)}`));
  const watchedDirectories = [...new Set(crlPaths.map(dirname))];
  const watchers = watchedDirectories.map((directory) => watch(directory, (_event, changedFilename) => {
    if (!watchedFiles.has(`${directory}/${changedFilename}`)) return;
    if (timer) cancel(timer);
    timer = schedule(reload, 200);
  }));
  // A generation pointer can keep the same filename while its target changes, so
  // directory events are only an optimization; polling is the revocation backstop.
  const poller = repeat(reload, pollIntervalMs);

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
      cancelRepeat(poller);
      watchers.forEach((watcher) => watcher.close());
    }
  };
}

function defaultWatch(path: string, listener: (event: string, filename: string) => void) {
  return watchFile(path, { persistent: false }, (event, filename) => {
    if (filename) listener(event, filename.toString());
  });
}

function checksumOf(content: Buffer | Buffer[]) {
  const values = Array.isArray(content) ? content : [content];
  return createHash("sha256").update(Buffer.concat(values)).digest("hex");
}
