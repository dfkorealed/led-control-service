# Task 16 Fix Round 5 보고서

상태: 완료(소프트웨어/native·production-source host fake·ESP-IDF target build, HIL 미실행)

기준 HEAD: `08dde71550d758d25fefcab4e55dfdabbca544cf`

범위: `task-16-review.md` Fix Round 4 Re-review P2-14를 coordinator ruling에 따라 수정했다. 16 pending, initial+6 retry, 60초+jitter, fixed application memory, sensor-task BLE 금지, exact ACK와 trust/test CID/OTA 정책은 유지했다.

## 원인과 최종 설계

ESP-IDF v5.5.1 `esp_ble_mesh_model_publish()`은 호출 시 shared `model->pub->msg`에 opcode/payload를 쓰고 BTC context에는 model pointer만 넣는다. BTC task가 나중에 pointer를 소비하므로 같은 model의 두 번째 호출이 먼저 실행되면 첫 payload가 덮인다. Fix Round 4의 API 호출 수는 맞았지만 event별 wire snapshot을 증명하지 못했다.

Sensor Status와 vendor event의 application-driven 전송은 `esp_ble_mesh_server_model_send_msg()`로 전환했다. 이 경로는 `btc_transfer_context()`에서 opcode 포함 payload와 `esp_ble_mesh_msg_ctx_t`를 deep-copy한다. Application-owned pending/queue/stack은 계속 고정 크기이고 ESP-IDF 내부 bounded allocation 또는 enqueue 실패는 동기 API error로 반환된다.

전송 context는 다음 계약을 사용한다.

- `net_idx`: 프로젝트 전체 Gateway provisioning 계약 `0`
- `app_idx`, destination address, TTL, friendship credential, SZMIC: 현재 model publication 설정과 exact 일치
- readiness: provisioned, assigned publication address, publication AppKey binding, period `0`, retransmit `0`
- sync 뒤 전송 직전 config가 달라진 경우에도 fail-closed하며 BLE API를 호출하지 않음

Wire destination, Sensor/vendor model, Sensor Status opcode와 vendor event opcode/payload는 기존과 같다. `ESP_BLE_MESH_MODEL_SEND_COMP_EVT`와 기존 publish completion은 request token이 없으므로 advisory no-op다. Sensor는 synchronous API enqueue 결과, vendor는 synchronous 결과와 exact `(bootId, sequence)` ACK/retry exhaustion만 source of truth로 사용한다.

## TDD RED

Production 변경 전 actual `vehicle_sensor_model.c`, `vehicle_sensor_runtime.c`, `vehicle_sensor_mesh_adapter.c`, `vehicle_sensor_health.c`를 strict C11로 링크했다. Fake는 `model_publish`의 shared buffer/model-pointer queue와 server-send의 context/payload deep-copy queue를 다르게 구현하고 BTC 소비를 지연했다.

1. `VEHICLE_SENSOR_FIX5_TEST=shared-overwrite`: sequence 1/2를 back-to-back 제출한 뒤 BTC를 drain했다. 첫 wire payload가 sequence 1이어야 하지만 마지막 sequence 2로 덮여 assertion exit `134`였다.
2. `VEHICLE_SENSOR_FIX5_TEST=sixteen-retry`: 16개 pending initial을 한 worker pass에서 enqueue했다. 각 sequence 1~16이어야 하지만 마지막 payload로 수렴해 initial 검증에서 exit `134`였다. GREEN에서는 initial과 같은 250ms deadline retry 각각의 bootId/sequence가 모두 보존된다.
3. `VEHICLE_SENSOR_FIX5_TEST=sensor-snapshot`: Sensor false/true Status를 back-to-back enqueue했다. 첫 false snapshot이 true로 덮여 exit `134`였다. Immediate failure 뒤 recovery accepted Status snapshot도 같은 테스트에서 검증한다.
4. `VEHICLE_SENSOR_FIX5_TEST=publication-context`: Sensor/vendor send가 publication context를 전달해야 하지만 기존 publish 경로에는 explicit ctx가 없어 AppKey assertion에서 exit `134`였다. 같은 테스트가 period/retransmit mismatch의 readiness/API fail-closed도 검증한다.
5. Gateway focused test는 nonzero Sensor publication retransmit status를 정상 resolve해 12개 중 1개가 RED였다.

