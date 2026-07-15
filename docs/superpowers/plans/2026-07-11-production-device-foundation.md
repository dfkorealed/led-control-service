# 양산형 장비 기반 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Raspberry Pi 게이트웨이 1대와 ESP32-H2 조명 노드 2대가 안전하게 claim되고, mTLS MQTT와 실제 BLE Mesh를 통해 검색·등록·개별/그룹 제어·상태 동기화를 수행하는 양산형 기반을 만든다.

**Architecture:** 기존 TypeScript gateway를 유지하면서 Raspberry Pi의 `bluetooth-meshd`/BlueZ Mesh D-Bus를 장기 실행 `BleMeshAdapter`로 연결한다. 제조 장치 identity와 사용자 claim을 분리하고, HTTPS mTLS bootstrap으로 gateway assignment를 내려준 뒤 모든 MQTT 명령과 이벤트를 gateway 범위로 제한한다. BlueZ Phase 0이 실패하면 상위 계약은 유지한 채 ESP32-H2 provisioner USB/UART bridge adapter로 교체한다.

**Tech Stack:** TypeScript, Node.js, NestJS, Prisma, PostgreSQL, MQTT 5, Mosquitto 2, TLS/mTLS, `dbus-next`, SQLite, Vitest, Jest, ESP-IDF v5.5.1, ESP32-H2, BlueZ `bluetooth-meshd`.

## Global Constraints

- 모든 문서와 사용자 표시 문구는 한국어로 유지한다.
- 이 파일을 양산형 장비 기반의 단일 체크리스트와 진행 로그로 지속 갱신한다.
- 운영 모드에서는 stub과 익명 MQTT를 허용하지 않는다.
- 실제 인증서 private key, claim code 원문, NetKey/AppKey 원문은 Git에 커밋하지 않는다.
- 하드웨어 없는 테스트, Raspberry Pi probe, ESP32-H2 실기 E2E 결과를 서로 다른 검증 등급으로 기록한다.
- ESP32-H2 펌웨어는 ESP-IDF v5.5.1과 `esp32h2` target을 사용한다.
- 스케줄·이벤트 제어, OTA 실제 배포, 5대 이상 부하 및 대규모 RF 시험은 이번 범위에서 제외한다.

---

## 파일 구조

- `packages/shared/src/gateway-contracts.ts`: gateway-scoped MQTT v2 payload와 Zod schema
- `apps/api/src/gateway-onboarding/*`: 사용자 claim과 장치 bootstrap API
- `apps/api/src/commands/command-dispatch.service.ts`: gateway별 명령 fan-out과 outbox 생성
- `apps/api/src/mqtt/topic-scope.ts`: MQTT topic scope 파싱과 DB 관계 검증
- `apps/api/src/fixtures/fixture-freshness.service.ts`: gateway/fixture TTL 판정
- `apps/gateway/src/config/*`: bootstrap client와 assignment 저장
- `apps/gateway/src/mqtt/*`: mTLS client와 명령 처리·멱등성
- `apps/gateway/src/mesh/*`: BlueZ D-Bus transport와 실제 Mesh adapter
- `apps/gateway/scripts/bluez-capability-probe.ts`: Raspberry Pi Phase 0 probe
- `apps/esp32-h2-firmware/main/*`: 영속 상태, identify, factory reset, watchdog
- `scripts/dev-pki/*`: 개발 전용 CA·장치 인증서 생성 및 폐기

---

### Task 1: BlueZ Phase 0 capability probe

**Files:**
- Modify: `apps/gateway/package.json`
- Create: `apps/gateway/src/mesh/bluez-transport.ts`
- Create: `apps/gateway/src/mesh/bluez-transport.test.ts`
- Create: `apps/gateway/scripts/bluez-capability-probe.ts`
- Modify: `apps/gateway/README.md`

**Interfaces:**
- Produces: `BluezTransport.call<T>(service, path, iface, method, args): Promise<T>`
- Produces: probe 결과 `{ daemon, adapter, scan, provision, modelRoundTrip, restartRecovery }`

- [x] **Step 1: 실패하는 fake transport 테스트 작성**

```ts
it("keeps one D-Bus session and maps BlueZ errors", async () => {
  const bus = new FakeBus();
  const transport = new BluezTransport(() => bus);
  await transport.connect();
  await transport.call("org.bluez.mesh", "/org/bluez/mesh", "org.bluez.mesh.Network1", "Attach", []);
  expect(bus.connectCount).toBe(1);
  await expect(transport.call("org.bluez.mesh", "/bad", "x", "y", [])).rejects.toMatchObject({ code: "BLUEZ_DBUS_ERROR" });
});
```

- [x] **Step 2: 테스트가 모듈 부재로 실패하는지 확인**

Run: `pnpm --filter @led-control/gateway test -- bluez-transport.test.ts`
Expected: FAIL because `BluezTransport` does not exist.

- [x] **Step 3: `@homebridge/dbus-native`와 장기 세션 transport 구현**

```ts
export interface DbusBusFactory { (): MessageBus }

export class BluezTransport {
  private bus: MessageBus | null = null;
  constructor(private readonly createBus: DbusBusFactory = systemBus) {}
  async connect() { this.bus ??= this.createBus(); }
  async call<T>(service: string, path: string, iface: string, method: string, args: unknown[]): Promise<T> {
    await this.connect();
    try {
      const object = await this.bus!.getProxyObject(service, path);
      return await (object.getInterface(iface) as Record<string, (...values: unknown[]) => Promise<T>>)[method](...args);
    } catch (cause) {
      throw Object.assign(new Error("BlueZ D-Bus call failed", { cause }), { code: "BLUEZ_DBUS_ERROR" });
    }
  }
}
```

- [x] **Step 4: Raspberry Pi probe와 판정표 구현**

코드와 Mac의 `hardware_required` 판정은 완료했다. Raspberry Pi에서 daemon, adapter, PB-ADV, provisioning, model 왕복, 재부팅 복구를 확인하는 실기 판정은 하드웨어 실행 대기 상태다.

Probe는 `bluetooth-meshd` service, D-Bus service, Bluetooth adapter, PB-ADV scan을 순서대로 확인하고 JSON을 출력한다. Raspberry Pi에서만 `scan/provision/modelRoundTrip/restartRecovery`를 `passed`로 기록할 수 있다.

Run: `pnpm --filter @led-control/gateway exec tsx scripts/bluez-capability-probe.ts`
Expected on macOS: exit 2 with `hardware_required`.
Expected on Raspberry Pi: JSON fields are all `passed` before Task 9 begins.

- [x] **Step 5: 테스트·문서·커밋**

Run: `pnpm --filter @led-control/gateway test && pnpm --filter @led-control/gateway typecheck && git diff --check`
Expected: PASS.

```bash
git add apps/gateway/package.json apps/gateway/src/mesh apps/gateway/scripts/bluez-capability-probe.ts apps/gateway/README.md pnpm-lock.yaml
git commit -m "feat: add BlueZ capability probe"
```

---

### Task 2: Gateway-scoped MQTT v2 계약

**Files:**
- Create: `packages/shared/src/gateway-contracts.ts`
- Create: `packages/shared/src/gateway-contracts.test.ts`
- Modify: `packages/shared/src/index.ts`
- Modify: `packages/shared/src/mqtt.ts`

**Interfaces:**
- Produces: `mqttTopicsV2.gatewayCommand(siteId, gatewayId, kind)`
- Produces: `gatewayCommandSchema`, `acceptanceAckSchema`, `deviceStatusAckSchema`, `fixtureStateV2Schema`

- [x] **Step 1: gateway 범위와 이벤트 순서를 검증하는 실패 테스트 작성**

```ts
expect(mqttTopicsV2.gatewayCommand(siteId, gatewayId, "dimming"))
  .toBe(`sites/${siteId}/gateways/${gatewayId}/commands/dimming`);
expect(() => fixtureStateV2Schema.parse({ ...validState, eventId: "", sequence: -1 })).toThrow();
```

- [x] **Step 2: 실패 확인**

Run: `pnpm --filter @led-control/shared test -- gateway-contracts.test.ts`
Expected: FAIL because v2 exports do not exist.

- [x] **Step 3: 실제 payload 타입과 schema 구현**

```ts
export const fixtureStateV2Schema = z.object({
  eventId: z.string().uuid(), siteId: z.string().uuid(), gatewayId: z.string().uuid(),
  fixtureId: z.string().uuid(), sequence: z.number().int().nonnegative(),
  occurredAt: z.string().datetime(), brightness: z.number().int().min(0).max(100),
  powerOn: z.boolean(), status: z.enum(["online", "offline", "fault"]),
  faultCode: z.string().optional(), rssi: z.number().nullable(), hopCount: z.number().int().nonnegative().nullable()
});
```

`acceptance ACK`는 수신·검증·로컬 저장 결과만, `device status ACK`는 fixture별 `succeeded|failed|timed_out`와 실제 밝기를 포함한다. legacy topic은 mock 전용 compatibility 함수로 표시하고 운영 설정에서는 거부한다.

