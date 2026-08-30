# Task 16 Breaker 누적 보고서

상태: 완료(소프트웨어/native·production-source host fake·ESP-IDF target build, HIL 미실행)

기준: Fix Round 5의 P2-14 수정 뒤 `task-16-review.md`에서 확인된 load-bearing P2-15와 coordinator breaker ruling을 최종 계약으로 적용했다. Fix Round 5 상세는 `task-16-fix5-report.md`, breaker RED/GREEN과 patch ownership은 `task-16-breaker-report.md`에 기록한다.

## Fix Round 5 + Breaker 최종 처리

| Review finding | 최종 수정 | 회귀 증거 |
| --- | --- | --- |
| P2-14 back-to-back publish가 shared publication buffer를 덮어씀 | Sensor Status와 vendor event의 application-driven 전송을 `esp_ble_mesh_server_model_send_msg()`로 전환했다. ESP-IDF가 BTC enqueue 시 opcode 포함 payload와 context를 deep-copy하므로 이후 호출이 이전 snapshot을 바꾸지 않는다. | Delayed BTC fake에서 sequence 1/2, 16개 initial과 같은 250ms deadline retry 각각의 `(bootId, sequence)`, Sensor false/true/recovery Status가 호출별로 보존된다. |
| Publication context/config 계약이 application send로 전달되지 않음 | NetKey는 Gateway provisioning 계약의 index `0`, AppKey/address/TTL/credential/SZMIC는 현재 model publication 설정을 exact 반영한다. Address/binding과 period/retransmit `0`이 아니면 sync와 전송 직전 모두 fail-closed한다. | Sensor/vendor 두 context의 모든 필드와 period/retransmit mismatch 차단을 host fake로 검증했다. Gateway도 NetKey/AppKey `0`, period/retransmit `0` 요청 payload와 nonzero retransmit status 거부를 고정했다. |
| P2-15 nested deep-copy allocation 실패가 `void` callback에서 유실됨 | Pinned ESP-IDF v5.5.1의 `SERVER_MODEL_SEND`만 API thread에서 payload/context를 all-or-nothing snapshot하는 repository patch를 적용했다. Queue 수락 전 실패는 동기 오류와 caller cleanup, 수락 후에는 handler deep-free 1회를 보장한다. | 실제 patched source allocator fault harness에서 payload/context/envelope/queue-post 실패, delayed success와 client-send 비변경을 검증했다. 16 burst failure는 pending/retry exact snapshot으로 수렴한다. |

## 최종 신뢰 계약

- Sensor Status와 vendor event는 기존 publication destination, model과 wire opcode/payload를 유지하되 shared `model->pub->msg`를 사용하지 않는다.
- Sensor Status는 patched server-send API의 동기 BTC enqueue 수락/거부만 반영한다. Payload/context/envelope allocation과 queue post 실패는 handler 실행 없이 동기 오류가 되고, 다음 accepted cadence/recovery call이 Sensor send fault를 회복한다.
- Vendor event는 API가 수락해도 exact `(bootId, sequence)` ACK까지 16-slot pending에 남는다. Immediate API failure는 vendor send fault를 올리고 다음 accepted call 또는 exact ACK가 회복하며, ACK가 없으면 retry exhaustion이 terminal source다.
- `ESP_BLE_MESH_MODEL_SEND_COMP_EVT`와 기존 publish completion은 request token이 없어 advisory no-op다. 유실, 지연, 중복과 이전 generation callback은 pending, retry, Health와 liveness를 바꾸지 않는다.
- Driver callback은 BLE API와 log 없이 static worker queue에만 nonblocking handoff한다. Application-owned queue/pending/stack은 고정 크기다. ESP-IDF patch가 API-thread payload/context ownership을 모두 확보한 뒤에만 BTC queue로 넘기므로 NULL handler input, double-free와 accepted-but-unsent allocation failure를 차단한다.

## ESP-IDF patch/산출물 계약

- Upstream은 exact `v5.5.1`, commit `fcae32885b0296b32044cb99ecbdc50d98dddb83`과 세 경계 source SHA-256로 고정한다.
- 사용자 global checkout은 수정하지 않는다. Build/flash wrapper가 외부 build workdir에 `components/bt` project overlay를 만들고 patch digest `dc6f4c7d62203444686416a6a511ceb366fa7162a47b9ff90520c9c047205df5`를 멱등 적용한다.
- Wrong commit/tag/hash, unpatched/tampered overlay는 원본을 덮어쓰지 않고 fail-closed한다. Target audit는 `compile_commands.json`이 patched source를 실제 compile했는지 확인한다.
- Test manifest v3와 production signed attestation v2는 ESP-IDF version/commit, patch/patched-source/identity digest를 기존 binary/OTA/config/map/approval identity와 함께 결속한다.

