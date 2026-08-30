# Task 16 Fix Round 3 누적 보고서

상태: 완료(소프트웨어/native·production-source host fake·ESP-IDF target build, HIL 미실행)

기준: `task-16-review.md`의 Fix Round 2 Re-review 신규 P2-10/P2-11을 Fix Round 3 범위로 적용했다. 상세 RED/GREEN 기록은 `task-16-fix3-report.md`에 분리했다.

## Fix Round 3 신규 P2 처리

| Review finding | 수정 | 회귀 증거 |
| --- | --- | --- |
| P2-10 이전 generation publish completion | ESP-IDF completion이 model pointer와 error만 주는 계약에 맞춰 Sensor/vendor 채널별 2-slot 고정 ledger에 model, opcode, runtime generation을 publish 호출 전에 예약한다. 같은 model은 completion 전까지 두 번째 publish를 시작하지 않으며 callback은 model과 일치하는 단 하나의 slot만 소비한다. 저장 generation이 현재 session과 다르면 fault atomics/Health를 변경하지 않는다. | Production-source host fake가 generation N의 vendor completion을 지연한 채 N+1을 시작한다. N+1 fault 뒤 N success가 fault를 지우지 않고, healthy N+1 뒤 N failure가 `0x82`를 만들지 않음을 검증한다. Synchronous callback, duplicate/no-slot completion과 기존 100회 lifecycle도 통과한다. |
| P2-11 restart 외부 Health snapshot 불일치 | 새 runtime session에서 내부 active/history를 0으로 초기화한 직후 fault handler를 `(0, 0)`으로 강제 호출한다. `ble_mesh_node.c` handler가 ESP BLE Mesh Health Server current/registered 배열을 zero부터 exact rebuild하므로 이전 session의 `0x82`가 제거된다. | Host fake 외부 Health 배열을 production Health mapper로 구성하고 generation N에 current/registered `0x82`를 만든 뒤 restart한다. 배열과 내부 mask가 모두 0이며 restart callback이 실제 호출됐음을 검증한다. |

## Fix Round 2 잔여 P2 처리

| Review finding | 수정 | 회귀 증거 |
| --- | --- | --- |
| P2-8 static worker TCB/stack 조기 재사용 | Model worker task와 static queue를 최초 start에서 한 번만 만들고 task를 삭제하지 않는다. Stop은 intake close와 producer drain 뒤 해당 run generation의 queue를 worker가 reset하고 `parked_generation` ack를 공개할 때까지 기다린다. Restart는 parked ack 뒤 session core와 새 `bootId`만 초기화하고 같은 task를 깨운다. | Production-source host fake에서 100회 즉시 stop/start, task create 정확히 1회, delete 0회, 매 generation 새 boot ID와 stale Sensor request 0건 검증. Target audit가 runtime `vTaskDelete`를 금지한다. |
| P2-9 교차 채널 send fault 오복구 | Sensor Status와 vendor event의 active send-fault flag를 분리하고 Health Current `0x82`는 두 flag의 OR로 계산한다. Sensor 성공은 Sensor flag만, vendor 성공 또는 exact ACK는 vendor flag만 내린다. Wrong boot/sequence ACK는 fault를 지우지 않으며 history는 Clear 전까지 유지된다. | Vendor publish 실패와 Sensor 성공 교차 테스트, wrong sequence/exact ACK 테스트, retry 성공 recovery, history Clear와 permanent sequence exhaustion 회귀 검증. |

## Fix Round 1 기존 7개 finding 처리