- [x] **Step 4: 전체 shared 검증과 커밋**

Run: `pnpm --filter @led-control/shared test && pnpm --filter @led-control/shared build`
Expected: PASS.

```bash
git add packages/shared
git commit -m "feat: define gateway scoped MQTT contracts"
```

---

### Task 3: Gateway inventory·claim·dispatch DB 모델

**Files:**
- Modify: `apps/api/prisma/schema.prisma`
- Create: `apps/api/prisma/migrations/20260711150000_add_gateway_identity_and_dispatch/migration.sql`
- Modify: `docs/database-schema.md`
- Test: `apps/api/test/domain-schema.test.ts`

**Interfaces:**
- Produces: `GatewayInventory`, `GatewayClaimAudit`, `CommandDispatch`, `CommandFixtureResult`
- Extends: `Gateway.certificateFingerprint`, `Gateway.assignmentVersion`, `Fixture.lastStateSequence`

- [x] **Step 1: schema 실패 테스트 작성**

```ts
expect(schema).toContain("model GatewayInventory");
expect(schema).toContain("claimCodeHash");
expect(schema).toContain("model CommandDispatch");
expect(schema).toContain("lastStateSequence");
```

- [x] **Step 2: 실패 확인**

Run: `pnpm --filter @led-control/api test -- domain-schema.test.ts --runInBand`
Expected: FAIL on missing models.

- [x] **Step 3: Prisma 모델과 유니크 제약 구현**

```prisma
model GatewayInventory {
  id String @id @default(uuid())
  serialNumber String @unique
  claimCodeHash String?
  certificateFingerprint String @unique
  claimedGatewayId String? @unique
  claimedAt DateTime?
  disabledAt DateTime?
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
}
```

`CommandDispatch`는 command/gateway별 sequence와 idempotencyKey를 unique로 저장하고, `CommandFixtureResult`는 fixture별 terminal result를 저장한다. 조회 경로에 `Site.organizationId`, `Floor.siteId`, `Fixture.floorId`, `Gateway.siteId` 인덱스를 추가한다.

- [x] **Step 4: format·generate·migration 검증**

Run: `pnpm --filter @led-control/api exec prisma format && pnpm --filter @led-control/api prisma:generate`
Expected: PASS.

Run: `DATABASE_URL=postgresql://led:led@localhost:5432/led_control?schema=public pnpm --filter @led-control/api exec prisma migrate deploy`
Expected: migration applied once.

- [x] **Step 5: DB 문서와 커밋**

`docs/database-schema.md`에 claim code 원문과 private key를 저장하지 않는다고 명시한다.

```bash
git add apps/api/prisma apps/api/test/domain-schema.test.ts docs/database-schema.md
git commit -m "feat: add gateway identity and dispatch schema"
```

---

### Task 4: 사용자 claim과 장치 mTLS bootstrap API

**Files:**
- Create: `apps/api/src/gateway-onboarding/gateway-onboarding.module.ts`
- Create: `apps/api/src/gateway-onboarding/gateway-onboarding.controller.ts`
- Create: `apps/api/src/gateway-onboarding/gateway-onboarding.service.ts`
- Create: `apps/api/src/gateway-onboarding/gateway-onboarding.service.spec.ts`
- Create: `apps/api/src/gateway-onboarding/device-certificate.guard.ts`
- Modify: `apps/api/src/app.module.ts`
- Modify: `apps/api/src/main.ts`
- Modify: `docs/menus/settings.md`

**Interfaces:**
- Produces: `POST /gateways/claim` for authenticated users
- Produces: `POST /gateway-bootstrap` for verified device certificates

- [x] **Step 1: 일회성 claim과 인증서 불일치 실패 테스트 작성**

```ts
await expect(service.claimGateway(user, { siteId, serialNumber, claimCode: "once" })).resolves.toMatchObject({ siteId });
await expect(service.claimGateway(user, { siteId, serialNumber, claimCode: "once" })).rejects.toThrow("claim code already used");
await expect(service.bootstrap({ serialNumber, fingerprint: "wrong" })).rejects.toThrow("device certificate mismatch");
```

- [x] **Step 2: 실패 확인**

Run: `pnpm --filter @led-control/api test -- gateway-onboarding.service.spec.ts --runInBand`
Expected: FAIL because module does not exist.

- [x] **Step 3: scrypt claim 검증과 원자적 binding 구현**

Claim transaction은 inventory가 미claim·활성 상태인지, site가 사용자 조직 소속인지, `timingSafeEqual`로 hash가 일치하는지 확인하고 Gateway를 생성·연결한 뒤 `claimCodeHash=null`, `claimedAt`을 기록한다. 성공·실패를 `GatewayClaimAudit`에 남기고 serial/IP 단위 rate limit을 적용한다.

- [x] **Step 4: peer certificate fingerprint guard 구현**

```ts
const cert = request.socket.getPeerCertificate?.();
const fingerprint = normalizeFingerprint(cert?.fingerprint256);
if (!request.socket.authorized || !fingerprint) throw new UnauthorizedException("mTLS device certificate required");
```

`NODE_ENV=test`에서만 `x-test-client-cert-fingerprint` 주입을 허용하고 production에서는 헤더를 무시한다. Bootstrap 응답은 assignment와 broker URL만 반환하며 claim code나 private key를 반환하지 않는다.

- [x] **Step 5: API 검증·문서·커밋**

Run: `pnpm --filter @led-control/api test -- gateway-onboarding --runInBand && pnpm --filter @led-control/api typecheck`
Expected: PASS.

```bash
git add apps/api/src/gateway-onboarding apps/api/src/app.module.ts apps/api/src/main.ts docs/menus/settings.md
git commit -m "feat: add secure gateway claim and bootstrap"
```

---

### Task 5: Gateway bootstrap client와 안전한 assignment 저장

**Files:**
- Create: `apps/gateway/src/config/assignment.ts`
- Create: `apps/gateway/src/config/assignment-store.ts`
- Create: `apps/gateway/src/config/assignment-store.test.ts`
- Create: `apps/gateway/src/config/bootstrap-client.ts`
- Create: `apps/gateway/src/config/bootstrap-client.test.ts`
- Modify: `apps/gateway/src/index.ts`
- Modify: `apps/gateway/.env.example`

**Interfaces:**
- Produces: `GatewayAssignment { siteId, gatewayId, serialNumber, mqttUrl, configVersion }`
- Produces: `AssignmentStore.read()` and `writeAtomic(assignment)`

- [x] **Step 1: 권한·원자성 실패 테스트 작성**

```ts
await store.writeAtomic(assignment);
expect((await stat(path)).mode & 0o777).toBe(0o600);
expect(await store.read()).toEqual(assignment);
expect(await readdir(dirname(path))).not.toContain("assignment.json.tmp");
```

- [x] **Step 2: 실패 확인 후 구현**

Run: `pnpm --filter @led-control/gateway test -- assignment-store.test.ts bootstrap-client.test.ts`
Expected before implementation: FAIL.

구현은 같은 디렉터리 임시 파일에 `mode: 0o600`으로 기록하고 `fsync` 후 rename한다. Bootstrap은 serial, client cert/key, CA만 환경변수로 받고 assignment가 없으면 지수 backoff로 대기한다.

- [x] **Step 3: `siteId/gatewayId` env 의존 제거**

`GATEWAY_SITE_ID`, `GATEWAY_ID`, `GATEWAY_TEST_MODE` 직접 assignment 우회는 모든 환경에서 금지한다. 시작 시 저장 assignment 또는 제조 credential이 없으면 명확한 오류로 종료한다.

- [x] **Step 4: 검증과 커밋**

Run: `pnpm --filter @led-control/gateway test && pnpm --filter @led-control/gateway typecheck`
Expected: PASS.

```bash
git add apps/gateway
git commit -m "feat: bootstrap gateway assignment securely"
```

---

### Task 6: MQTT 개발 PKI·mTLS·ACL

**Files:**
- Create: `infra/mosquitto.dev-tls.conf`
- Create: `infra/mosquitto.acl.example`
- Create: `scripts/dev-pki/create-ca.sh`
- Create: `scripts/dev-pki/issue-gateway-cert.sh`
- Create: `scripts/dev-pki/revoke-gateway-cert.sh`
- Modify: `.gitignore`
- Modify: `docker-compose.yml`
- Modify: `apps/gateway/src/mqtt/create-mqtt-client.ts`
- Create: `apps/gateway/src/mqtt/create-mqtt-client.test.ts`
- Modify: `apps/api/src/mqtt/mqtt.service.ts`
- Modify: `apps/gateway/README.md`

**Interfaces:**
- Produces: TLS listener 8883 with `require_certificate true`
- Produces: certificate CN/fingerprint to gateway-scoped ACL mapping

- [x] **Step 1: 보안 설정 정적 테스트 작성**

