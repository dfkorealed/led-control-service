# 모니터링·제어 집중 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 10분 주기 모니터링, 자사 조명 일괄 등록, 읽기 전용 에디터 지도, 개별·임의 다중·층·구역 수동 제어와 BLE Mesh Health Current 수집을 양산 코드 경로로 완성한다.

**Architecture:** 기존 React Query, NestJS, PostgreSQL outbox, MQTT v2, BlueZ D-Bus, ESP-IDF 구조를 유지한다. 정적 지도와 fixture snapshot을 분리하고, 사용자 관점의 동기 제어는 command 상태가 terminal이 될 때까지 웹 입력을 잠그는 방식으로 구현한다. 개별과 임의 다중 선택은 unicast 계열, 층과 저장 구역은 사전 구성한 Mesh Group Address 단일 전송을 사용한다.

**Tech Stack:** React 18, TypeScript, TanStack Query, Zustand, React Konva, NestJS 10, Prisma 6, PostgreSQL, MQTT 5, Raspberry Pi BlueZ 5.82 D-Bus, ESP-IDF 5.5.1, ESP32-H2

**Spec:** `docs/superpowers/specs/2026-08-19-monitoring-control-focused-completion-design.md`

## Global Constraints

- production 코드에는 mock 조명, mock scan, shell BLE adapter를 추가하지 않는다.
- 실제 하드웨어 검증은 사용자가 수동 수행하며 자동 테스트 성공과 실기 성공을 구분해 기록한다.
- WebSocket/SSE, 통신 품질 고도화, 장애 workflow, 스케줄·이벤트 제어, 설정 신규 기능은 구현하지 않는다.
- 명령 HTTP 요청을 장시간 유지하지 않고 기존 Command/Outbox/MQTT 구조를 유지한다.
- 모든 기능 변경은 테스트를 먼저 실패시킨 뒤 최소 구현으로 통과시킨다.
- DB 변경 Task는 `docs/database-schema.md`, 메뉴 변경 Task는 `docs/menus/*.md`를 같은 커밋에서 갱신한다.
- 각 Task는 검증과 커밋 후 즉시 중단하고 결과를 사용자에게 보고한다. 사용자가 명시적으로 승인하기 전에는 다음 Task를 시작하지 않는다.
- 현재 브랜치 `codex/mvp1-cloud-web`에서 작업한다.

## 파일 구조

- `apps/web/src/api/queries.ts`: 모니터링 metadata, fixture, 지도 query 정책
- `apps/web/src/features/monitoring/MonitoringView.tsx`: 새로고침과 읽기 전용 모니터링 화면
- `apps/web/src/features/floor-map/`: 에디터와 모니터링이 공유하는 Konva scene renderer
- `packages/shared/src/product-identity.ts`: 자사 BLE Mesh device UUID parser와 제품 registry
- `apps/esp32-h2-firmware/main/device_identity.c`: ESP32-H2 device UUID 생성
- `apps/api/src/registration/`: 일괄·개별 등록과 원자 번호·주소 예약
- `apps/api/src/floor-map/`: 읽기 전용 지도 snapshot API
- `apps/api/src/mesh-control-groups/`: floor/zone group address와 subscription 상태
- `apps/gateway/src/mesh/`: product scan filter, Config Model subscription, group Lightness 전송과 status 수집
- `apps/api/src/commands/`: 확장 target 해석과 delivery mode 결정
- `apps/web/src/features/control/`: 다중/층/구역 선택과 사용자 관점 동기 제어

---

### Task 1: 모니터링 10분 갱신과 수동 새로고침

**Files:**
- Modify: `apps/web/src/api/queries.ts`
- Modify: `apps/web/src/api/queries.test.tsx`
- Modify: `apps/web/src/features/monitoring/MonitoringView.tsx`
- Create: `apps/web/src/features/monitoring/MonitoringView.test.tsx`
- Modify: `apps/web/src/styles.css`
- Modify: `docs/menus/monitoring.md`
- Modify: `docs/superpowers/plans/2026-08-19-monitoring-control-focused-completion.md`

**Interfaces:**
- Produces: `MONITORING_REFRESH_INTERVAL_MS = 600_000`
- Produces: `monitoringQueryPolicy`과 `useDashboard`·`useFloorFixtures`의 10분 자동 갱신 정책
- Produces: 현재 dashboard와 fixture query를 함께 갱신하는 `새로고침` UI

- [x] **Step 1: query 정책의 실패 테스트 작성**

```ts
expect(MONITORING_REFRESH_INTERVAL_MS).toBe(600_000);
expect(queryOptions.refetchInterval).toBe(600_000);
expect(queryOptions.staleTime).toBe(600_000);
expect(queryOptions.refetchOnWindowFocus).toBe(false);
```

- [x] **Step 2: 새로고침 UI의 실패 테스트 작성**

```tsx
fireEvent.click(screen.getByRole("button", { name: "새로고침" }));
expect(refetchDashboard).toHaveBeenCalledTimes(1);
expect(refetchFixtures).toHaveBeenCalledTimes(1);
expect(screen.getByText(/마지막 갱신/)).toBeInTheDocument();
```

- [x] **Step 3: RED 확인**

Run: `pnpm --filter @led-control/web exec vitest run src/api/queries.test.tsx src/features/monitoring/MonitoringView.test.tsx`

Expected: 3초 interval 또는 새로고침 버튼 부재로 FAIL

- [x] **Step 4: query와 UI 최소 구현**

```ts
export const MONITORING_REFRESH_INTERVAL_MS = 10 * 60 * 1000;

export const monitoringQueryPolicy = {
  staleTime: MONITORING_REFRESH_INTERVAL_MS,
  refetchInterval: MONITORING_REFRESH_INTERVAL_MS,
  refetchOnWindowFocus: false
} as const;
```

`MonitoringView`는 dashboard `refetch`와 현재 층 fixture `refetch`를 `Promise.allSettled`로 실행하고, 실행 중 버튼을 잠그며 성공한 마지막 완료 시각을 표시한다.

- [x] **Step 5: Task 검증**

Run: `pnpm --filter @led-control/web exec vitest run src/api/queries.test.tsx src/features/monitoring/MonitoringView.test.tsx`

Run: `pnpm --filter @led-control/web typecheck`

Expected: 모든 명령 exit 0

- [x] **Step 6: 문서와 체크리스트 갱신 후 커밋**

```bash
git add apps/web/src/api/queries.ts apps/web/src/api/queries.test.tsx \
  apps/web/src/features/monitoring/MonitoringView.tsx \
  apps/web/src/features/monitoring/MonitoringView.test.tsx apps/web/src/styles.css \
  docs/menus/monitoring.md docs/superpowers/plans/2026-08-19-monitoring-control-focused-completion.md
git commit -m "feat(monitoring): add ten-minute refresh policy"
```

- [x] **사용자 확인 Gate 1:** 구현 결과와 테스트를 보고하고 다음 Task 승인을 기다린다.

---

### Task 2: 읽기 전용 층 지도 snapshot API

**Files:**
- Create: `apps/api/src/floor-map/floor-map.controller.ts`
- Create: `apps/api/src/floor-map/floor-map.service.ts`
- Create: `apps/api/src/floor-map/floor-map.service.spec.ts`
- Create: `apps/api/src/floor-map/floor-map.module.ts`
- Modify: `apps/api/src/app.module.ts`
- Modify: `packages/shared/src/schemas.ts`
- Modify: `packages/shared/src/schemas.test.ts`
- Modify: `packages/shared/src/index.ts`
- Modify: `docs/menus/monitoring.md`

**Interfaces:**
- Produces: `GET /sites/:siteId/floors/:floorId/map-snapshot`
- Produces: `FloorMapSnapshot` with `revision`, `floorPlan`, `objects`
- Security: `SiteAccessService.assert(user, siteId, "read")`, inaccessible floor is opaque 404

- [x] **Step 1: shared schema 실패 테스트 작성**

```ts
expect(floorMapSnapshotSchema.parse({
  floorId,
  revision: 3,
  width: 1200,
  height: 800,
  floorPlan: null,
  objects: []
}).revision).toBe(3);
```

- [x] **Step 2: API tenant와 정렬 실패 테스트 작성**

