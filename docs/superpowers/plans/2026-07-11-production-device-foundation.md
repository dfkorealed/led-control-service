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

- [ ] **Step 4: Raspberry Pi probe와 판정표 구현**

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

- [ ] **Step 1: 일회성 claim과 인증서 불일치 실패 테스트 작성**

```ts
await expect(service.claimGateway(user, { siteId, serialNumber, claimCode: "once" })).resolves.toMatchObject({ siteId });
await expect(service.claimGateway(user, { siteId, serialNumber, claimCode: "once" })).rejects.toThrow("claim code already used");
await expect(service.bootstrap({ serialNumber, fingerprint: "wrong" })).rejects.toThrow("device certificate mismatch");
```

- [ ] **Step 2: 실패 확인**

Run: `pnpm --filter @led-control/api test -- gateway-onboarding.service.spec.ts --runInBand`
Expected: FAIL because module does not exist.

- [ ] **Step 3: scrypt claim 검증과 원자적 binding 구현**

Claim transaction은 inventory가 미claim·활성 상태인지, site가 사용자 조직 소속인지, `timingSafeEqual`로 hash가 일치하는지 확인하고 Gateway를 생성·연결한 뒤 `claimCodeHash=null`, `claimedAt`을 기록한다. 성공·실패를 `GatewayClaimAudit`에 남기고 serial/IP 단위 rate limit을 적용한다.

- [ ] **Step 4: peer certificate fingerprint guard 구현**

```ts
const cert = request.socket.getPeerCertificate?.();
const fingerprint = normalizeFingerprint(cert?.fingerprint256);
if (!request.socket.authorized || !fingerprint) throw new UnauthorizedException("mTLS device certificate required");
```

`NODE_ENV=test`에서만 `x-test-client-cert-fingerprint` 주입을 허용하고 production에서는 헤더를 무시한다. Bootstrap 응답은 assignment와 broker URL만 반환하며 claim code나 private key를 반환하지 않는다.

- [ ] **Step 5: API 검증·문서·커밋**

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

- [ ] **Step 1: 권한·원자성 실패 테스트 작성**

```ts
await store.writeAtomic(assignment);
expect((await stat(path)).mode & 0o777).toBe(0o600);
expect(await store.read()).toEqual(assignment);
expect(await readdir(dirname(path))).not.toContain("assignment.json.tmp");
```

- [ ] **Step 2: 실패 확인 후 구현**

Run: `pnpm --filter @led-control/gateway test -- assignment-store.test.ts bootstrap-client.test.ts`
Expected before implementation: FAIL.

구현은 같은 디렉터리 임시 파일에 `mode: 0o600`으로 기록하고 `fsync` 후 rename한다. Bootstrap은 serial, client cert/key, CA만 환경변수로 받고 assignment가 없으면 지수 backoff로 대기한다.

- [ ] **Step 3: `siteId/gatewayId` env 의존 제거**

`GATEWAY_SITE_ID`, `GATEWAY_ID`는 test mode에서만 허용한다. Production 시작 시 assignment 또는 제조 credential이 없으면 명확한 오류로 종료한다.

- [ ] **Step 4: 검증과 커밋**

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

- [ ] **Step 1: 보안 설정 정적 테스트 작성**

```ts
expect(mosquittoConfig).toContain("allow_anonymous false");
expect(mosquittoConfig).toContain("require_certificate true");
expect(gitignore).toContain(".local/pki/");
```

- [ ] **Step 2: 개발 PKI와 Mosquitto profile 구현**

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

- [ ] **Step 3: API/gateway TLS option 구현**

Production에서 `mqtt://`, CA 누락, client cert/key 누락은 시작 실패한다. Test와 명시적 local profile에서만 평문 broker를 허용한다.

- [ ] **Step 4: 인증 부정 시험**

Run: `mosquitto_pub -h localhost -p 8883 -t test -m denied`
Expected: TLS/authentication failure.

Run with gateway certificate and another gateway topic.
Expected: ACL authorization failure.

- [ ] **Step 5: 검증·커밋**

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

- [ ] **Step 1: 두 gateway 그룹 분할 실패 테스트 작성**

```ts
const dispatches = await service.createDispatches(command, [
  { fixtureId: "f1", gatewayId: "g1" }, { fixtureId: "f2", gatewayId: "g2" }
]);
expect(dispatches).toHaveLength(2);
expect(dispatches.map((item) => item.gatewayId)).toEqual(["g1", "g2"]);
```

- [ ] **Step 2: transactional outbox 구현**

Command와 dispatch/outbox를 같은 DB transaction에서 생성한다. Publisher는 미발행 outbox를 재시도하고 `idempotencyKey`와 gateway sequence를 payload에 포함한다.

- [ ] **Step 3: gateway 멱등성 저장과 두 단계 ACK 구현**

Gateway는 명령을 로컬 저장한 뒤 acceptance ACK를 보내고, 실제 adapter 결과 후 fixture별 device-status ACK를 보낸다. 중복 key에는 저장된 terminal result를 재발행하며 다시 제어하지 않는다.

- [ ] **Step 4: 검증·문서·커밋**

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

