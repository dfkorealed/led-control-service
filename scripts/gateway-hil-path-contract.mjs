import { fileURLToPath } from "node:url";
import path from "node:path";

const scriptsDirectory = path.dirname(fileURLToPath(import.meta.url));

export const REPOSITORY_ROOT = path.resolve(scriptsDirectory, "..");
export const GATEWAY_HIL_WORKING_DIRECTORY = path.join(REPOSITORY_ROOT, "apps/gateway");

export function resolveGatewayHilPath(value) {
  return path.isAbsolute(value) ? value : path.resolve(GATEWAY_HIL_WORKING_DIRECTORY, value);
}
