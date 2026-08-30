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

## Automation snapshot hot reload와 offline 실행

Gateway는 `sites/{siteId}/gateways/{gatewayId}/commands/automation/config-sync`의 `AutomationSnapshotV1` full snapshot을 MQTT QoS 1로 구독한다. 수신 snapshot은 schema, Site/Gateway scope, canonical SHA-256, revision 순서를 검증하며 다음 규칙을 적용한다.

- 높은 revision은 단일 automation queue에서 검증한 뒤 `/var/lib/led-control/automation-snapshot.json`에 temp write, file fsync, rename, parent directory fsync 순으로 저장한다. rename 뒤 parent fsync가 실패하면 target을 exact read-back하고 parent fsync를 다시 통과해야 commit으로 취급한다. 재시도도 실패하면 이전 visible snapshot을 복구하고 `snapshot_commit_uncertain`으로 분류해 rejected ACK와 inbound PUBACK을 만들지 않는다. 이후 broker redelivery 또는 restart는 이전 durable revision을 유지하거나 같은 revision/hash를 다시 적용하는 두 일관된 상태 중 하나로 수렴한다. 저장 뒤 desired state 재계산 또는 적용이 실패하면 active 파일과 메모리를 모두 직전 snapshot으로 원자 복구하므로 재시작해도 rejected revision이 활성화되지 않는다.
- 같은 revision/hash는 파일 저장과 재계산을 반복하지 않고 idempotent `applied` ACK를 만든다. 낮은 revision과 같은 revision의 다른 유효 hash는 기존 snapshot을 유지하고 각각 `snapshot_old_revision`, `snapshot_revision_conflict`로 거부한다.
- 재시작 시 원자 교체가 끝난 마지막 snapshot만 복구하고 남은 temp 파일은 제거한다. snapshot이 없으면 자동제어 snapshot 없이 시작하며 손상되거나 scope/hash가 맞지 않는 파일은 fail-closed한다.
- `applied|rejected` ACK는 exact revision/hash와 함께 `/var/lib/led-control/automation-config-acks.json`에 먼저 저장한다. MQTT.js의 QoS 1 `handleMessage` backpressure 경계가 hot reload와 ACK outbox fsync 완료까지 broker PUBACK을 보류한다. MQTT ACK publish/PUBACK 실패 시 같은 payload를 지수 backoff로 재시도하고 reconnect나 process 재시작 뒤에도 재발행하며, reconnect는 이전 generation publish가 아직 끝나지 않았어도 새 generation drain을 즉시 시작한다. ACK drain startup은 health, provisioning, state, mesh resync startup과 독립되어 한 경로의 실패가 다른 경로를 막지 않는다.
- hot reload는 Gateway process, MQTT client, heartbeat, BLE Mesh adapter를 재시작하지 않는다.

경로는 `GATEWAY_AUTOMATION_CONFIG_PATH`, `GATEWAY_AUTOMATION_ACK_OUTBOX_PATH`, `GATEWAY_AUTOMATION_TELEMETRY_OUTBOX_PATH`로 변경할 수 있다. Task 12~13 production runtime은 Task 11의 `recompute/applyDesiredState` activation 경계에 offline scheduler, 차량 이벤트 상태와 priority arbiter를 연결한다.

