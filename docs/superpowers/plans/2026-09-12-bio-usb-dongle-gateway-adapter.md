# BIO USB 동글 Gateway Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 실제 `1a86:5523` BIO USB-UART 동글로 센서통신모듈을 검색·등록하고 기존 서비스에서 개별·그룹 밝기와 점멸을 안전하게 제어한다.

**Architecture:** 기존 Web/API/MQTT durability 계약을 유지하고 Gateway 내부에 frame codec, serial transport, durable mapping, `BioUsbDongleAdapter`를 추가한다. 기본 BlueZ 경로는 보존하며 1차 배포는 `GATEWAY_ADAPTER=bio-usb` 전용 모드로 수행한다. 확인되지 않은 opcode는 APK 추정값으로 넣지 않고 제조사 문서 또는 격리망 golden trace로만 활성화한다.

**Tech Stack:** TypeScript, Node.js 22, Vitest, Jest, `serialport@13.0.0`, MQTT QoS 1, Docker Compose, Raspberry Pi OS aarch64, CH34x USB-UART

**Spec:** `docs/superpowers/specs/2026-09-12-bio-usb-dongle-gateway-adapter-design.md`

## Global Constraints

- 기존 `GATEWAY_ADAPTER=bluez` 코드와 테스트 계약을 유지한다.
- 1차는 BIO 전용이며 BlueZ/BIO hybrid와 cloud sensor telemetry를 구현하지 않는다.
- `/dev` 전체 mount, `privileged=true`, root Node process를 사용하지 않는다.
- 실장비는 `1a86:5523`가 정확히 한 대일 때만 허용한다. `iSerial=0`이므로 다중 동글은 fail-closed한다.
- USB ACK만으로 `applied`를 반환하지 않고 밝기 read-back 일치를 요구한다.
- 주소 변경, factory reset, 비밀번호 변경은 계획에 명시된 승인 관문 밖에서 실행하지 않는다.
- raw payload와 자격 증명을 일반 로그·Git·HIL 보고서에 남기지 않는다.
- API/DB/MQTT, Gateway, 문서 공유 경계는 아래 작업 순서대로 변경한다.

---

### Task 1: V2 provisioning device terminal ingest와 application ACK

**Files:**
- Create: `apps/api/src/mqtt/provisioning-device-terminal.service.ts`
- Create: `apps/api/src/mqtt/provisioning-device-terminal.service.spec.ts`
- Create: `apps/api/src/mqtt/provisioning-device-terminal.integration.spec.ts`
- Modify: `apps/api/src/mqtt/mqtt.service.ts`
- Modify: `apps/api/src/mqtt/mqtt.service.spec.ts`
- Modify: `apps/api/src/mqtt/mqtt.module.ts`
- Modify: `apps/api/src/automation/automation-outbox-publisher.service.spec.ts`
- Modify: `apps/web/e2e/support/real-backend-lab.ts`
- Modify: `apps/web/e2e/provisioning-real-backend.spec.ts`

**Interfaces:**
- Consumes: `ProvisioningDeviceTerminalV2`, `ProvisioningDeviceOutbox`, `ProcessedGatewayEvent`, generic `MqttOutbox`
- Produces: `ProvisioningDeviceTerminalService.ingest(scope, event, receivedAt)`와 ACK key `provisioning-device-terminal:<gatewayId>:<commandId>`

- [x] **Step 1: completed/failed/duplicate/conflict/rollback RED 테스트를 작성한다.** Exact stored command identity, fixed event type `provisioning_device_terminal`, sequence, tenant, event hash와 altered terminal 거부를 각각 검증한다.
- [x] **Step 2: focused test가 새 service 부재로 실패하는지 확인한다.**

Run: `pnpm --filter @led-control/api test -- --runInBand src/mqtt/provisioning-device-terminal.service.spec.ts src/mqtt/mqtt.service.spec.ts`

Expected: 신규 service import 또는 V2 subscription 기대가 실패한다.

