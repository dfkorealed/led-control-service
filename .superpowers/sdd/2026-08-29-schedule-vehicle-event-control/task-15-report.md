# Task 15 보고서: ESP32-H2 차량 센서 GPIO driver

상태: 완료(소프트웨어/target build, HIL 미실행)

## 구현 내용

- `CONFIG_LED_CONTROL_VEHICLE_SENSOR_GPIO` 기본값을 GPIO 4로 추가하고 safe allowlist를 `0, 1, 4, 5, 10~14, 22~24`로 제한했다. PWM, factory reset, strapping, flash/package와 USB-Serial-JTAG 충돌은 compile-time과 runtime에서 fail-closed한다.
- 3.3V Active High 입력에 pull-down과 ESP32-H2 hardware hysteresis를 설정했다. software debounce, timing filter, High timeout과 신호 보정은 구현하지 않았다.
- ISR은 `gpio_get_level`, `esp_timer_get_time`, `xQueueSendFromISR`로 고정 edge `{level, monotonic_us}`만 32개 static queue에 넣는다. queue full은 lock-free saturating atomic dropped counter만 증가시키며 ISR에서 block, log 또는 BLE를 호출하지 않는다.
- boot level을 queue에 한 번 넣고 interrupt enable 직후 current level을 한 번 재조정한다. 일반 static task가 순서를 처리하고 시간 간격과 무관하게 동일 level만 제거한다.
- Task 16이 사용할 callback, current level, dropped counter, start/stop API를 제공하고 app startup과 ESP restart shutdown handler에 연결했다.
- production build는 실제 자사 Bluetooth SIG Company ID가 없으면 ESP-IDF 실행 전에 실패한다. 자동 target compile은 명시적 `--test-build`에서만 reserved `0xFFFF` fixture를 임시 주입하며 binary 경고와 flash-script의 missing/invalid/test 설정 거부를 적용한다.

## TDD 및 검증

- RED: native compile은 `vehicle_sensor_driver.c` 부재로 실패했다. build gate test는 Company ID가 없는 기존 production build가 통과해 실패했다.
- GREEN: boot High/Low 1회, 동일 level 제거, 동일 timestamp/1us 양 edge 보존, uint64 timestamp wrap, atomic dropped counter와 전체 GPIO allowlist/충돌을 native test로 검증했다.
- `scripts/esp32-h2-build.sh --test-build`로 ESP-IDF v5.5.1 `esp32h2` target build를 수행했다. test-build app binary는 `0xe6370` 바이트이고 1 MiB app partition에 `0x19c90` 바이트가 남았다.
- target object disassembly에서 GPIO ISR의 외부 호출이 `gpio_get_level`, `esp_timer_get_time`, `xQueueGenericSendFromISR`(`xQueueSendFromISR`의 구현 symbol)로만 연결되고 dropped counter는 RISC-V lock-free atomic instruction으로 inline 처리됨을 확인했다.
- production Company ID 누락/금지값 거부와 명시적 test fixture 설정은 host build-gate test로 검증했다.

## 전기 안전 및 HIL 한계

- 센서는 3.3V Active High 출력과 기준 GND를 확인한 뒤 연결한다. 5/12/24V, LED converter DIM/보조전원, 서로 다른 ground 계통은 GPIO나 3.3V rail에 직접 연결하지 않고 승인된 level shift/절연/보호 회로를 사용한다.
- native와 target compile은 실제 입력 전압, rise/fall time, sensor chatter, 긴 배선 noise, ESD/surge, queue overflow와 GPIO 손상을 증명하지 않는다.
- 실제 ESP32-H2 flash는 실행하지 않았다. `0xFFFF` test-build binary는 HIL/양산 flash가 금지된다.
- Sensor Server, vendor event, ACK/retry와 Raspberry Pi RF 왕복은 Task 16 및 별도 HIL 범위다.