| Review finding | 수정 | 회귀 증거 |
| --- | --- | --- |
| P1-1 Mesh 설정 미영속 | `CONFIG_BLE_MESH_SETTINGS=y`를 defaults와 artifact/target audit에 강제했다. Provisioning credentials, AppKey binding과 publication 복원을 전제로 새 runtime이 reboot 시 실제 model state를 다시 읽는다. | settings 누락 artifact RED, build/attestation fixture, host fake stop/start에서 동일 model config 복원과 새 `bootId` 검증 |
| P1-2 queue full에서 config sync 유실 | command queue와 독립된 atomic configuration generation을 두고 callback이 generation 증가와 worker notify만 수행한다. Worker는 command, timer, idle poll 경계마다 적용 generation까지 수렴한다. | 32-slot request queue 포화 중 config 변경 후 Sensor/vendor readiness와 current publication 수렴 |
| P2-3 이중 publication cadence | Gateway Sensor Config Publication Set/Status period를 exact `0`으로 변경했다. Firmware readiness도 period 0만 허용하며 custom worker만 `60s + FNV-1a(unicast)%5000ms` deadline을 소유한다. | Gateway nonzero period rejection, host fake deadline 당 1회 publication, target source audit에서 stack timer 취소 경로 부재 |
| P2-4 Sensor 상호운용성 | 지원하지 않는 Sensor Setup Server를 composition에서 제거했다. `RSP_BY_APP` Sensor Server가 Descriptor/Get/Column/Series를 모두 응답하고 unknown property의 official zero-length/property-only 의미를 구현했다. | native exact bytes와 production-source host fake 네 opcode 응답, target composition audit |
| P2-5 stale/default Low | Task 15 driver를 Mesh init/provisioning bearer보다 먼저 시작한다. Get과 periodic Status는 매번 `vehicle_sensor_driver_get_current_level()`을 호출하며 unavailable이면 응답을 보류하고 recovery를 예약한다. Get 응답 시 ESP-IDF Sensor state DB도 같은 값으로 갱신한다. | worker-time High 응답, unavailable no-response/no-false-Low, periodic authoritative High/Low와 state DB 테스트 |
| P2-6 shutdown race | intake state를 atomic `OPEN -> CLOSING`으로 먼저 닫고 in-flight producer를 drain한다. Fix Round 2에서 static worker를 영구 park/restart 방식으로 바꿔 queue와 TCB/stack을 삭제·재생성하지 않는다. | in-flight timeout/재호출, worker-context 거부, 100회 stop/start, task create 1회/delete 0회 |
| P2-7 Health latch | Health active/history를 분리하고 Fix Round 2에서 Sensor/vendor send active 조건도 분리했다. Clear는 history만 지우며 sequence exhaustion은 permanent active다. | native exact array와 host fake 교차 채널 recovery/clear/permanent sequence 테스트 |

## 구조와 계약

- `vehicle_sensor_model.*`: Task 14 byte-for-byte event/ACK wire, official Presence MPID와 16-slot retry core만 소유한다.
- `vehicle_sensor_runtime.*`: 32-slot static command queue, 24-event admission, atomic config/reset/channel-fault latch, 2-slot publish completion ledger, 한 번만 생성되어 generation별 park/restart하는 4 KiB static worker와 custom cadence를 소유한다.
- `vehicle_sensor_mesh_adapter.*`: ESP-IDF model readiness, Sensor 응답/state DB, Sensor/vendor publication만 소유한다.
- `vehicle_sensor_health.*`: active/history 상태와 Health fault `0x80~0x84` exact 배열 변환만 소유한다.
- Task 15 callback은 log/BLE API 없이 nonblocking queue handoff만 한다. 모든 Sensor/vendor BLE 호출은 model worker에서 직렬화하며 event별 동적 allocation은 없다.
- Vendor event는 `version=1, bootId LE32, sequence LE32, kind, level` 11바이트이고 ACK는 `version, bootId LE32, sequence LE32` 9바이트다. Company ID/opcode/model ID는 Task 14 공통 config와 일치한다.
- `bootId`는 runtime start마다 `esp_random()`, sequence는 1부터 시작한다. `UINT32_MAX` event 전송 뒤 wrap 없이 fail-stop한다.
- 최초 전송 뒤 250ms, 500ms, 1s, 2s, 4s, 8s 최대 6회 retry하고 마지막 8초 grace 뒤 retry fault를 기록하며 slot을 해제한다. Exact `(bootId, sequence)` ACK만 제거하고 duplicate/old/out-of-order ACK는 무해하다.

