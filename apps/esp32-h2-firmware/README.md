# ESP32-H2 펌웨어

이 펌웨어는 ESP32-H2 양산/개발 보드를 위한 ESP-IDF 기반 조명 제어 노드이다. PlatformIO는 현재 ESP32-H2 보드 인식과 BLE Mesh/OTA 상용 기능 검증에서 제약이 있어 사용하지 않는다. 기준 환경은 ESP-IDF `v5.5.1`, target은 `esp32h2`이다.

## 현재 검증 상태

- 2026-07-08 기준 macOS 개발 환경에 ESP-IDF `v5.5.1`을 설치했다.
- `scripts/esp32-h2-build.sh`로 실제 ESP32-H2 target 빌드를 통과했다.
- 빌드 산출물은 `/Users/kim-jh/esp/led-control-esp32-h2-build/build`에 생성된다.
- 현재 펌웨어는 부팅 시 NVS에서 마지막 밝기를 복원하고, BLE Mesh unprovisioned node로 광고되며, Generic OnOff/Light Lightness 명령을 받아 PWM 밝기에 반영하는 단계까지 빌드 검증했다.
- BLE Mesh group publication 지터, TID 중복 방지, 모델별 group 16개와 차량 센서 GPIO driver 포함 후 test-build `led_control_node.bin` 크기는 `0xe64f0`(`943,344`) 바이트다. Custom two-OTA partition의 각 app slot은 `0x1f0000`(`2,031,616`) 바이트이고 `0x109b10`(`1,088,272`, 약 54%)가 남는다. Production build는 free가 slot의 20%와 256 KiB 중 큰 값인 현재 `406,324` 바이트보다 작으면 실패한다.

## ESP-IDF 설치

macOS 기준 설치 명령은 아래와 같다. Python 3.14 계열은 일부 ESP-IDF 도구 호환성 리스크가 있어 Python 3.12를 우선 사용한다.

```bash
brew install cmake ninja dfu-util ccache python@3.12
mkdir -p "$HOME/esp"
git clone -b v5.5.1 --recursive https://github.com/espressif/esp-idf.git "$HOME/esp/esp-idf"
PATH="/opt/homebrew/opt/python@3.12/libexec/bin:/opt/homebrew/bin:$PATH" "$HOME/esp/esp-idf/install.sh" esp32h2
```

설치 후 터미널에서 ESP-IDF 명령을 직접 쓰려면 아래 export를 실행한다.

```bash
. "$HOME/esp/esp-idf/export.sh"
```

이 저장소의 `scripts/esp32-h2-build.sh`, `scripts/esp32-h2-flash.sh`는 macOS Homebrew의 Python 3.12 경로(`/opt/homebrew/opt/python@3.12/libexec/bin`)를 자동으로 PATH 앞에 붙인다. 따라서 Homebrew 기본 `python3`가 3.14여도 스크립트 실행 시 ESP-IDF `idf5.5_py3.12_env`를 사용한다.

## 빌드

Gateway와 센서 펌웨어는 Bluetooth SIG가 자사에 할당한 하나의 Company Identifier를 공유한다. 펌웨어 빌드 전 `CONFIG_LED_CONTROL_BLUETOOTH_COMPANY_ID=<10진수 식별자>`를 site별 보안 빌드 설정에 주입하고, Gateway에는 같은 값을 `GATEWAY_BLUETOOTH_COMPANY_ID`로 배포한다. 값이 없거나 `0`, Espressif 할당값 `0x02E5`, 테스트/내부용 `0xFFFF`이면 빌드 또는 Gateway 시작이 fail-closed된다. 저장소에는 양산 식별자나 테스트 기본값을 커밋하지 않는다.

```bash
test "$CONFIG_LED_CONTROL_BLUETOOTH_COMPANY_ID" = "$GATEWAY_BLUETOOTH_COMPANY_ID"
```

