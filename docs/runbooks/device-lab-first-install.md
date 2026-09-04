# Lab Vault 기반 최초 실장비 설치 시험

> 현재 판정: production API·인증·claim·registration·MQTT ACK/state의 software E2E와 Raspberry Pi 4 제조 등록·claim·bootstrap·mTLS, 단일 ESP32-H2 검색·provisioning·상태·수동 제어를 통과했다. 2026-09-04에는 Lab 전용 `0xFFFE`로 schedule 시작/종료와 GPIO Active High 차량 이벤트·Low hold 종료를 실제 BlueZ RF로 검증했다. 다중 노드·Mesh Group, 실제 센서와 LED converter 전기 연결, packet loss·동시 전원 차단은 남아 있으며 자사 Company Identifier와 서명된 firmware 제조 승인이 준비되기 전에는 양산 준비 완료로 판정하지 않는다.

이 문서는 개발 Mac에서 양산과 같은 신뢰 흐름을 반복 시험하는 단일 기준 절차다. Lab 전용 Root와 Vault를 사용하지만 제품 API의 제조 등록, 일회성 claim, 장비 bootstrap, MQTT mTLS 경로는 우회하지 않는다.

## 1. 시험 흐름과 각 단계의 목적

1. **Lab Vault 시작**: 장비 인증서를 발급하는 온라인 intermediate CA를 실행한다.
2. **Lab Root 서명**: Vault가 만든 목적별 CSR을 별도 Root로 서명해 device, MQTT, API 신뢰 영역을 분리한다.
3. **제조 station 발급**: 아무 PC나 제조 원장을 만들지 못하도록 제조 작업자용 mTLS identity를 발급한다.
4. **API/MQTT 실행 bundle 생성**: 서버 인증서, client CA, CRL과 제한된 Vault application token을 준비한다.
5. **Pi 제조 등록**: Pi 안에서 device private key를 만들고 API 제조 원장에 serial과 지문을 등록한다.
6. **웹 claim**: 일회성 code로 물리 장비를 특정 현장에 귀속한다.
7. **Gateway bootstrap**: claim된 장비만 assignment와 MQTT 인증서를 받는다.
8. **BLE Mesh 등록과 제어**: 실제 ESP32-H2를 검색, provisioning, model bind한 뒤 상태 응답까지 확인한다.

Lab Root private key와 Vault root token은 개발 Mac의 `.local` 밖으로 복사하지 않는다. Pi에는 device identity와 공개 CA만 전달되며 `siteId`나 DB `gatewayId`를 제조 시 미리 넣지 않는다.

## 2. 사전 준비

Mac에 Docker Desktop, Node.js, pnpm, Vault CLI, OpenSSL, jq, Mosquitto와 SSH가 필요하다. Pi에는 64-bit Raspberry Pi OS, Docker Engine/Compose plugin, Bluetooth와 SSH가 필요하다.

양산 Gateway와 ESP32-H2에는 Bluetooth SIG가 제품 소유 회사에 할당한 동일한 Company Identifier가 필요하다. 발급 전 BLE Mesh 실기는 격리된 `lab-hil` 프로파일에서만 비양산 RFU `0xFFFE`를 양쪽에 동일하게 사용한다. `0xFFFF`는 BlueZ가 SIG 모델 표식으로 사용하므로 vendor model이 있는 이 제품의 RF Lab에 사용할 수 없다. `0xFFFE`도 할당값이 아니므로 이 결과는 검색·provisioning·제어 RF 검증용일 뿐 Bluetooth SIG 적합성 또는 양산 완료 증거가 아니다.

```bash
cd "/Users/kim-jh/Documents/led-control-service"
brew install node pnpm vault openssl@3 jq mosquitto
pnpm install
cp -n .env.example .env
docker info
vault version
openssl version
```

`docker info`가 끝나지 않거나 새 컨테이너가 계속 `Created`에 머물면 Docker Desktop 엔진 문제다. Docker Desktop을 완전히 재시작하고 다음 smoke test가 즉시 끝나는지 먼저 확인한다.

```bash
docker run --rm --entrypoint vault hashicorp/vault:1.17.6 version
```