- [x] **Step 3: 한 transaction에서 row lock, stored command 대조, domain 전이, ledger, ACK outbox를 구현한다.** completed는 기존 fixture/group 연결 helper를 재사용하고 failed/unknown은 `reconcile_required`로 수렴한다.
- [x] **Step 4: MQTT exact topic을 subscribe/route하고 legacy completed/failed를 유지한다.** DB commit 뒤에만 QoS 1 PUBACK이 가능해야 한다.
- [x] **Step 5: generic application ACK publisher 회귀를 추가한다.**
- [x] **Step 6: real-backend lab을 V2 terminal publish/application ACK 대기로 전환한다.** Legacy terminal만으로 성공을 확정하지 않는 E2E 회귀를 추가한다.
- [x] **Step 7: 단위·격리 PostgreSQL·real-backend 계약 테스트를 통과시킨다.**

Run: `pnpm --filter @led-control/api test -- --runInBand src/mqtt/provisioning-device-terminal.service.spec.ts src/mqtt/mqtt.service.spec.ts src/automation/automation-outbox-publisher.service.spec.ts`

- [x] **Step 8: 커밋한다.**

```bash
git add apps/api/src/mqtt apps/api/src/automation/automation-outbox-publisher.service.spec.ts apps/web/e2e/support/real-backend-lab.ts apps/web/e2e/provisioning-real-backend.spec.ts
git commit -m "feat(api): ingest provisioning device terminals"
```

### Task 2: BIO identity와 durable mapping

**Files:**
- Create: `apps/gateway/src/bio/bio-device-identity.ts`
- Create: `apps/gateway/src/bio/bio-device-identity.test.ts`
- Create: `apps/gateway/src/bio/bio-device-mapping-store.ts`
- Create: `apps/gateway/src/bio/bio-device-mapping-store.test.ts`

**Interfaces:**
- Produces: `parseBioDeviceUuid`, `formatBioDeviceUuid`, `BioDeviceMappingStore`
- Mapping key: `fixtureId`, `nodeId`, `deviceUuid`, `nativeUuid`, `logicalAddress`, firmware, protocol, status, updatedAt

- [ ] **Step 1: `bio:[0-9a-f]{12}` 정규화와 mapping 충돌·복구 RED 테스트를 작성한다.** 주소 범위는 `0x0001..0x7fff`이며 duplicate fixture/UUID/address, corrupt file, reserved/confirmed 분리를 포함한다.
- [ ] **Step 2: RED를 확인한다.**

Run: `pnpm --filter @led-control/gateway exec vitest run src/bio/bio-device-identity.test.ts src/bio/bio-device-mapping-store.test.ts`

- [ ] **Step 3: 기존 atomic JSON storage helper를 재사용해 구현한다.** `listConfirmed()`와 lookup은 reserved mapping을 반환하지 않는다.
- [ ] **Step 4: GREEN과 restart recovery를 확인한다.**
- [ ] **Step 5: 커밋한다.**

```bash
git add apps/gateway/src/bio/bio-device-identity* apps/gateway/src/bio/bio-device-mapping-store*
git commit -m "feat(gateway): add durable BIO device mapping"
```

### Task 3: BIO frame codec와 resilient serial transport

**Files:**
- Create: `apps/gateway/src/bio/bio-frame-codec.ts`
- Create: `apps/gateway/src/bio/bio-frame-codec.test.ts`
- Create: `apps/gateway/src/bio/bio-usb-error.ts`
- Create: `apps/gateway/src/bio/node-serial-connection.ts`
- Create: `apps/gateway/src/bio/node-serial-connection.test.ts`
- Create: `apps/gateway/src/bio/linux-usb-identity-inspector.ts`
- Create: `apps/gateway/src/bio/linux-usb-identity-inspector.test.ts`
- Create: `apps/gateway/src/bio/bio-serial-transport.ts`
- Create: `apps/gateway/src/bio/bio-serial-transport.test.ts`
- Modify: `apps/gateway/package.json`
- Modify: `pnpm-lock.yaml`

