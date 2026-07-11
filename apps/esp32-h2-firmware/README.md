# ESP32-H2 펌웨어

이 펌웨어는 ESP32-H2 양산/개발 보드를 위한 ESP-IDF 기반 조명 제어 노드이다. PlatformIO는 현재 ESP32-H2 보드 인식과 BLE Mesh/OTA 상용 기능 검증에서 제약이 있어 사용하지 않는다. 기준 환경은 ESP-IDF `v5.5.1`, target은 `esp32h2`이다.

## 현재 검증 상태

- 2026-07-08 기준 macOS 개발 환경에 ESP-IDF `v5.5.1`을 설치했다.
- `scripts/esp32-h2-build.sh`로 실제 ESP32-H2 target 빌드를 통과했다.
- 빌드 산출물은 `/Users/kim-jh/esp/led-control-esp32-h2-build/build`에 생성된다.
- 현재 펌웨어는 부팅 시 NVS에서 마지막 밝기를 복원하고, BLE Mesh unprovisioned node로 광고되며, Generic OnOff/Light Lightness 명령을 받아 PWM 밝기에 반영하는 단계까지 빌드 검증했다.
- BLE Mesh와 양산 기반 보강 포함 후 `led_control_node.bin` 크기는 약 `0xe4d10` 바이트이며, 1MB OTA app partition 기준 약 11% 여유가 남는다. OTA 기능을 추가할 때는 파티션 크기 재검토가 필요하다.

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

저장소 경로에 공백과 한글이 포함되어 있어 ESP-IDF 빌드 안정성을 위해 firmware 파일을 `~/esp/led-control-esp32-h2-build`로 동기화한 뒤 빌드한다.

```bash
cd "/Users/kim-jh/Documents/led 조명 관제 서비스"
scripts/esp32-h2-build.sh
```

성공 시 주요 산출물은 아래와 같다.

- `/Users/kim-jh/esp/led-control-esp32-h2-build/build/bootloader/bootloader.bin`
- `/Users/kim-jh/esp/led-control-esp32-h2-build/build/partition_table/partition-table.bin`
- `/Users/kim-jh/esp/led-control-esp32-h2-build/build/ota_data_initial.bin`
- `/Users/kim-jh/esp/led-control-esp32-h2-build/build/led_control_node.bin`

## 실제 보드 플래시

1. ESP32-H2-MINI 개발 보드를 USB 데이터 케이블로 연결한다.
2. macOS에서 포트를 확인한다.

```bash
ls /dev/tty.usbmodem* /dev/cu.usbmodem* 2>/dev/null
```

3. `/dev/cu.usbmodemXXXX` 형식의 포트를 우선 사용한다.
4. 플래시와 시리얼 모니터를 실행한다.

```bash
cd "/Users/kim-jh/Documents/led 조명 관제 서비스"
scripts/esp32-h2-flash.sh /dev/cu.usbmodemXXXX
```

자동 다운로드 모드 진입이 실패하면 보드의 `BOOT` 버튼을 누른 상태에서 `RESET`을 눌렀다 떼고, 그 다음 `BOOT` 버튼을 놓은 뒤 다시 플래시한다.

ESP-IDF가 직접 출력한 수동 플래시 형식은 아래와 같다. 일반적으로는 위의 `scripts/esp32-h2-flash.sh`를 사용하면 된다.

```bash
idf.py -p /dev/cu.usbmodemXXXX flash monitor
```

## LED 드라이버 연결 주의

- 현재 PWM 출력 핀은 `GPIO 8`이다.
- PWM은 LEDC `5 kHz`, 10-bit duty 해상도를 사용한다.
- 개발 보드 LED 또는 절연된 LED driver의 PWM 입력에 연결해 검증한다.
- 주차장 LED 부하를 ESP32-H2 GPIO에 직접 연결하면 안 된다.
- 외부 LED driver를 사용할 때는 PWM 입력 전압, 공통 GND, 절연 요구사항을 먼저 확인한다.

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
- Health fault clear/test callback과 fault update publication 진입점
- 마지막 밝기, 이전 밝기, command sequence를 NVS blob으로 저장하고 2초 debounce commit으로 flash write를 제한
- Off 후 On 시 직전 0% 초과 밝기를 복원
- Health Attention에 연결된 250ms identify 점멸과 종료 시 원래 밝기 복원
- GPIO active-low 8초 길게 누르기를 통한 앱 NVS 및 BLE Mesh credential factory reset
- panic/watchdog reset reason을 Health fault `0x01`로 기록
- ESP-IDF task watchdog 10초 설정

