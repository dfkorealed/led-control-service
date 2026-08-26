# Raspberry Pi 게이트웨이 Appliance 운영 절차

> 현재 상태: **코드 완료·실기 미검증**. 실물 Pi/ESP32와 offline Root/Vault backup 승인 증거는 확인하지 않았다.

## 1. 적용 범위

이 문서는 Raspberry Pi 4/CM5에서 Docker 기반 게이트웨이를 설치하고 ESP32-H2 조명을 검색·등록·제어하는 절차다. Pi에는 전체 모노레포를 복사하지 않는다. 다음 파일만 배포한다.

- ARM64 gateway image tar와 SHA-256 파일
- `compose.yml`
- `.env.appliance`
- 장비별 mTLS 인증서
- 영속 데이터 디렉터리

컨테이너는 private system D-Bus, BlueZ 5.82 `bluetooth-meshd`, Node.js 22 gateway를 순서대로 실행한다. `/var/lib/bluetooth/mesh`의 BlueZ network DB와 `/var/lib/led-control`의 token·주소 mapping·명령 상태는 재부팅 후에도 유지한다.

## 2. 현재 검증 상태

2026-07-13 Raspberry Pi `dfkorea.local`에서 다음 항목을 확인했다.

- Debian ARM64, Docker 26.1.5, Compose 2.26.1
- Bluetooth controller `98:FE:54:21:26:24`, `Powered: yes`, rfkill 해제
- ARM64 image build 및 BlueZ 5.82 `bluetooth-meshd` 실행
- private D-Bus의 `org.bluez.mesh` 등록
- 실제 HCI 0을 이용한 provisioner network 생성
- 64비트 mesh token 무손실 저장과 `Attach`
- 동일 volume으로 컨테이너 재시작 후 기존 node DB 재사용

아직 완료로 판정하지 않는 실기 항목은 ESP32-H2 beacon 검색, provisioning, model bind, 0/25/50/100% 왕복, 2-node 3회 반복, 72시간 soak, 주차장 RF walk다.

## 3. Pi 최초 준비

Pi에 SSH 접속한 뒤 호스트 준비 스크립트를 실행한다.

```bash
scp scripts/gateway-host-prepare.sh dfkorea@dfkorea.local:/tmp/
ssh dfkorea@dfkorea.local
sudo /tmp/gateway-host-prepare.sh
sudo reboot
```

재접속 후 확인한다.

```bash
docker version
docker compose version
rfkill list bluetooth
bluetoothctl show
```

`Soft blocked: no`, `Hard blocked: no`, `Powered: yes`가 모두 필요하다.

## 4. ARM64 이미지 생성

Docker Buildx가 있는 개발 PC에서 실행한다. 기본값은 dirty working tree를 거부한다.

```bash
cd "/Users/kim-jh/Documents/led-control-service"
pnpm gateway:appliance:build
```

결과는 `dist/gateway-appliance`에 생성된다.

```text
led-control-gateway-<git revision>-linux-arm64.tar
led-control-gateway-<git revision>-linux-arm64.tar.sha256
led-control-gateway-<git revision>-linux-arm64.tar.env
```

임시 개발 검증만 dirty build를 허용한다.

```bash
ALLOW_DIRTY_BUILD=1 pnpm gateway:appliance:build
```

## 5. 제조 identity와 인증서 준비

양산 장비에는 `siteId`나 DB `gatewayId`를 미리 넣지 않는다. 장비에는 제조 시 다음 값만 주입한다.

- 고유 `GATEWAY_SERIAL`
- bootstrap device certificate와 private key
- bootstrap API CA

웹 claim 후 API가 assignment를 반환하면 gateway가 이를 `/var/lib/led-control/assignment.json`에 저장하고 MQTT key·CSR·인증서를 자동 발급한다. 장비 private key는 Pi의 Docker volume 안에서만 생성되며 제조 PC로 전송하지 않는다.

먼저 `gateway-appliance-deploy.sh`를 한 번 실행한다. image는 Pi에 load되고 제조 identity가 없다는 메시지와 exit code 2로 멈추는 것이 정상이다. 제조 PC에는 API가 신뢰하는 station mTLS 인증서·key·CA가 있어야 한다.

