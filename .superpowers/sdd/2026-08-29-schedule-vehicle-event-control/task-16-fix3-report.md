# Task 16 Fix Round 3 보고서

상태: 완료(소프트웨어/native·production-source host fake·ESP-IDF target build, HIL 미실행)

기준 HEAD: `87723c44f40d680009d82dc0f019c800de2b953b`

범위: `task-16-review.md` Fix Round 2 Re-review의 신규 P2-10/P2-11 두 건만 수정했다. 기존 wire/retry/current/cadence/worker/trust 계약은 변경하지 않았다.

## P2-10 generation-bound publish completion

ESP-IDF v5.5.1의 `ESP_BLE_MESH_MODEL_PUBLISH_COMP_EVT` parameter는 `err_code`와 `model`만 제공하고 custom context, opcode, runtime generation은 제공하지 않는다. `esp_ble_mesh_model_publish()`은 BTC context transfer 뒤 별도 callback을 올린다. 확인한 local source는 다음과 같다.

- `/Users/kim-jh/esp/esp-idf/components/bt/esp_ble_mesh/api/esp_ble_mesh_defs.h:2485-2491`
- `/Users/kim-jh/esp/esp-idf/components/bt/esp_ble_mesh/api/core/esp_ble_mesh_networking_api.c:90-111,206-216`
- `/Users/kim-jh/esp/esp-idf/components/bt/esp_ble_mesh/btc/btc_ble_mesh_prov.c:568-575,2903-2907`

이를 순서 추측으로 보완하지 않고 Sensor/vendor 채널 2개에 대응하는 고정 ledger를 만들었다. Worker는 실제 publish API 호출 전에 `(channel, model, opcode, run generation)`을 예약한다. ESP-IDF callback에 opcode가 없으므로 같은 model은 정확히 한 publish만 in-flight로 허용한다. Callback은 model과 일치하는 단 하나의 slot을 critical section에서 소비하며, 저장 generation이 현재 generation과 다르면 channel fault atomics와 Health에 접근하지 않는다. API enqueue가 즉시 실패하면 callback이 오지 않는 실제 IDF 경로에 맞춰 같은 generation slot을 즉시 취소한다.

`run_generation`은 intake를 `OPEN`으로 바꾸기 전에 먼저 공개한다. 따라서 start 중간에 이전 completion이 끼어들어도 새 session producer로 들어갈 수 없다. Ledger는 static 2-slot `.bss` `0x28`이고 event별 allocation은 없다.

## P2-11 restart Health exact sync

새 runtime session은 기존 정책대로 내부 Health active/history와 Sensor/vendor send fault flag를 0으로 초기화한다. 초기화 직후 fault handler를 `(0, 0)`으로 강제 호출하도록 바꿨다. Production handler는 `vehicle_sensor_active_fault_mask`, `vehicle_sensor_history_fault_mask`를 갱신하고 ESP BLE Mesh Health Server current/registered 배열을 zero부터 exact rebuild한다. System fault `0x01`은 기존 독립 source 정책을 유지한다.

## TDD RED

두 테스트 모두 actual `vehicle_sensor_runtime.c`, `vehicle_sensor_mesh_adapter.c`, `vehicle_sensor_health.c`, `vehicle_sensor_model.c`를 링크했다.

1. `VEHICLE_SENSOR_FIX3_TEST=generation`: generation N vendor publish completion을 지연하고 N+1 vendor fault를 만든 뒤 N success를 전달했다. 기존 코드는 새 fault를 지워 `test_vehicle_sensor_model_runtime.c:588`의 active `0x82` assertion으로 종료 코드 134를 냈다. Healthy N+1에 N failure를 전달하는 반대 경로도 같은 테스트에 포함했다.
2. `VEHICLE_SENSOR_FIX3_TEST=health`: production Health mapper로 외부 current/registered 배열에 `0x82`를 만든 뒤 stop/start했다. 기존 코드는 restart zero snapshot callback을 호출하지 않아 `test_vehicle_sensor_model_runtime.c:620`의 callback change assertion으로 종료 코드 134를 냈다.

구현 뒤 두 isolated test와 host 전체 suite가 GREEN으로 전환됐다. Host fake의 성공 completion은 publish 호출 안에서 동기 전달할 수도 있어 callback-before-return concurrency도 실행하며, 지연 mode는 stop/start 뒤 old-generation callback을 실행한다.

## 회귀 결과

- Firmware native: model codec/retry, Sensor adapter, Health mapping, Task 15 driver strict C11 `-Wall -Wextra -Werror -pedantic` 통과
- Production-source host fake: delayed success/failure completion, stale 외부 Health 배열, config saturation, Sensor requests, channel fault/ACK, 100회 stop/start와 test-build fail-stop 통과
- Gateway full: 59 files, 546 tests 통과
- Shared full: 7 files, 75 tests 통과
- Shared/Gateway typecheck, lint, production build 통과
- Build gate, fixed trust policy, artifact/OTA audit, signed attestation fixture 통과
- Production valid CID preflight: `production trust root is not provisioned`로 IDF 실행 전 expected fail-closed
- ESP-IDF v5.5.1 `esp32h2`: `set-target` dependency fullclean, compile/link, Sensor target source/map audit, artifact audit 통과
- Generated config: `CONFIG_BLE_MESH_SETTINGS=y`, `CONFIG_GPIO_CTRL_FUNC_IN_IRAM=y`, test CID `65535`
- `git diff --check`: 통과

## Binary와 OTA

- `led_control_node.bin`: `0xefc70` (`982,128`) bytes
- OTA app slot: `0x1f0000` (`2,031,616`) bytes
- OTA free: `0x100390` (`1,049,488`, 52%)
- Production minimum free gate: `406,324` bytes
- Fix Round 2 대비 binary `752` bytes 증가, free `752` bytes 감소
- 산출물 mode/CID: test / `0xFFFF`; flash, HIL, production 사용 금지

## 변경 파일

- Production: `vehicle_sensor_runtime.c`, `vehicle_sensor_runtime.h`, `ble_mesh_node.c`
- Tests: `test_vehicle_sensor_model_runtime.c`, `test_vehicle_sensor_model_target_artifact.sh`, `test_esp32_h2_build_gate.sh`
- Docs: firmware README, `docs/menus/control.md`, project status/plan, 누적 Task 16 report와 이 보고서

## HIL 한계

실제 ESP32-H2 flash, Raspberry Pi/BlueZ RF, power-cycle/reprovision/AppKey rebinding, 실제 delayed BTC completion interleaving, Sensor air packet, packet loss/late ACK, Health Fault Clear 왕복과 60초+jitter 장시간 측정은 실행하지 않았다. `0xFFFF` test image도 flash하지 않았다.
