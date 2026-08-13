# Lab Vault 기반 최초 실장비 설치 시험

> 현재 판정: 자동화 코드와 로컬 인증 계약 시험은 완료됐지만 Raspberry Pi와 ESP32-H2를 포함한 실기 E2E 증거는 아직 없다. 아래 절차를 모두 통과하기 전에는 양산 준비 완료로 판정하지 않는다.

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
BOOTSTRAP_OPERATOR_EMAIL='operator@example.com' \
BOOTSTRAP_OPERATOR_NAME='운영자' \
BOOTSTRAP_OPERATOR_PASSWORD='교체할-긴-시험용-비밀번호' \
pnpm --filter @led-control/api auth:bootstrap-operator
```

생성된 환경을 현재 shell에 export한 뒤 개발 서버를 실행한다.

```bash
set -a
. .local/lab-pki/lab.env
set +a
pnpm dev
```

정상 상태는 API `4000`, Web `5173`, MQTT TLS `8883`이 열리고 API가 Vault token file을 읽어 시작하는 것이다. 다른 터미널에서 확인한다.

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

pnpm gateway:manufacturing:enroll -- \
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

## 7. 웹에서 현장 생성과 일회성 claim

1. `http://localhost:5173`에서 operator 계정으로 로그인한다.
2. 초기 설정에서 고객사와 현장을 만들고 층 이름, 층 번호 등 기본 정보를 입력한다.
3. `게이트웨이 등록`에서 이름과 `GW-RPI-000001`을 입력한다.
4. label JSON의 `claimCode`를 비밀번호 입력란에 한 번만 입력한다.
5. 성공 응답의 `gatewayId`를 기록한다. Gateway는 현장에 귀속되며, 이후 조명 검색 세션에서 대상 층과 Gateway를 각각 선택한다.

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

정상 판정은 assignment에 웹 claim의 `gatewayId`와 `siteId`가 기록되고, MQTT heartbeat가 API DB의 gateway `lastSeenAt`을 갱신하며, 컨테이너 health가 `healthy`가 되는 것이다. BlueZ Mesh가 아직 준비되지 않았다면 `starting` 또는 `unhealthy` 원인을 로그에서 먼저 해결한다.

## 9. ESP32-H2 검색, 등록과 제어

ESP-IDF 5.5 펌웨어를 빌드하고 연결된 보드에 기록한다.

```bash
scripts/esp32-h2-build.sh
ls /dev/cu.usbmodem*
scripts/esp32-h2-flash.sh /dev/cu.usbmodemXXXX
```

1. ESP32-H2를 unprovisioned 상태로 켠다. 이미 provisioned된 보드는 검색되지 않는다.
2. 웹 모니터링의 조명 검색을 시작하고 실제 UUID와 RSSI가 나타나는지 확인한다. 하드웨어가 꺼져 있으면 결과 `0개`가 정상이다.
3. 조명 이름, 정격 전력과 대략적인 도면 위치를 입력해 등록한다.
4. Pi 로그에서 provisioning 완료, AppKey, Generic OnOff `0x1000`, Light Lightness `0x1300` bind와 status publication을 확인한다.
5. 제어 메뉴에서 `0% -> 25% -> 50% -> 100%`를 적용한다.
6. 웹 성공은 MQTT 접수 ACK가 아니라 ESP32-H2의 Light Lightness Status가 API까지 돌아온 뒤에만 판정한다.
7. Pi와 ESP32를 재부팅한 뒤 같은 fixture ID와 unicast address로 재-provision 없이 상태 조회와 제어가 되는지 확인한다.

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
| `pnpm dev`가 8883 handshake 실패 | 기존 개발용 mqtt container가 8883 점유 | `docker compose stop mqtt-tls`, Lab env를 source 후 재실행 |
| 제조 endpoint가 401/TLS 실패 | station key 권한, CA/CRL, API 재시작 | `600` 권한과 `lab.env` 적용 여부 확인 |
| claim 후 Pi가 `unclaimed` 반복 | serial 불일치 또는 claim 미완료 | label, 웹 입력, Pi `GATEWAY_SERIAL`을 비교 |
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
