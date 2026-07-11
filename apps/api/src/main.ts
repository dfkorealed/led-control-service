import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { config } from "dotenv";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";

config({ path: resolve(process.cwd(), "../../.env") });
config();

async function bootstrap() {
  const app = await NestFactory.create(AppModule, createHttpsOptions());
  const webOrigin = process.env.WEB_PUBLIC_URL ?? "http://localhost:5173";
  app.enableCors({
    origin: Array.from(new Set([webOrigin, "http://localhost:5173", "http://127.0.0.1:5173"])),
    credentials: true
  });
  await app.listen(Number(process.env.API_PORT ?? 4000));
}

function createHttpsOptions() {
  const certPath = process.env.API_TLS_CERT_PATH;
  const keyPath = process.env.API_TLS_KEY_PATH;
  const clientCaPath = process.env.API_DEVICE_CLIENT_CA_PATH;
  if (!certPath || !keyPath || !clientCaPath) return {};

  return {
    httpsOptions: {
      cert: readFileSync(certPath),
      key: readFileSync(keyPath),
      ca: readFileSync(clientCaPath),
      requestCert: true,
      rejectUnauthorized: false
    }
  };
}

void bootstrap();