Mac의 현재 LAN IP를 확인한다. Wi-Fi가 `en0`이 아니면 `networksetup -listallhardwareports`로 인터페이스를 찾는다.

```bash
export LAB_HOST_IP="$(ipconfig getifaddr en0)"
test -n "$LAB_HOST_IP" && printf 'Lab host IP: %s\n' "$LAB_HOST_IP"
```

기본 DNS 이름을 Mac과 Pi에서 같은 IP로 해석해야 TLS 인증서의 SAN 검증이 성립한다.

```bash
printf '%s api.led.lan mqtt.led.lan\n' "$LAB_HOST_IP" | sudo tee -a /etc/hosts
getent hosts api.led.lan 2>/dev/null || dscacheutil -q host -a name api.led.lan
```

Pi에도 `/etc/hosts`에 같은 한 줄을 추가한다. DHCP로 Mac IP가 바뀌면 인증서를 다시 발급하기보다 먼저 이 값과 `LAB_HOST_IP`가 일치하는지 확인한다.

## 3. Lab Vault와 전체 PKI를 한 번에 준비

다음 명령은 Vault 시작, CSR 생성, Lab Root 서명, intermediate 설치, API/MQTT 인증서, CRL, 제조 station, 제한된 application token과 실행 환경 파일 생성을 순서대로 수행한다.
Bootstrap은 목적별 Vault PKI mount의 CRL을 72시간 유효기간과 24시간 자동 재생성 여유로 설정하고 즉시 회전한다. 장기간 중지한 Lab을 재개할 때도 만료된 CRL을 그대로 service bundle에 재사용하지 않는다.

```bash
LAB_API_IP="$LAB_HOST_IP" \
LAB_MQTT_IP="$LAB_HOST_IP" \
pnpm lab:pki:bootstrap
```

정상 결과는 마지막에 `.local/lab-pki/lab.env` 경로가 출력되는 것이다. 같은 IP와 DNS로 다시 실행해도 안전하게 재사용돼야 한다.

주요 산출물은 다음과 같다.

| 경로 | 용도 | 외부 전달 |
| --- | --- | --- |
| `.local/lab-vault/root-token` | 최초 PKI 설정용 Vault 최고 권한 token | 금지 |
| `.local/lab-vault/unseal-key` | 재시작한 Lab Vault 해제 | 금지 |
| `.local/lab-pki/root/root.key` | Lab 전용 offline Root private key | 금지 |
| `.local/lab-pki/application/current/token` | API가 장비 인증서를 발급할 24시간 periodic 제한 token | API 호스트만 |
| `.local/lab-pki/lab.env` | API/MQTT/Vault 실행 경로 모음 | 개발 Mac 전용 |
| `.local/lab-pki/manufacturing/station.key` | 제조 원장 등록 권한 | 제조 station만 |
| `.local/lab-pki/services/` | API/MQTT 인증서, 공개 CA와 CRL | 목적별 배포 |

권한과 인증서 목적을 확인한다. private key와 token은 `600`이어야 한다.

```bash
stat -f '%Lp %N' .local/lab-vault/root-token .local/lab-vault/unseal-key \
  .local/lab-pki/application/current/token .local/lab-pki/manufacturing/station.key
openssl verify -CAfile .local/lab-pki/manufacturing/manufacturing-ca.crt \
  .local/lab-pki/manufacturing/station.crt
openssl x509 -in .local/lab-pki/manufacturing/station.crt -noout -purpose
PKI_ENV=lab pnpm lab:vault status
```

station 인증서의 `SSL client : Yes`와 Vault의 `Initialized true`, `Sealed false`가 정상이다.

API는 periodic token을 만료 시간의 절반마다 `renew-self`한다. 갱신 실패 시 인증서 발급을 계속하지 않고 API를 종료한다. bootstrap 중 token 폐기까지 실패한 경우에는 accessor와 token을 `.local/lab-pki/application-tokens/orphaned`에 권한 제한 상태로 남기고 실패하며, 다음 bootstrap이 이를 먼저 폐기한다.

## 4. DB, Redis, API, Web과 MQTT 실행