```ts
expect(mosquittoConfig).toContain("allow_anonymous false");
expect(mosquittoConfig).toContain("require_certificate true");
expect(gitignore).toContain(".local/pki/");
```

- [x] **Step 2: 개발 PKI와 Mosquitto profile 구현**

인증서 출력은 `.local/pki`로 고정하고 스크립트는 `umask 077`을 설정한다. 저장소에는 config와 예시 ACL만 남긴다.

```conf
listener 8883
allow_anonymous false
cafile /mosquitto/certs/ca.crt
certfile /mosquitto/certs/broker.crt
keyfile /mosquitto/certs/broker.key
require_certificate true
use_identity_as_username true
acl_file /mosquitto/config/mosquitto.acl
```

- [x] **Step 3: API/gateway TLS option 구현**

환경과 관계없이 `mqtt://`, CA 누락, client cert/key 누락은 시작 실패한다. 로컬도 개발용 CA와 client certificate를 사용한다.

- [x] **Step 4: 인증 부정 시험**

Run: `mosquitto_pub -h localhost -p 8883 -t test -m denied`
Expected: TLS/authentication failure.

Run with gateway certificate and another gateway topic.
Expected: ACL authorization failure.

- [x] **Step 5: 검증·커밋**

Run: `pnpm --filter @led-control/gateway test && pnpm --filter @led-control/api test -- mqtt.service.spec.ts --runInBand && git diff --check`
Expected: PASS.

```bash
git add infra scripts/dev-pki .gitignore docker-compose.yml apps/gateway apps/api/src/mqtt
git commit -m "feat: secure MQTT with mutual TLS"
```

---

### Task 7: Gateway별 command fan-out·outbox·ACK

**Files:**
- Create: `apps/api/src/commands/command-dispatch.service.ts`
- Create: `apps/api/src/commands/command-dispatch.service.spec.ts`
- Modify: `apps/api/src/commands/commands.service.ts`
- Modify: `apps/api/src/mqtt/mqtt.service.ts`
- Modify: `apps/gateway/src/gateway.ts`
- Modify: `apps/gateway/src/gateway.test.ts`
- Modify: `docs/menus/control.md`

**Interfaces:**
- Produces: one `CommandDispatch` per gateway
- Consumes: acceptance/device-status ACK v2

- [x] **Step 1: 두 gateway 그룹 분할 실패 테스트 작성**

```ts
const dispatches = await service.createDispatches(command, [
  { fixtureId: "f1", gatewayId: "g1" }, { fixtureId: "f2", gatewayId: "g2" }
]);
expect(dispatches).toHaveLength(2);
expect(dispatches.map((item) => item.gatewayId)).toEqual(["g1", "g2"]);
```

- [x] **Step 2: transactional outbox 구현**

Command와 dispatch/outbox를 같은 DB transaction에서 생성한다. Publisher는 미발행 outbox를 재시도하고 `idempotencyKey`와 gateway sequence를 payload에 포함한다.

- [x] **Step 3: gateway 멱등성 저장과 두 단계 ACK 구현**

Gateway는 명령을 로컬 저장한 뒤 acceptance ACK를 보내고, 실제 adapter 결과 후 fixture별 device-status ACK를 보낸다. 중복 key에는 저장된 terminal result를 재발행하며 다시 제어하지 않는다.

- [x] **Step 4: 검증·문서·커밋**

Run: `pnpm --filter @led-control/api test -- commands command-dispatch mqtt --runInBand`
Run: `pnpm --filter @led-control/gateway test`
Expected: PASS including partial timeout.

```bash
git add apps/api/src/commands apps/api/src/mqtt apps/gateway/src docs/menus/control.md
git commit -m "feat: dispatch commands per gateway"
```

---

### Task 8: MQTT scope 검증·stale event 차단·offline TTL

**Files:**
- Create: `apps/api/src/mqtt/topic-scope.ts`
- Create: `apps/api/src/mqtt/topic-scope.spec.ts`
- Modify: `apps/api/src/mqtt/mqtt.service.ts`
- Create: `apps/api/src/fixtures/fixture-freshness.service.ts`
- Create: `apps/api/src/fixtures/fixture-freshness.service.spec.ts`
- Modify: `apps/api/src/sites/sites.service.ts`
- Modify: `docs/menus/monitoring.md`

**Interfaces:**
- Produces: `parseGatewayTopic(topic)` and `assertGatewayScope(scope, payload)`
- Produces: `markStaleFixtures(now)` with gateway TTL 90s, fixture TTL 120s

- [x] **Step 1: tenant 위조·중복·역전 테스트 작성**

```ts
await service.handleMessage(topicForSiteA, stateForSiteB);
expect(prisma.fixture.updateMany).not.toHaveBeenCalled();
await service.handleMessage(validTopic, { ...state, sequence: 9 });
await service.handleMessage(validTopic, { ...state, sequence: 8 });
expect(lastStoredSequence).toBe(9);
```

- [x] **Step 2: topic와 DB 관계 검증 구현**

Fixture, command, gateway가 topic의 site/gateway에 모두 속할 때만 update한다. `eventId` unique 충돌은 성공한 중복 처리로 간주하고 낮은 sequence는 폐기한다.

- [x] **Step 3: TTL와 startup resync 처리**

90초 heartbeat 만료 시 gateway와 연결된 fixture를 `offline`+`gateway_offline`으로 표시한다. 120초 fixture state 만료는 해당 fixture만 `offline`+`fixture_stale`로 표시한다. Startup resync 이벤트는 같은 sequence 검증을 통과해야 한다.

- [x] **Step 4: 검증·문서·커밋**

Run: `pnpm --filter @led-control/api test -- mqtt fixture-freshness sites --runInBand && pnpm --filter @led-control/api typecheck`
Expected: PASS.

```bash
git add apps/api/src/mqtt apps/api/src/fixtures apps/api/src/sites docs/menus/monitoring.md
git commit -m "feat: validate gateway state scope and freshness"
```

---

### Task 9: 실제 BlueZ Mesh adapter

**Precondition:** Task 1의 Raspberry Pi Phase 0 결과가 모두 `passed`여야 한다. 실패하면 동일 interface로 `EspProvisionerBridgeAdapter` 계획을 이 Task에 대체 기록한다.

**Files:**
- Create: `apps/gateway/src/mesh/bluez-mesh-adapter.ts`
- Create: `apps/gateway/src/mesh/bluez-mesh-adapter.test.ts`
- Create: `apps/gateway/src/mesh/bluez-model-codec.ts`
- Create: `apps/gateway/src/mesh/bluez-model-codec.test.ts`
- Modify: `apps/gateway/src/gateway.ts`
- Modify: `apps/gateway/src/index.ts`
- Modify: `apps/gateway/README.md`

**Interfaces:**
- Implements: `BleMeshAdapter`, `ProvisioningScannerAdapter`, `ProvisioningAdapter`
- Produces: Lightness/OnOff/Health status callbacks

- [ ] **Step 1: opcode codec와 timeout 실패 테스트 작성**

```ts
expect(encodeLightnessSet({ lightness: 32768, tid: 7 })).toEqual(Buffer.from([0x82, 0x4c, 0x00, 0x80, 0x07]));
await expect(adapter.setBrightness([fixtureId], 50)).rejects.toMatchObject({ code: "MESH_STATUS_TIMEOUT" });
```

- [ ] **Step 2: scan/provision/configure state machine 구현**

순서는 `UnprovisionedScan → AddNode → AppKey add → model bind → group subscription → publication`으로 고정한다. 각 단계는 timeout과 BlueZ 오류 코드를 provisioning progress 이벤트로 변환한다.

- [ ] **Step 3: 개별·그룹 제어와 status callback 구현**

Lightness Set acknowledged 메시지를 사용하고 Status payload의 source unicast와 TID/sequence를 fixture에 매핑한다. Health fault는 fixture `faultCode`로 변환한다.

- [x] **Step 4: 운영 stub 차단**

`NODE_ENV=production` 또는 `GATEWAY_MODE=production`에서 stub/command adapter 선택 시 시작을 거부한다.

- [ ] **Step 5: Raspberry Pi 실기 검증과 커밋**

Run without hardware: `pnpm --filter @led-control/gateway test && pnpm --filter @led-control/gateway typecheck`
Expected: fake D-Bus tests PASS.

Run on Raspberry Pi: `pnpm --filter @led-control/gateway exec tsx scripts/bluez-capability-probe.ts --full`
Expected: two nodes provisioned and model round trip PASS.

```bash
git add apps/gateway
git commit -m "feat: connect gateway to BlueZ Mesh"
```

---

### Task 10: ESP32-H2 양산 기반 펌웨어