```ts
await expect(service.getSnapshot(user, siteId, floorId)).resolves.toMatchObject({ revision: 3 });
expect(siteAccess.assert).toHaveBeenCalledWith(user, siteId, "read");
expect(prisma.floor.findFirst).toHaveBeenCalledWith(expect.objectContaining({
  where: { id: floorId, siteId },
  include: expect.objectContaining({ mapObjects: { where: { visible: true }, orderBy: [{ zIndex: "asc" }, { createdAt: "asc" }] } })
}));
```

- [x] **Step 3: RED 확인**

Run: `pnpm --filter @led-control/shared exec vitest run src/schemas.test.ts`

Run: `pnpm --filter @led-control/api exec jest src/floor-map/floor-map.service.spec.ts --runInBand`

Expected: schema와 service 부재로 FAIL

- [x] **Step 4: schema와 API 최소 구현**

```ts
export const floorMapSnapshotSchema = z.object({
  floorId: z.string().uuid(),
  revision: z.number().int().nonnegative(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  floorPlan: floorPlanSnapshotSchema.nullable(),
  objects: z.array(floorMapObjectSchema)
}).strict();
```

서비스는 `Floor.mapRevision`, `FloorPlan`, visible object만 조회하고 fixture는 포함하지 않는다.

- [x] **Step 5: Task 검증**

Run: `pnpm --filter @led-control/shared test && pnpm --filter @led-control/api exec jest src/floor-map/floor-map.service.spec.ts --runInBand && pnpm --filter @led-control/api typecheck`

Expected: exit 0

- [x] **Step 6: 문서 갱신과 커밋**

```bash
git add packages/shared/src apps/api/src/floor-map apps/api/src/app.module.ts docs/menus/monitoring.md docs/superpowers/plans/2026-08-19-monitoring-control-focused-completion.md
git commit -m "feat(api): expose read-only floor map snapshots"
```

- [x] **사용자 확인 Gate 2:** 구현 결과와 테스트를 보고하고 다음 Task 승인을 기다린다.

---

### Task 3: 공유 Konva scene과 모니터링 읽기 전용 지도

**Files:**
- Create: `apps/web/src/features/floor-map/FloorScene.tsx`
- Create: `apps/web/src/features/floor-map/FloorScene.test.tsx`
- Modify: `apps/web/src/features/floor-editor/FloorEditorCanvas.tsx`
- Modify: `apps/web/src/features/monitoring/FloorMap.tsx`
- Modify: `apps/web/src/features/monitoring/FloorMap.test.tsx`
- Modify: `apps/web/src/api/queries.ts`
- Modify: `apps/web/src/features/monitoring/MonitoringView.tsx`
- Modify: `apps/web/src/styles.css`
- Modify: `docs/menus/monitoring.md`

**Interfaces:**
- Consumes: Task 2 `FloorMapSnapshot`
- Produces: `<FloorScene snapshot fixtures interactive />`
- Produces: `useFloorMapSnapshot(siteId, floorId)` with 10분 policy

- [x] **Step 1: 공유 renderer 실패 테스트 작성**

```tsx
render(<FloorScene snapshot={snapshot} fixtures={fixtures} interactive={false} />);
expect(screen.getByTestId("map-object-rectangle-1")).toBeInTheDocument();
expect(screen.queryByTestId("floor-transformer")).not.toBeInTheDocument();
```

- [x] **Step 2: 모니터링 query와 새로고침 실패 테스트 작성**

```ts
expect(apiGet).toHaveBeenCalledWith("/sites/site-1/floors/floor-1/map-snapshot");
expect(refetchMap).toHaveBeenCalledTimes(1);
```

- [x] **Step 3: RED 확인**

Run: `pnpm --filter @led-control/web exec vitest run src/features/floor-map/FloorScene.test.tsx src/features/monitoring/FloorMap.test.tsx src/features/monitoring/MonitoringView.test.tsx`

Expected: 공유 scene과 map query 부재로 FAIL

- [x] **Step 4: renderer 추출과 읽기 전용 합성**

```ts
interface FloorSceneProps {
  snapshot: FloorMapSnapshot;
  fixtures: FixtureSnapshot[];
  interactive: boolean;
  selectedFixtureId?: string | null;
  onSelectFixture?: (fixtureId: string) => void;
}
```

도형 geometry와 z-index 렌더링은 공유하고, `interactive=false`에서는 drag, transform, keyboard handler를 전달하지 않는다. 모니터링 수동 새로고침은 dashboard, fixture, map query를 함께 갱신한다.

- [x] **Step 5: Task 검증**

Run: `pnpm --filter @led-control/web exec vitest run src/features/floor-map/FloorScene.test.tsx src/features/floor-editor/FloorEditorView.test.tsx src/features/monitoring/FloorMap.test.tsx src/features/monitoring/MonitoringView.test.tsx`

Run: `pnpm --filter @led-control/web build`

Expected: exit 0

- [x] **Step 6: 문서 갱신과 커밋**

```bash
git add apps/web/src/features/floor-map apps/web/src/features/floor-editor/FloorEditorCanvas.tsx \
  apps/web/src/features/monitoring apps/web/src/api/queries.ts apps/web/src/styles.css \
  docs/menus/monitoring.md docs/superpowers/plans/2026-08-19-monitoring-control-focused-completion.md
git commit -m "feat(monitoring): render saved floor maps read-only"
```

- [x] **사용자 확인 Gate 3:** 구현 결과와 테스트를 보고하고 다음 Task 승인을 기다린다.

---

### Task 4: 자사 BLE Mesh device UUID 계약과 검색 필터

**Files:**
- Create: `packages/shared/src/product-identity.ts`
- Create: `packages/shared/src/product-identity.test.ts`
- Modify: `packages/shared/src/index.ts`
- Create: `apps/esp32-h2-firmware/main/device_identity.c`
- Create: `apps/esp32-h2-firmware/main/device_identity.h`
- Modify: `apps/esp32-h2-firmware/main/CMakeLists.txt`
- Modify: `apps/esp32-h2-firmware/main/ble_mesh_node.c`
- Modify: `apps/gateway/src/mesh/bluez-provisioner.ts`
- Modify: `apps/gateway/src/mesh/bluez-provisioner.test.ts`
- Modify: `apps/esp32-h2-firmware/README.md`
- Modify: `docs/menus/monitoring.md`

**Interfaces:**
- Produces: `parseDfkDeviceUuid(uuidHex): DfkProductIdentity | null`
- UUID layout: `DFKLED`, format `0x01`, family, model, hardware revision, 6-byte device identity
- Produces: firmware `device_identity_build(uint8_t output[16])`

- [x] **Step 1: shared parser 실패 테스트 작성**

```ts
expect(parseDfkDeviceUuid("44464b4c454401010101aabbccddeeff")).toEqual({
  formatVersion: 1,
  productFamily: 1,
  modelCode: 1,
  hardwareRevision: 1,
  deviceIdentity: "aabbccddeeff"
});
expect(parseDfkDeviceUuid("00112233445566778899aabbccddeeff")).toBeNull();
```

- [x] **Step 2: gateway filter 실패 테스트 작성**

```ts
provisioner.handleUnprovisionedDevice(tarPartyUuid);
expect(onDiscovered).not.toHaveBeenCalled();
provisioner.handleUnprovisionedDevice(dfkUuid);
expect(onDiscovered).toHaveBeenCalledTimes(1);
```

- [x] **Step 3: RED 확인**

Run: `pnpm --filter @led-control/shared exec vitest run src/product-identity.test.ts`

Run: `pnpm --filter @led-control/gateway exec vitest run src/mesh/bluez-provisioner.test.ts`

Expected: parser와 filter 부재로 FAIL

- [x] **Step 4: shared, gateway, firmware 구현**

```c
void device_identity_build(uint8_t output[16]) {
  memcpy(output, "DFKLED", 6);
  output[6] = 0x01;
  output[7] = CONFIG_DFK_PRODUCT_FAMILY;
  output[8] = CONFIG_DFK_MODEL_CODE;
  output[9] = CONFIG_DFK_HARDWARE_REVISION;
  ESP_ERROR_CHECK(esp_read_mac(&output[10], ESP_MAC_BT));
}
```

Gateway는 parser가 `null`인 장치를 구조화 로그로만 남기고 scan event로 발행하지 않는다.