```bash
set -a
. dist/gateway-appliance/led-control-gateway-<revision>-linux-arm64.tar.env
set +a
export GATEWAY_IMAGE="$GATEWAY_IMAGE_REPOSITORY:$GATEWAY_IMAGE_TAG"
export MANUFACTURING_API_URL='https://<API DNS 또는 IP>:4000'
export STATION_CERT="$PWD/.local/manufacturing/station.crt"
export STATION_KEY="$PWD/.local/manufacturing/station.key"
export STATION_CA="$PWD/.local/manufacturing/api-ca.crt"

pnpm gateway:manufacturing:enroll -- \
  --target dfkorea@dfkorea.local \
  --serial GW-RPI-000001 \
  --label-output "$PWD/.local/manufacturing/GW-RPI-000001.json"
```

label JSON은 `0600`이며 web claim에 사용할 일회성 code를 포함한다. 같은 serial과 정상 label로 재실행하면 API를 다시 호출하지 않는다. token은 pipe로만 전달되고 device private key는 `data/identity/device`에 generation 단위로 원자 설치된다.

## 6. Pi 설정 파일

Pi에서 템플릿을 복사한다.

```bash
cd /opt/led-control/gateway
cp .env.appliance.example .env.appliance
nano .env.appliance
```

필수 값의 예시는 다음과 같다.

```env
GATEWAY_DATA_DIR=/opt/led-control/gateway/data
MQTT_URL=mqtts://<클라우드 또는 개발 PC IP>:8883
GATEWAY_SERIAL=GW-RPI-000001
GATEWAY_FIRMWARE_VERSION=gateway-appliance-<revision>
GATEWAY_ADAPTER=bluez
GATEWAY_HEARTBEAT_MS=5000
GATEWAY_BLE_STATUS_TIMEOUT_MS=8000
GATEWAY_BLE_SCAN_SECONDS=10
GATEWAY_BOOTSTRAP_URL=https://<API IP>:4000/gateway-bootstrap
```

`GATEWAY_SERIAL`은 Pi가 자동으로 만드는 값이 아니라 제조 원장과 일치하는 장비 고유값이다. 로컬 개발 장비는 충돌하지 않는 `GW-RPI-...` 값을 정해 API 제조 장비 등록에도 같은 값을 사용한다.

## 7. 자동 배포

설정과 인증서를 먼저 Pi에 준비한 뒤 개발 PC에서 실행한다.

```bash
scripts/gateway-appliance-deploy.sh \
  dfkorea@dfkorea.local \
  dist/gateway-appliance/led-control-gateway-<revision>-linux-arm64.tar
```

스크립트는 checksum 검증, `docker image load`, Compose 적용, health 대기를 수행한다. `.env.appliance` 또는 인증서가 없으면 image를 실행하지 않고 누락 파일을 출력한다.

## 8. Pi에서 직접 실행

이미 image가 로드된 경우 다음 명령을 사용한다.

```bash
cd /opt/led-control/gateway
set -a
. ./*.tar.env
set +a
docker compose --env-file .env.appliance -f compose.yml up -d --remove-orphans
docker compose -f compose.yml ps
docker compose -f compose.yml logs -f gateway-appliance
```

상태 파일은 컨테이너의 `/var/run/led-control/health.json`에 있다.

```bash
docker exec led-control-gateway cat /var/run/led-control/health.json
docker inspect --format '{{json .State.Health}}' led-control-gateway
```

claim 전에는 `starting-unassigned`가 정상이다. claim 후 `healthy`는 선언값이 아니라 다음 실제 probe가 모두 통과하고 마지막 heartbeat publish가 `max(30초, GATEWAY_HEARTBEAT_MS x 3)` 이내일 때만 기록된다.

- private D-Bus의 `org.bluez.mesh` owner
- cached node path가 아니라 해당 path의 D-Bus `org.bluez.mesh.Node1` interface introspection
- `/sys/class/bluetooth/hci0/flags`의 powered bit
- 영속 mesh address mapping JSON parse
- MQTT QoS 1 heartbeat publish 완료 시각

