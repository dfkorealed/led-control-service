# Raspberry Pi 게이트웨이

이 앱은 라즈베리파이에서 실행되는 현장 게이트웨이 프로세스다. 클라우드 MQTT 명령을 받아 BLE Mesh adapter 인터페이스로 전달하고, 명령 ACK, 조명 상태, heartbeat, 조명 검색/등록 이벤트를 MQTT로 발행한다.

## BlueZ Phase 0 타당성 검사

양산형 실제 장비 경로는 Raspberry Pi의 `bluetooth-meshd`와 BlueZ Mesh D-Bus를 사용한다. 개발 PC의 stub 성공을 실제 BLE Mesh 성공으로 간주하지 않으며, 아래 여섯 항목이 Raspberry Pi 1대와 ESP32-H2 1~2대에서 모두 확인되어야 실제 BlueZ adapter 구현을 운영 경로로 선택한다.

1. `org.bluez.mesh` daemon 확인
2. `org.bluez.Adapter1` Bluetooth adapter 확인
3. ESP32-H2 PB-ADV unprovisioned beacon scan
4. 고정 unicast address를 사용한 provisioning과 AppKey/model bind
5. Generic OnOff/Light Lightness 명령과 Status 왕복
6. Raspberry Pi, `bluetooth-meshd`, ESP32-H2 재부팅 후 복구

우선 Raspberry Pi OS에서 BlueZ Mesh daemon을 설치하고 system D-Bus에 `org.bluez.mesh`가 노출되는지 확인한다. 배포판 패키지에 `bluetooth-meshd`가 없다면 해당 Raspberry Pi OS가 제공하는 BlueZ source package와 동일한 버전으로 빌드한다.

```bash
sudo systemctl enable --now bluetooth
sudo systemctl enable --now bluetooth-meshd
busctl --system list | rg 'org\.bluez(\.mesh)?'
pnpm --filter @led-control/gateway bluez:probe
```

Mac이나 일반 개발 PC에서는 probe가 종료 코드 `2`와 `hardware_required`를 반환한다. Raspberry Pi에서 daemon과 adapter만 확인되고 RF 검사가 끝나지 않았으면 종료 코드 `3`과 `incomplete`를 반환한다. 이 상태는 실패가 아니라 실기 검증 미완료이며, scan/provision/model/restart 항목을 실제 장비로 확인하기 전에는 문서에 BlueZ 검증 완료로 기록하지 않는다.

설치, Docker 배포, ESP32 적용, 등록·제어·복구 시험은 `docs/runbooks/raspberry-pi-gateway-appliance.md`를 따른다. 2026-07-13 Pi에서 daemon/HCI/network 생성/token 재연결까지 확인했으며 ESP32-H2와 2-node HIL은 아직 별도 실기 관문이다.

## 로컬 실행

로컬 테스트는 mTLS `mosquitto` MQTT 브로커와 게이트웨이 프로세스를 실행한 뒤 smoke test 명령을 발행하는 방식으로 검증한다.

### 1. MQTT 브로커 실행

```bash
cd "/Users/kim-jh/Documents/led 조명 관제 서비스"
scripts/dev-pki/create-ca.sh
scripts/dev-pki/issue-gateway-cert.sh <gatewayId>
docker compose up mqtt-tls
```

### 2. 게이트웨이 환경 변수 확인

Gateway 본체는 양산 설정과 BlueZ adapter만 허용한다. 별도 mock gateway 실행 경로와 stub mode는 없다.

```bash
cp apps/gateway/.env.example apps/gateway/.env
```

