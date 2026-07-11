import { readFile } from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import { GatewayAssignment, parseGatewayAssignment } from "./assignment";

type BootstrapResponse =
  | { status: "unclaimed"; retryAfterSeconds?: number }
  | { status: "assigned"; assignment: unknown };

export type BootstrapRequest = (body: { serialNumber: string }) => Promise<BootstrapResponse>;

interface BootstrapClientOptions {
  serialNumber: string;
  request: BootstrapRequest;
}

export class BootstrapClient {
  constructor(private readonly options: BootstrapClientOptions) {}

  async fetchAssignment(): Promise<GatewayAssignment | null> {
    const response = await this.options.request({ serialNumber: this.options.serialNumber });
    if (response.status === "unclaimed") return null;
    const assignment = parseGatewayAssignment(response.assignment);
    if (assignment.serialNumber !== this.options.serialNumber) throw new Error("gateway assignment serial mismatch");
    return assignment;
  }
}

export async function createMtlsBootstrapRequest(options: {
  url: string;
  certificatePath: string;
  privateKeyPath: string;
  caPath: string;
}): Promise<BootstrapRequest> {
  const [cert, key, ca] = await Promise.all([
    readFile(options.certificatePath),
    readFile(options.privateKeyPath),
    readFile(options.caPath)
  ]);

  return (body) =>
    new Promise<BootstrapResponse>((resolve, reject) => {
      const url = new URL(options.url);
      const request = httpsRequest(
        url,
        { method: "POST", cert, key, ca, rejectUnauthorized: true, headers: { "content-type": "application/json" } },
        (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.on("end", () => {
            const payload = Buffer.concat(chunks).toString("utf8");
            if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
              reject(new Error(`gateway bootstrap failed with HTTP ${response.statusCode ?? "unknown"}`));
              return;
            }
            try {
              resolve(JSON.parse(payload) as BootstrapResponse);
            } catch {
              reject(new Error("gateway bootstrap returned invalid JSON"));
            }
          });
        }
      );
      request.on("error", reject);
      request.end(JSON.stringify(body));
    });
}
