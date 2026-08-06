import { resolve } from "node:path";
import { config } from "dotenv";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import { enableApiShutdownHooks } from "./api-lifecycle";
import { createApiHttpsOptions } from "./api-tls-options";
import { startApiTlsCrlReload } from "./api-tls-reloader";

config({ path: resolve(process.cwd(), "../../.env") });
config();

async function bootstrap() {
  const tls = createApiHttpsOptions(process.env);
  const app = await NestFactory.create(AppModule, tls);
  enableApiShutdownHooks(app);
  if (tls.httpsOptions) {
    startApiTlsCrlReload({
      crlPath: process.env.API_DEVICE_CRL_PATH!.trim(),
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
