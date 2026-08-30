# Task 16 Fix Round 4 누적 보고서

상태: 완료(소프트웨어/native·production-source host fake·ESP-IDF target build, HIL 미실행)

기준: `task-16-review.md` Fix Round 3 Re-review의 P2-12/P2-13과 coordinator ruling을 Fix Round 4 최종 계약으로 적용했다. 상세 RED/GREEN과 전체 검증은 `task-16-fix4-report.md`에 기록한다.

## Fix Round 4 최종 처리

| Review finding | 최종 수정 | 회귀 증거 |
| --- | --- | --- |
| P2-12 same-model `BUSY`가 미송신 retry를 소모하고 callback 유실 시 정체 | ESP-IDF v5.5.1 model-only completion ledger와 model 단위 단일 in-flight 차단을 제거했다. 모든 vendor event의 initial과 6개 retry deadline은 실제 `esp_ble_mesh_model_publish()`을 호출한다. Sensor도 이전 completion을 기다리지 않고 다음 cadence/recovery publish를 호출한다. | Callback을 보류한 두 event의 sequence 1/2가 각각 initial 1회와 retry 6회, 총 7회씩 transport에 도달한다. Sensor completion 영구 유실 뒤 두 번째 cadence publish도 호출된다. |
| P2-13 slot 재사용 뒤 old duplicate가 새 completion으로 오인 | Completion callback은 model/error를 개별 publish에 상관할 수 없으므로 runtime state를 전혀 바꾸지 않는 advisory no-op로 제한했다. Slot과 generation correlation state 자체가 없다. | A completion 뒤 B publish를 시작한 후 A duplicate failure/success를 주입해도 send fault는 0이고 B retry가 실제 호출되며 exact B ACK 뒤 후속 retry가 없다. 이전 generation success/failure 테스트도 유지된다. |

## 최종 신뢰 계약

- Sensor Status는 `esp_ble_mesh_model_publish()`의 동기 반환이 `ESP_OK`이면 해당 송신을 완료로 본다. Immediate API failure만 Sensor send fault를 올리고 다음 accepted cadence/recovery call이 회복한다.
- Vendor event는 API가 수락해도 exact `(bootId, sequence)` ACK까지 16-slot pending에 남는다. Immediate API failure는 vendor send fault를 올리고 다음 accepted call 또는 exact ACK가 회복한다. 전달 신뢰도는 exact ACK와 retry exhaustion으로 판정한다.
- `ESP_BLE_MESH_MODEL_PUBLISH_COMP_EVT`는 model/error만 제공하므로 개별 channel Health, pending, retry, recovery와 liveness에 사용하지 않는다. 유실, 지연, 중복, 이전 generation callback은 모두 무해하다.
- Driver callback은 BLE API와 log 없이 static worker queue에만 nonblocking handoff한다. Sensor/vendor BLE 호출은 4 KiB static model worker에서 수행하며 event별 동적 allocation은 없다.
- Vendor payload는 version, bootId LE32, sequence LE32, kind, level의 11바이트이고 ACK는 version, bootId LE32, sequence LE32의 9바이트다. Initial 뒤 250ms, 500ms, 1s, 2s, 4s, 8s에 6회 retry한다.

## 이전 Fix 계약 유지

- `CONFIG_BLE_MESH_SETTINGS=y`, Sensor stack period 0, custom `60,000ms + FNV-1a(unicast)%5,000ms` cadence를 유지한다.
- Sensor Descriptor/Get/Column/Series 공식 Status와 Task 15 authoritative GPIO current source를 유지한다.
- Worker/queue는 한 번만 생성하고 generation별 park/restart한다. 100회 restart에서 task create 1회, delete 0회와 새 boot ID/stale command 부재를 유지한다.
- Sensor/vendor send fault active source는 분리하고 외부 Health `0x82`는 OR로 구성한다. Restart는 내부 zero active/history를 외부 Health current/registered 배열에 강제 동기화한다.
- Sequence `UINT32_MAX` fail-stop, 16 pending, queue admission 24/전체 32, fixed memory, trust/test CID/OTA 정책을 유지한다.

## TDD와 검증

- Fix Round 4 RED: 기존 ledger에서 vendor initial count가 `1/2`, Sensor cadence가 `1/2`였고 duplicate failure가 B의 send fault를 active로 만들며 accepted Sensor API call 뒤 fault가 남는 네 assertion이 각각 exit 134로 실패했다.
- GREEN: ledger 제거와 동기 API 결과 기반 channel recovery 뒤 네 isolated test, Fix Round 3 old-generation completion/restart Health test와 production-source host fake 전체가 통과했다.
- Native: codec/retry, Sensor adapter, Health mapping, Task 15 driver strict C11 `-Wall -Wextra -Werror -pedantic` 통과.
- Gateway 전체 59파일 546/546, shared 전체 7파일 75/75 통과.
- Shared/Gateway typecheck, lint, production build 통과.
- Build gate, fixed trust policy, artifact audit, signed attestation fixture 통과.
- Production valid CID `4660`은 `production trust root is not provisioned`로 IDF 실행 전 expected fail-closed했다.
- ESP-IDF v5.5.1 `esp32h2` dependency fullclean test build, target/map/artifact audit 통과. Generated config는 `CONFIG_BLE_MESH_SETTINGS=y`, `CONFIG_GPIO_CTRL_FUNC_IN_IRAM=y`, test CID `65535`다.
- Target map에 `publish_completions`가 없고 advisory completion bridge, 4 KiB worker, Sensor/vendor model 심볼은 유지된다.
- `git diff --check` 통과.

## 산출물

- `led_control_node.bin`: `0xef920` (`981,280`) 바이트
- OTA app slot: `0x1f0000` (`2,031,616`) 바이트
- OTA free: `0x1006e0` (`1,050,336`, 약 52%)
- Production minimum free gate: `406,324` 바이트
- Fix Round 3 대비 binary 848바이트 감소, free 848바이트 증가
- 산출물 mode/CID: test / `0xFFFF`; flash, HIL, production 사용 금지

## 변경 범위

- Firmware: `vehicle_sensor_runtime.c`, `vehicle_sensor_runtime.h`
- Tests: production-source runtime host fake, target source/linker-map audit와 build-gate map fixture
- Docs: firmware README, 제어 메뉴 현황, project status/plan, lesson learned, 누적 보고서와 Fix Round 4 상세 보고서

## HIL 한계

- 실제 ESP32-H2 flash, Raspberry Pi/BlueZ provisioning과 RF 연결은 실행하지 않았다.
- 실제 power-cycle/reprovision/AppKey rebinding, Sensor air packet, packet loss/late ACK, delayed/lost/duplicate BTC callback, Health Fault Clear 왕복과 60초+jitter 장시간 측정은 미실행이다.
- 실제 센서 전압/noise/ESD/surge, cache-disabled ISR과 concurrent BLE stack timing은 software/build 결과로 증명하지 않는다.
- Production Company ID, trust root/release key와 제조 승인 자료가 provision되기 전 production image 생성은 의도적으로 불가능하다.
