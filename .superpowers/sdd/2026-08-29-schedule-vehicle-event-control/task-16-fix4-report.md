# Task 16 Fix Round 4 보고서

상태: 완료(소프트웨어/native·production-source host fake·ESP-IDF target build, HIL 미실행)

기준 HEAD: `00fbf63273337012ed5038b05be7d93e4c29fd28`

범위: `task-16-review.md` Fix Round 3 Re-review의 P2-12/P2-13을 coordinator ruling에 따라 수정했다. 16 pending, initial+6 retry, 60초+jitter, fixed memory, sensor-task BLE 금지, trust/test CID/OTA 정책은 유지했다.

## 원인과 최종 설계

ESP-IDF v5.5.1 `ESP_BLE_MESH_MODEL_PUBLISH_COMP_EVT`는 model pointer와 error만 제공한다. Same-model 요청 식별자, opcode, payload sequence, runtime generation이 없으므로 delayed completion, duplicate-after-reuse와 현재 publish를 결정적으로 구분할 수 없다.

Fix Round 3 ledger는 이 정보 부족을 model 단일 in-flight로 보완했지만, callback 보류/유실 동안 다음 initial·retry·cadence를 `BUSY`로 막았다. Core는 transport API가 호출되지 않은 `BUSY`도 retry 시도로 소모했고, slot 재사용 뒤 old duplicate는 새 slot을 소비해 fault를 오염시켰다.

최종 구현은 completion ledger와 same-model in-flight 차단을 전부 제거했다. Completion bridge는 상태와 liveness를 바꾸지 않는 advisory no-op다. 개별 송신 신뢰 원천은 다음으로 제한한다.

- Sensor Status: `esp_ble_mesh_model_publish()` 동기 수락/거부. `ESP_OK`이면 완료, immediate failure면 Sensor send fault다.
- Vendor event: 동기 수락/거부와 exact bootId+sequence ACK, retry exhaustion. 수락 뒤에도 ACK까지 pending이다.
- Recovery: 다음 accepted API call은 해당 channel send fault를 내리고 exact ACK도 vendor send fault를 내린다.

## TDD RED

Actual `vehicle_sensor_model.c`, `vehicle_sensor_runtime.c`, `vehicle_sensor_mesh_adapter.c`, `vehicle_sensor_health.c`를 strict C11로 링크한 production-source host fake를 사용했다. Production 수정 전 네 isolated test가 모두 의도한 assertion으로 실패했다.

1. `VEHICLE_SENSOR_FIX4_TEST=vendor-liveness`: callback 보류 중 sequence 1/2 event를 연속 submit했다. 두 initial 기대값 2에 실제 1이라 line 508에서 exit 134였다. GREEN에서는 각 sequence가 initial+6 retry로 정확히 7회, 총 14회 publish된다.
2. `VEHICLE_SENSOR_FIX4_TEST=sensor-liveness`: 첫 Sensor completion을 영구 유실시킨 뒤 다음 cadence를 진행했다. 기대 count 2에 실제 1이라 line 540에서 exit 134였다.
3. `VEHICLE_SENSOR_FIX4_TEST=duplicate`: A success 뒤 B publish를 시작하고 A duplicate failure를 주입했다. B에 귀속되어 send fault가 active가 되므로 line 599에서 exit 134였다.
4. `VEHICLE_SENSOR_FIX4_TEST=immediate-failure`: Sensor immediate API failure 뒤 다음 API call을 수락했지만 completion을 보류했다. Fault가 남아 line 640에서 exit 134였다.

기존 `VEHICLE_SENSOR_FIX3_TEST=generation`과 `health`는 삭제하지 않았다. 이전 generation completion success/failure 무해성과 restart 외부 Health zero snapshot을 계속 검증한다. Wrong/exact ACK와 vendor immediate failure recovery 테스트도 유지한다.

## GREEN 구현

- `vehicle_sensor_runtime.c`의 2-slot completion struct/array, critical-section mux, reserve/cancel/identity 함수를 제거했다.
- Vendor initial/retry는 readiness가 있으면 매번 adapter publish를 호출한다. API `OK`는 vendor send fault를 회복하지만 pending은 exact ACK까지 유지한다.
- Sensor cadence/recovery는 이전 completion과 무관하게 매번 adapter publish를 호출한다. API `OK`에서 Sensor send fault를 회복하고 정상 cadence를 예약한다.
- Completion callback 입력은 model/error를 소비하지 않는 no-op다. 따라서 유실·중복·지연·restart generation은 상태를 바꿀 수 없다.
- Target audit는 restart Health sync를 유지하고 source/map에 `publish_completions`가 다시 나타나면 실패한다.

## 전체 검증

- Firmware native 4종: codec/retry, Sensor adapter, Health mapping, Task 15 driver 통과
- Production-source host fake 전체: Fix 4 isolated 4종, Fix 3 generation/Health, 100회 lifecycle, config saturation, Sensor requests, channel fault/ACK 통과
- Gateway full: 59 files, 546 tests 통과
- Shared full: 7 files, 75 tests 통과
- Shared/Gateway typecheck, lint, production build 통과
- Build gate, fixed trust policy, artifact audit, signed attestation fixture 통과
- Production valid CID `4660`: `production trust root is not provisioned` expected fail-closed, IDF 미호출
- ESP-IDF `v5.5.1`, target `esp32h2`: dependency fullclean, compile/link, target/map/artifact audit 통과
- Generated config: `CONFIG_BLE_MESH_SETTINGS=y`, `CONFIG_GPIO_CTRL_FUNC_IN_IRAM=y`, test CID `65535`
- Target map: `publish_completions` 없음, advisory completion bridge와 4 KiB worker 존재
- `git diff --check`: 통과

## Binary와 OTA

- `led_control_node.bin`: `0xef920` (`981,280`) bytes
- OTA app slot: `0x1f0000` (`2,031,616`) bytes
- OTA free: `0x1006e0` (`1,050,336`, 52%)
- Production minimum free gate: `406,324` bytes
- Fix Round 3 대비 binary 848 bytes 감소, free 848 bytes 증가
- 산출물 mode/CID: test / `0xFFFF`; flash, HIL, production 사용 금지

## 변경 파일

- Production: `apps/esp32-h2-firmware/main/vehicle_sensor_runtime.c`, `vehicle_sensor_runtime.h`
- Tests: `test_vehicle_sensor_model_runtime.c`, `test_vehicle_sensor_model_target_artifact.sh`, `test_esp32_h2_build_gate.sh`
- Docs: firmware README, `docs/menus/control.md`, `docs/project-status.md`, active schedule/vehicle plan, `docs/lesson_leared.md`, 누적 Task 16 report와 이 보고서

## HIL 한계

실제 ESP32-H2 flash, Raspberry Pi/BlueZ RF, power-cycle/reprovision/AppKey rebinding, Sensor air packet, packet loss/late ACK, delayed/lost/duplicate BTC completion, Health Fault Clear 왕복과 60초+jitter 장시간 측정은 실행하지 않았다. `0xFFFF` test image도 flash하지 않았다.
