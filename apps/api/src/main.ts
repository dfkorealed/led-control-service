import { resolve } from "node:path";
import { config } from "dotenv";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import { createApiRuntimeLifecycle, enableApiShutdownHooks } from "./api-lifecycle";
import { createApiHttpsOptions } from "./api-tls-options";
import { startApiTlsCrlReload } from "./api-tls-reloader";
import { startVaultTokenLifecycle } from "./pki/vault-token-lifecycle";
import { readFileSync } from "node:fs";

config({ path: resolve(process.cwd(), "../../.env") });
config();

async function bootstrap() {
  const tls = createApiHttpsOptions(process.env);
  // HTTP/CORS/TLS와 백그라운드 worker를 같은 API process에 조립해 하나의 종료·장애 경로로 관리한다.
  // 웹 요청만 종료되고 worker가 계속 발행하는 상태를 막고, 아래 lifecycle이 두 계층의 서버와 작업을 함께 정리한다.
  const app = await NestFactory.create(AppModule, tls);
  enableApiShutdownHooks(app);
  const runtime = createApiRuntimeLifecycle(app);
  runtime.bind(app.getHttpServer());
  if (process.env.PKI_PROVIDER?.trim().toLowerCase() === "vault") {
    const tokenFile = process.env.VAULT_TOKEN_FILE?.trim();
    if (!tokenFile) throw new Error("VAULT_TOKEN_FILE is required for Vault token renewal");
    let lifecycle;
    try {
      lifecycle = await startVaultTokenLifecycle({
        address: process.env.VAULT_ADDR?.trim() ?? "", tokenFile, expectedPolicy: "gateway-pki",
        namespace: process.env.VAULT_NAMESPACE?.trim() || undefined,
        caPem: process.env.VAULT_CA_CERT_PATH?.trim() ? readFileSync(process.env.VAULT_CA_CERT_PATH.trim(), "utf8") : undefined,
        requestTimeoutMs: Number(process.env.VAULT_REQUEST_TIMEOUT_MS ?? 5_000),
        onFatal: () => runtime.failClosed()
      });
    } catch (error) {
      await runtime.failClosed();
      throw error;
    }
    runtime.setToken(lifecycle);
  }
  if (tls.httpsOptions) {
    const crlLifecycle = startApiTlsCrlReload({
      crlPaths: [process.env.API_DEVICE_CRL_PATH!.trim(), process.env.API_MANUFACTURING_CRL_PATH!.trim()],
      initialOptions: tls.httpsOptions,
      load: () => createApiHttpsOptions(process.env).httpsOptions!,
      server: app.getHttpServer()
    });
    runtime.setCrl(crlLifecycle);
  }
  const webOrigin = process.env.WEB_PUBLIC_URL ?? "http://localhost:5173";
  app.enableCors({
    origin: Array.from(new Set([webOrigin, "http://localhost:5173", "http://127.0.0.1:5173"])),
    credentials: true
  });
  await app.listen(Number(process.env.API_PORT ?? 4000));
}

void bootstrap();
