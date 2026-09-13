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
  timeoutMs?: number;
}): Promise<BootstrapRequest> {
  const url = new URL(options.url);
  if (url.protocol !== "https:" || url.username || url.password || url.hash) throw new Error("invalid bootstrap URL");
  const timeoutMs = options.timeoutMs ?? 10_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) throw new Error("invalid bootstrap timeout");
  const [cert, key, ca] = await Promise.all([
    readFile(options.certificatePath),
    readFile(options.privateKeyPath),
    readFile(options.caPath)
  ]);

  return (body) =>
    new Promise<BootstrapResponse>((resolve, reject) => {
      let settled = false;
      const fail = () => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        reject(new Error("gateway bootstrap request failed"));
      };
      // 설치용 one-shot은 서버가 응답을 끝내지 않거나 조금씩 보내도 유한 시간에
      // 중단되어야 한다. Socket idle timeout이 아닌 요청 전체 deadline이다.
      const deadline = setTimeout(() => { fail(); request.destroy(); }, timeoutMs);
      const request = httpsRequest(
        url,
        { method: "POST", cert, key, ca, rejectUnauthorized: true, headers: { "content-type": "application/json" } },
        (response) => {
          const chunks: Buffer[] = [];
          let received = 0;
          response.on("data", (chunk: Buffer) => {
            received += chunk.byteLength;
            if (received > 256 * 1024) { fail(); response.destroy(); return; }
            chunks.push(chunk);
          });
          response.on("error", fail);
          response.on("aborted", fail);
          response.on("end", () => {
            if (settled) return;
            const payload = Buffer.concat(chunks).toString("utf8");
            if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
              fail();
              return;
            }
            try {
              const parsed = JSON.parse(payload) as BootstrapResponse;
              settled = true;
              clearTimeout(deadline);
              resolve(parsed);
            } catch {
              fail();
            }
          });
        }
      );
      request.on("error", fail);
      request.end(JSON.stringify(body));
    });
}
