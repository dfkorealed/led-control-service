# Task 16 보고서: ESP32-H2 Sensor Server와 reliable vendor event

상태: 완료(소프트웨어/native·host fake·ESP-IDF target build, HIL 미실행)

## 구현 계약

- ESP-IDF v5.5.1 공식 `BLE_MESH_PRESENCE_DETECTED(0x004D)`와 Format A MPID macro를 사용해 Sensor Status를 `52 a0 09 <0|1>` wire로 만든다. Sensor Get은 model worker 우선 queue에서 현재 GPIO를 응답한다.
- primary element에 Sensor Server `0x1100`, 필수 Sensor Setup Server와 Task 14 공통 Company ID의 vendor server `0x0000`을 추가했다. Sensor publication은 Gateway가 설정한 address/AppKey/TTL/60초 계약을 확인한 뒤 worker가 `60s + FNV-1a(primary unicast) % 5000ms` 간격으로 실제 model publication을 보낸다.
- Vendor event payload는 Task 14와 byte-for-byte 같은 11바이트 `version=1, bootId LE uint32, sequence LE uint32, kind, level`이다. Opcode는 wire `C1 <company low> <company high>`, ACK는 `C2`와 9바이트 payload를 사용한다.
- `bootId`는 부팅마다 `esp_random()`, sequence는 1부터 시작한다. `UINT32_MAX` event까지 송신한 뒤 wrap하지 않고 후속 event를 거부하며 Health sequence fault를 기록한다.
- 16개 고정 pending slot에서 최초 전송 후 250ms, 500ms, 1s, 2s, 4s, 8s로 최대 6회 retry한다. 마지막 retry 뒤 8초 ACK grace에도 exact `(bootId, sequence)` ACK가 없으면 retry-exhausted counter를 올리고 slot을 해제한다. Duplicate, 다른 boot와 out-of-order ACK는 pending을 제거하지 않는다.

## Worker와 lifecycle

- Task 15 callback은 log/BLE API 없이 lock-free current level 갱신과 길이 32 static command queue handoff만 수행한다. Sensor event admission을 24개로 제한해 ACK, Sensor Get과 lifecycle command 공간을 남기며 queue full은 saturating dropped counter와 current-state recovery를 예약한다.
- Static model task가 vendor send/retry, ACK, Sensor Get response, current Status publication, configuration sync와 reset을 직렬화한다. Event별 heap allocation은 없다.
- Provision complete/config state change/reboot에서 Sensor/vendor AppKey bind와 publication address를 다시 확인한다. Provision reset은 lifecycle epoch를 올리고 pending을 비우며 reset 이전 queued event를 폐기한다. Shutdown은 driver를 먼저 중지한 뒤 model worker를 bounded stop한다.
- Send error, publication unconfigured, queue/driver/pending drop, retry exhausted와 sequence exhausted는 Health vendor fault `0x80~0x84`에 연결했다. Fault Clear는 registered fault만 지우며 active current fault는 유지한다.

## TDD와 검증

- RED: `vehicle_sensor_model.c`가 없는 상태에서 native compile 실패를 먼저 확인했다. Exact event/ACK/Presence bytes, deterministic jitter, exact ACK, 6회 retry와 timeout release, 16-slot full/current recovery, send error/unconfigured와 uint32 overflow를 구현해 GREEN으로 전환했다.
- Native model은 detected sequence 1 뒤 cleared sequence 2의 exact wire와 terminal current Low도 검증한다. Task 15 native driver와 actual-driver host fake는 boot/ISR ordering, queue overflow/resync, repeated lifecycle을 유지한다.
- Test-build runtime fail-stop host fake는 새 handoff/shutdown 심볼을 포함해 예약 `0xFFFF` image가 NVS, LED, Bluetooth, sensor보다 먼저 abort함을 재검증했다.
- Trust, build gate, unsigned test artifact와 signed production attestation fixture test를 통과했다. 실제 production 명령은 고정 policy가 `unprovisioned`라 `production trust root is not provisioned`로 ESP-IDF 실행 전에 실패했다. 이는 의도한 fail-closed 결과다.
- ESP-IDF v5.5.1 `scripts/esp32-h2-build.sh --test-build` fullclean compile/link를 통과했다. Build-integrated target audit가 Sensor Server Kconfig/callback과 runtime start/stop/event/Get/ACK symbol, Sensor/vendor composition, 4 KiB worker stack과 `0x600` command queue section을 linker map에서 확인한다.
- 실제 build manifest의 binary/bootloader/partition/blank otadata/sdkconfig/map/flash args hash, ISR/GPIO/timer/queue-send IRAM/ROM 주소와 OTA margin audit를 통과했다.

## 산출물과 크기

- `led_control_node.bin`: `0xeacd0`(`961,744`) 바이트
- OTA app slot: `0x1f0000`(`2,031,616`) 바이트
- OTA free: `0x105330`(`1,069,872`, 약 53%)
- Production minimum free gate: `406,324` 바이트
- 최종 커밋 뒤 같은 fullclean build를 재실행해 test artifact manifest의 source commit과 실제 checkout을 일치시킨다.

## 변경 파일

- `apps/esp32-h2-firmware/main/vehicle_sensor_model.h`
- `apps/esp32-h2-firmware/main/vehicle_sensor_model.c`
- `apps/esp32-h2-firmware/test/native/test_vehicle_sensor_model.c`
- `apps/esp32-h2-firmware/main/ble_mesh_node.c`
- `apps/esp32-h2-firmware/main/ble_mesh_node.h`
- `apps/esp32-h2-firmware/main/app_main.c`
- `apps/esp32-h2-firmware/main/CMakeLists.txt`
- `apps/esp32-h2-firmware/sdkconfig.defaults`
- `apps/esp32-h2-firmware/test/native/test_vehicle_sensor_model_target_artifact.sh`
- `scripts/esp32-h2-build.sh`
- Task 15 host fake fail-stop 지원 파일과 관련 문서

## HIL 한계

- 실제 ESP32-H2에 flash하지 않았고 Raspberry Pi/BlueZ와 RF를 연결하지 않았다. 예약 Company ID test image는 runtime fail-stop이라 HIL/양산 flash에 사용할 수 없다.
- Sensor Get/Status 실제 왕복, 60초+jitter air timing, AppKey bind/unbind와 publication 재설정, packet loss 0~6회 retry/late ACK, queue/pending overflow, reboot/reprovision, Health Current/Fault Clear, 전원 차단은 미실행이다.
- 실제 센서 전압, 긴 배선 noise, ESD/surge, cache-disabled ISR과 concurrent BLE stack timing은 native/host/target build로 증명하지 않는다. 실제 자사 Company ID, production root/release key와 승인 자료 provision 후 별도 HIL이 필요하다.