MQTT 인증서 rotation은 pending generation broker probe 뒤 기존 stable-client-ID connection을 `end(true)`로 quiesce하고, candidate가 broker에 연결되기 전에 identity pointer를 commit하고 runtime current client로 지정한다. CONNACK 전 연결 실패만 disk rollback과 old client reconnect를 허용한다. CONNACK 뒤에는 candidate가 authoritative하며, subscription 실패는 old session으로 되돌리지 않고 candidate를 fail-closed 해 ACK된 non-idempotent command를 replay하지 않는다. 네 command handler는 메시지를 받은 source client로 ACK/provisioning 결과를 발행한다. `current` pointer write/fsync와 previous pointer 복구가 함께 실패하면 candidate generation을 보존하고 MQTT runtime을 fail-closed 해 dangling pointer를 만들지 않는다. heartbeat 시각이 미래이거나 `GATEWAY_HEARTBEAT_MS`가 양의 유한 정수가 아니면 healthcheck는 fail-closed 한다.

## 9. ESP32-H2 펌웨어 적용

Mac에 ESP-IDF 5.5 환경과 보드를 연결한다.

```bash
cd "/Users/kim-jh/Documents/led-control-service"
scripts/esp32-h2-build.sh
scripts/esp32-h2-flash.sh auto
```

포트를 직접 지정할 수도 있다.

```bash
scripts/esp32-h2-flash.sh /dev/cu.usbmodemXXXX
```

검색되지 않으면 보드가 이미 provisioned됐는지 먼저 확인한다. 시험 초기화는 mesh credential을 모두 지우므로 해당 장비를 DB와 gateway mapping에서도 제거한 뒤 수행한다.

```bash
cd apps/esp32-h2-firmware
idf.py -p /dev/cu.usbmodemXXXX erase-flash flash monitor
```

## 10. 웹에서 현장·층·조명 등록

1. 제조 등록 script가 만든 label JSON에서 제품 serial과 일회성 claim code를 확인한다. DB를 수동 수정하지 않는다.
2. 웹에서 현장과 층을 만든 뒤 `게이트웨이 등록` 화면에 label의 제품 serial과 일회성 코드를 입력해 claim한다. 초기 현장 API는 Gateway를 직접 만들지 않는다.
3. 층을 만들고 해당 gateway를 층에 연결한다.
4. ESP32-H2를 unprovisioned 상태로 켠다.
5. 조명 검색을 시작하고 UUID/RSSI가 나타나는지 확인한다.
6. 조명 이름, 도면 좌표, 정격 전력을 입력해 등록한다.
7. gateway 로그에서 `AddNodeComplete`, AppKey, `0x1000`, `0x1300` bind와 publication status를 확인한다.
8. 제어 메뉴에서 0%, 25%, 50%, 100%를 순서대로 적용한다.
9. 웹 성공 표시는 MQTT 접수 ACK가 아니라 ESP32의 Light Lightness Status 수신 뒤에만 확인한다.

표준 BLE Mesh는 provisioning 전 임의의 노드에 Generic OnOff/Lightness 명령을 보낼 수 없다. 따라서 현재 등록 전 `식별 점멸`은 명시적인 미지원 오류를 반환한다. 이 UX를 유지하려면 펌웨어와 gateway에 별도 vendor provisioning identify protocol을 추가해야 한다.

## 11. 재시작과 복구 시험

조명 등록 후 다음 순서로 시험한다.

```bash
cd /opt/led-control/gateway
docker compose -f compose.yml restart gateway-appliance
sudo reboot
```

재부팅 후 같은 fixture ID와 unicast address로 재-provision 없이 제어돼야 한다. 아래 디렉터리는 함께 백업한다.

```bash
sudo tar -C /opt/led-control/gateway -czf gateway-data-backup.tgz data/gateway data/mesh
```

`data/gateway`와 `data/mesh` 중 하나만 복원하면 token과 BlueZ DB가 불일치할 수 있으므로 항상 같은 시점의 묶음으로 복원한다.

## 12. 장애 진단