Lab bundle을 사용할 때 Compose의 개발용 `mqtt-tls`는 실행하지 않는다. PostgreSQL, Redis와 파일 저장소만 올린다.

```bash
docker compose stop mqtt-tls 2>/dev/null || true
docker compose up -d postgres redis object-storage object-storage-init
pnpm --filter @led-control/api prisma:generate
pnpm --filter @led-control/api exec prisma migrate deploy
```

빈 DB라면 최초 operator를 한 번 생성한다.

```bash
BOOTSTRAP_ORGANIZATION_NAME='DF Korea Service' \
BOOTSTRAP_OPERATOR_LOGIN_ID='operator_01' \
BOOTSTRAP_OPERATOR_NAME='운영자' \
BOOTSTRAP_OPERATOR_PASSWORD='교체할-긴-시험용-비밀번호' \
pnpm --filter @led-control/api auth:bootstrap-operator
```

계정 전환 migration은 사용자 DB를 reset하지 않으며 운영 DB에서는 유지보수 창을 잡아 다음 순서를 지킨다.

1. 계정·초대·세션 관련 write를 freeze한다.
2. 구버전 API, worker와 배치 작업을 완전히 drain하고 실행 인스턴스가 0개임을 확인한다.
3. `20260827090000_operator_admin_account_flow` expand와 `20260827100000_login_id_contract`의 재-backfill, 형식·충돌·NULL guard, `loginId NOT NULL` contract를 모두 완료한다.
4. 새 `loginId` API/Web만 배포하고 smoke 확인 뒤 write freeze를 해제한다.

이 유지보수 구간에는 로그인 API를 제공하지 않으므로 `loginId IS NULL` 사용자가 로그인해야 하는 공백이 없다. email 로그인 fallback이나 구·신 API 동시 운영은 허용하지 않는다. 빈 DB의 fresh deploy는 `prisma migrate deploy`로 전체 migration을 완료한 뒤 새 API/Web만 시작한다.

생성된 환경을 현재 shell에 export한 뒤 개발 서버를 실행한다.

```bash
set -a
. .local/lab-pki/lab.env
set +a
pnpm dev
```

정상 상태는 API `4000`, Web `5173`, MQTT TLS `8883`이 열리고 API가 Vault token file을 읽어 시작하는 것이다. 다른 터미널에서 확인한다.
API HTTPS listener는 일반 Web 요청과 장비 mTLS 요청을 함께 받는다. TLS 계층은 client certificate를 요청하되 인증서가 없는 브라우저 연결을 허용하고, 제조·Gateway 전용 endpoint는 `ManufacturingAuthGuard`와 `DeviceCertificateGuard`가 `socket.authorized` 및 발급 CA를 다시 검증해 거부한다.

```bash
curl --cacert .local/lab-pki/services/current/api-ca.crt \
  -sS -o /dev/null -w 'API HTTP %{http_code}\n' https://api.led.lan:4000/auth/me
openssl s_client -connect mqtt.led.lan:8883 -servername mqtt.led.lan \
  -CAfile .local/lab-pki/services/current/mqtt-ca.crt </dev/null
```

## 5. Gateway ARM64 image 준비와 Pi 선배포

개발 Mac에서 ARM64 appliance image를 만든다. 커밋되지 않은 코드로 일시 시험할 때만 `ALLOW_DIRTY_BUILD=1`을 사용한다.

```bash
pnpm gateway:appliance:build
# 또는 임시 시험: ALLOW_DIRTY_BUILD=1 pnpm gateway:appliance:build
```

Pi에 image와 Compose 파일을 먼저 전달한다.

```bash
scripts/gateway-appliance-deploy.sh dfkorea@dfkorea.local
```

최초 실행은 image를 load한 뒤 `.env.appliance` 또는 제조 identity가 없다는 이유로 exit code `2`가 나와도 정상이다. 아직 claim 전이라 실행에 필요한 장비 identity가 없기 때문이다.

## 6. 제조 station으로 Pi identity 발급

build가 만든 image 변수를 읽고 제조 station 인증서를 지정한다.

