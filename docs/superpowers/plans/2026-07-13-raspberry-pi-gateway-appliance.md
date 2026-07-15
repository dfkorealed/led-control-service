# Raspberry Pi Gateway Appliance 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Raspberry Pi 4/CM5에서 Docker Compose 한 번으로 BlueZ Mesh, 실제 게이트웨이 애플리케이션, 상태 점검을 실행하고 ESP32-H2 조명을 검색·등록·제어한다.

**Architecture:** ARM64 단일 appliance 이미지 안에서 private system D-Bus, BlueZ 5.82 `bluetooth-meshd`, Node.js 22 gateway를 순서대로 실행한다. 호스트는 Bluetooth kernel/HCI와 Docker만 제공하고, mesh token·주소 매핑·명령 journal은 bind volume에 영속화한다. Mac은 mTLS MQTT/API를 제공하며 Pi는 host network로 접속한다.

**Tech Stack:** Docker Buildx/Compose, Debian 13 ARM64, BlueZ 5.82, Node.js 22, TypeScript, `@homebridge/dbus-native`, MQTT 5/mTLS, Vitest, ESP-IDF 5.5.1

## 전역 제약

- 모든 런타임 경로는 양산 기준으로 구현하며 mock/stub 우회는 appliance에 포함하지 않는다.
- 기본 Compose에서 `privileged: true`, Docker socket, 호스트 전체 `/dev` mount를 사용하지 않는다.
- root filesystem은 read-only이며 `/run`, `/tmp`만 tmpfs로 제공한다.
- 인증서와 private key는 이미지에 COPY하지 않고 read-only bind mount로만 주입한다.
- BlueZ mesh database, gateway assignment, fixture-address mapping, journal, event sequence는 재부팅 후 유지한다.
- 실제 보드 검증 전에는 `코드 완료·실기 미검증`으로만 기록한다.
- ESP32-H2 OTA, 스케줄 제어, 이벤트 제어, 양산 PKI 자동 enrollment는 이번 범위에서 제외한다.

---

## 파일 구조

- `apps/gateway/docker/Dockerfile`: BlueZ 5.82와 gateway를 빌드하는 ARM64 multi-stage 이미지
- `apps/gateway/docker/entrypoint.sh`: D-Bus, meshd, gateway 순차 시작과 signal 전달
- `apps/gateway/docker/dbus-system.conf`: 컨테이너 내부 private system bus 정책
- `apps/gateway/docker/bluetooth-mesh.conf`: BlueZ Mesh daemon 설정
- `apps/gateway/docker/healthcheck.sh`: D-Bus/HCI/assignment/MQTT/mapping 상태 판정
- `apps/gateway/compose.raspberry-pi.yml`: Pi production runtime 계약
- `apps/gateway/src/mesh/bluez-dbus-application.ts`: ObjectManager/Application1/Provisioner1/Agent1/Element1 export
- `apps/gateway/src/mesh/mesh-identity-store.ts`: provisioner UUID/token 영속화
- `apps/gateway/src/mesh/mesh-address-store.ts`: device/fixture/unicast 예약·확정 원자 저장
- `apps/gateway/src/mesh/bluez-provisioner.ts`: CreateNetwork/Attach/scan/AddNode lifecycle
- `apps/gateway/src/mesh/bluez-config-client.ts`: composition/AppKey/model bind/subscription configuration
- `apps/gateway/src/mesh/bluez-mesh-adapter.ts`: gateway의 세 adapter interface 통합 구현
- `scripts/gateway-appliance-build.sh`: ARM64 이미지 buildx build와 archive 생성
- `scripts/gateway-appliance-deploy.sh`: archive/config를 Pi에 복사하고 Compose 적용
- `scripts/gateway-host-prepare.sh`: Pi Bluetooth rfkill 사전 조치와 Docker 확인
- `docs/runbooks/raspberry-pi-gateway-appliance.md`: 설치·배포·복구·실기 시험 절차