- [x] **Step 5: Task 검증**

Run: `pnpm --filter @led-control/shared test && pnpm --filter @led-control/gateway exec vitest run src/mesh/bluez-provisioner.test.ts`

Run: `scripts/esp32-h2-build.sh`

Expected: TypeScript 테스트와 ESP-IDF build exit 0

- [x] **Step 6: 문서 갱신과 커밋**

```bash
git add packages/shared/src apps/gateway/src/mesh/bluez-provisioner.ts apps/gateway/src/mesh/bluez-provisioner.test.ts \
  apps/esp32-h2-firmware/main apps/esp32-h2-firmware/README.md docs/menus/monitoring.md \
  docs/superpowers/plans/2026-08-19-monitoring-control-focused-completion.md
git commit -m "feat(mesh): filter discovery by product identity"
```

- [x] **사용자 확인 Gate 4:** 구현 결과와 펌웨어 build 결과를 보고하고 다음 Task 승인을 기다린다.

---

### Task 5: 등록용 원자 이름·Mesh 주소 예약

**Files:**
- Modify: `apps/api/prisma/schema.prisma`
- Create: `apps/api/prisma/migrations/20260819090000_add_registration_allocators/migration.sql`
- Create: `apps/api/src/registration/registration-allocation.service.ts`
- Create: `apps/api/src/registration/registration-allocation.service.spec.ts`
- Modify: `apps/api/src/registration/registration.module.ts`
- Modify: `docs/database-schema.md`
- Modify: `docs/menus/monitoring.md`

**Interfaces:**
- Produces: `reserveFixtureNumbers(tx, floorId, count, minimumStart=1): Promise<number[]>`
- Produces: `reserveMeshAddresses(tx, gatewayId, count): Promise<string[]>`
- DB: `Floor.nextFixtureSequence Int @default(0)`
- DB: `Gateway.nextMeshUnicastAddress Int @default(256)`

- [x] **Step 1: 동시 예약 실패 테스트 작성**

```ts
await expect(service.reserveFixtureNumbers(tx, floorId, 3)).resolves.toEqual([1, 2, 3]);
await expect(service.reserveMeshAddresses(tx, gatewayId, 2)).resolves.toEqual(["0x0100", "0x0101"]);
expect(tx.floor.update).toHaveBeenCalledWith(expect.objectContaining({ data: { nextFixtureSequence: { increment: 3 } } }));
```

- [x] **Step 2: 범위 초과 실패 테스트 작성**

```ts
await expect(service.reserveMeshAddresses(tx, gatewayId, 1)).rejects.toThrow("mesh unicast address range exhausted");
```

- [x] **Step 3: RED 확인**

Run: `pnpm --filter @led-control/api exec jest src/registration/registration-allocation.service.spec.ts --runInBand`

Expected: allocator 부재로 FAIL

- [x] **Step 4: Prisma migration과 allocator 구현**

```ts
const rows = await tx.$queryRaw<Array<{ nextFixtureSequence: number }>>`
  SELECT "nextFixtureSequence" FROM "Floor" WHERE id = ${floorId} FOR UPDATE
`;
const start = Math.max(rows[0].nextFixtureSequence + 1, minimumStart);
const end = start + count - 1;
await tx.floor.update({ where: { id: floorId }, data: { nextFixtureSequence: end } });
return Array.from({ length: count }, (_, index) => start + index);
```

Gateway도 같은 increment-return 패턴을 사용하고 `0x0001~0x7fff` 범위를 검증한다.

- [x] **Step 5: migration과 Task 검증**

Run: `pnpm --filter @led-control/api prisma:generate`

Run: `pnpm --filter @led-control/api exec jest src/registration/registration-allocation.service.spec.ts --runInBand`

Run: `pnpm --filter @led-control/api typecheck`

Expected: exit 0

- [x] **Step 6: DB 문서 갱신과 커밋**

```bash
git add apps/api/prisma apps/api/src/registration docs/database-schema.md docs/menus/monitoring.md \
  docs/superpowers/plans/2026-08-19-monitoring-control-focused-completion.md
git commit -m "feat(registration): reserve names and mesh addresses atomically"
```

- [x] **사용자 확인 Gate 5:** schema 변경과 migration 적용법을 보고하고 다음 Task 승인을 기다린다.

---

### Task 6: 일괄·개별 등록 API

**Files:**
- Modify: `packages/shared/src/schemas.ts`
- Modify: `packages/shared/src/schemas.test.ts`
- Modify: `apps/api/prisma/schema.prisma`
- Create: `apps/api/prisma/migrations/20260819091000_extend_registration_batch/migration.sql`
- Modify: `apps/api/src/registration/registration.controller.ts`
- Modify: `apps/api/src/registration/registration.controller.spec.ts`
- Modify: `apps/api/src/registration/registration.service.ts`
- Modify: `apps/api/src/registration/registration.service.spec.ts`
- Modify: `apps/api/src/mqtt/mqtt.service.ts`
- Modify: `apps/web/src/api/registration.ts`
- Modify: `docs/database-schema.md`
- Modify: `docs/menus/monitoring.md`

**Interfaces:**
- Produces: `POST /registration-sessions/:sessionId/nodes/register-batch`
- Input: `{ mode, defaults, nodes }`
- Node status adds `reconcile_required`, discovered node adds `pendingFixtureSize Float?`
- Produces: node별 `accepted | validation_failed` 결과

- [x] **Step 1: shared batch schema 실패 테스트 작성**

```ts
const input = registerFixtureBatchSchema.parse({
  mode: "batch",
  defaults: { namePrefix: "B2-L", startNumber: 1, digits: 3, ratedWatt: "40.00", size: 20 },
  nodes: [{ nodeId, placement: { mode: "auto" } }]
});
expect(input.mode).toBe("batch");
```

- [x] **Step 2: service의 원자 예약과 부분 결과 실패 테스트 작성**

```ts
const result = await service.registerBatch(user, sessionId, input);
expect(result.items).toEqual([
  expect.objectContaining({ nodeId: node1, fixtureName: "B2-L001", status: "accepted" }),
  expect.objectContaining({ nodeId: node2, status: "validation_failed" })
]);
```

- [x] **Step 3: RED 확인**

Run: `pnpm --filter @led-control/shared exec vitest run src/schemas.test.ts`

Run: `pnpm --filter @led-control/api exec jest src/registration/registration.service.spec.ts src/registration/registration.controller.spec.ts --runInBand`

Expected: batch contract와 endpoint 부재로 FAIL

- [x] **Step 4: batch 등록과 reconcile 상태 구현**

```ts
type RegisterBatchResult = {
  items: Array<{
    nodeId: string;
    status: "accepted" | "validation_failed";
    fixtureName?: string;
    error?: string;
  }>;
};
```

서버는 선택 node를 한 transaction에서 검증하고 Task 5 allocator를 호출한다. 자동 좌표는 floor plan 크기 안의 빈 grid cell을 결정한다. MQTT publish 결과가 불명확한 node는 provisioning failure event 처리에서 `reconcile_required`로 전환한다.

- [x] **Step 5: Task 검증**

Run: `pnpm --filter @led-control/shared test && pnpm --filter @led-control/api exec jest src/registration --runInBand`

Run: `pnpm --filter @led-control/api typecheck`

Expected: exit 0

- [x] **Step 6: DB·메뉴 문서 갱신과 커밋**

```bash
git add packages/shared/src apps/api/prisma apps/api/src/registration apps/api/src/mqtt/mqtt.service.ts \
  apps/web/src/api/registration.ts docs/database-schema.md docs/menus/monitoring.md \
  docs/superpowers/plans/2026-08-19-monitoring-control-focused-completion.md
git commit -m "feat(registration): support batch and individual fixture setup"
```

- [x] **사용자 확인 Gate 6:** API 예시와 테스트 결과를 보고하고 다음 Task 승인을 기다린다.

---

### Task 7: 조명 등록 일괄·개별 설정 UI

**Files:**
- Modify: `apps/web/src/features/registration/RegistrationPanel.tsx`
- Create: `apps/web/src/features/registration/RegistrationPanel.test.tsx`
- Create: `apps/web/src/features/registration/FixtureBatchForm.tsx`
- Create: `apps/web/src/features/registration/FixtureIndividualForm.tsx`
- Modify: `apps/web/src/api/registration.ts`
- Modify: `apps/web/src/styles.css`
- Modify: `docs/menus/monitoring.md`

