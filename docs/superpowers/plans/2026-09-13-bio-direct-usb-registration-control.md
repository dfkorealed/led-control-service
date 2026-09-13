# BIO Direct USB Registration and Control Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 제조사 Android 앱이나 휴대폰 없이 Raspberry Pi Gateway의 BIO USB-C 동글만으로 센서통신모듈을 검색하고, 사용자가 웹에서 점등 대상을 확인한 뒤 주소를 할당·등록하며, 등록한 조명의 0~100% 밝기와 ON/OFF를 제어한다.

**Architecture:** 이미 구현된 API/Web provisioning V2와 Gateway durable journal은 유지한다. 실패가 확인된 Linux tty/`serialport` 계층만 `usb@2.15.0`의 legacy libusb API를 사용하는 `BioDirectUsbConnection`으로 교체하고, 그 위에 request ownership을 보장하는 `BioUsbTransport`, APK serializer에서 복원한 명령 codec, UUID/address reconciliation, `BioUsbDongleAdapter`를 순서대로 올린다. USB ACK는 전송 수락일 뿐이므로 등록은 동일 UUID가 신규 주소에서 다시 발견되어야 완료하고, 제어는 high-brightness와 control-mode read-back이 요청값과 일치해야 완료한다.

**Tech Stack:** TypeScript, Node.js 22, Vitest, `usb@2.15.0`, libusb legacy API, MQTT QoS 1, Docker Compose, Raspberry Pi OS aarch64, CH34x raw USB bulk transfer

**Spec:** `docs/superpowers/specs/2026-09-12-bio-usb-dongle-gateway-adapter-design.md`

## Existing Baseline and Supersession

- `docs/superpowers/plans/2026-09-12-bio-usb-dongle-gateway-adapter.md`의 Task 1~3과 Task 4의 traced codec/client 부분은 보존한다.
- 이 계획은 기존 계획의 serial 기반 Task 4 hardware gate와 Task 5~10을 대체한다.
- `777193d`의 Android startup 순서는 golden evidence로 사용하지만 `NodeSerialConnection`과 `serialport` 제품 경로는 폐기한다.
- direct PyUSB HIL에서 interface `0`, bulk OUT `0x02`, bulk IN `0x82`, packet size `32`, valid `0x03`, valid `0x0b`, outer `0x11` ACK 두 건과 2초 점등을 확인했다.
- API의 provisioning device-terminal ingest/application ACK, Web 등록 세션, `bio:<12-hex>` identity와 mapping store의 초기 구현은 재사용한다.

## Global Constraints

- 기존 `GATEWAY_ADAPTER=bluez` 동작, D-Bus/BlueZ probe와 테스트 계약을 변경하지 않는다.
- 생산·현장 흐름은 제조사 앱, Android 단말, 무선 디버깅을 요구하거나 실행하지 않는다.
- `1a86:5523`가 정확히 한 대일 때만 open하고 interface `0`, OUT `0x02`, IN `0x82`, max packet `32`가 모두 일치하지 않으면 fail-closed한다.
- CH34x vendor control transfer는 검증된 8단계 순서와 값만 허용한다. 임의 baud divisor, reset, factory, password 명령을 추가하지 않는다.
- `/dev` 또는 `/dev/bus/usb` 전체 mount, `privileged=true`, root Node process를 사용하지 않는다.
- USB ACK만으로 주소 할당 또는 조명 제어를 성공 처리하지 않는다.
- 주소 할당 timeout은 같은 write를 즉시 재전송하지 않고 UUID를 이전/신규 주소에서 재검색해 판정한다.
- 등록 HIL은 사용자에게 redacted UUID fingerprint와 이전/신규 주소를 표시하고 한 장치에 대한 명시 확인을 받은 뒤 실행한다.
- 서비스 brightness는 정수 `0..100`만 받는다. `1..100`은 APK `deep_all`/`DEEP_VALUES`의 동일 index mapping을 사용하고, `0`은 force-off로 처리한다. `percent * 2.55`를 사용하지 않는다.
- raw frame 전체, password, 인증서, MQTT 자격 증명을 일반 log, fixture, Git history에 기록하지 않는다.
- MQTT 기준선이 healthy heartbeat 3회를 만들기 전에는 full Web→API→Gateway registration HIL을 시작하지 않는다.
- software 완료, read-only USB HIL, 주소 변경 HIL, end-to-end HIL을 문서에서 각각 구분한다.

---

### Task 1: Transport boundary rename and pre-request response ownership

**Files:**
- Create: `apps/gateway/src/bio/bio-byte-connection.ts`
- Create: `apps/gateway/src/bio/bio-usb-transport.ts`
- Create: `apps/gateway/src/bio/bio-usb-transport.test.ts`
- Modify: `apps/gateway/src/bio/bio-dongle-client.ts`
- Modify: `apps/gateway/src/bio/bio-dongle-client.test.ts`
- Modify: `apps/gateway/src/bio/bio-usb-error.ts`
- Delete: `apps/gateway/src/bio/bio-serial-transport.ts`
- Delete: `apps/gateway/src/bio/bio-serial-transport.test.ts`
- Delete: `apps/gateway/src/bio/node-serial-connection.ts`
- Delete: `apps/gateway/src/bio/node-serial-connection.test.ts`
- Delete: `apps/gateway/src/bio/linux-usb-identity-inspector.ts`
- Delete: `apps/gateway/src/bio/linux-usb-identity-inspector.test.ts`

**Interfaces:**

```ts
export interface BioByteConnection {
  open(): Promise<void>;
  write(bytes: Uint8Array): Promise<void>;
  close(): Promise<void>;
  onData(listener: (bytes: Buffer) => void): () => void;
  onDisconnect(listener: (error: Error) => void): () => void;
}

export interface BioUsbRequest {
  command: number;
  payload: Uint8Array;
}
```

- [x] **Step 1: 현재 전체 Gateway test를 기록한다.**

Run: `pnpm --filter @led-control/gateway test`

Expected: 현재 branch의 기존 suite가 통과한다. 실패하면 이 계획 변경과 분리해 원인을 기록한다.

- [x] **Step 2: byte connection 이름과 response ownership RED 테스트를 작성한다.** 다음 테스트는 `0x0a` request 전에 `55 aa 0b` partial input이 시작되고 request 뒤 tail이 도착해도 ready가 되지 않으며 write 자체가 실행되지 않아야 한다.

```ts
it("rejects a response candidate that started before the request write", async () => {
  const connection = new FakeBioByteConnection();
  const transport = createTransport(connection);
  const starting = transport.start();
  connection.emit(validInfo03);
  connection.emit(Buffer.from("55aa0b", "hex"));

  await expect(starting).rejects.toMatchObject({ code: "LATE_RESPONSE" });
  expect(connection.writes).toEqual([
    Buffer.from("55aa82000000", "hex"),
    Buffer.from("4753820000", "hex")
  ]);
});
```

- [x] **Step 3: RED를 확인한다.**

Run: `pnpm --filter @led-control/gateway exec vitest run src/bio/bio-usb-transport.test.ts src/bio/bio-dongle-client.test.ts`

Expected: 새 module import와 pre-request partial-frame assertion이 실패한다.

