import { MODULE_METADATA } from "@nestjs/common/constants";
import { Test } from "@nestjs/testing";
import * as fs from "node:fs";
import fsp = require("node:fs/promises");
import cp = require("node:child_process");
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { MqttModule } from "./mqtt.module";
import { COMMAND_DB_CLOCK_EVIDENCE_SOURCE, CommandDbClockHealth } from "./command-db-clock-health.service";
import { createConfiguredCommandDbClockEvidenceSource, UnixCommandDbClockEvidenceSource } from "./command-db-clock-evidence-source";

const fixtures = JSON.parse(fs.readFileSync(resolve(__dirname, "../../../../scripts/clock-attestor/fixtures/evidence-v1.json"), "utf8"));
const protocol = JSON.parse(fs.readFileSync(resolve(__dirname, "../../../../scripts/clock-attestor/protocol-v1.json"), "utf8"));
const sample = fixtures.valid.find((f: any) => f.name === "signed_evidence").wire as string;
const canonicalPath = "/Library/Application Support/Kinda/ClockAttestor/runtime/evidence.sock";
const producerUid = 601, producerGid = 602;
const config = () => ({ version: 1, producerUid, producerGid, apiUid: process.getuid!(),
  primary: { startedAt: "2026-10-15T00:00:00.000Z", address: "127.0.0.1", port: 5432, pid: 1234,
    processStartedAt: "Thu Oct 15 09:00:00 2026", dataDirectory: "/native/postgres/data", executable: "/native/bin/postgres" },
  sourceCommit: "a".repeat(40), fileHashes: Object.fromEntries(["core.py", "daemon.py", "installer.py", "operator.py", "protocol-v1.json"].map(name => [name, "b".repeat(64)])) });
const configBytes = (value: any): string => JSON.stringify(value, [...new Set(Object.keys(value).concat(Object.keys(value.primary), Object.keys(value.fileHashes)))].sort()) + "\n";