```bash
set -a
. "$(find dist/gateway-appliance -name '*-linux-arm64.tar.env' | sort | tail -n 1)"
. .local/lab-pki/lab.env
set +a
export GATEWAY_IMAGE="$GATEWAY_IMAGE_REPOSITORY:$GATEWAY_IMAGE_TAG"
mkdir -p .local/manufacturing

ssh dfkorea@dfkorea.local \
  'mkdir -p /opt/led-control/gateway/data/factory-trust && chmod 700 /opt/led-control/gateway/data/factory-trust'
scp .local/lab-pki/services/current/api-ca.crt \
  dfkorea@dfkorea.local:/opt/led-control/gateway/data/factory-trust/api-ca.crt

pnpm gateway:manufacturing:enroll \
  --target dfkorea@dfkorea.local \
  --serial GW-RPI-000001 \
  --label-output "$PWD/.local/manufacturing/GW-RPI-000001.json"
```

먼저 복사한 `api-ca.crt`는 Pi가 제조 API 서버를 진짜 Lab API로 검증하기 위한 공개 신뢰 anchor다. 이 단계에서 API는 정상 station mTLS 인증서만 허용하고, Pi는 private key를 Pi 내부에 생성한다. 정상 결과인 label JSON은 권한 `600`이며 `serialNumber`, `claimCode`, `fingerprint`를 가진다. claim code 원문을 채팅, Git, DB SQL 또는 로그에 붙이지 않는다.

```bash
jq '{serialNumber, fingerprint, hasClaimCode: (.claimCode | length > 20)}' \
  .local/manufacturing/GW-RPI-000001.json
ssh dfkorea@dfkorea.local 'find /opt/led-control/gateway/data/identity/device -maxdepth 3 -type f -ls'
```

## 7. 웹에서 현장·admin 생성과 일회성 claim

1. `http://localhost:5173`에서 operator의 `loginId`로 로그인하고 `/operator/site-admins`에서 **현장 및 관리자 생성**을 연다.
2. 고객사명, 현장명과 assigned admin의 이름·`loginId`·초기 비밀번호를 입력한다. operator 화면에서 고객 모니터링·제어·통계·설정 URL을 열면 `/operator/site-admins`로 돌아와야 한다.
3. operator에서 로그아웃하고 발급한 admin으로 로그인한다. pending Site는 `/settings?siteId=...`의 **초기 설치 설정**으로 이동해야 한다.
4. admin이 주소, kWh 단가, IANA 시간대와 층 구성을 저장한다.
5. `게이트웨이 등록`에서 이름과 `GW-RPI-000001`을 입력하고 label JSON의 `claimCode`를 비밀번호 입력란에 한 번만 입력한다.
6. 성공 응답의 `gatewayId`를 기록한다. Gateway는 현장에 귀속되며, 이후 admin이 조명 검색 세션에서 대상 층과 Gateway를 각각 선택한다.

claim code는 성공 즉시 hash까지 폐기되므로 같은 코드의 두 번째 사용은 실패해야 정상이다. 제조 원장을 직접 수정하거나 Gateway row를 SQL로 만들면 device identity 소유권 검증을 우회하므로 금지한다.

claim 후에는 로컬 Mosquitto ACL에 실제 Gateway UUID를 반영해야 한다. 실행 중인 `pnpm dev`를 `Ctrl+C`로 종료하고 새 터미널에서 다음처럼 재시작한다.

```bash
cd "/Users/kim-jh/Documents/led-control-service"
set -a
. .local/lab-pki/lab.env
set +a
export DEV_GATEWAY_ID='<claim 응답의 gatewayId>'
pnpm dev
```

## 8. Pi 설정, bootstrap과 MQTT 연결

Pi에서 실행 설정을 만든다.

```bash
ssh dfkorea@dfkorea.local
cd /opt/led-control/gateway
cp -n .env.appliance.example .env.appliance
nano .env.appliance
```

필수 값을 다음처럼 설정한다.

