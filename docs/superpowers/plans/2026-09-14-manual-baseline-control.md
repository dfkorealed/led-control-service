# 수동 기본 밝기 제어 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 수동 override 종료 시각을 제거하고, 성공한 수동 밝기를 조명별 영속 기본값으로 저장하며 다음 새 스케줄·이벤트 실행부터 자동 제어를 재개한다.

**Architecture:** Shared/API는 종료 시각 없는 canonical 명령을 만들고 legacy 입력과 저장 outbox만 compatibility boundary에서 정규화한다. Gateway V6 state는 RF 전 pending 수동 명령, 성공한 기본 밝기와 당시 활성 자동 source identity suppression을 원자 저장하고 새 source identity만 다시 자동 후보로 허용한다. Web은 종료 시각 입력을 제거하고 기존 명령 복구·반응형 레이아웃을 유지한다.

**Tech Stack:** TypeScript, React 18, TanStack Query, Zod, NestJS, Prisma/PostgreSQL, MQTT.js, Node.js, Vitest, Jest, Playwright

**Spec:** `docs/superpowers/specs/2026-09-14-manual-baseline-control-design.md`

## Global Constraints

- 새 수동 요청·canonical MQTT payload·Web 상태에는 `overrideUntil`과 `overrideRemainingMs`가 없어야 한다.
- legacy 요청/outbox/journal의 유효한 종료 시각은 compatibility parser에서만 허용하고 새 동작에서는 무시한다.
- 성공한 fixture만 `baseBrightnessByFixture`와 suppression을 갱신하며 실패·시간 초과 fixture는 기존 값을 유지한다.
- 명령 성공 시점에 활성인 exact schedule `(scheduleId, occurrenceKey)`와 vehicle `(ruleId, startedAt)`만 억제한다.
- 같은 source의 새 occurrence/activation은 억제하지 않고 기존 `vehicle event > schedule` 우선순위를 적용한다.
- MQTT delivery 10초, RF deadline, 불확실 명령 중첩 차단, idempotency, command journal과 telemetry ACK 계약은 유지한다.
- `ManualOverride` DB 이름과 `manual_override` telemetry discriminator는 이력 호환을 위해 유지하되 새 시간 기반 의미로 사용하지 않는다.
- 사용자 DB migration 적용, 운영 배포, 실제 key, Raspberry Pi/BIO/BlueZ/ESP32-H2 HIL은 실행하지 않는다.
- DB 구조 변경과 제어 메뉴 변경은 각각 `docs/database-schema.md`, `docs/menus/control.md`에 같은 작업에서 반영한다.

---

### Task 1: 종료 시각 없는 Shared 명령 계약

**Files:**
- Modify: `packages/shared/src/dimming-command.ts`
- Modify: `packages/shared/src/schemas.test.ts`
- Modify: `packages/shared/src/gateway-contracts.ts`
- Modify: `packages/shared/src/gateway-contracts.test.ts`
- Modify: `packages/shared/src/command-delivery.ts`
- Modify: `packages/shared/src/command-delivery.test.ts`
- Modify: `packages/shared/src/automation-contracts.ts`
- Modify: `packages/shared/src/automation-contracts.test.ts`

**Interfaces:**
- Consumes: 기존 `DimmingTarget`, Gateway command identity/delivery schemas
- Produces: 종료 시각 없는 `CreateDimmingCommandInput`, `GatewayDimmingCommandDraftV2`, `GatewayDimmingCommandPublishedV2`; old timed payload를 허용하는 compatibility schemas; `createGatewayCommandExpiry(publishedAt, deliveryGeneration)`

- [x] **Step 1: canonical 요청과 legacy 정규화 RED 테스트 작성**

```ts
const canonical = { siteId, clientRequestId, target: { type: "fixture", fixtureId }, brightness: 60 };
expect(createDimmingCommandSchema.parse(canonical)).toEqual(canonical);
expect(() => createDimmingCommandSchema.parse({ ...canonical, overrideUntil })).toThrow();
expect(createDimmingCommandRequestSchema.parse({ ...canonical, overrideUntil })).toEqual(canonical);
expect(() => createDimmingCommandRequestSchema.parse({ ...canonical, overrideUntil: "invalid" })).toThrow();
```

- [x] **Step 2: canonical/compatibility Gateway wire와 delivery RED 테스트 작성**

