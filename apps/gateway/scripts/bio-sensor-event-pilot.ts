import { open, lstat, realpath } from "node:fs/promises";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { BioDongleClient, type BioClientEvent, type BioOperationControl, type BioVerifiedLampTarget } from "../src/bio/bio-dongle-client";
import { BioDeviceMappingStore } from "../src/bio/bio-device-mapping-store";
import { BioUsbDongleAdapter } from "../src/adapters/bio-usb-dongle-adapter";
import { percentToBioRaw } from "../src/bio/bio-brightness-table";
import { PilotRuntime, type PilotOriginal, type PilotPort, type PilotState } from "./bio-sensor-event-pilot-runtime";

// Fixed, explicitly reviewed trial pair. No generic target or product support registry.
const pair = {
  A: { fixture: "8bd8f767-8aa9-4ea4-881d-754eefc46543", native: "e466e5265fe4", address: 256 },
  B: { fixture: "32f6dcd0-6357-45bb-bd80-a7ec84c71c64", native: "e466e55d7e3d", address: 259 }
} as const;
const mappingPath = "/diag/mapping.json";
const confirmation = "RUN_BIO_A_B_SENSOR_EVENT_PILOT";
export function parsePilotArgs(args: string[]) {
  let run = false, preflight = false, holdSeconds = 60, journalDirectory: string | undefined;
  const seen = new Set<string>();
  for (const arg of args) {
    const key = arg.split("=")[0];
    if (seen.has(key)) throw Error("PILOT_ARGUMENT"); seen.add(key);
    if (arg === "--run") run = true;
    else if (arg === "--preflight") preflight = true;
    else if (arg === `--confirm=${confirmation}`) { /* Exact opt-in, checked below. */ }
    else if (/^--hold-seconds=\d+$/.test(arg)) holdSeconds = Number(arg.split("=")[1]);
    else if (arg.startsWith("--journal-directory=")) journalDirectory = arg.slice("--journal-directory=".length);
    else throw Error("PILOT_ARGUMENT");
  }
  if (!Number.isInteger(holdSeconds) || holdSeconds < 10 || holdSeconds > 1800 || (run && preflight) ||
    (run && (!args.includes(`--confirm=${confirmation}`) || !journalDirectory || !journalDirectory.startsWith("/")))) throw Error("PILOT_ARGUMENT");
  return { run, preflight, holdSeconds, journalDirectory };
}

async function verifyMappings(mappings: BioDeviceMappingStore) {
  for (const member of Object.values(pair)) {
    const row = await mappings.findByFixtureId(member.fixture);
    if (!row || row.status !== "confirmed" || row.deviceUuid !== `bio:${member.native}` || row.nativeUuid !== member.native ||
      row.logicalAddress !== member.address) throw Error("PILOT_MAPPING_UNVERIFIED");
  }
}

/** Append-only, fsync before WRITE; existing paths are never reused/overwritten. */
export async function openPilotJournal(directory: string) {
  const path = resolve(directory), info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o777) !== 0o700 || info.uid !== process.getuid?.() || await realpath(path) !== path) throw Error("PILOT_PRIVATE_DIRECTORY");
  const file = await open(join(path, "pilot-journal.jsonl"), "wx", 0o600);
  const dir = await open(path, "r");
  await dir.sync(); await dir.close();
  return {
    write: async (state: PilotState) => { await file.writeFile(JSON.stringify({ ...state, trialIdentity: pair, fingerprint: "5.5.8/12889/2/1/0/3" }) + "\n"); await file.sync(); },
    close: () => file.close()
  };
}