### Task 1: Raspberry Pi 호스트 사전 점검과 Bluetooth unblock

**Files:**
- Create: `scripts/gateway-host-prepare.sh`
- Create: `scripts/gateway-host-prepare.test.mjs`
- Modify: `package.json`

**Interfaces:**
- Produces: `scripts/gateway-host-prepare.sh [--check-only]`
- Produces: 정상 시 exit 0, 수정 필요 시 check-only exit 2, 복구 실패 시 exit 1

- [x] **Step 1: 실패 테스트 작성**

임시 root에 `options rfkill default_state=0`을 만들고 `--check-only`가 exit 2, apply가 `default_state=1`로 원자 교체하는지 Node test로 검증한다. `bluetoothctl`, `docker`, `rfkill` command는 test fixture executable로 주입한다.

- [x] **Step 2: 실패 확인**

Run: `node --test scripts/gateway-host-prepare.test.mjs`

Expected: `gateway-host-prepare.sh` 부재로 FAIL.

- [x] **Step 3: 최소 구현**

스크립트는 Debian/ARM64, Docker Compose, HCI controller를 검사하고 `util-linux`의 rfkill을 설치한 뒤 `/etc/modprobe.d/rfkill_default.conf`를 `options rfkill default_state=1`로 갱신한다. `rfkill unblock bluetooth`, `systemctl enable --now bluetooth` 후 `bluetoothctl show`의 `Powered: yes`를 확인한다.

- [x] **Step 4: 검증과 커밋**

Run: `node --test scripts/gateway-host-prepare.test.mjs && shellcheck scripts/gateway-host-prepare.sh`

Expected: PASS. Commit: `feat: add Raspberry Pi gateway host preflight`

### Task 2: ARM64 BlueZ Mesh appliance 이미지

**Files:**
- Create: `apps/gateway/docker/Dockerfile`
- Create: `apps/gateway/docker/entrypoint.sh`
- Create: `apps/gateway/docker/dbus-system.conf`
- Create: `apps/gateway/docker/bluetooth-mesh.conf`
- Create: `apps/gateway/docker/container-contract.test.mjs`
- Modify: `.dockerignore`

**Interfaces:**
- Produces: image command `/usr/local/bin/gateway-entrypoint`
- Produces: private bus socket `/run/dbus/system_bus_socket`
- Produces: `org.bluez.mesh` owner before Node gateway startup

- [x] **Step 1: container contract 실패 테스트 작성**

Dockerfile이 `ARG BLUEZ_VERSION=5.82`, SHA256 `0739fa608a837967ee6d5572b43fb89946a938d1c6c26127158aaefd743a790b`, Node 22 runtime, non-root gateway process, HEALTHCHECK를 포함하고 secret COPY/whole `/dev`/privileged 설정이 없는지 정적 검사한다.

- [x] **Step 2: 실패 확인**

Run: `node --test apps/gateway/docker/container-contract.test.mjs`

Expected: Dockerfile 부재로 FAIL.

- [x] **Step 3: image와 시작 순서 구현**

BlueZ build stage는 `--enable-mesh --disable-systemd --disable-manpages`로 `bluetooth-meshd`를 빌드한다. app stage는 `pnpm deploy --prod` 결과와 빌드 JS만 복사한다. entrypoint는 private `dbus-daemon`, `bluetooth-meshd --config /etc/bluetooth/mesh/bluetooth-mesh.conf`, gateway를 순서대로 시작하고 `org.bluez.mesh` 대기 timeout 시 종료한다.

- [x] **Step 4: amd64 정적 검증과 ARM64 build**

Run: `node --test apps/gateway/docker/container-contract.test.mjs`

Run: `docker buildx build --platform linux/arm64 --load -f apps/gateway/docker/Dockerfile -t led-control-gateway:test .`