```ts
expect(gatewayDimmingCommandDraftV2Schema.parse(newDraft)).not.toHaveProperty("overrideUntil");
expect(() => gatewayDimmingCommandDraftV2Schema.parse(oldTimedDraft)).toThrow();
expect(gatewayDimmingCommandDraftV2CompatibilitySchema.parse(oldTimedDraft)).toMatchObject(oldTimedDraft);
expect(createGatewayCommandExpiry(generatedAt, generation)).toEqual(expect.objectContaining({
  deliveryWindowMs: 10_000,
  expiresAt: new Date(generatedAt.getTime() + 10_000).toISOString()
}));
```

- [x] **Step 3: focused Shared tests가 새 요구 때문에 실패하는지 확인**

Run:

```bash
pnpm workspace:prepare
pnpm --filter @led-control/shared exec vitest run src/schemas.test.ts src/gateway-contracts.test.ts src/command-delivery.test.ts src/automation-contracts.test.ts
```

Expected: 기존 canonical schema가 `overrideUntil`을 허용하고 delivery helper가 세 번째 인자를 요구하므로 FAIL.

- [x] **Step 4: canonical과 compatibility schema를 분리해 최소 구현**

```ts
const createDimmingCommandFields = {
  siteId: z.string().uuid(),
  clientRequestId: z.string().uuid(),
  brightness: z.number().int().min(0).max(100)
};
export const createDimmingCommandSchema = z.object({
  ...createDimmingCommandFields,
  target: dimmingTargetSchema
}).strict();
const legacyTimedCreateDimmingCommandSchema = z.object({
  ...createDimmingCommandFields,
  target: dimmingTargetSchema,
  overrideUntil: z.string().datetime()
}).strict().transform(({ overrideUntil: _ignored, ...input }) => input);
const legacyTargetCreateDimmingCommandSchema = z.object({
  ...createDimmingCommandFields,
  targetType: z.enum(["fixture", "group"]),
  targetId: z.string().uuid(),
  overrideUntil: z.string().datetime().optional()
}).strict().transform(({ targetType, targetId, overrideUntil: _ignored, ...input }) => ({
  ...input,
  target: targetType === "fixture"
    ? { type: "fixture" as const, fixtureId: targetId }
    : { type: "group" as const, groupId: targetId }
}));
export const createDimmingCommandRequestSchema = z.union([
  createDimmingCommandSchema,
  legacyTimedCreateDimmingCommandSchema,
  legacyTargetCreateDimmingCommandSchema
]);
```

`gatewayDimmingCommandFields`에서도 `overrideUntil`을 제거한다. Canonical draft/published schemas는 core fields만 사용하고 compatibility schemas만 `overrideUntil`/`overrideRemainingMs`가 있는 old variants를 포함한다. 미사용 `ManualOverrideWindow`와 `manualOverrideWindowSchema` export를 제거한다.

- [x] **Step 5: delivery helper를 transport TTL 전용으로 변경**

```ts
export function createGatewayCommandExpiry(publishedAt: Date, deliveryGeneration: string) {
  const generatedAt = publishedAt.getTime();
  const deliveryWindowMs = GATEWAY_COMMAND_ACCEPTANCE_DEADLINE_MS;
  return {
    deliveryGeneration,
    deliveryGeneratedAt: publishedAt.toISOString(),
    deliveryWindowMs,
    expiresAt: new Date(generatedAt + deliveryWindowMs).toISOString(),
    messageExpiryInterval: deliveryWindowMs / 1_000
  };
}
```

- [x] **Step 6: Shared focused와 전체 테스트·typecheck 확인**

Run:

```bash
pnpm --filter @led-control/shared exec vitest run src/schemas.test.ts src/gateway-contracts.test.ts src/command-delivery.test.ts src/automation-contracts.test.ts
pnpm --filter @led-control/shared test
pnpm --filter @led-control/shared typecheck
```

Expected: 새 focused tests와 전체 Shared가 모두 PASS.

- [x] **Step 7: Shared 계약 커밋**

```bash
git add packages/shared/src
git commit -m "refactor(control): remove manual expiry from command contract"
```

---

### Task 2: nullable 수동 이력과 API 발행

**Files:**
- Create: `apps/api/prisma/migrations/20260914090000_manual_control_baseline/migration.sql`
- Modify: `apps/api/prisma/schema.prisma`
- Modify: `apps/api/src/automation/automation-schema.spec.ts`
- Modify: `apps/api/src/commands/commands.service.ts`
- Modify: `apps/api/src/commands/commands.service.spec.ts`
- Modify: `apps/api/src/commands/command-delivery-reliability.spec.ts`
- Modify: `apps/api/src/mqtt/outbox-publisher.service.ts`
- Modify: `apps/api/src/mqtt/outbox-publisher.service.spec.ts`
- Modify: `docs/database-schema.md`