- [ ] **Step 1: tenant 위조·중복·역전 테스트 작성**

```ts
await service.handleMessage(topicForSiteA, stateForSiteB);
expect(prisma.fixture.updateMany).not.toHaveBeenCalled();
await service.handleMessage(validTopic, { ...state, sequence: 9 });
await service.handleMessage(validTopic, { ...state, sequence: 8 });
expect(lastStoredSequence).toBe(9);
```

- [ ] **Step 2: topic와 DB 관계 검증 구현**

Fixture, command, gateway가 topic의 site/gateway에 모두 속할 때만 update한다. `eventId` unique 충돌은 성공한 중복 처리로 간주하고 낮은 sequence는 폐기한다.

- [ ] **Step 3: TTL와 startup resync 처리**

90초 heartbeat 만료 시 gateway와 연결된 fixture를 `offline`+`gateway_offline`으로 표시한다. 120초 fixture state 만료는 해당 fixture만 `offline`+`fixture_stale`로 표시한다. Startup resync 이벤트는 같은 sequence 검증을 통과해야 한다.

- [ ] **Step 4: 검증·문서·커밋**

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

- [ ] **Step 4: 운영 stub 차단**

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

- [ ] **Step 1: host C 실패 테스트 작성**

```c
assert(mesh_state_apply_onoff(&state, 0) == 0);
assert(state.previous_brightness_percent == 30);
assert(mesh_state_apply_onoff(&state, 1) == 30);
assert(command_sequence_accept(&state, 10));
assert(!command_sequence_accept(&state, 9));
```

- [ ] **Step 2: 이전 밝기·sequence·transition 구현**

NVS write는 밝기 변경마다 하지 않고 debounce된 commit으로 flash wear를 제한한다. Transition 완료 후 Status를 발행하고 중복·낮은 sequence를 적용하지 않는다.

- [ ] **Step 3: identify·Health·factory reset·watchdog 구현**

Health Attention callback은 실제 PWM 점멸을 시작/종료한다. Factory reset 물리 입력은 길게 누르기 8초로 고정하고 mesh credential과 앱 NVS를 삭제한다. Task watchdog과 reset reason을 초기 상태 report에 포함한다.

- [ ] **Step 4: host·ESP-IDF 빌드 검증**

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

- [ ] **Step 1: deterministic scenario runner 실패 테스트 작성**

```ts
expect(result.steps.map((step) => step.name)).toEqual([
  "claim", "bootstrap", "secure-mqtt", "scan", "provision", "bind",
  "individual-control", "group-control", "stale-event", "offline", "restart-recovery", "acl-negative"
]);
```

- [ ] **Step 2: HIL runner 구현**

Runner는 serial/port/certificate 경로를 환경변수로 받고 secret은 출력하지 않는다. 각 단계의 commandId, fixtureId, 실제 Status, 지연시간을 JSON으로 남긴다.

- [ ] **Step 3: 장애·보안 부정 시나리오 구현**

중복 command, 역전 sequence, 한 노드 timeout, MQTT 단절, gateway/mesh daemon/노드 재부팅, 무인증 접속, 다른 gateway topic 접근을 실행한다.

- [ ] **Step 4: 3회 연속 실기 통과**

Run: `pnpm gateway:hil:2node -- --repeat 3`
Expected: all three runs PASS with no manual DB edits or reprovisioning between runs.

- [ ] **Step 5: 커밋**

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

- [ ] **Step 1: 기능 상태 문서 갱신**

BlueZ 실기 검증 전 항목은 `구현 완료`가 아니라 `코드 완료·실기 미검증`으로 기록한다. Stub, command adapter, 개발 인증서는 테스트 전용으로 명시한다.

- [ ] **Step 2: 반복 가능한 교훈 기록**

`docs/lesson_leared.md`에 topic scope 검증, claim 원문 금지, ACK 의미 분리, hardware validation level을 기록한다.

- [ ] **Step 3: 전체 자동 검증**

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

- [ ] **Step 5: 최종 커밋**

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

## 진행 로그

- 2026-07-11: 설계 승인 및 구현 계획 작성. 구현은 Task 1부터 순서대로 진행한다.
- 2026-07-11: Task 1의 D-Bus transport, capability report, Mac/Raspberry Pi 판정 probe를 구현하고 gateway 테스트 11개와 typecheck를 통과했다. `dbus-next`는 선택 의존성 취약점 때문에 `@homebridge/dbus-native`로 교체했다. Raspberry Pi 실기 Phase 0은 미완료다.
- 2026-07-11: Task 2의 gateway-scoped MQTT v2 topic과 dimming, acceptance ACK, device status ACK, fixture state, heartbeat schema를 추가했다. legacy MVP1 topic은 기존 소비자를 깨지 않도록 유지했으며 shared 테스트 8개와 build를 통과했다.
- 2026-07-11: Task 3의 제조 gateway inventory, claim audit, gateway별 command dispatch, fixture 결과, MQTT outbox, 처리 이벤트 원장과 sequence/freshness 필드를 추가했다. migration을 로컬 PostgreSQL에 적용하고 DB 문서를 갱신했다.
