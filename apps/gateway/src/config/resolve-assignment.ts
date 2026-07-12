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
    const assignment = await client.fetchAssignment();
    if (assignment) {
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
