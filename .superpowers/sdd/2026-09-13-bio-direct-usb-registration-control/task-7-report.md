# Task 7 report — Factory, lifecycle and adapter-aware health

## Status

DONE_WITH_CONCERNS

Task 7의 Gateway software factory, adapter-discriminated health, conditional vehicle-sensor lifecycle과 ordered shutdown을 구현하고 자동 검증했다. 실제 BIO 동글, Raspberry Pi Gateway, 운영 MQTT, 제조사 앱/전화, 배포 환경에는 접근하거나 변경하지 않았다. Task 8 non-root raw USB 배포·재연결 실증, Task 9 승인 HIL, Task 10 production E2E가 남아 있으므로 production 또는 hardware 호환 완료로 판정하지 않는다.

## Base and scope

- Verified clean base: `dcc859fe8fa8a523beae913532170936fc36675e`
- 구현 범위: `bluez | bio-usb` fail-closed factory, unified `GatewayAdapters`, BIO direct-USB construction, discriminated health/state healthcheck, vehicle-sensor cloud exclusion, SIGTERM/SIGINT ordered drain.
- 보존 범위: BlueZ Company ID/D-Bus/attach/mapping health, Task 6 startup provisioning recovery·group hydration·cancellation·read-back observation paths.
- 제외 범위: Task 8 compose/udev/non-root USB deployment, Task 9 hardware write/HIL, Task 10 production Web/API/DB E2E.
- DB schema와 firmware는 변경하지 않았다.

## Commit

- `13995907a5335d97f25ff3cf6f3d8af427938231` — `feat(gateway): start and monitor the BIO USB adapter`
- 메뉴 문서와 이 보고서는 동일 Task 7의 별도 documentation commit으로 기록한다.

## Implementation

### Fail-closed adapter factory

- `GatewayAdapterKind`를 `"bluez" | "bio-usb"`로 고정하고 `GatewayAdapters`에 discriminator, vehicle-sensor cloud 지원 여부, 필수 health probes와 async `stop()`을 통합했다.
- adapter 값 누락·빈 문자열·unknown/stub/command는 시작 전에 거부한다.
- BlueZ는 deployment-owned Company ID와 기존 D-Bus/BlueZ adapter·health 계약을 그대로 요구한다.
- BIO는 Company ID나 D-Bus/BlueZ를 읽지 않고 exact `BioDirectUsbConnection → BioDongleClient → BioUsbDongleAdapter`와 durable `BioDeviceMappingStore`를 구성한다.
- BIO response timeout, scan duration, mapping path를 각각 환경 설정으로 받고 양의 정수 검증 및 appliance 기본값을 적용한다.
- 시작 시 direct-USB protocol probe와 mapping validation을 모두 통과해야 adapter를 공개한다. 제조사 앱·Android 전화는 runtime 의존성이 아니다.

### Adapter-discriminated health

- health state에 `adapterKind`를 기록하고 BlueZ의 `dbusOwner`/`bluezAttached`와 BIO의 `transportConnected`/`protocolReady`를 상호 배타적으로 직렬화한다.
- BIO는 transport connected, protocol ready, mapping valid, MQTT connected, heartbeat fresh가 모두 참일 때만 healthy다. BIO probe 집합에는 D-Bus/BlueZ 함수가 없고 해당 함수를 호출하지 않는 회귀 테스트를 추가했다.
- adapter kind와 probe discriminator가 다르면 시작 전에 거부한다.
- container state healthcheck와 root shell healthcheck도 adapter kind를 fail-closed로 분기한다. BIO shell 분기는 D-Bus/HCI를 조회하지 않는다.
- health JSON에는 adapter kind와 readiness boolean만 추가했다. raw USB path/descriptor/protocol payload/UUID/secret은 노출하지 않는다.

### Conditional runtime and shutdown

- BIO의 `vehicleSensorCloudSupported=false`에서는 Company ID/vendor sensor model/controller를 만들거나 initial/config/provision completion capability refresh를 호출하지 않는다. capability ingest가 도달하면 `bio_sensor_cloud_unsupported`로 거부한다.
- SIGTERM/SIGINT shutdown은 MQTT command intake quiesce → worker/publisher drain → MQTT runtime stop → adapter stop 순서다.
- BIO adapter stop은 `BioDongleClient.close()`를 await하므로 transport polling 중지, USB interface release, 필요 시 kernel driver reattach가 끝나야 process exit가 진행된다.
- 각 shutdown 단계는 앞 단계가 실패해도 계속 실행하며 단일/aggregate failure를 보존한다. 반복 signal은 하나의 shutdown promise를 공유하고 adapter cleanup 실패 시 exit code 1을 사용한다.
- phase-0 probe도 성공 뒤 adapter stop을 기다린다.

## Strict TDD evidence

Initial RED:

```text
planned Task 7 Vitest: 12 failed | 68 passed
healthcheck-state: 2 failed | 3 passed
```

실패 원인은 BIO factory/discriminator/health/shutdown/helper가 아직 없고 state healthcheck가 BlueZ 필드만 요구한 것이었다.

Self-review RED:

```text
BIO root healthcheck D-Bus/HCI 분기: 1 failed
health adapter/probe discriminator mismatch: 1 failed
```