**Interfaces:**
- Consumes: Task 6 batch endpoint
- Produces: 검색 node checkbox 선택, `일괄 설정`/`개별 설정` segmented control
- Produces: node별 validation과 provisioning 상태 표시

- [x] **Step 1: 일괄 설정 실패 테스트 작성**

```tsx
fireEvent.click(screen.getByLabelText("조명 1 선택"));
fireEvent.click(screen.getByLabelText("조명 2 선택"));
fireEvent.change(screen.getByLabelText("이름 접두어"), { target: { value: "B2-L" } });
fireEvent.click(screen.getByRole("button", { name: "선택 조명 등록" }));
expect(registerBatch).toHaveBeenCalledWith(expect.objectContaining({ mode: "batch" }));
```

- [x] **Step 2: 개별 설정 실패 테스트 작성**

```tsx
fireEvent.click(screen.getByRole("radio", { name: "개별 설정" }));
fireEvent.change(screen.getByLabelText("조명 1 이름"), { target: { value: "입구 조명" } });
expect(screen.getByDisplayValue("입구 조명")).toBeInTheDocument();
```

- [x] **Step 3: RED 확인**

Run: `pnpm --filter @led-control/web exec vitest run src/features/registration/RegistrationPanel.test.tsx`

Expected: 다중 선택과 설정 form 부재로 FAIL

- [x] **Step 4: UI 최소 구현**

```ts
type RegistrationMode = "batch" | "individual";
type SelectedNodeDraft = {
  nodeId: string;
  fixtureName: string;
  ratedWatt: string;
  x?: number;
  y?: number;
  size: number;
};
```

form은 서버 validation 결과를 node 행에 표시하고 성공 node 선택을 해제한다. 실패와 `reconcile_required` node는 선택과 오류 내용을 유지한다.

- [x] **Step 5: Task 검증**

Run: `pnpm --filter @led-control/web exec vitest run src/features/registration/RegistrationPanel.test.tsx`

Run: `pnpm --filter @led-control/web build`

Expected: exit 0

- [x] **Step 6: 메뉴 문서 갱신과 커밋**

```bash
git add apps/web/src/features/registration apps/web/src/api/registration.ts apps/web/src/styles.css \
  docs/menus/monitoring.md docs/superpowers/plans/2026-08-19-monitoring-control-focused-completion.md
git commit -m "feat(web): add batch and individual fixture registration"
```

- [x] **사용자 확인 Gate 7:** 화면 동작과 테스트 결과를 보고하고 다음 Task 승인을 기다린다.

---

### Task 8: Health Current snapshot 저장과 표시

**Files:**
- Modify: `apps/api/prisma/schema.prisma`
- Create: `apps/api/prisma/migrations/20260819092000_add_fixture_health_snapshot/migration.sql`
- Modify: `packages/shared/src/gateway-contracts.ts`
- Modify: `packages/shared/src/gateway-contracts.test.ts`
- Modify: `apps/gateway/src/gateway.ts`
- Modify: `apps/gateway/src/index.ts`
- Modify: `apps/gateway/src/index.test.ts`
- Modify: `apps/gateway/src/mesh/bluez-mesh-adapter.ts`
- Modify: `apps/gateway/src/mesh/bluez-mesh-adapter.test.ts`
- Modify: `apps/api/src/mqtt/mqtt.service.ts`
- Modify: `apps/api/src/mqtt/mqtt-v2-state.spec.ts`
- Create: `apps/api/src/fixtures/fixture-health.ts`
- Modify: `apps/api/src/fixtures/fixtures.service.ts`
- Modify: `apps/api/src/sites/sites.service.ts`
- Modify: `apps/web/src/api/queries.ts`
- Modify: `apps/web/src/features/monitoring/MonitoringView.tsx`
- Modify: `apps/web/src/features/control/ControlView.tsx`
- Create: `apps/web/src/features/control/ControlView.test.tsx`
- Modify: `apps/web/src/styles.css`
- Modify: `docs/database-schema.md`
- Modify: `docs/menus/monitoring.md`
- Modify: `docs/menus/control.md`

**Interfaces:**
- DB: `Fixture.healthFaultCodes Json?`, `Fixture.healthLastSeenAt DateTime?`
- MQTT fixture state: `health: { faultCodes: number[]; observedAt: string }`
- UI status: `정상 | 장애 | 확인 대기`

- [x] **Step 1: shared와 MQTT persistence 실패 테스트 작성**

```ts
expect(fixtureStateV2Schema.parse({ ...event, health: { faultCodes: [1, 4], observedAt } }).health.faultCodes).toEqual([1, 4]);
expect(prisma.fixture.updateMany).toHaveBeenCalledWith(expect.objectContaining({
  data: expect.objectContaining({ healthFaultCodes: [1, 4], healthLastSeenAt: new Date(observedAt), status: "fault" })
}));
```

- [x] **Step 2: no-fault 변환 실패 테스트 작성**

```ts
expect(mapHealthFaults([0])).toEqual([]);
expect(statusFromHealth([])).toBe("online");
```

- [x] **Step 3: RED 확인**

Run: `pnpm --filter @led-control/shared exec vitest run src/gateway-contracts.test.ts`

Run: `pnpm --filter @led-control/api exec jest src/mqtt/mqtt-v2-state.spec.ts --runInBand`

Expected: health schema와 DB 필드 부재로 FAIL

- [x] **Step 4: schema, persistence, 조회와 UI 구현**

```ts
const faultCodes = [...new Set(input.health.faultCodes.filter((code) => code !== 0))].sort((a, b) => a - b);
const status = faultCodes.length > 0 ? "fault" : "online";
```

통신 품질 점수나 이력은 생성하지 않고 최신 Health Current snapshot만 보존한다.

- [x] **Step 5: Task 검증**

Run: `pnpm --filter @led-control/api prisma:generate`

Run: `pnpm --filter @led-control/shared test`

Run: `pnpm --filter @led-control/gateway test && pnpm --filter @led-control/gateway typecheck`

Run: `pnpm --filter @led-control/api exec jest src/mqtt/mqtt-v2-state.spec.ts src/fixtures/fixtures.service.spec.ts src/sites/sites.service.spec.ts --runInBand && pnpm --filter @led-control/api typecheck`

Run: `pnpm --filter @led-control/web test && pnpm --filter @led-control/web build`

Expected: exit 0

- [x] **Step 6: DB·메뉴 문서 갱신과 커밋**

```bash
git add packages/shared/src apps/api/prisma apps/api/src/mqtt apps/api/src/fixtures apps/api/src/sites \
  apps/web/src/api/queries.ts apps/web/src/features/monitoring/MonitoringView.tsx \
  apps/web/src/features/control/ControlView.tsx docs/database-schema.md docs/menus/monitoring.md docs/menus/control.md \
  docs/superpowers/plans/2026-08-19-monitoring-control-focused-completion.md
git commit -m "feat(health): persist current mesh health faults"
```

- [ ] **사용자 확인 Gate 8:** migration과 상태 변환 결과를 보고하고 다음 Task 승인을 기다린다.

---

### Task 9: Mesh control group DB 모델과 주소 allocator

**Files:**
- Modify: `apps/api/prisma/schema.prisma`
- Create: `apps/api/prisma/migrations/20260819093000_add_mesh_control_groups/migration.sql`
- Create: `apps/api/src/mesh-control-groups/mesh-control-group.schema.spec.ts`
- Create: `apps/api/src/mesh-control-groups/mesh-control-group.service.ts`
- Create: `apps/api/src/mesh-control-groups/mesh-control-group.service.spec.ts`
- Create: `apps/api/src/mesh-control-groups/mesh-control-group.module.ts`
- Modify: `apps/api/src/app.module.ts`
- Modify: `docs/database-schema.md`
- Modify: `docs/menus/control.md`

**Interfaces:**
- Produces: `ensureFloorGroup(tx, gatewayId, floorId)`
- Produces: `ensureFixtureGroup(tx, gatewayId, fixtureGroupId)`
- Group address range: `0xC000~0xFEFF`, gateway별 원자 증가
- DB: `MeshControlGroup`, `MeshControlGroupMember`

