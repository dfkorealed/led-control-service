# 스케줄·차량 감지 이벤트 제어 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 수동 override, 반복 스케줄, GPIO 마이크로웨이브 센서 기반 차량 이벤트를 클라우드에서 관리하고 Raspberry Pi Gateway가 통신 단절 중에도 무중단으로 실행하도록 구현한다.

**Architecture:** NestJS/PostgreSQL은 규칙과 revision의 정본이며 MQTT QoS 1 durable outbox로 Gateway별 전체 snapshot을 배포한다. Gateway는 snapshot을 원자 저장·hot reload하고 공통 recurrence engine과 우선순위 arbiter로 기존 BLE Mesh 밝기 명령을 실행한다. ESP32-H2는 3.3V Active High GPIO 상태를 Sensor Server와 ACK 가능한 vendor event로 전달한다.

**Tech Stack:** TypeScript 5.7, NestJS, Prisma/PostgreSQL, MQTT v5/QoS 1, React/React Query/Zustand, Temporal polyfill 0.5.1, Node test/Jest/Vitest/Playwright, ESP-IDF 5.5.1, ESP BLE Mesh C API

**Spec:** `docs/superpowers/specs/2026-08-29-schedule-vehicle-event-control-design.md`

## Global Constraints

- 모든 자동제어 실행은 Gateway에서만 수행하며 Cloud fallback 실행은 금지한다.
- 규칙 변경 시 Gateway process, MQTT, heartbeat, BLE Mesh listener를 재시작하지 않는다.
- 실행 우선순위는 `만료되지 않은 수동 override > 차량 이벤트 > 활성 스케줄 > 현재 밝기 유지`다.
- 한 규칙은 한 Gateway에만 속하고 target과 source Fixture ID를 저장 시점의 snapshot으로 고정한다.
- 스케줄 시간은 Site의 IANA timezone을 사용하며 DST 중복 시각은 한 번, 존재하지 않는 시각은 다음 유효 시각에 실행한다.
- 차량 센서는 3.3V Active High GPIO, 공통 GND, 양쪽 edge interrupt이며 시간 기반 debounce를 사용하지 않는다.
- 센서 High를 임의 timeout으로 해제하지 않고 Low 이후에만 5~1800초 hold timer를 시작한다.
- 규칙과 실행 상태는 재시작 뒤 복구되며 durable telemetry가 가득 차도 로컬 조명 제어를 중단하지 않는다.
- viewer는 조회만 가능하고 assigned admin만 자기 Site 규칙과 수동 override를 변경할 수 있다.
- 모바일 네이티브 화면과 다중 Gateway 규칙은 이번 범위에서 제외한다.
- 실제 센서·BLE Mesh 전달 성공은 HIL을 수행하기 전 완료로 표기하지 않는다.
- DB schema 변경 커밋은 `docs/database-schema.md`, 제어 기능 변경 커밋은 `docs/menus/control.md`를 함께 갱신한다.

---

## 파일 구조

- `packages/shared/src/automation-contracts.ts`: API, Gateway, Web이 공유하는 규칙·snapshot·ACK·실행 이벤트 타입과 Zod schema.
- `packages/shared/src/mqtt.ts`: automation MQTT topic과 command kind.
- `packages/automation-engine/src/recurrence.ts`: timezone/DST를 포함한 occurrence 계산.
- `packages/automation-engine/src/overlap.ts`: 두 스케줄의 실제 시간 중첩 판정.
- `apps/api/src/automation/`: CRUD, target 고정, 충돌 검증, snapshot 생성, MQTT ACK/실행 원장 수집.
- `apps/gateway/src/automation/`: snapshot 저장, hot reload, scheduler, vehicle event state, arbiter, telemetry outbox.
- `apps/gateway/src/mesh/vehicle-sensor-client.ts`: Sensor Get/Status와 vendor event ACK·중복 제거.
- `apps/esp32-h2-firmware/main/vehicle_sensor_driver.*`: GPIO 상태와 ISR queue 경계.
- `apps/esp32-h2-firmware/main/vehicle_sensor_model.*`: Sensor Server와 vendor event 전송·ACK retry.
- `apps/web/src/features/control/automation/`: 스케줄·이벤트 목록, 편집 dialog, 동기화/실행 상태.

### Task 1: 기존 Lab PKI와 API TLS 변경 검증·분리

**Files:**
- Modify: `apps/api/src/api-tls-options.ts`
- Test: `apps/api/src/api-tls-options.spec.ts`
- Modify: `scripts/pki/bootstrap-lab-vault.sh`
- Modify: `scripts/pki/issue-lab-service-cert.sh`
- Modify: `scripts/pki/sign-lab-intermediates.sh`
- Test: `scripts/pki/pki-scripts.test.mjs`
- Test: `scripts/pki/sign-lab-intermediates.test.mjs`
- Test: `scripts/lan-tls-integration.test.mjs`

**Interfaces:**
- Consumes: 현재 working tree에 남아 있는 Lab Root/intermediate/service certificate 변경.
- Produces: API와 MQTT broker가 같은 Lab trust chain/CRL을 반복 생성하고 검증하는 선행 기반.

- [ ] **Step 1: 변경 범위를 검토하고 인증서 파일 계약 테스트를 실행한다**

Run: `git diff -- apps/api/src/api-tls-options.ts apps/api/src/api-tls-options.spec.ts scripts/pki scripts/lan-tls-integration.test.mjs && pnpm test:lab:pki`

Expected: diff가 위 파일 범위로 설명 가능하고 모든 PKI script contract test가 PASS한다.

- [ ] **Step 2: API TLS 단위 테스트를 실행한다**

Run: `pnpm --filter @led-control/api test -- api-tls-options.spec.ts --runInBand`

Expected: 명시한 CA/certificate/key/CRL 누락은 fail-closed이고 정상 bundle은 PASS한다.

- [ ] **Step 3: 실패가 있으면 테스트가 요구하는 최소 trust-chain 처리만 수정한다**

```ts
export interface ApiTlsBundle {
  ca: Buffer;
  cert: Buffer;
  key: Buffer;
  crl: Buffer;
  requestCert: true;
  rejectUnauthorized: true;
}
```

수정 원칙: 개발 환경에서도 TLS 경로를 암묵적으로 건너뛰지 않고, 로그에는 private key와 Vault token을 출력하지 않는다.

- [ ] **Step 4: 회귀 검증 후 독립 커밋한다**

Run: `pnpm test:lab:pki && pnpm --filter @led-control/api typecheck`

```bash
git add apps/api/src/api-tls-options.ts apps/api/src/api-tls-options.spec.ts scripts/pki scripts/lan-tls-integration.test.mjs
git commit -m "fix(pki): complete lab certificate trust chain"
```

### Task 2: 기존 Raspberry Pi BlueZ Mesh appliance 변경 검증·분리

**Files:**
- Modify: `apps/gateway/compose.raspberry-pi.yml`
- Modify: `apps/gateway/docker/Dockerfile`
- Modify: `apps/gateway/docker/dbus-system.conf`
- Modify: `apps/gateway/docker/entrypoint.sh`
- Modify: `apps/gateway/docker/healthcheck.sh`
- Create: `apps/gateway/docker/seccomp-bluez-mesh.json`
- Modify: `apps/gateway/src/adapters/adapter-factory.ts`
- Modify: `apps/gateway/src/mesh/bluez-dbus-application.ts`
- Test: `apps/gateway/docker/compose-contract.test.mjs`
- Test: `apps/gateway/docker/container-contract.test.mjs`
- Test: `apps/gateway/src/adapters/adapter-factory.test.ts`
- Test: `apps/gateway/src/mesh/bluez-dbus-application.test.ts`

**Interfaces:**
- Consumes: host Bluetooth D-Bus와 container seccomp/capability 계약.
- Produces: production Gateway runtime에서 BlueZ Mesh adapter를 fail-closed로 시작하는 container image.

- [ ] **Step 1: container contract와 Gateway focused test를 실행한다**

Run: `node --test apps/gateway/docker/compose-contract.test.mjs apps/gateway/docker/container-contract.test.mjs`

Run: `pnpm --filter @led-control/gateway test -- adapter-factory.test.ts bluez-dbus-application.test.ts`

Expected: D-Bus socket, seccomp, healthcheck와 BlueZ object registration 계약이 모두 PASS한다.

- [ ] **Step 2: 실패가 있으면 production mode의 mock fallback을 금지한다**

```ts
if (config.meshAdapter === "bluez" && !bluezAvailable) {
  throw new Error("BlueZ Mesh adapter is required but unavailable");
}
```

healthcheck는 process 생존만 보지 않고 MQTT identity load와 BlueZ application registration을 확인한다.

- [ ] **Step 3: 전체 Gateway 검증 후 독립 커밋한다**

Run: `pnpm --filter @led-control/gateway typecheck && pnpm --filter @led-control/gateway test`

```bash
git add apps/gateway/compose.raspberry-pi.yml apps/gateway/docker apps/gateway/src/adapters apps/gateway/src/mesh/bluez-dbus-application.ts apps/gateway/src/mesh/bluez-dbus-application.test.ts
git commit -m "fix(gateway): harden Raspberry Pi BlueZ appliance"
```

### Task 3: 기존 제조 등록·배포·identity 변경 검증·분리

**Files:**
- Modify: `apps/gateway/scripts/manufacturing-enroll.ts`
- Modify: `apps/gateway/src/identity/mqtt-identity-store.ts`
- Test: `apps/gateway/src/identity/mqtt-identity-store.test.ts`
- Modify: `scripts/gateway-appliance-deploy.sh`
- Modify: `scripts/gateway-manufacturing-enroll.sh`
- Test: `scripts/gateway-appliance-scripts.test.mjs`
- Test: `scripts/gateway-manufacturing-enroll.test.mjs`

**Interfaces:**
- Consumes: 제조 인증서, private key, one-time claim code, API CA bundle.
- Produces: `/opt/led-control/gateway/data`의 원자적 identity 설치와 재실행 가능한 배포 script.

- [ ] **Step 1: script와 identity store contract를 실행한다**

Run: `node --test scripts/gateway-appliance-scripts.test.mjs scripts/gateway-manufacturing-enroll.test.mjs`

Run: `pnpm --filter @led-control/gateway test -- mqtt-identity-store.test.ts`

Expected: 인자 누락은 exit 2, key permission은 제한되고 중간 실패 시 기존 identity가 유지된다.

- [ ] **Step 2: secret 로그와 비원자 교체가 있으면 제거한다**

```ts
await writeFile(tempPath, payload, { mode: 0o600 });
await fsyncFile(tempPath);
await rename(tempPath, destinationPath);
await fsyncDirectory(dirname(destinationPath));
```