**Interfaces:**
- Produces: `BioFrameCodec.push/reset`, typed endian encoders, `BioSerialTransport.start/request/stop/snapshot/onState`
- Protocols: `crc16 | gs`; probes are exact literals `55aa82000000`, `4753820000`

- [ ] **Step 1: CRC/GS, split/merge/noise/corruption/length RED 테스트를 작성한다.** CRC는 init `ffff`, polynomial `a001`, low byte first다. GS는 command~payload sum의 carry를 접고 보수한다.
- [ ] **Step 2: serial 설정·VID/PID·one-in-flight·generation·timeout/reconnect RED 테스트를 작성한다.** `115200 8N1`, no flow control, `300ms`, `2s→32s`를 고정한다.
- [ ] **Step 3: RED를 확인한다.**

Run: `pnpm --filter @led-control/gateway exec vitest run src/bio/bio-frame-codec.test.ts src/bio/node-serial-connection.test.ts src/bio/linux-usb-identity-inspector.test.ts src/bio/bio-serial-transport.test.ts`

- [ ] **Step 4: `serialport@13.0.0`과 codec/transport를 최소 구현한다.** timeout 또는 malformed frame은 generation을 폐기하고 reconnect 전에 queued write를 자동 재실행하지 않는다.
- [ ] **Step 5: GREEN, typecheck와 build를 확인한다.**

Run: `pnpm --filter @led-control/gateway typecheck && pnpm --filter @led-control/gateway build`

- [ ] **Step 6: 커밋한다.**

```bash
git add apps/gateway/src/bio apps/gateway/package.json pnpm-lock.yaml
git commit -m "feat(gateway): add BIO serial protocol transport"
```

### Task 4: 승인된 golden trace와 high-level command client

**Files:**
- Create: `apps/gateway/test/fixtures/bio-protocol-v1.json`
- Create: `apps/gateway/src/bio/bio-command-codec.ts`
- Create: `apps/gateway/src/bio/bio-command-codec.test.ts`
- Create: `apps/gateway/src/bio/bio-dongle-client.ts`
- Create: `apps/gateway/src/bio/bio-dongle-client.test.ts`
- Create: `apps/gateway/scripts/bio-dongle-probe.ts`
- Create: `apps/gateway/scripts/bio-dongle-probe.test.ts`

**Interfaces:**
- Produces: `probe`, `scan`, `startIdentify`, `stopIdentify`, `assignAddress`, `setBrightness`, `readBrightness`, `readDeviceInfo`
- Evidence gate: 각 request/response vector는 제조사 문서 또는 격리망 capture의 SHA-256과 기능 이름을 기록한다.

- [ ] **Step 1: probe CLI가 read-only `0x82/0x83`만 허용하고 payload를 기본 redaction하는 RED 테스트를 작성한다.**
- [ ] **Step 2: Task 3 산출물로 aarch64 disposable probe image를 만들고, 현재 운영 container를 재시작하지 않은 채 exact device 한 개만 `--device ...:/dev/bio-dongle`로 전달해 USB descriptor와 read-only probe를 `umask 077` 증거 파일로 수집한다.** MQTT 자격 증명과 운영 data volume은 전달하지 않는다. probe 응답이 없으면 이 Task를 중단하고 opcode를 추정하지 않는다.
- [ ] **Step 3: 제조사 문서 또는 격리 Android capture로 scan/identify/address/brightness/info vector를 기능별 한 개 이상 확보한다.** 비밀번호·현장 식별 bytes는 fixture에서 제거하고 source trace SHA-256만 남긴다.
- [ ] **Step 4: byte-for-byte RED 테스트를 작성한다.** fixture의 모든 request encoder와 response parser가 정확히 일치해야 한다.
- [ ] **Step 5: command codec과 client를 구현하고 GREEN을 확인한다.**

Run: `pnpm --filter @led-control/gateway exec vitest run src/bio/bio-command-codec.test.ts src/bio/bio-dongle-client.test.ts`

- [ ] **Step 6: 커밋한다.**