```env
MQTT_URL=mqtts://localhost:8883
GATEWAY_SERIAL=GW-LOCAL-001
GATEWAY_FIRMWARE_VERSION=gateway-dev-local
GATEWAY_HEARTBEAT_MS=5000
GATEWAY_ADAPTER=bluez
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

웹/API/MQTT/DB 등록 파이프라인은 실제 Raspberry Pi와 ESP32-H2를 사용하는 HIL 절차로 검증한다. 자동 테스트용 adapter는 `apps/gateway/test`에만 있고 배포 산출물에는 포함되지 않는다.

## 라즈베리파이 배포

라즈베리파이 양산 이미지에는 현장 `siteId`와 DB의 `gatewayId`를 미리 넣지 않는다. 제조 시 주입한 serial과 1회용 enrollment token으로 장비 내부 key에 대한 device certificate를 발급받고, 이후 device mTLS bootstrap을 호출한다. 사용자가 웹에서 claim을 완료하면 서버가 assignment를 반환한다. 게이트웨이는 이를 기본 `/var/lib/led-control/assignment.json`에 원자적으로 저장하며 파일 권한은 `0600`이다.

### 제조 identity 생성과 설치

양산 장비의 private key는 게이트웨이 안에서 OpenSSL `genpkey` EC P-256으로 생성한 PKCS#8 파일이다. `OpenSslCsrGenerator`는 strict serial 형식만 받아 `req -new -sha256` CSR을 만들며 shell을 사용하지 않는다. OpenSSL 실행 전 key path를 exclusive `wx`와 mode `0600`으로 만들고 fsync한 뒤 닫으므로 process umask와 관계없이 group/other read 권한이 생기는 순간이 없다. `KeyMaterialStore.generateDeviceIdentity(serialNumber)`의 반환값에는 CSR만 있고 private key를 읽거나 내보내는 API는 없다.

`/var/lib/led-control/identity`는 writable persistent parent이고 device identity root는 `/var/lib/led-control/identity/device`, MQTT identity root는 `/var/lib/led-control/identity/mqtt`다. `GATEWAY_IDENTITY_ROOT`에는 device root를 지정한다. root와 generation directory는 `0750`, private key는 `0600`, 인증서와 CA bundle은 `0644`다. 생성 중 device key/CSR은 device root의 `pending-generations/<generation-id>`에만 존재한다. `installIdentityBundle()`이 CSR과 device certificate의 public key 일치, 인증서 유효기간, `deviceCaBundlePem` 기준 chain을 모두 OpenSSL로 확인한 뒤에만 generation을 `generations/<generation-id>`로 옮기고 `device/current` symlink를 원자 교체한다. 검증 또는 pointer 교체 실패 시 기존 `current`는 유지된다. Rename 후 directory fsync가 실패하면 이전 pointer를 먼저 복원하고, pointer rollback 자체가 실패한 경우에는 새 active generation을 보존해 `current`가 dangling 되지 않게 한다.

CA 파일은 용도별로 분리한다.

| CA 역할 | 저장/전달 | 사용처 |
| --- | --- | --- |
| Factory/API server CA | 제조 이미지의 `factory-trust/api-ca.crt`, 발급 응답의 `apiCaBundlePem`은 identity의 `api-ca.crt` | 제조 enrollment와 이후 bootstrap API의 HTTPS server certificate 검증 전용 |
| Device issuing CA | 발급 응답의 `deviceCaBundlePem`, identity의 `device-ca.crt` | device certificate 발급 chain과 로컬 OpenSSL `sslclient` 검증 전용 |
| MQTT server CA | 발급 응답의 `mqttCaBundlePem`; Task 27 활성화 후 `mqtt/current/mqtt-ca.crt` | MQTT broker TLS server certificate 검증 전용 |
| Manufacturing client CA | API 제조 station trust 설정 | manufacturing station client certificate 검증 전용이며 gateway에 배포하지 않음 |

`api-ca.crt`는 device certificate trust anchor가 아니다. API server CA와 Device issuing CA가 서로 달라도 enrollment와 identity 활성화가 성공해야 하며, 같은 device certificate를 `api-ca.crt`로 검증하면 실패해야 한다.

초기 제조 enrollment HTTPS trust는 leaf identity와 분리한다. 호스트의 `${GATEWAY_DATA_DIR}/factory-trust/api-ca.crt`만 `/etc/led-control/factory-trust/api-ca.crt:ro`로 mount하고, 클라이언트는 `rejectUnauthorized=true`와 hostname 검증을 사용한다. enrollment token, serial, CSR은 JSON body에 한 번만 들어가며 응답은 timeout과 크기 상한을 적용한다. 응답 parser는 device certificate와 `deviceCaBundlePem`, `apiCaBundlePem`, `mqttCaBundlePem`을 각각 certificate PEM으로 검사한다. Claim Code는 호출자에게 한 번 반환할 수 있지만 파일이나 로그에 저장하지 않는다.

runtime image는 Debian Bookworm이 제공하는 OpenSSL `3.0.x`를 설치하고 image build 중 `openssl version`으로 minor 범위를 확인한다. Debian snapshot을 사용하지 않는 상태에서 exact patch를 pin하면 보안 저장소가 갱신될 때 패키지가 사라져 재현성이 오히려 깨지므로 patch pin은 하지 않는다. 이미지 digest 고정이나 Debian snapshot 도입 시에만 exact patch 재현성을 별도 계약으로 올린다.

```env
GATEWAY_SERIAL=GW-RPI-001
GATEWAY_BOOTSTRAP_URL=https://api.example.com/gateway-bootstrap
GATEWAY_IDENTITY_ROOT=/var/lib/led-control/identity/device
GATEWAY_FACTORY_API_CA_PATH=/etc/led-control/factory-trust/api-ca.crt
GATEWAY_DEVICE_CERT_PATH=/var/lib/led-control/identity/device/current/device.crt
GATEWAY_DEVICE_KEY_PATH=/var/lib/led-control/identity/device/current/device.key
GATEWAY_BOOTSTRAP_CA_PATH=/var/lib/led-control/identity/device/current/api-ca.crt
MQTT_CA_PATH=/var/lib/led-control/identity/mqtt/current/mqtt-ca.crt
MQTT_CLIENT_CERT_PATH=/var/lib/led-control/identity/mqtt/current/gateway.crt
MQTT_CLIENT_KEY_PATH=/var/lib/led-control/identity/mqtt/current/gateway.key
GATEWAY_ASSIGNMENT_PATH=/var/lib/led-control/assignment.json
GATEWAY_FIRMWARE_VERSION=gateway-rpi-0.1.0
GATEWAY_HEARTBEAT_MS=5000
GATEWAY_ADAPTER=bluez
```

장비가 아직 claim되지 않았으면 2초부터 최대 60초까지 지수 backoff로 bootstrap을 재시도한다. 저장된 assignment가 있으면 네트워크 장애 중에도 이를 우선 사용한다. 현장 ID를 환경변수로 직접 넣는 경로는 제거 대상이며 장치 private key와 claim code 원문은 DB, assignment 파일, Git에 저장하지 않는다.

## MQTT mTLS 개발 검증

개발용 TLS broker와 인증서는 다음 순서로 준비한다. `.local/pki`는 Git에서 제외되며 private key 권한은 `0600`으로 생성된다.

```bash
scripts/dev-pki/create-ca.sh
scripts/dev-pki/issue-gateway-cert.sh <claim 후 발급된 gatewayId>
docker compose up mqtt-tls
```

API는 `.local/pki/api.crt`, gateway는 발급된 `gateway-<gatewayId>.crt`를 사용한다. API와 gateway는 환경에 관계없이 `mqtts://` URL 및 `MQTT_CA_PATH`, `MQTT_CLIENT_CERT_PATH`, `MQTT_CLIENT_KEY_PATH`가 모두 필요하며 평문 broker는 허용하지 않는다.