**Interfaces:**
- Consumes: Task 1 canonical/compatibility request and Gateway schemas
- Produces: `ManualOverride.overrideUntil: Date | null`, target+brightness idempotency fingerprint, expiry 없는 MQTT draft/published command

- [ ] **Step 1: Prisma schema/migration RED 계약 작성**

```ts
expect(modelFields.ManualOverride).toContain("overrideUntil DateTime?");
expect(migration).toContain('ALTER COLUMN "overrideUntil" DROP NOT NULL');
expect(migration).toContain('"overrideUntil" IS NULL');
```

기존 non-null legacy 행을 넣은 뒤 migration 후 값이 유지되고, null expiry 신규 행과 target cardinality가 허용되는 PostgreSQL integration case도 추가한다.

- [ ] **Step 2: API 명령·publisher RED 테스트 작성**

```ts
await service.createDimmingCommand(operator, canonicalInput);
expect(transaction.manualOverride.create).toHaveBeenCalledWith(expect.objectContaining({
  data: expect.objectContaining({ overrideUntil: null })
}));
expect(transaction.mqttOutbox.create).toHaveBeenCalledWith(expect.objectContaining({
  data: expect.objectContaining({ payload: expect.not.objectContaining({ overrideUntil: expect.anything() }) })
}));
```

같은 target/brightness/clientRequestId에 legacy `overrideUntil`만 다른 요청은 같은 canonical command로 복구되고, publisher 결과에 `overrideRemainingMs`가 없다는 case를 함께 추가한다.

- [ ] **Step 3: API focused tests의 예상 실패 확인**

Run:

```bash
pnpm --filter @led-control/api prisma:generate
pnpm --filter @led-control/api exec jest src/commands/commands.service.spec.ts src/commands/command-delivery-reliability.spec.ts src/mqtt/outbox-publisher.service.spec.ts src/automation/automation-schema.spec.ts --runInBand
```

Expected: 기본 1시간 계산, non-null schema와 timed outbox assertion 때문에 FAIL.

- [ ] **Step 4: 순방향 migration과 Prisma schema 구현**

```sql
ALTER TABLE "ManualOverride"
  ALTER COLUMN "overrideUntil" DROP NOT NULL;

ALTER TABLE "ManualOverride" DROP CONSTRAINT "ManualOverride_time_range_check";
ALTER TABLE "ManualOverride" ADD CONSTRAINT "ManualOverride_time_range_check" CHECK (
  ("overrideUntil" IS NULL AND "endedAt" IS NULL)
  OR (
    "overrideUntil" > "startedAt"
    AND ("endedAt" IS NULL OR ("endedAt" >= "startedAt" AND "endedAt" <= "overrideUntil"))
  )
);
```

Prisma field는 `overrideUntil DateTime?`로 변경하고 기존 migration은 수정하지 않는다.

- [ ] **Step 5: CommandsService와 publisher 최소 구현**

`DEFAULT_OVERRIDE_DURATION_MS`, `MAX_OVERRIDE_DURATION_MS`, `resolveOverrideUntil()`을 제거한다. 새 row는 `overrideUntil: null`, 새 outbox payload는 Task 1 canonical draft를 사용한다. `createRequestFingerprint(target, brightness)`는 종료 시각을 받지 않으며 `toCreateResponse()`는 expiry를 반환하지 않는다. Publisher는 `assertManualOverridePublishable()`과 `ManualOverrideExpiredError`를 제거하고 다음 호출을 사용한다.

```ts
const { messageExpiryInterval: _messageExpiryInterval, ...delivery } =
  createGatewayCommandExpiry(generatedAt, deliveryGeneration);
return gatewayDimmingCommandPublishedV2Schema.parse({ ...draft, ...delivery });
```

- [ ] **Step 6: DB 문서 갱신**

`docs/database-schema.md`의 `ManualOverride.overrideUntil`을 nullable legacy compatibility field로 바꾸고, null인 새 row는 수동 기본 밝기 명령 감사용이며 Gateway가 만료 판단에 사용하지 않는다고 기록한다. migration 이름과 변경된 CHECK를 명시한다.

- [ ] **Step 7: API focused, Prisma validate와 typecheck 확인**

Run:

```bash
pnpm --filter @led-control/api prisma:generate
pnpm --filter @led-control/api prisma:validate
pnpm --filter @led-control/api exec jest src/commands/commands.service.spec.ts src/commands/command-delivery-reliability.spec.ts src/mqtt/outbox-publisher.service.spec.ts src/automation/automation-schema.spec.ts --runInBand
pnpm --filter @led-control/api typecheck
```