```env
GATEWAY_DATA_DIR=/opt/led-control/gateway/data
MQTT_URL=mqtts://mqtt.led.lan:8883
GATEWAY_SERIAL=GW-RPI-000001
GATEWAY_FIRMWARE_VERSION=gateway-appliance-lab
GATEWAY_ADAPTER=bluez
GATEWAY_DEPLOYMENT_MODE=lab-hil
GATEWAY_LAB_HIL_ACK=NOT_FOR_PRODUCTION
GATEWAY_BLUETOOTH_COMPANY_ID=65534
GATEWAY_HEARTBEAT_MS=5000
GATEWAY_BLE_STATUS_TIMEOUT_MS=8000
GATEWAY_BLE_SCAN_SECONDS=10
GATEWAY_BOOTSTRAP_URL=https://api.led.lan:4000/gateway-bootstrap
```

Mac에서 다시 배포하면 gateway가 제조 인증서로 assignment를 받고 자체 MQTT key/CSR을 생성해 Vault 서명 인증서를 받은 뒤 broker에 연결한다.

```bash
scripts/gateway-appliance-deploy.sh dfkorea@dfkorea.local
ssh dfkorea@dfkorea.local \
  'docker inspect --format "{{json .State.Health}}" led-control-gateway && docker logs --tail=200 led-control-gateway'
```

정상 판정은 assignment에 웹 claim의 `gatewayId`와 `siteId`가 기록되고, MQTT heartbeat가 API DB의 gateway `lastHeartbeatAt`을 갱신하며, 컨테이너 health가 `healthy`가 되는 것이다. BlueZ Mesh가 아직 준비되지 않았다면 `starting` 또는 `unhealthy` 원인을 로그에서 먼저 해결한다.

## 9. ESP32-H2 준비와 Task 16 실기 검증 진입

Company ID 발급 전에는 ESP-IDF 5.5 Lab HIL firmware를 빌드하고 연결된 각 보드에 기록한다. Lab flash wrapper는 flash 후 serial monitor까지 계속 실행하므로 node마다 terminal을 하나씩 사용한다.

```bash
cd "/Users/kim-jh/Documents/led-control-service"
scripts/esp32-h2-build.sh --lab-hil-build
ls /dev/cu.usbmodem*
scripts/esp32-h2-lab-hil-flash.sh /dev/cu.usbmodemXXXX
```

serial log의 `BLE Mesh node initialized ... uuid=` 값은 32자리 hex이고 `44464b4c4544`로 시작해야 한다. 검색 전 보드는 unprovisioned 상태여야 한다. 이미 provisioned된 보드는 NetKey와 unicast address를 보존하므로 검색되지 않으며, 새 설치 시험에서는 firmware README의 `erase-flash` 절차로 초기화한 뒤 다시 flash한다.

### 9.1 software E2E와 HIL을 분리한다

다음 Playwright 명령은 로그인 이후의 모니터링·제어 route/UI 계약을 빠르게 회귀 검증하기 위한 것이다. 앞의 두 browser fixture는 실제 MQTT mTLS를 사용하지 않고, `e2e:journey:real`만 격리 lab CA/mTLS broker를 사용한다. 어느 명령도 실제 Raspberry Pi, ESP32-H2 또는 BLE Mesh RF를 사용하지 않으므로 이 결과만으로 실장비 설치 성공을 표시하지 않는다.

```bash
pnpm --filter @led-control/web exec playwright test e2e/monitoring-control-flow.spec.ts
pnpm --filter @led-control/web exec playwright test e2e/monitoring-1000.spec.ts
pnpm --filter @led-control/web e2e:journey:real
```

`e2e:journey:real`은 매 실행 전용 PostgreSQL data directory/Unix socket, Redis, lab CA 기반 mTLS Mosquitto와 test-support software publisher를 생성하고 종료 시 삭제한다. PostgreSQL은 `SHOW data_directory`와 spawned postmaster PID, Redis/API/Web/Mosquitto는 spawned process의 포트 소유권을 확인한 뒤에만 진행하므로 사용자 개발 DB나 기존 서비스를 읽거나 reset하지 않는다. publisher는 shared `parseDfkDeviceUuid` 정본으로 3개 후보 중 invalid/타사 UUID 1개를 scan-found에서 제외하고 lab CA의 `CN=Gateway.id` 인증서와 own-gateway topic ACL을 사용한다. 이 시험은 production API, cookie 인증, Gateway claim, registration outbox, command MQTT acceptance/device-status ACK와 fixture-state ingestion을 통과하지만 production Gateway 인증서 발급·bootstrap·배포 ACL, 실제 `apps/gateway`, Raspberry Pi BlueZ 또는 ESP32-H2 radio/firmware를 실행하지 않는다.

