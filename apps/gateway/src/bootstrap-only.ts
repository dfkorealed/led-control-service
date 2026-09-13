import { constants } from "node:fs";
import { access, lstat, readFile, realpath } from "node:fs/promises";
import { X509Certificate } from "node:crypto";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createAssignmentStore, resolveGatewayAssignment } from "./config/resolve-assignment";
import { KeyMaterialStore } from "./identity/key-material-store";
import { ensureMqttIdentity } from "./identity/ensure-mqtt-identity";

type Stage = "preflight" | "assignment" | "mqtt";
type Result = { status: "complete"; operation: "bootstrap-only" } |
  { status: "failed"; operation: "bootstrap-only"; stage: Stage };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * claim과 실제 RF adapter 활성화를 분리하는 제품용 설치 명령이다.
 * /gateway-bootstrap은 서버의 Site/Gateway 배정을, /gateway-certificates/mqtt는
 * 그 배정에 결속된 MQTT 인증서를 돌려준다. 성공은 인증 준비만 의미하며
 * online heartbeat/조명 검색/제어 성공을 뜻하지 않는다.
 *
 * 이 파일은 index.ts를 import하면 안 된다. index의 dependency graph에는 USB,
 * BlueZ와 명령 runtime이 들어 있다. 전용 artifact/entrypoint로 분리해야 실수로
 * HCI 전원을 바꾸거나 BIO 패킷을 보내는 일을 실행 시작 전부터 차단할 수 있다.
 */
export async function runBootstrapOnly(env: NodeJS.ProcessEnv, args: readonly string[] = []): Promise<Result> {
  let stage: Stage = "preflight";
  try {
    // Root 권한으로 identity를 생성하지 않는다. Host는 새 root의 소유권만 미리
    // 준비하고, 이 CLI는 chmod/chown이나 이전 identity 복사로 권한을 우회하지 않는다.
    if (!process.getuid || process.getuid() === 0 || args.length) throw new Error("invalid execution");
    const serialNumber = env.GATEWAY_SERIAL ?? "";
    const siteId = env.GATEWAY_EXPECTED_SITE_ID ?? "";
    const gatewayId = env.GATEWAY_EXPECTED_GATEWAY_ID ?? "";
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(serialNumber) || !UUID.test(siteId) || !UUID.test(gatewayId)) throw new Error("invalid scope");
    const url = new URL(env.GATEWAY_BOOTSTRAP_URL ?? "");
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/gateway-bootstrap") throw new Error("invalid endpoint");
    const identityRoot = await writableRoot(env.GATEWAY_BOOTSTRAP_IDENTITY_DIR ?? "/data/identity");
    const stateRoot = await writableRoot(env.GATEWAY_BOOTSTRAP_STATE_DIR ?? "/data/gateway");
    if (contains(identityRoot, stateRoot) || contains(stateRoot, identityRoot)) throw new Error("overlapping roots");
    // 두 mount는 같은 새 host data root의 서로 다른 하위 디렉터리여야 한다.
    // 기존 assignment/MQTT/current 복사는 금지하며, 저장된 scope도 아래 resolver가
    // 검증한다. 별도 mount라 제조 device identity를 runtime state와 혼동하지 않는다.
    const deviceRoot = join(identityRoot, "device");
    const device = await new KeyMaterialStore({ identityRoot: deviceRoot }).currentIdentity();
    if (new X509Certificate(await readFile(device.certificatePath)).subject !== `CN=${serialNumber}`) throw new Error("invalid device scope");
    const runtimeEnv: NodeJS.ProcessEnv = {
      GATEWAY_SERIAL: serialNumber,
      GATEWAY_BOOTSTRAP_URL: url.toString(),
      GATEWAY_DEVICE_CERT_PATH: device.certificatePath,
      GATEWAY_DEVICE_KEY_PATH: device.privateKeyPath,
      GATEWAY_BOOTSTRAP_CA_PATH: device.apiCaPath,
      GATEWAY_IDENTITY_ROOT: deviceRoot,
      GATEWAY_MQTT_IDENTITY_ROOT: join(identityRoot, "mqtt"),
      GATEWAY_MQTT_CA_SOURCE_PATH: device.mqttCaPath,
      GATEWAY_ASSIGNMENT_PATH: join(stateRoot, "assignment.json")
    };
    stage = "assignment";
    const assignment = await resolveGatewayAssignment({ env: runtimeEnv, store: createAssignmentStore(runtimeEnv),
      once: true, expected: { serialNumber, siteId, gatewayId } });
    stage = "mqtt";
    await ensureMqttIdentity(assignment, runtimeEnv, true);
    return { status: "complete", operation: "bootstrap-only" };
  } catch {
    // 발급 요청 후 실패는 서버 commit 여부가 불확실할 수 있다. 자동 재시도하지
    // 않고 고정 stage만 반환한다. 원시 Error/PEM/URL/ID/claim code는 로그 금지다.
    return { status: "failed", operation: "bootstrap-only", stage };
  }
}

async function writableRoot(path: string) {
  if (!isAbsolute(path) || resolve(path) === "/") throw new Error("invalid root");
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || (metadata.mode & 0o022)) throw new Error("unsafe root");
  const canonical = await realpath(path);
  if (canonical !== resolve(path)) throw new Error("aliased root");
  await access(path, constants.R_OK | constants.W_OK | constants.X_OK);
  return canonical;
}

function contains(parent: string, child: string) {
  const suffix = relative(parent, child);
  return suffix === "" || (suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void runBootstrapOnly(process.env, process.argv.slice(2)).then((result) => {
    const output = `${JSON.stringify(result)}\n`;
    if (result.status === "complete") process.stdout.write(output);
    else { process.stderr.write(output); process.exitCode = 1; }
  });
}
