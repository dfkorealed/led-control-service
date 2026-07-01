# MVP 1 Cloud Web Mock Gateway Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the first MVP for the LED lighting control service: NestJS API, PostgreSQL/Redis data model, React PC Web monitoring/control UI, React Native WebView shell, and a mock gateway that simulates lighting state over MQTT.

**Architecture:** Use a pnpm monorepo with focused apps: `apps/api`, `apps/web`, `apps/mobile`, and `apps/mock-gateway`. The API owns persistent domain data and command creation; Redis/MQTT handle realtime state; the web app renders monitoring, control, statistics, and settings screens from typed API contracts shared through `packages/shared`.

**Tech Stack:** TypeScript, pnpm workspaces, NestJS, Prisma, PostgreSQL, Redis, MQTT, React, Vite, React Query, Zustand, React Native, WebView, Vitest/Jest, Playwright.

---

## Scope

This plan implements MVP 1 only. It does not implement the real Go gateway, ESP32-H2 firmware, real BLE Mesh communication, production OTA rollout, or pilot-site installation workflow. Those belong in separate MVP 2 and MVP 3 plans.

## Target File Structure

- Create: `package.json` - root scripts and workspace commands.
- Create: `pnpm-workspace.yaml` - workspace package discovery.
- Create: `docker-compose.yml` - PostgreSQL, Redis, and MQTT broker for local development.
- Create: `.env.example` - local environment contract.
- Create: `packages/shared` - DTOs, enums, topic names, and shared validation schemas.
- Create: `apps/api` - NestJS API, Prisma schema, realtime state, MQTT command publishing, REST endpoints.
- Create: `apps/mock-gateway` - MQTT simulator that subscribes to command topics and publishes fixture state.
- Create: `apps/web` - React PC Web UI with monitoring, control, statistics, settings, and RF planning screens.
- Create: `apps/mobile` - React Native shell that loads the web app in a WebView.
- Modify: `docs/superpowers/specs/2026-07-01-led-lighting-control-service-design.md` only if this plan reveals a spec correction.

## Domain Contracts

Use these names consistently across tasks:

```ts
export type FixtureStatus = "online" | "offline" | "fault";
export type CommandStatus = "pending" | "acknowledged" | "failed";

export interface FixtureState {
  fixtureId: string;
  brightness: number;
  powerOn: boolean;
  status: FixtureStatus;
  rssi: number | null;
  hopCount: number | null;
  commandSuccessRate: number | null;
  lastSeenAt: string;
}

export interface DimmingCommandPayload {
  commandId: string;
  siteId: string;
  targetType: "fixture" | "group";
  targetId: string;
  brightness: number;
  requestedBy: string;
  requestedAt: string;
}
```

MQTT topics:

```text
sites/{siteId}/commands/dimming
sites/{siteId}/events/fixture-state
sites/{siteId}/events/command-ack
sites/{siteId}/events/gateway-heartbeat
```

## Task 1: Monorepo Foundation

**Files:**
- Create: `package.json`
- Create: `pnpm-workspace.yaml`
- Create: `docker-compose.yml`
- Create: `.env.example`
- Create: `README.md`
- Create: `packages/shared/package.json`
- Create: `packages/shared/src/index.ts`
- Create: `packages/shared/src/domain.ts`
- Create: `packages/shared/src/mqtt.ts`
- Create: `packages/shared/src/schemas.ts`
- Create: `packages/shared/vitest.config.ts`
- Create: `packages/shared/src/schemas.test.ts`

- [ ] **Step 1: Create root workspace files**

Create `package.json`:

```json
{
  "name": "led-lighting-control-service",
  "private": true,
  "packageManager": "pnpm@9.15.0",
  "scripts": {
    "dev": "pnpm --parallel --filter @led-control/api --filter @led-control/web --filter @led-control/mock-gateway dev",
    "test": "pnpm -r test",
    "lint": "pnpm -r lint",
    "typecheck": "pnpm -r typecheck",
    "docker:up": "docker compose up -d",
    "docker:down": "docker compose down"
  },
  "devDependencies": {
    "@types/node": "^22.10.2",
    "typescript": "^5.7.2"
  }
}
```

Create `pnpm-workspace.yaml`:

```yaml
packages:
  - "apps/*"
  - "packages/*"
```

Create `.env.example`:

```dotenv
DATABASE_URL="postgresql://led:led@localhost:5432/led_control?schema=public"
REDIS_URL="redis://localhost:6379"
MQTT_URL="mqtt://localhost:1883"
API_PORT=4000
WEB_PORT=5173
WEB_PUBLIC_URL="http://localhost:5173"
```

Create `docker-compose.yml`:

```yaml
services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: led
      POSTGRES_PASSWORD: led
      POSTGRES_DB: led_control
    ports:
      - "5432:5432"
    volumes:
      - postgres-data:/var/lib/postgresql/data

  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"

  mqtt:
    image: eclipse-mosquitto:2
    ports:
      - "1883:1883"
    volumes:
      - ./infra/mosquitto.conf:/mosquitto/config/mosquitto.conf:ro

volumes:
  postgres-data:
```

Also create `infra/mosquitto.conf`:

```conf
listener 1883
allow_anonymous true
```

- [ ] **Step 2: Create shared package**

Create `packages/shared/package.json`:

```json
{
  "name": "@led-control/shared",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "src/index.ts",
  "scripts": {
    "test": "vitest run",
    "lint": "tsc --noEmit",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "zod": "^3.24.1"
  },
  "devDependencies": {
    "vitest": "^2.1.8"
  }
}
```

Create `packages/shared/src/domain.ts`:

```ts
export type FixtureStatus = "online" | "offline" | "fault";
export type CommandStatus = "pending" | "acknowledged" | "failed";

export interface FixtureState {
  fixtureId: string;
  brightness: number;
  powerOn: boolean;
  status: FixtureStatus;
  rssi: number | null;
  hopCount: number | null;
  commandSuccessRate: number | null;
  lastSeenAt: string;
}

export interface DimmingCommandPayload {
  commandId: string;
  siteId: string;
  targetType: "fixture" | "group";
  targetId: string;
  brightness: number;
  requestedBy: string;
  requestedAt: string;
}
```

Create `packages/shared/src/mqtt.ts`:

```ts
export const mqttTopics = {
  dimmingCommand: (siteId: string) => `sites/${siteId}/commands/dimming`,
  fixtureState: (siteId: string) => `sites/${siteId}/events/fixture-state`,
  commandAck: (siteId: string) => `sites/${siteId}/events/command-ack`,
  gatewayHeartbeat: (siteId: string) => `sites/${siteId}/events/gateway-heartbeat`
} as const;
```

Create `packages/shared/src/schemas.ts`:

```ts
import { z } from "zod";

export const dimmingCommandSchema = z.object({
  commandId: z.string().uuid(),
  siteId: z.string().uuid(),
  targetType: z.enum(["fixture", "group"]),
  targetId: z.string().uuid(),
  brightness: z.number().int().min(0).max(100),
  requestedBy: z.string().min(1),
  requestedAt: z.string().datetime()
});

export const fixtureStateSchema = z.object({
  fixtureId: z.string().uuid(),
  brightness: z.number().int().min(0).max(100),
  powerOn: z.boolean(),
  status: z.enum(["online", "offline", "fault"]),
  rssi: z.number().nullable(),
  hopCount: z.number().int().nonnegative().nullable(),
  commandSuccessRate: z.number().min(0).max(1).nullable(),
  lastSeenAt: z.string().datetime()
});
```

