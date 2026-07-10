# Raspberry Pi 게이트웨이

이 앱은 라즈베리파이에서 실행되는 현장 게이트웨이 프로세스다. 클라우드 MQTT 명령을 받아 BLE Mesh adapter 인터페이스로 전달하고, 명령 ACK, 조명 상태, heartbeat, 조명 검색/등록 이벤트를 MQTT로 발행한다.

## 로컬 실행

로컬 테스트는 `mosquitto` MQTT 브로커와 게이트웨이 프로세스를 각각 실행한 뒤 smoke test 명령을 발행하는 방식으로 검증한다.

### 1. MQTT 브로커 실행

```bash
cd "/Users/kim-jh/Documents/led 조명 관제 서비스"
mosquitto -c infra/mosquitto.conf
```

브로커는 기본적으로 `mqtt://localhost:1883`에서 익명 접속을 허용한다.

### 2. 게이트웨이 환경 변수 확인

개발 PC에서는 `apps/gateway/.env`를 사용한다. 새 환경에서 시작할 때는 아래처럼 복사한 뒤 현장 값으로 수정한다.

```bash
cp apps/gateway/.env.example apps/gateway/.env
```

```env
MQTT_URL=mqtt://localhost:1883
GATEWAY_SITE_ID=00000000-0000-4000-8000-000000000003
GATEWAY_ID=00000000-0000-4000-8000-000000000004
GATEWAY_SERIAL=GW-LOCAL-001
GATEWAY_NAME=Local Gateway
GATEWAY_FIRMWARE_VERSION=gateway-dev-local
GATEWAY_HEARTBEAT_MS=5000
GATEWAY_PROVISIONING_ADAPTER=stub
GATEWAY_STUB_DISCOVERY_COUNT=4
GATEWAY_STUB_FLOOR_NAME=B2
```

### 3. 게이트웨이 실행

```bash
cd "/Users/kim-jh/Documents/led 조명 관제 서비스"
pnpm install
pnpm --filter @led-control/shared build
pnpm --filter @led-control/gateway dev
```

### 4. 수동 제어 smoke test

다른 터미널에서 아래 명령을 실행한다.

```bash
cd "/Users/kim-jh/Documents/led 조명 관제 서비스"
pnpm gateway:smoke
```

성공하면 `sites/{siteId}/commands/dimming`으로 조명 밝기 명령을 발행하고, 게이트웨이가 `command-ack`와 `fixture-state` 이벤트를 다시 발행한 결과가 출력된다. 내부 스크립트는 `apps/gateway/scripts/local-smoke-test.mjs`에 있다.

### 5. 조명 검색/등록 로컬 테스트

기본 `GATEWAY_PROVISIONING_ADAPTER=stub` 모드에서는 웹에서 `조명 검색 시작`을 누르면 게이트웨이가 `provisioning-scan-start` 명령을 받고 `GATEWAY_STUB_DISCOVERY_COUNT`만큼의 `unprovisioned-device-found` 이벤트를 발행한다. 후보 노드에서 `등록`을 누르면 `provision-device` 명령을 받고 `provisioning-completed` 이벤트를 발행한다. API는 이 이벤트를 받아 `MeshNode`와 `Fixture`를 생성한다.

이 모드는 실제 BLE RF 스캔이 아니라 웹/API/MQTT/DB 등록 파이프라인 검증용이다.

## 라즈베리파이 배포

라즈베리파이에 배포할 때는 저장소를 복사한 뒤 `apps/gateway/.env`를 현장 값으로 수정한다.

```env
MQTT_URL=mqtt://<broker-host>:1883
GATEWAY_SITE_ID=<site uuid>
GATEWAY_ID=<gateway uuid>
GATEWAY_SERIAL=GW-RPI-001
GATEWAY_NAME=Main Gateway
GATEWAY_FIRMWARE_VERSION=gateway-rpi-0.1.0
GATEWAY_HEARTBEAT_MS=5000
GATEWAY_PROVISIONING_ADAPTER=command
GATEWAY_SCAN_COMMAND=/opt/led-control/bin/scan-unprovisioned
GATEWAY_PROVISION_COMMAND=/opt/led-control/bin/provision-device
GATEWAY_IDENTIFY_COMMAND=/opt/led-control/bin/identify-device
```