Task 16 vendor event model의 composition, 3-byte opcode, ACK opcode는 이 Kconfig 값을 사용해야 하며 Gateway의 shared protocol 계약 `BLUETOOTH_COMPANY_ID_CONFIG`와 이름을 임의로 바꾸지 않는다.

checkout 경로와 무관하게 ESP-IDF 빌드 안정성을 위해 firmware 파일을 `~/esp/led-control-esp32-h2-build`로 동기화한 뒤 빌드한다. 기본 실행은 production build다. 실제 자사 Company ID, exact CID를 승인한 제조 manifest와 signature, protected deployment가 신뢰하는 public-key SHA-256가 모두 없으면 ESP-IDF 실행 전에 실패한다. 현재 실제 승인 자료가 없으므로 production build는 의도적으로 실행할 수 없다.

```bash
cd "/Users/kim-jh/Documents/led-control-service"
CONFIG_LED_CONTROL_BLUETOOTH_COMPANY_ID=<Bluetooth SIG 자사 할당값의 10진수> \
LED_CONTROL_MANUFACTURING_APPROVAL_MANIFEST=<승인 manifest 경로> \
LED_CONTROL_MANUFACTURING_APPROVAL_SIGNATURE=<detached signature 경로> \
LED_CONTROL_MANUFACTURING_APPROVAL_PUBLIC_KEY=<승인 public key 경로> \
LED_CONTROL_MANUFACTURING_APPROVAL_PUBLIC_KEY_SHA256=<보호된 trust anchor> \
scripts/esp32-h2-build.sh
```

승인 manifest는 아래 네 줄의 exact payload이며 detached signature가 trusted public key로 검증돼야 한다. 저장소에는 실제 ID, 승인 manifest, key 또는 signature를 기본값으로 두지 않는다.

```text
schema=led-control-manufacturing-approval-v1
product=led-control-esp32-h2
mode=production
company_id=<Bluetooth SIG 자사 할당값의 10진수>
```

실제 ID가 아직 없는 자동 compile 검증만 아래 명시적 gate를 사용한다. 이 모드는 Bluetooth SIG internal-use 값 `0xFFFF`를 build workdir의 임시 설정에만 주입하며 저장소 기본값으로 두지 않는다. 생성된 test binary는 부팅 첫 분기에서 `esp_system_abort`해 NVS, LED, Bluetooth/BLE Mesh, sensor와 factory-reset 초기화를 실행하지 않는다. 따라서 wrapper를 우회해 raw `esptool`로 잘못 flash해도 RF와 센서는 시작하지 않는다. 실제 장비 HIL과 양산에는 절대 사용하지 않는다.

```bash
scripts/esp32-h2-build.sh --test-build
```

성공 시 주요 산출물은 아래와 같다.

- `/Users/kim-jh/esp/led-control-esp32-h2-build/build/bootloader/bootloader.bin`
- `/Users/kim-jh/esp/led-control-esp32-h2-build/build/partition_table/partition-table.bin`
- `/Users/kim-jh/esp/led-control-esp32-h2-build/build/ota_data_initial.bin`
- `/Users/kim-jh/esp/led-control-esp32-h2-build/build/led_control_node.bin`
- `/Users/kim-jh/esp/led-control-esp32-h2-build/build/led-control-artifact.manifest`

build 후 audit는 `CONFIG_GPIO_CTRL_FUNC_IN_IRAM=y`와 linker map의 ISR, `gpio_get_level`, `esp_timer_get_time`, `xQueueGenericSendFromISR`가 ESP32-H2 IRAM/ROM 주소인지 확인한다. Artifact manifest는 binary, `sdkconfig`, linker map, generated `flash_args`, custom partition, 제조 승인 manifest hash와 mode/CID/size를 결속한다.

## 실제 보드 플래시

1. ESP32-H2-MINI 개발 보드를 USB 데이터 케이블로 연결한다.
2. macOS에서 포트를 확인한다.

```bash
ls /dev/tty.usbmodem* /dev/cu.usbmodem* 2>/dev/null
```

3. `/dev/cu.usbmodemXXXX` 형식의 포트를 우선 사용한다.
4. 플래시와 시리얼 모니터를 실행한다.

