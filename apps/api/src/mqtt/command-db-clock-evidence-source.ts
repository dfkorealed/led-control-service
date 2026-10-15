import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as cp from "node:child_process";
import { randomUUID } from "node:crypto";
import { createConnection, isIP } from "node:net";
import { basename, dirname, isAbsolute } from "node:path";
import type { CommandDbClockEvidenceSource, CommandDbClockEvidence } from "./command-db-clock-health.service";

const SOCKET_PATH = "/Library/Application Support/Kinda/ClockAttestor/runtime/evidence.sock";
const MAX_BYTES = 16_384;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ARTIFACTS = ["core.py", "daemon.py", "installer.py", "operator.py", "protocol-v1.json"];
type ObjectValue = Record<string, any>;
interface Boundary { identity: string; primary: ObjectValue }

/** The optional path is an isolated IPC fixture seam. Production configuration is
 * pinned below; every path, including fixtures, receives the same protection checks. */
export class UnixCommandDbClockEvidenceSource implements CommandDbClockEvidenceSource {
  constructor(private readonly socketPath: string = SOCKET_PATH) {}

  async read(): Promise<CommandDbClockEvidence | null> {
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const deadline = performance.now() + 1_000;
    const timeout = new Promise<null>(done => {
      timer = setTimeout(() => { controller.abort(); done(null); }, 1_000);
    });
    const work = async () => {
      const before = await this.inspect(deadline, controller.signal);
      const nonce = randomUUID();
      const raw = await this.exchange(nonce, deadline, controller.signal);
      const after = await this.inspect(deadline, controller.signal);
      if (before.identity !== after.identity) return null;
      return parseEvidence(raw, nonce, before.primary);
    };
    try { return await Promise.race([work().catch(() => null), timeout]); }
    finally { if (timer) clearTimeout(timer); controller.abort(); }
  }

  private async inspect(deadline: number, signal: AbortSignal): Promise<Boundary> {
    const prefix = dirname(dirname(this.socketPath));
    const identities: unknown[] = [];
    const inspect = async (path: string, uid: number, mode?: number, kind: "directory" | "file" | "socket" = "directory") => {
      remaining(deadline, signal);
      const stat = await fsp.lstat(path);
      if (stat.isSymbolicLink() || stat.uid !== uid || (mode === undefined ? (stat.mode & 0o022) !== 0 : (stat.mode & 0o7777) !== mode) ||
        !(kind === "directory" ? stat.isDirectory() : kind === "file" ? stat.isFile() : stat.isSocket())) throw new Error("unprotected boundary");
      await noAcl(path, deadline, signal);
      identities.push([path, fingerprint(stat)]);
      return stat;
    };
    // Check each ancestor by lstat (never follow a symlink), including the root.
    for (let path = prefix; ; path = dirname(path)) {
      await inspect(path, 0, path === prefix ? 0o755 : undefined);
      if (dirname(path) === path) break;
    }
    const configPath = `${prefix}/config.json`;
    const named = await inspect(configPath, 0, 0o644, "file");
    remaining(deadline, signal);
    const handle = await fsp.open(configPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    let raw: string;
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || fingerprint(opened) !== fingerprint(named) || opened.size > MAX_BYTES) throw new Error("config changed");
      const buffer = Buffer.alloc(MAX_BYTES + 1);
      let size = 0;
      while (size < buffer.length) {
        remaining(deadline, signal);
        const result = await handle.read(buffer, size, buffer.length - size, null);
        if (result.bytesRead === 0) break;
        size += result.bytesRead;
      }
      if (size > MAX_BYTES || fingerprint(await handle.stat()) !== fingerprint(opened)) throw new Error("config changed");
      raw = buffer.toString("utf8", 0, size);
    } finally { await handle.close(); }
    const config = parseConfig(raw);
    identities.push(raw);
    const runtime = await inspect(dirname(this.socketPath), config.producerUid, 0o755);
    const socket = await inspect(this.socketPath, config.producerUid, 0o666, "socket");
    if (runtime.gid !== config.producerGid || socket.gid !== config.producerGid) throw new Error("producer group changed");
    remaining(deadline, signal);
    return { identity: JSON.stringify(identities), primary: config.primary };
  }

  private exchange(nonce: string, deadline: number, signal: AbortSignal): Promise<Buffer> {
    remaining(deadline, signal);
    return new Promise((resolve, reject) => {
      const socket = createConnection({ path: this.socketPath, allowHalfOpen: true });
      const chunks: Buffer[] = []; let size = 0, settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true; signal.removeEventListener("abort", aborted); socket.destroy();
        if (error) reject(error); else resolve(Buffer.concat(chunks, size));
      };
      const aborted = () => finish(new Error("clock IPC deadline"));
      signal.addEventListener("abort", aborted, { once: true });
      socket.on("error", () => finish(new Error("clock IPC unavailable")));
      socket.on("connect", () => {
        if (signal.aborted || performance.now() >= deadline) return aborted();
        // Producer reads through EOF before responding; an ordinary write deadlocks.
        socket.end(`{"nonce":"${nonce}","op":"read","version":1}\n`);
      });
      socket.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_BYTES) return finish(new Error("clock IPC frame too large"));
        chunks.push(chunk);
      });
      socket.on("end", () => performance.now() >= deadline ? aborted() : finish());
      socket.on("close", () => { if (!settled) finish(new Error("clock IPC incomplete")); });
    });
  }
}