**Files:**
- Create: `apps/esp32-h2-firmware/main/persistent_state.c`
- Create: `apps/esp32-h2-firmware/main/persistent_state.h`
- Create: `apps/esp32-h2-firmware/main/identify.c`
- Create: `apps/esp32-h2-firmware/main/identify.h`
- Create: `apps/esp32-h2-firmware/main/factory_reset.c`
- Create: `apps/esp32-h2-firmware/main/factory_reset.h`
- Modify: `apps/esp32-h2-firmware/main/mesh_state.c`
- Modify: `apps/esp32-h2-firmware/main/ble_mesh_node.c`
- Modify: `apps/esp32-h2-firmware/main/app_main.c`
- Modify: `apps/esp32-h2-firmware/main/CMakeLists.txt`
- Modify: `apps/esp32-h2-firmware/test/control_state_test.c`
- Modify: `apps/esp32-h2-firmware/README.md`

**Interfaces:**
- Produces: persisted `{ brightness, previousBrightness, lastCommandSequence }`
- Produces: identify pattern, physical factory reset, reset reason and Health fault report

- [x] **Step 1: host C 실패 테스트 작성**

```c
assert(mesh_state_apply_onoff(&state, 0) == 0);
assert(state.previous_brightness_percent == 30);
assert(mesh_state_apply_onoff(&state, 1) == 30);
assert(command_sequence_accept(&state, 10));
assert(!command_sequence_accept(&state, 9));
```

- [ ] **Step 2: 이전 밝기·sequence·transition 구현**

NVS write는 밝기 변경마다 하지 않고 debounce된 commit으로 flash wear를 제한한다. Transition 완료 후 Status를 발행하고 중복·낮은 sequence를 적용하지 않는다.

- [x] **Step 3: identify·Health·factory reset·watchdog 구현**

Health Attention callback은 실제 PWM 점멸을 시작/종료한다. Factory reset 물리 입력은 길게 누르기 8초로 고정하고 mesh credential과 앱 NVS를 삭제한다. Task watchdog과 reset reason을 초기 상태 report에 포함한다.

- [x] **Step 4: host·ESP-IDF 빌드 검증**

Run: `scripts/esp32-h2-build.sh`
Expected: ESP-IDF v5.5.1 `esp32h2` build PASS and partition free space reported.

- [ ] **Step 5: 실제 보드 시험과 커밋**

두 보드에서 identify, transition, 전원 재인가 밝기 복원, 8초 reset 후 unprovisioned beacon을 확인한다.

```bash
git add apps/esp32-h2-firmware scripts/esp32-h2-build.sh scripts/esp32-h2-flash.sh
git commit -m "feat: harden ESP32-H2 mesh firmware"
```

---

### Task 11: 2-node HIL/E2E harness

**Files:**
- Create: `apps/gateway/scripts/hil-2node-test.ts`
- Create: `apps/gateway/scripts/hil-2node-test.test.ts`
- Create: `docs/runbooks/production-device-lab.md`
- Modify: `package.json`

**Interfaces:**
- Produces: `pnpm gateway:hil:2node`
- Produces: machine-readable result JSON with each security and recovery gate

- [x] **Step 1: deterministic scenario runner 실패 테스트 작성**

```ts
expect(result.steps.map((step) => step.name)).toEqual([
  "claim", "bootstrap", "secure-mqtt", "scan", "provision", "bind",
  "individual-control", "group-control", "stale-event", "offline", "restart-recovery", "acl-negative"
]);
```

- [x] **Step 2: HIL runner 구현**

Runner는 serial/port/certificate 경로를 환경변수로 받고 secret은 출력하지 않는다. 각 단계의 commandId, fixtureId, 실제 Status, 지연시간을 JSON으로 남긴다.

- [ ] **Step 3: 장애·보안 부정 시나리오 구현**

Runner의 단계·timeout·JSON 판정 계약은 구현했다. 실제 MQTT 단절, node timeout, daemon/node 재부팅을 수행하는 Raspberry Pi용 단계 실행 파일은 BlueZ Phase 0 이후 구현한다.

중복 command, 역전 sequence, 한 노드 timeout, MQTT 단절, gateway/mesh daemon/노드 재부팅, 무인증 접속, 다른 gateway topic 접근을 실행한다.

- [ ] **Step 4: 3회 연속 실기 통과**

Run: `pnpm gateway:hil:2node -- --repeat 3`
Expected: all three runs PASS with no manual DB edits or reprovisioning between runs.

- [x] **Step 5: 커밋**

```bash
git add apps/gateway/scripts docs/runbooks package.json
git commit -m "test: add two node production HIL flow"
```

---

### Task 12: 문서·운영 상태·최종 검증

**Files:**
- Modify: `docs/menus/monitoring.md`
- Modify: `docs/menus/control.md`
- Modify: `docs/menus/settings.md`
- Modify: `docs/database-schema.md`
- Modify: `docs/lesson_leared.md`
- Modify: `docs/superpowers/plans/2026-07-11-production-device-foundation.md`
- Modify: `README.md`

**Interfaces:**
- Produces: 실제 구현/테스트 전용/미구현 상태가 코드와 일치하는 최종 문서

- [x] **Step 1: 기능 상태 문서 갱신**

BlueZ 실기 검증 전 항목은 `구현 완료`가 아니라 `코드 완료·실기 미검증`으로 기록한다. Stub, command adapter, 개발 인증서는 테스트 전용으로 명시한다.

- [x] **Step 2: 반복 가능한 교훈 기록**

`docs/lesson_leared.md`에 topic scope 검증, claim 원문 금지, ACK 의미 분리, hardware validation level을 기록한다.

- [x] **Step 3: 전체 자동 검증**

Run:

```bash
pnpm test
pnpm typecheck
pnpm --filter @led-control/web exec playwright test e2e/mvp1.spec.ts
scripts/esp32-h2-build.sh
git diff --check
```

Expected: all automated checks PASS.

- [ ] **Step 4: 실기 검증 증거 확인**

`pnpm gateway:hil:2node -- --repeat 3`의 3회 결과와 Raspberry Pi systemd/journald 로그가 없으면 양산형 장비 기반을 완료로 표시하지 않는다.

- [x] **Step 5: 최종 커밋**

```bash
git add README.md docs
git commit -m "docs: complete production device foundation runbook"
```

---

## 완료 판정

- `자동 검증 완료`: 단위·계약·타입·ESP-IDF 빌드가 모두 통과했다.
- `Raspberry Pi 검증 완료`: BlueZ Phase 0 probe가 내장 BLE에서 통과했다.
- `2-node 실기 완료`: HIL 전체 시나리오가 수동 DB 수정 없이 3회 연속 통과했다.
- 세 등급 중 하나라도 빠지면 프로젝트 문서에 `양산 준비 완료`라고 기록하지 않는다.

---

## 양산 단일 기준 후속 구현

### Task 13: Gateway 양산 adapter 경계와 실행 차단

**Files:**
- Create: `apps/gateway/src/adapters/adapter-factory.ts`
- Create: `apps/gateway/src/adapters/adapter-factory.test.ts`
- Modify: `apps/gateway/src/index.ts`
- Modify: `apps/gateway/src/gateway.ts`
- Modify: `apps/gateway/.env.example`
- Modify: `apps/gateway/README.md`

**Interfaces:**
- Produces: `createProductionAdapters(env): GatewayAdapters`
- Produces: capability가 확인된 실제 adapter 외에는 시작 실패

- [x] **Step 1: gateway 본체에서 stub 선택이 불가능한 실패 테스트 작성**
- [x] **Step 2: 테스트가 현재 stub 생성 때문에 실패하는지 확인**
- [x] **Step 3: adapter factory를 추가하고 `index.ts`의 직접 stub 생성을 제거**
- [x] **Step 4: 실제 adapter 미구현 상태에서는 MQTT 연결 전 `PRODUCTION_ADAPTER_UNAVAILABLE`로 종료**
- [x] **Step 5: mock은 `apps/mock-gateway`와 test dependency injection에만 남았는지 정적 검사**
- [x] **Step 6: gateway 테스트/typecheck/문서 갱신/커밋**

### Task 14: 명령 timeout과 최신 snapshot journal

**Files:**
- Modify: `apps/gateway/src/commands/gateway-command-handler.ts`
- Modify: `apps/gateway/src/commands/gateway-command-handler.test.ts`
- Replace: `apps/gateway/src/commands/command-journal.ts`
- Modify: `apps/gateway/src/commands/command-journal.test.ts`
- Modify: `apps/gateway/src/index.ts`
- Modify: `packages/shared/src/gateway-contracts.ts`

**Interfaces:**
- Produces: fixture status 제한 기본 8초
- Produces: `indeterminate` recovery result
- Produces: idempotency TTL 24시간/최대 10,000건과 fixture latest snapshot 1건

- [x] **Step 1: adapter가 영원히 대기할 때 8초 후 timed-out 결과가 생성되는 fake-clock 테스트**
- [x] **Step 2: accepted-only 재시작 명령이 재제어되지 않고 indeterminate로 닫히는 테스트**
- [x] **Step 3: journal prune와 fixture별 latest snapshot 테스트**
- [x] **Step 4: timeout/recovery/prune 구현**
- [x] **Step 5: startup resync가 최신 snapshot만 현재 시각·새 sequence로 발행하도록 변경**
- [x] **Step 6: gateway/shared 검증과 커밋**