- [ ] **Step 3: 독립 커밋한다**

Run: `pnpm --filter @led-control/gateway typecheck && node --test scripts/gateway-appliance-scripts.test.mjs scripts/gateway-manufacturing-enroll.test.mjs`

```bash
git add apps/gateway/scripts/manufacturing-enroll.ts apps/gateway/src/identity scripts/gateway-appliance-deploy.sh scripts/gateway-manufacturing-enroll.sh scripts/gateway-appliance-scripts.test.mjs scripts/gateway-manufacturing-enroll.test.mjs
git commit -m "fix(gateway): complete manufacturing enrollment deployment"
```

### Task 4: automation 공유 계약과 MQTT topic 추가

**Files:**
- Create: `packages/shared/src/automation-contracts.ts`
- Create: `packages/shared/src/automation-contracts.test.ts`
- Modify: `packages/shared/src/mqtt.ts`
- Modify: `packages/shared/src/mqtt.test.ts`
- Modify: `packages/shared/src/index.ts`

**Interfaces:**
- Consumes: 기존 `GatewayCommandEnvelopeV2`, fixture/gateway/site 식별자, Zod convention.
- Produces: `AutomationSnapshotV1`, `AutomationConfigAppliedV1`, `AutomationExecutionEventV1`, `AutomationExecutionIngestedAckV1`, `ManualOverrideWindow`와 schema.

- [ ] **Step 1: 계약 실패 테스트를 작성한다**

```ts
it("rejects a snapshot with an invalid hold duration", () => {
  const result = automationSnapshotV1Schema.safeParse({
    schemaVersion: 1,
    siteId: "site-1",
    gatewayId: "gateway-1",
    revision: 3,
    timeZone: "Asia/Seoul",
    schedules: [],
    vehicleEventRules: [{ holdSeconds: 4 }],
    generatedAt: "2026-08-29T00:00:00.000Z",
    payloadHash: "sha256:invalid",
  });
  expect(result.success).toBe(false);
});
```

- [ ] **Step 2: 실패를 확인한다**

Run: `pnpm --filter @led-control/shared test -- automation-contracts.test.ts mqtt.test.ts`

Expected: `automationSnapshotV1Schema`와 automation topic이 없어 FAIL한다.

- [ ] **Step 3: 정확한 공유 타입과 schema를 구현한다**

```ts
export type AutomationRuleStatus = "enabled" | "disabled";
export type ScheduleRecurrenceKind = "once" | "daily" | "weekly" | "monthly" | "yearly";

export interface AutomationActionV1 {
  dimmingEnabled: boolean;
  brightnessPercent: number;
}

export interface AutomationSnapshotV1 {
  schemaVersion: 1;
  siteId: string;
  gatewayId: string;
  revision: number;
  timeZone: string;
  schedules: LightingScheduleSnapshotV1[];
  vehicleEventRules: VehicleEventRuleSnapshotV1[];
  generatedAt: string;
  payloadHash: `sha256:${string}`;
}

export interface LightingScheduleSnapshotV1 {
  id: string;
  name: string;
  status: AutomationRuleStatus;
  activeFrom: string;
  activeUntil: string;
  localStartTime: string;
  localEndTime: string;
  recurrence: {
    kind: ScheduleRecurrenceKind;
    weeklyDays: number[];
    monthlyDay: number | null;
    yearlyMonth: number | null;
    yearlyDay: number | null;
  };
  action: AutomationActionV1;
  fixtureIds: string[];
}

export interface VehicleEventRuleSnapshotV1 {
  id: string;
  name: string;
  status: AutomationRuleStatus;
  sourceFixtureIds: string[];
  targetFixtureIds: string[];
  action: AutomationActionV1;
  holdSeconds: number;
}

export interface AutomationConfigAppliedV1 {
  schemaVersion: 1;
  gatewayId: string;
  revision: number;
  payloadHash: `sha256:${string}`;
  status: "applied" | "rejected";
  errorCode: string | null;
  appliedAt: string;
}

export interface AutomationExecutionEventV1 {
  schemaVersion: 1;
  eventId: string;
  sequence: number;
  gatewayId: string;
  revision: number;
  ruleId: string | null;
  occurrenceKey: string | null;
  kind: "schedule_started" | "schedule_ended" | "vehicle_detected" | "event_started" | "event_extended" | "event_ended" | "action_result" | "telemetry_gap";
  occurredAt: string;
  payload: Record<string, unknown>;
}
```

`brightnessPercent`는 0~100 정수, `holdSeconds`는 5~1800 정수, weekly day는 1~7 ISO weekday, fixture ID 배열은 비어 있지 않고 중복이 없어야 한다.

- [ ] **Step 4: MQTT topic을 Gateway scope로 추가한다**

```ts
automationConfig: (siteId: string, gatewayId: string) =>
  `v2/sites/${siteId}/gateways/${gatewayId}/commands/automation/config-sync`,
automationConfigApplied: (siteId: string, gatewayId: string) =>
  `v2/sites/${siteId}/gateways/${gatewayId}/events/automation/config-applied`,
automationExecution: (siteId: string, gatewayId: string) =>
  `v2/sites/${siteId}/gateways/${gatewayId}/events/automation/execution`,
automationExecutionIngested: (siteId: string, gatewayId: string) =>
  `v2/sites/${siteId}/gateways/${gatewayId}/acks/automation/execution-ingested`,
```

- [ ] **Step 5: 공유 패키지를 검증하고 커밋한다**

Run: `pnpm --filter @led-control/shared typecheck && pnpm --filter @led-control/shared test && pnpm --filter @led-control/shared build`

```bash
git add packages/shared
git commit -m "feat(shared): define automation contracts"
```

### Task 5: 공통 recurrence/overlap engine 패키지 추가

**Files:**
- Create: `packages/automation-engine/package.json`
- Create: `packages/automation-engine/tsconfig.json`
- Create: `packages/automation-engine/src/index.ts`
- Create: `packages/automation-engine/src/recurrence.ts`
- Create: `packages/automation-engine/src/recurrence.test.ts`
- Create: `packages/automation-engine/src/overlap.ts`
- Create: `packages/automation-engine/src/overlap.test.ts`
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`

**Interfaces:**
- Consumes: `LightingScheduleSnapshotV1`, `@js-temporal/polyfill@0.5.1`.
- Produces: `getActiveOccurrence(rule, epochMs, timeZone)`, `getNextOccurrence(rule, epochMs, timeZone)`, `schedulesOverlap(left, right, timeZone)`.

- [ ] **Step 1: 월말·윤년·자정·DST 실패 테스트를 작성한다**

```ts
expect(getActiveOccurrence(monthlyDay31, Date.parse("2026-04-30T12:00:00Z"), "Asia/Seoul")).toBeNull();
expect(getNextOccurrence(yearlyLeapDay, Date.parse("2025-03-01T00:00:00Z"), "Asia/Seoul")?.localDate).toBe("2028-02-29");
expect(getActiveOccurrence(crossMidnight, Date.parse("2026-08-29T16:30:00Z"), "Asia/Seoul")?.key).toBe("schedule-1:2026-08-29");
expect(getOccurrences(dstFallback, dstWindow, "America/New_York")).toHaveLength(1);
```

- [ ] **Step 2: 패키지 test가 실패하는지 확인한다**

Run: `pnpm --filter @led-control/automation-engine test`

Expected: 새 패키지 또는 함수가 없어 FAIL한다.

- [ ] **Step 3: Temporal 기반 occurrence API를 구현한다**

```ts
export interface ScheduleOccurrence {
  key: string;
  startsAtEpochMs: number;
  endsAtEpochMs: number;
  localDate: string;
}