## GREEN 구현

- `vehicle_sensor_mesh_adapter.c`에 publication readiness/context builder를 추가하고 Sensor current/vendor event를 server-send API로 전환했다.
- Context는 NetKey `0`과 publication AppKey/address/TTL/credential/SZMIC를 복사한다. Period/retransmit `0`, assigned address와 exact AppKey binding이 아니면 전송하지 않는다.
- Gateway Config Client는 Sensor/vendor publication 요청에 period/retransmit `0`을 명시하고 returned Config Status의 두 값도 exact 검증한다. NetKey/AppKey `0`과 두 publication wire payload를 테스트로 고정했다.
- Model send completion도 기존 completion bridge로 전달하지만 runtime에서는 상태를 바꾸지 않는 no-op다.
- Production-like fake drain 후 sequence 1/2, 16 initial/retry, Sensor snapshots와 두 model context가 exact 보존된다.

## 회귀 유지

- Server-send immediate failure는 기존 Sensor/vendor channel send fault를 올리고 다음 synchronous acceptance 또는 exact vendor ACK가 회복한다.
- Callback 영구 유실, 지연, duplicate-after-reuse와 old generation success/failure는 pending, retry, fault와 Health를 바꾸지 않는다.
- Wrong ACK는 무해하고 exact ACK만 해당 pending/vendor send fault를 회복한다. ACK 부재는 initial+6 retry와 grace 뒤 retry-exhausted로 끝난다.
- Restart는 내부 zero Health source를 외부 current/registered fault 배열에 다시 반영한다.
- 100회 park/restart, config queue saturation recovery, Sensor official requests, authoritative GPIO current와 sensor-task BLE 금지를 유지한다.

## 전체 검증

- Firmware native 4종: codec/retry, Sensor adapter, Health mapping, Task 15 driver 통과
- Production-source host fake 전체와 Fix 5 isolated 4종 통과
- Fix 4 isolated liveness/duplicate/immediate-failure 4종, Fix 3 old-generation/restart Health 2종 통과
- Gateway full: 59 files, 547 tests 통과
- Shared full: 7 files, 75 tests 통과
- Shared/Gateway typecheck, lint, production build 통과
- Build gate, fixed trust policy, artifact audit, signed attestation fixture 통과
- Production valid CID `4660`: `production trust root is not provisioned` expected fail-closed, IDF 미호출
- ESP-IDF `v5.5.1`, target `esp32h2`: dependency fullclean, compile/link, target/map/artifact audit 통과
- Generated config: `CONFIG_BLE_MESH_SETTINGS=y`, `CONFIG_GPIO_CTRL_FUNC_IN_IRAM=y`, test CID `65535`
- Target map: `publish_completions` 없음, advisory completion bridge와 4 KiB worker 존재
- `git diff --check`: 최종 커밋 전 통과 확인

## Binary와 OTA

- `led_control_node.bin`: `0xef9f0` (`981,488`) bytes
- OTA app slot: `0x1f0000` (`2,031,616`) bytes
- OTA free: `0x100610` (`1,050,128`, 52%)
- Production minimum free gate: `406,324` bytes
- Fix Round 4 대비 binary 208 bytes 증가, free 208 bytes 감소
- 산출물 mode/CID: test / `0xFFFF`; flash, HIL, production 사용 금지

## 변경 파일

- Production firmware: `ble_mesh_node.c`, `vehicle_sensor_mesh_adapter.c`, `vehicle_sensor_runtime.c`
- Production Gateway: `bluez-config-client.ts`
- Tests: runtime production-source host fake와 fake ESP-IDF definitions, Gateway Config Client test
- Docs: firmware README, `docs/menus/control.md`, `docs/menus/monitoring.md`, `docs/project-status.md`, active schedule/vehicle plan, `docs/lesson_leared.md`, 누적 Task 16 report와 이 보고서

## HIL 한계

실제 ESP32-H2 flash, Raspberry Pi/BlueZ RF, power-cycle/reprovision/AppKey rebinding, Sensor air packet, packet loss/late ACK, 실제 BTC backlog/heap pressure, delayed/lost/duplicate completion, Health Fault Clear 왕복과 60초+jitter 장시간 측정은 실행하지 않았다. `0xFFFF` test image도 flash하지 않았다.