`GATEWAY_FIRMWARE_VERSION`은 사용자가 현장 등록 화면에서 입력하지 않는다. 게이트웨이가 heartbeat를 발행할 때 이 값을 함께 보내고, API가 `Gateway.firmwareVersion`을 자동 갱신한다. 값이 없으면 서버는 기존 `manual-unknown` 값을 유지한다.

## systemd 예시

```ini
[Unit]
Description=LED Control Gateway
After=network-online.target
Wants=network-online.target

[Service]
WorkingDirectory=/opt/led-control-service
EnvironmentFile=/opt/led-control-service/apps/gateway/.env
ExecStart=/usr/bin/pnpm --filter @led-control/gateway dev
Restart=always
RestartSec=5
User=pi

[Install]
WantedBy=multi-user.target
```

## 하드웨어 연동 메모

현재 `StubBleMeshAdapter`, `StubProvisioningScannerAdapter`, `StubProvisioningAdapter`는 실제 BLE Mesh 전송 대신 로컬 테스트 이벤트를 만든다. 하드웨어 확보 후 수동 제어는 `BleMeshAdapter`, 조명 검색은 `ProvisioningScannerAdapter`, 조명 등록은 `ProvisioningAdapter` 구현체를 BlueZ D-Bus 또는 검증된 BLE Mesh provisioner/client 스택으로 교체한다.

`BleMeshAdapter.setBrightness()`는 fixture별 결과를 반환해야 한다.

```ts
interface BleMeshCommandReport {
  fixtureId: string;
  acknowledged: boolean;
  brightness: number;
  faultCode?: string;
  rssi: number | null;
  hopCount: number | null;
}
```

일부 fixture가 실패하면 gateway는 `command-ack`를 `failed`로 발행하되, 성공/실패 fixture의 `fixture-state`를 모두 발행한다. 이 계약은 실제 BLE Mesh Light Lightness Status, Generic OnOff Status, Health Fault Status를 수신하는 adapter로 교체해도 유지한다.

## 실제 BLE Mesh provisioner command adapter

라즈베리파이에서 실제 스캔/등록을 테스트할 때는 `GATEWAY_PROVISIONING_ADAPTER=command`를 사용한다. gateway는 각 command adapter 프로세스의 stdin으로 MQTT payload JSON 한 줄을 전달하고, stdout의 JSON lines를 읽는다.

`GATEWAY_SCAN_COMMAND`는 발견 노드를 한 줄씩 출력한다.

```json
{"deviceUuid":"esp32h2-b2-001","serialNumber":"LC-B2-001","rssi":-61,"oobCapability":"static-oob","firmwareVersion":"esp32h2-0.1.0"}
```

gateway는 `sessionId`와 `discoveredAt`을 보강해 `unprovisioned-device-found` 이벤트로 발행한다.

`GATEWAY_PROVISION_COMMAND`는 한 노드 provisioning, AppKey bind, model subscription, publication 설정을 완료한 뒤 결과 한 줄을 출력한다.

```json
{"meshAddress":"0x0101","firmwareVersion":"esp32h2-0.1.0","rssi":-59,"hopCount":1}
```

명령이 0이 아닌 exit code로 종료되면 gateway는 `provisioning-failed` 이벤트를 발행한다. `GATEWAY_IDENTIFY_COMMAND`는 선택 사항이며, 설정되지 않으면 identify 명령은 성공 처리만 하고 실제 점멸은 수행하지 않는다.

실제 ESP32-H2 검색을 위해서는 보드가 unprovisioned 상태여야 한다. 이미 provisioning된 보드는 검색되지 않으므로 `idf.py erase-flash flash monitor` 또는 펌웨어 factory reset 기능으로 NetKey/AppKey와 mesh address를 지운 뒤 다시 테스트한다.

상용화 단계에서는 게이트웨이가 아래 책임을 추가로 가져야 한다.

- BLE Mesh network key, app key, IV index 등 보안 material을 안전하게 저장한다.
- 조명 노드별 unicast address와 group address 매핑을 서버와 동기화한다.
- MQTT 재연결, 명령 중복 수신, 장비 ACK 지연에 대해 idempotent하게 동작한다.
- 펌웨어 OTA 작업은 서버 명령을 받아 ESP32-H2 노드에 분산 적용하고 진행률을 MQTT 이벤트로 보고한다.