Expected: 모두 PASS. PostgreSQL URL이 필요한 migration case는 disposable DB에서 별도 실행하고 환경 부재를 성공으로 기록하지 않는다.

- [ ] **Step 8: API·DB 커밋**

```bash
git add apps/api/prisma apps/api/src/automation/automation-schema.spec.ts apps/api/src/commands apps/api/src/mqtt/outbox-publisher.service.ts apps/api/src/mqtt/outbox-publisher.service.spec.ts docs/database-schema.md
git commit -m "feat(api): persist manual controls without expiry"
```

---

### Task 3: Gateway V6 수동 상태와 V5 마이그레이션

**Files:**
- Modify: `apps/gateway/src/automation/automation-state-store.ts`
- Modify: `apps/gateway/src/automation/automation-state-store.test.ts`

**Interfaces:**
- Consumes: V1–V5 persisted automation state
- Produces: `PersistedAutomationStateV6`, `pendingManualControls`, `manualAutomationSuppressions`, V5→V6 migration

- [ ] **Step 1: V6 round-trip과 exact validation RED 테스트 작성**

```ts
const state = emptyAutomationState();
state.pendingManualControls[fixtureId] = {
  sourceId: commandId, brightnessPercent: 60, requestedAt, preBrightness: 30
};
state.manualAutomationSuppressions[fixtureId] = {
  sourceId: commandId,
  appliedAt,
  schedules: [{ scheduleId, occurrenceKey }],
  vehicleEvents: [{ ruleId, startedAt: eventStartedAt }]
};
expect(parseAutomationState(state)).toEqual(state);
expect(() => parseAutomationState({ ...state, extra: true })).toThrow();
```

중복 schedule/event identity, 잘못된 UUID/timestamp/brightness, 10,000 fixture 상한 초과를 fail-closed하는 case를 포함한다.

- [ ] **Step 2: V5 migration RED 테스트 작성**

terminal success, pending, failed/timed_out, transition 없음+관측 일치, transition 없음+관측 불일치 다섯 fixture를 한 V5 state에 넣는다. 기대값은 success/관측 일치만 기본값과 당시 active source suppression으로 승격, pending은 `pendingManualControls`, 나머지는 제거다.

- [ ] **Step 3: state-store focused tests의 예상 실패 확인**

Run:

```bash
pnpm --filter @led-control/gateway exec vitest run src/automation/automation-state-store.test.ts
```

Expected: schemaVersion 6과 신규 map이 없어 FAIL.

- [ ] **Step 4: V6 타입과 parser 구현**

```ts
export interface PersistedAutomationStateV6 {
  schemaVersion: 6;
  activeOccurrences: Record<string, PersistedOccurrenceState>;
  pendingManualControls: Record<string, PersistedManualControlState>;
  manualAutomationSuppressions: Record<string, PersistedManualAutomationSuppressionState>;
  vehicleRules: Record<string, PersistedVehicleRuleState>;
  currentByFixture: Record<string, number>;
  baseBrightnessByFixture: Record<string, number>;
  lastDesiredByFixture: Record<string, number>;
  unverifiedDesiredByFixture: Record<string, number>;
  transitionsByFixture: Record<string, PersistedAutomationTransitionState>;
  telemetryGap: PersistedAutomationTelemetryGap | null;
  pendingTelemetryHandoffs: PersistedAutomationTelemetryHandoff[];
  vehicleSensorInbox: PersistedVehicleSensorInboxSource[];
}
```

`emptyAutomationState()`는 V6 exact keys를 만들고 parser는 sorted unique identity arrays만 허용한다.

- [ ] **Step 5: V5 migration 구현**

`parseAutomationState()`의 V5 branch에서 old fields를 먼저 전부 검증한 뒤 `migrateV5ManualState()`를 호출한다. 성공 판정은 terminal succeeded 또는 `currentByFixture/lastDesiredByFixture === brightnessPercent`일 때만 허용한다. 성공 fixture suppression은 V5 `activeOccurrences[*].preBrightness`와 `vehicleRules[*].targetFixtureIds`에서 exact identity를 만든다. pending transition은 요청값을 기본값으로 승격하지 않는다.

- [ ] **Step 6: state-store focused와 전체 Gateway state tests 확인**

Run:

```bash
pnpm --filter @led-control/gateway exec vitest run src/automation/automation-state-store.test.ts
pnpm --filter @led-control/gateway typecheck
```

Expected: V1–V6 restore/round-trip과 typecheck PASS.

- [ ] **Step 7: Gateway state 커밋**

