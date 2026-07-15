import { resolve } from "node:path";
import { config } from "dotenv";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import { createApiHttpsOptions } from "./api-tls-options";

config({ path: resolve(process.cwd(), "../../.env") });
config();

async function bootstrap() {
  const app = await NestFactory.create(AppModule, createApiHttpsOptions(process.env));
  const webOrigin = process.env.WEB_PUBLIC_URL ?? "http://localhost:5173";
  app.enableCors({
    origin: Array.from(new Set([webOrigin, "http://localhost:5173", "http://127.0.0.1:5173"])),
    credentials: true
  });
  await app.listen(Number(process.env.API_PORT ?? 4000));
}

void bootstrap();
