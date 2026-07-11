import { BluezTransport } from "../src/mesh/bluez-transport";
import { createHardwareRequiredReport, probeLocalBluez, summarizeCapabilityReport } from "../src/mesh/bluez-capability";

async function main() {
  if (process.platform !== "linux") {
    const report = createHardwareRequiredReport(process.platform);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exitCode = summarizeCapabilityReport(report).exitCode;
    return;
  }

  const transport = new BluezTransport();
  try {
    const report = await probeLocalBluez(transport);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exitCode = summarizeCapabilityReport(report).exitCode;
  } finally {
    transport.disconnect();
  }
}

void main();
