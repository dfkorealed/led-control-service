# Task 15 보고서: ESP32-H2 차량 센서 GPIO driver

상태: Fix Round 3 완료(소프트웨어/clean target build, HIL 미실행)

## Fix Round 3 잔존 finding 매핑

| Finding | 수정 및 검증 |
| --- | --- |
| P2-1 queue-empty/resync ordering | Queue drain 뒤 task가 critical section에서 queue empty를 다시 확인한다. Pending edge가 있으면 section을 나와 drain으로 복귀하고, empty일 때만 resync-needed consume, monotonic timestamp와 GPIO level sample을 같은 section에서 수행한다. Callback은 section 밖에서 실행하므로 sample 이후 ISR은 더 늦은 queue event가 된다. Host fake가 empty 반환 직후 `High -> Low` 두 ISR을 재현해 callback timestamp 단조성, exact level 순서와 terminal getter Low를 검증한다. |

Fix Round 3 clean build의 ISR/GPIO/timer/queue-send 주소는 `0x40801b4c`, `0x40808726`, `0x4080196e`, `0x4080b832`다. Task objdump는 `vPortEnterCritical -> queue recheck -> timer -> GPIO -> vPortExitCritical -> callback` 순서를 확인했다.

## Fix Round 2 잔존 finding 매핑

| Finding | 수정 및 검증 |
| --- | --- |
| P1-1 production trust | Production trust policy를 repository의 고정 경로로 제한하고 caller env의 public key/fingerprint/policy override를 읽지 않는다. 현재 policy는 `unprovisioned`라 실제 production build가 IDF 실행 전에 의도적으로 실패한다. 별도 `verify-test-only` fixture만 자체 생성 key로 v2 approval의 CID/source commit/sdkconfig/partition exact binding을 검증한다. |
| P1-2 task-create race | Sensor task entry가 notification gate에서 먼저 block한다. `xTaskCreateStatic()` 반환 전에 priority preemption을 재현하는 fake scheduler에서도 callback은 0회이고, controller가 handle을 publish하고 gate를 연 뒤 callback self-stop은 항상 `ESP_ERR_INVALID_STATE`다. 외부 stop cleanup과 repeated lifecycle은 유지된다. |
| P2-3 resync ordering | ISR generation과 timestamp-before-level 기반 경합 검사를 추가했다. Fix Round 3에서는 generation snapshot 전에 이미 enqueue된 edge까지 보장하도록 queue-empty 재확인과 authoritative sample을 하나의 critical section으로 강화했다. |
| P2-4 progress tracking | 실수로 force-track한 `.superpowers/.../progress.md`는 `git rm --cached`로 index에서 삭제하고 ignored local coordination file은 보존한다. |

Production approval v2는 CID, source commit, generated `sdkconfig`와 `partitions.csv` digest를 fixed approval key로 서명한다. Production artifact attestation은 approval manifest/signature/signer identity, app binary, bootloader, partition table, blank otadata, sdkconfig, linker map, generated flash args와 partition digest를 fixed release key로 서명하고 flash wrapper가 signature와 exact payload를 재검증한다. Test image의 app-entry fail-stop은 그대로 유지된다.

## Fix Round 1 finding 매핑(회귀 유지)

| Finding | 수정 및 검증 |
| --- | --- |
| P1-1 ISR IRAM | `CONFIG_GPIO_CTRL_FUNC_IN_IRAM=y`를 defaults와 compile guard에 고정했다. Build audit가 linker map에서 ISR, `gpio_get_level`, `esp_timer_get_time`, `xQueueGenericSendFromISR` 주소를 확인해 IRAM/ROM 밖이면 실패한다. Fix Round 2 clean build 주소는 각각 `0x40801b4c`, `0x40808726`, `0x4080196e`, `0x4080b832`다. |
| P1-2 boot ordering | Interrupt-disabled 상태에서 boot sample을 queue에 먼저 넣고 critical section 안에서 interrupt enable과 immediate reconciliation을 수행한다. Deferred ISR은 critical exit 뒤 enqueue되므로 boot보다 앞설 수 없고 start current도 마지막 reconcile/ISR 관측으로 초기화된다. Start 전에 발생하고 원래 level로 돌아온 짧은 pulse는 보장 범위 밖이다. |
| P1-3 overflow current | Queue-full ISR은 saturating dropped counter와 lock-free `resync_needed`만 갱신한다. Task는 queued edge를 drain한 뒤 GPIO를 authoritative하게 읽고, resync read와 경합해 enqueue된 더 최신 edge까지 반복 drain한다. 33번째 terminal High drop과 resync-read 중 ISR race를 host fake로 검증했다. |
| P1-4 Company ID trust | Production은 exact CID의 signed manufacturing approval, detached signature, trusted public-key SHA-256를 모두 검증해야 한다. 실제 승인 자료가 없어 현재 production build는 의도적으로 실패한다. Build artifact manifest가 binary/CID/mode/sdkconfig/map/generated flash args/partition/approval hash를 결속하고 flash wrapper가 재검증한다. Test image는 app 첫 분기에서 `esp_system_abort`해 raw flash 우회에도 NVS/Bluetooth/sensor를 시작하지 않는다. |
| P2-5 UART0 GPIO | 기본 UART0 console의 RX GPIO23/TX GPIO24와 custom UART console의 configured TX/RX GPIO를 compile/runtime에서 거부한다. Console이 해당 GPIO를 소유하지 않을 때만 기존 allowlist 후보로 남는다. PWM/reset/strapping/flash/package/USB guard는 유지했다. |
| P2-6 callback stop | `vehicle_sensor_driver_stop()`을 `esp_err_t` API로 바꾸고 sensor task callback 내부 호출은 `ESP_ERR_INVALID_STATE`로 거부한다. 외부 control/shutdown context stop은 ISR, handler, task, queue, ISR service, GPIO와 state를 끝까지 정리한다. |
| P2-7 실제 driver test | `ESP_PLATFORM` production source를 fake ESP-IDF queue/GPIO/task/ISR와 함께 컴파일해 boot interleaving, queue full, held High resync, 최신 ISR ordering, self-stop, start failure cleanup과 반복 start/stop을 실행한다. Helper test와 build-gate shell mock만으로 완료를 주장하지 않는다. |
| P2-8 OTA margin | 4 MiB flash를 factory slot 없이 두 개의 `0x1f0000` OTA slot으로 구성했다. Production build는 free가 `max(slot * 20%, 256 KiB)`보다 작으면 실패하며 flash는 ESP-IDF generated `flash_args`와 partition offset 일치를 검증한다. |

