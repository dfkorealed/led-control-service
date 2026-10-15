import { Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { installGatewayDeploymentReadOnly } from "./gateway-deployment-read-only";

@Module({})
class HttpFixtureModule {}

describe("gateway deployment read-only HTTP boundary", () => {
  let app: NestExpressApplication;
  let port: number;
  let parsed: number;
  let handled: number;
  let observed: number;
  const health = { dependencies: { postgres: "up", redis: "up", mqtt: "up", objectStorage: "up", cadConverter: "up" } };

  async function start(mode: string | undefined, install = true) {
    parsed = handled = observed = 0;
    app = await NestFactory.create<NestExpressApplication>(HttpFixtureModule, {
      logger: false, bodyParser: false
    });
    // Production also installs observability before the maintenance boundary.
    app.use((_req: unknown, _res: unknown, next: () => void) => { observed++; next(); });
    if (install) installGatewayDeploymentReadOnly(app, { GATEWAY_DEPLOYMENT_READ_ONLY: mode });
    app.useBodyParser("json", { verify: () => { parsed++; } });
    app.use((req: { url: string }, res: { status(code: number): { json(body: unknown): void } }) => {
      handled++;
      res.status(200).json(req.url === "/health/ready" ? health : { accepted: true });
    });
    await app.listen(0, "127.0.0.1");
    port = (app.getHttpServer().address() as AddressInfo).port;
  }

  function send(method: string, path = "/commands", body?: string) {
    return new Promise<{ status: number; headers: Record<string, unknown>; body: string }>((resolve, reject) => {
      const req = request({ hostname: "127.0.0.1", port, method, path,
        headers: body === undefined ? {} : { "Content-Type": "application/json" }
      }, res => {
        const chunks: Buffer[] = [];
        res.on("data", chunk => chunks.push(Buffer.from(chunk)));
        res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks).toString() }));
      });
      req.on("error", reject);
      req.end(body);
    });
  }

  afterEach(async () => { if (app) await app.close(); });

  it.each(["GET", "HEAD", "OPTIONS"])("allows %s and marks read-only responses", async method => {
    await start("1");
    const response = await send(method, "/health/ready");
    expect(response.status).toBe(200);
    expect(response.headers["x-kinda-read-only"]).toBe("1");
    if (method !== "HEAD") expect(JSON.parse(response.body)).toEqual(health);
    expect(handled).toBe(1);
  });

  it.each(["POST", "PUT", "PATCH", "DELETE", "PROPFIND"])(
    "blocks %s before JSON parsing and handler side effects", async method => {
      await start("1");
      const response = await send(method, "/commands", '{"invalid":');
      expect(response.status).toBe(503);
      expect(JSON.parse(response.body)).toMatchObject({ statusCode: 503, code: "gateway_deployment_read_only" });
      expect(response.headers["x-kinda-read-only"]).toBe("1");
      expect(response.headers["retry-after"]).toBe("60");
      expect({ parsed, handled, observed }).toEqual({ parsed: 0, handled: 0, observed: 1 });
    }
  );

  it("blocks login and new commands without consuming an already accepted recovery intent", async () => {
    const acceptedIntents = new Set(["accepted-end"]);
    await start("1");
    for (const path of ["/auth/login", "/commands"]) {
      expect((await send("POST", path, "{}")).status).toBe(503);
    }
    expect([...acceptedIntents]).toEqual(["accepted-end"]);
    // This owned sentinel models an existing worker, outside the HTTP middleware.
    let recovered = 0;
    for (const intent of acceptedIntents) { acceptedIntents.delete(intent); recovered++; }
    expect(recovered).toBe(1);
    expect(handled).toBe(0);
  });

  it.each([undefined, "0"])("preserves normal HTTP status, body, headers and parser behavior for %p", async mode => {
    await start(mode, false);
    const baseline = await send("POST", "/commands", "{}");
    await app.close();
    await start(mode);
    const response = await send("POST", "/commands", "{}");
    expect(response.status).toBe(baseline.status);
    expect(response.body).toBe(baseline.body);
    // Independent servers may respond on opposite sides of a wall-clock second.
    const { date: _baselineDate, ...baselineHeaders } = baseline.headers;
    const { date: _responseDate, ...responseHeaders } = response.headers;
    expect(responseHeaders).toEqual(baselineHeaders);
    expect(response.headers["x-kinda-read-only"]).toBeUndefined();
    expect(response.headers["retry-after"]).toBeUndefined();
    expect({ parsed, handled, observed }).toEqual({ parsed: 1, handled: 1, observed: 1 });
  });

  it.each(["", " ", "true", "01", "2", " 1 "])("rejects invalid startup flag %p", mode => {
    expect(() => installGatewayDeploymentReadOnly({} as NestExpressApplication, {
      GATEWAY_DEPLOYMENT_READ_ONLY: mode
    })).toThrow("Invalid GATEWAY_DEPLOYMENT_READ_ONLY");
  });
});