export function createConfiguredCommandDbClockEvidenceSource(env: NodeJS.ProcessEnv): CommandDbClockEvidenceSource | undefined {
  return env.COMMAND_DB_CLOCK_SOCKET_PATH === SOCKET_PATH ? new UnixCommandDbClockEvidenceSource() : undefined;
}

function remaining(deadline: number, signal: AbortSignal): number {
  const value = Math.ceil(deadline - performance.now());
  if (signal.aborted || value <= 0) throw new Error("clock reader deadline");
  return value;
}

async function noAcl(path: string, deadline: number, signal: AbortSignal): Promise<void> {
  const output = await new Promise<string>((resolve, reject) => {
    cp.execFile("/bin/ls", ["-lde", path], { encoding: "utf8", timeout: remaining(deadline, signal), signal,
      maxBuffer: 4096, env: { PATH: "/usr/bin:/bin", LC_ALL: "C" } }, (error, stdout, stderr) => {
      if (error || stderr) reject(new Error("clock boundary ACL unavailable")); else resolve(stdout);
    });
  });
  const lines = output.trimEnd().split("\n");
  if (lines.length !== 1 || !lines[0] || lines[0].split(/\s+/)[0].includes("+")) throw new Error("clock boundary ACL present");
  remaining(deadline, signal);
}

function fingerprint(stat: fs.Stats): string {
  return JSON.stringify([stat.dev, stat.ino, stat.uid, stat.gid, stat.mode, stat.size, stat.mtimeMs, stat.ctimeMs]);
}

function exact(value: unknown, keys: string[]): value is ObjectValue {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
}
function date(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}
function generation(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function primary(value: unknown): value is ObjectValue {
  return exact(value, ["startedAt", "address", "port"]) && date(value.startedAt) &&
    (value.address === null || typeof value.address === "string" && isIP(value.address) !== 0) &&
    (value.port === null || Number.isSafeInteger(value.port) && value.port >= 1 && value.port <= 65535);
}
function local(address: unknown): boolean {
  return typeof address === "string" && (isIP(address) === 4 && address.startsWith("127.") || address === "::1");
}
function canonical(value: any): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
}