Expected: test PASS, image build PASS, `bluetooth-meshd --version`이 `5.82`.

- [ ] **Step 5: 커밋**

Commit: `feat: build BlueZ Mesh gateway appliance image`

### Task 3: Compose 보안·영속성 계약

**Files:**
- Create: `apps/gateway/compose.raspberry-pi.yml`
- Create: `apps/gateway/.env.appliance.example`
- Create: `apps/gateway/docker/compose-contract.test.mjs`

**Interfaces:**
- Consumes: `led-control-gateway:${GATEWAY_IMAGE_TAG}`
- Produces: `/var/lib/led-control`, `/var/lib/bluetooth/mesh`, `/etc/led-control/certs` mount 계약

- [x] **Step 1: 실패 테스트 작성**

Compose render 결과가 `network_mode: host`, `read_only: true`, `init: true`, restart policy, healthcheck, tmpfs, 최소 capability를 포함하는지 검사한다. `privileged`, Docker socket, 이미지 내부 인증서, plaintext MQTT URL은 발견 시 실패한다.

- [x] **Step 2: 실패 확인**

Run: `node --test apps/gateway/docker/compose-contract.test.mjs`

Expected: compose 부재로 FAIL.

- [x] **Step 3: Compose 구현**

HCI 접근에는 `NET_ADMIN`, `NET_RAW` capability와 `/run/dbus`가 아닌 컨테이너 private bus를 사용한다. assignment/mapping/journal/sequence와 BlueZ mesh DB를 named host directory에 bind하고 cert는 read-only로 mount한다.

- [x] **Step 4: 검증과 커밋**

Run: `docker compose --env-file apps/gateway/.env.appliance.example -f apps/gateway/compose.raspberry-pi.yml config`

Run: `node --test apps/gateway/docker/compose-contract.test.mjs`

Expected: PASS. Commit: `feat: add production gateway appliance compose`

### Task 4: BlueZ D-Bus application callback export

**Files:**
- Create: `apps/gateway/src/mesh/bluez-dbus-application.ts`
- Create: `apps/gateway/src/mesh/bluez-dbus-application.test.ts`
- Modify: `apps/gateway/src/mesh/bluez-transport.ts`

**Interfaces:**
- Produces: `BluezDbusApplication.start(): Promise<void>`
- Produces: callback events `joinComplete`, `scanResult`, `provisionDataRequested`, `nodeAdded`, `nodeAddFailed`, `messageReceived`, `devKeyMessageReceived`
- Produces: `GetManagedObjects(): Record<ObjectPath, Record<InterfaceName, PropertyMap>>`

- [x] **Step 1: fake bus 실패 테스트 작성**

`/com/dfkorea/ledcontrol`, `/application`, `/agent`, `/ele00`에 ObjectManager, Application1, Provisioner1, ProvisionAgent1, Element1이 정확한 signature로 export되는지 검사한다. `RequestProvData(count)`는 `[netIndex, unicast]`, `JoinComplete(token)`은 token event, `MessageReceived`는 source/data event를 발생시켜야 한다.

- [x] **Step 2: 실패 확인**

Run: `pnpm --filter @led-control/gateway test -- bluez-dbus-application.test.ts`

Expected: module not found로 FAIL.

- [x] **Step 3: export 구현**

`@homebridge/dbus-native`의 누락 type은 project-local narrow interface로 감싸고, `GetManagedObjects`를 직접 export한다. BlueZ 5.82 API signature `naya{sv}`, `yqq`, `ayqy`, `qqvay`를 그대로 사용하며 export 완료 전 Network1 호출을 허용하지 않는다.

- [x] **Step 4: 검증과 커밋**

Run: `pnpm --filter @led-control/gateway test -- bluez-dbus-application.test.ts && pnpm --filter @led-control/gateway typecheck`

Expected: PASS. Commit: `feat: export BlueZ Mesh application callbacks`

### Task 5: Mesh identity와 fixture-address 영속 저장