export function getActiveOccurrence(
  rule: LightingScheduleSnapshotV1,
  epochMs: number,
  timeZone: string,
): ScheduleOccurrence | null;
```

local date/time 변환에는 Temporal의 `disambiguation: "compatible"`을 사용하고, 존재하지 않는 월일은 다음 달로 넘기지 않고 해당 회차를 건너뛴다.

- [ ] **Step 4: overlap 판정을 구현한다**

```ts
export function schedulesOverlap(
  left: LightingScheduleSnapshotV1,
  right: LightingScheduleSnapshotV1,
  timeZone: string,
): boolean;
```

두 규칙의 유효 기간 교집합에서 recurrence 주기의 최소 반복 주기를 포함하는 bounded horizon을 열거하고 epoch interval이 `start < otherEnd && otherStart < end`인지 비교한다. yearly 규칙이 포함되면 Gregorian 윤년 주기 400년까지, 아니면 최대 14개월까지 계산한다.

- [ ] **Step 5: root build 순서와 정확한 의존성을 추가한다**

```json
{
  "dependencies": {
    "@js-temporal/polyfill": "0.5.1",
    "@led-control/shared": "workspace:*"
  }
}
```

root `dev`, `test`, `typecheck`는 shared 다음 automation-engine을 build한다.

- [ ] **Step 6: 검증하고 커밋한다**

Run: `pnpm install && pnpm --filter @led-control/automation-engine typecheck && pnpm --filter @led-control/automation-engine test && pnpm --filter @led-control/automation-engine build`

```bash
git add packages/automation-engine package.json pnpm-lock.yaml
git commit -m "feat(automation): add recurrence engine"
```

### Task 6: Prisma automation schema와 DB 문서 추가

**Files:**
- Modify: `apps/api/prisma/schema.prisma`
- Create: `apps/api/prisma/migrations/20260829_add_lighting_automation/migration.sql`
- Modify: `docs/database-schema.md`

**Interfaces:**
- Consumes: Site, Gateway, Fixture, User, Command, MqttOutbox 관계.
- Produces: automation configuration/rule/target/manual override/execution 원장 tables와 Prisma client types.

- [ ] **Step 1: schema validation이 새 model 부재로 실패하는 API test를 작성한다**

Test: `apps/api/src/automation/automation-schema.spec.ts`

```ts
expect(prisma.gatewayAutomationConfiguration).toBeDefined();
expect(prisma.lightingSchedule).toBeDefined();
expect(prisma.vehicleEventRule).toBeDefined();
expect(prisma.manualOverride).toBeDefined();
expect(prisma.automationExecution).toBeDefined();
```

- [ ] **Step 2: Prisma models와 DB check를 구현한다**

핵심 model 이름은 다음으로 고정한다.

```prisma
model GatewayAutomationConfiguration {
  gatewayId       String   @id
  siteId          String
  desiredRevision Int      @default(0)
  appliedRevision Int      @default(0)
  syncStatus      AutomationSyncStatus @default(PENDING)
  payloadHash     String?
  lastErrorCode   String?
  lastAppliedAt   DateTime?
  updatedAt       DateTime @updatedAt
}
```

추가 model은 `LightingSchedule`, `LightingScheduleFixture`, `VehicleEventRule`, `VehicleEventSource`, `VehicleEventTarget`, `ManualOverride`, `ManualOverrideFixture`, `AutomationExecution`, `AutomationExecutionFixtureResult`로 한다. migration SQL에는 brightness 0~100, hold 5~1800, revision 0 이상, join table unique key를 CHECK/UNIQUE로 강제한다. 별도 `AutomationConfigOutbox` table은 만들지 않고 기존 `MqttOutbox`에 `(gatewayId, revision, payloadHash)` deduplication key를 저장해 동일한 durable publish 책임을 재사용한다.

- [ ] **Step 3: DB 문서를 실제 필드·인덱스·삭제 정책과 일치시킨다**

`docs/database-schema.md`에 각 model의 PK/FK, unique/check, Site/Gateway tenant 경계와 history 보존 정책을 기록한다.

- [ ] **Step 4: migration과 client를 검증하고 커밋한다**

Run: `pnpm --filter @led-control/api prisma:generate && pnpm --filter @led-control/api exec prisma validate && pnpm --filter @led-control/api typecheck`

```bash
git add apps/api/prisma apps/api/src/automation/automation-schema.spec.ts docs/database-schema.md
git commit -m "feat(api): add lighting automation schema"
```

### Task 7: API target snapshot과 스케줄 CRUD 구현

**Files:**
- Create: `apps/api/src/automation/automation.module.ts`
- Create: `apps/api/src/automation/automation.controller.ts`
- Create: `apps/api/src/automation/schedules.service.ts`
- Create: `apps/api/src/automation/target-snapshot.service.ts`
- Create: `apps/api/src/automation/dto/schedule.dto.ts`
- Test: `apps/api/src/automation/schedules.service.spec.ts`
- Test: `apps/api/test/automation-schedules.e2e-spec.ts`
- Modify: `apps/api/src/app.module.ts`
- Modify: `apps/api/package.json`
- Modify: `pnpm-lock.yaml`

**Interfaces:**
- Consumes: `schedulesOverlap`, SiteAccessService, existing fixture/group/floor selection DTO convention.
- Produces: `GET/POST/PATCH/DELETE /sites/:siteId/automation/schedules`와 `incrementDesiredRevision(tx, gatewayId)`.

- [ ] **Step 1: 권한·snapshot·409 충돌 실패 테스트를 작성한다**

```ts
await expect(service.create(siteId, admin, overlappingInput)).rejects.toMatchObject({
  status: 409,
  response: { code: "schedule_overlap" },
});
expect(created.targets.map((target) => target.fixtureId).sort()).toEqual(["fixture-1", "fixture-2"]);
```

E2E에는 viewer mutation 403, 타 Site ID 404, disabled 저장 성공, enable 시 충돌 409, 동일 Site 동시 create 중 하나만 성공을 포함한다.

- [ ] **Step 2: 테스트 실패를 확인한다**

Run: `pnpm --filter @led-control/api test -- schedules.service.spec.ts automation-schedules.e2e-spec.ts --runInBand`

Expected: module/routes가 없어 FAIL한다.

- [ ] **Step 3: transaction과 Site row lock 기반 CRUD를 구현한다**

```ts
await tx.$queryRaw`SELECT id FROM "Site" WHERE id = ${siteId} FOR UPDATE`;
await this.siteAccess.assertAssignedAdmin(tx, actor, siteId);
const fixtureIds = await this.targetSnapshot.resolve(tx, siteId, input.target);
const gatewayId = await this.targetSnapshot.assertSingleGateway(tx, fixtureIds);
await this.assertNoOverlap(tx, siteId, gatewayId, fixtureIds, candidate, scheduleId);
```

저장 transaction 안에서 rule, fixture snapshot, desiredRevision 증가, full snapshot outbox 생성을 함께 commit한다.

- [ ] **Step 4: routes와 응답 상태를 구현한다**

목록 응답에는 `syncStatus`, `desiredRevision`, `appliedRevision`, `nextOccurrence`, `lastExecution`을 포함한다. create는 201, update/delete는 200, tenant 은닉은 404를 사용한다.

- [x] **Step 5: 검증하고 커밋한다**

Run: `pnpm --filter @led-control/api typecheck && pnpm --filter @led-control/api test -- schedules.service.spec.ts automation-schedules.e2e-spec.ts --runInBand`

```bash
git add apps/api/src/automation apps/api/src/app.module.ts
git commit -m "feat(api): add lighting schedule management"
```

### Task 8: API 차량 이벤트 규칙 CRUD 구현 (완료)

**Files:**
- Create: `apps/api/src/automation/vehicle-event-rules.service.ts`
- Create: `apps/api/src/automation/dto/vehicle-event-rule.dto.ts`
- Test: `apps/api/src/automation/vehicle-event-rules.service.spec.ts`
- Test: `apps/api/test/vehicle-event-rules.e2e-spec.ts`
- Modify: `apps/api/src/automation/automation.controller.ts`
- Modify: `apps/api/src/automation/automation.module.ts`

**Interfaces:**
- Consumes: Task 7 target snapshot/revision/outbox transaction helper.
- Produces: `GET/POST/PATCH/DELETE /sites/:siteId/automation/vehicle-event-rules`.

- [x] **Step 1: source/target/Gateway/hold validation 실패 테스트를 작성한다**

```ts
await expect(service.create(siteId, admin, invalidHoldDurationInput)).rejects.toMatchObject({ status: 400 });
await expect(service.create(siteId, admin, crossGatewayInput)).rejects.toMatchObject({
  status: 409,
  response: { code: "single_gateway_required" },
});
```

- [x] **Step 2: 테스트 실패를 확인한다**

Run: `pnpm --filter @led-control/api test -- vehicle-event-rules.service.spec.ts vehicle-event-rules.e2e-spec.ts --runInBand`

- [x] **Step 3: OR source와 고정 target CRUD를 구현한다**

source와 target은 각각 1개 이상, 중복 없음, 같은 Site/Gateway, 등록 완료 Fixture만 허용한다. `dimmingEnabled=false`이면 snapshot action brightness를 100으로 정규화하되 사용자가 입력한 값은 저장하지 않는다.

- [x] **Step 4: revision/outbox 원자성을 검증한다**

```ts
expect(await prisma.gatewayAutomationConfiguration.findUnique({ where: { gatewayId } })).toMatchObject({
  desiredRevision: 2,
  syncStatus: "PENDING",
});
expect(outbox.payload.revision).toBe(2);
```

- [x] **Step 5: 전체 API 검증 후 커밋한다**

Run: `pnpm --filter @led-control/api typecheck && pnpm --filter @led-control/api test -- vehicle-event-rules.service.spec.ts vehicle-event-rules.e2e-spec.ts --runInBand`

```bash
git add apps/api/src/automation apps/api/test/vehicle-event-rules.e2e-spec.ts
git commit -m "feat(api): add vehicle event rule management"
```

#### Task 8 fix round 1 (완료)

- [x] MeshNode 차량 센서 capability metadata와 source-only resolver 검증
- [x] 최신 `vehicle_detected` partial index forward migration과 catalog 계약
- [x] disable/re-enable, 기존 schedule 보존, schedule+event 동시 mutation E2E
- [x] 중립 automation list query/cursor helper와 event 전용 오류 문구
- [x] fresh/seeded migration, focused/full 회귀, lint/typecheck/build, 보고서와 별도 커밋

#### Task 8 fix round 2 (완료)

- [x] 기존 source preflight와 direct SQL source/capability/re-enable DB invariant
- [x] MeshNode/source 공통 automation statement lock과 양방향·공통 isolation race E2E
- [x] strict `VehicleSensorCapabilityReportV1`와 Gateway-scoped MQTT topic
- [x] `VehicleSensorCapabilityService.applyReport` ownership, downgrade disable/snapshot, state idempotency
- [x] supported/forged/downgrade/re-enable PostgreSQL E2E
- [x] fresh/seeded migration, shared/API focused/full 검증, lint/typecheck/build, 보고서와 별도 커밋

#### Task 8 fix round 3 (완료)

- [x] report `capabilityRevision`과 strict ingested ACK payload/topic 계약
- [x] MeshNode revision/model binding과 ProcessedGatewayEvent hash forward migration/coherence
- [x] canonical complete-report hash, eventId/revision dedupe, conflict/stale/equal/higher ordering
- [x] out-of-order unsupported/supported와 다중 rule 단일 snapshot revision PostgreSQL E2E
- [x] Task 9 authenticated consumer/durable ACK와 Task 14 durable revision/retry handoff 문서
- [x] fresh/seeded migration, shared/API/Gateway 검증, 보고서와 별도 커밋

#### Task 8 fix round 4 (완료)

- [x] `ProcessedGatewayEvent.meshNodeId` 관계/backfill과 legacy/capability partial unique index
- [x] 두 node의 동일 revision 순차·동시 적용, 같은 node conflict와 migration baseline reconciliation
- [x] unsupported model flag direct-DML coherence 교정
- [x] `MqttOutbox.applicationAckKey`와 command/config/application-ACK 3종 row shape
- [x] classification transaction의 deterministic ACK upsert, 최초 payload/시각 재사용과 conflict rejected ACK
- [x] capability safe integer 최대값, fresh/seeded/invalid migration, focused/shared/full API 검증과 보고서/문서/별도 커밋

#### Task 8 fix round 5 (완료)

- [x] Gateway/node/event 범위의 interim cross-node-safe ACK identity (breaker fix에서 report hash까지 확장)
- [x] 같은 Gateway의 cross-node eventId conflict를 별도 rejected ACK row로 보존하고 원본/충돌 양쪽 replay 검증
- [x] exact replay의 최초 payload/hash/`ingestedAt` 불변과 published-lost/deadletter revival
- [x] live unexpired publisher lease 보호와 expired lease 원자 requeue
- [x] Task 9 config/application-ACK publisher claim, QoS 1, retry/deadletter, shutdown handoff 구체화
- [x] focused PostgreSQL/shared/API/migration, lint/typecheck/build 검증과 보고서/별도 커밋

#### Task 8 breaker fix (완료)

- [x] strict ACK의 필수 `reportPayloadHash=sha256:<64 lowercase hex>` 계약
- [x] `vehicle-sensor-capability:<gatewayId>:<meshNodeId>:<eventId>:<reportPayloadHash>` exact-report ACK identity와 255-byte 이내 key 안전성
- [x] same-node/same-event altered payload의 별도 immutable rejected ACK와 원본/충돌 양방향 replay
- [x] report hash별 published/deadletter/expired-lease revival, live lease 보호, payload/hash/`ingestedAt` 불변
- [x] Task 9 exact stored ACK publish와 Task 14 hash-aware terminal matching handoff
- [x] focused PostgreSQL/shared/API/migration, lint/typecheck/build 검증과 보고서/별도 커밋

### Task 9: automation snapshot 발행·ACK·실행 원장 수집

**상태:** 완료(소프트웨어, fix round 2) (2026-08-30). Production MQTT 보안·실패 계약을 strict TDD로 구현했다. Config와 application ACK는 bounded backoff 뒤 공통 10회/15분 retained deadletter를 사용하며, execution 원장과 immutable ingested ACK outbox는 같은 transaction에 저장한다. Fix round 1은 execution을 `event.revision`의 immutable config snapshot으로 검증하고 rejected desired 상태의 out-of-order ACK 보존을 추가했다. Fix round 2는 DB source trigger가 `revision`과 `payload` 단독 UPDATE에도 발화하도록 순방향 migration으로 재생성했다. 실제 Gateway 규칙 적용과 Raspberry Pi/ESP32-H2 HIL은 후속 Task다.

**Files:**
- Create: `apps/api/prisma/migrations/20260903_revalidate_automation_execution_updates/migration.sql`
- Create: `apps/api/src/automation/automation-outbox-publisher.service.ts`
- Create: `apps/api/src/automation/automation-mqtt-consumer.service.ts`
- Create: `apps/api/src/automation/automation-runtime.module.ts`
- Test: `apps/api/src/automation/automation-schema.spec.ts`
- Test: `apps/api/src/automation/automation-outbox-publisher.service.spec.ts`
- Test: `apps/api/src/automation/automation-mqtt-consumer.service.spec.ts`
- Modify: `apps/api/src/automation/vehicle-sensor-capability.service.ts`
- Modify: `apps/api/src/mqtt/mqtt.service.ts`
- Modify: `apps/api/src/mqtt/mqtt.module.ts`
- Modify: `apps/api/src/mqtt/mqtt-shutdown-coordinator.service.ts`
- Modify: `apps/api/src/mqtt/mqtt-shutdown-coordinator.spec.ts`

**Interfaces:**
- Consumes: shared automation schema/topics, Task 7/8의 세 가지 `MqttOutbox` row shape와 processed-event idempotency pattern. Command publisher는 `dispatchId IS NOT NULL` row만 계속 소유하며 Task 9 publisher와 claim 범위를 공유하지 않는다.
- Produces: canonical hash full snapshot, exact revision applied/rejected 처리, `eventId+sequence` 멱등 원장, ingested ACK.
- Capability report consumer는 `sites/{siteId}/gateways/{gatewayId}/events/automation/vehicle-sensor-capability`를 subscribe한다. broker가 확인한 mTLS/ACL Gateway identity, topic site/gateway, payload site/gateway, DB의 active claimed Gateway identity가 모두 같을 때만 `VehicleSensorCapabilityService.applyReport`를 호출한다. unauthenticated HTTP/direct route는 만들지 않는다.
- Automation publisher는 config와 application-ACK를 **서로 다른 claim SQL**로 가져온다. Config predicate는 `dispatchId IS NULL AND applicationAckKey IS NULL AND gatewayId IS NOT NULL AND revision IS NOT NULL`, ACK predicate는 `dispatchId IS NULL AND applicationAckKey IS NOT NULL AND gatewayId IS NOT NULL AND revision IS NULL`이다. 두 query 모두 `publishedAt IS NULL`, `deadLetteredAt IS NULL`, `nextAttemptAt <= now`, lease null/만료 조건과 `FOR UPDATE SKIP LOCKED LIMIT 50`을 사용하고 같은 transaction에서 `lockedBy/lockedAt/leaseExpiresAt=now+30s`를 기록한다.
- Claim한 config와 ACK는 row의 `topic`과 저장된 JSON `payload`를 생성 시각·revision·hash 변경 없이 `MqttService.publishTopic(..., { timeoutMs: 10_000 })`로 MQTT QoS 1 발행한다. 특히 application ACK는 claim/publish 시 payload나 `reportPayloadHash`를 재계산·재구성하지 않는다. 성공 갱신과 실패 갱신은 `id + lockedBy + live lease + unpublished + non-deadletter` ownership predicate를 다시 확인한다.
- 실패는 `attempts+1`, 1초부터 최대 60초 exponential backoff와 0~20% jitter를 적용하고 lease를 해제한다. Config와 application ACK 모두 10회 또는 생성 후 15분에 `deadLetteredAt/lastError`를 기록하며 row, topic, payload, hash를 삭제·변경하지 않는다. 두 variant 모두 command relation을 조회하거나 command terminal row를 갱신하지 않는다.
- Service가 같은 transaction에 저장한 application-ACK를 `sites/{siteId}/gateways/{gatewayId}/acks/automation/vehicle-sensor-capability-ingested`에 발행한다. Identity는 `applicationAckKey=vehicle-sensor-capability:<gatewayId>:<meshNodeId>:<eventId>:<reportPayloadHash>`이고 `dispatchId/revision=NULL`이다. Same-node altered payload는 altered hash의 별도 rejected ACK row를 가지며, exact report 재전달은 Task 8 service가 해당 hash row의 최초 ACK payload/hash/`ingestedAt`을 유지한 채 published/deadletter/expired-lease 상태만 즉시 재큐잉한다. `leaseExpiresAt > now`인 row는 active publisher 소유이므로 reset하지 않는다.
- Publisher scheduler는 single-flight batch만 실행한다. `stopAndDrain()`은 timer를 중지하고 진행 중 publish를 bounded timeout까지 기다리며, batch는 shutdown 시작 뒤 다음 row를 publish하지 않는다. `MqttShutdownCoordinator`는 command/config/application-ACK/scan publisher와 mesh sync/inbound handler를 모두 drain한 뒤 MQTT client를 close한다.

- [x] **Step 1: variant claim, lease race, exact publish와 retry/deadletter 실패 테스트를 작성한다**

Config/ACK query가 각자 자기 row만 `FOR UPDATE SKIP LOCKED`로 claim하고 command row를 claim하지 않는지, 두 worker가 같은 row를 얻지 않는지 검증한다. 저장 payload/topic의 QoS 1 exact publish, 10초 timeout, backoff/jitter, retained deadletter, ownership 상실 시 no-op을 각각 RED로 확인한다. Published/deadletter ACK의 exact report revival, active lease 보호, expired lease reclaim은 Task 8 PostgreSQL 회귀를 그대로 유지한다.

- [x] **Step 2: out-of-order ACK와 중복 execution 실패 테스트를 작성한다**

```ts
await consumer.onConfigApplied({ gatewayId, revision: 4, status: "applied", payloadHash });
await consumer.onConfigApplied({ gatewayId, revision: 3, status: "applied", payloadHash: oldHash });
expect(config.appliedRevision).toBe(4);