Create `packages/shared/src/index.ts`:

```ts
export * from "./domain";
export * from "./mqtt";
export * from "./schemas";
```

- [ ] **Step 3: Add schema tests**

Create `packages/shared/src/schemas.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { dimmingCommandSchema, fixtureStateSchema } from "./schemas";

describe("shared schemas", () => {
  it("accepts a valid dimming command", () => {
    const parsed = dimmingCommandSchema.parse({
      commandId: "11111111-1111-4111-8111-111111111111",
      siteId: "22222222-2222-4222-8222-222222222222",
      targetType: "fixture",
      targetId: "33333333-3333-4333-8333-333333333333",
      brightness: 70,
      requestedBy: "operator@example.com",
      requestedAt: "2026-07-01T00:00:00.000Z"
    });

    expect(parsed.brightness).toBe(70);
  });

  it("rejects brightness outside 0 to 100", () => {
    expect(() =>
      fixtureStateSchema.parse({
        fixtureId: "33333333-3333-4333-8333-333333333333",
        brightness: 101,
        powerOn: true,
        status: "online",
        rssi: -64,
        hopCount: 2,
        commandSuccessRate: 0.98,
        lastSeenAt: "2026-07-01T00:00:00.000Z"
      })
    ).toThrow();
  });
});
```

- [ ] **Step 4: Run foundation tests**

Run:

```bash
pnpm install
pnpm --filter @led-control/shared test
```

Expected: shared package tests pass.

- [ ] **Step 5: Commit**

```bash
git add package.json pnpm-workspace.yaml docker-compose.yml .env.example infra packages/shared
git commit -m "chore: scaffold monorepo foundation"
```

## Task 2: API Scaffold and Database Schema

**Files:**
- Create: `apps/api/package.json`
- Create: `apps/api/src/main.ts`
- Create: `apps/api/src/app.module.ts`
- Create: `apps/api/src/prisma/prisma.module.ts`
- Create: `apps/api/src/prisma/prisma.service.ts`
- Create: `apps/api/prisma/schema.prisma`
- Create: `apps/api/prisma/seed.ts`
- Create: `apps/api/test/domain-schema.test.ts`

- [ ] **Step 1: Scaffold NestJS API package**

Create `apps/api/package.json`:

```json
{
  "name": "@led-control/api",
  "version": "0.1.0",
  "private": true,
  "type": "commonjs",
  "scripts": {
    "dev": "nest start --watch",
    "build": "nest build",
    "test": "jest",
    "lint": "tsc --noEmit",
    "typecheck": "tsc --noEmit",
    "prisma:generate": "prisma generate",
    "prisma:migrate": "prisma migrate dev",
    "prisma:seed": "tsx prisma/seed.ts"
  },
  "dependencies": {
    "@led-control/shared": "workspace:*",
    "@nestjs/common": "^10.4.15",
    "@nestjs/core": "^10.4.15",
    "@nestjs/platform-express": "^10.4.15",
    "@prisma/client": "^6.1.0",
    "ioredis": "^5.4.2",
    "mqtt": "^5.10.3",
    "reflect-metadata": "^0.2.2",
    "rxjs": "^7.8.1"
  },
  "devDependencies": {
    "@nestjs/cli": "^10.4.8",
    "@nestjs/testing": "^10.4.15",
    "@types/jest": "^29.5.14",
    "jest": "^29.7.0",
    "prisma": "^6.1.0",
    "ts-jest": "^29.2.5",
    "tsx": "^4.19.2",
    "typescript": "^5.7.2"
  },
  "prisma": {
    "seed": "tsx prisma/seed.ts"
  }
}
```

Create `apps/api/src/main.ts`:

```ts
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.enableCors({ origin: true, credentials: true });
  await app.listen(Number(process.env.API_PORT ?? 4000));
}

void bootstrap();
```

Create `apps/api/src/app.module.ts`:

```ts
import { Module } from "@nestjs/common";
import { PrismaModule } from "./prisma/prisma.module";

@Module({
  imports: [PrismaModule]
})
export class AppModule {}
```

- [ ] **Step 2: Add Prisma service**

Create `apps/api/src/prisma/prisma.module.ts`:

```ts
import { Module } from "@nestjs/common";
import { PrismaService } from "./prisma.service";

@Module({
  providers: [PrismaService],
  exports: [PrismaService]
})
export class PrismaModule {}
```

Create `apps/api/src/prisma/prisma.service.ts`:

```ts
import { Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { PrismaClient } from "@prisma/client";

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  async onModuleInit() {
    await this.$connect();
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
```

- [ ] **Step 3: Add Prisma schema**

Create `apps/api/prisma/schema.prisma`:

```prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

enum FixtureStatus {
  online
  offline
  fault
}

enum CommandStatus {
  pending
  acknowledged
  failed
}

model Organization {
  id        String   @id @default(uuid())
  name      String
  users     User[]
  sites     Site[]
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
}

model User {
  id             String       @id @default(uuid())
  organizationId String
  email          String       @unique
  name           String
  role           String
  organization   Organization @relation(fields: [organizationId], references: [id])
  commands       Command[]
  createdAt      DateTime     @default(now())
  updatedAt      DateTime     @updatedAt
}

model Site {
  id             String       @id @default(uuid())
  organizationId String
  name           String
  address        String
  tariffKwhRate  Decimal      @db.Decimal(10, 2)
  organization   Organization @relation(fields: [organizationId], references: [id])
  floors         Floor[]
  gateways       Gateway[]
  groups         FixtureGroup[]
  commands       Command[]
  createdAt      DateTime     @default(now())
  updatedAt      DateTime     @updatedAt
}

model Floor {
  id        String      @id @default(uuid())
  siteId    String
  name      String
  level     Int
  site      Site        @relation(fields: [siteId], references: [id])
  floorPlan FloorPlan?
  fixtures  Fixture[]
  createdAt DateTime    @default(now())
  updatedAt DateTime    @updatedAt
}

model FloorPlan {
  id        String   @id @default(uuid())
  floorId   String   @unique
  imageUrl  String
  width     Int
  height    Int
  version   Int      @default(1)
  floor     Floor    @relation(fields: [floorId], references: [id])
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
}

model Fixture {
  id             String        @id @default(uuid())
  floorId        String
  meshNodeId     String?       @unique
  name           String
  ratedWatt      Decimal       @db.Decimal(8, 2)
  x              Float
  y              Float
  status         FixtureStatus @default(offline)
  brightness     Int           @default(0)
  lastSeenAt     DateTime?
  floor          Floor         @relation(fields: [floorId], references: [id])
  meshNode       MeshNode?     @relation(fields: [meshNodeId], references: [id])
  groupFixtures  GroupFixture[]
  energyUsages   EnergyUsage[]
  createdAt      DateTime      @default(now())
  updatedAt      DateTime      @updatedAt
}

model FixtureGroup {
  id            String         @id @default(uuid())
  siteId         String
  name          String
  site          Site           @relation(fields: [siteId], references: [id])
  groupFixtures GroupFixture[]
  createdAt     DateTime       @default(now())
  updatedAt     DateTime       @updatedAt
}

model GroupFixture {
  groupId   String
  fixtureId String
  group     FixtureGroup @relation(fields: [groupId], references: [id])
  fixture   Fixture      @relation(fields: [fixtureId], references: [id])

  @@id([groupId, fixtureId])
}

model Gateway {
  id              String     @id @default(uuid())
  siteId          String
  name            String
  serialNumber    String     @unique
  firmwareVersion String
  lastHeartbeatAt DateTime?
  site            Site       @relation(fields: [siteId], references: [id])
  meshNodes       MeshNode[]
  createdAt       DateTime   @default(now())
  updatedAt       DateTime   @updatedAt
}

model MeshNode {
  id              String    @id @default(uuid())
  gatewayId       String
  meshAddress     String
  firmwareVersion String
  gateway         Gateway   @relation(fields: [gatewayId], references: [id])
  fixture         Fixture?
  createdAt       DateTime  @default(now())
  updatedAt       DateTime  @updatedAt
}

model Command {
  id          String        @id @default(uuid())
  siteId      String
  requestedBy String
  targetType  String
  targetId    String
  brightness  Int
  status      CommandStatus @default(pending)
  errorMessage String?
  site        Site          @relation(fields: [siteId], references: [id])
  user        User          @relation(fields: [requestedBy], references: [id])
  createdAt   DateTime      @default(now())
  updatedAt   DateTime      @updatedAt
}

model EnergyUsage {
  id        String   @id @default(uuid())
  fixtureId String
  source    String
  period    String
  kwh       Decimal  @db.Decimal(12, 4)
  cost      Decimal  @db.Decimal(12, 2)
  fixture   Fixture  @relation(fields: [fixtureId], references: [id])
  createdAt DateTime @default(now())
}
```