**Files:**
- Create: `apps/gateway/src/mesh/mesh-identity-store.ts`
- Create: `apps/gateway/src/mesh/mesh-identity-store.test.ts`
- Create: `apps/gateway/src/mesh/mesh-address-store.ts`
- Create: `apps/gateway/src/mesh/mesh-address-store.test.ts`

**Interfaces:**
- Produces: `MeshIdentityStore.loadOrCreate(): Promise<{ uuid: Uint8Array; token?: bigint }>`
- Produces: `MeshIdentityStore.saveToken(token: bigint): Promise<void>`
- Produces: `MeshAddressStore.reserve(input): Promise<MeshAddressReservation>`
- Produces: `confirm(deviceUuid, primaryUnicast, elementCount)` 및 `findByFixtureId(fixtureId)`

- [x] **Step 1: 실패 테스트 작성**

UUID 재시작 유지, bigint token lossless 직렬화, 동일 command 재예약 idempotency, 주소 범위 충돌, element count 범위 충돌, temp-file rename 원자성, 손상 파일 fail-closed를 검증한다.

- [x] **Step 2: 실패 확인**

Run: `pnpm --filter @led-control/gateway test -- mesh-identity-store.test.ts mesh-address-store.test.ts`

Expected: module not found로 FAIL.

- [x] **Step 3: 구현**

웹 payload의 `meshAddress`를 hex unicast로 파싱해 먼저 예약하고 `RequestProvData(count)`에서 해당 예약 주소를 반환한다. BlueZ callback 주소가 예약과 다르면 mapping을 저장하지 않고 provisioning을 실패 처리한다.

- [x] **Step 4: 검증과 커밋**

Run: `pnpm --filter @led-control/gateway test -- mesh-identity-store.test.ts mesh-address-store.test.ts`

Expected: PASS. Commit: `feat: persist mesh identity and address mappings`

### Task 6: Provisioner bootstrap·attach·scan·AddNode lifecycle

**Files:**
- Create: `apps/gateway/src/mesh/bluez-provisioner.ts`
- Create: `apps/gateway/src/mesh/bluez-provisioner.test.ts`

**Interfaces:**
- Consumes: `BluezTransport`, `BluezDbusApplication`, identity/address stores
- Produces: `start()`, `scan(seconds)`, `provision(request)`, `stopScan()`

- [x] **Step 1: lifecycle 실패 테스트 작성**

token이 없으면 `Network1.CreateNetwork`, `JoinComplete` 후 저장 및 `Attach`; token이 있으면 즉시 `Attach`를 호출한다. scan은 `Management1.UnprovisionedScan({Seconds})`, UUID dedupe와 strongest RSSI를 적용한다. provision은 예약 후 `AddNode`, callback timeout/failure cleanup을 검증한다.

- [x] **Step 2: 실패 확인**

Run: `pnpm --filter @led-control/gateway test -- bluez-provisioner.test.ts`

Expected: module not found로 FAIL.

- [x] **Step 3: 구현**

BlueZ node path와 configuration 반환값을 attach 결과에서 보관한다. 동시에 한 번만 AddNode를 허용하고 취소·timeout 시 예약을 해제한다. firmware/serial은 unprovisioned beacon에 없으므로 UUID를 serial fallback으로 사용하고 등록 뒤 상태 모델에서 보강한다.

- [ ] **Step 4: 검증과 커밋**

Run: `pnpm --filter @led-control/gateway test -- bluez-provisioner.test.ts && pnpm --filter @led-control/gateway typecheck`

Expected: PASS. Commit: `feat: implement BlueZ Mesh provisioning lifecycle`

### Task 7: Config Client와 모델 설정

**Files:**
- Create: `apps/gateway/src/mesh/bluez-config-codec.ts`
- Create: `apps/gateway/src/mesh/bluez-config-codec.test.ts`
- Create: `apps/gateway/src/mesh/bluez-config-client.ts`
- Create: `apps/gateway/src/mesh/bluez-config-client.test.ts`