```bash
cd "/Users/kim-jh/Documents/led-control-service"
LED_CONTROL_MANUFACTURING_APPROVAL_MANIFEST=<승인 manifest 경로> \
LED_CONTROL_MANUFACTURING_APPROVAL_SIGNATURE=<detached signature 경로> \
LED_CONTROL_MANUFACTURING_APPROVAL_PUBLIC_KEY=<승인 public key 경로> \
LED_CONTROL_MANUFACTURING_APPROVAL_PUBLIC_KEY_SHA256=<보호된 trust anchor> \
scripts/esp32-h2-flash.sh /dev/cu.usbmodemXXXX
```

자동 다운로드 모드 진입이 실패하면 보드의 `BOOT` 버튼을 누른 상태에서 `RESET`을 눌렀다 떼고, 그 다음 `BOOT` 버튼을 놓은 뒤 다시 플래시한다.

flash wrapper는 signed approval과 artifact manifest의 모든 hash를 다시 검증한 뒤 ESP-IDF가 생성한 `flash_args`를 사용하는 `idf.py flash`를 호출한다. ESP-IDF build 출력의 raw `idf.py`/`esptool` 명령은 이 검증을 우회하므로 production 절차에서 직접 실행하지 않는다.

## LED 드라이버 연결 주의

- 현재 PWM 출력 핀은 `GPIO 8`이다.
- PWM은 LEDC `5 kHz`, 10-bit duty 해상도를 사용한다.
- 개발 보드 LED 또는 절연된 LED driver의 PWM 입력에 연결해 검증한다.
- 주차장 LED 부하를 ESP32-H2 GPIO에 직접 연결하면 안 된다.
- 외부 LED driver를 사용할 때는 PWM 입력 전압, 공통 GND, 절연 요구사항을 먼저 확인한다.

## 차량 감지 센서 GPIO와 전기 안전

- 입력 계약은 **3.3V Active High digital output**인 마이크로웨이브 센서다. 5V, 12V, 24V 신호나 open collector 출력을 level 확인 없이 직접 연결하지 않는다.
- 비절연 연결은 ESP32-H2와 센서가 같은 기준 GND를 사용해야 한다. 서로 다른 전원 계통, 긴 배선, surge 또는 ground potential 차이가 있으면 승인된 절연기나 level shifter와 ESD/서지 보호를 사용한다.
- LED converter의 DIM+/DIM-, 0-10V, PWM DIM, 보조전원 출력은 센서 GPIO 또는 ESP32-H2 3.3V rail에 직접 연결하지 않는다. converter 매뉴얼의 절연/전압/전류 조건에 맞는 별도 interface 회로가 필요하다.
- 기본 센서 입력은 `GPIO 4`다. fail-closed allowlist는 GPIO `0, 1, 4, 5, 10~14, 22~24`이며 PWM, factory reset, strapping, flash/package와 USB-Serial-JTAG pin은 compile 시 거부한다. 기본 UART0 console의 RX GPIO23/TX GPIO24와 custom UART console에 설정한 GPIO도 compile/runtime에서 거부한다.
- 입력은 내부 pull-down과 ESP32-H2 hardware hysteresis를 사용한다. software debounce, 시간 filter, High timeout 또는 임의 Low 보정은 넣지 않는다. 센서 출력 chatter가 있으면 모든 실제 level 전환이 event가 되므로 PCB와 센서 자체의 전기적 품질로 해결한다.
- 양산 PCB에서는 외부 pull-down, 입력 직렬 저항, ESD/서지, isolation, 센서 소비전류와 전원 sequencing을 회로 검토와 실측으로 확정한다. ESP32-H2 3.3V pin을 검증되지 않은 센서/컨버터 보조전원 공급원으로 사용하지 않는다.