- [x] **Step 1: allocator와 uniqueness 실패 테스트 작성**

```ts
await expect(service.ensureFloorGroup(tx, gatewayId, floorId)).resolves.toMatchObject({
  targetType: "floor",
  targetId: floorId,
  groupAddress: "0xc000",
  status: "configuring"
});
```

- [x] **Step 2: 다른 gateway 분리 실패 테스트 작성**

```ts
expect(await service.ensureFloorGroup(tx, gateway2, floorId)).toMatchObject({ gatewayId: gateway2 });
```

- [x] **Step 3: RED 확인**

Run: `pnpm --filter @led-control/api exec jest src/mesh-control-groups/mesh-control-group.service.spec.ts --runInBand`

Expected: 모델과 service 부재로 FAIL

- [x] **Step 4: schema와 service 구현**

```ts
type MeshControlTarget =
  | { targetType: "floor"; targetId: string }
  | { targetType: "fixture_group"; targetId: string };
```

Gateway에 `nextMeshGroupAddress Int @default(49152)`를 두고 increment-return으로 주소를 예약한다. group과 member는 `configuring | ready | failed` 및 구성 version을 저장한다.

- [x] **Step 5: migration과 Task 검증**

Run: `pnpm --filter @led-control/api prisma:generate`

Run: `pnpm --filter @led-control/api exec jest src/mesh-control-groups/mesh-control-group.schema.spec.ts src/mesh-control-groups/mesh-control-group.service.spec.ts --runInBand`

Run: `pnpm --filter @led-control/api typecheck`

Expected: exit 0

- [x] **Step 6: DB 문서 갱신과 커밋**

```bash
git add apps/api/prisma apps/api/src/mesh-control-groups apps/api/src/app.module.ts \
  docs/database-schema.md docs/menus/control.md docs/superpowers/plans/2026-08-19-monitoring-control-focused-completion.md
git commit -m "feat(mesh): add persistent control groups"
```

- [ ] **사용자 확인 Gate 9:** 주소 범위와 DB 구조를 보고하고 다음 Task 승인을 기다린다.

---

### Task 10: BLE Mesh model subscription 구성과 동기화

**Files:**
- Modify: `packages/shared/src/mqtt.ts`
- Modify: `packages/shared/src/schemas.ts`
- Modify: `packages/shared/src/schemas.test.ts`
- Modify: `apps/gateway/src/mesh/bluez-config-codec.ts`
- Modify: `apps/gateway/src/mesh/bluez-config-codec.test.ts`
- Modify: `apps/gateway/src/mesh/bluez-config-client.ts`
- Modify: `apps/gateway/src/mesh/bluez-config-client.test.ts`
- Modify: `apps/gateway/src/gateway.ts`
- Modify: `apps/gateway/src/index.ts`
- Modify: `apps/gateway/src/commands/gateway-command-handler.test.ts`
- Modify: `apps/gateway/src/mesh/bluez-mesh-adapter.ts`
- Modify: `apps/gateway/src/mesh/bluez-mesh-adapter.test.ts`
- Create: `apps/gateway/src/mesh/group-subscription-handler.ts`
- Create: `apps/gateway/src/mesh/group-subscription-handler.test.ts`
- Modify: `apps/gateway/src/adapters/adapter-factory.test.ts`
- Modify: `apps/gateway/test/stub-adapters.ts`
- Modify: `apps/api/src/mesh-control-groups/mesh-control-group.module.ts`
- Modify: `apps/api/src/mqtt/mqtt.service.ts`
- Modify: `apps/api/src/mqtt/mqtt.service.spec.ts`
- Modify: `apps/api/prisma/schema.prisma`
- Create: `apps/api/prisma/migrations/20260821093000_add_mesh_control_group_member_status_version/migration.sql`
- Modify: `docs/database-schema.md`
- Create: `apps/api/src/mesh-control-groups/mesh-group-sync.worker.ts`
- Create: `apps/api/src/mesh-control-groups/mesh-group-sync.worker.spec.ts`
- Modify: `docs/menus/control.md`
- Create: `.superpowers/sdd/2026-08-19-monitoring-control-focused-completion/task-10-report.md`

**Interfaces:**
- MQTT command: `mesh-group/subscription-sync`
- MQTT event: `mesh-group/subscription-result`
- Gateway: `BluezConfigClient.addModelSubscription(unicast, groupAddress, 0x1300)`
- API: 10초 주기 sync worker가 `configuring` group을 versioned command로 발행하고 모든 member ACK 성공 후 group을 `ready`로 전환

- [x] **Step 1: Config opcode codec 실패 테스트 작성**

```ts
expect(Array.from(encodeModelSubscriptionAdd(0x0100, 0xc000, 0x1300))).toEqual([
  0x80, 0x1b, 0x00, 0x01, 0x00, 0xc0, 0x00, 0x13
]);
```

- [x] **Step 2: subscription 결과 집계 실패 테스트 작성**

```ts
await handler.sync({ groupId, groupAddress: "0xc000", members });
expect(configClient.addModelSubscription).toHaveBeenCalledTimes(members.length);
expect(publishResult).toHaveBeenCalledWith(expect.objectContaining({ status: "ready" }));
await worker.runOnce();
expect(publishSubscriptionSync).toHaveBeenCalledWith(expect.objectContaining({ groupId, version: 2 }));
```

- [x] **Step 3: RED 확인**

Run: `pnpm --filter @led-control/shared exec vitest run src/schemas.test.ts`

Run: `pnpm --filter @led-control/gateway exec vitest run src/mesh/bluez-config-codec.test.ts src/mesh/bluez-config-client.test.ts src/mesh/group-subscription-handler.test.ts`

Run: `pnpm --filter @led-control/api exec jest src/mesh-control-groups/mesh-group-sync.worker.spec.ts src/mqtt/mqtt.service.spec.ts --runInBand`

Expected: shared topic/schema 미정의, subscription codec/client API 미구현, handler/worker 파일 부재, result persistence 미구현으로 FAIL

- [x] **Step 4: shared 계약, gateway 구성, API 집계 구현**

```ts
type MeshGroupSubscriptionResult = {
  groupId: string;
  version: number;
  members: Array<{ meshNodeId: string; status: "ready" | "failed"; error?: string }>;
};
```

Gateway는 Light Lightness Server `0x1300`에 subscription을 추가하고 Config Model Subscription Status의 source, element, group, model을 검증한다. 같은 source/opcode의 동시 요청은 parser 전에 request-specific raw matcher로 상관관계가 맞는 응답만 각 waiter가 소비한다. ESP32-H2 Config Server는 표준 subscription을 이미 처리하므로 firmware에 사설 opcode를 추가하지 않는다. API worker는 `configuring` group 중 member가 1개 이상인 group만 10초마다 조회하고, 한 group publish 실패를 구조적 로그로 남긴 뒤 다음 group 발행을 계속 진행하며, 같은 group ID와 version을 다시 발행할 수 있다. Gateway 처리는 idempotent하며 외부 `ready` 결과를 API가 내부 `subscriptionStatus="applied"`로 변환한다. 결과 ACK의 version이 현재 DB version과 일치할 때만 상태를 갱신하고 `statusVersion`으로 같은 version의 성공/실패만 집계한다.

- [x] **Step 5: Task 검증**

Run: `pnpm --filter @led-control/shared test`

Run: `pnpm --filter @led-control/gateway exec vitest run src/mesh/bluez-config-codec.test.ts src/mesh/bluez-config-client.test.ts src/mesh/group-subscription-handler.test.ts src/mesh/bluez-mesh-adapter.test.ts src/adapters/adapter-factory.test.ts`

Run: `pnpm --filter @led-control/api exec jest src/mesh-control-groups/mesh-group-sync.worker.spec.ts src/mqtt/mqtt.service.spec.ts --runInBand`

Run: `pnpm --filter @led-control/api typecheck`

Run: `pnpm --filter @led-control/api prisma:generate`

Expected: exit 0

- [x] **Step 6: 메뉴 문서 갱신과 커밋**