```bash
git add apps/gateway/test/fixtures/bio-protocol-v1.json apps/gateway/src/bio/bio-command-codec* apps/gateway/src/bio/bio-dongle-client* apps/gateway/scripts/bio-dongle-probe.ts apps/gateway/scripts/bio-dongle-probe.test.ts
git commit -m "feat(gateway): add traced BIO dongle commands"
```

### Task 5: BIO adapter, identity ownership와 fault propagation

**Files:**
- Create: `apps/gateway/src/adapters/bio-usb-dongle-adapter.ts`
- Create: `apps/gateway/src/adapters/bio-usb-dongle-adapter.test.ts`
- Create: `apps/gateway/src/adapters/bio-sensor-capability-unavailable-port.ts`
- Create: `apps/gateway/src/adapters/bio-sensor-capability-unavailable-port.test.ts`
- Modify: `apps/gateway/src/gateway.ts`
- Modify: `apps/gateway/src/gateway.test.ts`
- Modify: `apps/gateway/src/state/provisioning-device-journal.ts`
- Modify: `apps/gateway/src/state/provisioning-device-journal.test.ts`
- Modify: `apps/gateway/src/commands/gateway-command-handler.ts`
- Modify: `apps/gateway/src/commands/gateway-command-handler.test.ts`

**Interfaces:**
- `ProvisioningScannerAdapter.acceptsDeviceUuid(deviceUuid): boolean`
- BIO `applyMeshGroup` = bounded parallel unicast; `syncGroupSubscriptions` = confirmed mapping 기반 virtual membership
- `BIO_STATE_MISMATCH`는 관측값이 있는 실패이며 ACK만 성공으로 승격하지 않는다.

- [ ] **Step 1: scan/provision/control/read-back/group/identify/sensor-unavailable RED 테스트를 작성한다.** address 변경 실패는 reserved, exact UUID read-back 뒤만 confirmed다.
- [ ] **Step 2: DFK/BIO adapter-owned identity와 exact BIO fault 보존 RED 테스트를 작성한다.**
- [ ] **Step 3: RED를 확인한다.**

Run: `pnpm --filter @led-control/gateway exec vitest run src/adapters/bio-usb-dongle-adapter.test.ts src/adapters/bio-sensor-capability-unavailable-port.test.ts src/gateway.test.ts src/state/provisioning-device-journal.test.ts src/commands/gateway-command-handler.test.ts`

- [ ] **Step 4: 세 port와 fail-closed sensor port를 구현한다.** fixture별 read-back 결과를 반환하고 deadline/abort를 전파한다.
- [ ] **Step 5: scanner predicate와 fault propagation을 적용하고 GREEN을 확인한다.**
- [ ] **Step 6: 커밋한다.**

```bash
git add apps/gateway/src/adapters apps/gateway/src/gateway* apps/gateway/src/state/provisioning-device-journal* apps/gateway/src/commands/gateway-command-handler*
git commit -m "feat(gateway): implement BIO USB gateway adapter"
```

### Task 6: Factory, lifecycle와 adapter-aware health

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
- `GatewayAdapterKind = "bluez" | "bio-usb"`
- `GatewayAdapters` adds `adapterKind`, `vehicleSensorCloudSupported`, `stop()`
- BIO health requires `transportConnected`, `protocolReady`, `mappingValid`; BlueZ probes remain unchanged.

- [ ] **Step 1: exact factory selection, no Company ID on BIO, shutdown, no sensor refresh RED 테스트를 작성한다.**
- [ ] **Step 2: discriminated health RED 테스트를 작성한다.** BIO health가 D-Bus/BlueZ를 호출하면 실패해야 한다.
- [ ] **Step 3: factory/startup/shutdown/health를 구현하고 GREEN을 확인한다.**

Run: `pnpm --filter @led-control/gateway exec vitest run src/adapters/adapter-factory.test.ts src/index.test.ts src/health/appliance-health.test.ts`

Run: `node --test apps/gateway/docker/healthcheck-state.test.mjs`