제조 시 주입하는 bootstrap 인증서는 serial 기반 장치 identity를 증명한다. MQTT 인증서는 claim이 끝나 `gatewayId`가 정해진 뒤 장치가 생성한 CSR에 대해 별도로 발급하고 CN을 `gatewayId`로 사용한다. 따라서 양산 이미지에 site/gateway ID나 MQTT private key를 미리 넣지 않는다. Task 27은 MQTT 연결 전에 `identity/mqtt/current`에 `gateway.crt`, `gateway.key`, `mqtt-ca.crt`가 포함된 원자적 identity generation을 생성해야 한다. Gateway는 이 precondition이 충족되기 전에는 MQTT client를 시작하지 않으며, MQTT leaf 파일을 `identity/device/current`에서 찾지 않는다.

인증서 폐기 후에는 CRL을 갱신하고 broker를 재시작한다.

```bash
scripts/dev-pki/revoke-gateway-cert.sh .local/pki/gateway-<gatewayId>.crt
```

`GATEWAY_FIRMWARE_VERSION`은 사용자가 현장 등록 화면에서 입력하지 않는다. claim 직후에는 `bootstrap-pending`이며 게이트웨이가 heartbeat를 발행하면 API가 실제 버전으로 갱신한다.

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

양산 gateway runtime에는 stub adapter가 없다. 자동 테스트용 adapter는 `apps/gateway/test`에만 존재하고 배포 진입점에서 import하지 않는다. 수동 제어, 검색, 등록은 검증된 BlueZ D-Bus adapter가 없으면 시작 단계에서 실패한다.

SIG model codec과 실제 BlueZ adapter는 scan, provisioning, AppKey 추가, Generic OnOff/Light Lightness bind, status publication, acknowledged Lightness Status 처리를 구현했다. fixture ID와 unicast mapping은 gateway volume에 원자 저장하며 실제 Status 전에는 제어 성공으로 처리하지 않는다.

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

## 폐기된 command adapter

범용 shell command adapter는 양산 gateway에서 사용하지 않는다. 실제 스캔/등록/identify/제어는 검증된 BlueZ Mesh adapter interface로만 연결한다. 아래 형식은 이전 MVP 경계 기록이며 실행 설정으로 사용하지 않는다.

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
