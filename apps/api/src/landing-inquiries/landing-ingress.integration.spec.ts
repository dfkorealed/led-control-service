import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { LandingInquiriesController } from "./landing-inquiries.controller";
import { LandingInquiriesService } from "./landing-inquiries.service";
import { LandingMailCallbackController } from "./landing-mail.controller";
import { LandingMailOAuthService } from "./landing-mail-oauth.service";
import { LandingInquiryRateLimitService } from "./landing-inquiry-rate-limit.service";

const describeDocker = process.env.LANDING_INGRESS_TEST === "1" ? describe : describe.skip;

// Real production nginx HTTP + raw TCP config, real Nest route and rate limiter.
// Persistence and provider exchange are boundary doubles; this never sends mail.
describeDocker("landing production nginx ingress", () => {
  let app: INestApplication;
  let directory: string;
  const container = `kinda-ingress-test-${randomBytes(6).toString("hex")}`;
  const oldEnv = { ...process.env };
  const buckets = new Map<string, number>();
  const completeAuthorization = jest.fn(async () => undefined);
  const repository = resolve(__dirname, "../../../..");

  async function docker(...args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn("docker", args);
      let output = "";
      let diagnostic = "";
      child.stdout.on("data", chunk => { output += chunk; });
      child.stderr.on("data", chunk => { diagnostic += chunk; });
      child.on("error", reject);
      child.on("close", code => code === 0 ? resolve(output + (args[0] === "logs" ? diagnostic : "")) : reject(new Error(`Docker fixture ${args[0]} failed (${code}): ${diagnostic}`)));
    });
  }
  async function request(ip: string, path: string, extra: string[] = [], port = 8443) {
    const output = await docker("exec", container, "curl", "-sk", "--max-time", "8", "--interface", ip,
      "-w", "\n%{http_code}", ...extra, `https://localhost:${port}${path}`);
    const split = output.lastIndexOf("\n");
    return { status: Number(output.slice(split + 1)), body: output.slice(0, split) };
  }

  beforeAll(async () => {
    directory = mkdtempSync(join(tmpdir(), "kinda-ingress-test-"));
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=api",
      "-addext", "subjectAltName=DNS:api,DNS:localhost", "-keyout", join(directory, "key.pem"), "-out", join(directory, "cert.pem")], { stdio: "pipe" });
    process.env.NODE_ENV = "production";
    process.env.LANDING_INGRESS_SECRET = "a".repeat(64);
    const rate = new LandingInquiryRateLimitService({ getClient: () => ({ eval: async (_script: string, _keys: number, key: string) => {
      const count = (buckets.get(key) ?? 0) + 1;
      buckets.set(key, count);
      return [count > 5 ? 0 : 1, 900];
    } }) } as any);
    const module = await Test.createTestingModule({
      controllers: [LandingInquiriesController, LandingMailCallbackController],
      providers: [
        { provide: LandingInquiriesService, useValue: { submit: async (_input: unknown, ip: string) => { await rate.consume(ip); return { ip }; } } },
        { provide: LandingMailOAuthService, useValue: { completeAuthorization } }
      ]
    }).compile();
    app = module.createNestApplication({ logger: false, httpsOptions: { key: readFileSync(join(directory, "key.pem")), cert: readFileSync(join(directory, "cert.pem")) } });
    await app.listen(0, "0.0.0.0");
    const port = app.getHttpServer().address().port;
    const template = readFileSync(join(repository, "apps/web/nginx.conf.template"), "utf8")
      .replaceAll("https://api:4000/", `https://host.docker.internal:${port}/`)
      .replaceAll("/run/web-tls/web.crt", "/fixture/cert.pem").replaceAll("/run/web-tls/web.key", "/fixture/key.pem")
      .replaceAll("/run/api-tls/api-ca.crt", "/fixture/cert.pem");
    const stream = readFileSync(join(repository, "apps/web/nginx.stream.conf"), "utf8").replaceAll("api:4000", `host.docker.internal:${port}`);
    writeFileSync(join(directory, "default.conf.template"), template);
    writeFileSync(join(directory, "nginx.conf"), `events {}\nhttp { include /etc/nginx/conf.d/default.conf; }\n${stream}`);
    const dockerfile = readFileSync(join(repository, "apps/web/Dockerfile"), "utf8");
    const filter = /ENV NGINX_ENVSUBST_FILTER="([^"]+)"/.exec(dockerfile)?.[1];
    if (!filter) throw new Error("Missing production nginx substitution filter");
    await docker("run", "-d", "--name", container, "--add-host", "host.docker.internal:host-gateway",
      "-e", `NGINX_ENVSUBST_FILTER=${filter}`, "-e", "WEB_HTTPS_ORIGIN=https://localhost:8443", "-e", `LANDING_INGRESS_SECRET=${"a".repeat(64)}`,
      "-v", `${directory}:/fixture:ro`, "-v", `${join(directory, "default.conf.template")}:/etc/nginx/templates/default.conf.template:ro`,
      "nginx:1.27.5-alpine", "nginx", "-c", "/fixture/nginx.conf", "-g", "daemon off;");
    try { await docker("exec", container, "nginx", "-t", "-c", "/fixture/nginx.conf"); }
    catch (error) { throw new Error(`${error}; ${await docker("logs", container)}`); }
    // Container start precedes its entrypoint template rendering and socket listen.
    const deadline = Date.now() + 8_000;
    while (true) {
      try { await request("127.0.0.2", "/api/fixture-ready"); break; }
      catch (error) {
        if (Date.now() >= deadline) throw new Error(`${error}; ${await docker("logs", container)}`);
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
  }, 60_000);
  afterAll(async () => {
    await docker("rm", "-f", container).catch(() => undefined);
    await app?.close();
    if (directory) rmSync(directory, { recursive: true, force: true });
    process.env = oldEnv;
  });
  beforeEach(() => buckets.clear());

  it("separates visitors, overwrites forged identity and keeps each bucket limited", async () => {
    const forged = ["-X", "POST", "-H", "X-Forwarded-For: 198.51.100.99", "-H", "X-Landing-Client-IP: 198.51.100.99", "-H", `X-Landing-Ingress-Secret: ${"b".repeat(64)}`];
    for (let index = 0; index < 5; index++) {
      const first = await request("127.0.0.2", "/api/landing/inquiries", forged);
      expect(first.status).toBe(201);
      expect(JSON.parse(first.body).ip).toBe("127.0.0.2");
    }
    expect((await request("127.0.0.2", "/api/landing/inquiries", forged)).status).toBe(429);
    const second = await request("127.0.0.3", "/api/landing/inquiries", forged);
    expect(second.status).toBe(201);
    expect(JSON.parse(second.body).ip).toBe("127.0.0.3");
    expect(buckets.size).toBe(2);
  }, 30_000);

  it("rejects forged direct requests through the public raw TLS listener", async () => {
    const response = await request("127.0.0.2", "/landing/inquiries", ["-X", "POST", "-H", "X-Forwarded-For: 198.51.100.99",
      "-H", "X-Landing-Client-IP: 198.51.100.99", "-H", `X-Landing-Ingress-Secret: ${"b".repeat(64)}`], 9443);
    expect(response.status).toBe(503);
    expect(buckets.size).toBe(0);
  });

  it("routes the exact public OAuth callback through API and redirects to the same Web origin", async () => {
    const response = await request("127.0.0.2", "/api/landing-mail/oauth/callback?code=fake-code&state=fake-state", ["-D", "-"]);
    expect(response.status).toBe(302);
    const location = /\r?\nlocation: ([^\r\n]+)/i.exec(response.body)?.[1];
    expect(location).toBe("/operator/landing-inquiries?mail=connected");
    expect(new URL(location!, "https://localhost:8443/api/landing-mail/oauth/callback").href).toBe("https://localhost:8443/operator/landing-inquiries?mail=connected");
    expect(completeAuthorization).toHaveBeenCalledWith("fake-code", "fake-state");
    expect(response.body).not.toContain("fake-code");
  });
});