- [ ] **Step 4: Add seed data**

Create `apps/api/prisma/seed.ts`. The seed resets demo data and creates one organization, one operator, one site, one floor, one floor plan, one gateway, twelve fixtures, and one group.

```ts
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  await prisma.energyUsage.deleteMany();
  await prisma.command.deleteMany();
  await prisma.groupFixture.deleteMany();
  await prisma.fixtureGroup.deleteMany();
  await prisma.fixture.deleteMany();
  await prisma.meshNode.deleteMany();
  await prisma.gateway.deleteMany();
  await prisma.floorPlan.deleteMany();
  await prisma.floor.deleteMany();
  await prisma.site.deleteMany();
  await prisma.user.deleteMany();
  await prisma.organization.deleteMany();

  const organization = await prisma.organization.create({
    data: { name: "Demo Parking Operator" }
  });

  const user = await prisma.user.create({
    data: {
      organizationId: organization.id,
      email: "operator@example.com",
      name: "Demo Operator",
      role: "admin"
    }
  });

  const site = await prisma.site.create({
    data: {
      organizationId: organization.id,
      name: "Demo Underground Parking",
      address: "Seoul",
      tariffKwhRate: "160.00"
    }
  });

  const gateway = await prisma.gateway.create({
    data: {
      siteId: site.id,
      name: "Gateway B2",
      serialNumber: "GW-DEMO-001",
      firmwareVersion: "mock-1.0.0"
    }
  });

  const floor = await prisma.floor.create({
    data: {
      siteId: site.id,
      name: "B2",
      level: -2,
      floorPlan: {
        create: {
          imageUrl: "/demo/floor-b2.svg",
          width: 1200,
          height: 800
        }
      }
    }
  });

  const group = await prisma.fixtureGroup.create({
    data: { siteId: site.id, name: "B2 Entrance Zone" }
  });

  for (let index = 0; index < 12; index += 1) {
    const meshNode = await prisma.meshNode.create({
      data: {
        gatewayId: gateway.id,
        meshAddress: `0x${(index + 1).toString(16).padStart(4, "0")}`,
        firmwareVersion: "mock-node-1.0.0"
      }
    });

    const fixture = await prisma.fixture.create({
      data: {
        floorId: floor.id,
        meshNodeId: meshNode.id,
        name: `B2-L${String(index + 1).padStart(2, "0")}`,
        ratedWatt: "40.00",
        x: 120 + (index % 4) * 220,
        y: 140 + Math.floor(index / 4) * 180,
        status: "online",
        brightness: 60,
        lastSeenAt: new Date()
      }
    });

    if (index < 4) {
      await prisma.groupFixture.create({
        data: { groupId: group.id, fixtureId: fixture.id }
      });
    }
  }

  console.log({ organizationId: organization.id, siteId: site.id, userId: user.id });
}

main()
  .finally(async () => {
    await prisma.$disconnect();
  });
```

- [ ] **Step 5: Run database migration and seed**

Run:

```bash
pnpm docker:up
cp .env.example .env
pnpm --filter @led-control/api prisma:generate
pnpm --filter @led-control/api prisma:migrate --name init
pnpm --filter @led-control/api prisma:seed
```

Expected: migration succeeds and seed logs demo IDs.

- [ ] **Step 6: Commit**

```bash
git add apps/api docker-compose.yml .env.example
git commit -m "feat(api): add domain database schema"
```

## Task 3: API Read Models for Monitoring and Settings

**Files:**
- Create: `apps/api/src/sites/sites.module.ts`
- Create: `apps/api/src/sites/sites.controller.ts`
- Create: `apps/api/src/sites/sites.service.ts`
- Create: `apps/api/src/sites/sites.service.spec.ts`
- Modify: `apps/api/src/app.module.ts`

- [ ] **Step 1: Write service tests for dashboard read model**

Create `apps/api/src/sites/sites.service.spec.ts`:

```ts
import { Test } from "@nestjs/testing";
import { SitesService } from "./sites.service";
import { PrismaService } from "../prisma/prisma.service";

describe("SitesService", () => {
  const prisma = {
    site: {
      findFirstOrThrow: jest.fn()
    }
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("returns a site dashboard with floors, fixtures, groups, and summary", async () => {
    prisma.site.findFirstOrThrow.mockResolvedValue({
      id: "site-1",
      name: "Demo Site",
      floors: [
        {
          id: "floor-1",
          name: "B2",
          level: -2,
          floorPlan: { imageUrl: "/demo.svg", width: 1200, height: 800, version: 1 },
          fixtures: [
            { id: "fixture-1", name: "L1", x: 10, y: 20, brightness: 70, status: "online", ratedWatt: "40", lastSeenAt: new Date("2026-07-01T00:00:00.000Z") },
            { id: "fixture-2", name: "L2", x: 30, y: 40, brightness: 0, status: "fault", ratedWatt: "40", lastSeenAt: null }
          ]
        }
      ],
      groups: [{ id: "group-1", name: "Entrance", groupFixtures: [{ fixtureId: "fixture-1" }] }]
    });

    const moduleRef = await Test.createTestingModule({
      providers: [SitesService, { provide: PrismaService, useValue: prisma }]
    }).compile();

    const service = moduleRef.get(SitesService);
    const dashboard = await service.getDefaultDashboard();

    expect(dashboard.summary.totalFixtures).toBe(2);
    expect(dashboard.summary.onlineFixtures).toBe(1);
    expect(dashboard.summary.faultFixtures).toBe(1);
    expect(dashboard.floors[0].fixtures[0].brightness).toBe(70);
  });
});
```

- [ ] **Step 2: Implement sites service and controller**

Create `apps/api/src/sites/sites.service.ts`:

```ts
import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";

@Injectable()
export class SitesService {
  constructor(private readonly prisma: PrismaService) {}

  async getDefaultDashboard() {
    const site = await this.prisma.site.findFirstOrThrow({
      include: {
        floors: {
          orderBy: { level: "asc" },
          include: {
            floorPlan: true,
            fixtures: { orderBy: { name: "asc" } }
          }
        },
        groups: {
          include: { groupFixtures: true },
          orderBy: { name: "asc" }
        }
      }
    });

    const fixtures = site.floors.flatMap((floor) => floor.fixtures);

    return {
      site: { id: site.id, name: site.name },
      summary: {
        totalFixtures: fixtures.length,
        onlineFixtures: fixtures.filter((fixture) => fixture.status === "online").length,
        faultFixtures: fixtures.filter((fixture) => fixture.status === "fault").length,
        averageBrightness: fixtures.length
          ? Math.round(fixtures.reduce((sum, fixture) => sum + fixture.brightness, 0) / fixtures.length)
          : 0
      },
      floors: site.floors.map((floor) => ({
        id: floor.id,
        name: floor.name,
        level: floor.level,
        floorPlan: floor.floorPlan,
        fixtures: floor.fixtures.map((fixture) => ({
          id: fixture.id,
          name: fixture.name,
          x: fixture.x,
          y: fixture.y,
          ratedWatt: Number(fixture.ratedWatt),
          brightness: fixture.brightness,
          status: fixture.status,
          lastSeenAt: fixture.lastSeenAt?.toISOString() ?? null
        }))
      })),
      groups: site.groups.map((group) => ({
        id: group.id,
        name: group.name,
        fixtureIds: group.groupFixtures.map((item) => item.fixtureId)
      }))
    };
  }
}
```

Create `apps/api/src/sites/sites.controller.ts`:

```ts
import { Controller, Get } from "@nestjs/common";
import { SitesService } from "./sites.service";

@Controller("sites")
export class SitesController {
  constructor(private readonly sitesService: SitesService) {}

  @Get("default/dashboard")
  getDefaultDashboard() {
    return this.sitesService.getDefaultDashboard();
  }
}
```

Create `apps/api/src/sites/sites.module.ts`:

```ts
import { Module } from "@nestjs/common";
import { PrismaModule } from "../prisma/prisma.module";
import { SitesController } from "./sites.controller";
import { SitesService } from "./sites.service";

@Module({
  imports: [PrismaModule],
  controllers: [SitesController],
  providers: [SitesService]
})
export class SitesModule {}
```

Modify `apps/api/src/app.module.ts`:

```ts
import { Module } from "@nestjs/common";
import { PrismaModule } from "./prisma/prisma.module";
import { SitesModule } from "./sites/sites.module";

@Module({
  imports: [PrismaModule, SitesModule]
})
export class AppModule {}
```

- [ ] **Step 3: Run API tests**

Run:

```bash
pnpm --filter @led-control/api test -- sites.service.spec.ts
```

Expected: service test passes.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src
git commit -m "feat(api): expose monitoring dashboard read model"
```

## Task 4: API Command Flow and MQTT Publishing

**Files:**
- Create: `apps/api/src/mqtt/mqtt.module.ts`
- Create: `apps/api/src/mqtt/mqtt.service.ts`
- Create: `apps/api/src/commands/commands.module.ts`
- Create: `apps/api/src/commands/commands.controller.ts`
- Create: `apps/api/src/commands/commands.service.ts`
- Create: `apps/api/src/commands/commands.service.spec.ts`
- Modify: `apps/api/src/app.module.ts`

- [ ] **Step 1: Write command service test**

Create `apps/api/src/commands/commands.service.spec.ts`:

```ts
import { Test } from "@nestjs/testing";
import { CommandsService } from "./commands.service";
import { PrismaService } from "../prisma/prisma.service";
import { MqttService } from "../mqtt/mqtt.service";

describe("CommandsService", () => {
  it("creates a pending dimming command and publishes MQTT payload", async () => {
    const createdCommand = {
      id: "11111111-1111-4111-8111-111111111111",
      siteId: "22222222-2222-4222-8222-222222222222",
      targetType: "fixture",
      targetId: "33333333-3333-4333-8333-333333333333",
      brightness: 75,
      requestedBy: "44444444-4444-4444-8444-444444444444",
      createdAt: new Date("2026-07-01T00:00:00.000Z")
    };

    const prisma = {
      command: {
        create: jest.fn().mockResolvedValue(createdCommand)
      }
    };
    const mqtt = { publishDimmingCommand: jest.fn().mockResolvedValue(undefined) };

    const moduleRef = await Test.createTestingModule({
      providers: [
        CommandsService,
        { provide: PrismaService, useValue: prisma },
        { provide: MqttService, useValue: mqtt }
      ]
    }).compile();

    const service = moduleRef.get(CommandsService);
    const result = await service.createDimmingCommand({
      siteId: createdCommand.siteId,
      targetType: "fixture",
      targetId: createdCommand.targetId,
      brightness: 75,
      requestedBy: createdCommand.requestedBy
    });

    expect(result.id).toBe(createdCommand.id);
    expect(mqtt.publishDimmingCommand).toHaveBeenCalledWith({
      commandId: createdCommand.id,
      siteId: createdCommand.siteId,
      targetType: "fixture",
      targetId: createdCommand.targetId,
      brightness: 75,
      requestedBy: createdCommand.requestedBy,
      requestedAt: "2026-07-01T00:00:00.000Z"
    });
  });
});
```

- [ ] **Step 2: Implement MQTT service**

Create `apps/api/src/mqtt/mqtt.service.ts`:

```ts
import { Injectable, OnModuleDestroy } from "@nestjs/common";
import { DimmingCommandPayload, mqttTopics } from "@led-control/shared";
import mqtt, { MqttClient } from "mqtt";

@Injectable()
export class MqttService implements OnModuleDestroy {
  private readonly client: MqttClient;

  constructor() {
    this.client = mqtt.connect(process.env.MQTT_URL ?? "mqtt://localhost:1883");
  }

