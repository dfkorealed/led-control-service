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

  return async (body) => {
    let request: ReturnType<typeof httpsRequest> | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      return await new Promise<BootstrapResponse>((resolve, reject) => {
        let settled = false;
        const fail = () => {
          if (settled) return;
          settled = true;
          reject(new Error("gateway bootstrap request failed"));
          request?.destroy();
        };
        // TLS key/cert 오류는 httpsRequest 생성 중에도 동기 throw할 수 있다.
        // request가 만들어진 뒤에만 timer를 만들고 아래 finally에서 정리해야,
        // 원래 실패 이후 미초기화 request를 참조하는 지연 예외가 발생하지 않는다.
        request = httpsRequest(
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
                resolve(parsed);
              } catch {
                fail();
              }
            });
          }
        );
        // Idle이 아니라 연결/TLS/응답 전체 deadline: 조금씩 오는 body도 연장 못 한다.
        deadline = setTimeout(fail, timeoutMs);
        request.on("error", fail);
        request.end(JSON.stringify(body));
      });
    } catch {
      request?.destroy();
      throw new Error("gateway bootstrap request failed");
    } finally {
      // 정상 완료, HTTP/파싱 오류, timeout, 동기 TLS 생성 오류 모두 한 경로로 정리한다.
      clearTimeout(deadline);
    }
  };
}