### Task 15: Outbox lease, backoff, dead-letter와 dispatch timeout

**Files:**
- Modify: `apps/api/prisma/schema.prisma`
- Create: `apps/api/prisma/migrations/*_harden_mqtt_outbox/migration.sql`
- Create: `apps/api/src/mqtt/outbox-publisher.service.ts`
- Create: `apps/api/src/mqtt/outbox-publisher.service.spec.ts`
- Create: `apps/api/src/commands/command-timeout.service.ts`
- Create: `apps/api/src/commands/command-timeout.service.spec.ts`
- Modify: `apps/api/src/mqtt/mqtt.module.ts`
- Modify: `apps/api/src/mqtt/mqtt.service.ts`

**Interfaces:**
- Produces: `claimBatch(workerId, now)` lease ownership
- Produces: 최대 10회/15분 dead-letter
- Produces: acceptance 10초, dispatch 30초 timeout 집계

- [x] **Step 1: publisher 두 개가 같은 row를 동시에 소유하지 않는 DB 계약 테스트**
- [x] **Step 2: 지수 backoff, lease 만료 회수, 최대 시도 dead-letter 실패 테스트**
- [x] **Step 3: schema/migration과 atomic claim 구현**
- [x] **Step 4: publish 성공/실패와 lease owner 조건부 update 구현**
- [x] **Step 5: pending/published/accepted dispatch timeout worker 구현**
- [x] **Step 6: migration 적용, API 전체 검증, DB 문서 갱신, 커밋**

### Task 16: Fixture gateway 범위와 제어 가능 상태 API

**Files:**
- Modify: `apps/api/src/sites/sites.service.ts`
- Modify: `apps/api/src/sites/sites.service.spec.ts`
- Modify: `apps/api/src/commands/commands.service.ts`
- Modify: `apps/api/src/commands/commands.service.spec.ts`
- Modify: `apps/web/src/api/queries.ts`
- Modify: `apps/web/src/features/monitoring/MonitoringView.tsx`
- Modify: `apps/web/src/features/control/ControlView.tsx`
- Modify: `apps/web/src/App.test.tsx`

**Interfaces:**
- Produces: fixture별 gateway ID/name/connection status
- Produces: `controllable`과 `controlBlockReason`

- [x] **Step 1: 다중 gateway에서 선택 fixture의 gateway가 표시되는 실패 테스트**
- [x] **Step 2: offline/fault/mapping 없음/group 일부 불가가 명령 생성 전에 거부되는 API 테스트**
- [x] **Step 3: dashboard query와 command validation 구현**
- [x] **Step 4: UI 비활성화와 한국어 차단 사유 표시**
- [x] **Step 5: API/Web 테스트, 메뉴 문서 갱신, 커밋**

### Task 17: Command 진행 상태 API와 제어 결과 UI

**Files:**
- Modify: `apps/api/src/commands/commands.controller.ts`
- Modify: `apps/api/src/commands/commands.service.ts`
- Create: `apps/api/src/commands/command-status.service.ts`
- Create: `apps/api/src/commands/command-status.service.spec.ts`
- Create: `apps/web/src/api/commands.ts`
- Modify: `apps/web/src/features/control/ControlView.tsx`
- Modify: `apps/web/src/App.test.tsx`

**Interfaces:**
- Produces: `GET /commands/:commandId`
- Produces: command/dispatch/fixture result 단계 표시

- [x] **Step 1: 다른 조직 command 조회 거부와 fixture별 결과 응답 테스트**
- [x] **Step 2: status service/controller 구현**
- [x] **Step 3: command 생성 응답에 dispatch 수 포함**
- [x] **Step 4: UI에서 접수/수신/적용/부분 실패/timeout polling 표시**
- [x] **Step 5: API/Web/E2E 검증과 커밋**

### Task 18: 1,000 fixture 조회와 렌더링 성능 기반

**Files:**
- Create: `apps/api/src/fixtures/fixtures.controller.ts`
- Create: `apps/api/src/fixtures/fixtures.service.ts`
- Create: `apps/api/src/fixtures/fixtures.service.spec.ts`
- Modify: `apps/api/src/app.module.ts`
- Modify: `apps/web/src/api/queries.ts`
- Modify: `apps/web/src/features/monitoring/FloorMap.tsx`
- Create: `apps/web/e2e/monitoring-1000.spec.ts`

**Interfaces:**
- Produces: 층 metadata와 cursor 기반 fixture snapshot 분리 조회
- Produces: 1,000 fixture deterministic seed/performance test

- [x] **Step 1: cursor/tenant 범위 fixture API 실패 테스트**
- [x] **Step 2: paginated snapshot API 구현**
- [x] **Step 3: Web query를 층 선택 기반 조회로 분리**
- [x] **Step 4: viewport marker 렌더링과 1,000 fixture E2E 작성**
- [x] **Step 5: API p95 1초와 브라우저 메모리/렌더 기준 측정 스크립트 추가**
- [x] **Step 6: 전체 검증, 모니터링 문서 갱신, 커밋**

### Task 19: Object Storage 도면 업로드

**Files:**
- Create: `apps/api/src/storage/object-storage.service.ts`
- Create: `apps/api/src/storage/object-storage.service.spec.ts`
- Create: `apps/api/src/floor-editor/floor-assets.controller.ts`
- Modify: `apps/api/src/floor-editor/floor-editor.module.ts`
- Modify: `apps/api/src/floor-editor/floor-editor.service.ts`
- Modify: `apps/web/src/features/floor-editor/FloorAssetUploader.tsx`
- Modify: `docker-compose.yml`
- Modify: `.env.example`

**Interfaces:**
- Produces: S3-compatible signed upload/complete flow
- Removes: data URL floor plan persistence

- [x] **Step 1: data URL 거부, MIME/size/checksum 검증 실패 테스트**
- [x] **Step 2: S3-compatible storage와 signed upload 구현**
- [x] **Step 3: DB에 object metadata만 저장하도록 editor API 변경**
- [x] **Step 4: Web direct upload와 PDF render object upload 구현**
- [ ] **Step 5: 로컬 S3 호환 integration/E2E, 문서, 커밋**

### Task 20: 실제 adapter·HIL·soak 완료 게이트

**Files:**
- Modify: `apps/gateway/src/mesh/*`
- Modify: `apps/gateway/scripts/hil-2node-test.ts`
- Create: `apps/gateway/scripts/soak-test.ts`
- Modify: `docs/runbooks/production-device-lab.md`
- Modify: `docs/menus/monitoring.md`
- Modify: `docs/menus/control.md`

- [ ] **Step 1: Raspberry Pi Phase 0 여섯 항목 통과 증거 기록**
- [ ] **Step 2: 선택된 실제 adapter의 scan/provision/bind/status 구현**
- [ ] **Step 3: 실장비 HIL step executor 구현**
- [ ] **Step 4: 2-node 전체 시나리오 3회 연속 실행**
- [ ] **Step 5: 72시간 soak와 주차장 RF walk test 실행**
- [ ] **Step 6: 완료 수준 문서 갱신과 최종 커밋**

### Task 21: 양산 보안 우회 제거

- [x] `NODE_ENV=test` client certificate header 우회 제거
- [x] API/gateway의 `MQTT_ALLOW_INSECURE_LOCAL` 평문 MQTT 우회 제거
- [x] `GATEWAY_TEST_MODE`, 직접 site/gateway ID assignment 우회 제거
- [x] gateway runtime stub를 `apps/gateway/test` 전용 helper로 이동
- [x] gateway smoke test를 mTLS 및 gateway-scoped v2 ACK 계약으로 변경

### Task 22: 테스트 전용 런타임 제거와 실장비 E2E 경로 단일화

**목표:** 현장 등록, 실제 BLE Mesh 검색/등록, 모니터링, 수동 제어가 하나의 양산 경로만 사용하도록 mock·demo·legacy 우회를 제거한다.

**유지 예외:** 사용자가 명시적으로 제외한 로그인 폼의 데모 이메일, 비밀번호, 초대 코드 기본 입력값은 이번 작업에서 변경하지 않는다.

- [x] **Step 1: 웹 mock API와 `VITE_USE_MOCK_API` 제거, UI 테스트 데이터는 `src/test`로 격리**
- [x] **Step 2: `apps/mock-gateway`, `dev:mock`, `MOCK_*`, shared demo ID 제거**
- [x] **Step 3: 파괴적 demo seed를 삭제하고 빈 DB 전용 owner bootstrap 명령으로 교체**
- [x] **Step 4: `DEV_GATEWAY_ID` 누락 시 mock identity fallback 없이 API/Web 온보딩 모드만 시작**
- [x] **Step 5: MQTT v1 dimming/state/ack/heartbeat와 미사용 shell command adapter 제거**
- [x] **Step 6: 고정 통계 인사이트, 비기능 설정/RF/알림/스케줄 UI 제거**
- [x] **Step 7: 에너지 예상치를 로그인 사용자 조직 현장으로 제한하고 실제 계산값 비율로 차트 표시**
- [x] **Step 8: 메뉴 문서에 유지 중인 개발·시험 자산과 제거 조건 기록**
- [x] **Step 9: 전체 테스트, 타입 검사, 웹 빌드, ESP-IDF 빌드, 실장비 E2E 준비 상태 검증**

