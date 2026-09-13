import { pathToFileURL } from "node:url";
import type { BioByteConnection } from "../src/bio/bio-byte-connection";
import type { BioFrame, BioProtocol } from "../src/bio/bio-frame-codec";
import { BioUsbTransport } from "../src/bio/bio-usb-transport";
import { BioUsbError } from "../src/bio/bio-usb-error";
import { decodeBioResponse } from "../src/bio/bio-command-codec";

interface ProbeOptions {
  devicePath: string;
  protocol: BioProtocol;
  profile: "legacy" | "android-v1.2.0";
  timeoutMs: number;
}
type ProbeDependencies = {
  connectionFactory?: (devicePath: string) => BioByteConnection;
  output?: (line: string) => void;
};

function parseArguments(args: string[]): ProbeOptions {
  const options: ProbeOptions = {
    devicePath: "/dev/serial/by-id/usb-1a86_CH57x-if00-port0",
    protocol: "crc16",
    profile: "android-v1.2.0",
    timeoutMs: 300
  };
  const seen = new Set<string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!value || seen.has(key)) throw new Error("Invalid arguments");
    seen.add(key);
    if (key === "--device" && [options.devicePath, "/dev/bio-dongle"].includes(value)) options.devicePath = value;
    else if (key === "--protocol" && (value === "crc16" || value === "gs")) options.protocol = value;
    else if (key === "--profile" && (value === "legacy" || value === "android-v1.2.0")) options.profile = value;
    else if (key === "--timeout-ms" && /^[0-9]+$/.test(value) && Number(value) >= 1 && Number(value) <= 10000) options.timeoutMs = Number(value);
    else throw new Error("Invalid arguments");
  }
  if (options.profile === "android-v1.2.0" && options.protocol !== "crc16") throw new Error("Unobserved protocol");
  return options;
}

/** One read-only attempt. There is intentionally no raw command or payload API. */
export async function runBioDongleProbe(args: string[], dependencies: ProbeDependencies = {}): Promise<number> {
  const output = dependencies.output ?? ((line: string) => console.log(line));
  let options: ProbeOptions;
  try {
    options = parseArguments(args);
  } catch {
    output(JSON.stringify({ ok: false, operation: "probe", error: "INVALID_ARGUMENTS" }));
    return 2;
  }

  let response: BioFrame | undefined;
  let failure: unknown;
  const transport = new BioUsbTransport({
    protocol: options.protocol,
    profile: options.profile,
    timeoutMs: options.timeoutMs,
    connectionFactory: () => {
      if (!dependencies.connectionFactory) throw new BioUsbError("USB_IDENTITY", "BIO USB connection is not configured");
      return dependencies.connectionFactory(options.devicePath);
    },
    // Only the profile's read-only probe is sent. No lamp request() follows.
    // GET_NWK includes sensitive fields: validate shape without retaining them in output.
    validateReadiness: async (frame) => {
      if (options.profile === "android-v1.2.0" && decodeBioResponse(frame).kind !== "probe") throw new BioUsbError("READINESS", "BIO probe was not validated");
      response = frame;
    }
  });
  try {
    await transport.start();
  } catch (error) {
    failure = error;
  } finally {
    // Cancel the transport's reconnect timer even on a failed first probe.
    // A close failure overrides success because descriptor ownership is uncertain.
    try { await transport.stop(); } catch (error) { failure = error; }
  }
  if (failure || !response) {
    output(JSON.stringify({ ok: false, operation: "probe", error: failure instanceof BioUsbError ? failure.code : "PROBE_FAILED" }));
    return 1;
  }
  output(JSON.stringify({
    ok: true, operation: "probe", protocol: response.protocol, responseCommand: `0x${response.command.toString(16).padStart(2, "0")}`,
    payloadBytes: response.payload.length, payload: "[REDACTED]"
  }));
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runBioDongleProbe(process.argv.slice(2));
}
