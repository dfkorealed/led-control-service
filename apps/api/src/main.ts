import { resolve } from "node:path";
import { config } from "dotenv";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import { bindLifecycleToServerClose, enableApiShutdownHooks } from "./api-lifecycle";
import { createApiHttpsOptions } from "./api-tls-options";
import { startApiTlsCrlReload } from "./api-tls-reloader";
import { startVaultTokenLifecycle } from "./pki/vault-token-lifecycle";
import { readFileSync } from "node:fs";

config({ path: resolve(process.cwd(), "../../.env") });
config();

async function bootstrap() {
  const tls = createApiHttpsOptions(process.env);
  const app = await NestFactory.create(AppModule, tls);
  enableApiShutdownHooks(app);
  if (process.env.PKI_PROVIDER?.trim().toLowerCase() === "vault") {
    const tokenFile = process.env.VAULT_TOKEN_FILE?.trim();
    if (!tokenFile) throw new Error("VAULT_TOKEN_FILE is required for Vault token renewal");
    let lifecycle;
    try {
      lifecycle = await startVaultTokenLifecycle({
        address: process.env.VAULT_ADDR?.trim() ?? "", tokenFile, expectedPolicy: "gateway-pki",
        namespace: process.env.VAULT_NAMESPACE?.trim() || undefined,
        caPem: process.env.VAULT_CACERT?.trim() ? readFileSync(process.env.VAULT_CACERT.trim(), "utf8") : undefined,
        requestTimeoutMs: Number(process.env.VAULT_REQUEST_TIMEOUT_MS ?? 5_000),
        onFatal: async () => { process.exitCode = 1; await app.close(); }
      });
    } catch (error) {
      await app.close();
      throw error;
    }
    bindLifecycleToServerClose(app.getHttpServer(), lifecycle);
  }
  if (tls.httpsOptions) {
    startApiTlsCrlReload({
      crlPaths: [process.env.API_DEVICE_CRL_PATH!.trim(), process.env.API_MANUFACTURING_CRL_PATH!.trim()],
      initialOptions: tls.httpsOptions,
      load: () => createApiHttpsOptions(process.env).httpsOptions!,
      server: app.getHttpServer()
    });
  }
  const webOrigin = process.env.WEB_PUBLIC_URL ?? "http://localhost:5173";
  app.enableCors({
    origin: Array.from(new Set([webOrigin, "http://localhost:5173", "http://127.0.0.1:5173"])),
    credentials: true
  });
  await app.listen(Number(process.env.API_PORT ?? 4000));
}

void bootstrap();