실제 장비 판정은 [양산 장비 2-노드 실험실 검증](./production-device-lab.md)의 Gate 1부터 Gate 7까지 순서대로 수행한다. 그 문서의 `목적`, `선행 조건`, `실행 명령과 화면 조작`, `기대 로그와 API/DB 상태`, `실패 판정`, `저장할 증거`를 생략하거나 자동 fixture 결과로 대체하지 않는다.

### 9.2 설치 직후 실행 순서

1. **자사 UUID 검색**: 모니터링에서 층과 Gateway를 선택한 뒤 **조명 검색 시작**을 누른다. ESP32 boot UUID와 API `discoveredNodes[].deviceUuid`를 대조하고, 타사 prefix가 웹에 나타나지 않는지 확인한다.
2. **batch 등록**: 두 node를 선택해 **일괄 설정**으로 자동 이름을 지정한다. batch API의 `accepted`는 접수 상태일 뿐이므로 각 node가 `provisioned` 또는 명시적 실패 상태가 될 때까지 기다린다.
3. **subscription ready**: 최소 10초 후 층과 사용자 구역의 `MeshControlGroup` 및 모든 member가 같은 version의 `ready/applied`인지 확인한다. Gateway의 `/var/lib/led-control/mesh-groups.json`에 대응 snapshot이 없으면 제어로 넘어가지 않는다. 현재 clean install에는 FixtureGroup 생성·멤버십 API/UI가 없으므로 zone을 SQL로 만들지 않으며, 기존에 지원 경로로 생성된 zone이 없으면 이 항목은 `not_executed`다.
4. **group 단일 전송**: 제어 메뉴에서 층 또는 구역을 선택하고 밝기를 한 번 적용한다. create response가 `deliveryMode=mesh_group`, `transmissionCount=1`인지 확인하고, 상세 런북의 `dbus-monitor`로 실제 group destination `Node1.Send`가 한 번인지 저장한다.
5. **fixture별 status**: `GET /api/commands/{commandId}`가 각 fixture의 Light Lightness Status를 받은 뒤 terminal이 되는지 확인한다. 한 node 전원 OFF 시험에서는 응답 node `succeeded`, 미응답 node `timed_out`, command `partial_failed`여야 한다. MQTT 접수 ACK만으로 성공 처리되면 실패다.
6. **Health 발생·해제**: exact ELF의 GDB로 production image에 panic fault `0x01`을 일회성 발생시키고, Gateway resync로 DB/UI fault를 확인한다. 현재는 ESP32 정상 reset 뒤 Health Current가 정상화되는 것까지만 검증한다. Gateway 내부 표준 Health Fault Clear 송신 경로가 없어 callback 실기는 `not_executed`이며 전체 통과로 표시하지 않는다.
7. **active command 복구**: **밝기 적용 중**에 같은 브라우저 탭을 reload하고 동일 command ID polling과 잠금이 복구되는지 확인한다. 새 탭이나 브라우저 재실행은 현재 `sessionStorage` 계약 범위가 아니다.
8. **재시작 복구**: Pi와 ESP32를 재부팅한 뒤 같은 fixture ID, unicast address와 group version으로 재-provision 없이 상태 조회와 제어가 되는지 확인한다.

각 단계 전에 브라우저 DevTools Network의 **Preserve log**를 켜고, Pi Gateway log와 두 ESP32 serial log를 동시에 수집한다. claim code, session cookie, 인증서 private key가 HAR나 로그에 들어가면 해당 증거를 폐기하고 secret을 rotation한 뒤 다시 시험한다.

### 9.3 Health fault 수동 주입 경계