**Interfaces:**
- Produces: `configureNode({ unicast, elementCount }): Promise<NodeComposition>`
- Consumes/produces: Config Composition Data Get/Status, AppKey Add/Status, Model App Bind/Status, Publication/Subscription Set/Status opcodes

- [x] **Step 1: codec golden-vector 실패 테스트 작성**

Bluetooth Mesh Profile의 little-endian opcode payload를 고정 byte vector로 검증하고 malformed/status error 응답을 거부한다.

- [x] **Step 2: state machine 실패 테스트 작성**

`Node1.DevKeySend` 순서가 composition 조회, AppKey 0 추가, Light Lightness Server와 Generic OnOff Server bind, status publication 설정 순서인지 검증한다. 각 응답은 source/opcode/status 일치와 timeout을 요구한다.

- [x] **Step 3: 구현과 검증**

Run: `pnpm --filter @led-control/gateway test -- bluez-config-codec.test.ts bluez-config-client.test.ts`

Expected: PASS.

- [ ] **Step 4: 커밋**

Commit: `feat: configure provisioned lighting mesh nodes`

### Task 8: 실제 scan/identify/control/status adapter

**Files:**
- Create: `apps/gateway/src/mesh/bluez-mesh-adapter.ts`
- Create: `apps/gateway/src/mesh/bluez-mesh-adapter.test.ts`
- Modify: `apps/gateway/src/mesh/bluez-model-codec.ts`
- Modify: `apps/gateway/src/adapters/adapter-factory.ts`
- Modify: `apps/gateway/src/adapters/adapter-factory.test.ts`

**Interfaces:**
- Implements: `BleMeshAdapter`, `ProvisioningScannerAdapter`, `ProvisioningAdapter`
- Produces: Light Lightness Set acknowledged transaction과 Lightness Status 기반 `BleMeshCommandReport`

- [x] **Step 1: 실패 테스트 작성**

factory가 `GATEWAY_ADAPTER=bluez`에서 실제 단일 adapter를 반환하는지, fixture mapping 없음은 전송 전 실패하는지, TID 증가/재시작 유지, status source 일치, timeout, duplicate status, 부분 실패를 검증한다. identify는 Generic OnOff/Lightness 식별 패턴을 적용 후 원상 복귀한다.

- [x] **Step 2: 실패 확인**

Run: `pnpm --filter @led-control/gateway test -- bluez-mesh-adapter.test.ts adapter-factory.test.ts`

Expected: production unavailable 오류로 FAIL.

- [x] **Step 3: 구현**

`Node1.Send(elementPath, destination, appKeyIndex, options, data)`로 acknowledged Lightness Set을 전송한다. `Element1.MessageReceived`의 Status만 성공 근거로 삼고 send 성공 자체를 ACK로 간주하지 않는다.

- [ ] **Step 4: 전체 gateway 검증과 커밋**

Run: `pnpm --filter @led-control/gateway test && pnpm --filter @led-control/gateway typecheck`

Expected: PASS. Commit: `feat: enable production BlueZ Mesh gateway adapter`

### Task 9: Appliance healthcheck와 장애 상태

**Files:**
- Create: `apps/gateway/src/health/appliance-health.ts`
- Create: `apps/gateway/src/health/appliance-health.test.ts`
- Create: `apps/gateway/docker/healthcheck.sh`
- Modify: `apps/gateway/src/index.ts`
- Modify: `apps/gateway/docker/Dockerfile`

**Interfaces:**
- Produces: `/var/run/led-control/health.json`
- Produces: `healthy`, `starting-unassigned`, `unhealthy` 판정

- [x] **Step 1: 실패 테스트 작성**