- [ ] **Step 4: 커밋한다.**

```bash
git add apps/gateway/src/adapters/adapter-factory* apps/gateway/src/index* apps/gateway/src/health apps/gateway/docker/healthcheck-state*
git commit -m "feat(gateway): select and monitor BIO USB adapter"
```

### Task 7: Non-root USB appliance와 preflight

**Files:**
- Create: `apps/gateway/compose.bio-usb.yml`
- Create: `scripts/gateway-bio-usb-preflight.sh`
- Create: `scripts/gateway-bio-usb-preflight.test.mjs`
- Modify: `apps/gateway/docker/entrypoint.sh`
- Modify: `apps/gateway/docker/healthcheck.sh`
- Modify: `apps/gateway/docker/compose-contract.test.mjs`
- Modify: `apps/gateway/docker/container-contract.test.mjs`
- Modify: `apps/gateway/.env.appliance.example`
- Modify: `scripts/gateway-appliance-deploy.sh`
- Modify: `scripts/gateway-appliance-scripts.test.mjs`
- Modify: `infra/mosquitto.acl.example`
- Modify: `scripts/dev-runtime.mjs`
- Modify: `scripts/dev-runtime.test.mjs`

**Interfaces:**
- Overlay maps `/dev/serial/by-id/usb-1a86_CH57x-if00-port0:/dev/bio-dongle:rwm`
- Requires `GATEWAY_SERIAL_GID`; prohibits multiple `1a86:5523`, `/dev` mount and privileged mode.

- [ ] **Step 1: Compose/entrypoint/preflight/ACL RED contract를 작성한다.** BIO branch는 `btmgmt`, `bluetooth-meshd`, HCI를 실행하지 않고 BlueZ branch는 그대로여야 하며 Gateway는 device-terminal ACK topic을 read-only로만 사용해야 한다.
- [ ] **Step 2: RED를 확인한다.**

Run: `node --test apps/gateway/docker/compose-contract.test.mjs apps/gateway/docker/container-contract.test.mjs scripts/gateway-bio-usb-preflight.test.mjs scripts/gateway-appliance-scripts.test.mjs scripts/dev-runtime.test.mjs`

- [ ] **Step 3: overlay, exact-one USB 검증, dialout GID 전달과 deploy option을 구현한다.**
- [ ] **Step 4: GREEN과 ARM64 `serialport` load를 확인한다.**
- [ ] **Step 5: 커밋한다.**

```bash
git add apps/gateway/compose.bio-usb.yml apps/gateway/docker apps/gateway/.env.appliance.example infra/mosquitto.acl.example scripts/gateway-bio-usb-preflight* scripts/gateway-appliance-deploy.sh scripts/gateway-appliance-scripts.test.mjs scripts/dev-runtime.mjs scripts/dev-runtime.test.mjs
git commit -m "feat(gateway): deploy one BIO USB device safely"
```

### Task 8: 문서와 software 전체 검증

**Files:**
- Modify: `apps/gateway/README.md`
- Modify: `docs/runbooks/raspberry-pi-gateway-appliance.md`
- Modify: `docs/menus/settings.md`
- Modify: `docs/menus/control.md`
- Modify: `docs/menus/monitoring.md`
- Modify: `docs/database-schema.md`
- Modify: `docs/lesson_leared.md`
- Modify: `docs/project-status.md`
- Modify: `docs/superpowers/plans/2026-09-12-bio-usb-dongle-gateway-adapter.md`

**Interfaces:**
- Produces: 설치, rollback, 제한, software/HIL 증거를 구분한 운영 문서

- [ ] **Step 1: API device terminal ACK, BIO 등록/제어, sensor cloud 제외, 실제 HIL 미실행 상태를 관련 문서에 반영한다.** DB migration이 없고 기존 원장을 재사용함을 schema 문서에 기록한다.
- [ ] **Step 2: 전체 자동 검증을 실행한다.**

Run: `pnpm --filter @led-control/shared test`