```bash
git add apps/gateway/src/automation/automation-state-store.ts apps/gateway/src/automation/automation-state-store.test.ts
git commit -m "feat(gateway): migrate manual control state to baselines"
```

---

### Task 4: 수동 적용과 다음 자동 source 재개

**Files:**
- Modify: `apps/gateway/src/automation/schedule-runtime.ts`
- Modify: `apps/gateway/src/automation/schedule-runtime.test.ts`
- Modify: `apps/gateway/src/automation/automation-arbiter.ts`
- Modify: `apps/gateway/src/automation/automation-arbiter.test.ts`
- Modify: `apps/gateway/src/commands/gateway-command-handler.ts`
- Modify: `apps/gateway/src/commands/gateway-command-handler.test.ts`
- Modify: `apps/gateway/src/commands/command-journal.ts`
- Modify: `apps/gateway/src/commands/command-journal.test.ts`
- Modify: `apps/gateway/src/index.ts`
- Modify: `apps/gateway/src/index.test.ts`

**Interfaces:**
- Consumes: Task 1 new/legacy wire, Task 3 V6 state
- Produces: `prepareManualControl(input)`, `handoffManualTerminal(sourceId, results)`, `ManualControlCoordinator`; identity-filtered desired state

- [ ] **Step 1: 수동 성공·부분 실패 RED 테스트 작성**

```ts
const previousFailedBase = store.read().baseBrightnessByFixture[failedId];
await runtime.prepareManualControl({
  sourceId: commandId,
  fixtureIds: [successId, failedId],
  brightnessPercent: 60,
  requestedAt
});
await runtime.handoffManualTerminal(commandId, [
  succeeded(successId, 60),
  failed(failedId)
]);
expect(store.read().baseBrightnessByFixture[successId]).toBe(60);
expect(store.read().baseBrightnessByFixture[failedId]).toBe(previousFailedBase);
```

두 fixture가 schedule/event 활성 중인 fixture도 포함하고 성공 fixture만 현재 source identities를 suppression에 갖는지 확인한다.

- [ ] **Step 2: 다음 occurrence/activation 재개 RED 테스트 작성**

같은 schedule occurrence와 같은 vehicle activation의 recompute는 수동 60%를 유지해야 한다. occurrence key가 바뀐 schedule start 또는 Low→새 High로 `startedAt`이 바뀐 event는 자동 밝기를 적용하고, 종료 뒤 60%로 복귀해야 한다.

```ts
const activeSnapshot = createAutomationSnapshot({
  schedules: [activeSchedule({ fixtureId, brightnessPercent: 40 })]
});
test.execute.mockClear();
await test.runtime.recompute(activeSnapshot);
expect(test.execute).not.toHaveBeenCalled();
test.wall.set("2026-08-31T01:00:00.000Z");
await test.runtime.tick();
expect(test.execute).toHaveBeenLastCalledWith([
  expect.objectContaining({ fixtureId, brightnessPercent: 40, sourceType: "schedule" })
]);
test.wall.set("2026-08-31T02:00:00.000Z");
await test.runtime.tick();
expect(test.execute).toHaveBeenLastCalledWith([
  expect.objectContaining({ fixtureId, brightnessPercent: 60, sourceType: "current" })
]);
```

- [ ] **Step 3: restart·journal·clock-untrusted RED 테스트 작성**

종료 시각 없는 command의 accepted/completed journal handoff가 skip되지 않고 V6 pending을 수렴시키는지, restart 뒤 suppression이 유지되는지, clock trust false에서도 manual prepare가 성공하는지 검증한다. MQTT/RF expiry가 지난 command는 계속 RF 전에 실패해야 한다.

- [ ] **Step 4: focused Gateway tests의 예상 실패 확인**

Run:

```bash
pnpm --filter @led-control/gateway exec vitest run src/automation/schedule-runtime.test.ts src/automation/automation-arbiter.test.ts src/commands/gateway-command-handler.test.ts src/commands/command-journal.test.ts src/index.test.ts
```

Expected: runtime이 `overrideUntil`을 요구하고 old active manual이 자동 후보를 계속 선점하므로 FAIL.

- [ ] **Step 5: prepare/handoff를 시간 독립 수동 제어로 변경**

```ts
export interface ManualControlInput {
  sourceId: string;
  fixtureIds: string[];
  brightnessPercent: number;
  requestedAt: string;
}

prepareManualControl(input: ManualControlInput): Promise<void>;
handoffManualTerminal(sourceId: string, results: AutomationExecutionFixtureResultV1[]): Promise<void>;
```