describe("protected Unix DB clock evidence reader", () => {
  let directory: string, runtime: string, path: string, configPath: string, server: Server;
  let respond: (socket: Socket, nonce: string) => void;
  let metadata: (path: string, stat: fs.Stats) => fs.Stats;
  let configValue: any;
  const sockets = new Set<Socket>();
  const reply = (nonce: string, raw = sample) => raw.replaceAll("22222222-2222-4222-8222-222222222222", nonce);
  beforeEach(async () => {
    directory = fs.mkdtempSync(join(fs.realpathSync(tmpdir()), "clock-reader-"));
    runtime = join(directory, "runtime"); fs.mkdirSync(runtime); path = join(runtime, "evidence.sock");
    configPath = join(directory, "config.json"); configValue = config(); fs.writeFileSync(configPath, configBytes(configValue));
    metadata = (_path, stat) => stat;
    const actualStat = fsp.lstat.bind(fsp), actualOpen = fsp.open.bind(fsp);
    const protectedStat = (name: string, stat: fs.Stats) => metadata(name, Object.assign(stat, {
      uid: name === runtime || name === path ? producerUid : 0,
      gid: name === runtime || name === path ? producerGid : 0,
      mode: (stat.mode & ~0o7777) | (name === path ? 0o666 : name === configPath ? 0o644 : 0o755)
    }));
    jest.spyOn(fsp, "lstat").mockImplementation((async (name: fs.PathLike) => protectedStat(String(name), await actualStat(name))) as typeof fsp.lstat);
    jest.spyOn(fsp, "open").mockImplementation((async (...args: Parameters<typeof fsp.open>) => {
      const handle = await actualOpen(...args); const stat = handle.stat.bind(handle);
      jest.spyOn(handle, "stat").mockImplementation((async () => protectedStat(String(args[0]), await stat())) as typeof handle.stat);
      return handle;
    }) as typeof fsp.open);
    jest.spyOn(cp, "execFile").mockImplementation(((...args: any[]) => {
      args.at(-1)(null, "drwxr-xr-x  root wheel protected\n", ""); return {};
    }) as typeof cp.execFile);
    jest.spyOn(Date, "now").mockReturnValue(Date.parse("2026-10-15T00:00:00.400Z"));
    respond = (socket, nonce) => socket.end(reply(nonce));
    server = createServer({ allowHalfOpen: true }, socket => {
      sockets.add(socket); socket.on("close", () => sockets.delete(socket)); socket.on("error", () => {});
      let request = ""; socket.on("data", chunk => request += chunk);
      socket.on("end", () => {
        const parsed = JSON.parse(request);
        expect(request).toBe(`{"nonce":"${parsed.nonce}","op":"read","version":1}\n`);
        respond(socket, parsed.nonce);
      });
    });
    await new Promise<void>(done => server.listen(path, done));
  });
  afterEach(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(done => server.close(() => done()));
    jest.restoreAllMocks(); fs.rmSync(directory, { recursive: true, force: true });
  });
  const read = () => new UnixCommandDbClockEvidenceSource(path).read();

  it("maps only healthy canonical signed evidence, retaining original issue time, offset and primary", async () => {
    expect(protocol.$defs.evidence.required).toContain("uncertaintyMs");
    expect(await read()).toEqual({ issuedAt: new Date("2026-10-15T00:00:00.300Z"), offsetMs: -58.639,
      stepGeneration: 1, clearedStepGeneration: 1, failoverGeneration: 0, clearedFailoverGeneration: 0,
      primary: { startedAt: new Date("2026-10-15T00:00:00.000Z"), address: "127.0.0.1", port: 5432 } });
  });
  it.each(fixtures.invalid.filter((f: any) => f.direction === "response").map((f: any): [string, string] => [f.name, f.wire]) as [string, string][])
  ("rejects shared invalid wire %s", async (_name, raw) => {
    respond = (socket, nonce) => socket.end(reply(nonce, raw)); expect(await read()).toBeNull();
  });
  it.each([
    ["offsetMs", "1e-12"], ["offsetMs", "0.001000000001"],
    ["uncertaintyMs", "1e-12"], ["uncertaintyMs", "0.001000000001"],
    ["readBracketMs", "1e-12"], ["readBracketMs", "0.001000000001"]
  ])("rejects an otherwise healthy wire with only %s changed to %s", async (key, token) => {
    const raw = sample.replace(new RegExp(`"${key}":[^,}]+`), `"${key}":${token}`);
    expect(JSON.parse(raw)).toEqual({ ...JSON.parse(sample), [key]: Number(token) });
    respond = (socket, nonce) => socket.end(reply(nonce, raw));
    expect(await read()).toBeNull();
  });
  it.each([
    ["offsetMs", "-0.001", -0.001], ["offsetMs", "0.001", 0.001],
    ["uncertaintyMs", "0.001", -58.639], ["readBracketMs", "0.001", -58.639]
  ])("preserves healthy three-decimal %s=%s", async (key, token, offsetMs) => {
    const raw = sample.replace(new RegExp(`"${key}":[^,}]+`), `"${key}":${token}`);
    respond = (socket, nonce) => socket.end(reply(nonce, raw));
    expect(await read()).toMatchObject({ offsetMs, issuedAt: new Date("2026-10-15T00:00:00.300Z") });
  });
  it.each([
    ["wrong nonce", (v: any) => { v.nonce = "99999999-9999-4999-8999-999999999999"; }],
    ["stale", (v: any) => { v.issuedAt = "2026-10-14T23:59:59.399Z"; }],
    ["future", (v: any) => { v.issuedAt = "2026-10-15T00:00:00.501Z"; }],
    ["uncertainty budget", (v: any) => { v.uncertaintyMs = 40; }],
    ["bracket budget", (v: any) => { v.readBracketMs = 40; }],
    ["uncleared generation", (v: any) => { v.clearedStepGeneration = 0; }],
    ["non-local primary", (v: any) => { v.primary.address = "192.0.2.1"; }],
    ["different configured primary", (v: any) => { v.primary.port = 5433; }]
  ])("rejects %s", async (_name, mutate) => {
    respond = (socket, nonce) => { const value = JSON.parse(reply(nonce)); mutate(value); socket.end(JSON.stringify(value) + "\n"); };
    expect(await read()).toBeNull();
  });
  it("accepts the exact 100ms total budget boundary", async () => {
    respond = (socket, nonce) => socket.end(reply(nonce, fixtures.valid.find((f: any) => f.name === "exact_100ms_evidence").wire));
    expect(await read()).toMatchObject({ offsetMs: -90 });
  });
  it("retains cached issuedAt for a fresh nonce and checks reader evidence against the same DB transaction", async () => {
    const nonces: string[] = [];
    respond = (socket, nonce) => { nonces.push(nonce); socket.end(reply(nonce)); };
    const source = new UnixCommandDbClockEvidenceSource(path);
    const health = new CommandDbClockHealth(source);
    const tx = (serverPort = 5432) => ({ $queryRaw: async () => [{ dbNow: new Date("2026-10-15T00:00:00.400Z"),
      isReplica: false, primaryStartedAt: new Date("2026-10-15T00:00:00.000Z"), serverAddress: "127.0.0.1", serverPort }] });
    await expect(health.assertHealthy(tx() as never)).resolves.toEqual(new Date("2026-10-15T00:00:00.400Z"));
    await expect(health.assertHealthy(tx(5433) as never)).rejects.toThrow("not current for primary");
    expect(await source.read()).toMatchObject({ issuedAt: new Date("2026-10-15T00:00:00.300Z") });
    expect(new Set(nonces).size).toBe(3);
    await expect(health.assertHealthy(tx() as never, 7)).rejects.toThrow("durable epoch continuity unavailable");
  });
  it.each(["partial", "oversize", "late trailing", "no EOF", "drip feed"])("rejects %s response under an absolute 1s deadline", async kind => {
    const timers: NodeJS.Timeout[] = [];
    respond = (socket, nonce) => {
      if (kind === "partial") socket.end(reply(nonce).slice(0, -1));
      if (kind === "oversize") socket.end("x".repeat(16385));
      if (kind === "late trailing") { socket.write(reply(nonce)); timers.push(setTimeout(() => socket.end("x"), 20)); }
      if (kind === "no EOF") socket.write(reply(nonce));
      if (kind === "drip feed") timers.push(setInterval(() => socket.write(" "), 100));
    };
    const started = performance.now();
    try { expect(await read()).toBeNull(); expect(performance.now() - started).toBeLessThan(1300); }
    finally { timers.forEach(clearTimeout); }
  });
  it.each(["socket symlink", "socket file", "socket owner", "socket mode", "ancestor writable", "ancestor owner", "ancestor symlink", "runtime owner", "runtime mode", "config owner", "config mode", "config symlink"])
  ("rejects unprotected %s metadata", async kind => {
    metadata = (name, stat) => {
      if (name === path && kind === "socket symlink" || name === directory && kind === "ancestor symlink" || name === configPath && kind === "config symlink") stat.isSymbolicLink = () => true;
      if (name === path && kind === "socket file") stat.isSocket = () => false;
      if (name === path && kind === "socket owner" || name === runtime && kind === "runtime owner" || name === directory && kind === "ancestor owner" || name === configPath && kind === "config owner") stat.uid = process.getuid!();
      if (name === path && kind === "socket mode") stat.mode = 0o140660;
      if (name === directory && kind === "ancestor writable") stat.mode |= 0o020;
      if (name === runtime && kind === "runtime mode") stat.mode = 0o40777;
      if (name === configPath && kind === "config mode") stat.mode = 0o100664;
      return stat;
    };
    expect(await read()).toBeNull();
  });
  it.each([0, 65534, -2, process.getuid!()])("rejects producer identity %s", async uid => {
    configValue.producerUid = uid; fs.writeFileSync(configPath, configBytes(configValue)); expect(await read()).toBeNull();
  });
  it.each(["config", "socket", "ancestor"])("rejects replaced %s identity during response", async kind => {
    respond = (socket, nonce) => { const target = kind === "config" ? configPath : kind === "socket" ? path : directory;
      metadata = (name, stat) => { if (name === target) stat.ino += 1; return stat; }; socket.end(reply(nonce)); };
    expect(await read()).toBeNull();
  });
  it("rejects changed owner after the connection and a different opened config inode", async () => {
    respond = (socket, nonce) => { metadata = (name, stat) => { if (name === path) stat.uid = process.getuid!(); return stat; }; socket.end(reply(nonce)); };
    expect(await read()).toBeNull();
    let configReads = 0;
    metadata = (name, stat) => { if (name === configPath && ++configReads === 2) stat.ino += 1; return stat; };
    expect(await read()).toBeNull();
  });
  it.each(["extra config key", "missing primary key", "extra primary key", "wrong API UID", "non-local config", "duplicate config key"])
  ("rejects installed config drift: %s", async kind => {
    if (kind === "extra config key") configValue.offsetMs = 0;
    if (kind === "missing primary key") delete configValue.primary.pid;
    if (kind === "extra primary key") configValue.primary.extra = 0;
    if (kind === "wrong API UID") configValue.apiUid += 1;
    if (kind === "non-local config") configValue.primary.address = "192.0.2.1";
    const raw = configBytes(configValue);
    fs.writeFileSync(configPath, kind === "duplicate config key" ? raw.replace('"version":1', '"version":1,"version":1') : raw);
    expect(await read()).toBeNull();
  });
  it("rejects extended ACLs even with protected POSIX modes", async () => {
    (cp.execFile as unknown as jest.Mock).mockImplementation((...args: any[]) => { args.at(-1)(null, "drwxr-xr-x+ root wheel protected\n 0: user allow write\n", ""); });
    expect(await read()).toBeNull();
  });
  it("bounds hung metadata inspection by the same absolute 1s deadline", async () => {
    (cp.execFile as unknown as jest.Mock).mockImplementation(() => ({}));
    const started = performance.now(); expect(await read()).toBeNull();
    expect(performance.now() - started).toBeLessThan(1300);
  });
  it("keeps factory default-off and rejects arbitrary or normalized aliases", () => {
    for (const value of [undefined, "", path, `${dirname(canonicalPath)}/../runtime/evidence.sock`, `${canonicalPath}/`, "relative.sock"])
      expect(createConfiguredCommandDbClockEvidenceSource({ COMMAND_DB_CLOCK_SOCKET_PATH: value })).toBeUndefined();
    const source = createConfiguredCommandDbClockEvidenceSource({ COMMAND_DB_CLOCK_SOCKET_PATH: canonicalPath });
    expect(source).toBeInstanceOf(UnixCommandDbClockEvidenceSource); expect(source?.readEpochContinuity).toBeUndefined();
  });
  it.each([false, true])("uses the actual Nest source binding (configured=%s) and keeps epoch unsupported", async configured => {
    const previous = process.env.COMMAND_DB_CLOCK_SOCKET_PATH;
    if (configured) process.env.COMMAND_DB_CLOCK_SOCKET_PATH = canonicalPath; else delete process.env.COMMAND_DB_CLOCK_SOCKET_PATH;
    try {
      const binding = Reflect.getMetadata(MODULE_METADATA.PROVIDERS, MqttModule).find((p: any) => p.provide === COMMAND_DB_CLOCK_EVIDENCE_SOURCE);
      expect(binding).toBeDefined();
      const module = await Test.createTestingModule({ providers: [binding, CommandDbClockHealth] }).compile();
      try {
        const source = module.get(COMMAND_DB_CLOCK_EVIDENCE_SOURCE);
        if (configured) expect(source).toBeInstanceOf(UnixCommandDbClockEvidenceSource); else expect(source).toBeUndefined();
        await expect(module.get(CommandDbClockHealth).assertHealthy({} as never, 7)).rejects.toThrow("durable epoch continuity unavailable");
      } finally { await module.close(); }
    } finally { if (previous === undefined) delete process.env.COMMAND_DB_CLOCK_SOCKET_PATH; else process.env.COMMAND_DB_CLOCK_SOCKET_PATH = previous; }
  });
});