driver는 interrupt가 비활성인 상태에서 boot level을 32개 static queue에 먼저 넣는다. 이어 critical section 안에서 interrupt를 enable하고 즉시 level을 재확인하므로 ISR edge가 boot event보다 앞서지 않는다. Driver start 이전에 발생하고 원래 level로 돌아온 짧은 pulse는 보장 범위 밖이며, start가 반환할 때 current level은 마지막 reconciliation 또는 ISR 관측값으로 초기화된다.

양 edge ISR은 `{level, monotonic_us}`를 전달하며 외부 호출은 `gpio_get_level`, `esp_timer_get_time`, `xQueueSendFromISR`로 제한된다. queue가 가득 차면 lock-free saturating dropped counter와 atomic resync-needed만 갱신하고 log, BLE, block을 수행하지 않는다. 일반 task는 queued edge를 먼저 모두 처리한 뒤 GPIO를 authoritative하게 다시 읽고, resync와 경합한 더 최신 queued edge까지 반복 drain해 High가 유지되는 경우에도 current level을 수렴시킨다. 시간 간격과 무관하게 동일 level만 제거하며 software debounce/timing filter는 없다. Callback 안의 `vehicle_sensor_driver_stop()`은 `ESP_ERR_INVALID_STATE`로 거부하고 외부 control/shutdown context에서 stop해야 완전 cleanup과 restart를 보장한다.

## 현재 구현 범위

- ESP-IDF 프로젝트 구조
- 밝기 상태 관리
- LEDC PWM 기반 LED 드라이버
- 앱 부팅 시 기본 밝기 적용
- BLE Mesh provisioning advertisement 활성화
- device UUID와 unprovisioned device name(`DFK-LED-H2`) 기반 node identity 설정
- Config Server, Health Server, Generic OnOff Server, Light Lightness Server, Light Lightness Setup Server composition 구성
- Generic OnOff Set/Get 수신 후 0% 또는 100% PWM 반영
- Light Lightness Set/Get 수신 후 0~65535 lightness 값을 0~100% 밝기로 변환해 PWM 반영
- OnOff/Lightness status publication
- group 주소로 받은 Light Lightness Set Unacknowledged는 PWM을 즉시 반영하고 primary unicast 기반 결정적 지터 후 실제 Lightness Status publication
- `RSP_BY_APP` Light Lightness Set은 `(source, destination, TID)` 기준 6초 transaction cache로 중복 적용 방지
- Light Lightness/Generic OnOff 모델별 group subscription 16개 지원: 층 group 1개와 사용자 fixture group 최대 15개
- Health fault clear/test callback과 fault update publication 진입점
- 마지막 밝기, 이전 밝기, command sequence를 NVS blob으로 저장하고 2초 debounce commit으로 flash write를 제한
- Off 후 On 시 직전 0% 초과 밝기를 복원
- Health Attention에 연결된 250ms identify 점멸과 종료 시 원래 밝기 복원
- GPIO active-low 8초 길게 누르기를 통한 앱 NVS 및 BLE Mesh credential factory reset
- panic/watchdog reset reason을 Health fault `0x01`로 기록
- ESP-IDF task watchdog 10초 설정
- 3.3V Active High 차량 센서 GPIO 양 edge, boot level event, static queue/task와 Task 16 callback/start/stop lifecycle

## 후속 구현

- 실제 ESP32-H2 보드에서 PB-ADV/PB-GATT provisioning 검증
- provisioner에서 AppKey bind, Light Lightness/OnOff model bind, group subscription 자동화
- 라즈베리파이 gateway의 실제 BLE Mesh provisioner/client adapter 구현
- 양산 PCB 확정 후 PWM GPIO와 factory reset GPIO 확정 및 전기적 debounce/ESD 검증
- gateway `identify-device` 명령을 Health Attention Set으로 보내는 실제 BlueZ adapter 연결
- gateway가 Light Lightness Status, Generic OnOff Status, Health Fault Status를 수신해 서버 fixture state로 동기화
- OTA 이미지 수신, 검증, rollback 정책
- BLE Mesh optional transition time을 LEDC 비동기 fade 완료 callback/task와 present/target 상태 분리 후 Status publication으로 연결. 현재 즉시 duty 변경만 구현되어 있어 미완료다.
- 표준 BLE Mesh TID와 cloud gateway command sequence의 매핑 정책. Light Lightness의 로컬 6초 TID 중복 방지는 구현됐지만 8-bit TID를 cloud sequence로 간주하지 않는다.