prepare는 `pendingManualControls`와 pending transition만 저장한다. handoff success는 실제 결과 밝기를 current/lastDesired/base에 쓰고 그 시점의 active schedule/event identities를 suppression으로 snapshot한 뒤 pending을 제거한다. 실패는 pending만 제거한다.

- [ ] **Step 6: suppression-aware arbitration과 cleanup 구현**

```ts
const events = activeEvents.filter(({ sourceId, startedAt }) =>
  !suppression?.vehicleEvents.some((item) => item.ruleId === sourceId && item.startedAt === startedAt)
);
const schedule = activeSchedules.find(({ sourceId, occurrenceKey }) =>
  !suppression?.schedules.some((item) => item.scheduleId === sourceId && item.occurrenceKey === occurrenceKey)
) ?? null;
```

`baseBrightnessByFixture`는 자동 source가 사라져도 삭제하지 않는다. 종료·설정 변경 lifecycle에서 더 이상 active하지 않은 suppression identity만 제거하고, 두 배열이 모두 비면 fixture record를 제거한다.

- [ ] **Step 7: coordinator와 journal recovery 구현**

`createManualOverrideCoordinator`를 `createManualControlCoordinator`로 바꾸되 old/new compatible wire 모두 `requestedAt`, target, brightness만 runtime에 전달한다. `recoverPendingManualAutomationHandoffs()`의 `if (!command.overrideUntil) continue`를 제거해 새 command도 복구한다. Broker remaining TTL은 command 실행 deadline에만 사용하고 manual state 입력에는 전달하지 않는다.

- [ ] **Step 8: Gateway focused·전체 테스트와 typecheck 확인**

Run:

```bash
pnpm --filter @led-control/gateway exec vitest run src/automation/automation-state-store.test.ts src/automation/schedule-runtime.test.ts src/automation/automation-arbiter.test.ts src/commands/gateway-command-handler.test.ts src/commands/command-journal.test.ts src/index.test.ts
pnpm --filter @led-control/gateway test
pnpm --filter @led-control/gateway typecheck
```

Expected: focused와 전체 Gateway 모두 PASS, timed expiry 기대는 새 source identity 기대값으로 교체됨.

- [ ] **Step 9: Gateway 동작 커밋**

```bash
git add apps/gateway/src
git commit -m "feat(gateway): resume automation after persistent manual baseline"
```

---

### Task 5: Web 종료 시각 UI 제거

**Files:**
- Modify: `apps/web/src/features/control/ControlView.tsx`
- Modify: `apps/web/src/features/control/ControlView.test.tsx`
- Modify: `apps/web/src/features/control/active-command-store.test.ts`
- Modify: `apps/web/src/api/commands.ts`
- Modify: `apps/web/e2e/calm-operations-manual-control.spec.ts`

**Interfaces:**
- Consumes: Task 1 `CreateDimmingCommandInput`, Task 2 expiry 없는 response
- Produces: 종료 시각 입력이 없는 수동 제어 UI와 target+brightness 복구 request

- [ ] **Step 1: UI·payload RED 테스트 작성**

```ts
expect(screen.queryByLabelText("수동 override 종료 시각")).not.toBeInTheDocument();
await user.click(screen.getByRole("button", { name: "밝기 적용" }));
expect(mocks.apiPost).toHaveBeenCalledWith("/commands/dimming", expect.not.objectContaining({
  overrideUntil: expect.anything()
}), expect.anything());
```

active-command-store는 target+brightness request가 round-trip되고 legacy localStorage의 `overrideUntil`은 canonical 복구에서 제거되는 case를 추가한다.

- [ ] **Step 2: Chromium route RED 기대값 작성**

`calm-operations-manual-control.spec.ts`에서 datetime fill/disabled assertion을 제거하고 captured request에 `overrideUntil`이 없음을 확인한다. 1440×900, 1366×768, 390×844, 320×740에서 document-level overflow와 44×44px 유효 target 계약은 유지한다.

- [ ] **Step 3: focused Web tests의 예상 실패 확인**

Run:

```bash
pnpm --filter @led-control/web exec vitest run src/features/control/ControlView.test.tsx src/features/control/active-command-store.test.ts
```

Expected: 기존 datetime 입력과 payload가 남아 있어 FAIL.

- [ ] **Step 4: ControlView와 API type 최소 구현**

`overrideUntilLocal`, `defaultOverrideUntilLocal`, `overrideUntilFromLocal`, `validateOverrideUntil`과 form field를 제거한다. submit payload는 다음 exact shape만 만든다.

