import { Controller, HttpCode, Post, UseGuards, type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { execFileSync } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { Agent, createServer, request, type Server } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApiHttpsOptions } from "../src/api-tls-options";
import { MANUFACTURING_CA_FINGERPRINT, ManufacturingAuthGuard } from "../src/pki/manufacturing-auth.guard";

@Controller()
class ManufacturingProbeController {
  @Post("manufacturing/probe")
  @HttpCode(204)
  @UseGuards(ManufacturingAuthGuard)
  probe() {}
}

describe("Nest manufacturing mTLS integration", () => {
  let server: Server | undefined;
  let app: INestApplication | undefined;
  let directory: string;

  afterEach(async () => {
    await new Promise<void>(resolve => server?.close(() => resolve()) ?? resolve());
    await app?.close();
    if (directory) rmSync(directory, { recursive: true, force: true });
  });

  it("createApiHttpsOptions와 ManufacturingAuthGuard를 결합해 정상 station만 허용하고 runtime CRL 폐기를 반영한다", async () => {
    directory = mkdtempSync(join(tmpdir(), "nest-manufacturing-mtls-"));
    const repo = join(directory, "repo");
    const scripts = join(repo, "scripts", "pki");
    mkdirSync(scripts, { recursive: true });
    const issuer = join(scripts, "issue-lab-manufacturing-station.sh");
    copyFileSync(join(process.cwd(), "../../scripts/pki/issue-lab-manufacturing-station.sh"), issuer);
    chmodSync(issuer, 0o755);
    execFileSync(issuer, ["issue"], { cwd: repo, env: { ...process.env, PKI_ENV: "lab" }, stdio: "pipe" });
    const manufacturing = join(repo, ".local", "lab-pki", "manufacturing");
    issueServer(directory);
    const env = tlsEnvironment(directory, manufacturing);
    const tls = createApiHttpsOptions(env).httpsOptions!;
    const caFingerprint = new X509Certificate(readFileSync(join(manufacturing, "manufacturing-ca.crt"))).fingerprint256;
    const module = await Test.createTestingModule({
      controllers: [ManufacturingProbeController],
      providers: [ManufacturingAuthGuard, { provide: MANUFACTURING_CA_FINGERPRINT, useValue: caFingerprint }]
    }).compile();
    app = module.createNestApplication();
    await app.init();
    server = createServer(tls, app.getHttpAdapter().getInstance());
    await new Promise<void>(resolve => server!.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server did not bind");

    expect(await call(address.port, directory, manufacturing, true)).toBe(204);
    expect(await call(address.port, directory, manufacturing, false)).toBe(401);

    execFileSync(issuer, ["revoke"], { cwd: repo, env: { ...process.env, PKI_ENV: "lab" }, stdio: "pipe" });
    server.setSecureContext(createApiHttpsOptions(env).httpsOptions!);
    expect(await call(address.port, directory, manufacturing, true)).toBe(401);
  });
});

function issueServer(directory: string) {
  openssl(directory, ["ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", "api-ca.key"]);
  openssl(directory, ["req", "-x509", "-new", "-key", "api-ca.key", "-out", "api-ca.crt", "-days", "1", "-subj", "/CN=Lab API CA", "-addext", "basicConstraints=critical,CA:true", "-addext", "keyUsage=critical,keyCertSign,cRLSign"]);
  openssl(directory, ["ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", "api.key"]);
  openssl(directory, ["req", "-new", "-key", "api.key", "-out", "api.csr", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost"]);
  writeFileSync(join(directory, "api.ext"), "basicConstraints=critical,CA:false\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:localhost\n");
  openssl(directory, ["x509", "-req", "-in", "api.csr", "-CA", "api-ca.crt", "-CAkey", "api-ca.key", "-CAcreateserial", "-out", "api.crt", "-days", "1", "-extfile", "api.ext"]);
}

function tlsEnvironment(directory: string, manufacturing: string) {
  return {
    NODE_ENV: "development", API_TLS_CERT_PATH: join(directory, "api.crt"), API_TLS_KEY_PATH: join(directory, "api.key"),
    API_DEVICE_CLIENT_CA_PATH: join(manufacturing, "manufacturing-ca.crt"), API_MANUFACTURING_CLIENT_CA_PATH: join(manufacturing, "manufacturing-ca.crt"),
    API_DEVICE_CRL_PATH: join(manufacturing, "manufacturing.crl"), API_MANUFACTURING_CRL_PATH: join(manufacturing, "manufacturing.crl")
  };
}

function call(port: number, directory: string, manufacturing: string, withStation: boolean): Promise<number | undefined> {
  return new Promise((resolve, reject) => {
    const req = request({
      hostname: "localhost", port, path: "/manufacturing/probe", method: "POST",
      ca: readFileSync(join(directory, "api-ca.crt")), rejectUnauthorized: true, agent: new Agent({ maxCachedSessions: 0 }),
      ...(withStation ? { cert: readFileSync(join(manufacturing, "station.crt")), key: readFileSync(join(manufacturing, "station.key")) } : {})
    }, response => { response.resume(); response.once("end", () => resolve(response.statusCode)); });
    req.once("error", reject);
    req.end();
  });
}

function openssl(directory: string, args: string[]) {
  execFileSync("openssl", args, { cwd: directory, stdio: "pipe" });
}