- 반복 일정은 `@led-control/automation-engine`의 wall-clock recurrence를 사용한다. 활성 수동 override, 활성 차량 이벤트 중 최대 밝기, schedule, 마지막 실제 관측값 또는 source 시작 전 base 순으로 fixture별 desired brightness를 계산한다.
- `/var/lib/led-control/automation-state.json` schema v4에는 활성 source와 pre-state, `pending|terminal` fixture transition, 실제 관측 또는 성공 terminal로 확인된 마지막 desired를 저장한다. Lifecycle 또는 terminal transition을 만드는 같은 atomic mutation에 stable `handoffId`, exact telemetry records와 canonical `recordsHash`를 `pendingTelemetryHandoffs`로 먼저 넣는다. Outbox가 handoff를 원자·멱등 수락한 뒤에만 state에서 exact handoff를 지우므로 state commit, outbox commit, state clear 각 경계의 process 종료를 재생할 수 있다. `telemetryGap`도 stable handoff identity와 `fixture_state_outbox` provenance를 보존한다. V1~V3은 v4로 migration하며 restart pending과 unverified desired는 local Mesh lighting observation 전까지 RF를 보류한다.
- 차량 입력은 `detected|cleared|current-state`를 한 상태 전이로 정규화한다. 규칙별 source set은 OR로 계산하고 하나라도 High이면 software timeout 없이 유지한다. 마지막 source Low에서만 현재 process monotonic hold를 시작하며 재감지는 deadline을 취소한다. 재시작 뒤 persisted UTC expiry는 system clock이 trusted일 때만 새 monotonic deadline으로 변환한다. 겹치는 active event는 fixture별 최대 밝기를 사용하고 마지막 event 종료 시 현재 schedule 또는 최초 event 직전 base로 복귀한다.
- 새 output은 단일 fixture unicast 또는 동시성 8의 제한된 parallel unicast를 기존 BLE Mesh executor로 실행한다. RF 뒤 telemetry handoff 실패는 state의 exact pending handoff 또는 preallocated gap journal에 남고 로컬 결과를 되돌리거나 다음 scheduler startup을 막지 않는다. Process-local vehicle/manual monotonic deadline은 automation state commit 성공 뒤에만 교체하며 definite write failure와 commit-uncertain rollback 모두 이전 deadline을 유지한다.
- `/var/lib/led-control/automation-telemetry.json`의 `appendBatch`는 한 handoff의 모든 event identity/sequence/payload/hash와 acceptance receipt를 단 한 번의 atomic rewrite로 저장하거나 전체 record set을 drop으로 반환한다. Prefix commit은 없으며 grouped `action_result` 하나의 fixture result 수를 dropped payload 수로 계산하지 않는다. Pretty JSON metadata를 포함한 regular outbox 파일은 64 MiB를 넘지 않고, 미게시 `event_extended`는 active event별 최신 record로 교체한다.
- Startup은 `${GATEWAY_AUTOMATION_TELEMETRY_OUTBOX_PATH}.gap`을 두 개의 4 KiB checksum block으로 실제 preallocate한다. Capacity 또는 regular outbox `ENOSPC` 때 alternate block을 fixed-size positional write와 file `fsync`로 갱신해 추가 block allocation 없이 `firstDroppedAt|lastDroppedAt|droppedCount`와 마지막 source handoff identity를 보존한다. `${...}.reserve`는 최대 regular outbox 크기의 atomic-rewrite headroom이며 rewrite 동안 durable하게 해제한 뒤 다시 preallocate한다. Sidecar를 제외한 regular outbox 자체의 strict cap은 metadata 포함 64 MiB다.
- Regular outbox 또는 reserve 초기화가 `ENOSPC`이거나 outbox JSON이 손상되면 `automation_telemetry_unavailable` degraded health를 노출하되 scheduler, manual intake와 local RF startup은 계속한다. Gap journal이 durable acceptance source가 되고, regular storage가 복구되면 stable journal handoff를 outbox에 idempotent하게 옮긴 뒤 exact journal snapshot만 clear한다. Task 12 state gap도 stable handoff/provenance로 같은 protocol을 사용해 clear 전 crash가 count를 중복 합산하지 않는다.
- `schedule_started|schedule_ended|vehicle_detected|event_started|event_extended|event_ended|action_result|telemetry_gap`은 `sites/{siteId}/gateways/{gatewayId}/events/automation/execution`에 exact JSON, MQTT QoS 1로 발행한다. Broker PUBACK으로 삭제하지 않으며 `acks/automation/execution-ingested`의 gateway/eventId/sequence/canonical payload hash가 모두 일치할 때만 제거한다. Hash conflict는 원본을 보존하고 reconnect/retry가 같은 immutable payload를 다시 발행한다. 종료 시 scheduler terminal handoff를 마친 뒤 telemetry publisher의 in-flight QoS 1 publish와 outbox queue를 drain하고 MQTT client를 닫는다.
- schedule occurrence와 override/event 종료 시 저장한 pre-state를 기준으로 다시 arbitrate해 현재 더 높은 source를 덮지 않는다. 성공한 manual-only override만 마지막 수동 밝기를 새 base로 사용한다. 이미 활성인 schedule/event 위에서 manual이 성공해도 해당 automatic source의 기존 pre-state를 바꾸지 않으므로 manual 만료 뒤 automatic source로, 그 source 종료 뒤 원래 pre-state로 복귀한다.
- system clock은 `/run/systemd/timesync/synchronized` marker와 5분 이상 역행 여부로 신뢰한다. Compose는 marker가 cold boot 뒤 생성될 수 있도록 `/run/systemd/timesync` 디렉터리를 read-only mount한다. Rollback 순간 marker mtime을 recovery fence로 잡아 최소 한 번 untrusted를 보장하고 이후 marker 갱신만 trust를 회복한다. Trusted manual은 수신 시점의 absolute `overrideUntil - now`만 monotonic deadline으로 변환한다. Untrusted manual은 원래 최대 30일 duration을 다시 시작하지 않고 MQTT command delivery 상한과 같은 최대 10초 fail-safe monotonic window만 허용한다.
- timed manual command는 acceptance와 실행 직전 expiry 검사를 통과한 뒤 override를 먼저 durable 저장하고 RF를 실행한다. Startup은 snapshot runtime을 활성화한 뒤 command journal handoff를 재생한다. Accepted timed record와 `automationHandoff=pending` record는 완료 전까지 24시간 TTL 및 일반 `maxRecords` eviction에서 보호하며 별도 10,000건 pending 상한이 가득 차면 `COMMAND_AUTOMATION_HANDOFF_CAPACITY`로 새 intake를 fail-closed한다. Prepare-before-RF restart는 indeterminate terminal로 닫고 completed-before-handoff restart는 RF 없이 handoff를 재생한다.
- Automation은 Health Current 완료 상태와 분리된 OnOff/Lightness observation callback으로 recovery fence를 해제하므로 Health timeout이 밝기 복구를 막지 않는다. Full Mesh resync는 concurrency 4 background worker에서 fixture 실패를 격리하며 MQTT, heartbeat, ACK와 manual control을 먼저 시작한다. `mesh_resync_pending|mesh_resync_failed`가 readiness를 나타내고 shutdown은 in-flight worker를 drain한다.
- API command publisher는 stored `overrideUntil`이 지난 outbox를 `MANUAL_OVERRIDE_EXPIRED`로 terminal 처리해 발행/재발행하지 않는다. Command `expiresAt`과 MQTT message expiry는 absolute `overrideUntil`을 넘지 않는다. Gateway command-expiry 검사는 trusted clock에서만 absolute 시각을 사용하며, untrusted 동안에는 broker retention 상한과 위 10초 monotonic fail-safe에 의존한다.
- 종료 시 `stopAndDrain()`이 새 automation intake를 차단하고 queued/in-flight tick, RF, state commit, terminal handoff를 모두 마친 뒤 MQTT runtime을 닫는다.