  async publishDimmingCommand(payload: DimmingCommandPayload) {
    const topic = mqttTopics.dimmingCommand(payload.siteId);
    await new Promise<void>((resolve, reject) => {
      this.client.publish(topic, JSON.stringify(payload), { qos: 1 }, (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }

  onModuleDestroy() {
    this.client.end();
  }
}
```

Create `apps/api/src/mqtt/mqtt.module.ts`:

```ts
import { Module } from "@nestjs/common";
import { MqttService } from "./mqtt.service";

@Module({
  providers: [MqttService],
  exports: [MqttService]
})
export class MqttModule {}
```

- [ ] **Step 3: Implement command API**

Create `apps/api/src/commands/commands.service.ts`:

```ts
import { BadRequestException, Injectable } from "@nestjs/common";
import { dimmingCommandSchema } from "@led-control/shared";
import { PrismaService } from "../prisma/prisma.service";
import { MqttService } from "../mqtt/mqtt.service";

interface CreateDimmingCommandInput {
  siteId: string;
  targetType: "fixture" | "group";
  targetId: string;
  brightness: number;
  requestedBy: string;
}

@Injectable()
export class CommandsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly mqttService: MqttService
  ) {}

  async createDimmingCommand(input: CreateDimmingCommandInput) {
    if (!Number.isInteger(input.brightness) || input.brightness < 0 || input.brightness > 100) {
      throw new BadRequestException("brightness must be an integer from 0 to 100");
    }

    const command = await this.prisma.command.create({
      data: {
        siteId: input.siteId,
        requestedBy: input.requestedBy,
        targetType: input.targetType,
        targetId: input.targetId,
        brightness: input.brightness
      }
    });

    const payload = dimmingCommandSchema.parse({
      commandId: command.id,
      siteId: command.siteId,
      targetType: command.targetType,
      targetId: command.targetId,
      brightness: command.brightness,
      requestedBy: command.requestedBy,
      requestedAt: command.createdAt.toISOString()
    });

    await this.mqttService.publishDimmingCommand(payload);
    return command;
  }
}
```

Create `apps/api/src/commands/commands.controller.ts`:

```ts
import { Body, Controller, Post } from "@nestjs/common";
import { CommandsService } from "./commands.service";

@Controller("commands")
export class CommandsController {
  constructor(private readonly commandsService: CommandsService) {}

  @Post("dimming")
  createDimmingCommand(
    @Body()
    body: {
      siteId: string;
      targetType: "fixture" | "group";
      targetId: string;
      brightness: number;
      requestedBy: string;
    }
  ) {
    return this.commandsService.createDimmingCommand(body);
  }
}
```

Create `apps/api/src/commands/commands.module.ts`:

```ts
import { Module } from "@nestjs/common";
import { PrismaModule } from "../prisma/prisma.module";
import { MqttModule } from "../mqtt/mqtt.module";
import { CommandsController } from "./commands.controller";
import { CommandsService } from "./commands.service";

@Module({
  imports: [PrismaModule, MqttModule],
  controllers: [CommandsController],
  providers: [CommandsService]
})
export class CommandsModule {}
```

Modify `apps/api/src/app.module.ts` to import `CommandsModule`.

- [ ] **Step 4: Run command tests**

Run:

```bash
pnpm --filter @led-control/api test -- commands.service.spec.ts
```

Expected: command service test passes.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src
git commit -m "feat(api): publish dimming commands over mqtt"
```

## Task 5: Mock Gateway Simulator

**Files:**
- Create: `apps/mock-gateway/package.json`
- Create: `apps/mock-gateway/src/index.ts`
- Create: `apps/mock-gateway/src/simulator.ts`
- Create: `apps/mock-gateway/src/simulator.test.ts`

- [ ] **Step 1: Write simulator test**

Create `apps/mock-gateway/src/simulator.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { applyDimmingCommand } from "./simulator";

describe("applyDimmingCommand", () => {
  it("updates matching fixture brightness and power state", () => {
    const states = [
      {
        fixtureId: "33333333-3333-4333-8333-333333333333",
        brightness: 10,
        powerOn: true,
        status: "online" as const,
        rssi: -60,
        hopCount: 1,
        commandSuccessRate: 1,
        lastSeenAt: "2026-07-01T00:00:00.000Z"
      }
    ];

    const next = applyDimmingCommand(states, {
      commandId: "11111111-1111-4111-8111-111111111111",
      siteId: "22222222-2222-4222-8222-222222222222",
      targetType: "fixture",
      targetId: "33333333-3333-4333-8333-333333333333",
      brightness: 0,
      requestedBy: "operator@example.com",
      requestedAt: "2026-07-01T00:00:00.000Z"
    });

    expect(next[0].brightness).toBe(0);
    expect(next[0].powerOn).toBe(false);
  });
});
```

- [ ] **Step 2: Implement simulator**

Create `apps/mock-gateway/src/simulator.ts`:

```ts
import { DimmingCommandPayload, FixtureState } from "@led-control/shared";

export function applyDimmingCommand(states: FixtureState[], command: DimmingCommandPayload): FixtureState[] {
  const now = new Date().toISOString();

  return states.map((state) => {
    const matchesTarget = command.targetType === "fixture" && state.fixtureId === command.targetId;
    if (!matchesTarget) return state;

    return {
      ...state,
      brightness: command.brightness,
      powerOn: command.brightness > 0,
      lastSeenAt: now
    };
  });
}
```

Create `apps/mock-gateway/src/index.ts`:

```ts
import mqtt from "mqtt";
import { dimmingCommandSchema, FixtureState, mqttTopics } from "@led-control/shared";
import { applyDimmingCommand } from "./simulator";

const siteId = process.env.MOCK_SITE_ID ?? "";
const mqttUrl = process.env.MQTT_URL ?? "mqtt://localhost:1883";

if (!siteId) {
  throw new Error("MOCK_SITE_ID is required");
}

let states: FixtureState[] = [];
const client = mqtt.connect(mqttUrl);

client.on("connect", () => {
  client.subscribe(mqttTopics.dimmingCommand(siteId), { qos: 1 });
  setInterval(() => {
    for (const state of states) {
      client.publish(mqttTopics.fixtureState(siteId), JSON.stringify(state), { qos: 1 });
    }
    client.publish(
      mqttTopics.gatewayHeartbeat(siteId),
      JSON.stringify({ siteId, gatewaySerial: "GW-DEMO-001", sentAt: new Date().toISOString() }),
      { qos: 1 }
    );
  }, 3000);
});

client.on("message", (topic, payload) => {
  if (topic !== mqttTopics.dimmingCommand(siteId)) return;
  const command = dimmingCommandSchema.parse(JSON.parse(payload.toString()));
  states = applyDimmingCommand(states, command);
  client.publish(
    mqttTopics.commandAck(siteId),
    JSON.stringify({ commandId: command.commandId, status: "acknowledged", acknowledgedAt: new Date().toISOString() }),
    { qos: 1 }
  );
});
```

Create `apps/mock-gateway/package.json`:

```json
{
  "name": "@led-control/mock-gateway",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx src/index.ts",
    "test": "vitest run",
    "lint": "tsc --noEmit",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@led-control/shared": "workspace:*",
    "mqtt": "^5.10.3"
  },
  "devDependencies": {
    "tsx": "^4.19.2",
    "vitest": "^2.1.8"
  }
}
```

- [ ] **Step 3: Run simulator tests**

Run:

```bash
pnpm --filter @led-control/mock-gateway test
```

Expected: simulator test passes.

- [ ] **Step 4: Commit**

```bash
git add apps/mock-gateway
git commit -m "feat(mock-gateway): simulate fixture dimming commands"
```

## Task 6: Web App Shell and API Client

**Files:**
- Create: `apps/web/package.json`
- Create: `apps/web/index.html`
- Create: `apps/web/src/main.tsx`
- Create: `apps/web/src/App.tsx`
- Create: `apps/web/src/api/client.ts`
- Create: `apps/web/src/api/queries.ts`
- Create: `apps/web/src/state/navigation-store.ts`
- Create: `apps/web/src/styles.css`
- Create: `apps/web/src/App.test.tsx`

- [ ] **Step 1: Write app shell test**

Create `apps/web/src/App.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { App } from "./App";

describe("App", () => {
  it("renders the four primary navigation items", () => {
    const queryClient = new QueryClient();
    render(
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    );

    expect(screen.getByText("모니터링")).toBeInTheDocument();
    expect(screen.getByText("제어")).toBeInTheDocument();
    expect(screen.getByText("통계")).toBeInTheDocument();
    expect(screen.getByText("설정")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Implement React app shell**

Create `apps/web/src/state/navigation-store.ts`:

```ts
import { create } from "zustand";

export type PrimaryView = "monitoring" | "control" | "statistics" | "settings";

interface NavigationState {
  view: PrimaryView;
  setView: (view: PrimaryView) => void;
}

export const useNavigationStore = create<NavigationState>((set) => ({
  view: "monitoring",
  setView: (view) => set({ view })
}));
```

Create `apps/web/src/api/client.ts`:

```ts
const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:4000";

export async function apiGet<T>(path: string): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${path}`);
  if (!response.ok) throw new Error(`GET ${path} failed with ${response.status}`);
  return response.json() as Promise<T>;
}

export async function apiPost<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!response.ok) throw new Error(`POST ${path} failed with ${response.status}`);
  return response.json() as Promise<T>;
}
```

Create `apps/web/src/api/queries.ts`:

```ts
import { useQuery } from "@tanstack/react-query";
import { apiGet } from "./client";

export interface Dashboard {
  site: { id: string; name: string };
  summary: {
    totalFixtures: number;
    onlineFixtures: number;
    faultFixtures: number;
    averageBrightness: number;
  };
  floors: Array<{
    id: string;
    name: string;
    level: number;
    floorPlan: { imageUrl: string; width: number; height: number; version: number } | null;
    fixtures: Array<{
      id: string;
      name: string;
      x: number;
      y: number;
      ratedWatt: number;
      brightness: number;
      status: "online" | "offline" | "fault";
      lastSeenAt: string | null;
    }>;
  }>;
  groups: Array<{ id: string; name: string; fixtureIds: string[] }>;
}

export function useDashboard() {
  return useQuery({
    queryKey: ["dashboard"],
    queryFn: () => apiGet<Dashboard>("/sites/default/dashboard"),
    refetchInterval: 3000
  });
}
```

Create `apps/web/src/App.tsx`:

```tsx
import { useNavigationStore } from "./state/navigation-store";
import "./styles.css";

const labels = {
  monitoring: "모니터링",
  control: "제어",
  statistics: "통계",
  settings: "설정"
} as const;

export function App() {
  const { view, setView } = useNavigationStore();

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">LED Control</div>
        {Object.entries(labels).map(([key, label]) => (
          <button
            key={key}
            className={view === key ? "nav-item active" : "nav-item"}
            onClick={() => setView(key as keyof typeof labels)}
          >
            {label}
          </button>
        ))}
      </aside>
      <main className="content">
        <h1>{labels[view]}</h1>
      </main>
    </div>
  );
}
```

Create `apps/web/src/main.tsx`:

```tsx
import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { App } from "./App";

const queryClient = new QueryClient();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </React.StrictMode>
);
```

- [ ] **Step 3: Run web shell test**

Run:

```bash
pnpm --filter @led-control/web test
```

Expected: app shell test passes.

- [ ] **Step 4: Commit**

```bash
git add apps/web
git commit -m "feat(web): add control center shell"
```

## Task 7: Monitoring Map, Control Panel, Statistics, Settings

**Files:**
- Create: `apps/web/src/features/monitoring/MonitoringView.tsx`
- Create: `apps/web/src/features/monitoring/FloorMap.tsx`
- Create: `apps/web/src/features/control/ControlView.tsx`
- Create: `apps/web/src/features/statistics/StatisticsView.tsx`
- Create: `apps/web/src/features/settings/SettingsView.tsx`
- Create: `apps/web/src/features/rf/RfPlanningPanel.tsx`
- Modify: `apps/web/src/App.tsx`
- Test: `apps/web/src/features/monitoring/FloorMap.test.tsx`

- [ ] **Step 1: Write FloorMap test**

Create `apps/web/src/features/monitoring/FloorMap.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { FloorMap } from "./FloorMap";

describe("FloorMap", () => {
  it("renders fixtures with brightness labels", () => {
    render(
      <FloorMap
        floor={{
          id: "floor-1",
          name: "B2",
          level: -2,
          floorPlan: { imageUrl: "/demo.svg", width: 1200, height: 800, version: 1 },
          fixtures: [
            {
              id: "fixture-1",
              name: "B2-L01",
              x: 100,
              y: 120,
              ratedWatt: 40,
              brightness: 70,
              status: "online",
              lastSeenAt: "2026-07-01T00:00:00.000Z"
            }
          ]
        }}
      />
    );

    expect(screen.getByText("B2-L01")).toBeInTheDocument();
    expect(screen.getByText("70%")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Implement monitoring components**

Create `apps/web/src/features/monitoring/FloorMap.tsx`:

```tsx
import { Dashboard } from "../../api/queries";

interface FloorMapProps {
  floor: Dashboard["floors"][number];
}

export function FloorMap({ floor }: FloorMapProps) {
  const width = floor.floorPlan?.width ?? 1200;
  const height = floor.floorPlan?.height ?? 800;

  return (
    <div className="floor-map" style={{ aspectRatio: `${width} / ${height}` }}>
      {floor.fixtures.map((fixture) => (
        <button
          key={fixture.id}
          className={`fixture-dot ${fixture.status}`}
          style={{ left: `${(fixture.x / width) * 100}%`, top: `${(fixture.y / height) * 100}%` }}
          title={`${fixture.name} ${fixture.brightness}%`}
        >
          <span>{fixture.name}</span>
          <strong>{fixture.brightness}%</strong>
        </button>
      ))}
    </div>
  );
}
```

Create `apps/web/src/features/monitoring/MonitoringView.tsx`:

```tsx
import { useDashboard } from "../../api/queries";
import { FloorMap } from "./FloorMap";

export function MonitoringView() {
  const { data, isLoading, error } = useDashboard();

  if (isLoading) return <div className="panel">불러오는 중</div>;
  if (error || !data) return <div className="panel danger">현황 데이터를 불러오지 못했습니다.</div>;

  const floor = data.floors[0];

  return (
    <section className="screen-grid">
      <div className="summary-row">
        <div className="metric">전체 조명 <strong>{data.summary.totalFixtures}</strong></div>
        <div className="metric">온라인 <strong>{data.summary.onlineFixtures}</strong></div>
        <div className="metric">장애 <strong>{data.summary.faultFixtures}</strong></div>
        <div className="metric">평균 밝기 <strong>{data.summary.averageBrightness}%</strong></div>
      </div>
      <FloorMap floor={floor} />
    </section>
  );
}
```

- [ ] **Step 3: Implement control, statistics, settings, and RF panels**

Create `apps/web/src/features/control/ControlView.tsx`:

```tsx
import { useMemo, useState } from "react";
import { apiPost } from "../../api/client";
import { useDashboard } from "../../api/queries";

export function ControlView() {
  const { data } = useDashboard();
  const [targetId, setTargetId] = useState("");
  const [brightness, setBrightness] = useState(70);
  const fixtures = useMemo(() => data?.floors.flatMap((floor) => floor.fixtures) ?? [], [data]);

  async function submitCommand() {
    if (!data || !targetId) return;
    await apiPost("/commands/dimming", {
      siteId: data.site.id,
      targetType: "fixture",
      targetId,
      brightness,
      requestedBy: "operator@example.com"
    });
  }

  return (
    <section className="panel">
      <h2>개별 조명 제어</h2>
      <label>
        조명
        <select value={targetId} onChange={(event) => setTargetId(event.target.value)}>
          <option value="">선택</option>
          {fixtures.map((fixture) => (
            <option key={fixture.id} value={fixture.id}>
              {fixture.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        밝기 {brightness}%
        <input
          type="range"
          min="0"
          max="100"
          value={brightness}
          onChange={(event) => setBrightness(Number(event.target.value))}
        />
      </label>
      <button className="primary-button" onClick={submitCommand} disabled={!targetId}>
        적용
      </button>
    </section>
  );
}
```

Create `apps/web/src/features/statistics/StatisticsView.tsx`:

```tsx
const staticEstimate = {
  day: { kwh: 28.8, cost: 4608 },
  month: { kwh: 864, cost: 138240 },
  year: { kwh: 10512, cost: 1681920 }
};

export function StatisticsView() {
  return (
    <section className="panel">
      <h2>전력 사용량</h2>
      <div className="summary-row">
        <div className="metric">일 <strong>{staticEstimate.day.kwh} kWh</strong><span>{staticEstimate.day.cost.toLocaleString()}원</span></div>
        <div className="metric">월 <strong>{staticEstimate.month.kwh} kWh</strong><span>{staticEstimate.month.cost.toLocaleString()}원</span></div>
        <div className="metric">년 <strong>{staticEstimate.year.kwh} kWh</strong><span>{staticEstimate.year.cost.toLocaleString()}원</span></div>
      </div>
    </section>
  );
}
```

Create `apps/web/src/features/rf/RfPlanningPanel.tsx`:

```tsx
export function RfPlanningPanel() {
  return (
    <section className="panel">
      <h2>통신 음영 검토</h2>
      <p>1차 RF 검토 도구는 Hamina Planner를 사용합니다.</p>
      <ul>
        <li>입력: 주차장 도면, 층별 scale, 벽/기둥/램프 구조</li>
        <li>MVP 1 산출물: 예상 음영 후보와 권장 보강 위치</li>
        <li>MVP 2 지표: RSSI, hop count, 명령 성공률, 응답 지연</li>
      </ul>
    </section>
  );
}
```

Create `apps/web/src/features/settings/SettingsView.tsx`:

```tsx
import { useDashboard } from "../../api/queries";
import { RfPlanningPanel } from "../rf/RfPlanningPanel";

export function SettingsView() {
  const { data } = useDashboard();

  return (
    <section className="settings-grid">
      <div className="panel">
        <h2>현장 설정</h2>
        <p>{data?.site.name ?? "현장 정보를 불러오는 중"}</p>
      </div>
      <div className="panel">
        <h2>층/도면</h2>
        <p>{data?.floors.map((floor) => floor.name).join(", ") ?? "층 정보를 불러오는 중"}</p>
      </div>
      <div className="panel">
        <h2>그룹</h2>
        <p>{data?.groups.map((group) => group.name).join(", ") ?? "그룹 정보를 불러오는 중"}</p>
      </div>
      <div className="panel">
        <h2>OTA</h2>
        <p>MVP 1에서는 OTA 메뉴 구조만 노출하고 실제 배포는 MVP 2에서 구현합니다.</p>
      </div>
      <RfPlanningPanel />
    </section>
  );
}
```

- [ ] **Step 4: Connect views in App**

Modify `apps/web/src/App.tsx`:

```tsx
import { ControlView } from "./features/control/ControlView";
import { MonitoringView } from "./features/monitoring/MonitoringView";
import { SettingsView } from "./features/settings/SettingsView";
import { StatisticsView } from "./features/statistics/StatisticsView";
import { useNavigationStore } from "./state/navigation-store";
import "./styles.css";

const labels = {
  monitoring: "모니터링",
  control: "제어",
  statistics: "통계",
  settings: "설정"
} as const;

export function App() {
  const { view, setView } = useNavigationStore();

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">LED Control</div>
        {Object.entries(labels).map(([key, label]) => (
          <button
            key={key}
            className={view === key ? "nav-item active" : "nav-item"}
            onClick={() => setView(key as keyof typeof labels)}
          >
            {label}
          </button>
        ))}
      </aside>
      <main className="content">
        <h1>{labels[view]}</h1>
        {view === "monitoring" && <MonitoringView />}
        {view === "control" && <ControlView />}
        {view === "statistics" && <StatisticsView />}
        {view === "settings" && <SettingsView />}
      </main>
    </div>
  );
}
```

- [ ] **Step 5: Run web tests**

Run:

```bash
pnpm --filter @led-control/web test
```

Expected: app shell and floor map tests pass.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src
git commit -m "feat(web): add monitoring control statistics screens"
```

## Task 8: Energy Estimate API and UI

**Files:**
- Create: `apps/api/src/energy/energy.module.ts`
- Create: `apps/api/src/energy/energy.controller.ts`
- Create: `apps/api/src/energy/energy.service.ts`
- Create: `apps/api/src/energy/energy.service.spec.ts`
- Modify: `apps/api/src/app.module.ts`
- Modify: `apps/web/src/features/statistics/StatisticsView.tsx`
- Create: `apps/web/src/api/energy.ts`

- [ ] **Step 1: Write energy calculation test**

Create `apps/api/src/energy/energy.service.spec.ts`:

```ts
import { EnergyService } from "./energy.service";

describe("EnergyService", () => {
  it("estimates kWh and cost from rated watt, brightness, hours, and tariff", () => {
    const service = new EnergyService({} as never);
    const result = service.calculateEstimatedUsage({
      ratedWatt: 40,
      brightness: 50,
      hours: 10,
      tariffKwhRate: 160
    });

    expect(result.kwh).toBe(0.2);
    expect(result.cost).toBe(32);
  });
});
```

- [ ] **Step 2: Implement energy service**

Create `apps/api/src/energy/energy.service.ts`:

```ts
import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";

interface EstimateInput {
  ratedWatt: number;
  brightness: number;
  hours: number;
  tariffKwhRate: number;
}

@Injectable()
export class EnergyService {
  constructor(private readonly prisma: PrismaService) {}

  calculateEstimatedUsage(input: EstimateInput) {
    const kwh = Number(((input.ratedWatt * (input.brightness / 100) * input.hours) / 1000).toFixed(4));
    const cost = Number((kwh * input.tariffKwhRate).toFixed(2));
    return { kwh, cost };
  }

  async getDefaultSiteEstimate() {
    const site = await this.prisma.site.findFirstOrThrow({
      include: { floors: { include: { fixtures: true } } }
    });
    const fixtures = site.floors.flatMap((floor) => floor.fixtures);
    const daily = fixtures.reduce(
      (sum, fixture) =>
        sum +
        this.calculateEstimatedUsage({
          ratedWatt: Number(fixture.ratedWatt),
          brightness: fixture.brightness,
          hours: 12,
          tariffKwhRate: Number(site.tariffKwhRate)
        }).kwh,
      0
    );

    return {
      day: { kwh: Number(daily.toFixed(4)), cost: Number((daily * Number(site.tariffKwhRate)).toFixed(2)) },
      month: { kwh: Number((daily * 30).toFixed(4)), cost: Number((daily * 30 * Number(site.tariffKwhRate)).toFixed(2)) },
      year: { kwh: Number((daily * 365).toFixed(4)), cost: Number((daily * 365 * Number(site.tariffKwhRate)).toFixed(2)) }
    };
  }
}
```

- [ ] **Step 3: Create energy endpoint and connect UI**

Create `apps/api/src/energy/energy.controller.ts`:

```ts
import { Controller, Get } from "@nestjs/common";
import { EnergyService } from "./energy.service";

@Controller("energy")
export class EnergyController {
  constructor(private readonly energyService: EnergyService) {}

  @Get("default/estimate")
  getDefaultEstimate() {
    return this.energyService.getDefaultSiteEstimate();
  }
}
```

Create `apps/api/src/energy/energy.module.ts`:

```ts
import { Module } from "@nestjs/common";
import { PrismaModule } from "../prisma/prisma.module";
import { EnergyController } from "./energy.controller";
import { EnergyService } from "./energy.service";

@Module({
  imports: [PrismaModule],
  controllers: [EnergyController],
  providers: [EnergyService]
})
export class EnergyModule {}
```

Modify `apps/api/src/app.module.ts` to include `EnergyModule`:

```ts
import { Module } from "@nestjs/common";
import { CommandsModule } from "./commands/commands.module";
import { EnergyModule } from "./energy/energy.module";
import { PrismaModule } from "./prisma/prisma.module";
import { SitesModule } from "./sites/sites.module";

@Module({
  imports: [PrismaModule, SitesModule, CommandsModule, EnergyModule]
})
export class AppModule {}
```

Create `apps/web/src/api/energy.ts`:

```ts
import { useQuery } from "@tanstack/react-query";
import { apiGet } from "./client";

interface EnergyEstimate {
  day: { kwh: number; cost: number };
  month: { kwh: number; cost: number };
  year: { kwh: number; cost: number };
}

export function useEnergyEstimate() {
  return useQuery({
    queryKey: ["energy-estimate"],
    queryFn: () => apiGet<EnergyEstimate>("/energy/default/estimate")
  });
}
```

Modify `apps/web/src/features/statistics/StatisticsView.tsx`:

```tsx
import { useEnergyEstimate } from "../../api/energy";

export function StatisticsView() {
  const { data, isLoading, error } = useEnergyEstimate();

  if (isLoading) return <section className="panel">전력 통계를 불러오는 중</section>;
  if (error || !data) return <section className="panel danger">전력 통계를 불러오지 못했습니다.</section>;

  return (
    <section className="panel">
      <h2>전력 사용량</h2>
      <div className="summary-row">
        <div className="metric">일 <strong>{data.day.kwh} kWh</strong><span>{data.day.cost.toLocaleString()}원</span></div>
        <div className="metric">월 <strong>{data.month.kwh} kWh</strong><span>{data.month.cost.toLocaleString()}원</span></div>
        <div className="metric">년 <strong>{data.year.kwh} kWh</strong><span>{data.year.cost.toLocaleString()}원</span></div>
      </div>
    </section>
  );
}
```

- [ ] **Step 4: Run tests**

Run:

```bash
pnpm --filter @led-control/api test -- energy.service.spec.ts
pnpm --filter @led-control/web test
```

Expected: energy service and web tests pass.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src apps/web/src
git commit -m "feat: add estimated energy statistics"
```

## Task 9: React Native WebView Shell

**Files:**
- Create: `apps/mobile/package.json`
- Create: `apps/mobile/App.tsx`
- Create: `apps/mobile/src/WebShell.tsx`
- Create: `apps/mobile/src/WebShell.test.tsx`

- [ ] **Step 1: Write WebView shell test**

Create `apps/mobile/src/WebShell.test.tsx`:

```tsx
import { render } from "@testing-library/react-native";
import { WebShell } from "./WebShell";

describe("WebShell", () => {
  it("renders WebView with the configured web url", () => {
    const { getByTestId } = render(<WebShell webUrl="http://localhost:5173" />);
    expect(getByTestId("control-webview").props.source).toEqual({ uri: "http://localhost:5173" });
  });
});
```

- [ ] **Step 2: Implement WebView shell**

Create `apps/mobile/src/WebShell.tsx`:

```tsx
import { SafeAreaView, StyleSheet } from "react-native";
import { WebView } from "react-native-webview";

interface WebShellProps {
  webUrl: string;
}

export function WebShell({ webUrl }: WebShellProps) {
  return (
    <SafeAreaView style={styles.container}>
      <WebView testID="control-webview" source={{ uri: webUrl }} sharedCookiesEnabled />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#ffffff"
  }
});
```

Create `apps/mobile/App.tsx`:

```tsx
import { WebShell } from "./src/WebShell";

export default function App() {
  return <WebShell webUrl={process.env.EXPO_PUBLIC_WEB_URL ?? "http://localhost:5173"} />;
}
```

- [ ] **Step 3: Run mobile shell tests**

Run:

```bash
pnpm --filter @led-control/mobile test
```

Expected: WebView shell test passes.

- [ ] **Step 4: Commit**

```bash
git add apps/mobile
git commit -m "feat(mobile): add webview shell"
```

## Task 10: End-to-End Demo Verification

**Files:**
- Create: `apps/web/e2e/mvp1.spec.ts`
- Create: `apps/web/playwright.config.ts`
- Modify: `README.md`

- [ ] **Step 1: Add Playwright test**

Create `apps/web/e2e/mvp1.spec.ts`:

```ts
import { expect, test } from "@playwright/test";

test("operator can view monitoring dashboard and navigate primary sections", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("모니터링")).toBeVisible();
  await expect(page.getByText("전체 조명")).toBeVisible();
  await page.getByRole("button", { name: "제어" }).click();
  await expect(page.getByRole("heading", { name: "제어" })).toBeVisible();
  await page.getByRole("button", { name: "통계" }).click();
  await expect(page.getByRole("heading", { name: "통계" })).toBeVisible();
  await page.getByRole("button", { name: "설정" }).click();
  await expect(page.getByRole("heading", { name: "설정" })).toBeVisible();
});
```

- [ ] **Step 2: Document demo runbook**

Update `README.md` with:

```markdown
# LED Lighting Control Service

## MVP 1 Local Demo

1. Install dependencies:
   ```bash
   pnpm install
   ```

2. Start local infrastructure:
   ```bash
   pnpm docker:up
   cp .env.example .env
   ```

3. Prepare database:
   ```bash
   pnpm --filter @led-control/api prisma:generate
   pnpm --filter @led-control/api prisma:migrate --name init
   pnpm --filter @led-control/api prisma:seed
   ```

4. Start API, Web, and Mock Gateway:
   ```bash
   pnpm dev
   ```

5. Open the PC Web app:
   ```text
   http://localhost:5173
   ```
```

- [ ] **Step 3: Run full verification**

Run:

```bash
pnpm test
pnpm typecheck
pnpm --filter @led-control/web exec playwright test
```

Expected:

```text
All unit tests pass.
All TypeScript checks pass.
Playwright MVP 1 test passes.
```

- [ ] **Step 4: Commit**

```bash
git add README.md apps/web/e2e apps/web/playwright.config.ts
git commit -m "test: add mvp1 demo verification"
```

## Self-Review

Spec coverage:

- PC Web first: covered by Tasks 6, 7, 10.
- React Native WebView reuse: covered by Task 9.
- 2D floor map monitoring: covered by Task 7.
- Individual/group dimming command flow: covered by Tasks 4, 5, 7.
- Energy estimate and expected electricity cost: covered by Task 8.
- Cloud stack with NestJS, PostgreSQL, Redis, MQTT: covered by Tasks 1, 2, 4.
- Mock gateway for MVP 1: covered by Task 5.
- Hamina Planner and RF/coverage planning process: covered by Task 7 and README runbook content in Task 10.

Planned gaps by design:

- Real Go gateway, ESP32-H2 firmware, BLE Mesh, real OTA, and pilot installation workflow are outside MVP 1 and require separate implementation plans.
