import { lstat, readFile, realpath } from "node:fs/promises";
import { X509Certificate } from "node:crypto";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AssignmentStore } from "./config/assignment-store";
import { validateExpectedAssignment } from "./config/resolve-assignment";
import { KeyMaterialStore } from "./identity/key-material-store";
import { MqttIdentityStore } from "./identity/mqtt-identity-store";

/**
 * Host launcher가 USB를 넘기기 전에 --network none/readonly mount로 실행한다.
 * bootstrap-only와 달리 발급·CONNECT·assignment 저장을 절대 하지 않는다.
 * 이미 준비된 새 assignment와 device/MQTT identity만 같은 제품 Store로 검증한다.
 * 별도 root의 신뢰 검증 없이 Node를 직접 실행하면 예전 assignment를 사용할 수
 * 있으므로 host 권한 준비와 이 read-only 검증을 모두 통과해야 full runtime을 연다.
 */
export async function validateBioRuntimeIdentity(env: NodeJS.ProcessEnv) {
  if (!process.getuid || process.getuid() === 0) throw new Error("non-root required");
  const identity = env.GATEWAY_BOOTSTRAP_IDENTITY_DIR ?? "/data/identity";
  const state = env.GATEWAY_BOOTSTRAP_STATE_DIR ?? "/data/gateway";
  for (const [root, mode] of [[identity, 0o750], [state, 0o700]] as const) {
    const metadata = await lstat(root);
    if (!metadata.isDirectory() || metadata.isSymbolicLink() || (metadata.mode & 0o777) !== mode || await realpath(root) !== resolve(root)) throw new Error("unsafe root");
  }
  if (resolve(identity) === resolve(state) || resolve(identity).startsWith(`${resolve(state)}/`) || resolve(state).startsWith(`${resolve(identity)}/`)) throw new Error("overlapping roots");
  const serialNumber = env.GATEWAY_SERIAL ?? "";
  const siteId = env.GATEWAY_EXPECTED_SITE_ID ?? "";
  const gatewayId = env.GATEWAY_EXPECTED_GATEWAY_ID ?? "";
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (!uuid.test(siteId) || !uuid.test(gatewayId) || !serialNumber) throw new Error("invalid expected scope");
  const path = join(state, "assignment.json");
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o777) !== 0o600) throw new Error("unsafe assignment");
  const assignment = await new AssignmentStore(path).read();
  if (!assignment) throw new Error("bootstrap required");
  validateExpectedAssignment(assignment, { serialNumber, siteId, gatewayId });
  const device = await new KeyMaterialStore({ identityRoot: join(identity, "device") }).currentIdentity();
  if (new X509Certificate(await readFile(device.certificatePath)).subject !== `CN=${serialNumber}`) throw new Error("device scope mismatch");
  await new MqttIdentityStore({ identityRoot: join(identity, "mqtt") }).currentIdentity(gatewayId);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void validateBioRuntimeIdentity(process.env).then(() => {
    process.stdout.write("BIO_RUNTIME_IDENTITY_VALID\n");
  }).catch(() => {
    process.stderr.write("BIO_RUNTIME_IDENTITY_INVALID\n"); process.exitCode = 1;
  });
}
