import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startVaultTokenLifecycle } from "./vault-token-lifecycle";

describe("Vault application token lifecycle", () => {
  let server: Server | undefined;
  let directory: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "vault-token-lifecycle-"));
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server?.close(() => resolve()) ?? resolve());
    rmSync(directory, { recursive: true, force: true });
  });

  it("lookup-self 후 만료 전에 token file을 다시 읽어 renew-self하고 stop 시 timer를 취소한다", async () => {
    const tokenFile = join(directory, "token");
    writeFileSync(tokenFile, "token-one\n", { mode: 0o600 });
    const requests: Array<{ url: string; token: string | undefined }> = [];
    const address = await listen((request, response) => {
      requests.push({ url: request.url ?? "", token: request.headers["x-vault-token"] as string | undefined });
      response.writeHead(200, { "content-type": "application/json" });
      if (request.url?.endsWith("lookup-self")) response.end(JSON.stringify({ data: lease(86_400) }));
      else response.end(JSON.stringify({ auth: lease(86_400) }));
    });
    const timer = timerHarness();

    const lifecycle = await startVaultTokenLifecycle({
      address, tokenFile, expectedPolicy: "gateway-pki", requestTimeoutMs: 1_000,
      onFatal: jest.fn(), ...timer
    });
    expect(requests).toEqual([{ url: "/v1/auth/token/lookup-self", token: "token-one" }]);
    expect(timer.delay()).toBe(43_200_000);

    writeFileSync(tokenFile, "token-two\n", { mode: 0o600 });
    await timer.run();
    expect(requests.at(-1)).toEqual({ url: "/v1/auth/token/renew-self", token: "token-two" });

    lifecycle.stop();
    expect(timer.cancelled()).toBe(true);
  });

  it("renew 실패를 명시적으로 기록하고 lifecycle을 중지한 뒤 fail-closed callback을 실행한다", async () => {
    const tokenFile = join(directory, "token");
    writeFileSync(tokenFile, "token-one\n", { mode: 0o600 });
    let failRenew = false;
    const address = await listen((request, response) => {
      if (failRenew && request.url?.endsWith("renew-self")) { response.writeHead(503).end(); return; }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: lease(600) }));
    });
    const timer = timerHarness();
    const onFatal = jest.fn();
    const logger = { error: jest.fn() };
    const lifecycle = await startVaultTokenLifecycle({
      address, tokenFile, expectedPolicy: "gateway-pki", requestTimeoutMs: 1_000, onFatal, logger, ...timer
    });

    failRenew = true;
    await timer.run();

    expect(logger.error).toHaveBeenCalledWith("[vault-token] renewal failed; closing API to fail closed.");
    expect(onFatal).toHaveBeenCalledTimes(1);
    expect(timer.cancelled()).toBe(true);
    lifecycle.stop();
  });

  const integration = process.env.VAULT_TOKEN_LIFECYCLE_INTEGRATION === "1" ? it : it.skip;
  integration("실제 Vault lookup-self/renew-self 계약을 따른다", async () => {
    const lifecycle = await startVaultTokenLifecycle({
      address: process.env.VAULT_ADDR!, tokenFile: process.env.VAULT_TOKEN_FILE!,
      expectedPolicy: "gateway-pki", requestTimeoutMs: 2_000, onFatal: jest.fn(),
      caPem: process.env.VAULT_CACERT ? readFileSync(process.env.VAULT_CACERT, "utf8") : undefined
    });
    await lifecycle.renewNow();
    lifecycle.stop();
  });

  function listen(handler: (request: IncomingMessage, response: ServerResponse) => void): Promise<string> {
    server = createServer(handler);
    return new Promise((resolve) => server!.listen(0, "127.0.0.1", () => {
      const address = server!.address();
      if (!address || typeof address === "string") throw new Error("server did not bind");
      resolve(`http://127.0.0.1:${address.port}`);
    }));
  }
});

function lease(ttl: number) {
  return { renewable: true, ttl, lease_duration: ttl, policies: ["gateway-pki"] };
}

function timerHarness() {
  let callback: (() => void | Promise<void>) | undefined;
  let delayMs = 0;
  let wasCancelled = false;
  return {
    schedule(listener: () => void | Promise<void>, delay: number) { callback = listener; delayMs = delay; return 1 as unknown as NodeJS.Timeout; },
    cancel() { wasCancelled = true; },
    async run() { await callback?.(); },
    delay() { return delayMs; },
    cancelled() { return wasCancelled; }
  };
}
