import { AssignmentStore } from "./assignment-store";
import { BootstrapClient, createMtlsBootstrapRequest } from "./bootstrap-client";
import { GatewayAssignment } from "./assignment";

interface AssignmentStoreLike {
  read(): Promise<GatewayAssignment | null>;
  writeAtomic(assignment: GatewayAssignment): Promise<void>;
}

interface BootstrapClientLike {
  fetchAssignment(): Promise<GatewayAssignment | null>;
}

export async function resolveGatewayAssignment(options: {
  env: NodeJS.ProcessEnv;
  store: AssignmentStoreLike;
  bootstrapClient?: BootstrapClientLike;
  sleep?: (milliseconds: number) => Promise<void>;
}) {
  const stored = await options.store.read();
  if (stored) return stored;

  const serialNumber = requireManufacturingEnv(options.env, "GATEWAY_SERIAL");
  const client =
    options.bootstrapClient ??
    new BootstrapClient({
      serialNumber,
      request: await createMtlsBootstrapRequest({
        url: requireManufacturingEnv(options.env, "GATEWAY_BOOTSTRAP_URL"),
        certificatePath: requireManufacturingEnv(options.env, "GATEWAY_DEVICE_CERT_PATH"),
        privateKeyPath: requireManufacturingEnv(options.env, "GATEWAY_DEVICE_KEY_PATH"),
        caPath: requireManufacturingEnv(options.env, "GATEWAY_BOOTSTRAP_CA_PATH")
      })
    });
  const sleep = options.sleep ?? ((milliseconds) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));

  for (let attempt = 0; ; attempt += 1) {
    // 아직 claim되지 않은 Gateway는 빈 배정을 정상 상태로 보고 다시 조회한다. 바로
    // 실패하면 제조·설치 순서가 늦을 때 현장 process가 멈추고, 다음 MQTT 계층까지
    // 도달하지 못한다. 반대로 배정이 생긴 뒤에만 아래 저장 단계로 진행한다.
    const assignment = await client.fetchAssignment();
    if (assignment) {
      // writeAtomic은 0600 임시 파일을 fsync·rename해 배정을 교체한다. 전원 장애가
      // 난 뒤 부분 JSON이나 다른 사용자가 읽을 수 있는 자격 정보로 시작하는 일을
      // 막고, 다음 시작에서는 같은 local assignment로 MQTT identity를 준비하게 한다.
      await options.store.writeAtomic(assignment);
      return assignment;
    }
    const delay = Math.min(60_000, 2_000 * 2 ** Math.min(attempt, 5));
    await sleep(delay);
  }
}

export function createAssignmentStore(env: NodeJS.ProcessEnv) {
  return new AssignmentStore(env.GATEWAY_ASSIGNMENT_PATH ?? "/var/lib/led-control/assignment.json");
}

function requireManufacturingEnv(env: NodeJS.ProcessEnv, name: string) {
  const value = env[name];
  if (!value) throw new Error(`${name} manufacturing credential is required when no gateway assignment exists`);
  return value;
}