## 진행 로그

- 2026-07-11: 설계 승인 및 구현 계획 작성. 구현은 Task 1부터 순서대로 진행한다.
- 2026-07-11: Task 1의 D-Bus transport, capability report, Mac/Raspberry Pi 판정 probe를 구현하고 gateway 테스트 11개와 typecheck를 통과했다. `dbus-next`는 선택 의존성 취약점 때문에 `@homebridge/dbus-native`로 교체했다. Raspberry Pi 실기 Phase 0은 미완료다.
- 2026-07-11: Task 2의 gateway-scoped MQTT v2 topic과 dimming, acceptance ACK, device status ACK, fixture state, heartbeat schema를 추가했다. legacy MVP1 topic은 기존 소비자를 깨지 않도록 유지했으며 shared 테스트 8개와 build를 통과했다.
- 2026-07-11: Task 3의 제조 gateway inventory, claim audit, gateway별 command dispatch, fixture 결과, MQTT outbox, 처리 이벤트 원장과 sequence/freshness 필드를 추가했다. migration을 로컬 PostgreSQL에 적용하고 DB 문서를 갱신했다.
- 2026-07-11: Task 4~8의 secure claim/bootstrap, assignment 저장, MQTT mTLS/ACL/CRL, gateway별 outbox dispatch, 두 단계 ACK, tenant scope와 offline TTL을 구현하고 자동 테스트를 통과했다.
- 2026-07-11: Task 9는 Raspberry Pi BlueZ Phase 0 미완료로 보류했다. 하드웨어 결과 없이 실제 adapter 완료로 표시하지 않는다.
- 2026-07-11: Task 10의 host 상태 테스트, NVS debounce 복원, identify, reset fault, watchdog, 8초 factory reset을 구현해 ESP-IDF build를 통과했다. transition과 두 보드 실기는 미완료다.
- 2026-07-11: Task 11의 deterministic HIL runner와 한글 runbook을 추가했다. 실제 장애 명령과 3회 연속 HIL은 Raspberry Pi/두 node에서 실행해야 한다.
- 2026-07-11: Task 12 자동 검증에서 전체 workspace 테스트, typecheck, Chromium MVP E2E, ESP32-H2 clean build가 통과했다. Raspberry Pi Phase 0과 2-node HIL 3회 증거는 아직 없어 양산 준비 완료로 표시하지 않는다.
- 2026-07-12: Task 19의 signed upload, FloorAsset lifecycle, ready URL 강제, Web direct upload를 구현했다. 로컬 PostgreSQL migration은 적용했으나 현재 머신에 Docker CLI가 없어 MinIO integration 실행은 보류했다.
- 2026-07-12: BlueZ 공식 Mesh API 기준 Lightness/OnOff codec과 72시간 soak runner를 구현했다. macOS capability probe는 여섯 항목 모두 `hardware_required`로 exit 2였으며, D-Bus application callback export와 fixture-unicast mapping이 없어 실제 adapter factory 연결은 보류했다.
- 2026-07-14: Task 22 Step 1~8을 완료했다. 런타임 mock/demo/legacy MQTT 경로와 수동 Gateway 생성 우회를 제거하고, 현장 생성 후 제조 원장 기반 claim UI 및 비파괴 inventory 적재 명령으로 양산 온보딩 경로를 연결했다. 전체 자동 검증과 ESP-IDF build는 통과했으며 Raspberry Pi/ESP32-H2 연속 실기 검증은 남아 있다.
- 2026-07-14: Task 22 Step 9 검증에서 전체 workspace 테스트, typecheck, Web production build, ESP32-H2 build, 실제 DB 로그인/빈 dashboard/인증 경계가 통과했다. 과거 mock gateway DB 행과 빈 검색 세션을 제거했다. Mac에 ESP32 serial port가 없고 `dfkorea.local`이 해석되지 않아 Raspberry Pi/두 node HIL은 Task 20의 미완료 상태를 유지한다.

### Task 23: Gateway PKI 도메인과 인증서 원장

**Files:**
- Modify: `apps/api/prisma/schema.prisma`
- Create: `apps/api/prisma/migrations/*_add_gateway_pki_lifecycle/migration.sql`
- Create: `apps/api/src/pki/pki.types.ts`
- Modify: `apps/api/test/domain-schema.test.ts`
- Modify: `docs/database-schema.md`

**Interfaces:**
- Produces: `CertificatePurpose = "device" | "mqtt"`
- Produces: `GatewayCertificate`, `GatewayEnrollment` persistence
- Constraint: certificate PEM, private key, token 원문, Claim Code 원문은 DB에 저장하지 않음

- [ ] **Step 1: schema 계약 실패 테스트 작성**

```ts
expect(schema).toContain("model GatewayCertificate");
expect(schema).toContain("certificateSerial");
expect(schema).toContain("fingerprint");
expect(schema).toContain("model GatewayEnrollment");
expect(schema).toContain("tokenHash");
expect(schema).not.toContain("privateKey String");
```

- [ ] **Step 2: API schema 테스트가 모델 누락으로 실패하는지 확인**

Run: `pnpm --filter @led-control/api test -- --runInBand test/domain-schema.test.ts`
Expected: `GatewayCertificate` 또는 `GatewayEnrollment` 누락으로 FAIL

- [ ] **Step 3: Prisma 모델과 migration 작성**

```prisma
model GatewayEnrollment {
  id              String   @id @default(uuid())
  serialNumber    String
  tokenHash       String
  expiresAt       DateTime
  usedAt          DateTime?
  stationIdentity String
  outcome         String?
  failureReason   String?
  createdAt       DateTime @default(now())
  @@index([serialNumber, createdAt])
}

model GatewayCertificate {
  id                String   @id @default(uuid())
  inventoryId       String
  gatewayId         String?
  purpose           String
  certificateSerial String
  fingerprint       String   @unique
  issuer            String
  notBefore         DateTime
  notAfter          DateTime
  status            String
  revokedAt         DateTime?
  replacedById      String?
  createdAt         DateTime @default(now())
  updatedAt         DateTime @updatedAt
  @@index([inventoryId, purpose, status])
  @@index([gatewayId, purpose, status])
}
```

- [ ] **Step 4: migration과 Prisma client 생성 후 schema 테스트 통과 확인**

Run: `pnpm --filter @led-control/api prisma:generate && pnpm --filter @led-control/api test -- --runInBand test/domain-schema.test.ts`
Expected: PASS

- [ ] **Step 5: `docs/database-schema.md`에 원문 비밀정보 금지와 관계·인덱스 갱신**

- [ ] **Step 6: Task 23 변경만 검토 후 커밋**

### Task 24: CA Provider 경계와 Vault PKI 구현

**Files:**
- Create: `apps/api/src/pki/certificate-authority.provider.ts`
- Create: `apps/api/src/pki/vault-pki.provider.ts`
- Create: `apps/api/src/pki/vault-pki.provider.spec.ts`
- Create: `apps/api/src/pki/pki.module.ts`
- Modify: `apps/api/src/app.module.ts`
- Modify: `apps/api/package.json`
- Modify: `.env.example`

**Interfaces:**
- Produces: `CertificateAuthorityProvider.signCsr(input): Promise<SignedCertificate>`
- Produces: `CertificateAuthorityProvider.revoke(input): Promise<void>`
- Constraint: production에서 local/OpenSSL signer 선택 시 시작 실패

- [ ] **Step 1: provider 계약과 Vault 요청 실패 테스트 작성**

```ts
export interface SignCsrInput {
  purpose: "device" | "mqtt";
  csrPem: string;
  commonName: string;
  uriSans: string[];
  ttlSeconds: number;
}

export interface SignedCertificate {
  certificatePem: string;
  caChainPem: string[];
  certificateSerial: string;
  fingerprint: string;
  issuer: string;
  notBefore: string;
  notAfter: string;
}
```

- [ ] **Step 2: 테스트가 provider 미구현으로 실패하는지 확인**

Run: `pnpm --filter @led-control/api test -- --runInBand src/pki/vault-pki.provider.spec.ts`
Expected: module 또는 class 누락으로 FAIL

- [ ] **Step 3: HTTPS Vault client와 역할별 sign/revoke 구현**

