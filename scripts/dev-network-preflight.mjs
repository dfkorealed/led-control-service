import { lookup } from "node:dns/promises";
import { existsSync, readFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnvFile, validateLabNetworkConfiguration } from "./dev-runtime.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const repositoryRoot = join(dirname(scriptPath), "..");

export async function runDevelopmentNetworkPreflight({
  root = repositoryRoot,
  processEnvironment = process.env,
  environmentFileExists = existsSync,
  readEnvironmentFile = readFileSync,
  listNetworkInterfaces = networkInterfaces,
  resolveHostname = resolveIpv4Hostname
} = {}) {
  const environmentPath = join(root, ".env");
  if (!environmentFileExists(environmentPath)) {
    throw new Error(".env 파일이 없습니다. cp .env.example .env를 먼저 실행하세요.");
  }

  const fileEnvironment = parseEnvFile(readEnvironmentFile(environmentPath, "utf8"));
  const sourceEnvironment = { ...fileEnvironment, ...processEnvironment };
  const localIpv4Addresses = Object.values(listNetworkInterfaces())
    .flatMap((entries) => entries ?? [])
    .filter((entry) => entry.family === "IPv4" || entry.family === 4)
    .map((entry) => entry.address);

  await validateLabNetworkConfiguration(sourceEnvironment, {
    localAddresses: localIpv4Addresses,
    resolveHostname
  });
  return sourceEnvironment;
}

async function resolveIpv4Hostname(hostname) {
  return (await lookup(hostname, { all: true, family: 4, verbatim: true }))
    .map((entry) => entry.address);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(scriptPath)) {
  runDevelopmentNetworkPreflight().catch((error) => {
    console.error(`[dev:network-preflight] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
