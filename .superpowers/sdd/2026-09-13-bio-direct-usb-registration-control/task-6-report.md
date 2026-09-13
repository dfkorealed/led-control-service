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

## Review hardening — 2026-09-13

### Status

DONE_WITH_CONCERNS

Task 6 review의 여섯 지적을 software integration 범위에서 보완했다. 실제 BIO 동글, Raspberry Pi Gateway, 조명, 운영 MQTT, 배포는 접근하거나 변경하지 않았다. 따라서 Task 7–10 및 승인 HIL 전에는 production-complete로 판정하지 않는다.

### Fix base and commit

- Verified clean fix base: `64360bb65174ada881c6ea8fa04aaf03844631a1`
- Implementation fix: `de23cc95cecb1d4ca8ec41578c184e0375fd1198` — `fix(gateway): harden BIO recovery and observation truth`

### Review fixes

- cancellation/deadline을 BIO client operation queue까지 전달하고 queue 획득 직후와 각 새 physical write/read 직전에 재검사한다. brightness 단계 취소 뒤 force-on/read/applied는 발생하지 않는다. identify의 sensor-mode restore만 안전 복귀를 위한 의도적 post-expiry write 예외다.
- OFF mismatch 또는 table 밖 raw에서 요청 brightness를 관측값으로 대입하지 않는다. 실제 percent를 모르면 brightness를 생략하고 raw/mode 진단 metadata만 보존한다.
- Gateway startup journal이 generic `provisioning_outcome_unknown` 처리 전에 BIO adapter recovery를 호출한다. confirmed mapping은 write 없이 같은 completed terminal로 수렴하고, reserved mapping은 old/new UUID reconciliation만 수행한다. recovery 계약이 없는 BlueZ 동작은 그대로다.
- startup에서 durable `ready` group snapshot을 BIO adapter local virtual membership으로 수화한다. confirmed node/address가 일치한 fixture만 포함하며 native group subscription 성공을 만들지 않는다.
- BIO mismatch의 실제 read-back brightness/mode를 command handler, journal result, index filter/publisher까지 전달한다. brightness가 실제 관측되지 않으면 fixture-state event를 발행하지 않는다.
- `parallel_unicast`가 8을 전달해도 adapter 내부를 포함한 모든 BIO multi-unicast 경로의 최대 동시성을 4로 고정한다.

### Strict RED evidence

초기 review regression RED:

```text
Test Files  4 failed (4)
Tests       16 failed | 138 passed (154)
```

추가 self-review RED:

```text
read-back waiter abort cleanup: 1 failed | 54 skipped
hydration node/address identity: 1 failed | 18 skipped
```

각 RED는 production code 변경 전에 확인했고, 원인은 각각 queue control 부재, requested brightness fallback, startup recovery/hydration 미연결, mismatch filter 누락, concurrency 상한 미강제, listener cleanup 및 node identity 미검증이었다.

### GREEN verification

```text
review focused: 4 files, 155 passed
expanded cancellation/recovery/group/BlueZ: 7 files, 220 passed
planned focused Task 6: 5 files, 82 passed
BIO and relevant Gateway: 18 files, 480 passed
Gateway full suite: 76 files, 946 passed
Docker contracts: 24 passed, 0 failed
Gateway typecheck: exit 0
Gateway build: exit 0, dist/gateway.mjs 568.0kb
git diff --check: exit 0
```

### Remaining concerns

- 본 결과는 fake transport/store와 자동 테스트에 근거한 software integration 검증이다.
- Task 7의 factory/lifecycle/health 연결, Task 8 deployment contract, Task 9 승인 HIL, Task 10 production Web E2E는 여전히 필요하다.
- identify post-expiry sensor restore 및 address/brightness physical truth는 Task 9에서 실제 장치로 확인해야 한다.