Device는 `VAULT_PKI_DEVICE_MOUNT`/`VAULT_PKI_DEVICE_ROLE`, MQTT는 `VAULT_PKI_MQTT_MOUNT`/`VAULT_PKI_MQTT_ROLE`만 사용한다. Vault token은 `VAULT_TOKEN_FILE`에서 읽고 요청·오류 로그에서 제거한다.

- [ ] **Step 4: `NODE_ENV=production` fail-closed 설정 검증**

```ts
if (env.NODE_ENV === "production" && env.PKI_PROVIDER !== "vault") {
  throw new Error("PKI_PROVIDER=vault is required in production");
}
```

- [ ] **Step 5: provider 단위 테스트와 API typecheck 통과 확인**

Run: `pnpm --filter @led-control/api test -- --runInBand src/pki/vault-pki.provider.spec.ts && pnpm --filter @led-control/api typecheck`
Expected: PASS

- [ ] **Step 6: Task 24 변경만 검토 후 커밋**

### Task 25: 제조 Enrollment 발급 API와 1회용 비밀정보

**Files:**
- Create: `apps/api/src/pki/manufacturing-auth.guard.ts`
- Create: `apps/api/src/pki/manufacturing-enrollment.controller.ts`
- Create: `apps/api/src/pki/manufacturing-enrollment.service.ts`
- Create: `apps/api/src/pki/manufacturing-enrollment.service.spec.ts`
- Modify: `apps/api/src/pki/pki.module.ts`
- Deprecate: `apps/api/prisma/enroll-gateway-inventory.ts`

**Interfaces:**
- Produces: `POST /manufacturing/gateway-enrollments`
- Produces: `POST /gateway-manufacturing/enroll`
- Produces: 15분 TTL enrollment token과 1회 표시 Claim Code

- [ ] **Step 1: token 재사용, 만료, serial 불일치, CSR key 부적합 실패 테스트 작성**

```ts
await expect(service.enrollDevice({ serialNumber, token, csrPem })).resolves.toMatchObject({
  deviceCertificatePem: expect.stringContaining("BEGIN CERTIFICATE"),
  apiCaBundlePem: expect.any(String),
  mqttCaBundlePem: expect.any(String)
});
await expect(service.enrollDevice({ serialNumber, token, csrPem })).rejects.toThrow("enrollment token is not active");
```

- [ ] **Step 2: 관련 테스트가 서비스 누락으로 실패하는지 확인**

Run: `pnpm --filter @led-control/api test -- --runInBand src/pki/manufacturing-enrollment.service.spec.ts`
Expected: FAIL

- [ ] **Step 3: 제조 station mTLS guard와 enrollment 생성 구현**

제조 endpoint는 일반 Web session을 받지 않고 별도 manufacturing client CA로 검증된 certificate subject만 허용한다. token과 Claim Code는 256-bit CSPRNG로 생성하고 scrypt hash만 저장한다.

- [ ] **Step 4: CSR proof-of-possession, ECDSA P-256, 서버 고정 CN/SAN 검증 구현**

CSR이 요청한 subject를 그대로 서명하지 않고 `CN=<serial>`, `URI:urn:dfkorea:gateway:<serial>`을 API가 Vault 요청에 지정한다.

- [ ] **Step 5: 인증서 metadata와 inventory를 transaction으로 기록하고 token 폐기**

- [ ] **Step 6: Claim Code 원문이 로그·DB·두 번째 응답에 없는 테스트 추가**

- [ ] **Step 7: API 전체 테스트와 typecheck 통과 확인 후 커밋**

### Task 26: Gateway 내부 Key/CSR 생성과 원자 저장

**Files:**
- Create: `apps/gateway/src/identity/key-material-store.ts`
- Create: `apps/gateway/src/identity/key-material-store.test.ts`
- Create: `apps/gateway/src/identity/openssl-csr-generator.ts`
- Create: `apps/gateway/src/identity/openssl-csr-generator.test.ts`
- Create: `apps/gateway/src/identity/manufacturing-enrollment-client.ts`
- Modify: `apps/gateway/docker/Dockerfile`
- Modify: `apps/gateway/compose.raspberry-pi.yml`

**Interfaces:**
- Produces: `generateDeviceIdentity(serialNumber): Promise<{ csrPem: string }>`
- Produces: `installIdentityBundle(bundle): Promise<void>`
- Constraint: private key는 API 응답·stdout·CSR payload에 포함되지 않음

- [ ] **Step 1: directory `0750`, key `0600`, cert `0644`, atomic rename 실패 테스트 작성**

```ts
const result = await store.generateDeviceIdentity("GW-RPI-000001");
expect(result).toEqual({ csrPem: expect.stringContaining("BEGIN CERTIFICATE REQUEST") });
expect(await modeOf("device.key")).toBe(0o600);
expect(JSON.stringify(result)).not.toContain("PRIVATE KEY");
```

- [ ] **Step 2: 테스트가 identity 구현 누락으로 실패하는지 확인**

Run: `pnpm --filter @led-control/gateway test -- src/identity/key-material-store.test.ts`
Expected: FAIL

- [ ] **Step 3: OpenSSL을 shell 없이 고정 argument array로 실행해 ECDSA P-256 PKCS#8 key와 CSR 생성**

- [ ] **Step 4: temporary write, `fsync`, `chmod`, atomic rename과 기존 활성 bundle 보존 구현**

- [ ] **Step 5: enrollment client가 token을 request body에 한 번만 사용하고 오류 로그를 redaction하도록 구현**

- [ ] **Step 6: Docker runtime에 고정 버전 OpenSSL과 persistent identity mount 추가**

- [ ] **Step 7: gateway 테스트·typecheck와 image contract 테스트 통과 후 커밋**

### Task 27: Device mTLS Bootstrap 후 MQTT CSR 발급

**Files:**
- Create: `apps/api/src/pki/gateway-certificate.controller.ts`
- Create: `apps/api/src/pki/gateway-certificate.service.ts`
- Create: `apps/api/src/pki/gateway-certificate.service.spec.ts`
- Create: `apps/gateway/src/identity/mqtt-certificate-client.ts`
- Create: `apps/gateway/src/identity/mqtt-certificate-client.test.ts`
- Modify: `apps/gateway/src/config/resolve-assignment.ts`
- Modify: `apps/gateway/src/index.ts`

**Interfaces:**
- Produces: `POST /gateway-certificates/mqtt`
- Consumes: authenticated device fingerprint, claimed inventory, gateway assignment, CSR
- Produces: CN=`Gateway.id`, TTL 90일 MQTT certificate

- [x] **Step 1: 미claim 장비, fingerprint 불일치, 다른 gateway CN 요청 거부 테스트 작성**

- [x] **Step 2: 테스트 실패 확인**

Run: `pnpm --filter @led-control/api test -- --runInBand src/pki/gateway-certificate.service.spec.ts`
Expected: FAIL

- [x] **Step 3: device mTLS identity와 inventory/gateway 관계 검증 후 MQTT CSR sign 구현**

- [x] **Step 4: MQTT certificate metadata transaction 기록과 기존 active certificate 교체 연결 구현**

- [x] **Step 5: Gateway가 assignment 후 별도 `gateway.key`/CSR을 만들고 certificate를 원자 설치하도록 구현**

- [x] **Step 6: certificate 설치 전 MQTT 연결 금지와 설치 후 재연결 테스트 작성**

- [x] **Step 7: API/gateway 전체 관련 테스트와 typecheck 통과 후 커밋**

### Task 28: LAN Service TLS와 CA Bundle 자동 배포

**Files:**
- Create: `infra/vault/README.md`
- Create: `infra/vault/policies/gateway-pki.hcl`
- Create: `scripts/pki/bootstrap-lab-vault.sh`
- Create: `scripts/pki/issue-lab-service-cert.sh`
- Create: `scripts/pki/pki-scripts.test.mjs`
- Modify: `scripts/dev-runtime.mjs`
- Modify: `.env.example`
- Modify: `docker-compose.yml`

**Interfaces:**
- Produces: LAN DNS/IP SAN을 가진 API/MQTT server certificate
- Produces: versioned `api-ca.crt`, `mqtt-ca.crt` bundle
- Constraint: `MQTT_PUBLIC_URL` 사용자 값을 localhost로 덮어쓰지 않음

- [x] **Step 1: SAN 누락, production Vault dev mode, CA key Git 포함 거부 정적 테스트 작성**

- [x] **Step 2: 스크립트 계약 테스트 실패 확인**

Run: `node --test scripts/pki/pki-scripts.test.mjs`
Expected: FAIL

- [x] **Step 3: 오프라인 Root CSR 서명 절차와 Vault intermediate mount/role/policy bootstrap 구현**

- [x] **Step 4: `LAB_API_DNS`, `LAB_API_IP`, `LAB_MQTT_DNS`, `LAB_MQTT_IP`를 SAN으로 강제하는 service cert 발급 구현**

- [x] **Step 5: API HTTPS, device client CA, Mosquitto server cert/client CA/CRL 설정 연결**

- [ ] **Step 6: Raspberry Pi에서 hostname 검증 성공, 잘못된 IP와 신뢰하지 않은 CA 실패 integration test**