```bash
git add packages/shared/src apps/gateway/src/gateway.ts apps/gateway/src/index.ts \
  apps/gateway/src/commands/gateway-command-handler.test.ts apps/gateway/src/adapters/adapter-factory.test.ts \
  apps/gateway/src/mesh apps/gateway/test/stub-adapters.ts \
  apps/api/src/mesh-control-groups apps/api/src/mqtt/mqtt.service.ts apps/api/src/mqtt/mqtt.service.spec.ts docs/menus/control.md \
  .superpowers/sdd/2026-08-19-monitoring-control-focused-completion/task-10-report.md \
  docs/superpowers/plans/2026-08-19-monitoring-control-focused-completion.md
git commit -m "feat(mesh): synchronize control group subscriptions"
```

- [x] **사용자 확인 Gate 10:** subscription ACK 집계와 테스트를 보고하고 다음 Task 승인을 기다린다.

---

### Task 11: provisioning 완료 시 floor/zone subscription 연결

**Files:**
- Modify: `apps/api/src/mqtt/mqtt.service.ts`
- Modify: `apps/api/src/mqtt/mqtt.service.spec.ts`
- Modify: `apps/api/src/registration/registration.service.ts`
- Modify: `apps/api/src/registration/registration.service.spec.ts`
- Modify: `apps/api/src/mesh-control-groups/mesh-control-group.service.ts`
- Modify: `apps/api/src/mesh-control-groups/mesh-control-group.service.spec.ts`
- Modify: `docs/menus/monitoring.md`
- Modify: `docs/menus/control.md`

**Interfaces:**
- Consumes: Task 9 group persistence, Task 10 subscription sync
- Produces: provisioning 완료 node의 floor group 자동 membership
- Produces: 기존 FixtureGroup membership의 zone subscription 동기화

- [x] **Step 1: provisioning 완료 hook 실패 테스트 작성**

```ts
await service.handleProvisioningCompleted(event);
expect(meshGroups.attachProvisionedNode).toHaveBeenCalledWith(expect.objectContaining({
  meshNodeId,
  floorId,
  gatewayId
}));
```

- [x] **Step 2: ready 전 제어 불가 상태 실패 테스트 작성**

```ts
await expect(meshGroups.getReadyDestination({ type: "floor", floorId, gatewayId }))
  .rejects.toThrow("mesh control group is not ready");
```

- [x] **Step 3: RED 확인**

Run: `pnpm --filter @led-control/api exec jest src/mqtt/mqtt.service.spec.ts src/registration/registration.service.spec.ts src/mesh-control-groups/mesh-control-group.service.spec.ts --runInBand`

Expected: provisioning hook 부재로 FAIL

- [x] **Step 4: membership와 sync dispatch 구현**

```ts
await this.meshGroups.attachProvisionedNode(tx, {
  meshNodeId,
  gatewayId,
  floorId,
  fixtureGroupIds
});
```

DB transaction은 member와 group을 `configuring`으로 저장한다. Task 10의 10초 주기 worker가 commit된 group을 찾아 subscription sync를 발행한다. 물리 subscription ACK 전에 `ready`로 만들지 않는다.

- [x] **Step 5: Task 검증**

Run: `pnpm --filter @led-control/api exec jest src/mqtt/mqtt.service.spec.ts src/registration/registration.service.spec.ts src/mesh-control-groups/mesh-control-group.service.spec.ts --runInBand`

Run: `pnpm --filter @led-control/api typecheck`

Expected: exit 0

- [x] **Step 6: 메뉴 문서 갱신과 커밋**

```bash
git add apps/api/src/mqtt apps/api/src/registration apps/api/src/mesh-control-groups \
  docs/menus/monitoring.md docs/menus/control.md docs/superpowers/plans/2026-08-19-monitoring-control-focused-completion.md
git commit -m "feat(registration): configure mesh groups after provisioning"
```

- 2026-08-21 fix round 1: group row 선잠금 후 member createMany(skipDuplicates)로 attach를 직렬화하고, subscription ACK도 같은 group->member 잠금 순서로 맞췄다. 기존 fixture가 다른 층에 이미 연결된 경우 `fixture is already assigned to another floor`로 실패 처리해 잘못된 floor group attach를 차단했다.
- 2026-08-21 fix round 2: subscription ACK 잠금 SQL을 `FOR UPDATE OF g`로 좁혀 `Gateway` row 동반 잠금과 gateway->group 반대 순서 교착 가능성을 줄였다.

- [ ] **사용자 확인 Gate 11:** 등록 후 group 준비 상태 흐름을 보고하고 다음 Task 승인을 기다린다.

---

### Task 12: 제어 target과 delivery mode API

**Files:**
- Modify: `packages/shared/src/gateway-contracts.ts`
- Modify: `packages/shared/src/gateway-contracts.test.ts`
- Modify: `packages/shared/src/schemas.ts`
- Modify: `packages/shared/src/schemas.test.ts`
- Modify: `apps/api/src/commands/commands.controller.ts`
- Modify: `apps/api/src/commands/commands.controller.spec.ts`
- Modify: `apps/api/src/commands/commands.service.ts`
- Modify: `apps/api/src/commands/commands.service.spec.ts`
- Modify: `apps/api/src/commands/command-dispatch.service.ts`
- Modify: `apps/api/src/commands/command-status.service.ts`
- Modify: `apps/api/src/mesh-control-groups/mesh-control-group.service.ts`
- Modify: `apps/api/src/mqtt/outbox-publisher.service.ts`
- Create: `apps/api/src/commands/command-target-migration.spec.ts`
- Modify: `apps/api/prisma/schema.prisma`
- Create: `apps/api/prisma/migrations/20260819094000_extend_command_targets/migration.sql`
- Modify: `docs/database-schema.md`
- Modify: `docs/menus/control.md`

**Interfaces:**
- Input: `DimmingTarget = fixture | fixtures | floor | group`
- Produces: `deliveryMode = unicast | parallel_unicast | mesh_group`
- Gateway payload adds `destinationAddress`, `meshControlGroupId`, `meshControlGroupVersion` for mesh group
- DB: `Command.targetId String?`, `Command.targetFixtureIds Json`, `CommandDispatch.deliveryMode String`, `CommandDispatch.destinationAddress String?`, `CommandDispatch.meshControlGroupId String?`, `CommandDispatch.meshControlGroupVersion Int?`

- [x] **Step 1: target schema 실패 테스트 작성**

```ts
expect(createDimmingCommandSchema.parse({
  siteId,
  target: { type: "fixtures", fixtureIds: [fixture1, fixture2] },
  brightness: 70
}).target.type).toBe("fixtures");
```

- [x] **Step 2: delivery mode 결정 실패 테스트 작성**

```ts
expect(await service.createDimmingCommand(user, floorInput)).toMatchObject({ deliveryMode: "mesh_group" });
expect(await service.createDimmingCommand(user, multiInput)).toMatchObject({ deliveryMode: "parallel_unicast" });
```

- [x] **Step 3: 다중 gateway와 준비 안 된 group 거부 테스트 작성**

```ts
await expect(service.createDimmingCommand(user, floorAcrossGateways)).rejects.toThrow("multiple gateways are not supported");
await expect(service.createDimmingCommand(user, unreadyGroup)).rejects.toThrow("mesh control group is not ready");
```

- [x] **Step 4: RED 확인**

Run: `pnpm --filter @led-control/shared exec vitest run src/gateway-contracts.test.ts`

Run: `pnpm --filter @led-control/shared exec vitest run src/schemas.test.ts`

Run: `pnpm --filter @led-control/api exec jest src/commands/commands.service.spec.ts src/commands/commands.controller.spec.ts --runInBand`

Expected: 확장 target과 delivery mode 부재로 FAIL

- [x] **Step 5: API와 DB 최소 구현**

```ts
type ResolvedControlTarget = {
  fixtureIds: string[];
  gatewayId: string;
  deliveryMode: "unicast" | "parallel_unicast" | "mesh_group";
  destinationAddress?: string;
};
```

서버는 floor/group fixture를 DB에서 다시 계산하고 임의 선택이 ready floor/group과 정확히 일치하면 `mesh_group`으로 승격한다. migration은 기존 Command의 result fixture snapshot, Dispatch의 실제 result 수 기반 physical mode, 기존 outbox의 strict `fixtures` payload를 backfill한 뒤 NOT NULL을 적용하고 `Command.targetId`의 NOT NULL 제약을 제거한다.