Task 13은 normalized 차량 sensor runtime API와 application-ACK execution telemetry를 production Gateway 수명주기에 연결한다. 실제 ESP32-H2 Sensor Client/vendor event model 입력은 Task 14 범위이므로 해당 Mesh 입력 연결 전에는 차량 규칙이 스스로 활성화되지는 않는다.

```bash
pnpm --filter @led-control/gateway test -- automation-state-store.test.ts automation-arbiter.test.ts vehicle-event-runtime.test.ts automation-telemetry-outbox.test.ts automation-telemetry-coordinator.test.ts schedule-runtime.test.ts clock-trust-provider.test.ts automation-runtime.test.ts command-journal.test.ts gateway-command-handler.test.ts gateway-mqtt-runtime.test.ts index.test.ts
pnpm --filter @led-control/gateway build
```

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
After=network-online.target time-sync.target
Wants=network-online.target time-sync.target

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

검색 시작 명령은 `/var/lib/led-control/provisioning-scan-journal.json`에 `(sessionId, scanCorrelationId, scanAttempt)` key로 원자 저장한다. 이 파일은 `0600`이어야 하며, 손상·권한 오류·1,000 record 초과는 scanner를 시작하지 않는 fail-closed 오류다. running duplicate는 기존 실행만 기다린다. 재시작 초기화는 남은 running record를 새 BlueZ scan 없이 정제된 `scan-failed` terminal로 원자 전환하지만 MQTT 연결 전에는 발행하지 않는다. runtime listener 등록 전에 MQTT가 연결됐어도 command와 application ACK subscription을 먼저 준비한 뒤 connect recovery를 한 번 실행한다.

