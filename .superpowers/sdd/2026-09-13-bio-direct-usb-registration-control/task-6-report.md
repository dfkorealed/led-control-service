# Task 6 report — BIO adapter and registration/control integration

## Status

DONE_WITH_CONCERNS

Task 6의 Gateway software integration과 자동 검증을 완료했다. 실제 BIO 동글, Raspberry Pi Gateway, 조명, 운영 MQTT, 배포는 접근하거나 변경하지 않았다. Task 7 factory/lifecycle/health, Task 8 deployment, Task 9 승인 HIL, Task 10 Web E2E가 남아 있으므로 production 또는 hardware 호환 완료로 판정하지 않는다.

## Base and scope

- Verified clean base: `6b9a8ace2925e39f0433686d0c045dc8d4e9ad12`
- 구현 범위: adapter-owned discovery identity, BIO provisioning/recovery, confirmed-only individual and virtual-group control, read-back truth propagation, sensor-cloud exclusion.
- 제외 범위: Task 7 factory/USB lifecycle/health, Task 8 compose/deployment, Task 9 hardware write/HIL, Task 10 production Web E2E.
- DB schema와 firmware는 변경하지 않았다.

## Commits

- `b696185` — `feat(gateway): integrate BIO registration and lighting control`
- `adde52f` — `fix(gateway): skip BIO sensor capability refresh`

## Implementation

### Adapter-owned identity

- `ProvisioningScannerAdapter.acceptsDeviceUuid()`를 추가하고 scan lifecycle의 전역 DFK filter를 제거했다.
- BlueZ는 기존 `parseDfkDeviceUuid()` namespace만 수락한다.
- BIO는 canonical lowercase `bio:[0-9a-f]{12}`만 수락한다.

### Registration and restart recovery

- BIO mesh address는 `0x0001..0x7fff`만 허용한다.
- 신규 등록은 scan cache target의 2초 identify/sensor restore 완료 → mapping reserve → UUID address assignment → same UUID/new address 재확인 → mapping confirm → completed 순서다.
- durable accepted command가 재시작 뒤 복구될 때 confirmed mapping은 physical write 없이 completed로 수렴한다.
- reserved mapping은 저장된 old/new address의 UUID reconciliation 결과가 new-only confirmed일 때만 confirm한다. 불명 결과를 성공으로 추정하거나 address write를 자동 반복하지 않는다.

### Control and read-back truth

- individual control은 confirmed mapping만 사용한다.
- BIO group은 adapter-local virtual membership이며 native RF subscription/broadcast 성공으로 표현하지 않는다.
- group control은 hard concurrency `4`의 unicast fan-out이며 fixture마다 별도 report를 반환한다.
- `BioDongleClient.setOutput()`의 brightness/control-mode read-back 완료 뒤에만 `acknowledged=true`, `outcome=applied`다.
- brightness/mode mismatch error에 관측 percent/raw/mode를 보존하고 failed report와 device-status에 전달한다.
- outer USB ACK만 있는 결과는 applied fixture-state 관측으로 승격하지 않는다.

### Sensor-cloud exclusion

- `BioSensorCapabilityUnavailablePort`는 source 목록을 비우고 lookup을 `null`로 반환한다.
- configure/send는 code와 message 모두 exact `bio_sensor_cloud_unsupported`로 실패한다.
- BIO provisioning adapter의 `vehicleSensorCloudSupported=false`를 Gateway provisioning 완료 경계에서 검사해 capability refresh를 enqueue하지 않는다. 기존 BlueZ/unspecified adapter refresh는 유지한다.

## TDD evidence

Initial RED:

```text
Test Files  7 failed (7)
Tests       5 failed | 115 passed (120)
```

두 missing-module suite와 adapter predicate 미사용, accepted recovery 미사용, reserved lookup 부재, mismatch metadata/observed-state 부재가 기대한 이유로 실패했다. test fixture의 local variable 오류는 바로 수정한 뒤 adapter predicate가 호출되지 않는 기대 RED를 별도로 확인했다.

추가 self-review RED:

```text
BluezMeshAdapter identity: adapter.acceptsDeviceUuid is not a function
BIO virtual membership restart: bio_virtual_group_not_ready
BIO sensor refresh exclusion: requestVehicleSensorCapabilityRefresh is not a function
```

각 RED 뒤 최소 구현을 추가하고 GREEN을 재확인했다.

## Verification

```text
planned focused Task 6: 5 files, 77 passed
BIO and relevant Gateway: 17 files, 455 passed
Gateway full suite: 76 files, 931 passed
Docker contracts: 24 passed, 0 failed
Gateway typecheck: exit 0
Gateway build: exit 0, dist/gateway.mjs 565.6kb
git diff --check: exit 0
```

## Concerns and follow-up

- 실제 hardware/Gateway/deployment write는 실행하지 않았다.
- APK static evidence와 software fake는 physical brightness/address evidence가 아니다.
- Task 7이 BIO adapter를 factory/lifecycle/adapter-aware health에 연결해야 production 경로가 열린다.
- Task 8은 exact raw USB node와 non-root deployment contract를 완료해야 한다.
- Task 9는 승인된 한 장치에서 address assignment, restart recovery, `0/20/60/90/100%` read-back/육안 반응과 sensor restore를 검증해야 한다.
- 다중 장치 group concurrency/partial failure HIL은 장비 수가 부족하면 보류 상태로 명시해야 한다.
- Task 10 전에는 Web/API/Gateway/DB의 production E2E 또는 완전한 BIO 지원을 주장하지 않는다.