D-Bus owner/HCI/assignment/MQTT heartbeat age/mapping integrity 조합별 상태를 검증한다. claim 전 assignment 없음은 crash가 아닌 `starting-unassigned`, mapping 손상과 Bluetooth blocked는 unhealthy다.

- [x] **Step 2: 구현과 검증**

Run: `pnpm --filter @led-control/gateway test -- appliance-health.test.ts && node --test apps/gateway/docker/container-contract.test.mjs`

Expected: PASS.

- [ ] **Step 3: 커밋**

Commit: `feat: add gateway appliance health monitoring`

### Task 10: ARM64 build·전송·배포 자동화

**Files:**
- Create: `scripts/gateway-appliance-build.sh`
- Create: `scripts/gateway-appliance-deploy.sh`
- Create: `scripts/gateway-appliance-scripts.test.mjs`
- Modify: `package.json`

**Interfaces:**
- Produces: `pnpm gateway:appliance:build`
- Produces: `scripts/gateway-appliance-deploy.sh dfkorea@dfkorea.local`

- [x] **Step 1: 실패 테스트 작성**

build script가 linux/arm64와 immutable source revision tag를 사용하고 tar checksum을 생성하는지 검사한다. deploy는 checksum 검증, `docker load`, env/cert 존재 검사, `docker compose up -d --remove-orphans`, health 대기를 수행해야 한다.

- [ ] **Step 2: 구현과 검증**

Run: `node --test scripts/gateway-appliance-scripts.test.mjs`

Run: `scripts/gateway-appliance-build.sh`

Expected: test PASS, `dist/gateway-appliance/*.tar`와 `.sha256` 생성.

- [ ] **Step 3: 커밋**

Commit: `feat: automate gateway appliance deployment`

### Task 11: Raspberry Pi Phase 0 실제 배포

**Files:**
- Modify: `docs/runbooks/raspberry-pi-gateway-appliance.md`
- Create during test: `artifacts/hil/<timestamp>/phase0.json`

**Interfaces:**
- Consumes: SSH `dfkorea@dfkorea.local`, appliance archive, gateway mTLS certs
- Produces: host/daemon/HCI/scan/provision/control/restart 6개 증거

- [x] **Step 1: 호스트 준비**

Run: `ssh dfkorea@dfkorea.local 'sudo /opt/led-control/scripts/gateway-host-prepare.sh'`

Expected: Bluetooth `Powered: yes`, Docker Compose available.

- [ ] **Step 2: appliance 배포**

Run: `scripts/gateway-appliance-deploy.sh dfkorea@dfkorea.local`

Expected: container healthy 또는 claim 전 `starting-unassigned`, `org.bluez.mesh` owner 확인.

- [ ] **Step 3: ESP32-H2 1대 Phase 0**

펌웨어를 flash하고 unprovisioned beacon 검색, provisioning, model bind, 0/25/50/100% Lightness status 왕복을 수행한다.

- [ ] **Step 4: 재시작 복구**

컨테이너와 Pi를 재부팅한 뒤 재-provision 없이 동일 node address로 제어한다. 실패 시 Task 12로 진행하지 않는다.

### Task 12: 2-node HIL·문서·최종 판정

**Files:**
- Modify: `apps/gateway/scripts/hil-2node-test.ts`
- Modify: `apps/gateway/scripts/soak-test.ts`
- Create: `docs/runbooks/raspberry-pi-gateway-appliance.md`
- Modify: `apps/gateway/README.md`
- Modify: `README.md`
- Modify: `docs/menus/monitoring.md`
- Modify: `docs/menus/control.md`
- Modify: `docs/menus/settings.md`
- Modify: `docs/lesson_leared.md`
- Modify: `docs/superpowers/plans/2026-07-11-production-device-foundation.md`

**Interfaces:**
- Produces: 2-node 3회 연속 HIL evidence와 사용자가 재현 가능한 한글 runbook

- [ ] **Step 1: 실장비 HIL 3회**

Run: `pnpm gateway:hil:2node -- --repeat 3`