## 유지한 센서 계약

- 입력은 configurable safe GPIO의 3.3V Active High digital sensor이며 내부 pull-down과 ESP32-H2 hardware hysteresis를 사용한다.
- ISR 외부 호출은 `gpio_get_level`, `esp_timer_get_time`, `xQueueSendFromISR`뿐이다. Queue full에서는 atomic dropped counter와 resync flag 외 block, log, BLE를 수행하지 않는다.
- Queue item은 고정 `{level, monotonic_us}`이고 static queue/task memory를 사용한다. Timestamp elapsed는 unsigned `uint64_t` subtraction으로 wrap-safe하다.
- 일반 task는 동일 level만 제거한다. Software debounce, timing filter, High timeout과 신호 보정은 추가하지 않았다.
- Task 16 consumer용 callback/current/drop/start/stop API를 유지하며 callback self-stop 제한을 명시했다.

## TDD 및 자동 검증

- Fix Round 3 RED: Queue drain의 empty 반환 직후 `High -> Low` 두 ISR을 넣자 기존 generation-only resync가 더 늦은 Low sample을 먼저 callback한 뒤 더 이른 High ISR edge를 처리해 timestamp 단조 assertion이 실패하는 것을 확인했다.
- RED: UART-aware pin API와 `esp_err_t stop` 부재, side-effectful test `app_main`, unsigned production CID 통과, artifact audit script 부재를 각각 실패로 확인했다.
- Native test: boot High/Low, 동일 level 제거, 동일 timestamp/1 us edge 보존, timestamp wrap, atomic counter와 GPIO allowlist를 검증했다.
- Actual-driver host fake: boot sample/ISR interleaving, start current, 32-slot queue와 33번째 dropped High/Low resync, queue-empty 직후 2개 ISR ordering과 timestamp 단조성, create-before-return preemption gate, callback self-stop 거부, handler/task failure cleanup과 repeated lifecycle을 검증했다.
- Build/trust/artifact tests: caller-selected key/fingerprint production 거부, unprovisioned production fail-closed, 별도 test-only fixed policy의 v2 approval exact binding, signed attestation과 app/bootloader/partition-table/otadata 변조, test runtime marker, IRAM map fixture와 production OTA margin을 검증했다. 자체 생성 key로 production success를 주장하지 않는다.
- ESP-IDF v5.5.1 clean `esp32h2` test-build와 post-build audit를 통과했다. Binary는 `0xe6790`(`944,016`) 바이트, app slot은 `0x1f0000`(`2,031,616`) 바이트, free는 `0x109870`(`1,087,600`, 약 54%), production minimum free는 `406,324` 바이트다.

## 전기 안전 및 HIL 한계

- 센서는 3.3V Active High 출력과 기준 GND를 확인한 뒤 연결한다. 5/12/24V, LED converter DIM/보조전원, 서로 다른 ground 계통은 GPIO나 3.3V rail에 직접 연결하지 않고 승인된 level shift/절연/ESD·서지 보호 회로를 사용한다.
- Host fake와 target build는 실제 입력 전압, rise/fall time, sensor chatter, 긴 배선 noise, ESD/surge, hardware queue timing과 GPIO 손상을 증명하지 않는다.
- Cache-disabled 구간의 실제 edge, boot 전 짧은 pulse, 실제 32개 queue overflow, callback 실행시간과 power-cycle은 보드 HIL에서 확인해야 한다.
- 실제 production root/release key와 자사 CID는 provision되지 않았다. 실제 ESP32-H2 flash는 실행하지 않았고 `0xFFFF` test-build는 runtime fail-stop하지만 HIL/양산 flash가 금지된다.
- Sensor Server, vendor event, ACK/retry와 Raspberry Pi RF 왕복은 Task 16 및 별도 HIL 범위다.