```ts
const request = canonicalizeDimmingCommandInput({
  siteId: data.site.id,
  clientRequestId: crypto.randomUUID(),
  target,
  brightness
});
```

`CreateDimmingCommandResponse.overrideUntil`도 제거한다. 성공 표시가 생성되는 기존 분기에서만 “조명 적용 완료 · 기본 밝기로 저장됨”을 사용한다.

- [ ] **Step 5: Web focused·전체·Chromium·typecheck/build 확인**

Run:

```bash
pnpm --filter @led-control/web exec vitest run src/features/control/ControlView.test.tsx src/features/control/active-command-store.test.ts
pnpm --filter @led-control/web test
pnpm --filter @led-control/web exec playwright test e2e/calm-operations-manual-control.spec.ts --workers=1
pnpm --filter @led-control/web typecheck
pnpm --filter @led-control/web build
```

Expected: unit, 네 viewport Chromium, typecheck와 production build PASS.

- [ ] **Step 6: Web 커밋**

```bash
git add apps/web
git commit -m "feat(web): remove manual control end time"
```

---

### Task 6: 실제 software 자동화 흐름과 운영 문서

**Files:**
- Modify: `apps/web/e2e/automation-control-flow.spec.ts`
- Modify: `apps/gateway/README.md`
- Modify: `docs/runbooks/raspberry-pi-gateway-appliance.md`
- Modify: `docs/menus/control.md`
- Modify: `docs/project-status.md`
- Modify: `docs/superpowers/plans/2026-09-14-manual-baseline-control.md`

**Interfaces:**
- Consumes: Task 1–5 전체 Web/API/Gateway flow
- Produces: 실제 PostgreSQL·Redis·mTLS Mosquitto software E2E와 일치하는 메뉴/배포 문서

- [ ] **Step 1: RealBackendLab RED 시나리오 변경**

기존 `manual-before-expiry`/`manual-after-expiry` clock advance를 제거하고 다음 exact phase를 기록한다.

```ts
await admin.goto(`/control?siteId=${created.siteId}&mode=manual`);
await admin.getByRole("checkbox", { name: `${targetName} 선택` }).check();
await admin.getByRole("slider", { name: "밝기" }).fill("60");
await admin.getByRole("button", { name: "밝기 적용" }).click();
await lab.waitForFixtureBrightness(targetName, 60);
await lab.assertAutomationBrightnessPhase({
  phase: "manual-suppresses-current-event",
  cause: "manual_baseline_applied",
  fixtureName: targetName,
  brightness: 60
});
await lab.injectSensorEdge(sensorName, "cleared");
await lab.waitForAutomationExecutionKind("event_extended");
await lab.advanceAutomationClockTo((await lab.latestVehicleHoldUntil()) + 1);
await lab.waitForFixtureBrightness(targetName, 60);
await lab.injectSensorEdge(sensorName, "detected");
await lab.waitForFixtureBrightness(targetName, 80);
await lab.assertAutomationBrightnessPhase({
  phase: "next-event-resumes",
  cause: "new_vehicle_activation",
  fixtureName: targetName,
  brightness: 80
});
await lab.injectSensorEdge(sensorName, "cleared");
await lab.waitForAutomationExecutionKind("event_extended");
await lab.advanceAutomationClockTo((await lab.latestVehicleHoldUntil()) + 1);
await lab.waitForFixtureBrightness(targetName, 60);
```

`createSchedule()` 호출자가 생성 기준 시각을 전달하게 한다. 이 테스트의 현장 시간대는 `Asia/Seoul`이고 DST가 없으므로 기존 `now-1h`/`now+1h` 창의 다음 occurrence는 아래처럼 고정 계산한다.

```ts
const scheduleReference = new Date();
await createSchedule(admin, { brightness: 40, target: preconnectTargetName, now: scheduleReference });
await lab.advanceAutomationClockTo(scheduleReference.getTime() + 23 * 60 * 60 * 1_000 + 1);
await lab.waitForFixtureBrightness(targetName, 40);
await lab.advanceAutomationClockTo(scheduleReference.getTime() + 25 * 60 * 60 * 1_000 + 1);
await lab.waitForFixtureBrightness(targetName, 60);
```

Helper signature를 `input: { brightness: number; target: string; now: Date }`로 바꾸고 내부 `const now = new Date()` 대신 `const now = input.now`를 사용해 form 입력과 clock advance가 같은 경계를 공유하게 한다.

- [ ] **Step 2: RealBackendLab가 기존 동작 때문에 실패하는지 확인**

Run:

```bash
E2E_REAL_BACKEND_LAB=1 pnpm --filter @led-control/web exec playwright test e2e/automation-control-flow.spec.ts --workers=1
```