- [x] **Step 6: Task 검증**

Run: `pnpm --filter @led-control/api prisma:generate`

Run: `pnpm --filter @led-control/shared test && pnpm --filter @led-control/api exec jest src/commands --runInBand && pnpm --filter @led-control/api typecheck`

Expected: exit 0

- [x] **Step 7: DB·메뉴 문서 갱신과 커밋**

```bash
git add packages/shared/src apps/api/prisma apps/api/src/commands docs/database-schema.md docs/menus/control.md \
  docs/superpowers/plans/2026-08-19-monitoring-control-focused-completion.md
git commit -m "feat(control): resolve fixture floor and group targets"
```

- [x] **Review fix 1: 기존 outbox와 Dispatch migration 정규화**

과거 outbox는 `CommandFixtureResult` 목록을 권위 있는 대상으로 사용한다. 과거 `group` payload는 Mesh subscription/version 증거가 없으므로 `fixtures`와 `unicast | parallel_unicast`로 바꾸고, result가 없거나 strict wire 한도 1,000개를 초과하는 outbox가 있으면 migration을 중단한다. Task 12 migration은 아직 적용 전이라는 전제에서 같은 파일을 수정했다.

- [x] **Review fix 2: Mesh group snapshot과 발행 직전 검증**

Dispatch와 Gateway payload에 group ID/version/address를 저장한다. Publisher는 payload 준비 transaction 안에서 현재 group과 snapshot을 비교해 같은 version의 `configuring`만 재시도하고, missing/failed/version/address/gateway mismatch는 `MESH_GROUP_STALE`로 즉시 종료한다.

- [x] **Review fix 3: Gateway wire 불변식 강화**

fixture 목록의 unique/1,000개 제한, target type/ID/fixture 수/delivery mode 조합, BLE Mesh group address 범위, Mesh metadata 필수·금지 조건을 shared Zod schema에서 함께 검증한다.

- [ ] **사용자 확인 Gate 12:** API 계약과 대상별 delivery mode를 보고하고 다음 Task 승인을 기다린다.

---

### Task 13: Gateway 병렬 unicast와 Mesh group 단일 전송

**Files:**
- Modify: `apps/gateway/src/mesh/bluez-model-codec.ts`
- Modify: `apps/gateway/src/mesh/bluez-model-codec.test.ts`
- Modify: `apps/gateway/src/mesh/bluez-mesh-adapter.ts`
- Modify: `apps/gateway/src/mesh/bluez-mesh-adapter.test.ts`
- Modify: `apps/gateway/src/commands/gateway-command-handler.ts`
- Modify: `apps/gateway/src/commands/gateway-command-handler.test.ts`
- Modify: `apps/esp32-h2-firmware/main/ble_mesh_node.c`
- Modify: `apps/esp32-h2-firmware/README.md`
- Modify: `docs/menus/control.md`

**Interfaces:**
- Produces: `encodeLightnessSetUnacknowledged(lightness, tid)`
- Produces: `applyParallelUnicast(expectedFixtures, brightness, concurrency=8)`
- Produces: `applyMeshGroup(groupAddress, expectedFixtures, brightness)`
- Group result: actual Lightness Status by expected source address
- Consumes: Task 12 `meshControlGroupId`, `meshControlGroupVersion`; Gateway 로컬에 적용 완료된 동일 group/version만 송신

- [ ] **Step 1: unacknowledged group codec 실패 테스트 작성**

```ts
expect(Array.from(encodeLightnessSetUnacknowledged(0xffff, 7))).toEqual([0x82, 0x4d, 0xff, 0xff, 0x07]);
```

- [ ] **Step 2: 단일 전송과 status 집계 실패 테스트 작성**

```ts
const result = adapter.applyMeshGroup(0xc000, fixtures, 70);
expect(transport.send).toHaveBeenCalledTimes(1);
emitLightnessStatus(source1, 70);
emitLightnessStatus(source2, 70);
await expect(result).resolves.toEqual(expect.arrayContaining([
  expect.objectContaining({ fixtureId: fixture1, status: "applied" }),
  expect.objectContaining({ fixtureId: fixture2, status: "applied" })
]));
```

- [ ] **Step 3: timeout과 state mismatch 실패 테스트 작성**

```ts
emitLightnessStatus(source1, 30);
await expect(result).resolves.toEqual(expect.arrayContaining([
  expect.objectContaining({ fixtureId: fixture1, status: "failed", errorCode: "state_mismatch" }),
  expect.objectContaining({ fixtureId: fixture2, status: "timed_out" })
]));
```

동시에 payload의 `meshControlGroupId`/`meshControlGroupVersion`이 Gateway 로컬에서 적용 완료한 subscription version과 다르면 BLE 송신 전에 실패하는 테스트를 작성한다. API publisher 검증 transaction 커밋과 실제 MQTT publish 사이의 극소 race를 이 물리 경계에서 최종 차단한다.

- [ ] **Step 4: RED 확인**

Run: `pnpm --filter @led-control/gateway exec vitest run src/mesh/bluez-model-codec.test.ts src/mesh/bluez-mesh-adapter.test.ts src/commands/gateway-command-handler.test.ts`

Expected: group opcode와 실행 경로 부재로 FAIL

- [ ] **Step 5: gateway와 firmware 구현**

```ts
switch (command.deliveryMode) {
  case "mesh_group":
    assertLocallyAppliedMeshGroupVersion(command.meshControlGroupId, command.meshControlGroupVersion);
    return adapter.applyMeshGroup(parseMeshAddress(command.destinationAddress), fixtures, command.brightness);
  case "parallel_unicast":
    return adapter.applyParallelUnicast(fixtures, command.brightness, 8);
  default:
    return adapter.applyUnicast(fixtures[0], command.brightness);
}
```

ESP32-H2는 Group Set Unack 수신 후 실제 PWM 상태를 publication한다. publication 지연은 primary unicast 하위 비트를 사용해 결정적으로 계산하고 command 적용 자체는 지연하지 않는다.

- [ ] **Step 6: Task 검증**

Run: `pnpm --filter @led-control/gateway exec vitest run src/mesh/bluez-model-codec.test.ts src/mesh/bluez-mesh-adapter.test.ts src/commands/gateway-command-handler.test.ts`

Run: `pnpm --filter @led-control/gateway typecheck`

Run: `scripts/esp32-h2-build.sh`

Expected: gateway test/typecheck와 ESP-IDF build exit 0

- [ ] **Step 7: 메뉴 문서 갱신과 커밋**

```bash
git add apps/gateway/src apps/esp32-h2-firmware/main/ble_mesh_node.c apps/esp32-h2-firmware/README.md \
  docs/menus/control.md docs/superpowers/plans/2026-08-19-monitoring-control-focused-completion.md
git commit -m "feat(gateway): execute mesh group dimming"
```

- [ ] **사용자 확인 Gate 13:** 단일 전송 증거와 firmware build 결과를 보고하고 다음 Task 승인을 기다린다.

---

### Task 14: 제어 화면 개별·다중·층·구역 선택

**Files:**
- Modify: `apps/web/src/api/commands.ts`
- Modify: `apps/web/src/api/queries.ts`
- Modify: `apps/web/src/features/control/ControlView.tsx`
- Create: `apps/web/src/features/control/ControlView.test.tsx`
- Create: `apps/web/src/features/control/ControlTargetPicker.tsx`
- Modify: `apps/web/src/styles.css`
- Modify: `docs/menus/control.md`

**Interfaces:**
- Consumes: Task 12 target API
- Produces: `개별/다중`, `층`, `구역` segmented control
- Produces: 검색, 상태·층 필터, checkbox 선택과 대상 요약

- [ ] **Step 1: 임의 다중 선택 실패 테스트 작성**

```tsx
fireEvent.click(screen.getByLabelText("B2-L001 선택"));
fireEvent.click(screen.getByLabelText("B2-L002 선택"));
fireEvent.click(screen.getByRole("button", { name: "밝기 적용" }));
expect(createCommand).toHaveBeenCalledWith(expect.objectContaining({
  target: { type: "fixtures", fixtureIds: [fixture1, fixture2] }
}));
```

- [ ] **Step 2: 층과 구역 target 실패 테스트 작성**

