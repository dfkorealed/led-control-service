# Task 16 Fix Round 5 누적 보고서

상태: 완료(소프트웨어/native·production-source host fake·ESP-IDF target build, HIL 미실행)

기준: `task-16-review.md` Fix Round 4 Re-review의 P2-14와 coordinator ruling을 Fix Round 5 최종 계약으로 적용했다. 상세 RED/GREEN과 전체 검증은 `task-16-fix5-report.md`에 기록한다.

## Fix Round 5 최종 처리

| Review finding | 최종 수정 | 회귀 증거 |
| --- | --- | --- |
| P2-14 back-to-back publish가 shared publication buffer를 덮어씀 | Sensor Status와 vendor event의 application-driven 전송을 `esp_ble_mesh_server_model_send_msg()`로 전환했다. ESP-IDF가 BTC enqueue 시 opcode 포함 payload와 context를 deep-copy하므로 이후 호출이 이전 snapshot을 바꾸지 않는다. | Delayed BTC fake에서 sequence 1/2, 16개 initial과 같은 250ms deadline retry 각각의 `(bootId, sequence)`, Sensor false/true/recovery Status가 호출별로 보존된다. |
| Publication context/config 계약이 application send로 전달되지 않음 | NetKey는 Gateway provisioning 계약의 index `0`, AppKey/address/TTL/credential/SZMIC는 현재 model publication 설정을 exact 반영한다. Address/binding과 period/retransmit `0`이 아니면 sync와 전송 직전 모두 fail-closed한다. | Sensor/vendor 두 context의 모든 필드와 period/retransmit mismatch 차단을 host fake로 검증했다. Gateway도 NetKey/AppKey `0`, period/retransmit `0` 요청 payload와 nonzero retransmit status 거부를 고정했다. |

## 최종 신뢰 계약

- Sensor Status와 vendor event는 기존 publication destination, model과 wire opcode/payload를 유지하되 shared `model->pub->msg`를 사용하지 않는다.
- Sensor Status는 server-send API의 동기 BTC enqueue 수락/거부만 반영한다. Immediate API failure는 Sensor send fault를 올리고 다음 accepted cadence/recovery call이 회복한다.
- Vendor event는 API가 수락해도 exact `(bootId, sequence)` ACK까지 16-slot pending에 남는다. Immediate API failure는 vendor send fault를 올리고 다음 accepted call 또는 exact ACK가 회복하며, ACK가 없으면 retry exhaustion이 terminal source다.
- `ESP_BLE_MESH_MODEL_SEND_COMP_EVT`와 기존 publish completion은 request token이 없어 advisory no-op다. 유실, 지연, 중복과 이전 generation callback은 pending, retry, Health와 liveness를 바꾸지 않는다.
- Driver callback은 BLE API와 log 없이 static worker queue에만 nonblocking handoff한다. Application-owned queue/pending/stack은 고정 크기이며 ESP-IDF 내부 bounded allocation/deep-copy 실패는 동기 API error로 표면화된다.

## 이전 Fix 계약 유지

- `CONFIG_BLE_MESH_SETTINGS=y`, Sensor stack period/retransmit `0`, custom `60,000ms + FNV-1a(unicast)%5,000ms` cadence를 유지한다.
- Sensor Descriptor/Get/Column/Series 공식 Status와 Task 15 authoritative GPIO current source를 유지한다.
- Worker/queue는 한 번만 생성하고 generation별 park/restart한다. 100회 restart에서 task create 1회, delete 0회와 새 boot ID/stale command 부재를 유지한다.
- Sensor/vendor send fault active source는 분리하고 외부 Health `0x82`는 OR로 구성한다. Restart는 내부 zero active/history를 외부 Health current/registered 배열에 강제 동기화한다.
- Sequence `UINT32_MAX` fail-stop, 16 pending, initial+6 retry, queue admission 24/전체 32, trust/test CID/OTA 정책과 sensor-task BLE 금지를 유지한다.

## TDD와 검증

- Fix Round 5 RED: shared-overwrite, 16 pending retry, Sensor snapshot/recovery, publication context focused test가 production 변경 전 각각 exit `134`로 실패했다. Gateway nonzero retransmit status test도 정상 resolve되어 1건 실패했다.
- GREEN: deep-copy server-send와 exact context/readiness 적용 뒤 Fix 5 isolated 4종, Fix 4 liveness/duplicate/immediate-failure 4종, Fix 3 generation/Health 2종과 production-source host fake 전체가 통과했다.
- Native: codec/retry, Sensor adapter, Health mapping, Task 15 driver strict C11 `-Wall -Wextra -Werror -pedantic` 통과.
- Gateway 전체 59파일 547/547, shared 전체 7파일 75/75 통과.
- Shared/Gateway typecheck, lint, production build 통과.
- Build gate, fixed trust policy, artifact audit, signed attestation fixture 통과.
- Production valid CID `4660`은 `production trust root is not provisioned`로 IDF 실행 전 expected fail-closed했다.
- ESP-IDF v5.5.1 `esp32h2` dependency fullclean test build, target/map/artifact audit 통과. Generated config는 `CONFIG_BLE_MESH_SETTINGS=y`, `CONFIG_GPIO_CTRL_FUNC_IN_IRAM=y`, test CID `65535`다.
- Target map에 `publish_completions`가 없고 advisory completion bridge, 4 KiB worker, Sensor/vendor model과 server-send 경로가 유지된다.

## 산출물

- `led_control_node.bin`: `0xef9f0` (`981,488`) 바이트
- OTA app slot: `0x1f0000` (`2,031,616`) 바이트
- OTA free: `0x100610` (`1,050,128`, 약 52%)
- Production minimum free gate: `406,324` 바이트
- Fix Round 4 대비 binary 208바이트 증가, free 208바이트 감소
- 산출물 mode/CID: test / `0xFFFF`; flash, HIL, production 사용 금지

## 변경 범위

- Firmware: `ble_mesh_node.c`, `vehicle_sensor_mesh_adapter.c`, `vehicle_sensor_runtime.c`
- Gateway: `bluez-config-client.ts`
- Tests: production-source runtime host fake/ESP-IDF fake definitions, Gateway Config Client
- Docs: firmware README, 제어·모니터링 메뉴 현황, project status/active plan, lesson learned, 누적 보고서와 Fix Round 5 상세 보고서

## HIL 한계

- 실제 ESP32-H2 flash, Raspberry Pi/BlueZ provisioning과 RF 연결은 실행하지 않았다.
- 실제 power-cycle/reprovision/AppKey rebinding, BTC backlog 중 payload lifetime, Sensor air packet, packet loss/late ACK, completion 유실·지연·중복, Health Fault Clear 왕복과 60초+jitter 장시간 측정은 미실행이다.
- 실제 센서 전압/noise/ESD/surge, cache-disabled ISR과 concurrent BLE stack timing은 software/build 결과로 증명하지 않는다.
- Production Company ID, trust root/release key와 제조 승인 자료가 provision되기 전 production image 생성은 의도적으로 불가능하다.