- [x] **Step 4: `BioByteConnection`, `BioUsbTransport`, error 경계를 최소 구현한다.** 모든 request는 active owner를 설정하기 직전에 `codec.hasPendingFrame()`을 검사한다. pending candidate가 있으면 write하지 않고 generation을 retire하며 `LATE_RESPONSE`를 반환한다. startup의 `0x0a`도 일반 요청과 동일한 ownership gate를 사용한다.

```ts
private begin(request: PendingRequest) {
  if (this.codec.hasPendingFrame()) {
    this.fail(this.status.generation, new BioUsbError(
      "LATE_RESPONSE",
      "BIO response candidate started before request ownership"
    ));
    return;
  }
  this.active = request;
  this.armResponseTimeout();
  void this.connection!.write(request.bytes).catch(() => {
    this.fail(this.status.generation, new BioUsbError("DISCONNECTED", "BIO USB write failed"));
  });
}
```

- [x] **Step 5: 기존 one-in-flight, late response, reconnect `2s→32s`, close-failure 테스트를 새 이름으로 옮기고 GREEN을 확인한다.**

Run: `pnpm --filter @led-control/gateway exec vitest run src/bio/bio-frame-codec.test.ts src/bio/bio-usb-transport.test.ts src/bio/bio-dongle-client.test.ts`

- [x] **Step 6: typecheck 후 커밋한다.**

Run: `pnpm --filter @led-control/gateway typecheck`

```bash
git add apps/gateway/src/bio
git commit -m "refactor(gateway): prepare BIO transport for direct USB"
```

---

### Task 2: Direct libusb connection and exact CH34x initialization

**Files:**
- Create: `apps/gateway/src/bio/bio-direct-usb-connection.ts`
- Create: `apps/gateway/src/bio/bio-direct-usb-connection.test.ts`
- Create: `apps/gateway/src/bio/node-usb-driver.ts`
- Create: `apps/gateway/src/bio/node-usb-driver.test.ts`
- Modify: `apps/gateway/src/bio/bio-dongle-client.ts`
- Modify: `apps/gateway/package.json`
- Modify: `pnpm-lock.yaml`
- Modify: `apps/gateway/docker/Dockerfile`

**Interfaces:**

```ts
export interface BioUsbDescriptor {
  idVendor: number;
  idProduct: number;
  busNumber: number;
  deviceAddress: number;
  interfaceNumber: number;
  bulkOutAddress: number;
  bulkInAddress: number;
  maxPacketSize: number;
}

export interface BioUsbDeviceHandle {
  descriptor(): BioUsbDescriptor;
  open(): void;
  detachKernelDriver(): boolean;
  claim(): void;
  controlOut(request: number, value: number, index: number): Promise<void>;
  controlIn(request: number, value: number, index: number, length: number): Promise<Buffer>;
  transferOut(bytes: Uint8Array): Promise<void>;
  startInput(listener: (bytes: Buffer) => void, onError: (error: Error) => void): void;
  stopInput(): Promise<void>;
  release(): Promise<void>;
  reattachKernelDriver(): void;
  close(): void;
}
```

- [x] **Step 1: exact-one descriptor와 lifecycle RED 테스트를 작성한다.** 0대, 2대, VID/PID 불일치, interface/endpoint/packet 불일치, open 실패, detach 실패, 각 control transfer 실패, poll 실패, release 실패, reattach 실패를 별도 case로 만든다.

- [x] **Step 2: CH34x 8단계 순서 RED 테스트를 작성한다.**

```ts
expect(handle.calls).toEqual([
  ["controlOut", 0xa1, 0x0000, 0x0000],
  ["controlIn", 0x5f, 0x0000, 0x0000, 2],
  ["controlOut", 0x9a, 0x1312, 0xd982],
  ["controlOut", 0x9a, 0x0f2c, 0x0004],
  ["controlIn", 0x95, 0x2518, 0x0000, 2],
  ["controlOut", 0x9a, 0x2727, 0x0000],
  ["controlOut", 0xa4, 0x00ff, 0x0000],
  ["controlOut", 0xa1, 0xc39c, 0xcc8b]
]);
```

- [x] **Step 3: RED를 확인한다.**

Run: `pnpm --filter @led-control/gateway exec vitest run src/bio/bio-direct-usb-connection.test.ts src/bio/node-usb-driver.test.ts`

Expected: direct USB modules가 없어 실패한다.

- [x] **Step 4: `usb@2.15.0`을 exact dependency로 추가한다.** `apps/gateway/package.json`은 `apply_patch`로 수정하고 lockfile은 package manager로 재계산한다. v2 legacy API의 `getDeviceList`, `Device.controlTransfer`, `Interface.claim/release`, `InEndpoint.startPoll/stopPoll`, `OutEndpoint.transfer`를 사용한다. 별도 `@types/usb`는 추가하지 않는다.

Run: `pnpm install --lockfile-only`

- [x] **Step 5: `NodeUsbDriver`를 최소 구현한다.** `getDeviceList()` 결과에서 `idVendor===0x1a86 && idProduct===0x5523`인 장치를 모두 수집하고 정확히 하나가 아니면 `USB_IDENTITY`로 실패한다. callback API는 Promise wrapper 안에서 한 번만 settle한다.

- [x] **Step 6: `BioDirectUsbConnection`을 구현한다.** open 순서는 descriptor 재검증 → device open → kernel driver detach 여부 기록 → interface claim → 8 control transfers → endpoint 검증 → IN poll 시작이다. close는 poll stop → release → 조건부 reattach → device close이며 어느 단계도 실패를 성공으로 숨기지 않는다.

- [x] **Step 7: detach/open 도중 실패한 경우에도 역순 cleanup이 정확히 한 번 실행되는지 GREEN으로 확인한다.**

Run: `pnpm --filter @led-control/gateway exec vitest run src/bio/bio-direct-usb-connection.test.ts src/bio/node-usb-driver.test.ts src/bio/bio-usb-transport.test.ts`

- [x] **Step 8: Docker ARM64 build가 native addon을 load할 수 있게 builder fallback dependency를 추가하고 local build/typecheck를 통과시킨다.** runtime에는 `libudev1`만 유지하고 compiler는 최종 image에 남기지 않는다.

Run: `pnpm --filter @led-control/gateway typecheck && pnpm --filter @led-control/gateway build`

- [x] **Step 9: 커밋한다.**

```bash
git add apps/gateway/src/bio apps/gateway/package.json apps/gateway/docker/Dockerfile pnpm-lock.yaml
git commit -m "feat(gateway): open BIO dongle through direct USB"
```

---

### Task 3: Product-path read-only probe on Raspberry Pi

**Files:**
- Modify: `apps/gateway/scripts/bio-dongle-probe.ts`
- Modify: `apps/gateway/scripts/bio-dongle-probe.test.ts`
- Modify: `apps/gateway/package.json`
- Evidence only, Git-ignored: `.superpowers/sdd/2026-09-12-bio-usb-dongle-gateway-adapter/direct-usb-readonly-hil/`