호스트 자동 integration은 실제 발급 bundle로 정상 mTLS, 폐기 CRL, 잘못된 DNS/IP와 신뢰하지 않은 CA 실패까지 통과했다. Raspberry Pi 실기만 하드웨어 대기다.

- [x] **Step 7: 관련 문서와 `.env.example` 갱신 후 커밋**

### Task 29: 인증서 Rotation, 폐기와 CRL 배포

**Files:**
- Create: `apps/api/src/pki/certificate-lifecycle.service.ts`
- Create: `apps/api/src/pki/certificate-lifecycle.service.spec.ts`
- Create: `apps/gateway/src/identity/certificate-rotation.ts`
- Create: `apps/gateway/src/identity/certificate-rotation.test.ts`
- Modify: `apps/api/src/gateway-onboarding/gateway-onboarding.service.ts`
- Modify: `apps/api/src/main.ts`
- Modify: `scripts/dev-runtime.mjs`

**Interfaces:**
- Produces: MQTT 만료 30일 전 key rotation
- Produces: device 인증서 만료 30일 전 renewal
- Produces: inventory disabled 시 device/MQTT revoke와 CRL 반영

- [x] **Step 1: fake clock로 renewal window, grace overlap, expired fail-closed 테스트 작성**

- [x] **Step 2: revoke 후 bootstrap/MQTT 재연결 거부 테스트 작성**

- [x] **Step 3: Vault revoke와 certificate status transaction 구현**

- [x] **Step 4: CRL download, checksum, atomic replace, API/broker reload 구현**

- [x] **Step 5: Gateway 새 인증서 연결 성공 후에만 이전 key/cert 삭제하도록 구현**

- [x] **Step 6: lifecycle 테스트, API/gateway typecheck 통과 후 커밋**

2026-07-15 기준 신규 PostgreSQL에서 16개 migration 적용, API 199개 테스트와 API/Gateway 타입 검사를 통과했다. 활성화 응답 유실 재시도와 CRL 원자 교체 실패 재시도까지 자동 검증했다.

### Task 30: 제조 Station 자동 부여 스크립트

**Files:**
- Create: `scripts/gateway-manufacturing-enroll.sh`
- Create: `scripts/gateway-manufacturing-enroll.test.mjs`
- Create: `apps/gateway/scripts/manufacturing-enroll.ts`
- Modify: `package.json`
- Modify: `.gitignore`

**Interfaces:**
- Produces: `pnpm gateway:manufacturing:enroll --target <ssh> --serial <serial> --label-output <path>`
- Produces: Claim label artifact `0600`, private key는 gateway 외부에 생성하지 않음

- [x] **Step 1: command injection, token stdout 노출, label 권한, 중복 serial 실패 테스트 작성**

- [x] **Step 2: 테스트 실패 확인**

Run: `node --test scripts/gateway-manufacturing-enroll.test.mjs`
Expected: FAIL

- [x] **Step 3: 제조 API에서 enrollment를 만들고 secret JSON을 stdout 대신 pipe로 전달**

- [x] **Step 4: SSH target에서 local key/CSR 생성과 enrollment 호출 실행**

- [x] **Step 5: public key 일치, certificate chain, fingerprint 원장 일치 검증**

- [x] **Step 6: Claim Code QR/label 입력 파일을 `0600`으로 생성하고 나머지 secret 임시 파일 제거**

- [x] **Step 7: 성공/실패 제조 감사 결과 기록과 재실행 idempotency 구현**

- [ ] **Step 8: 스크립트 테스트와 실제 Pi 1대 dry run 후 커밋**

스크립트·API 테스트와 Docker enrollment bundle 빌드는 통과했다. 실제 Pi dry run 증거가 없어 Step 8은 미완료로 유지한다.

### Task 31: PKI 보안 E2E와 양산 완료 게이트

**Files:**
- Create: `apps/api/test/gateway-pki.e2e-spec.ts`
- Create: `apps/gateway/scripts/pki-hil-test.ts`
- Modify: `docs/runbooks/raspberry-pi-gateway-appliance.md`
- Modify: `docs/runbooks/production-device-lab.md`
- Modify: `docs/menus/settings.md`
- Modify: `README.md`

**Interfaces:**
- Produces: 제조 등록부터 MQTT rotation까지 반복 가능한 증거 JSON
- Completion gate: private key 외부 유출 0건, 정상 3회, 부정 시험 전부 거부

- [x] **Step 1: 제조 등록 → Claim → Bootstrap → MQTT 발급 happy path E2E 작성**

- [x] **Step 2: token 재사용, CSR 변조, serial 불일치, 잘못된 CA, 폐기 인증서 부정 시험 작성**

- [ ] **Step 3: API·broker·gateway 재시작 후 identity/assignment 복구 시험 작성**

- [ ] **Step 4: MQTT rotation overlap 중 명령 유실·중복 제어 없음 검증**

- [ ] **Step 5: Raspberry Pi 2대에 서로 다른 key/fingerprint가 발급되는지 검증**

- [ ] **Step 6: 로그·DB·Docker image·배포 tar에서 `PRIVATE KEY`, Claim Code, token 원문 secret scan**

- [ ] **Step 7: 전체 workspace 테스트, typecheck, ARM64 image build, PKI HIL 3회 실행**

- [x] **Step 8: 한글 runbook과 메뉴 문서에 발급·복구·폐기·CA rotation 절차 갱신**

- [ ] **Step 9: Root offline 보관, Vault production mode, backup/restore, 운영 책임자 승인 증거가 모두 있을 때만 양산 PKI 완료 표시**

실제 PostgreSQL 기반 제조 등록·claim·bootstrap·MQTT 발급과 주요 부정 시험은 자동화했다. ARM64 image build와 image/archive private-key PEM scan도 통과했다. 재시작·rotation·2대 fingerprint·전체 secret scan은 HIL runner 판정 계약까지 구현했으며, 실물 3회 결과와 운영 승인 증거가 없어 Step 3~7·9는 미완료다.

## PKI 구현 순서

Task 23 → 24 → 25 → 26 → 27 → 28 → 29 → 30 → 31 순서를 변경하지 않는다. Task 23~27이 장비별 identity와 MQTT 인증서 핵심 경로이고, Task 28은 실제 LAN HIL을 가능하게 하며, Task 29~31은 양산에서 필수인 수명주기와 운영 증거를 완성한다.

## 2026-07-15 PKI 구현 체크포인트

### 완료 및 커밋

- Task 23~25: Gateway PKI 원장, Vault CA provider, 제조 mTLS enrollment, PKCS#10 PoP/ECDSA P-256 검증, 1회용 token/Claim Code를 구현했다. 커밋: `e64ca33`.
- Task 26: Raspberry Pi 내부 private key/CSR 생성, device identity 세대 저장, 원자적 current 전환, 분리된 Device/API/MQTT CA 검증, 제조 enrollment HTTPS client와 appliance mount를 구현했다. 커밋: `4515d8f`.
- 자동 검증: API 154 tests, Gateway 88 tests, identity 23 tests, Docker/Compose contract 8 tests, 양쪽 typecheck와 실제 로컬 OpenSSL 분리 CA 검증이 통과했다.
- 실제 PostgreSQL 검증: 빈 임시 DB에 전체 13개 migration을 적용했고 partial unique enrollment index를 확인했다.

### 중단 지점과 다음 순서

1. Task 27: Device mTLS로 claim된 inventory/gateway를 확인하고 별도 MQTT CSR을 발급한다. Gateway는 `identity/mqtt/current` 설치가 성공하기 전 BlueZ/MQTT runtime을 시작하지 않는다.
2. Task 28: Vault intermediate/role/policy, LAN API/MQTT server certificate, CA bundle 배포와 실제 TLS hostname/잘못된 CA 부정 시험을 구현한다.
3. Task 29: device/MQTT 만료 30일 전 rotation, revoke, CRL checksum/원자 교체와 broker/API reload를 구현한다.
4. Task 30: 제조 station이 SSH 대상 Raspberry Pi 내부에서 key를 만들고 enrollment를 실행하며 Claim label만 `0600`으로 출력하는 자동화 스크립트를 구현한다.
5. Task 31: 제조 등록부터 claim, bootstrap, MQTT 발급, 조명 등록·제어, rotation까지 실제 Raspberry Pi/ESP32-H2 HIL 3회와 부정 시험 증거를 수집한다.

### 완료로 표시하지 않는 항목

- 현재 머신에는 Docker CLI가 없어 ARM64 appliance image build를 실행하지 못했다.
- 실제 Vault, manufacturing client certificate, Raspberry Pi, MQTT broker, ESP32-H2를 연결한 PKI/조명 E2E는 아직 실행하지 않았다.
- 따라서 소프트웨어 Task 23~26은 완료지만 양산 PKI 또는 하드웨어 E2E 100% 완료로 표시하지 않는다.