각 RED를 production code 변경 전에 확인한 뒤 최소 구현으로 GREEN 전환했다.

## Fresh verification

```text
planned Task 7 Vitest: 3 files, 81 passed
healthcheck-state: 5 passed, 0 failed
focused container contract: 15 passed, 0 failed
BIO/BlueZ/relevant expanded suite: 22 files, 534 passed
Gateway full suite: 76 files, 970 passed
Docker contracts: 27 passed, 0 failed
Gateway typecheck: exit 0
Gateway build: exit 0, dist/gateway.mjs 657.1kb
git diff --check: exit 0
```

## Documentation

- `docs/menus/monitoring.md`: adapter-aware boolean health와 app-free software 경계, Task 8–10 미검증 범위를 반영했다.
- `docs/menus/settings.md`: fail-closed selection, BlueZ Company ID 보존, BIO mapping/timeout/direct-USB 설정과 production 미완료 범위를 반영했다.
- `docs/menus/control.md`: conditional sensor refresh, MQTT-first/USB-last shutdown과 배포·HIL 한계를 반영했다.

## Concerns and follow-up

- 본 결과는 fake connection/store와 자동 테스트에 근거한 software integration 증거다.
- Task 8에서 exact raw USB node, udev/non-root 권한, compose/runtime 설정과 반복 unplug/replug recovery를 검증해야 한다.
- Task 9에서 승인된 단일 장치의 address assignment, restart recovery, `0/20/60/90/100%` 실제 read-back/육안 반응과 sensor restore를 검증해야 한다.
- Task 10 전에는 Web/API/Gateway/DB production E2E 또는 완전한 BIO 지원을 주장하지 않는다.

## Review hardening — repeated OS signals and startup cleanup

### Status

DONE_WITH_CONCERNS

Task 7 review의 Important 두 건을 Gateway software 범위에서 보완했다. 실제 BIO 동글, Raspberry Pi Gateway, 운영 MQTT와 배포는 접근하거나 변경하지 않았다.

### Review base and implementation commit

- Verified clean review base: `bf881ba6926031852e31d348dbb7e9562421b3f9`
- `ad57f7de11f38c81b35e0f128581ce14b2e2774f` — `fix(gateway): retain BIO cleanup ownership`

### Review fixes

- SIGTERM/SIGINT listener를 `once`로 등록하면 첫 signal 직후 제거되어, 느린 USB cleanup 중 같은 실제 OS signal이 다시 왔을 때 Node 기본 종료가 실행됐다. listener는 cleanup 종료 직전까지 유지하고 기존 단일 shutdown promise가 반복 signal을 흡수하도록 변경했다.
- 종료 callback 직전에 SIGTERM/SIGINT listener를 함께 제거한다. 성공·실패 exit가 결정된 뒤 test host에 handler가 남지 않으며 명시적 unregister도 idempotent하다.
- 별도 Node child process가 cleanup 중 동일 SIGTERM을 두 번 받는 회귀를 추가했다. child는 두 번째 signal에도 종료되지 않고 `USB_CLEANUP_FINISHED`를 출력한 뒤 code 0으로 종료해야 한다.
- factory probe가 adapter를 반환한 순간부터 MQTT client 생성이 성공할 때까지 `startGatewayRuntime`이 cleanup ownership을 가진다. MQTT factory가 throw하면 `adapter.stop()`을 await한 뒤 primary failure를 다시 던진다.
- runtime 반환 뒤 health/journal/controller 구성부터 signal handler 등록 완료까지도 같은 startup-stage cleanup 경계를 적용했다. 중간 동기·비동기 실패 시 direct USB polling stop/interface release/conditional reattach를 포함한 adapter stop을 기다린다.
- startup primary failure와 adapter cleanup failure가 함께 발생하면 순서를 유지한 `AggregateError`로 둘 다 보존한다.

### Strict RED evidence

실제 child process repeated-signal RED:

```text
expected { code: 0, signal: null }
received { code: null, signal: "SIGTERM" }
USB_CLEANUP_FINISHED 미도달
```

MQTT 생성 실패 cleanup RED:

```text
2 failed
adapter stop calls: expected 1, received 0
primary Error에 cleanup Error가 보존되지 않음
```

later-stage startup cleanup RED:

```text
1 failed
runGatewayStartupStageWithAdapterCleanup is not a function
```

각 RED는 production code 변경 전에 확인했고 단계별 최소 구현 뒤 GREEN으로 전환했다.

### Fresh GREEN verification

```text
review focused: 4 passed
planned Task 7 focused: 3 files, 85 passed
healthcheck-state: 5 passed, 0 failed
Gateway full suite: 76 files, 974 passed
Docker contracts: 27 passed, 0 failed
Gateway typecheck: exit 0
Gateway build: exit 0, dist/gateway.mjs 659.2kb
git diff --check: exit 0
```

### Remaining concerns

- child process 검증은 실제 OS signal semantics를 사용하지만 USB cleanup 자체는 시간 제어 fake adapter다.
- 반복 signal과 startup error를 실제 Pi/systemd/raw USB detach와 결합한 검증은 Task 8–9 범위다.
- Task 8 deployment, Task 9 승인 HIL, Task 10 production E2E 전에는 production-complete로 판정하지 않는다.