**Interfaces:**
- CLI default operation: descriptor + CH34x init + converter literals + GET_NWK only
- Success: valid `0x03` and valid CRC16 `0x0b`
- Forbidden: outer command `0x10`, address assignment, brightness, mode, password, reset

- [x] **Step 1: CLI allowlist RED 테스트를 작성한다.** source contract에서 `setBrightness`, `setControlMode`, `assignAddress`, arbitrary hex option이 노출되지 않음을 검사한다.

- [x] **Step 2: CLI를 `BioDirectUsbConnection`/`BioUsbTransport`로 교체하고 JSON output은 descriptor, protocol, command, payload length, elapsed time만 내보낸다.** UUID, network password, raw payload는 출력하지 않는다.

- [x] **Step 3: focused test와 build를 통과시킨다.**

Run: `pnpm --filter @led-control/gateway exec vitest run scripts/bio-dongle-probe.test.ts src/bio/bio-direct-usb-connection.test.ts src/bio/bio-usb-transport.test.ts`

Run: `pnpm --filter @led-control/gateway build`

- [x] **Step 4: 현재 Gateway container fingerprint를 기록한다.** container ID, image ID, StartedAt, RestartCount만 저장하고 env/secret은 출력하지 않는다.

- [x] **Step 5: disposable ARM64 image를 만들고 현재 raw node 한 개만 같은 경로로 mapping해 probe를 non-root `gateway` user로 실행한다.** 운영 compose, MQTT identity, data volume은 전달하지 않는다.

Expected:

```text
adapterKind=bio-usb
descriptor=1a86:5523/interface0/out02/in82/packet32
converterInfo=valid-03
networkProbe=valid-0b
```

- [x] **Step 6: probe 종료 후 kernel driver가 다시 연결됐고 `/dev/ttyUSB0`가 복구됐는지 확인한다.** 운영 container ID/StartedAt/RestartCount가 Step 4와 같아야 한다.

- [x] **Step 7: disposable container/image를 제거하고 redacted evidence SHA-256을 progress ledger에 기록한다.** 실패하면 Task 4 이후를 시작하지 않고 direct connection cleanup을 수정한다.

- [x] **Step 8: 커밋한다.**

```bash
git add apps/gateway/scripts/bio-dongle-probe.ts apps/gateway/scripts/bio-dongle-probe.test.ts apps/gateway/package.json
git commit -m "feat(gateway): probe BIO dongle over direct USB"
```

**Gate result: PASSED.** 비동기 startup 알림 drain과 두 converter literal 완료 gate를 적용한 제품 경로 probe가 52ms 안에 CRC16 `0x03`(payload 12 bytes)과 decoder-valid CRC16 GET_NWK `0x0b`(payload 13 bytes)를 확인했다. outer `0x10`과 상태 변경 명령은 전송하지 않았고, USB driver 및 운영 container fingerprint가 복구·불변임을 확인했다. Redacted evidence SHA-256은 `22d0829433b0b9a985ab73970b01bc93104e16fe83394fedc16eb745e0856499`이다.

---

### Task 4: Address, brightness and read-back protocol contracts

**Files:**
- Create: `apps/gateway/src/bio/bio-brightness-table.ts`
- Create: `apps/gateway/src/bio/bio-brightness-table.test.ts`
- Modify: `apps/gateway/src/bio/bio-command-codec.ts`
- Modify: `apps/gateway/src/bio/bio-command-codec.test.ts`
- Modify: `apps/gateway/test/fixtures/bio-protocol-v1.json`

**Interfaces:**

```ts
export type BioOperation =
  | { kind: "probe" | "scan" | "stopScan" }
  | { kind: "assignAddress"; target: BioLampTarget; nativeUuid: string; logicalAddress: number }
  | { kind: "readHighBrightness"; target: BioLampTarget }
  | { kind: "setHighBrightness"; target: BioLampTarget; rawHighBrightness: number }
  | { kind: "readControlMode"; target: BioLampTarget }
  | { kind: "setControlMode"; target: BioLampTarget; mode: BioControlMode };

export function percentToBioRaw(percent: number): number;
export function bioRawToPercent(raw: number): number | null;
```

- [x] **Step 1: APK static evidence를 fixture metadata에 기록한다.** installed APK SHA-256 `38b908d233019888da7b0cfb77c8f5f6cf8a6f36cd2afb2f1b0cf59357f95a1d`, `Network.setUnicastAddressByUuid`, DPID `0x81`, UUID 6 bytes, ADDRESS big-endian, base opcode `0x38`을 적는다.

- [x] **Step 2: brightness mapping RED 테스트를 작성한다.** integer service percent는 `deep_all`의 동일 표시값을 찾은 index의 `DEEP_VALUES`를 사용한다. 대표점은 아래 값으로 고정한다.

```ts
expect(percentToBioRaw(0)).toBe(0);
expect(percentToBioRaw(1)).toBe(26);
expect(percentToBioRaw(20)).toBe(114);
expect(percentToBioRaw(60)).toBe(198);
expect(percentToBioRaw(90)).toBe(242);
expect(percentToBioRaw(99)).toBe(254);
expect(percentToBioRaw(100)).toBe(255);
```

- [x] **Step 3: address serializer RED 테스트를 작성한다.** body는 `b8 81 <uuid-6> <address-BE>`이고 lamp header destination은 관측된 현재 address다. UUID가 6 bytes가 아니거나 address가 `0x0001..0x7fff` 밖이면 frame을 만들지 않는다.

```ts
expect(encodeBioCommand({
  kind: "assignAddress",
  target: { kind: "unicast", networkId: 0, logicalAddress: 0x1234 },
  nativeUuid: "001122334455",
  logicalAddress: 0x2345
}, 0x53).payload.subarray(15)).toEqual(Buffer.from("b8810011223344552345", "hex"));
```

- [x] **Step 4: read-back RED 테스트를 작성한다.** high brightness GET body는 `4e 13`, response body는 `4f 13 <raw>`, control mode GET body는 `4e 12`, response body는 `4f 12 <mode>`다. outer `0x11`은 read-back 값으로 해석하지 않는다.

- [x] **Step 5: RED를 확인한다.**

Run: `pnpm --filter @led-control/gateway exec vitest run src/bio/bio-brightness-table.test.ts src/bio/bio-command-codec.test.ts`

- [x] **Step 6: 101개 integer mapping과 command encode/decode를 최소 구현한다.** reverse mapping은 exact raw 값만 percent로 반환하며 근사 반올림하지 않는다.

- [x] **Step 7: malformed response, wrong UUID/address, unsupported DPID, non-exact raw 값 테스트를 GREEN으로 만든다.**

Run: `pnpm --filter @led-control/gateway exec vitest run src/bio/bio-brightness-table.test.ts src/bio/bio-command-codec.test.ts`

- [x] **Step 8: 커밋한다.**

```bash
git add apps/gateway/src/bio/bio-brightness-table* apps/gateway/src/bio/bio-command-codec* apps/gateway/test/fixtures/bio-protocol-v1.json
git commit -m "feat(gateway): encode BIO registration and read-back commands"
```

---

### Task 5: Discovery, identify, address reconciliation and verified control client