function parseConfig(raw: string): ObjectValue {
  const value = JSON.parse(raw);
  // Installer emits sorted ASCII JSON plus LF. Comparing its normalized domain
  // catches duplicate/prototype keys before the UID can become a trust anchor.
  const normalized = canonical(value).replace(/[\u007f-\uffff]/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`) + "\n";
  if (raw !== normalized || !exact(value, ["version", "producerUid", "producerGid", "apiUid", "primary", "sourceCommit", "fileHashes"]) || value.version !== 1 ||
    typeof process.getuid !== "function" || value.apiUid !== process.getuid() ||
    ![value.apiUid, value.producerUid, value.producerGid].every(uid => Number.isSafeInteger(uid) && uid >= 501 && uid <= 2147483647 && uid !== 65534) ||
    value.producerUid === value.apiUid || !exact(value.primary, ["startedAt", "address", "port", "pid", "processStartedAt", "dataDirectory", "executable"]) ||
    !primary({ startedAt: value.primary.startedAt, address: value.primary.address, port: value.primary.port }) || !local(value.primary.address) || value.primary.port === null ||
    !Number.isSafeInteger(value.primary.pid) || value.primary.pid <= 0 || typeof value.primary.processStartedAt !== "string" || !value.primary.processStartedAt ||
    ![value.primary.dataDirectory, value.primary.executable].every(path => typeof path === "string" && isAbsolute(path) && !path.split("/").includes("..")) ||
    basename(value.primary.executable) !== "postgres" || typeof value.sourceCommit !== "string" || !/^[0-9a-f]{40}$/.test(value.sourceCommit) ||
    !exact(value.fileHashes, ARTIFACTS) || !Object.values(value.fileHashes).every(hash => typeof hash === "string" && /^[0-9a-f]{64}$/.test(hash))) throw new Error("clock config invalid");
  return value;
}

function parseEvidence(raw: Buffer, nonce: string, configuredPrimary: ObjectValue): CommandDbClockEvidence | null {
  const text = raw.toString("utf8"); const value = JSON.parse(text);
  if (canonical(value) + "\n" !== text || !Buffer.from(text).equals(raw) ||
    !exact(value, ["version", "nonce", "producerBootId", "observationId", "issuedAt", "offsetMs", "uncertaintyMs", "readBracketMs", "stepGeneration", "clearedStepGeneration", "failoverGeneration", "clearedFailoverGeneration", "primary"]) ||
    value.version !== 1 || value.nonce !== nonce || !UUID.test(value.producerBootId) || !UUID.test(value.observationId) || !date(value.issuedAt) || !primary(value.primary)) return null;
  for (const key of ["offsetMs", "uncertaintyMs", "readBracketMs"]) {
    const number = value[key];
    if (typeof number !== "number" || !Number.isFinite(number) || Math.abs(number * 1000 - Math.round(number * 1000)) > 1e-8 ||
      (key !== "offsetMs" && number < 0)) return null;
  }
  const budget = Math.abs(Math.round(value.offsetMs * 1000)) + Math.round(value.uncertaintyMs * 1000) + Math.round(value.readBracketMs * 1000) + 2000;
  const age = Date.now() - Date.parse(value.issuedAt);
  if (budget > 100_000 || age < -100 || age > 1_000 ||
    ![value.stepGeneration, value.clearedStepGeneration, value.failoverGeneration, value.clearedFailoverGeneration].every(generation) ||
    value.stepGeneration !== value.clearedStepGeneration || value.failoverGeneration !== value.clearedFailoverGeneration ||
    ["startedAt", "address", "port"].some(key => value.primary[key] !== configuredPrimary[key])) return null;
  return { issuedAt: new Date(value.issuedAt), offsetMs: value.offsetMs, stepGeneration: value.stepGeneration,
    clearedStepGeneration: value.clearedStepGeneration, failoverGeneration: value.failoverGeneration,
    clearedFailoverGeneration: value.clearedFailoverGeneration,
    primary: { startedAt: new Date(value.primary.startedAt), address: value.primary.address, port: value.primary.port } };
}