```tsx
fireEvent.click(screen.getByRole("radio", { name: "층" }));
fireEvent.click(screen.getByRole("button", { name: "B2" }));
expect(screen.getByText("BLE Mesh 그룹 전송")).toBeInTheDocument();
```

- [ ] **Step 3: 제어 불가 대상 차단 실패 테스트 작성**

```tsx
expect(screen.getByRole("button", { name: "밝기 적용" })).toBeDisabled();
expect(screen.getByText(/게이트웨이가 오프라인/)).toBeInTheDocument();
```

- [ ] **Step 4: RED 확인**

Run: `pnpm --filter @led-control/web exec vitest run src/features/control/ControlView.test.tsx`

Expected: 다중/층/구역 picker 부재로 FAIL

- [ ] **Step 5: target picker와 API 연결 구현**

```ts
type ControlMode = "fixtures" | "floor" | "group";
type ControlSelection =
  | { mode: "fixtures"; fixtureIds: string[] }
  | { mode: "floor"; floorId: string }
  | { mode: "group"; groupId: string };
```

목록은 이름 검색, 상태·층 필터를 제공하고 선택 개수와 제어 불가 개수를 표시한다. 1개 선택은 `fixture`, 2개 이상은 `fixtures` target으로 보낸다.

- [ ] **Step 6: Task 검증**

Run: `pnpm --filter @led-control/web exec vitest run src/features/control/ControlView.test.tsx`

Run: `pnpm --filter @led-control/web build`

Expected: exit 0

- [ ] **Step 7: 메뉴 문서 갱신과 커밋**

```bash
git add apps/web/src/api apps/web/src/features/control apps/web/src/styles.css docs/menus/control.md \
  docs/superpowers/plans/2026-08-19-monitoring-control-focused-completion.md
git commit -m "feat(control): add fixture floor and zone selection"
```

- [ ] **사용자 확인 Gate 14:** 화면 선택 흐름과 테스트를 보고하고 다음 Task 승인을 기다린다.

---

### Task 15: 사용자 관점 동기 제어와 재접속 복구

**Files:**
- Modify: `apps/web/src/api/commands.ts`
- Modify: `apps/web/src/features/control/ControlView.tsx`
- Modify: `apps/web/src/features/control/ControlView.test.tsx`
- Create: `apps/web/src/features/control/active-command-store.ts`
- Create: `apps/web/src/features/control/active-command-store.test.ts`
- Modify: `apps/web/src/styles.css`
- Modify: `docs/menus/control.md`

**Interfaces:**
- Produces: 현장별 진행 command ID의 sessionStorage 복구
- Produces: terminal 전 target, slider, preset, 적용 버튼 잠금
- Terminal: `completed | partial_failed | failed | timed_out`

- [ ] **Step 1: 명령 중 UI 잠금 실패 테스트 작성**

```tsx
fireEvent.click(screen.getByRole("button", { name: "밝기 적용" }));
expect(screen.getByRole("button", { name: "밝기 적용 중" })).toBeDisabled();
expect(screen.getByRole("slider", { name: "밝기" })).toBeDisabled();
```

- [ ] **Step 2: terminal 해제와 결과 실패 테스트 작성**

```tsx
commandStatus.resolve({ status: "partial_failed", results });
expect(await screen.findByText("일부 조명 적용 실패")).toBeInTheDocument();
expect(screen.getByRole("button", { name: "밝기 적용" })).toBeEnabled();
```

- [ ] **Step 3: 새로고침 복구 실패 테스트 작성**

```ts
sessionStorage.setItem(activeCommandKey(siteId), commandId);
render(<ControlView siteId={siteId} />);
expect(getCommandStatus).toHaveBeenCalledWith(commandId);
```

- [ ] **Step 4: RED 확인**

Run: `pnpm --filter @led-control/web exec vitest run src/features/control/ControlView.test.tsx src/features/control/active-command-store.test.ts`

Expected: 전체 UI 잠금과 command 복구 부재로 FAIL

- [ ] **Step 5: 동기 UX와 복구 구현**

```ts
const TERMINAL_COMMAND_STATUSES = new Set(["completed", "partial_failed", "failed", "timed_out"]);
```

명령 생성 즉시 command ID를 현장별 sessionStorage에 저장하고 1초 polling한다. terminal 수신 시 결과를 화면에 남기고 저장된 ID와 입력 잠금을 해제한다. 네트워크 오류는 command를 실패로 단정하지 않고 재조회 버튼을 제공한다.

- [ ] **Step 6: Task 검증**

Run: `pnpm --filter @led-control/web exec vitest run src/features/control/ControlView.test.tsx src/features/control/active-command-store.test.ts`

Run: `pnpm --filter @led-control/web build`

Expected: exit 0

- [ ] **Step 7: 메뉴 문서 갱신과 커밋**

```bash
git add apps/web/src/api/commands.ts apps/web/src/features/control apps/web/src/styles.css docs/menus/control.md \
  docs/superpowers/plans/2026-08-19-monitoring-control-focused-completion.md
git commit -m "feat(control): lock controls until device results"
```

- [ ] **사용자 확인 Gate 15:** 동기 제어 상태 전이와 테스트를 보고하고 최종 검증 승인을 기다린다.

---

### Task 16: 통합 회귀 검증과 수동 하드웨어 런북

**Files:**
- Modify: `apps/web/e2e/monitoring-1000.spec.ts`
- Create: `apps/web/e2e/monitoring-control-flow.spec.ts`
- Modify: `docs/runbooks/production-device-lab.md`
- Modify: `docs/runbooks/device-lab-first-install.md`
- Modify: `docs/menus/monitoring.md`
- Modify: `docs/menus/control.md`
- Modify: `docs/menus/settings.md`
- Modify: `docs/superpowers/plans/2026-08-19-monitoring-control-focused-completion.md`

**Interfaces:**
- Produces: 웹/API 계약 회귀 E2E
- Produces: 실제 Raspberry Pi + ESP32-H2 수동 검증 체크리스트와 증거 기록 형식
- Does not claim: 실제 하드웨어 검증 완료

- [ ] **Step 1: E2E 실패 시나리오 작성**

```ts
await page.getByRole("button", { name: "새로고침" }).click();
await expect(page.getByText(/마지막 갱신/)).toBeVisible();
await page.getByLabel("B2-L001 선택").check();
await page.getByRole("button", { name: "밝기 적용" }).click();
await expect(page.getByRole("button", { name: "밝기 적용 중" })).toBeDisabled();
```

- [ ] **Step 2: E2E RED 확인**

Run: `pnpm --filter @led-control/web exec playwright test e2e/monitoring-control-flow.spec.ts`

Expected: 통합 fixture와 route 계약이 완성되기 전 FAIL

- [ ] **Step 3: deterministic E2E fixture를 현재 계약에 맞게 작성**

테스트 전용 route fixture는 브라우저 계약 검증으로 명시하고 실제 하드웨어 검증으로 표기하지 않는다. 1,000 fixture 시나리오는 10분 query 정책과 지도 object 렌더링을 함께 검증한다.

- [ ] **Step 4: 전체 자동 검증**

Run: `pnpm test`

Run: `pnpm typecheck`

Run: `pnpm lint`

Run: `pnpm --filter @led-control/web build`

Run: `pnpm --filter @led-control/api build`

Run: `scripts/esp32-h2-build.sh`

Expected: 모든 명령 exit 0. 실패가 있으면 완료로 표시하지 않고 원인과 남은 작업을 기록한다.

- [ ] **Step 5: 수동 하드웨어 절차 갱신**

런북에 자사 UUID 검색, batch 등록, floor/zone subscription ready, group destination 1회 전송, fixture별 status, Health fault 발생·해제, 브라우저 재접속 복구의 명령과 기대 로그를 순서대로 기록한다.

- [ ] **Step 6: 메뉴 완료/보류 상태 갱신과 커밋**

```bash
git add apps/web/e2e docs/runbooks docs/menus docs/superpowers/plans/2026-08-19-monitoring-control-focused-completion.md
git commit -m "test: document monitoring and control hardware validation"
```

- [ ] **사용자 확인 Gate 16:** 자동 검증 결과, 미실행 실기 항목, 수동 E2E 절차를 최종 보고한다.