**Files:**
- Modify: `apps/gateway/src/bio/bio-dongle-client.ts`
- Modify: `apps/gateway/src/bio/bio-dongle-client.test.ts`
- Modify: `apps/gateway/src/bio/bio-command-codec.ts`
- Modify: `apps/gateway/src/bio/bio-command-codec.test.ts`
- Modify: `apps/gateway/src/bio/bio-device-mapping-store.ts`
- Modify: `apps/gateway/src/bio/bio-device-mapping-store.test.ts`
- Modify: `apps/gateway/src/bio/bio-usb-error.ts`

**Interfaces:**

```ts
export interface BioDiscoveredDevice {
  nativeUuid: string;
  deviceUuid: string;
  logicalAddress: number;
  networkId: number;
  firmwareVersion: string;
  rssi: number;
}

export type BioAddressAssignmentResult =
  | { outcome: "confirmed"; device: BioDiscoveredDevice }
  | { outcome: "unchanged"; device: BioDiscoveredDevice }
  | { outcome: "unknown"; code: "BIO_ADDRESS_STATE_UNKNOWN" };
```

- [x] **Step 1: scan aggregation RED 테스트를 작성한다.** discovery notification을 UUID별 최신 RSSI/address로 dedupe하고 scan deadline 뒤 `stopScan`을 finally에서 호출하며, stop ACK가 없으면 성공 list를 반환하지 않는다.

- [x] **Step 2: identify RED 테스트를 작성한다.** 대상 UUID를 현재 scan cache에서 resolve하고 force-on을 보낸 뒤 2초 후 sensor mode를 보낸다. cancel, timeout, thrown error에서도 sensor restore를 최종 시도하고 동일 UUID/address의 sensor-mode report가 없으면 `BIO_IDENTIFY_RESTORE_UNCONFIRMED`로 실패한다.

- [x] **Step 3: mapping journal v2 RED 테스트를 작성한다.** reserved row에 `observedLogicalAddressBeforeAssignment`를 저장하고 v1 confirmed row는 안전하게 읽되 v1 reserved row는 address state unknown으로 처리한다. 같은 command의 identical reservation은 idempotent하고 UUID/address 충돌은 실패한다.

- [x] **Step 4: address reconciliation RED 테스트를 작성한다.** ACK 성공/유실과 무관하게 scan 결과를 아래처럼 판정한다.

| old UUID/address | new UUID/address | 판정 |
| --- | --- | --- |
| 없음 | 동일 UUID/new만 있음 | confirm |
| 동일 UUID/old만 있음 | 없음 | bounded retry 1회 가능 |
| 동일 UUID/old 있음 | 동일 UUID/new 있음 | `BIO_ADDRESS_STATE_UNKNOWN` |
| 없음 | 없음 | `BIO_ADDRESS_STATE_UNKNOWN` |
| 다른 UUID가 new 사용 | 없음 | `BIO_ADDRESS_CONFLICT` |

- [x] **Step 5: verified brightness RED 테스트를 작성한다.** percent `1..100`은 raw high brightness set → force-on → readHighBrightness → readControlMode 순서이며 둘 다 일치해야 applied다. percent `0`은 force-off → readControlMode만 실행한다.

```ts
await expect(client.setOutput(target, 60)).resolves.toEqual({
  brightnessPercent: 60,
  powerOn: true,
  rawHighBrightness: 198,
  mode: "force-on"
});
```

- [x] **Step 6: RED를 확인한다.**

Run: `pnpm --filter @led-control/gateway exec vitest run src/bio/bio-dongle-client.test.ts src/bio/bio-device-mapping-store.test.ts`

- [x] **Step 7: client와 mapping migration을 최소 구현한다.** timeout 뒤 assign write를 즉시 반복하지 않고 `reconcileAddress()`를 먼저 호출한다. old만 확인된 경우에만 동일 command를 최대 한 번 재전송하고 다시 reconcile한다.

- [x] **Step 8: mismatch fault를 명시적으로 보존한다.** high brightness mismatch는 `BIO_BRIGHTNESS_STATE_MISMATCH`, mode mismatch는 `BIO_CONTROL_MODE_STATE_MISMATCH`, 주소 불명은 `BIO_ADDRESS_STATE_UNKNOWN`이다.

- [x] **Step 9: GREEN과 typecheck를 확인한다.**

Run: `pnpm --filter @led-control/gateway exec vitest run src/bio`

Run: `pnpm --filter @led-control/gateway typecheck`

- [x] **Step 10: 커밋한다.**

```bash
git add apps/gateway/src/bio
git commit -m "feat(gateway): verify BIO registration and lighting state"
```

---

### Task 6: BIO adapter and existing registration/control integration

**Files:**
- Create: `apps/gateway/src/adapters/bio-usb-dongle-adapter.ts`
- Create: `apps/gateway/src/adapters/bio-usb-dongle-adapter.test.ts`
- Create: `apps/gateway/src/adapters/bio-sensor-capability-unavailable-port.ts`
- Create: `apps/gateway/src/adapters/bio-sensor-capability-unavailable-port.test.ts`
- Modify: `apps/gateway/src/gateway.ts`
- Modify: `apps/gateway/src/gateway.test.ts`
- Modify: `apps/gateway/src/state/provisioning-device-journal.ts`
- Modify: `apps/gateway/src/state/provisioning-device-journal.test.ts`
- Modify: `apps/gateway/src/commands/gateway-command-handler.test.ts`

**Interfaces:**

```ts
export interface ProvisioningScannerAdapter {
  acceptsDeviceUuid(deviceUuid: string): boolean;
  scan(command: ProvisioningScanStartPayload): Promise<ProvisioningScanFoundDevice[]>;
}
```

- [x] **Step 1: adapter-owned identity RED 테스트를 작성한다.** BlueZ는 기존 DFK UUID만, BIO는 `bio:[0-9a-f]{12}`만 수락한다. `publishProvisioningScanLifecycle`의 전역 `parseDfkDeviceUuid` filter를 제거하고 adapter predicate를 사용한다.

- [x] **Step 2: provisioning RED 테스트를 작성한다.** `meshAddress`를 `0x0001..0x7fff`로 parse하고, scan cache 대상 확인 → 2초 identify/restore → mapping reserve → UUID address assignment → 신규 address 동일 UUID 확인 → mapping confirm → completed payload 순서만 허용한다.

- [x] **Step 3: restart recovery RED 테스트를 작성한다.** durable provisioning command가 accepted 상태로 복구될 때 confirmed mapping은 동일 terminal로 수렴하고, reserved mapping은 old/new scan reconciliation 결과로만 수렴한다.

- [x] **Step 4: individual/group control RED 테스트를 작성한다.** confirmed mapping만 제어하고 group은 bounded concurrency `4`의 unicast로 실행한다. 각 fixture의 read-back 결과를 별도 report로 반환한다.

```ts
expect(report).toEqual({
  fixtureId: "fixture-1",
  acknowledged: true,
  outcome: "applied",
  brightness: 60,
  rssi: -41,
  hopCount: null
});
```

- [x] **Step 5: sensor capability RED 테스트를 작성한다.** source 목록은 빈 배열이고 configure/send는 `bio_sensor_cloud_unsupported`로 실패한다. BIO provisioning 완료 뒤 vehicle capability refresh를 enqueue하지 않는다.