```bash
bluetoothctl show
rfkill list bluetooth
docker compose -f /opt/led-control/gateway/compose.yml ps
docker logs --tail=200 led-control-gateway
docker exec led-control-gateway dbus-send --system --print-reply \
  --dest=org.freedesktop.DBus /org/freedesktop/DBus \
  org.freedesktop.DBus.NameHasOwner string:org.bluez.mesh
```

- 검색 0건: ESP32 전원, unprovisioned 상태, gateway scan 로그, 주파수 간섭을 확인한다.
- `MESH_MAPPING_NOT_FOUND`: API의 fixture ID와 gateway mapping 파일이 불일치한다.
- `STATUS_TIMEOUT`: 전송 성공이 아니라 ESP32 Status 미수신이다. 거리, relay, 모델 bind를 확인한다.
- `mqtt_disconnected`: URL, CA, client certificate, broker ACL, Pi 시간을 확인한다.
- `dbus_owner_missing`, `bluez_not_attached`, `hci_not_powered`, `mapping_invalid`, `heartbeat_stale`: `health.json`의 probe 필드를 먼저 확인한다. `hci_not_powered`이면 `bluetoothctl show`와 `rfkill list bluetooth`를 확인하고, mapping 오류면 파일을 수동 편집하지 말고 backup 복원 또는 명시적 재-provision 절차를 따른다.
- `state_outbox_capacity`: 미ACK 상태 이벤트가 `100,000건` 또는 `100MiB` 한도에 도달했다. MQTT/API를 먼저 복구해 application ACK drain을 완료한다. 공간이 회복되면 Gateway가 Mesh publication listener를 다시 열고 강제 상태 resync를 수행하므로 outbox 파일을 삭제하지 않는다.
- `state_outbox_missing`, `state_outbox_corrupt`, `state_outbox_permissions`: 조명 제어와 provisioning을 계속하지 않는다. `/var/lib/led-control/state-event-outbox.json`과 `.manifest.json`을 같은 시점의 `data/gateway` 백업에서 함께 복원하고, 상위 디렉터리 `0700`, 두 파일 `0600`, 소유자 `gateway`를 확인한 뒤 재시작한다.
- token/mesh DB 손상: 임의 재생성하지 말고 같은 시점 백업을 복원하거나 현장 전체를 명시적으로 재-provision한다.

outbox 백업이 없어 복원이 불가능하면 담당 운영자의 데이터 유실 승인과 장애 기록이 필요하다. 컨테이너를 중지하고 현재 파일을 별도 보관한 뒤 **두 파일을 함께** 제거해야만 새 first-run으로 초기화할 수 있다. 이 절차는 미ACK 이벤트를 복구하지 못하며 API 통계에는 마지막 정상 상태 이후 구간이 unknown으로 남는다. 재시작 후 강제 resync 결과와 현장 조명 상태를 대조하기 전에는 제어·등록을 재개하지 않는다.

```bash
cd /opt/led-control/gateway
docker compose -f compose.yml stop gateway-appliance
sudo tar --ignore-failed-read -C /opt/led-control/data/gateway \
  -czf "state-outbox-incident-$(date +%Y%m%d%H%M%S).tgz" \
  state-event-outbox.json state-event-outbox.json.manifest.json
sudo rm -f /opt/led-control/data/gateway/state-event-outbox.json \
  /opt/led-control/data/gateway/state-event-outbox.json.manifest.json
sudo chmod 0700 /opt/led-control/data/gateway
docker compose --env-file .env.appliance -f compose.yml up -d gateway-appliance
```

## 13. 양산 판정 관문

다음 항목 전부를 증거 로그와 함께 통과하기 전에는 양산 준비 완료로 판정하지 않는다.

- ESP32-H2 2대 검색·등록·개별/그룹 제어 3회 연속 성공
- 한 노드 전원 차단 시 부분 실패와 나머지 노드 성공 확인
- MQTT 단절·재연결과 QoS 1 중복 명령 idempotency 확인
- Pi/container/ESP32 재부팅 복구 확인
- 72시간 soak 동안 메모리 증가, D-Bus 단절, sequence 역전 없음
- 실제 주차장 층별 RF walk와 음영 지역 기록