## 양산 GPIO 설정

기본값은 PWM `GPIO 8`, factory reset active-low 입력 `GPIO 9`, 길게 누르기 `8000ms`다. PCB pinout이 확정되면 `menuconfig` 또는 `sdkconfig.defaults`의 다음 값을 변경한다.

```text
CONFIG_LED_CONTROL_PWM_GPIO=8
CONFIG_LED_CONTROL_FACTORY_RESET_GPIO=9
CONFIG_LED_CONTROL_FACTORY_RESET_HOLD_MS=8000
CONFIG_LED_CONTROL_VEHICLE_SENSOR_GPIO=4
CONFIG_DFK_PRODUCT_FAMILY=1
CONFIG_DFK_MODEL_CODE=1
CONFIG_DFK_HARDWARE_REVISION=1
CONFIG_LED_CONTROL_BLUETOOTH_COMPANY_ID=<Bluetooth SIG 자사 할당값의 10진수>
CONFIG_BLE_MESH_MODEL_GROUP_COUNT=16
```

factory reset 입력은 내부 pull-up을 사용한다. 양산 회로에서는 외부 pull-up, switch debounce, ESD와 부팅 strap 충돌 여부를 반드시 검토한다. 8초가 충족되면 앱 상태 NVS와 BLE Mesh provisioning 정보를 삭제하고 재부팅해 unprovisioned beacon 상태로 돌아간다.

## BLE Mesh 동작 흐름

1. 부팅 후 NimBLE host를 초기화한다.
2. BLE Mesh device UUID를 DFK 제품 식별 계약과 Bluetooth MAC으로 만든다.
3. unprovisioned device name을 `DFK-LED-H2`로 설정한다.
4. PB-ADV/PB-GATT bearer를 켜고 provisioner 검색을 기다린다.
5. provisioner가 NetKey/AppKey를 주입하고 model bind/group subscription을 설정한다.
6. gateway가 Generic OnOff 또는 Light Lightness client message를 보낸다.
7. 펌웨어는 PWM 밝기를 변경하고 OnOff/Lightness status를 publish한다. group Lightness Set Unacknowledged는 PWM을 먼저 변경하고 아래 지터 후 Lightness status만 publish한다.
8. Health fault test/clear 요청은 Health Server callback에서 처리하고 fault update를 publish한다.

웹의 `조명 검색`에 잡히려면 보드가 반드시 unprovisioned 상태여야 한다. 한 번 provisioning된 보드는 NetKey/AppKey와 mesh address를 NVS에 보관하므로 unprovisioned beacon을 내보내지 않는다. 재검색 테스트 전에는 `erase-flash`를 실행하거나 후속 factory reset 기능을 통해 mesh 설정을 삭제한다.

## Provisioner 설정 체크리스트

현재 펌웨어는 노드 역할만 수행한다. 실제 현장에서 라즈베리파이 gateway 또는 별도 provisioner가 아래 작업을 수행해야 한다.

- unprovisioned device UUID의 `DFKLED` prefix, format version과 제품 코드를 검증해 조명 노드를 식별한다.
- NetKey를 주입하고 unicast address를 할당한다.
- AppKey를 추가한다.
- primary element의 Generic OnOff Server, Light Lightness Server, Health Server에 AppKey를 bind한다.
- 층/구역별 group address를 Light Lightness Server와 Generic OnOff Server에 subscribe한다.
- 상태 publication 주소와 주기를 설정한다.

`CONFIG_BLE_MESH_MODEL_GROUP_COUNT=16`은 모델별 subscription 상한이다. 양산 계약은 각 조명 모델에 층 group 1개와 사용자 fixture group 최대 15개다. 17번째 주소를 추가하려고 상한을 임의로 높이면 모델별 RAM 사용량도 증가하므로 제품 요구사항과 메모리 측정을 함께 갱신해야 한다.