- [x] **Step 6: RED를 확인한다.**

Run: `pnpm --filter @led-control/gateway exec vitest run src/adapters/bio-usb-dongle-adapter.test.ts src/adapters/bio-sensor-capability-unavailable-port.test.ts src/gateway.test.ts src/state/provisioning-device-journal.test.ts src/commands/gateway-command-handler.test.ts`

- [x] **Step 7: 세 기존 port와 virtual group membership을 구현한다.** native BIO group 가입 성공을 가장하지 않고 confirmed local membership만 저장한다.

- [x] **Step 8: fault propagation과 fixture observation을 연결한다.** read-back mismatch는 관측 brightness/mode를 포함한 failed report로 전달하고 outer ACK만 받은 상태는 fixture-state를 발행하지 않는다.

- [x] **Step 9: GREEN을 확인한다.**

Run: `pnpm --filter @led-control/gateway exec vitest run src/adapters/bio-usb-dongle-adapter.test.ts src/adapters/bio-sensor-capability-unavailable-port.test.ts src/gateway.test.ts src/state/provisioning-device-journal.test.ts src/commands/gateway-command-handler.test.ts`

- [x] **Step 10: 커밋한다.**

```bash
git add apps/gateway/src/adapters apps/gateway/src/gateway.ts apps/gateway/src/gateway.test.ts apps/gateway/src/state/provisioning-device-journal* apps/gateway/src/commands/gateway-command-handler.test.ts
git commit -m "feat(gateway): integrate BIO registration and lighting control"
```

---

### Task 7: Factory, lifecycle and adapter-aware health

**Files:**
- Modify: `apps/gateway/src/adapters/adapter-factory.ts`
- Modify: `apps/gateway/src/adapters/adapter-factory.test.ts`
- Modify: `apps/gateway/src/index.ts`
- Modify: `apps/gateway/src/index.test.ts`
- Modify: `apps/gateway/src/health/appliance-health.ts`
- Modify: `apps/gateway/src/health/appliance-health.test.ts`
- Modify: `apps/gateway/docker/healthcheck-state.cjs`
- Modify: `apps/gateway/docker/healthcheck-state.test.mjs`

**Interfaces:**

```ts
export type GatewayAdapterKind = "bluez" | "bio-usb";

export interface GatewayAdapters {
  adapterKind: GatewayAdapterKind;
  dimming: BleMeshAdapter;
  scanner: ProvisioningScannerAdapter;
  provisioning: ProvisioningAdapter;
  vehicleSensors: VehicleSensorMeshPort;
  vehicleSensorCloudSupported: boolean;
  healthProbes: ApplianceHealthProbes;
  stop(): Promise<void>;
}
```

- [x] **Step 1: factory RED 테스트를 작성한다.** `bluez`는 Company ID를 계속 요구하고 `bio-usb`는 Company ID/D-Bus를 요구하지 않으며 exact USB client, mapping path, timeout/scan settings를 생성한다. 누락/unknown adapter는 실패한다.

- [x] **Step 2: discriminated health RED 테스트를 작성한다.** BIO는 `transportConnected`, `protocolReady`, `mappingValid`, MQTT, heartbeat freshness가 모두 true여야 healthy이고 `dbusOwner`/`bluezAttached`를 호출하지 않는다. BlueZ 판정은 기존과 동일하다.

- [x] **Step 3: shutdown RED 테스트를 작성한다.** SIGTERM/SIGINT에서 MQTT intake 중지 후 adapter `stop()`이 USB poll/release/reattach를 완료해야 process shutdown이 끝난다.

- [x] **Step 4: RED를 확인한다.**

Run: `pnpm --filter @led-control/gateway exec vitest run src/adapters/adapter-factory.test.ts src/index.test.ts src/health/appliance-health.test.ts`

Run: `node --test apps/gateway/docker/healthcheck-state.test.mjs`

- [x] **Step 5: factory, conditional vehicle sensor refresh, lifecycle과 health JSON을 구현한다.** health log는 `adapterKind`와 boolean 상태만 포함하고 descriptor raw path나 protocol payload를 포함하지 않는다.

- [x] **Step 6: GREEN과 build를 확인한다.**

Run: `pnpm --filter @led-control/gateway exec vitest run src/adapters/adapter-factory.test.ts src/index.test.ts src/health/appliance-health.test.ts`

Run: `node --test apps/gateway/docker/healthcheck-state.test.mjs`

Run: `pnpm --filter @led-control/gateway typecheck && pnpm --filter @led-control/gateway build`

- [x] **Step 7: 커밋한다.**

```bash
git add apps/gateway/src/adapters/adapter-factory* apps/gateway/src/index* apps/gateway/src/health apps/gateway/docker/healthcheck-state*
git commit -m "feat(gateway): start and monitor the BIO USB adapter"
```

---

### Task 8: Non-root raw USB deployment and MQTT baseline recovery

**Files:**
- Create: `apps/gateway/compose.bio-usb.yml`
- Create: `scripts/gateway-bio-usb-preflight.sh`
- Create: `scripts/gateway-bio-usb-preflight.test.mjs`
- Modify: `apps/gateway/docker/entrypoint.sh`
- Modify: `apps/gateway/docker/compose-contract.test.mjs`
- Modify: `apps/gateway/docker/container-contract.test.mjs`
- Modify: `apps/gateway/.env.appliance.example`
- Modify: `scripts/gateway-appliance-deploy.sh`
- Modify: `scripts/gateway-appliance-scripts.test.mjs`
- Modify: `scripts/dev-runtime.mjs`
- Modify: `scripts/dev-runtime.test.mjs`
- Modify: `infra/mosquitto.acl.example`

**Interfaces:**
- Preflight output env: `GATEWAY_BIO_USB_DEVICE=/dev/bus/usb/<bus>/<device>`
- Preflight output env: `GATEWAY_BIO_USB_GID=<numeric gid>`
- Compose mapping: `${GATEWAY_BIO_USB_DEVICE}:${GATEWAY_BIO_USB_DEVICE}:rwm`
- Compose group: `${GATEWAY_BIO_USB_GID}`

- [x] **Step 1: compose/preflight RED contracts를 작성한다.** exact-one `1a86:5523`, character device, sysfs descriptor 일치, numeric GID를 검사한다. whole `/dev`, whole `/dev/bus/usb`, privileged, root user가 있으면 실패한다.

- [x] **Step 2: entrypoint branch RED 테스트를 작성한다.** `bio-usb`는 dbus-daemon, btmgmt, bluetooth-meshd, HCI 설정을 실행하지 않고 `gateway` user로 Node만 시작한다. `bluez` branch는 기존 startup을 유지한다.

- [x] **Step 3: RED를 확인한다.**

Run: `node --test apps/gateway/docker/compose-contract.test.mjs apps/gateway/docker/container-contract.test.mjs scripts/gateway-bio-usb-preflight.test.mjs scripts/gateway-appliance-scripts.test.mjs scripts/dev-runtime.test.mjs`

- [x] **Step 4: overlay와 preflight를 구현한다.** USB bus/device 번호가 바뀌면 old path를 재사용하지 않고 preflight가 새 path를 계산한 뒤 Gateway service만 recreate한다.