await consumer.onExecution(event);
await consumer.onExecution(event);
expect(await prisma.automationExecution.count()).toBe(1);
expect(publishedIngestedAcks).toHaveLength(2);
```

- [x] **Step 3: canonical payload hash와 full snapshot을 구현한다**

```ts
const payloadHash = `sha256:${createHash("sha256").update(stableJson(snapshotWithoutHash)).digest("hex")}` as const;
```

배열은 ID 기준 정렬하고 object key는 stable serializer로 정렬해 같은 revision의 hash가 process마다 달라지지 않게 한다.

- [x] **Step 4: config/application-ACK publisher와 ACK·실행 원장을 구현한다**

위 variant별 claim/lease/publish/retry/deadletter 계약을 `AutomationOutboxPublisherService`에 구현한다. Rejected config ACK는 desiredRevision을 낮추지 않고 `syncStatus=REJECTED`, 정제된 error code를 저장하며 이후 lower applied ACK는 applied revision만 전진시키고 current rejection을 보존한다. Execution은 unique `(gatewayId,eventId,sequence)`와 canonical payload hash로 dedupe하고, `event.revision`에 해당하는 stored full snapshot으로 source/target을 검증한 뒤 terminal fixture 결과 및 immutable application ACK outbox와 같은 transaction에 저장한다.

- [x] **Step 5: shutdown drain을 연결하고 검증 후 커밋한다**

`MqttShutdownCoordinator`에 automation publisher `stopAndDrain()`을 등록하고 active publish 완료 전 MQTT close가 호출되지 않으며 shutdown 뒤 다음 row를 시작하지 않는지 검증한다.

Run: `pnpm --filter @led-control/api typecheck && pnpm --filter @led-control/api test -- automation-snapshot.service.spec.ts automation-outbox-publisher.service.spec.ts automation-mqtt-consumer.service.spec.ts mqtt-shutdown-coordinator.spec.ts --runInBand`

```bash
git add apps/api/src/automation apps/api/src/mqtt/mqtt.module.ts apps/api/src/mqtt/mqtt-shutdown-coordinator.service.ts apps/api/src/mqtt/mqtt-shutdown-coordinator.spec.ts
git commit -m "feat(api): synchronize gateway automation snapshots"
```

### Task 10: 수동 명령 overrideUntil 계약과 저장

**Files:**
- Modify: `packages/shared/src/gateway-contracts.ts`
- Modify: `packages/shared/src/gateway-contracts.test.ts`
- Modify: `apps/api/src/commands/commands.service.ts`
- Modify: `apps/api/src/commands/commands.service.spec.ts`
- Modify: `apps/api/src/commands/dto/create-command.dto.ts`
- Modify: `apps/web/src/api/commands.ts`

**Interfaces:**
- Consumes: 기존 synchronous dimming command와 fixture terminal result.
- Produces: ISO instant `overrideUntil`, 서버 기본값 `now+1h`, Gateway 대상별 durable manual override.

- [x] **Step 1: 기본값·과거 시각·viewer 실패 테스트를 작성한다**

```ts
expect(created.overrideUntil).toBe("2026-08-29T01:00:00.000Z");
await expect(create({ overrideUntil: "2026-08-28T23:59:59.000Z" })).rejects.toMatchObject({ status: 400 });
```

- [x] **Step 2: 공유 command schema와 API 저장을 구현한다**

```ts
const overrideUntil = input.overrideUntil ?? new Date(clock.now() + 60 * 60 * 1000).toISOString();
```

요청 시각보다 미래이고 최대 30일 이내인 ISO instant만 허용하며 command와 `ManualOverride`/fixture rows를 기존 Site lock transaction 안에서 함께 저장한다.

- [x] **Step 3: 기존 동기 ACK 회귀 검증 후 커밋한다**

Run: `pnpm --filter @led-control/shared test && pnpm --filter @led-control/api test -- commands.service.spec.ts --runInBand && pnpm --filter @led-control/api typecheck`

```bash
git add packages/shared/src/gateway-contracts.ts packages/shared/src/gateway-contracts.test.ts apps/api/src/commands apps/web/src/api/commands.ts
git commit -m "feat(control): add timed manual overrides"
```

### Task 11: Gateway snapshot 원자 저장과 hot reload

**Files:**
- Create: `apps/gateway/src/automation/automation-config-store.ts`
- Create: `apps/gateway/src/automation/automation-config-store.test.ts`
- Create: `apps/gateway/src/automation/automation-runtime.ts`
- Create: `apps/gateway/src/automation/automation-runtime.test.ts`
- Modify: `apps/gateway/src/gateway.ts`
- Modify: `apps/gateway/src/runtime/gateway-mqtt-runtime.ts`
- Modify: `apps/gateway/package.json`

**Interfaces:**
- Consumes: `AutomationSnapshotV1`, exact revision/hash, MQTT config topic.
- Produces: `AutomationConfigStore.load/apply`, `AutomationRuntime.hotReload`, applied/rejected ACK.

- [x] **Step 1: invalid/old snapshot rollback과 process 무중단 테스트를 작성한다**

```ts
await runtime.hotReload(validRevision4);
await expect(runtime.hotReload(invalidRevision5)).rejects.toThrow("snapshot_invalid");
expect(runtime.currentRevision).toBe(4);
expect(mqttConnection.disconnect).not.toHaveBeenCalled();
expect(meshAdapter.stop).not.toHaveBeenCalled();
```

- [x] **Step 2: 테스트 실패를 확인한다**

Run: `pnpm --filter @led-control/gateway test -- automation-config-store.test.ts automation-runtime.test.ts`

- [x] **Step 3: 원자 file 교체를 구현한다**

```ts
export interface AutomationConfigStore {
  load(): Promise<AutomationSnapshotV1 | null>;
  apply(snapshot: AutomationSnapshotV1): Promise<void>;
}
```

temp write → file fsync → rename → parent directory fsync 후에만 메모리 참조를 교체한다. revision이 낮거나 같은데 hash가 다르면 거부하고 같은 revision/hash는 idempotent ACK한다.

- [x] **Step 4: runtime queue에서 hot reload를 직렬화한다**

snapshot validation/storage/reference swap/recompute를 하나의 automation serial queue로 실행한다. 재계산 결과가 현재 desired state와 다를 때만 mesh action을 요청한다.

- [ ] **Step 5: 검증하고 커밋한다**

Run: `pnpm --filter @led-control/gateway typecheck && pnpm --filter @led-control/gateway test -- automation-config-store.test.ts automation-runtime.test.ts`

```bash
git add apps/gateway/src/automation apps/gateway/src/gateway.ts apps/gateway/src/runtime/gateway-mqtt-runtime.ts apps/gateway/package.json pnpm-lock.yaml
git commit -m "feat(gateway): hot reload automation snapshots"
```

### Task 12: Gateway scheduler·priority arbiter·재시작 복구

**상태:** 완료 (2026-08-30)

**Files:**
- Create: `apps/gateway/src/automation/automation-state-store.ts`
- Create: `apps/gateway/src/automation/automation-state-store.test.ts`
- Create: `apps/gateway/src/automation/automation-arbiter.ts`
- Create: `apps/gateway/src/automation/automation-arbiter.test.ts`
- Create: `apps/gateway/src/automation/schedule-runtime.ts`
- Create: `apps/gateway/src/automation/schedule-runtime.test.ts`
- Create: `apps/gateway/src/automation/clock-trust-provider.ts`
- Create: `apps/gateway/src/automation/clock-trust-provider.test.ts`
- Modify: `apps/gateway/src/commands/gateway-command-handler.ts`
- Modify: `apps/gateway/compose.raspberry-pi.yml`

**Interfaces:**
- Consumes: common recurrence engine, applied snapshot, existing mesh dimming executor, manual `overrideUntil`.
- Produces: fixture별 `DesiredLightingState`, occurrence key, pre-schedule/pre-event brightness, persisted timers.

- [x] **Step 1: fake wall/monotonic clock 기반 우선순위 테스트를 작성한다**

```ts
expect(resolveDesiredState({ manual: activeManual, events: [80], schedule: 40, current: 20 }).brightness).toBe(60);
expect(resolveDesiredState({ manual: null, events: [50, 80], schedule: 40, current: 20 }).brightness).toBe(80);
expect(resolveDesiredState({ manual: null, events: [], schedule: 40, current: 20 }).brightness).toBe(40);
```

첫 assertion의 `activeManual.brightness`는 60이다. 추가로 override 만료 후 event 복귀, schedule 종료 전 밝기 복귀, 재시작 중 occurrence 중복 명령 없음, system clock 불신 시 새 경계 중단을 검증한다.

- [x] **Step 2: durable state schema를 구현한다**

```ts
export interface PersistedAutomationStateV1 {
  schemaVersion: 1;
  activeOccurrences: Record<string, { key: string; startedAt: string; preBrightness: Record<string, number> }>;
  manualOverrides: Record<string, { brightnessPercent: number; overrideUntil: string }>;
  vehicleRules: Record<string, PersistedVehicleRuleState>;
  lastDesiredByFixture: Record<string, number>;
}
```

- [x] **Step 3: scheduler와 arbiter를 구현한다**

wall clock은 recurrence 경계 계산에만, monotonic clock은 현재 process의 event hold에 사용한다. restart 시 persisted UTC expiry를 wall clock과 비교해 복구하되 clock 신뢰 검사가 실패하면 새 schedule transition을 실행하지 않는다.

production `ClockTrustProvider`는 container에 read-only mount한 `/run/systemd/timesync/synchronized` 존재 여부를 확인하고, 실행 중 wall clock이 마지막 관측값보다 5분 이상 뒤로 이동하면 다시 동기화 marker가 갱신될 때까지 untrusted로 전환한다. test는 fake provider를 사용한다. 시계가 untrusted여도 MQTT, 수동 제어, sensor current state와 monotonic hold 처리는 계속한다.

- [x] **Step 4: 같은 desired brightness 중복 전송을 억제한다**

기존 상태와 값이 다를 때만 기존 unicast/limited parallel/group 전송기를 호출하며 fixture별 terminal result를 execution telemetry로 전달한다.

- [x] **Step 5: 검증하고 커밋한다**

Run: `pnpm --filter @led-control/gateway typecheck && pnpm --filter @led-control/gateway test -- automation-state-store.test.ts automation-arbiter.test.ts schedule-runtime.test.ts clock-trust-provider.test.ts`

```bash
git add apps/gateway/src/automation apps/gateway/src/commands/command-handler.ts apps/gateway/compose.raspberry-pi.yml
git commit -m "feat(gateway): execute durable lighting schedules"
```

**Fix round 1 (2026-08-30):**

- [x] RF를 telemetry capacity와 분리하고 terminal enqueue 실패를 durable `telemetryGap`으로 인계한다.
- [x] Fixture transition을 `pending -> terminal`로 저장하고 성공 terminal만 dedup하며 불확실성은 at-least-once로 재시도한다.
- [x] Manual-only 만료의 마지막 수동 밝기 유지, current-process monotonic expiry와 restart trusted UTC 복구를 적용한다.
- [x] Timesync directory read-only mount와 rollback marker recovery fence를 적용한다.
- [x] Command journal terminal/handoff phase를 재생 가능하게 만들고 prepare/completed crash fault test를 추가한다.
- [x] Scheduler `stopAndDrain()`으로 intake 차단과 RF/state/handoff drain을 production shutdown에 연결한다.

**Fix round 2 (2026-08-30):**

- [x] V1/V2 migration과 pending restart를 fixture observed-state resync로 분류해 target mismatch에만 RF를 전송한다.
- [x] 이미 활성인 schedule/event의 pre-state를 manual terminal이 덮지 않도록 layered base 복귀를 수정한다.
- [x] Clock-untrusted 중 수신한 manual도 server-confirmed duration으로 current-process monotonic deadline을 만든다.
- [x] Persisted snapshot activation 뒤 pending manual handoff를 재생하고 실제 `ScheduleRuntime` 통합으로 검증한다.
- [x] Pending manual recovery를 TTL/일반 eviction에서 보호하고 별도 bounded capacity error를 적용한다.
- [x] Process-local manual guard/deadline/observation fence를 atomic state 성공 뒤 변경하고 fault-injection tick으로 검증한다.

**Fix round 3 (2026-08-30):**

- [x] BlueZ OnOff/Lightness observation을 Health completion과 분리해 automation recovery fence에 직접 전달한다.
- [x] RF success 뒤 terminal state write failure/commit uncertainty에 same-process observation fence를 세운다.
- [x] MQTT control plane을 먼저 시작하고 full Mesh resync를 bounded background worker/readiness/shutdown drain으로 전환한다.
- [x] API outbox absolute override expiry와 Gateway trusted remaining/untrusted 10초 fail-safe 정책으로 stale manual 부활을 차단한다.

**Fix round 4 (2026-08-30, 완료):**

- [x] Legacy persisted journal/old API wire를 compatibility parser로 복구하고 strict expiry invariant는 새 producer output에만 적용한다.
- [x] Command publish transaction에서 override remaining/delivery generation을 durable payload로 확정하고 exact retry와 broker TTL을 일치시킨다.
- [x] Broker remaining TTL 기반 receipt-relative monotonic deadline과 untrusted restart manual 보류 정책을 적용한다.
- [x] Terminal commit observation fence가 bounded targeted lighting resync와 retry/backoff를 즉시 요청하게 한다.
- [x] Full/targeted resync에 fixture-boundary cancellation과 production bounded shutdown을 적용한다.

### Task 13: Gateway 차량 이벤트 상태와 durable telemetry

**Files:**
- Create: `apps/gateway/src/automation/vehicle-event-runtime.ts`
- Create: `apps/gateway/src/automation/vehicle-event-runtime.test.ts`
- Create: `apps/gateway/src/automation/automation-telemetry-outbox.ts`
- Create: `apps/gateway/src/automation/automation-telemetry-outbox.test.ts`
- Modify: `apps/gateway/src/automation/automation-runtime.ts`
- Modify: `apps/gateway/src/runtime/gateway-mqtt-runtime.ts`

**Interfaces:**
- Consumes: normalized sensor `detected|cleared|current-state`, monotonic clock, arbiter.
- Produces: OR source set, Low 이후 hold expiry, max-brightness aggregation, application-ACK telemetry outbox.

- [x] **Step 1: 센서 OR/hold/retrigger/overlap 테스트를 작성한다**

```ts
runtime.onDetected("sensor-a", 1000);
runtime.onCleared("sensor-a", 2000);
clock.advance(30_000);
runtime.onDetected("sensor-b", 32_000);
expect(runtime.isRuleActive(ruleId)).toBe(true);
expect(runtime.getDesiredBrightness("fixture-1")).toBe(80);
```

High 장기 유지 시 timeout 해제되지 않음, 마지막 Low부터 60초, event 중 manual override가 출력을 가림, override 만료 후 event 즉시 적용을 포함한다.

- [x] **Step 2: event 상태와 복귀를 구현한다**

활성 source set이 비지 않으면 hold timer를 취소한다. 마지막 source가 빠질 때 monotonic expiry와 복구용 UTC expiry를 함께 저장한다. event 종료 시 현재 schedule이 있으면 schedule, 없으면 첫 event 직전 밝기를 arbiter에 제공한다.

- [x] **Step 3: telemetry outbox와 공간 상한을 구현한다**

`schedule_started`, `schedule_ended`, `vehicle_detected`, `event_started`, `event_extended`, `event_ended`, `action_result`를 저장한다. 동일 active event의 `event_extended`는 최신 expiry로 upsert한다. pending payload 총량은 64 MiB로 제한하고 상한에 도달하면 먼저 모든 active event의 연장 record를 병합한다. 그래도 공간이 없으면 새 telemetry payload 대신 고정 크기 `telemetry_gap { firstDroppedAt, lastDroppedAt, droppedCount }`를 원자 갱신하며 로컬 제어는 계속한다.

- [x] **Step 4: application ACK 삭제와 재전달을 검증한다**

```ts
await outbox.markIngested(eventId, sequence);
expect(await outbox.pending()).not.toContainEqual(expect.objectContaining({ eventId, sequence }));
```

- [x] **Step 5: 검증하고 커밋한다**

Run: `pnpm --filter @led-control/gateway typecheck && pnpm --filter @led-control/gateway test -- vehicle-event-runtime.test.ts automation-telemetry-outbox.test.ts`

```bash
git add apps/gateway/src/automation apps/gateway/src/runtime/gateway-mqtt-runtime.ts
git commit -m "feat(gateway): execute vehicle sensor events"
```

**Fix round 4 (2026-08-30, 완료):**

- [x] 최초 `telemetryGap` 후보의 stable identity/count를 state write 전에 확정하고, durable state `ENOSPC`에서는 동일 cumulative 후보를 preallocated fixed journal에 직접 수용한다.
- [x] State와 journal이 모두 실패하면 새 배열을 늘리지 않고 하나의 cumulative retained source에 시각 범위와 count를 합치며 `automation_state_durability_degraded` health와 1초~30초 coordinator retry를 유지한다.
- [x] Journal 수용 후보를 process state에 mirror해 full disk 중 후속 drop도 오래된 disk count가 아닌 마지막 durable journal count에서 이어가고, 다른 journal source가 사이에 기록돼도 cumulative source receipt 하나를 별도 고정 필드로 보존한다.
- [x] Storage 회복 retry가 만든 outbox 변경은 publisher를 깨우고 transient outbox 실패도 다음 bounded backoff를 다시 예약하며, durable clear 전 receipt 유지, commit-uncertain taxonomy, exact event replay와 application ACK ordering을 보존한다.
- [x] RED/GREEN으로 최초 state `ENOSPC`, state+journal 동시 실패, bounded cumulative retry, journal fallback restart, interleaved source, 같은 identity 재수용, commit uncertainty와 transient outbox recovery를 검증했다.

검증: Task 13 focused 8파일 161/161, Gateway 전체 56파일 488/488, shared 74/74, Docker 계약 17/17, 필수 Mosquitto 2/2와 Shared/Gateway typecheck·lint·build를 통과했다. 실제 Raspberry Pi storage exhaustion·power loss·flash wear와 ESP32-H2/BlueZ RF HIL은 별도 검증이다.

**Fix round 5 (2026-08-30, 완료):**

- [x] Fixed journal aggregate에 outbox가 durable 수용한 누적 baseline과 acceptance handoff ID/hash를 고정 필드로 저장하고, clear까지 aggregate identity를 유지한다.
- [x] Reimport count는 bounded last/cumulative source metadata가 아니라 `aggregate - acceptedBaseline`으로만 계산하며 source receipt는 state replay identity 용도로만 사용한다.
- [x] Outbox commit 뒤 baseline commit과 clear의 failure/uncertainty에서 previous·next visible block을 모두 재시작 복구하고 동일 `telemetry_gap` event ID/sequence/final hash로 수렴한다.
- [x] General source 교체를 32회 반복해 exact cumulative count와 8 KiB preallocated inode/block 고정을 검증하고 clear tombstone 뒤 새 source generation도 보존한다.

검증: Task 13 focused 8파일 175/175, Gateway 전체 56파일 494/494, shared 74/74, Docker 계약 17/17, 필수 Mosquitto 2/2와 Shared/Gateway typecheck·lint·build를 통과했다. 실제 Raspberry Pi storage exhaustion·power loss·flash wear와 ESP32-H2/BlueZ RF HIL은 별도 검증이다.

**Fix round 5 breaker (2026-08-30, 완료):**

- [x] Accepted aggregate baseline에 흡수되고 state/journal에서 더 이상 재생 불가능한 general source receipt를 같은 durable outbox import commit에서 제거한다.
- [x] 현재 state pending handoff/gap, current journal source, cumulative source, aggregate와 active baseline identity를 cleanup 보호 집합으로 유지한다.
- [x] Clear 100회 실패와 source 교체 및 50회 지점 restart에서 accepted receipt를 O(1)로 유지하면서 total 100과 exact event ID/sequence/final hash를 검증한다.
- [x] Receipt cleanup의 definite failure와 previous·next commit uncertainty를 재시도/restart로 복구하고 이후 clear 성공 시 정상 수렴한다.

검증: Gateway focused 2파일 42/42, Gateway 전체 56파일 499/499, shared 74/74, Docker 계약 17/17, 필수 Mosquitto 2/2와 Shared/Gateway typecheck·lint·build 및 diff-check를 통과했다. 실제 Raspberry Pi storage exhaustion·power loss·flash wear와 ESP32-H2/BlueZ RF HIL은 별도 검증이다.

### Task 14: Gateway BLE Mesh Sensor Client와 vendor ACK 처리

**Files:**
- Create: `apps/gateway/src/mesh/vehicle-sensor-client.ts`
- Create: `apps/gateway/src/mesh/vehicle-sensor-client.test.ts`
- Modify: `apps/gateway/src/mesh/bluez-dbus-application.ts`
- Modify: `apps/gateway/src/mesh/bluez-mesh-model-config.ts`
- Modify: `apps/gateway/src/mesh/mesh-store-file.ts`
- Modify: `apps/gateway/src/gateway.ts`

**Interfaces:**
- Consumes: Sensor Status 현재 Presence/Motion property, vendor payload `{bootId,sequence,eventKind,level}`.
- Produces: dedupe key `(sourceUnicast,bootId,sequence)`, vendor application ACK, startup Sensor Get, normalized sensor events.
- Produces: node별 durable `VehicleSensorCapabilityReportV1` journal과 report topic publish. journal은 `capabilityRevision`, `eventId`, complete report payload와 그 canonical `reportPayloadHash`를 함께 저장한다.

- [x] **Step 1: 중복·재부팅·startup query 테스트를 작성한다**

```ts
await client.onVendorEvent(source, { bootId: 7, sequence: 9, eventKind: "detected", level: true });
await client.onVendorEvent(source, { bootId: 7, sequence: 9, eventKind: "detected", level: true });
expect(runtimeEvents).toHaveLength(1);
expect(sentAcks).toHaveLength(2);
```

- [x] **Step 2: Sensor Status와 vendor opcode decoder를 구현한다**

표준 property ID는 ESP-IDF/공식 Bluetooth assigned-number header의 `Presence Detected` 상수를 사용하고 숫자를 중복 하드코딩하지 않는다. 잘못된 length, 알려지지 않은 source, 현재 Gateway 규칙에 없는 sensor는 상태 변경 없이 정제 로그만 남긴다.

- [x] **Step 3: dedupe 영속화와 startup Sensor Get을 구현한다**

bootId가 바뀌면 sequence가 작아져도 새 session으로 처리한다. 각 configured source에 Gateway startup/reconnect 후 Sensor Get을 보내고 Status High/Low를 runtime current-state로 반영한다.

Sensor Server와 vendor vehicle event model의 bound 상태가 실제로 바뀔 때만 node의 `capabilityRevision`을 1 증가시키고 새 `eventId`와 두 model boolean을 포함한 complete report, canonical `reportPayloadHash`를 원자 저장한다. broker PUBACK만으로 delivered 처리하지 않고 capability ingested ACK가 올 때까지 같은 eventId/revision/payload/hash를 재시도한다. reconnect에서는 저장한 현재 report를 revision 증가 없이 그대로 재발행한다. ACK의 `eventId`, `gatewayId`, `meshNodeId`, `capabilityRevision`, `reportPayloadHash`가 journal과 모두 일치할 때만 `applied|stale|duplicate`를 terminal로 처리하고 `rejected`는 journal을 보존한 채 정제된 conflict 진단으로 fail-closed 한다. Event/node/revision이 같아도 다른 report hash의 ACK는 현재 journal에 적용하지 않고 무시한다.

- [x] **Step 4: 검증하고 커밋한다**

Run: `pnpm --filter @led-control/gateway typecheck && pnpm --filter @led-control/gateway test -- vehicle-sensor-client.test.ts bluez-dbus-application.test.ts`

```bash
git add apps/gateway/src/mesh apps/gateway/src/gateway.ts
git commit -m "feat(gateway): ingest BLE Mesh vehicle sensors"
```

검증: Gateway focused 7파일 94/94, Gateway 전체 57파일 523/523, shared 74/74, Docker 계약 17/17, 필수 mTLS Mosquitto 2/2와 Shared/Gateway typecheck·lint·build 및 diff-check를 통과했다. 실제 Raspberry Pi/ESP32-H2 RF, packet loss, power-loss와 flash-wear HIL은 별도 검증이다.

Fix Round 1에서는 production Company ID 명시 설정, automation state v5 atomic sensor inbox와 bounded recent boot high-water, provisioning terminal-first/durable capability refresh retry, Percentage 8 decode, capability uncertainty target reconciliation, sensor intake bounded drain을 추가했다. 단일 sensor 모듈은 codec/controller/capability failure boundary로 분리했다. 상세 RED/GREEN 근거와 HIL 한계는 `.superpowers/sdd/2026-08-29-schedule-vehicle-event-control/task-14-report.md`를 따른다.

Fix Round 2에서는 최초 refresh journal write definite failure를 bounded volatile pending set과 1초~30초 retry로 보존하고 active retry를 shutdown drain에 포함한다. Startup/reconnect와 개별 provisioning refresh는 공통 batch API로 pending enqueue 1회, Config 성공 binding/completion 1회만 commit해 rewrite count O(1), total bytes O(N)을 보장한다. Partial failure는 해당 node만 pending에 남고 batch uncertainty는 previous/next/unknown read-back으로 수렴하거나 fence한다.

### Task 15: ESP32-H2 GPIO vehicle sensor driver

**Files:**
- Create: `apps/esp32-h2-firmware/main/vehicle_sensor_driver.h`
- Create: `apps/esp32-h2-firmware/main/vehicle_sensor_driver.c`
- Create: `apps/esp32-h2-firmware/test/native/test_vehicle_sensor_driver.c`
- Modify: `apps/esp32-h2-firmware/main/Kconfig.projbuild`
- Modify: `apps/esp32-h2-firmware/main/CMakeLists.txt`
- Modify: `apps/esp32-h2-firmware/main/app_main.c`
- Modify: `apps/esp32-h2-firmware/main/ble_mesh_node.c`
- Modify: `scripts/esp32-h2-build.sh`
- Modify: `scripts/esp32-h2-flash.sh`
- Modify: `apps/esp32-h2-firmware/README.md`
- Modify: `docs/menus/control.md`
- Create: `.superpowers/sdd/2026-08-29-schedule-vehicle-event-control/task-15-report.md`

**Interfaces:**
- Consumes: configurable safe GPIO, 3.3V Active High microwave sensor.
- Produces: fixed queue `vehicle_sensor_edge_t { level, monotonic_us }`, boot level event, dropped-edge fault counter.

- [x] **Step 1: native GPIO state-machine 실패 테스트를 작성한다**

```c
assert(vehicle_sensor_process_level(&state, true, 1000, &event));
assert(event.kind == VEHICLE_SENSOR_DETECTED);
assert(!vehicle_sensor_process_level(&state, true, 2000, &event));
assert(vehicle_sensor_process_level(&state, false, 3000, &event));
assert(event.kind == VEHICLE_SENSOR_CLEARED);
```

- [x] **Step 2: native test 실패를 확인한다**

Run: `cc -std=c11 -Wall -Wextra -Werror -I apps/esp32-h2-firmware/main apps/esp32-h2-firmware/test/native/test_vehicle_sensor_driver.c apps/esp32-h2-firmware/main/vehicle_sensor_driver.c -o /tmp/test_vehicle_sensor_driver && /tmp/test_vehicle_sensor_driver`

Expected: driver 파일/함수가 없어 FAIL한다.

- [x] **Step 3: ISR-safe driver와 pin validation을 구현한다**

ISR은 `gpio_get_level`, `esp_timer_get_time`, `xQueueSendFromISR`만 수행한다. task가 중복 level을 제거한다. Kconfig pin validation은 ESP32-H2 strapping, flash, USB-Serial-JTAG 사용 pin을 build/config 단계에서 거부하고 pull-down과 hardware hysteresis를 설정한다.

- [x] **Step 4: boot High와 queue full fault를 검증한다**

boot 직후 pin을 읽어 High면 detected를 queue에 한 번 넣는다. queue full이면 dropped counter만 증가시키고 ISR에서 block/log/BLE 호출을 하지 않는다.

- [x] **Step 5: native와 ESP-IDF build 후 커밋한다**

Run: `cc -std=c11 -Wall -Wextra -Werror -I apps/esp32-h2-firmware/main apps/esp32-h2-firmware/test/native/test_vehicle_sensor_driver.c apps/esp32-h2-firmware/main/vehicle_sensor_driver.c -o /tmp/test_vehicle_sensor_driver && /tmp/test_vehicle_sensor_driver`

Run: `scripts/esp32-h2-build.sh --test-build` (실제 자사 Company ID가 없는 자동 compile 전용이며 flash 금지)

```bash
git add apps/esp32-h2-firmware/main apps/esp32-h2-firmware/test/native/test_vehicle_sensor_driver.c
git commit -m "feat(firmware): add microwave sensor GPIO driver"
```

검증: native driver state/pin/counter test와 production/test build-gate test를 통과했다. 최초 ESP-IDF v5.5.1 `esp32h2` test-build binary는 `0xe6370` 바이트이고 1 MiB app partition `0x19c90` 바이트가 남았다. Review에서 IRAM, boot ordering, overflow resync, Company ID trust, UART0 pin, lifecycle, 실제 driver test와 OTA margin P1 4/P2 4가 발견되어 아래 Fix Round 1을 수행했다.

#### Task 15 Fix Round 1

- [x] `CONFIG_GPIO_CTRL_FUNC_IN_IRAM=y`와 build linker-map audit로 ISR, GPIO level, timer, queue-send symbol이 IRAM/ROM이 아니면 실패한다.
- [x] interrupt-disabled boot enqueue 뒤 critical enable/reconcile로 producer 순서를 고정하고 start current를 초기화한다. Start 이전에 끝난 짧은 pulse는 범위 밖이다.
- [x] queue full ISR은 dropped counter와 atomic resync-needed만 세우고 task가 drain 뒤 authoritative GPIO를 읽으며 경합한 최신 queue edge까지 반복 처리한다.
- [x] signed manufacturing approval exact CID와 trusted key fingerprint 없이는 production build를 거부하고 artifact hash manifest를 build/flash에 연결한다. Test image는 side-effect 전 runtime fail-stop한다.
- [x] 기본 UART0 console의 GPIO23/24와 custom UART console의 configured TX/RX GPIO를 compile/runtime에서 거부하고 기존 PWM/reset/strapping/flash/package/USB guard를 유지한다.
- [x] callback self-stop을 `ESP_ERR_INVALID_STATE`로 거부하고 외부 stop의 완전 cleanup, failure cleanup과 반복 start/stop을 검증한다.
- [x] 실제 production driver를 `ESP_PLATFORM`으로 컴파일한 host fake에서 boot/ISR/queue overflow/resync/lifecycle을 실행하고 map section audit를 자동화한다.
- [x] 4 MiB flash를 custom `0x1f0000` two-OTA slot으로 바꾸고 production free margin을 `max(slot * 20%, 256 KiB)`로 강제한다.

Fix Round 1 clean test-build는 binary `0xe64f0`(`943,344`) 바이트, app slot `0x1f0000`(`2,031,616`) 바이트, free `0x109b10`(`1,088,272`, 약 54%)이며 현재 production 최소 free gate는 `406,324` 바이트다. Software debounce/timing filter는 추가하지 않았다. 실제 센서 전압/noise/ESD, cache-disabled edge, raw flash 동작, Raspberry Pi RF와 HIL은 미실행이다.

### Task 16: ESP32-H2 Sensor Server와 reliable vendor event

**Files:**
- Create: `apps/esp32-h2-firmware/main/vehicle_sensor_model.h`
- Create: `apps/esp32-h2-firmware/main/vehicle_sensor_model.c`
- Create: `apps/esp32-h2-firmware/test/native/test_vehicle_sensor_model.c`
- Modify: `apps/esp32-h2-firmware/main/ble_mesh_node.c`
- Modify: `apps/esp32-h2-firmware/main/ble_mesh_node.h`
- Modify: `apps/esp32-h2-firmware/main/CMakeLists.txt`

**Interfaces:**
- Consumes: driver edge/current level, provisioned node unicast, ESP-IDF Sensor Server/vendor model API.
- Produces: Sensor Status 60초 deterministic jitter publication, vendor event retry/ACK, 부팅 session별 bootId와 증가 sequence.

- [ ] **Step 1: encode/decode·ACK retry 실패 테스트를 작성한다**

```c
vehicle_sensor_packet_t packet = vehicle_sensor_packet_make(boot_id, 41, VEHICLE_SENSOR_DETECTED, true);
assert(vehicle_sensor_packet_encode(&packet, bytes, sizeof(bytes)) == VEHICLE_SENSOR_PACKET_SIZE);
vehicle_sensor_on_retry_timeout(&model, now_ms);
assert(fake_transport_send_count == 2);
vehicle_sensor_on_ack(&model, boot_id, 41);
assert(!vehicle_sensor_has_pending(&model));
```

- [ ] **Step 2: Sensor Server 현재 상태와 publication을 구현한다**

Sensor Get은 현재 GPIO level을 즉시 Status로 응답한다. publication 주기는 `60s + hash(unicast) % 5000ms`로 node별 deterministic jitter를 적용한다.

- [ ] **Step 3: vendor event ACK/retry를 구현한다**

payload는 protocol version, bootId, uint32 sequence, detected/cleared, level을 포함한다. `bootId`는 매 부팅마다 `esp_random()`으로 새로 만들고 sequence는 1부터 증가시킨다. pending event는 16개 고정 크기 queue에 저장하고 최초 전송 뒤 250ms, 500ms, 1s, 2s, 4s, 8s 간격으로 최대 6회 재전송한다. 마지막 retry 후에도 ACK가 없으면 fault counter를 증가시키고 해당 pending slot을 해제하되 다음 event를 막지 않는다.

- [ ] **Step 4: 모델 composition과 provisioning lifecycle에 연결한다**

Sensor Server와 vendor server model을 기존 node composition에 추가하고 provisioning 완료 뒤 publication address/app key binding 상태를 확인한다. ACK opcode는 수신 `(bootId,sequence)`와 일치할 때만 pending을 제거한다.

- [ ] **Step 5: native test와 ESP-IDF build 후 커밋한다**

Run: `cc -std=c11 -Wall -Wextra -Werror -I apps/esp32-h2-firmware/main apps/esp32-h2-firmware/test/native/test_vehicle_sensor_model.c apps/esp32-h2-firmware/main/vehicle_sensor_model.c -o /tmp/test_vehicle_sensor_model && /tmp/test_vehicle_sensor_model`

Run: `scripts/esp32-h2-build.sh`

```bash
git add apps/esp32-h2-firmware/main apps/esp32-h2-firmware/test/native/test_vehicle_sensor_model.c
git commit -m "feat(firmware): publish reliable vehicle sensor events"
```

### Task 17: Web 제어 탭과 스케줄 CRUD UI

**Files:**
- Modify: `apps/web/src/features/control/ControlView.tsx`
- Create: `apps/web/src/features/control/automation/ControlModeTabs.tsx`
- Create: `apps/web/src/features/control/automation/ScheduleControlPanel.tsx`
- Create: `apps/web/src/features/control/automation/ScheduleDialog.tsx`
- Create: `apps/web/src/features/control/automation/schedule-form.ts`
- Create: `apps/web/src/api/automation.ts`
- Test: `apps/web/src/features/control/automation/ScheduleControlPanel.test.tsx`
- Modify: `apps/web/src/styles.css`

**Interfaces:**
- Consumes: schedule API, existing `ControlTargetPicker`, React Query and common Button/Dialog/Input components.
- Produces: 수동/스케줄/이벤트 탭, schedule list/create/edit/delete/enable, sync status.

- [ ] **Step 1: admin CRUD와 viewer read-only 실패 테스트를 작성한다**

```tsx
render(<ScheduleControlPanel siteId="site-1" role="viewer" />);
expect(screen.queryByRole("button", { name: "스케줄 추가" })).not.toBeInTheDocument();
expect(screen.getByText("Gateway 동기화 중")).toBeInTheDocument();
```

- [ ] **Step 2: 탭과 API query/mutation을 구현한다**

탭은 `수동 제어`, `스케줄 제어`, `이벤트 제어`를 사용하고 URL query `mode=manual|schedule|event`로 새로고침 뒤 선택을 유지한다. mutation 성공 시 schedule list와 control dashboard query를 invalidate한다.

- [ ] **Step 3: schedule form validation을 구현한다**

기간, 한 시간 구간, 반복별 필수값, 밝기 0~100, target 1개 이상을 client에서 검증한다. 월 29~31일과 2월 29일은 허용하고 건너뛰기 의미를 짧은 보조 문구로 표시한다. 서버 `schedule_overlap`은 대상/시간 충돌 메시지로 표시한다.

- [ ] **Step 4: 목록과 동기화 상태를 구현한다**

이름, enabled, 다음 실행, 반복·시간, 밝기, 대상 수, `동기화 중|적용됨|적용 실패`, 최근 결과를 table로 표시한다. viewer에게 edit/delete/toggle command를 렌더링하지 않는다.

- [ ] **Step 5: Web 검증 후 커밋한다**

Run: `pnpm --filter @led-control/web typecheck && pnpm --filter @led-control/web test -- ScheduleControlPanel.test.tsx && pnpm --filter @led-control/web build`

```bash
git add apps/web/src/features/control apps/web/src/api/automation.ts apps/web/src/styles.css
git commit -m "feat(web): add schedule control interface"
```

### Task 18: Web 이벤트 CRUD와 수동 override UI

**Files:**
- Create: `apps/web/src/features/control/automation/VehicleEventControlPanel.tsx`
- Create: `apps/web/src/features/control/automation/VehicleEventDialog.tsx`
- Create: `apps/web/src/features/control/automation/vehicle-event-form.ts`
- Modify: `apps/web/src/features/control/ControlTargetPicker.tsx`
- Modify: `apps/web/src/features/control/ControlView.tsx`
- Test: `apps/web/src/features/control/automation/VehicleEventControlPanel.test.tsx`
- Test: `apps/web/src/features/control/ControlView.test.tsx`

**Interfaces:**
- Consumes: event rule API, source fixture list, schedule UI convention, command `overrideUntil`.
- Produces: source→target→action/hold dialog, event list CRUD, manual override 종료 시각 입력.

- [ ] **Step 1: source/target/hold와 override 실패 테스트를 작성한다**

```tsx
await user.click(screen.getByRole("button", { name: "이벤트 추가" }));
await user.click(screen.getByRole("button", { name: "저장" }));
expect(screen.getByText("감지 센서를 한 개 이상 선택하세요.")).toBeInTheDocument();
expect(screen.getByText("제어 조명을 한 개 이상 선택하세요.")).toBeInTheDocument();
```

- [ ] **Step 2: event dialog와 목록을 구현한다**

dialog 순서는 감지 센서, 제어 조명, 행동·유지시간이다. 목록에는 enabled, source 수, target 수, 밝기, hold, sync 상태, 최근 감지를 표시한다. source picker는 현재 Gateway와 등록된 Fixture만 제공한다.

- [ ] **Step 3: 수동 override 종료 입력을 구현한다**

기본 UI 값은 현재부터 1시간이며 local datetime을 ISO instant로 변환한다. 비워 전송하면 서버 기본값을 사용한다. 과거 시각과 30일 초과를 client에서도 거부한다.

- [ ] **Step 4: 접근성과 회귀 검증 후 커밋한다**

Run: `pnpm --filter @led-control/web typecheck && pnpm --filter @led-control/web test -- VehicleEventControlPanel.test.tsx ControlView.test.tsx && pnpm --filter @led-control/web build`

```bash
git add apps/web/src/features/control
git commit -m "feat(web): add vehicle event control interface"
```

### Task 19: software integration과 Chromium E2E

**Files:**
- Create: `apps/gateway/src/automation/software-automation-simulator.ts`
- Create: `apps/gateway/src/automation/software-automation-simulator.test.ts`
- Create: `apps/web/e2e/automation-control-flow.spec.ts`
- Modify: `apps/web/playwright.config.ts`
- Modify: `scripts/dev.mjs`

**Interfaces:**
- Consumes: production API/Gateway runtime, PostgreSQL, Redis, mTLS MQTT, simulated BLE adapter/sensor input.
- Produces: 실제 DB/MQTT 경로를 통과하는 CRUD→snapshot applied→schedule/event/manual priority E2E 증거.

- [ ] **Step 1: simulator가 production 기본 경로에서 비활성인지 테스트한다**

```ts
expect(() => createSoftwareAutomationSimulator({ nodeEnv: "production", enabled: true })).toThrow(
  "software automation simulator is forbidden in production",
);
```

- [ ] **Step 2: 명시적 E2E 환경에서만 sensor edge를 주입하는 adapter를 구현한다**

환경 변수 `AUTOMATION_E2E_SIMULATOR=1`과 `NODE_ENV=test`가 모두 있어야 활성화한다. UI/API에는 simulator endpoint를 노출하지 않고 test process 내부 handle로만 `detected/cleared`를 주입한다.

- [ ] **Step 3: Chromium 사용자 흐름을 작성한다**

```ts
test("admin creates and executes schedule and vehicle event rules", async ({ page }) => {
  await loginAsAssignedAdmin(page);
  await createSchedule(page, { brightness: 40, target: "B2-001" });
  await expect(page.getByText("적용됨")).toBeVisible();
  await createVehicleEvent(page, { brightness: 80, source: "B2-SENSOR-001", target: "B2-001" });
  await injectSensorEdge("B2-SENSOR-001", "detected");
  await expectFixtureBrightness(page, "B2-001", "80%");
});
```

같은 spec에서 manual override 60%가 event 80%를 가리고, override 만료 뒤 event 80%, clear+hold 뒤 schedule 40%로 복귀하는지 검증한다.

- [ ] **Step 4: 전체 software 검증을 실행한다**

Run: `pnpm typecheck && pnpm test && pnpm --filter @led-control/web exec playwright test e2e/automation-control-flow.spec.ts --project=chromium`

Expected: shared/API/Gateway/Web/Firmware native 계약과 Chromium E2E가 모두 PASS한다. Docker/mTLS dependency가 시작되지 않으면 테스트를 skip하지 않고 setup failure로 종료한다.

- [ ] **Step 5: 통합 변경을 커밋한다**

```bash
git add apps/gateway/src/automation apps/web/e2e apps/web/playwright.config.ts scripts/dev.mjs
git commit -m "test: verify lighting automation end to end"
```

### Task 20: 문서 현황과 HIL 수동 절차 갱신

**Files:**
- Modify: `docs/menus/control.md`
- Modify: `docs/project-status.md`
- Modify: `apps/gateway/README.md`
- Modify: `apps/esp32-h2-firmware/README.md`
- Modify: `docs/superpowers/plans/2026-08-29-schedule-vehicle-event-control.md`

**Interfaces:**
- Consumes: Tasks 1~19의 실제 test 결과와 남은 HIL 경계.
- Produces: 구현 완료/미구현/개선 필요 현황, Raspberry Pi+ESP32-H2 HIL runbook, 체크된 실행 계획.

- [ ] **Step 1: 메뉴 문서를 실제 기능과 일치시킨다**

`docs/menus/control.md`의 `구현 완료`, `미구현`, `부족하거나 개선이 필요한 기능`, `관련 파일`, `갱신 규칙` 구조를 유지한다. software E2E 완료와 HIL 미실행을 별도 항목으로 표시한다.

- [ ] **Step 2: HIL 절차를 재현 가능한 순서로 기록한다**

순서는 센서 3.3V/Active High/GND 및 safe GPIO 실측 → Gateway/ESP flash/deploy → provisioning/app key/model binding → 규칙 적용 확인 → High/Low/hold/retrigger → cloud 단절 → Gateway/ESP restart → telemetry 재전달이다. LED converter DIM interface를 GPIO에 직접 연결하지 않는 경고를 포함한다.

- [ ] **Step 3: 최종 검증 결과를 기록하고 plan checkbox를 갱신한다**

Run: `git status --short && pnpm typecheck && pnpm test && scripts/esp32-h2-build.sh`

HIL은 실제 장비에서 수행하지 않았으면 `미실행`으로 남기고 software 결과로 대체하지 않는다.

- [ ] **Step 4: 문서를 커밋한다**

```bash
git add docs/menus/control.md docs/project-status.md apps/gateway/README.md apps/esp32-h2-firmware/README.md docs/superpowers/plans/2026-08-29-schedule-vehicle-event-control.md
git commit -m "docs: finalize lighting automation verification"
```

## 완료 판정

- API CRUD 저장과 Gateway 적용 ACK가 UI에서 서로 다른 상태로 표시된다.
- Gateway 재시작·Cloud 단절 중에도 마지막 applied snapshot으로 schedule/event가 실행된다.
- 수동 override, 겹치는 차량 event, schedule의 밝기와 복귀 순서가 확정 우선순위와 일치한다.
- schedule overlap, tenant, viewer 권한, target single-Gateway 제약을 DB/API test가 보장한다.
- GPIO edge/current state, vendor ACK/retry/dedupe, Sensor Get/Status를 native/ESP-IDF build가 검증한다.
- production runtime에서 simulator와 mock 장비가 자동 활성화되지 않는다.
- software E2E와 HIL 상태를 문서에서 구분한다.