## Group Lightness publication 지터

group 주소의 `Light Lightness Set Unacknowledged`를 받으면 명령 적용은 지연하지 않는다. PWM, NVS 저장 예약, present Lightness 상태를 먼저 갱신한 뒤 ESP-IDF model publication API로 실제 반영값을 보낸다. acknowledged Set과 unicast Set의 기존 즉시 응답/publication 동작은 유지한다.

ESP-IDF의 내장 TID 검사는 자동 응답 경로에만 적용되므로 `RSP_BY_APP` Light Lightness Set에는 32개 고정 슬롯 transaction cache를 사용한다. 키는 `(source, destination, TID)`이며 첫 수신 후 6초 미만인 같은 키를 중복으로 본다. 단조 시각의 unsigned elapsed 계산을 사용해 wrap 경계에서도 판정이 유지된다. 중복 acknowledged Set은 현재 Lightness Status만 직접 응답하고 PWM, NVS 저장, publication을 다시 실행하지 않는다. 중복 unacknowledged Set은 적용과 지연 publication 예약을 모두 생략한다. 캐시는 최대 512바이트로 컴파일 시 제한한다.

publication 지연은 다음 고정 수식을 사용한다.

```text
delay_ms = 64 + (primary_unicast & 0x03FF) * 5
```

- 1,024개 주소 슬롯을 `64~5,179ms` 범위에 결정적으로 분산한다.
- 같은 primary unicast는 재부팅 후에도 같은 슬롯을 사용한다.
- 계산은 ESP-IDF에 의존하지 않는 `mesh_publication_jitter.c`에 분리되어 호스트 단위 테스트로 경곗값과 주소 wrap을 검증한다.
- ESP-IDF `server_model_update_state`의 암묵 publication과 명시적 publication을 함께 사용하지 않는다. `RSP_BY_APP` 수신 경로에서 상태를 한 번 적용하고, publish update callback은 주기 publication buffer만 갱신한다.
- 타이머 예약이 실패하면 상태 확인 자체가 유실되지 않도록 실제 Lightness Status를 즉시 publish하고 오류를 기록한다.

Light Lightness Server의 publication 주소와 AppKey가 provisioner에서 설정되어 있지 않으면 지연 계산이 정상이어도 status를 보낼 수 없다. 동일 노드에 겹치는 group 명령은 Gateway가 직렬화해야 하며, 다음 명령이 지터 대기 중 도착하면 예약 publication은 최신 실제 상태 기준으로 다시 예약된다.

### HIL 검증 한계

Native/actual-driver host fake와 ESP-IDF clean target build만으로는 아래 항목을 증명할 수 없다. 실제 ESP32-H2 노드와 라즈베리파이 Gateway를 연결한 HIL 시험에서 확인한다.