Expected: 기존 시간 기반 override 또는 새 source 재개 미구현이면 FAIL. 필수 PostgreSQL/Redis/Mosquitto 환경이 없으면 skip을 성공으로 취급하지 말고 미실행 사유로 기록한다.

- [ ] **Step 3: 통합 fixture와 기대값을 새 계약에 맞춰 최소 수정**

Lab helper가 phase 이름만 기록하도록 유지하고 production API/Gateway 코드를 우회하는 simulator endpoint나 직접 state mutation을 추가하지 않는다. 새 이벤트는 실제 sensor edge, 새 schedule은 private test clock의 실제 occurrence 계산을 사용한다.

- [ ] **Step 4: 제어·Gateway·runbook 문서 갱신**

`docs/menus/control.md`에서 datetime/1시간/30일/timed expiry 설명을 새 기본 밝기·현재 source suppression·다음 source 재개 계약으로 교체한다. `apps/gateway/README.md`와 Raspberry Pi runbook에는 V5 backup → Gateway → DB/API → Web 순서 및 rollback 시 이전 state backup 동반 복원을 기록한다. software E2E와 실제 HIL을 구분한다.

- [ ] **Step 5: 문서/통합 커밋**

```bash
git add apps/web/e2e/automation-control-flow.spec.ts apps/gateway/README.md docs/runbooks/raspberry-pi-gateway-appliance.md docs/menus/control.md docs/project-status.md docs/superpowers/plans/2026-09-14-manual-baseline-control.md
git commit -m "docs(control): record manual baseline automation flow"
```

---

### Task 7: 전체 검증과 최종 상태

**Files:**
- Modify: `docs/project-status.md`
- Modify: `docs/superpowers/plans/2026-09-14-manual-baseline-control.md`

**Interfaces:**
- Consumes: Task 1–6 committed branch
- Produces: 검증 수치, external validation 경계와 clean final branch

- [ ] **Step 1: Prisma와 공유 산출물 준비**

Run:

```bash
pnpm install --frozen-lockfile
pnpm --filter @led-control/api prisma:generate
pnpm --filter @led-control/api prisma:validate
```

Expected: frozen install, generate, validate PASS; tracked lockfile 변경 없음.

- [ ] **Step 2: canonical 정적·단위·빌드 gate 실행**

Run serially:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

Expected: 네 command 모두 exit 0. 기존 environment-gated skip은 정확한 이유와 개수를 기록하고 새 관련 테스트 skip은 허용하지 않는다.

- [ ] **Step 3: 관련 Chromium과 software integration 실행**

Run serially:

```bash
pnpm --filter @led-control/web exec playwright test e2e/calm-operations-manual-control.spec.ts --workers=1
E2E_REAL_BACKEND_LAB=1 pnpm --filter @led-control/web exec playwright test e2e/automation-control-flow.spec.ts --workers=1
```

Expected: mock UI flow와 실제 API/Gateway/MQTT software flow PASS. 실장비 증거로 기록하지 않는다.

- [ ] **Step 4: 전체 production audit 실행**

Run:

```bash
pnpm ci:production-audit
```

Expected: Compose/MQTT/Gateway/Web/dependency policy가 끝까지 exit 0이고 owned container/artifact가 정리됨.

- [ ] **Step 5: independent code review 수행**

Reviewer에게 spec, plan, base SHA와 전체 diff를 제공한다. 요구사항 누락, mixed-version wire, nullable migration, V5→V6 불명확 상태, partial success, source identity cleanup, crash recovery와 문서 증거를 Critical/Important/Minor로 검토받는다. 발견 사항은 별도 TDD fix commit 후 같은 범위 검증을 재실행한다.

- [ ] **Step 6: 상태판과 계획을 실제 증거로 완료 처리**

`docs/project-status.md`의 행을 `완료(소프트웨어)`로 바꾸고 정확한 test/build/E2E/audit 수치와 사용자 DB migration·운영 배포·Pi/BIO/BlueZ/ESP32-H2 HIL 미실행을 기록한다. 이 계획의 완료 step만 `[x]`로 바꾼다.

- [ ] **Step 7: 최종 문서 커밋과 clean 확인**

```bash
git add docs/project-status.md docs/superpowers/plans/2026-09-14-manual-baseline-control.md
git commit -m "docs(control): record manual baseline verification"
git diff --check HEAD^ HEAD
git status --short
git log -8 --oneline
```

Expected: diff check exit 0, status empty, 모든 기능·검증·문서 commit이 현재 branch에 존재한다.