firmware의 panic/watchdog reset fault `0x01` 기록, Gateway의 Health Fault Get과 API snapshot 저장은 구현돼 있다. 웹에는 fault 발생·해제 버튼이 없으므로 실험실에서는 `production-device-lab.md`의 Gate 6만 사용한다. 현재 fault 해제는 ESP32 정상 reset과 다음 Health Current로 확인하며 임시 firmware, 임의 MQTT publish 또는 DB 수정을 사용하지 않는다.

GDB panic 주입 또는 다음 Health Current 중 하나라도 확인되지 않으면 `failed`다. Gateway 내부 표준 Health Fault Clear 송신 경로와 ESP32 clear callback은 아직 실기할 수 없으므로 `not_executed`로 남긴다. 이 시험은 현재 구현된 panic/watchdog 경로만 검증하며 실제 LED driver의 모든 field fault sensor를 검증한 것으로 확대 해석하지 않는다.

### 9.4 실행 후 최소 증거

- Git SHA, Gateway image tag, ESP32 firmware build log
- ESP32 UUID와 검색 API/HAR, 하드웨어 OFF 검색 0개 화면
- batch request/response와 node별 provisioning terminal matrix
- DB와 Gateway의 floor/zone group address/version/readiness
- group command create/terminal response, fixture별 status와 ESP32 publication log
- Health fault/clear 시점의 GDB, ESP32, Gateway, DB와 모니터링 증거
- 같은 탭 reload 전후 동일 command ID polling과 제어 잠금 화면
- 미실행 또는 차단 항목을 그대로 표시한 최종 판정표

### 9.5 스케줄·차량 이벤트 단일 노드 HIL

스케줄은 현재 시각을 포함하는 짧은 규칙을 Web에서 만들고 `GatewayAutomationConfiguration.desiredRevision = appliedRevision`, Gateway snapshot의 같은 revision, `schedule_started/action_result/schedule_ended/action_result`, 시작 밝기와 종료 복귀 밝기를 모두 확인한다. 차량 이벤트는 capability가 `supported`이고 Sensor Server/vendor model binding이 모두 true인 fixture만 source로 사용한다. High 동안 이벤트 밝기를 유지하고 Low 뒤 규칙의 hold가 지난 다음 직전 base 밝기로 복귀해야 한다.

2026-09-04 단일 노드 시험은 schedule `70% -> 35% -> 70%`, 차량 이벤트 `70% -> 85% -> 70%`(5초), 수정 규칙 `70% -> 80% -> 70%`(6초)를 통과했다. 실제 센서가 없는 자동 시험에서는 ESP32-H2 GPIO4의 외부 전압을 인가하지 않고 JTAG로 내부 pull만 바꿨다. 이 방식은 firmware·BLE Mesh·Gateway·API·Web 논리 경로 검증용이며 실제 센서 출력 전압, rise/fall time, 공통 GND와 converter 절연 검증을 대체하지 않는다. 다른 SoC·GPIO·ELF에 raw register 값을 재사용하지 말고 exact build의 GPIO 설정과 칩을 먼저 검증한다.

완료 뒤 생성한 schedule/event rule을 Web에서 비활성화·삭제하고 empty snapshot까지 `APPLIED`인지 확인한다. Gateway의 `automation-config-acks.json`과 `automation-telemetry.json`은 records가 비어야 하며 fixture는 시험 전 base 밝기로 돌아와야 한다.

## 10. 부정 시험

- 잘못된 station 인증서로 제조 endpoint 호출: TLS 단계에서 거부돼야 한다.
- `PKI_ENV=production pnpm lab:pki:bootstrap`: 파일 생성 전에 거부돼야 한다.
- 이미 사용한 claim code 재사용: `already claimed`로 실패해야 한다.
- 다른 serial의 제조 인증서를 사용한 bootstrap: 거부돼야 한다.
- MQTT client 인증서 없이 `8883` 접속: TLS handshake가 실패해야 한다.
- ESP32-H2 전원 OFF 상태 검색: 가짜 fixture 없이 `0개`가 보여야 한다.
- station 폐기 후 API 재시작: 폐기된 station mTLS 연결이 실패해야 한다.

station 폐기 시험은 다음 명령을 사용한다. 폐기 후 다시 발급하면 새 key와 인증서가 생성된다.