- [x] **Step 5: deploy script에 `--adapter bio-usb`를 추가한다.** base compose와 BIO overlay를 함께 전달하고 preflight 성공 뒤에만 `docker compose up -d`를 실행한다. rollback용 기존 image tag와 compose/env backup을 먼저 기록한다.

- [x] **Step 6: ACL을 확인한다.** 기존 provisioning device-terminal application ACK는 read-only, acceptance/device-status는 write-only라는 방향을 유지한다. BIO를 이유로 wildcard ACL을 추가하지 않는다.

- [x] **Step 7: GREEN을 확인한다.**

Run: `node --test apps/gateway/docker/compose-contract.test.mjs apps/gateway/docker/container-contract.test.mjs scripts/gateway-bio-usb-preflight.test.mjs scripts/gateway-appliance-scripts.test.mjs scripts/dev-runtime.test.mjs`

- [x] **Step 8: `systematic-debugging`으로 Gateway의 기존 `.lan` MQTT assignment를 조사한다.** API 설치 원장의 intended broker hostname과 비교한 뒤 DNS → TCP 8883 → TLS SAN/mTLS → MQTT CONNACK 순서로 확인한다. 원장 값이 잘못된 경우에만 해당 scope의 assignment를 수정한다.

- [ ] **Step 9: 운영 container를 바꾸기 전에 MQTT healthy heartbeat 3회를 확인한다.** baseline 복구가 실패하면 BIO full deployment를 중단하고 원인과 rollback 상태를 기록한다.

- [x] **Step 10: 커밋한다.**

```bash
git add apps/gateway/compose.bio-usb.yml apps/gateway/docker apps/gateway/.env.appliance.example infra/mosquitto.acl.example scripts/gateway-bio-usb-preflight* scripts/gateway-appliance-deploy.sh scripts/gateway-appliance-scripts.test.mjs scripts/dev-runtime.mjs scripts/dev-runtime.test.mjs
git commit -m "feat(gateway): deploy one BIO raw USB device safely"
```

---

### Task 8a: Lab MQTT DNS/SAN baseline recovery

**Files:**
- Evidence only, Git-ignored: `.superpowers/sdd/2026-09-13-bio-direct-usb-registration-control/task-8a-mqtt-recovery/`
- Modify when state changes: `docs/project-status.md`
- Modify when a repeatable gap is found: `docs/lesson_leared.md`
- Modify only if an automation defect is reproduced: `scripts/pki/bootstrap-device-lab.sh`, `scripts/pki/bootstrap-device-lab.test.mjs`, `scripts/lan-tls-integration.test.mjs`, `scripts/dev.mjs`, `scripts/dev-runtime.mjs`, corresponding tests

**Recovery boundary:**
- Current LAN address, `lab.env`, service certificate SAN, running API/MQTT environment, Pi host resolution and container resolution must describe the same `api.led.lan` / `mqtt.led.lan` endpoint.
- Preserve DB Site/Gateway IDs, claim state, device identity and Gateway client certificate.
- Back up current Lab PKI service generation metadata, Pi hosts/compose/env/data and running container metadata before mutation; never record private key/token contents.
- Do not deploy the BIO image or execute any lamp write in this task.

- [x] **Step 1: Phase-1 evidence를 다시 수집한다.** 현재 Mac LAN IP, local listeners/processes, effective `MQTT_URL`, current MQTT certificate DNS/IP SAN, Pi와 running container의 `getent`, TCP 8883, TLS hostname/mTLS, Gateway health/heartbeat를 순서대로 재현한다.

- [x] **Step 2: 단일 root-cause hypothesis를 확정한다.** API/MQTT 실행 환경, Lab certificate generation, Pi host mapping 가운데 불일치한 경계를 명시하고 변경 전 증거 SHA-256을 기록한다.

- [x] **Step 3: 자동화 결함이 있으면 RED를 먼저 작성한다.** 기존 runbook만으로 올바르게 복구되면 제품 코드를 바꾸지 않는다. 재현 가능한 script 결함이 있을 때만 failing contract를 만든 뒤 최소 수정한다. 이번 조사에서는 자동화 결함보다 현재 DB의 target Site/Gateway 관계 부재가 선행 차단 원인으로 확인되어 제품 코드를 변경하지 않았다.

- [ ] **Step 4: rollback 자료를 만든다.** Lab PKI current generation과 실행 env의 비밀 원문을 출력하지 않고 권한 제한 backup을 만들며, Pi `/etc/hosts`, compose/env/data와 container ID/image/StartedAt/restart count를 보존한다.

- [ ] **Step 5: 현재 LAN IP로 Lab PKI와 runtime을 복구한다.** `LAB_API_IP`와 `LAB_MQTT_IP`를 같은 검증된 LAN IP로 사용해 `lab:pki:bootstrap`을 실행하고 새 `lab.env`로 API/MQTT를 재기동한다. 기존 DB, claim, Gateway device/client identity는 초기화하거나 재발급하지 않는다.

- [ ] **Step 6: Pi와 container name resolution을 복구한다.** Pi의 두 `.led.lan` 이름을 같은 LAN IP로 원자 갱신하고, 기존 image와 data를 유지한 채 Gateway service만 재생성해 container 내부 resolution을 갱신한다.

- [ ] **Step 7: DNS → TCP → TLS SAN/mTLS → MQTT CONNACK을 확인한다.** 어느 단계든 실패하면 후속 BIO 배포와 HIL을 중단하고 rollback 또는 보존 상태를 기록한다.

- [ ] **Step 8: 서로 다른 healthy heartbeat 3회를 확인한다.** API DB의 `lastHeartbeatAt` 증가, Gateway health와 container lifecycle을 함께 대조한다.

- [x] **Step 9: 문서와 증거를 갱신하고 커밋한다.** `docs/project-status.md`, Task 8 Step 9와 이 체크리스트를 실제 결과와 일치시킨다. Task 8의 healthy heartbeat Step 9는 미완료로 유지한다.

---

### Task 8b: Cancelled admin3 Lab reset

> **Cancelled before mutation:** 사용자가 destructive reset을 `admin4` 별도 설치로 대체했다. operator 인증 Session 1건 외에는 `DELETE /operator/site-admins/:userId`와 `POST /operator/site-admins`가 호출되지 않았고, `admin3` organization/Site/User/Floor/Fixture/Gateway graph는 그대로 보존됐다. 아래 체크리스트는 실행하지 않는다.

**User-approved destructive boundary:**
- `admin3`이 소유한 customer organization, its only Site and all Site-owned data, `admin3`, and the one additional User in the same organization may be deleted without a recoverable backup.
- Unrelated organizations, Sites, Users, inventories, certificates, database schemas and services are out of scope.
- Do not reset the BIO dongle or lamp module and do not send address/brightness/identify/sensor writes.
- Store new temporary admin password and claim code only in a local Git-ignored mode `0600` handoff file; never print them in logs or evidence.

- [ ] **Step 1: destructive preflight를 실행한다.** canonical `admin3`가 active admin exact-one이고 organization exact-one/Site exact-one인지, unrelated scope와 분리됐는지 read-only transaction으로 다시 확인한다. 복구본 대신 hash/count manifest만 기록한다.