Run: `pnpm --filter @led-control/api typecheck && pnpm --filter @led-control/api test -- --runInBand && pnpm --filter @led-control/api build`

Run: `pnpm --filter @led-control/gateway test && pnpm --filter @led-control/gateway test:contracts && pnpm --filter @led-control/gateway typecheck && pnpm --filter @led-control/gateway build`

Run: `git diff --check`

- [ ] **Step 3: 커밋한다.**

```bash
git add apps/gateway/README.md docs
git commit -m "docs: document BIO USB gateway operation"
```

### Task 9: MQTT 기준선 복구, 배포와 단일 장치 HIL

**Files:**
- Evidence: `.superpowers/sdd/2026-09-12-bio-usb-dongle-gateway-adapter/hil-<UTC>/`
- Remote backup: Gateway의 기존 image `led-control-gateway:a965f05f0261`, compose/env/data snapshot

**Interfaces:**
- Consumes: Task 1~8 software 결과와 실제 `dfkorea@192.168.45.122`
- Produces: healthy MQTT, exact USB probe, 실제 scan/registration/brightness/read-back 증거 또는 안전한 rollback

- [ ] **Step 1: `systematic-debugging`으로 API 원장 hostname과 assignment를 대조하고 DNS → TCP → TLS → CONNACK을 순서대로 복구한다.** 연속 3회 fresh heartbeat 전에는 다음 단계로 가지 않는다.
- [ ] **Step 2: 현재 image/compose/env/data를 비밀값 출력 없이 백업하고 SHA-256을 기록한다.**
- [ ] **Step 3: exact-one USB preflight와 새 ARM64 image 검증 뒤 BIO overlay로 배포한다.**
- [ ] **Step 4: `privileged=false`, device 한 개, non-root+dialout, BlueZ 미기동, BIO protocol ready를 확인한다.**
- [ ] **Step 5: 단일 모듈 scan과 점멸 식별을 실행한다.** 대상 UUID를 증거에 기록하되 raw 비밀번호는 기록하지 않는다.
- [ ] **Step 6: 한 모듈의 주소 등록 후 `0/20/60/90/100%` 제어와 read-back/DB 상태를 비교한다.**
- [ ] **Step 7: 실패 시 기존 image/compose/env를 복원하고 BIO mapping journal은 보존한다.**

### Task 10: 복구·중복·장시간 HIL과 최종 상태

**Files:**
- Modify: `docs/project-status.md`
- Modify: `docs/menus/settings.md`
- Modify: `docs/menus/control.md`
- Modify: `docs/menus/monitoring.md`
- Modify: `docs/superpowers/plans/2026-09-12-bio-usb-dongle-gateway-adapter.md`

**Interfaces:**
- Produces: Gateway restart, USB 재연결, QoS duplicate, 2-node 3회와 72시간 soak의 최종 판정

- [ ] **Step 1: container restart 뒤 동일 fixture mapping과 제어 복구를 검증한다.**
- [ ] **Step 2: USB 탈착/재연결에서 stale Docker device bind를 성공으로 우회하지 않고 복구 또는 실패로 기록한다.**
- [ ] **Step 3: 동일 MQTT command 재전달이 USB 물리 명령을 재실행하지 않는지 검증한다.**
- [ ] **Step 4: 두 모듈의 개별/parallel-unicast/부분 실패를 3회 반복한다.** 장치가 한 대뿐이면 `보류(장비 부족)`로 기록하고 완료로 표시하지 않는다.
- [ ] **Step 5: 72시간 soak 결과를 기록한다.** 기간을 채우기 전에는 `진행 중`으로 유지한다.
- [ ] **Step 6: 실제 증거에 맞춰 메뉴 문서, 상태판과 이 체크리스트를 동일하게 갱신하고 `git diff --check`를 실행한다.**
- [ ] **Step 7: 문서 상태를 커밋한다.**

```bash
git add docs/project-status.md docs/menus docs/superpowers/plans/2026-09-12-bio-usb-dongle-gateway-adapter.md
git commit -m "docs: record BIO USB hardware validation"
```