```bash
PKI_ENV=lab scripts/pki/issue-lab-manufacturing-station.sh revoke
PKI_ENV=lab scripts/pki/issue-lab-manufacturing-station.sh issue
```

## 11. 중지, 재시작과 reset 경계

Vault 데이터와 key를 보존한 채 컨테이너만 중지한다.

```bash
PKI_ENV=lab pnpm lab:vault stop
PKI_ENV=lab pnpm lab:vault start
```

다음 reset은 **Lab Vault container와 `.local/lab-vault`만 제거**한다. Root, service 인증서, 제조 station과 Pi identity는 제거하지 않으므로 전체 초기화가 아니다.

```bash
PKI_ENV=lab pnpm lab:vault reset --confirm-lab-destroy
```

Vault를 reset한 뒤 기존 `.local/lab-pki`와 Pi 인증서를 섞으면 issuer가 달라져 실패한다. 완전한 재시험은 서버를 중지하고 Lab 전용 `.local/lab-pki`, 제조 label, Pi의 `/opt/led-control/gateway/data`를 각각 명시적으로 백업 또는 폐기한 뒤 새 serial로 처음부터 수행한다. PostgreSQL volume 삭제는 사용자와 현장 데이터까지 지우므로 이 문서의 자동 reset 범위에 포함하지 않는다.

## 12. 자주 발생하는 오류

| 증상 | 원인 확인 | 조치 |
| --- | --- | --- |
| Vault container가 `Created`에서 멈춤 | `docker info`, Docker Desktop 로그 | Docker Desktop 엔진 재시작 후 Vault smoke test |
| `api.led.lan`을 찾지 못함 | Mac/Pi `/etc/hosts`, 현재 LAN IP | 두 호스트의 DNS 매핑을 같은 IP로 수정 |
| API 인증서 hostname 오류 | `openssl x509 -in ... -text`의 SAN | 현재 `LAB_HOST_IP`로 Lab PKI 재생성 여부 판단 |
| 장소 이동 뒤 API/Gateway MQTT가 동시에 offline | 실행 중 API의 `MQTT_URL`, Pi의 `getent hosts`, 인증서 SAN이 이전 IP를 가리킴 | 현재 LAN IP로 `lab:pki:bootstrap`을 재실행하고 새 `lab.env`를 source한 뒤 Pi DNS 매핑과 두 process를 재시작한다. DB ID·claim·장비 인증서는 유지한다. |
| `pnpm dev`가 8883 handshake 실패 | 기존 개발용 mqtt container가 8883 점유 | `docker compose stop mqtt-tls`, Lab env를 source 후 재실행 |
| 제조 endpoint가 401/TLS 실패 | station key 권한, CA/CRL, API 재시작 | `600` 권한과 `lab.env` 적용 여부 확인 |
| claim 후 Pi가 `unclaimed` 반복 | serial 불일치 또는 claim 미완료 | label, 웹 입력, Pi `GATEWAY_SERIAL`을 비교 |
| Gateway가 `owned_bluetooth_company_id_required`로 종료 | 자사 Bluetooth SIG Company Identifier 누락 또는 금지값 | 자사 할당값을 Gateway와 ESP32-H2에 동일하게 배포한 뒤 재시작 |
| 조명 검색 0개 | ESP32 provisioned 상태, HCI block, mesh daemon | ESP32 serial log, `rfkill`, Pi gateway/BlueZ 로그 확인 |

자동 검증은 다음 명령으로 반복한다.

```bash
pnpm test:lab:vault:integration
pnpm test:lab:pki
pnpm test:lan-tls
pnpm --filter @led-control/api typecheck
```

`test:lab:vault:integration`과 `api:vault-token:integration`은 실제 Docker Vault가 응답할 때만 수행하는 opt-in 검증이다. Docker daemon이 정상화된 뒤 다음도 실행한다.

```bash
LAB_API_IP="$LAB_HOST_IP" LAB_MQTT_IP="$LAB_HOST_IP" pnpm test:lab:pki:integration
set -a
. .local/lab-pki/lab.env
set +a
pnpm api:vault-token:integration
```