export function createPilotSession(journal: (state: PilotState) => Promise<void>, holdSeconds: number) {
  const client = new BioDongleClient({ timeoutMs: 1000, observationTimeoutMs: 1500, scanDurationMs: 5000 });
  const mappings = new BioDeviceMappingStore(mappingPath);
  const adapter = new BioUsbDongleAdapter(client, mappings);
  const targets = new Map<"A" | "B", BioVerifiedLampTarget>();
  const discoveries: Extract<BioClientEvent, { kind: "discovery" }>[] = [];
  let armed = false, generation = -1;
  const checkDiscovery = (event: Extract<BioClientEvent, { kind: "discovery" }>) => {
    const matching = Object.values(pair).find(member => event.deviceUuid === `bio:${member.native}` || event.logicalAddress === member.address);
    if (!matching) return;
    if (event.deviceUuid !== `bio:${matching.native}` || event.logicalAddress !== matching.address || event.networkId !== 0 ||
      event.firmware.major !== 5 || event.firmware.minor !== 5 || event.firmware.revision !== 8 || event.firmware.build !== 12889 ||
      event.sensorType !== 2 || event.infraredType !== 1 || event.ambientLightType !== 0 || event.hardwareType !== 3) throw Error("PILOT_DISCOVERY_UNVERIFIED");
  };
  const freshDiscovery = async (control: BioOperationControl) => {
    discoveries.length = 0; await client.scanObservations(control);
    for (const event of discoveries) checkDiscovery(event);
    for (const member of Object.values(pair)) if (!discoveries.some(event => event.deviceUuid === `bio:${member.native}`)) throw Error("PILOT_DISCOVERY_MISSING");
  };
  const assertCurrent = async () => {
    await verifyMappings(mappings);
    const state = client.sensorSourceSnapshot();
    if (!state.transportConnected || !state.protocolReady || state.generation !== generation) throw Error("PILOT_GENERATION_CHANGED");
  };
  const fenced = (control: BioOperationControl): BioOperationControl => ({ ...control, beforeWrite: assertCurrent });
  const readOriginal = async (name: "A" | "B", control: BioOperationControl): Promise<PilotOriginal> => {
    const read = await adapter.readBioState(pair[name].fixture, control), member = pair[name];
    if (read.target.nativeUuid !== member.native || read.target.logicalAddress !== member.address || read.target.networkId !== 0) throw Error("PILOT_TARGET_CHANGED");
    const raw = (await client.readBrightness(read.target, control)).rawHighBrightness;
    if (raw !== percentToBioRaw(read.configuration.configuredHighBrightnessPercent)) throw Error("PILOT_BASE_UNKNOWN");
    targets.set(name, read.target); return { raw, configuration: read.configuration };
  };
  const port: PilotPort = {
    prepare: async control => {
      await verifyMappings(mappings); await client.probe(); await freshDiscovery(control);
      generation = client.sensorSourceSnapshot().generation;
      const originals = { A: await readOriginal("A", control), B: await readOriginal("B", control) };
      // Adapter may scan again; validate every collision/profile observation, not its last-value cache.
      for (const event of discoveries) checkDiscovery(event); await assertCurrent(); armed = true;
      return { generation, originals };
    },
    sensor: async control => {
      await client.setControlMode(targets.get("A")!, "sensor", fenced(control));
      const info = await client.readDeviceInfo(targets.get("A")!, control);
      if (info.mode !== "sensor" || info.networkId !== 0) throw Error("PILOT_SENSOR_MODE_UNKNOWN"); await assertCurrent();
    },
    applyB: async control => {
      await assertCurrent();
      await adapter.restoreBioState(pair.B.fixture, targets.get("B")!, { configuredHighBrightnessPercent: 60, bioMode: "force-on" }, fenced(control));
      await assertCurrent();
    },
    link: async control => {
      await assertCurrent(); const info = await client.readDeviceInfo(targets.get("A")!, control); await assertCurrent();
      return info.mode === "sensor" && info.networkId === 0 && info.deviceUuid === `bio:${pair.A.native}` && info.logicalAddress === pair.A.address;
    },
    restore: async (name, original, control) => {
      // Explicit recovery may rebind only after a fresh full exact-pair discovery.
      if (client.sensorSourceSnapshot().generation !== generation) {
        armed = false; await client.probe(); await freshDiscovery(control); generation = client.sensorSourceSnapshot().generation;
      }
      await assertCurrent();
      await adapter.restoreBioState(pair[name].fixture, targets.get(name)!, original.configuration, fenced(control));
      if ((await client.readBrightness(targets.get(name)!, control)).rawHighBrightness !== original.raw) throw Error("PILOT_RAW_RESTORE_UNKNOWN");
      await assertCurrent();
    },
    close: async () => { armed = false; unsubscribePulse(); unsubscribeEvent(); unsubscribeState(); await client.close(); }
  };
  const runtime = new PilotRuntime({ holdSeconds, journal, port, monotonic: () => performance.now() });
  const unsubscribePulse = client.onSensorPulseCandidate(candidate => { void runtime.pulse(candidate).catch(() => runtime.fault()); });
  const unsubscribeEvent = client.onEvent(event => {
    if (event.kind === "discovery") { discoveries.push(event); if (armed) { try { checkDiscovery(event); } catch { runtime.fault(); } } }
    if (armed && event.kind === "invalid-notification") runtime.fault();
  });
  const unsubscribeState = client.onSensorSourceState(state => {
    if (armed && (!state.transportConnected || !state.protocolReady || state.generation !== generation)) runtime.fault();
  });
  return runtime;
}

export async function main(args = process.argv.slice(2)) {
  const options = parsePilotArgs(args);
  if (!options.run) {
    if (options.preflight) await verifyMappings(new BioDeviceMappingStore(mappingPath));
    console.log(options.preflight ? "PILOT_MAPPING_PREFLIGHT_ONLY_NO_USB" : "PILOT_OPT_IN_REQUIRED_NO_USB"); return;
  }
  // Operational launcher must separately verify stopped original Gateway/exclusive USB.
  // This script never stops/restarts a service, writes mappings, or supplies product health.
  const journal = await openPilotJournal(options.journalDirectory!);
  const runtime = createPilotSession(journal.write, options.holdSeconds);
  const cancel = () => { void runtime.stop().catch(() => {}); };
  process.once("SIGINT", cancel); process.once("SIGTERM", cancel);
  try {
    await runtime.start(); console.log("PILOT_TRIAL_NOTIFICATION_ONLY_STARTED");
    while (!runtime.closed) { await new Promise(resolve => setTimeout(resolve, 200)); await runtime.tick(); }
  } finally {
    await runtime.stop(); process.removeListener("SIGINT", cancel); process.removeListener("SIGTERM", cancel); await journal.close();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => { console.error("PILOT_FAILED_PRIVATE_JOURNAL_REQUIRED"); process.exitCode = 1; });
}
