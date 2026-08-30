# Task 16 Fix Round 1 보고서

상태: 완료(소프트웨어/native·production-source host fake·ESP-IDF target build, HIL 미실행)

기준: `task-16-review.md` P1 2건/P2 5건과 ignored local coordination file `progress.md`의 Fix Round 1 ruling을 authoritative로 적용했다.

## 7개 finding 처리

| Review finding | 수정 | 회귀 증거 |
| --- | --- | --- |
| P1-1 Mesh 설정 미영속 | `CONFIG_BLE_MESH_SETTINGS=y`를 defaults와 artifact/target audit에 강제했다. Provisioning credentials, AppKey binding과 publication 복원을 전제로 새 runtime이 reboot 시 실제 model state를 다시 읽는다. | settings 누락 artifact RED, build/attestation fixture, host fake stop/start에서 동일 model config 복원과 새 `bootId` 검증 |
| P1-2 queue full에서 config sync 유실 | command queue와 독립된 atomic configuration generation을 두고 callback이 generation 증가와 worker notify만 수행한다. Worker는 command, timer, idle poll 경계마다 적용 generation까지 수렴한다. | 32-slot request queue 포화 중 config 변경 후 Sensor/vendor readiness와 current publication 수렴 |
| P2-3 이중 publication cadence | Gateway Sensor Config Publication Set/Status period를 exact `0`으로 변경했다. Firmware readiness도 period 0만 허용하며 custom worker만 `60s + FNV-1a(unicast)%5000ms` deadline을 소유한다. | Gateway nonzero period rejection, host fake deadline 당 1회 publication, target source audit에서 stack timer 취소 경로 부재 |
| P2-4 Sensor 상호운용성 | 지원하지 않는 Sensor Setup Server를 composition에서 제거했다. `RSP_BY_APP` Sensor Server가 Descriptor/Get/Column/Series를 모두 응답하고 unknown property의 official zero-length/property-only 의미를 구현했다. | native exact bytes와 production-source host fake 네 opcode 응답, target composition audit |
| P2-5 stale/default Low | Task 15 driver를 Mesh init/provisioning bearer보다 먼저 시작한다. Get과 periodic Status는 매번 `vehicle_sensor_driver_get_current_level()`을 호출하며 unavailable이면 응답을 보류하고 recovery를 예약한다. Get 응답 시 ESP-IDF Sensor state DB도 같은 값으로 갱신한다. | worker-time High 응답, unavailable no-response/no-false-Low, periodic authoritative High/Low와 state DB 테스트 |
| P2-6 shutdown race | intake state를 atomic `OPEN -> CLOSING`으로 먼저 닫고 in-flight producer를 drain한 뒤 worker stop latch를 처리한다. Static queue는 delete하지 않고 worker 종료 후 reset하며 timeout 뒤 stop 재호출과 restart를 지원한다. Worker-context stop은 intake를 닫지 않고 거부한다. | in-flight stop timeout, 새 intake 거부, 후속 stop 성공, queue delete 0회, restart와 worker-context 거부 테스트 |
| P2-7 Health latch | Health state를 active mask와 registered history mask로 분리했다. dropped/retry/send/unconfigured는 정상 current publication/config 복구 시 active에서 제거되고 history에 남는다. Clear는 history만 지우며 sequence exhaustion은 permanent active다. 배열은 매 변경마다 zero부터 exact rebuild한다. | native array 제거/clear, host fake send/drop/retry/unconfigured 회복과 permanent sequence 테스트 |

## 구조와 계약

- `vehicle_sensor_model.*`: Task 14 byte-for-byte event/ACK wire, official Presence MPID와 16-slot retry core만 소유한다.
- `vehicle_sensor_runtime.*`: 32-slot static command queue, 24-event admission, atomic config/reset/fault/stop latch, 4 KiB static worker, custom cadence와 lifecycle을 소유한다.
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
- Native: codec/retry, Sensor response adapter, Health active/history, Task 15 driver 모두 strict C11 `-Wall -Wextra -Werror -pedantic` 통과.
- Host fake: actual driver + test-build fail-stop + actual model/runtime/adapter/Health production C 통과.
- Gateway focused 3파일 39/39, Gateway 전체 59파일 546/546, shared 7파일 75/75 통과.
- Build gate, trust policy, artifact audit와 signed attestation fixture 통과. `git diff --check` 통과.
- ESP-IDF v5.5.1 `scripts/esp32-h2-build.sh --test-build`가 dependency fullclean, compile/link, target map audit, artifact/OTA audit를 통과했다.
- Production은 고정 trust root가 `unprovisioned`라 `production trust root is not provisioned`로 IDF 실행 전에 정상 fail-closed했다.

## 산출물

- `led_control_node.bin`: `0xef710`(`980,752`) 바이트
- OTA app slot: `0x1f0000`(`2,031,616`) 바이트
- OTA free: `0x1008f0`(`1,050,864`, 약 52%)
- Production minimum free gate: `406,324` 바이트
- Test image Company ID: reserved `0xFFFF`, flash/HIL/production 사용 금지

## 변경 파일 범위

- Firmware: `vehicle_sensor_model.*`, 새 `vehicle_sensor_runtime.*`, `vehicle_sensor_mesh_adapter.*`, `vehicle_sensor_health.*`, node/app/CMake/sdkconfig
- Tests: native model/adapter/Health, production-source host fake와 ESP-IDF fake headers, build/artifact/target audit fixtures
- Gateway: `bluez-config-client.ts`와 exact period test
- Docs: firmware README, `docs/menus/control.md`, project status/plan, lesson learned, 이 보고서

## HIL 한계

- 실제 ESP32-H2 flash, Raspberry Pi/BlueZ provisioning과 RF 연결은 실행하지 않았다.
- 실제 power-cycle settings 복원, AppKey bind/unbind, reprovision, Sensor Descriptor/Get/Column/Series air packet, 60초+jitter 장시간 cadence, packet loss 0~6회 retry/late ACK와 Health Fault Clear 왕복은 미실행이다.
- 실제 센서 전압/noise/ESD/surge, cache-disabled ISR과 concurrent BLE stack timing은 software/build 결과로 증명하지 않는다.
- Production Company ID, trust root/release key와 제조 승인 자료가 provision되기 전 production image 생성은 의도적으로 불가능하다.