## 이전 Fix 계약 유지

- `CONFIG_BLE_MESH_SETTINGS=y`, Sensor stack period/retransmit `0`, custom `60,000ms + FNV-1a(unicast)%5,000ms` cadence를 유지한다.
- Sensor Descriptor/Get/Column/Series 공식 Status와 Task 15 authoritative GPIO current source를 유지한다.
- Worker/queue는 한 번만 생성하고 generation별 park/restart한다. 100회 restart에서 task create 1회, delete 0회와 새 boot ID/stale command 부재를 유지한다.
- Sensor/vendor send fault active source는 분리하고 외부 Health `0x82`는 OR로 구성한다. Restart는 내부 zero active/history를 외부 Health current/registered 배열에 강제 동기화한다.
- Sequence `UINT32_MAX` fail-stop, 16 pending, initial+6 retry, queue admission 24/전체 32, trust/test CID/OTA 정책과 sensor-task BLE 금지를 유지한다.

## TDD와 검증

- Fix Round 5 RED: shared-overwrite, 16 pending retry, Sensor snapshot/recovery, publication context focused test가 production 변경 전 각각 exit `134`로 실패했다. Gateway nonzero retransmit status test도 정상 resolve되어 1건 실패했다.
- Breaker RED: pristine actual networking source의 context allocation failure가 `ESP_OK`를 반환해 boundary assertion이 exit `134`로 실패했다. Production-source 16 burst도 context failure event를 accepted해 기대 queue 수를 초과하며 exit `134`로 실패했다.
- GREEN: actual patched source의 payload/context/envelope/queue-post fault가 handler 0회와 exact free를 만족했다. Delayed success는 snapshot과 deep-free 1회, client send는 기존 secondary deep-copy를 유지했다. Fix 5 isolated 4종, allocation burst, Fix 3/4 회귀와 production-source host fake 전체가 통과했다.
- Native: codec/retry, Sensor adapter, Health mapping, Task 15 driver strict C11 `-Wall -Wextra -Werror -pedantic` 통과.
- Gateway 전체 59파일 547/547, shared 전체 7파일 75/75 통과.
- Shared/Gateway typecheck, lint, production build 통과.
- Patch idempotency/wrong-source gate, build gate, fixed trust policy, artifact audit, signed attestation fixture 통과.
- Production valid CID `4660`은 `production trust root is not provisioned`로 IDF 실행 전 expected fail-closed했다.
- Patched ESP-IDF v5.5.1 `esp32h2` dependency fullclean test build, target/map/artifact audit와 build-only compile source 확인을 통과했다. Generated config는 `CONFIG_BLE_MESH_SETTINGS=y`, `CONFIG_GPIO_CTRL_FUNC_IN_IRAM=y`, test CID `65535`다.
- Target map에 `publish_completions`가 없고 advisory completion bridge, 4 KiB worker, Sensor/vendor model과 server-send 경로가 유지된다.

## 산출물

- `led_control_node.bin`: `0xefa30` (`981,552`) 바이트
- OTA app slot: `0x1f0000` (`2,031,616`) 바이트
- OTA free: `0x1005d0` (`1,050,064`, 약 52%)
- Production minimum free gate: `406,324` 바이트
- Fix Round 5 대비 binary 64바이트 증가, free 64바이트 감소
- 산출물 mode/CID: test / `0xFFFF`; flash, HIL, production 사용 금지

## 변경 범위

- ESP-IDF patch: pinned patch/metadata, build-only overlay gate와 build/flash integration
- Artifact: test manifest v3, signed attestation v2와 patch identity binding
- Tests: actual patched boundary allocator/BTC fault harness, patch fail-closed/idempotency gate, production-source 16 burst retry
- Docs: patch maintenance, firmware README, 제어·모니터링 메뉴 현황, project status/active plan, lesson learned, 누적 보고서와 breaker 상세 보고서

## HIL 한계

- 실제 ESP32-H2 flash, Raspberry Pi/BlueZ provisioning과 RF 연결은 실행하지 않았다.
- 실제 power-cycle/reprovision/AppKey rebinding, device heap pressure/queue saturation, Sensor air packet, packet loss/late ACK, completion 유실·지연·중복, Health Fault Clear 왕복과 60초+jitter 장시간 측정은 미실행이다.
- 실제 센서 전압/noise/ESD/surge, cache-disabled ISR과 concurrent BLE stack timing은 software/build 결과로 증명하지 않는다.
- Production Company ID, trust root/release key와 제조 승인 자료가 provision되기 전 production image 생성은 의도적으로 불가능하다.