## TDD와 검증

- RED: Gateway가 Sensor period `0x86`을 보내고 수락하던 focused test 2건 실패를 확인한 뒤 period 0으로 전환했다.
- RED: settings 누락 artifact, 신규 adapter/Health/runtime production source 부재, config saturation/lifecycle 경계를 먼저 실패시켰다.
- RED: 추가 host fake에서 provisioned-but-invalid model config가 Health에 나타나지 않는 문제와 Get 응답 후 Sensor state DB가 비어 있는 문제를 재현한 뒤 GREEN으로 수정했다.
- Fix Round 2 RED: 100회 restart에서 task 생성 횟수가 증가하는 실패와 vendor send 실패가 Sensor Status 성공으로 active에서 사라지는 실패를 각각 확인했다. Wrong sequence ACK 유지/exact ACK recovery도 RED 후 GREEN으로 전환했다.
- Fix Round 3 RED: 이전 generation success completion이 새 vendor `0x82`를 제거하는 assertion failure와 restart가 stale 외부 Health 배열을 갱신하지 않아 callback change count가 증가하지 않는 assertion failure를 각각 production-source host test에서 확인한 뒤 GREEN으로 전환했다.
- Native: codec/retry, Sensor response adapter, Health active/history, Task 15 driver 모두 strict C11 `-Wall -Wextra -Werror -pedantic` 통과.
- Host fake: actual driver + test-build fail-stop + actual model/runtime/adapter/Health production C, delayed old-generation completion, stale 외부 Health 배열 restart sync와 100회 parked lifecycle 통과.
- Gateway focused 3파일 44/44, Gateway 전체 59파일 546/546, shared 7파일 75/75 통과.
- Build gate, trust policy, artifact audit와 signed attestation fixture 통과. Target audit에서 2-slot ledger `.bss` `0x28`과 completion bridge를 확인했다. `git diff --check` 통과.
- ESP-IDF v5.5.1 `scripts/esp32-h2-build.sh --test-build`가 dependency fullclean, compile/link, target map audit, artifact/OTA audit를 통과했다.
- Production은 고정 trust root가 `unprovisioned`라 `production trust root is not provisioned`로 IDF 실행 전에 정상 fail-closed했다.

## 산출물

- `led_control_node.bin`: `0xefc70`(`982,128`) 바이트
- OTA app slot: `0x1f0000`(`2,031,616`) 바이트
- OTA free: `0x100390`(`1,049,488`, 약 52%)
- Production minimum free gate: `406,324` 바이트
- Test image Company ID: reserved `0xFFFF`, flash/HIL/production 사용 금지

## 변경 파일 범위

- Firmware: `vehicle_sensor_runtime.*`와 `ble_mesh_node.c`의 generation-bound publication completion 및 restart Health sync
- Tests: production-source runtime host fake의 delayed completion/외부 Health snapshot, target source/linker-map audit
- Docs: firmware README, `docs/menus/control.md`, project status/plan, lesson learned, 이 보고서

## HIL 한계

- 실제 ESP32-H2 flash, Raspberry Pi/BlueZ provisioning과 RF 연결은 실행하지 않았다.
- 실제 power-cycle settings 복원, AppKey bind/unbind, reprovision, Sensor Descriptor/Get/Column/Series air packet, 60초+jitter 장시간 cadence, packet loss 0~6회 retry/late ACK와 Health Fault Clear 왕복은 미실행이다.
- 실제 센서 전압/noise/ESD/surge, cache-disabled ISR과 concurrent BLE stack timing은 software/build 결과로 증명하지 않는다.
- Production Company ID, trust root/release key와 제조 승인 자료가 provision되기 전 production image 생성은 의도적으로 불가능하다.