- [ ] **Step 2: 기존 제품 operator 삭제 경로를 사용한다.** 삭제 전 현재 session에서 target hash/count를 재확인하고, Site report object cleanup과 연결된 certificate/inventory cleanup을 포함한 제품 API를 실행한다. 직접 cascade SQL로 우회하지 않는다.

- [ ] **Step 3: 삭제 후 경계를 검증한다.** target organization/Site/admin/other-user와 종속 행이 제거됐고 unrelated aggregate가 유지됐는지 확인한다. 외부 object와 revocation/cleanup 실패가 있으면 새 설치를 중단한다.

- [ ] **Step 4: 새 admin3 설치 주체를 만든다.** 기존 operator API로 새 organization, pending Site, `admin3` admin을 만들고 temporary password를 `0600` handoff file에 기록한다. 비밀번호 원문은 DB/Git/명령 출력에 남기지 않는다.

- [ ] **Step 5: 기존 orphan identity를 폐기하고 Pi를 새 manufacturing identity로 등록한다.** old device/MQTT certificates를 제품 PKI 경로로 revoke/replace하고 새 serial/device identity를 사용한다. old certificate를 새 Gateway ID에 재결속하지 않는다.

- [ ] **Step 6: 새 Site의 initial setup과 Gateway claim/bootstrap을 완료한다.** 새 one-time claim code를 제품 API로 한 번만 사용하고, claim 성공 후 원문을 폐기한다. floor가 없으면 조명 등록이 불가능하므로 최소 한 층을 제품 setup API로 생성한다.

- [ ] **Step 7: Task 8a LAN/PKI/MQTT 복구를 다시 실행한다.** current LAN, hosts, SAN/CRL, runtime broker, Pi/container DNS를 일치시키고 DNS → TCP → TLS/mTLS → MQTT CONNACK을 검증한다.

- [ ] **Step 8: healthy heartbeat 3회를 확인한다.** 새 Gateway ID의 API DB timestamp 증가, Gateway health와 container lifecycle을 대조한다.

- [ ] **Step 9: 상태판·메뉴·교훈·계획을 실제 결과로 갱신하고 커밋한다.** reset/re-enrollment과 BIO deployment/HIL 완료를 구분한다.

---

### Task 8c: Separate admin4 Lab installation and Gateway re-enrollment

**User-approved boundary:**
- 기존 `admin3` organization/Site/User/device graph는 변경하거나 삭제하지 않는다.
- 기존 operator API로 독립된 customer organization, pending Site, canonical `admin4` admin을 새로 만든다.
- temporary password와 claim code는 Git-ignored mode `0600` local handoff file에만 저장하고 로그·증거·문서에 원문을 남기지 않는다.
- BIO dongle/lamp module에는 address/brightness/identify/sensor write를 보내지 않는다.

- [x] **Step 1: 생성 직전 경계를 재검증한다.** canonical `admin4`가 0건이고 `admin3` identity/organization/Site 핵심 해시와 건수가 유지되는지 read-only transaction으로 확인했다.

- [x] **Step 2: 기존 operator create API로 admin4 Lab을 만든다.** 별도 customer organization + pending Site + active admin을 transaction으로 생성했고, strong temporary password는 ignored mode `0600` handoff file에만 기록했다.

- [x] **Step 3: 생성 결과와 admin3 보존을 검증한다.** `admin4` exact-one, pending Site/Floor 0, 새 organization 분리와 `admin3` 기존 graph 불변을 확인했다. `admin3`의 Floor 2/Fixture 400/Gateway 2는 유지됐다.

- [x] **Step 4: manufacturing보다 먼저 Lab LAN/API/PKI를 복구한다.** CA identity를 유지한 채 current LAN IP SAN의 API/MQTT service certificate, device/MQTT/manufacturing CRL과 application token을 갱신했다. Pi name resolution, API HTTPS/station mTLS, MQTT TLS를 검증했고 main DB migration은 69/69·적용 0건이다. Mac hosts는 관리자 권한이 없어 변경하지 않고 Mac-side URL을 current IP로 명시한다.

- [ ] **Step 5: orphan certificate를 폐기하고 Pi를 새 manufacturing identity로 등록한다.** old inventory exact-one과 admin3 무관성을 확인한 뒤 제품 disable/reconciliation 경로로 device·MQTT certificate와 CRL 폐기를 완료한다. old certificate를 새 Gateway ID에 재결속하지 않고, 기존 data root와 분리된 `/data-admin4`에 새 serial/device identity와 one-time claim code를 생성한다.

- [ ] **Step 6: admin4 initial setup과 Gateway claim/bootstrap을 완료한다.** 최소 한 층을 만들고 새 claim code를 한 번만 사용하며 성공 후 원문을 폐기한다. 새 runtime은 `/data-admin4/{identity,gateway,mesh}`만 사용하고 DNS → TCP → TLS/mTLS → MQTT CONNACK을 검증한다.

- [ ] **Step 7: healthy heartbeat 3회를 확인한다.** 새 Gateway ID의 DB timestamp 증가와 Gateway/container health를 대조한다.

- [ ] **Step 8: 상태판·메뉴·교훈·계획을 실제 결과로 갱신하고 커밋한다.** admin4 설치, Gateway baseline, BIO deployment/HIL 완료 여부를 분리해 기록한다.

---

### Task 9: Approved single-device address and control HIL

**Files:**
- Create: `apps/gateway/scripts/bio-registration-hil.ts`
- Create: `apps/gateway/scripts/bio-registration-hil.test.ts`
- Evidence only, Git-ignored: `.superpowers/sdd/2026-09-12-bio-usb-dongle-gateway-adapter/address-control-hil/`
- Modify: `.superpowers/sdd/2026-09-12-bio-usb-dongle-gateway-adapter/progress.md`
- Modify: `.superpowers/sdd/2026-09-12-bio-usb-dongle-gateway-adapter/task-4-report.md`

**Interfaces:**
- Dry-run output: redacted UUID fingerprint, observed old address, requested new address, network ID
- Required input: exact fingerprint + old address + new address confirmation
- Safety restore: final sensor mode attempt on every exit path

- [x] **Step 1: HIL CLI safety RED 테스트를 작성한다.** dry-run 외에는 `--fingerprint`, `--old-address`, `--new-address`, `--confirm-address-change`가 모두 정확히 일치해야 한다. factory reset/password/arbitrary hex option은 제공하지 않는다.

- [x] **Step 2: CLI를 구현하고 dry-run으로 한 장치만 선택한다.** multiple discovery, duplicate UUID, address collision은 모두 실패한다.

- [x] **Step 2a: HIL 전용 임시 mapping/data 경로를 사용한다.** production `/var/lib/led-control/bio-device-mappings.json`과 API provisioning journal에는 쓰지 않아 Task 10의 Web 등록이 최초 등록 흐름을 그대로 검증하게 한다.

- [ ] **Step 3: 사용자에게 dry-run의 redacted fingerprint와 old/new address를 제시하고 명시 확인을 받는다.** 확인 전에는 address write를 실행하지 않는다.

