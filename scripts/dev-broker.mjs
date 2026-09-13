import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

const CONTAINER_ACL_DIRECTORY = "/mosquitto/runtime";
const CONTAINER_ACL_PATH = `${CONTAINER_ACL_DIRECTORY}/mosquitto.acl`;

export function publishNativeBrokerIdentity(destination, identity) {
  if (!Number.isSafeInteger(identity.pid) || identity.pid <= 0) {
    throw new Error("native Mosquitto pid must be a positive integer");
  }
  publishPrivateFile(destination, `${JSON.stringify(identity)}\n`);
}

export function removeNativeBrokerIdentity(destination, expectedPid) {
  try {
    const identity = JSON.parse(readFileSync(destination, "utf8"));
    if (identity.pid === expectedPid) rmSync(destination, { force: true });
  } catch {
    // A missing, replaced, or malformed marker must never cause broad cleanup.
  }
}

export function reloadExistingDevelopmentBroker({
  root,
  aclPath,
  nativeIdentityPath = join(root, ".local", "mosquitto.host.pid.json"),
  port = 8883,
  run = runCommand,
  signalProcess = process.kill
}) {
  const owner = identifyDevelopmentBroker({ root, aclPath, nativeIdentityPath, port, run });

  if (owner.kind === "docker") {
    requireSuccess(
      run("docker", ["kill", "--signal=SIGHUP", owner.id], { cwd: root }),
      "failed to reload the repo-owned Docker mqtt-tls broker"
    );
    const mountedAcl = requireSuccess(
      run("docker", ["exec", "-u", "1883:1883", owner.id, "cat", CONTAINER_ACL_PATH], { cwd: root }),
      "failed to verify the Docker mqtt-tls ACL mount"
    ).stdout;
    if (mountedAcl !== readFileSync(aclPath, "utf8")) {
      throw new Error("Docker mqtt-tls did not expose the generated development ACL");
    }
  } else {
    signalProcess(owner.pid, "SIGHUP");
  }

  // Re-resolve the listener after SIGHUP. A successful signal alone does not
  // prove the expected broker survived or that the port was not taken over.
  const verified = identifyDevelopmentBroker({ root, aclPath, nativeIdentityPath, port, run });
  if (verified.kind !== owner.kind || (owner.kind === "docker" ? verified.id !== owner.id : verified.pid !== owner.pid)) {
    throw new Error("development Mosquitto ownership changed while reloading ACL");
  }
  return owner;
}

function identifyDevelopmentBroker({ root, aclPath, nativeIdentityPath, port, run }) {
  const containerIds = successfulOutput(run("docker", ["compose", "ps", "-q", "mqtt-tls"], { cwd: root }))
    .split(/\s+/)
    .filter(Boolean);
  if (containerIds.length > 1) throw new Error("multiple Docker mqtt-tls containers matched this repository");
  if (containerIds.length === 1) {
    assertRepoDockerBroker(containerIds[0], root, aclPath, port, run);
    return { kind: "docker", id: containerIds[0] };
  }

  const listenerPids = [...new Set(successfulOutput(
    run("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { cwd: root })
  ).split(/\s+/).filter(Boolean))];
  if (listenerPids.length !== 1 || !/^\d+$/.test(listenerPids[0])) {
    throw new Error(`an unmanaged process owns port ${port}`);
  }
  const listenerPid = Number(listenerPids[0]);
  const identity = readNativeIdentity(nativeIdentityPath);
  const expectedRoot = resolve(root);
  const expectedAcl = resolve(aclPath);
  const expectedConfig = join(expectedRoot, ".local", "mosquitto.host.conf");
  if (
    !identity ||
    identity.pid !== listenerPid ||
    resolve(identity.root ?? "") !== expectedRoot ||
    resolve(identity.config ?? "") !== expectedConfig ||
    basename(identity.binary ?? "") !== "mosquitto" ||
    !existsSync(identity.binary) ||
    !existsSync(identity.config) ||
    readFileSync(identity.config, "utf8").split(/\r?\n/).filter((line) => line.startsWith("acl_file ")).join("\n") !==
      `acl_file ${expectedAcl}`
  ) {
    throw new Error(`an unmanaged process owns port ${port}`);
  }
  const command = requireSuccess(
    run("ps", ["-ww", "-p", String(listenerPid), "-o", "command="], { cwd: root }),
    "failed to inspect the native Mosquitto process"
  ).stdout.trim();
  if (command !== `${identity.binary} -c ${identity.config}`) {
    throw new Error(`an unmanaged process owns port ${port}`);
  }
  return { kind: "native", pid: listenerPid };
}

function assertRepoDockerBroker(containerId, root, aclPath, port, run) {
  const result = requireSuccess(
    run("docker", ["inspect", containerId], { cwd: root }),
    "failed to inspect the repository Docker mqtt-tls broker"
  );
  let container;
  try {
    [container] = JSON.parse(result.stdout);
  } catch {
    throw new Error("Docker mqtt-tls inspection returned malformed JSON");
  }
  const labels = container?.Config?.Labels ?? {};
  const portBindings = container?.NetworkSettings?.Ports?.[`${port}/tcp`] ?? [];
  const aclMount = container?.Mounts?.filter((mount) => mount.Destination === CONTAINER_ACL_DIRECTORY) ?? [];
  if (
    !container?.State?.Running ||
    labels["com.docker.compose.service"] !== "mqtt-tls" ||
    resolve(labels["com.docker.compose.project.working_dir"] ?? "") !== resolve(root) ||
    !portBindings.some((binding) => binding.HostPort === String(port)) ||
    aclMount.length !== 1 ||
    resolve(aclMount[0].Source ?? "") !== resolve(dirname(aclPath)) ||
    aclMount[0].RW !== false
  ) {
    throw new Error(`an unmanaged process owns port ${port}`);
  }
}

function readNativeIdentity(path) {
  try {
    if ((statSync(path).mode & 0o777) !== 0o600) return undefined;
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

function publishPrivateFile(destination, content) {
  const temporaryPath = join(
    dirname(destination),
    `.${basename(destination)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`
  );
  let descriptor;
  try {
    descriptor = openSync(temporaryPath, "wx", 0o600);
    writeFileSync(descriptor, content, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    chmodSync(temporaryPath, 0o600);
    renameSync(temporaryPath, destination);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    rmSync(temporaryPath, { force: true });
  }
}

function successfulOutput(result) {
  return result?.status === 0 ? result.stdout.trim() : "";
}

function requireSuccess(result, message) {
  if (result?.status !== 0) throw new Error(message);
  return result;
}

function runCommand(command, args, options) {
  return spawnSync(command, args, { ...options, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}