## 후속 구현

- 실제 ESP32-H2 보드에서 PB-ADV/PB-GATT provisioning 검증
- provisioner에서 AppKey bind, Light Lightness/OnOff model bind, group subscription 자동화
- 라즈베리파이 gateway의 실제 BLE Mesh provisioner/client adapter 구현
- 양산 PCB 확정 후 PWM GPIO와 factory reset GPIO 확정 및 전기적 debounce/ESD 검증
- gateway `identify-device` 명령을 Health Attention Set으로 보내는 실제 BlueZ adapter 연결
- gateway가 Light Lightness Status, Generic OnOff Status, Health Fault Status를 수신해 서버 fixture state로 동기화
- OTA 이미지 수신, 검증, rollback 정책
- BLE Mesh optional transition time을 LEDC fade 완료 후 Status publication으로 연결
- 표준 BLE Mesh TID와 cloud gateway command sequence의 매핑 정책. 현재 영속 sequence 필드는 준비되어 있지만 Generic OnOff/Lightness 표준 메시지의 8-bit TID를 cloud sequence로 간주하지 않는다.

## 양산 GPIO 설정

기본값은 PWM `GPIO 8`, factory reset active-low 입력 `GPIO 9`, 길게 누르기 `8000ms`다. PCB pinout이 확정되면 `menuconfig` 또는 `sdkconfig.defaults`의 다음 값을 변경한다.

```text
CONFIG_LED_CONTROL_PWM_GPIO=8
CONFIG_LED_CONTROL_FACTORY_RESET_GPIO=9
CONFIG_LED_CONTROL_FACTORY_RESET_HOLD_MS=8000
```

factory reset 입력은 내부 pull-up을 사용한다. 양산 회로에서는 외부 pull-up, switch debounce, ESD와 부팅 strap 충돌 여부를 반드시 검토한다. 8초가 충족되면 앱 상태 NVS와 BLE Mesh provisioning 정보를 삭제하고 재부팅해 unprovisioned beacon 상태로 돌아간다.

## BLE Mesh 동작 흐름

1. 부팅 후 NimBLE host를 초기화한다.
2. BLE Mesh device UUID를 `0x4c45 + BLE address` 형태로 만든다.
3. unprovisioned device name을 `DFK-LED-H2`로 설정한다.
4. PB-ADV/PB-GATT bearer를 켜고 provisioner 검색을 기다린다.
5. provisioner가 NetKey/AppKey를 주입하고 model bind/group subscription을 설정한다.
6. gateway가 Generic OnOff 또는 Light Lightness client message를 보낸다.
7. 펌웨어는 PWM 밝기를 변경하고 OnOff/Lightness status를 publish한다.
8. Health fault test/clear 요청은 Health Server callback에서 처리하고 fault update를 publish한다.

웹의 `조명 검색`에 잡히려면 보드가 반드시 unprovisioned 상태여야 한다. 한 번 provisioning된 보드는 NetKey/AppKey와 mesh address를 NVS에 보관하므로 unprovisioned beacon을 내보내지 않는다. 재검색 테스트 전에는 `erase-flash`를 실행하거나 후속 factory reset 기능을 통해 mesh 설정을 삭제한다.

## Provisioner 설정 체크리스트

현재 펌웨어는 노드 역할만 수행한다. 실제 현장에서 라즈베리파이 gateway 또는 별도 provisioner가 아래 작업을 수행해야 한다.

- unprovisioned device UUID prefix `0x4c45` 또는 name `DFK-LED-H2` 기준으로 조명 노드를 식별한다.
- NetKey를 주입하고 unicast address를 할당한다.
- AppKey를 추가한다.
- primary element의 Generic OnOff Server, Light Lightness Server, Health Server에 AppKey를 bind한다.
- 층/구역별 group address를 Light Lightness Server와 Generic OnOff Server에 subscribe한다.
- 상태 publication 주소와 주기를 설정한다.

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