- group subscription과 publication 주소/AppKey 설정 후 단일 group 패킷이 모든 대상 PWM에 즉시 반영되는지
- 각 노드의 Lightness Status가 primary unicast별 `64~5,179ms` 슬롯에 실제 송신되는지
- 같은 `(source, destination, TID)` acknowledged Set을 6초 안에 재전송했을 때 Status 응답은 오지만 PWM 변경, NVS 저장 예약, publication이 추가 발생하지 않는지
- 같은 `(source, destination, TID)` unacknowledged Set을 6초 안에 재전송했을 때 PWM 변경과 지터 타이머 재예약이 없는지, 정확히 6초 이후에는 새 transaction으로 적용되는지
- Light Lightness와 Generic OnOff 각 모델에 층 group 1개와 사용자 group 15개까지 subscription이 성공하고 17번째 주소는 Config Status 오류로 거부되는지
- 16개 group을 모두 구독하고 재부팅한 뒤 subscription이 유지되며 group별 Lightness 명령이 정상 수신되는지
- relay/retransmit가 있는 주차장 RF 환경에서 노드 수 증가에 따른 충돌률과 8초 Gateway 수집 timeout의 적정성
- 패킷 손실, 노드 재부팅, 연속 명령에서 Gateway가 누락 또는 상태 불일치를 정확히 판정하는지
- 100개 이상 실제 노드 soak에서 heap, watchdog, Mesh replay/TID 동작에 회귀가 없는지
- 실제 센서의 Low/High 전압, rise/fall time, 출력 방식과 공통 GND/절연 조건이 ESP32-H2 입력 정격에 맞는지
- boot High/Low, 빠른 양 edge, 장시간 High와 queue overflow에서 edge/current level 및 dropped counter가 예상대로 관측되는지
- 전원 인가/차단, 긴 배선, LED converter switching noise와 ESD 조건에서 false edge나 GPIO 손상이 없는지
- Task 16 Sensor Server/vendor event와 Raspberry Pi Gateway를 연결했을 때 packet loss, ACK retry와 restart current-state 복구가 수렴하는지

## DFK BLE Mesh device UUID

unprovisioned beacon의 16바이트 device UUID는 아래 고정 형식을 사용한다.

| Byte | 길이 | 내용 |
| --- | ---: | --- |
| 0~5 | 6 | ASCII `DFKLED` (`44 46 4b 4c 45 44`) |
| 6 | 1 | format version, 현재 `0x01` |
| 7 | 1 | 제품군 코드 `CONFIG_DFK_PRODUCT_FAMILY` |
| 8 | 1 | 모델 코드 `CONFIG_DFK_MODEL_CODE` |
| 9 | 1 | 하드웨어 revision `CONFIG_DFK_HARDWARE_REVISION` |
| 10~15 | 6 | ESP32-H2 Bluetooth MAC 기반 장치 식별자 |

기본 ESP32-H2 mini 조명 모듈은 제품군, 모델, 하드웨어 revision을 각각 `1`로 사용한다. 제품 또는 PCB revision을 출시할 때는 `Kconfig.projbuild`와 양산용 `sdkconfig.defaults` 값을 확정하고 동일 값으로 펌웨어를 빌드한다. 부팅 로그의 `BLE Mesh node initialized ... uuid=` 뒤 32자리 값을 Gateway 검색 로그와 대조할 수 있다.

이 UUID는 주변의 타사 장치를 검색 결과에서 제외하기 위한 제품 식별자이며 인증서나 서명을 대신하지 않는다. 복제 방지와 장비 신뢰성은 Gateway mTLS, 제조 원장, claim 절차와 별도로 보장한다.

## 문제 해결

- `idf.py`를 찾을 수 없으면 `. "$HOME/esp/esp-idf/export.sh"`를 실행한다.
- 포트가 보이지 않으면 USB 케이블이 데이터 케이블인지 확인하고, 보드의 USB/JTAG 포트를 사용한다.
- 포트가 사용 중이면 기존 `idf.py monitor` 또는 시리얼 모니터를 종료한다.
- 웹 조명 검색에 잡히지 않으면 시리얼 로그에서 `BLE Mesh initialized`와 `Provisioning enabled` 로그를 확인하고, 이미 provisioning된 보드가 아닌지 `erase-flash`로 초기화 후 다시 시도한다.
- `idf5.5_py3.14_env`를 찾는 오류가 나면 스크립트가 최신인지 확인한다. 최신 스크립트는 Python 3.12 경로를 자동으로 우선 적용한다.
- target 오류가 나면 `~/esp/led-control-esp32-h2-build`에서 `idf.py set-target esp32h2`를 다시 실행한다.
- 플래시가 꼬이면 아래 명령으로 erase 후 재시도한다.

```bash
. "$HOME/esp/esp-idf/export.sh"
cd "$HOME/esp/led-control-esp32-h2-build"
idf.py -p /dev/cu.usbmodemXXXX erase-flash
idf.py -p /dev/cu.usbmodemXXXX flash monitor
```