Expected: 두 node 검색/등록, 개별·그룹 0/25/50/100%, 한 node timeout 부분 실패, MQTT 재연결, gateway 재시작 복구가 3회 연속 PASS.

- [x] **Step 2: 전체 자동 검증**

Run: `pnpm test && pnpm typecheck && git diff --check`

Run: `scripts/esp32-h2-build.sh`

Expected: 모두 PASS.

- [x] **Step 3: 상태 문서 갱신**

실행된 증거까지만 완료로 표시한다. 72시간 soak와 주차장 RF walk가 실행되지 않았으면 양산 준비 완료로 쓰지 않고 남은 검증으로 유지한다.

- [ ] **Step 4: 최종 커밋**

Commit: `docs: complete Raspberry Pi gateway appliance runbook`

## 진행 로그

- 2026-07-13: 단일 Gateway Appliance 설계 승인. Raspberry Pi 4의 Debian 13, BlueZ 5.82, 내장 BCM4345를 확인했다. 호스트는 `default_state=0` 때문에 Bluetooth가 off-blocked이고 `bluetooth-meshd`가 설치되지 않은 상태다.
- 2026-07-13: 구현 계획을 작성했다. 실제 구현 완료와 Raspberry Pi/ESP32-H2 실기 완료를 별도 관문으로 관리한다.
- 2026-07-13: Task 1 host preflight를 구현해 boot rfkill policy의 check-only/apply와 powered controller 실패 테스트 3개를 통과했다. 로컬에 shellcheck가 없어 해당 검사는 Pi 또는 image에서 실행해야 한다.
- 2026-07-13: Task 2의 BlueZ 5.82/Node 22 image와 Task 3 Compose 보안 계약의 정적 테스트 6개를 통과했다. Mac에 Docker CLI가 없어 ARM64 실제 build는 Pi 단계로 이관했다.
- 2026-07-13: Task 4 D-Bus application hierarchy와 callback export, `RequestProvData` 복수 반환 호환 계층을 구현해 테스트 6개와 typecheck를 통과했다.
- 2026-07-13: Task 5 provisioner identity/token과 fixture-unicast mapping을 원자 저장하고 주소 범위 충돌·손상 파일 fail-closed 테스트 6개를 통과했다. 등록 node ID를 fixture 선할당 ID로 사용하는 API 보강은 실제 adapter 연결 전에 완료해야 한다.
- 2026-07-13: Task 6~8의 실제 BlueZ provisioner, Config Client, scan/provision/control adapter를 구현했다. callback D-Bus 메서드 bind, multi-return, Long.js uint64 token을 실기에서 보정했으며 gateway 테스트 66개를 통과했다.
- 2026-07-13: Raspberry Pi `dfkorea.local`에서 ARM64 image, private D-Bus, BlueZ 5.82, HCI 0, network 생성과 token 저장, 동일 volume 재시작 attach를 확인했다. ESP32-H2 RF/provision/control과 2-node HIL은 아직 미완료다.
- 2026-07-13: appliance health state와 ARM64 archive/checksum/deploy 스크립트, 한글 운영 runbook을 추가했다.
- 2026-07-13: 전체 workspace 테스트(API 95, gateway 69, web 49 등), 전체 typecheck, appliance 계약 12개, `git diff --check`, ESP-IDF 5.5.1 esp32h2 build를 통과했다. 최종 펌웨어 크기는 `0xe4d10`, app partition 여유는 약 11%다.
- 2026-07-13: Pi `/opt/led-control/gateway`에 Compose, 설정 템플릿, host 준비 스크립트와 ARM64 image `sha256:0c1e1bb88d8d6de59ca71f59ac018e3268ce4be5b85616082ebabd852ef791d8`를 설치했다. 실제 `.env.appliance`와 인증서는 사용자가 주입하기 전이라 운영 Compose는 시작하지 않았다.