connect recovery는 아직 application ACK를 받지 못한 terminal을 original `eventId`와 `sequence`로 직렬 drain한다. 연결 뒤 새 terminal이 생기면 retry scheduler를 깨우고, ACK가 없으면 1초부터 30초까지 exponential bounded backoff로 같은 terminal을 재발행한다. idle journal은 polling하지 않으며 connection 안의 drain은 single-flight다. 각 recovery publish는 30초 scan outbox lease보다 짧은 10초 안에 끝나야 한다. MQTT close는 예약 timer와 callback 대기를 모두 취소하고, reconnect는 새 connection generation에서 즉시 drain을 재시작한다. broker PUBACK은 전송만 확인하므로 `deliveredAt`을 기록하지 않는다. API가 `ProcessedGatewayEvent`와 `ProvisioningSession` transaction을 commit한 뒤 발행한 `acks/provisioning/scan-terminal-ingested`의 `eventId`, `sequence`, `sessionId`, `scanCorrelationId`, `scanAttempt`가 저장 terminal과 모두 일치할 때만 delivered로 전환하고 retry timer를 정리한다. ACK를 받지 못한 terminal과 running record는 retention과 capacity eviction에서 제외한다. 이 보호 record 때문에 1,000개 한도를 넘으면 새 scan을 시작하지 않고 fail-closed 한다. delivered terminal만 ACK의 `ingestedAt`부터 24시간 보존한 뒤 제거한다. 경로는 `GATEWAY_PROVISIONING_SCAN_JOURNAL_PATH`로 바꿀 수 있다.

Gateway MQTT certificate는 ACK namespace에서 Gateway가 실제 생성하는 `acks/acceptance`, `acks/device-status`만 publish할 수 있다. API transaction commit을 증명하는 `acks/state-ingested`, `acks/provisioning/scan-terminal-ingested`는 Gateway read-only이며 self-publish는 Mosquitto ACL에서 거부한다.

## 차량 센서 capability report handoff

Task 14 Gateway 구현은 MeshNode마다 `capabilityRevision`, `eventId`, complete `VehicleSensorCapabilityReportV1` payload와 그 canonical `reportPayloadHash`를 gateway volume에 원자 저장한다. `capabilityRevision`은 Sensor Server와 vendor vehicle event model의 실제 bound 상태가 바뀔 때만 1 증가한다. 새 report는 두 model boolean을 모두 포함하고 `supported`는 둘 다 true일 때만 사용한다.

Gateway는 `sites/{siteId}/gateways/{gatewayId}/events/automation/vehicle-sensor-capability`에 저장된 report를 발행하고 broker PUBACK만으로 delivered 처리하지 않는다. API의 `sites/{siteId}/gateways/{gatewayId}/acks/automation/vehicle-sensor-capability-ingested` ACK가 같은 `eventId`, `gatewayId`, `meshNodeId`, `capabilityRevision`, `reportPayloadHash`를 확인할 때까지 같은 payload/hash를 재시도한다. reconnect에서도 revision, eventId, payload, hash를 바꾸지 않고 현재 저장 report를 다시 발행한다. `applied`, `stale`, `duplicate`는 다섯 identity가 모두 일치하는 ACK일 때만 전송 완료로 기록하고 `rejected`는 journal을 보존한 채 conflict를 운영 오류로 노출한다. Event/node/revision이 같더라도 다른 report hash의 ACK는 현재 journal의 terminal 상태를 바꾸지 않고 무시한다.

Task 9 API consumer는 broker가 확인한 mTLS/ACL Gateway identity와 topic/payload의 site/gateway가 DB의 active claimed Gateway identity와 모두 일치할 때만 report service를 호출한다. 이 report에는 unauthenticated direct API route가 없다. Service는 ingestion transaction에 `vehicle-sensor-capability:<gatewayId>:<meshNodeId>:<eventId>:<reportPayloadHash>` key의 ACK outbox row를 저장한다. Cross-node eventId 충돌과 same-node altered payload는 incoming report hash별 rejected ACK가 되고 원본 ACK는 유지된다. Exact report 재전달은 해당 hash row의 최초 payload/hash/`ingestedAt`을 유지하며 published/deadletter/expired lease 상태를 재큐잉하지만 active lease는 뺏지 않는다. Task 9 publisher는 config와 application-ACK를 variant별 `FOR UPDATE SKIP LOCKED` 30초 lease로 claim하고 저장된 topic/exact payload를 재계산 없이 MQTT QoS 1으로 발행한다. 실패는 1초~60초 backoff 후 10회 또는 15분에 row를 보존한 deadletter로 전환하며, shutdown은 active batch를 drain한 뒤 MQTT를 닫는다. 이 절은 Task 9/14의 정확한 구현 계약이고 publisher와 Gateway runtime에는 아직 연결되지 않았다.

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

gateway는 `eventId`, `sequence`, `occurredAt`를 보강한 v2 `scan-found` 이벤트로 발견 결과를 발행한다.

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