- [ ] **Step 4: 승인된 한 장치에서 address assignment를 정확히 한 번 실행한다.** outer ACK 상태와 무관하게 scan으로 동일 UUID/new address를 재확인한다. unknown이면 같은 write를 자동 재전송하지 않는다.

- [ ] **Step 5: 신규 주소에서 read-only high brightness/control mode getter를 검증한다.** `0x4f/0x13`과 `0x4f/0x12` 응답의 UUID/address가 대상과 일치해야 한다.

- [ ] **Step 6: `0, 20, 60, 90, 100%`를 순서대로 적용하고 매 단계 read-back과 육안 반응을 확인한다.** 각 단계 사이에 sensor mode restore를 실행하고 마지막에도 restore를 확인한다.

- [ ] **Step 7: Gateway process를 재시작하고 confirmed mapping으로 같은 UUID/address를 복구한 뒤 20%→sensor restore를 한 번 재검증한다.**

- [ ] **Step 8: raw identity/payload를 제거한 HIL report와 SHA-256을 기록한다.** 장치가 한 대이므로 multi-device group 결과는 `보류(장비 부족)`로 기록한다.

- [x] **Step 9: 커밋한다.**

```bash
git add apps/gateway/scripts/bio-registration-hil.ts apps/gateway/scripts/bio-registration-hil.test.ts
git commit -m "test(gateway): add guarded BIO registration HIL"
```

---

### Task 10: Web-only end-to-end registration, documentation and final verification

**Files:**
- Modify: `apps/gateway/README.md`
- Modify: `docs/runbooks/raspberry-pi-gateway-appliance.md`
- Modify: `docs/menus/settings.md`
- Modify: `docs/menus/control.md`
- Modify: `docs/menus/monitoring.md`
- Modify: `docs/project-status.md`
- Modify: `docs/lesson_leared.md`
- Modify: `docs/superpowers/plans/2026-09-12-bio-usb-dongle-gateway-adapter.md`
- Modify: `docs/superpowers/plans/2026-09-13-bio-direct-usb-registration-control.md`

**Completion flow:**

```text
Web 검색 시작
→ API scan command
→ Gateway direct USB scan
→ bio:<uuid> 검색 결과
→ Web 2초 식별 확인
→ API address 예약
→ Gateway UUID 대상 주소 할당
→ 동일 UUID/new address 재발견
→ confirmed mapping
→ provisioning terminal application ACK
→ Web 등록 완료
→ Web 0/20/60/90/100% 제어
→ Gateway read-back
→ API fixture state 반영
```

- [ ] **Step 1: 새 BIO image를 production Gateway에 배포한다.** backup한 image/compose/env/data snapshot을 유지하고 `privileged=false`, exact device 한 개, non-root process, BlueZ 미기동을 확인한다.

- [ ] **Step 2: 제조사 앱과 휴대폰을 사용하지 않은 상태에서 Web 등록 세션을 시작한다.** 검색 목록의 BIO 조명을 선택하고 2초 점등/복귀를 확인한 뒤 등록을 확정한다.

- [ ] **Step 3: API/Gateway/Web terminal 상태를 대조한다.** mapping은 confirmed, provisioning session/node는 provisioned, fixture/mesh node는 예약 address, application ACK는 journal에서 제거된 상태여야 한다.

- [ ] **Step 4: Web 제어에서 `0/20/60/90/100%`를 실행한다.** 각 device-status가 applied이고 read-back 기반 fixture state/DB/UI 값이 일치해야 한다.

- [ ] **Step 5: USB 탈착 복구를 검증한다.** stale raw node에서는 health가 실패해야 하고 host preflight가 새 node로 Gateway service만 recreate한 뒤 mapping과 제어를 복구해야 한다.

- [ ] **Step 6: duplicate MQTT delivery를 검증한다.** 같은 idempotency key의 provisioning/dimming command가 두 번 전달돼도 address write와 물리 dimming write를 다시 실행하지 않아야 한다.

- [ ] **Step 7: 관련 메뉴 문서를 갱신한다.** 설정에는 제조사 앱 없는 BIO 검색·식별·등록, 제어에는 exact brightness mapping/read-back, 모니터링에는 confirmed registration 뒤 상태 표시와 sensor-cloud 제외를 각각 `구현 완료`, `미구현`, `부족하거나 개선이 필요한 기능`, `관련 파일`, `갱신 규칙` 구조로 반영한다.

- [ ] **Step 8: runbook과 상태 문서를 갱신한다.** exact USB preflight, replug recreate, rollback, HIL 증거, 단일 장치 한계, 2-node/72시간 soak 미완료 여부를 사실대로 기록한다. DB schema는 변경하지 않았으므로 `docs/database-schema.md`는 수정하지 않는다.

- [ ] **Step 9: 전체 자동 검증을 실행한다.**

Run: `pnpm --filter @led-control/shared test`

Run: `pnpm --filter @led-control/api typecheck && pnpm --filter @led-control/api test -- --runInBand && pnpm --filter @led-control/api build`

Run: `pnpm --filter @led-control/gateway test && pnpm --filter @led-control/gateway test:contracts && pnpm --filter @led-control/gateway typecheck && pnpm --filter @led-control/gateway build`

Run: `pnpm --filter @led-control/web test && pnpm --filter @led-control/web build`

Run: `git diff --check`

- [ ] **Step 10: `verification-before-completion`으로 evidence를 재검토한다.** software test, read-only USB HIL, address HIL, Web E2E를 각각 독립 판정하고 한 단계라도 실패하면 전체 호환 완료로 표시하지 않는다.

- [ ] **Step 11: 문서와 최종 상태를 커밋한다.**

```bash
git add apps/gateway/README.md docs .superpowers/sdd/2026-09-12-bio-usb-dongle-gateway-adapter/progress.md .superpowers/sdd/2026-09-12-bio-usb-dongle-gateway-adapter/task-4-report.md
git commit -m "docs: record app-free BIO registration and control validation"
```

## Plan Self-Review

- [ ] 모든 1차 포함 범위가 Task 1~10 중 하나에 연결됐는지 spec과 대조한다.
- [ ] 제조사 앱/휴대폰 production dependency가 코드, compose, runbook에 남아 있지 않은지 검색한다.
- [ ] `serialport`, `NodeSerialConnection`, `BioSerialTransport` production import가 남아 있지 않은지 검색한다.
- [ ] `percent * 2.55`, 임의 raw brightness rounding, ACK-only applied 처리가 없는지 검색한다.
- [ ] address assignment retry 전에 reconciliation이 강제되는지 unit/HIL 양쪽에서 확인한다.
- [ ] 미완성 표식, 임시 mock success, 가짜 evidence hash가 계획과 구현에 없는지 검색한다.
- [ ] `BioByteConnection`, `BioUsbTransport`, `BioDirectUsbConnection`, adapter factory type이 서로 일치하는지 typecheck로 확인한다.
- [ ] `/dev`, `/dev/bus/usb` whole mount, privileged, root Node 실행이 contract test로 금지되는지 확인한다.
- [ ] 설정·제어·모니터링 메뉴 문서가 실제 software/HIL 상태와 동일한지 확인한다.
