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
GATEWAY_BLUETOOTH_COMPANY_ID=<Bluetooth SIG 자사 할당 Company Identifier>
```

`GATEWAY_BLUETOOTH_COMPANY_ID`는 필수이며 10진수 또는 `0x` 16진수로 설정한다. 누락, 미할당 `0`, Espressif 할당값 `0x02E5`, 테스트/내부용 `0xFFFF`는 시작 단계에서 거부한다. 같은 제품의 ESP32-H2 빌드는 `CONFIG_LED_CONTROL_BLUETOOTH_COMPANY_ID`에 정확히 같은 값을 사용한다.

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
- 새 output은 단일 fixture unicast 또는 동시성 8의 제한된 parallel unicast를 기존 BLE Mesh executor로 실행한다. State mutation은 `durable|memory_only` outcome을 반환하며 schedule/vehicle/manual local-control transition만 `memory_only`를 허용한다. Shared headroom retry 뒤에도 control state write가 `ENOSPC`이면 mutation을 in-memory committed state로 유지하고 새 exact pending handoff를 preallocated gap journal로 옮긴 뒤 memory queue에서 제거한다. `automation_state_durability_degraded`를 노출하지만 local RF는 계속하며, 다음 성공 write가 전체 in-memory snapshot을 durable state로 reconcile한다. Process-local vehicle/manual monotonic deadline은 durable 또는 명시적 in-memory commit 성공 뒤에만 교체한다.
- `/var/lib/led-control/automation-telemetry.json`의 `appendBatch`는 한 handoff의 모든 event identity/sequence/payload/hash와 acceptance receipt를 단 한 번의 atomic rewrite로 저장하거나 전체 record set을 drop으로 반환한다. Prefix commit은 없으며 grouped `action_result` 하나의 fixture result 수를 dropped payload 수로 계산하지 않는다. Pretty JSON metadata를 포함한 regular outbox 파일은 64 MiB를 넘지 않고, 미게시 `event_extended`는 active event별 최신 record로 교체한다.
- Startup은 `${GATEWAY_AUTOMATION_TELEMETRY_OUTBOX_PATH}.gap`을 두 개의 4 KiB checksum block으로, `${...}.reserve`를 automation state와 telemetry outbox가 공유하는 64 MiB headroom으로 각각 한 번 실제 preallocate한다. 정상 state/outbox commit은 reserve를 release하거나 rewrite하지 않는다. 실제 top-level `ENOSPC`에서만 manager가 reserve를 원자적으로 한 번 release하고 typed write를 한 번 retry하며, 최소 reserve 두 배의 free space를 확인한 뒤에만 background task가 reserve를 복원한다. Counters는 normal write, `ENOSPC`, retry, release, preallocation bytes와 replenish attempt/failure를 분리한다. Sidecar를 제외한 regular outbox 자체의 strict cap은 metadata 포함 64 MiB다.
- Capacity 또는 state/outbox `ENOSPC` drop은 alternate journal block을 fixed-size positional write와 file `fsync`로 갱신해 추가 allocation 없이 `firstDroppedAt|lastDroppedAt|droppedCount`를 보존한다. 최초 persisted gap은 state write 전에 stable identity/count를 만들고 definite state `ENOSPC`이면 같은 cumulative 후보를 fixed journal에 직접 수용한다. State와 journal이 모두 실패하면 하나의 bounded in-memory cumulative source와 `automation_state_durability_degraded` health를 유지하고 local RF를 계속한다. Journal은 마지막 일반 source와 cumulative source receipt 외에 outbox가 durable 수용한 aggregate baseline과 acceptance identity/hash를 고정 저장한다. Aggregate identity는 clear까지 유지하며 reimport는 source metadata 합계가 아니라 `aggregate - acceptedBaseline`만 반영한다. Baseline에 흡수된 뒤 state/journal에서 재생 불가능한 general source receipt는 같은 outbox import commit에서 제거하고, 현재 state pending handoff/gap, current journal source, cumulative source, aggregate와 active baseline identity는 보호한다. 따라서 clear 실패 중 source 교체를 100회 반복하거나 중간 restart 및 cleanup commit previous·next uncertainty가 있어도 recovery metadata는 O(1)이고 기존 event ID, sequence와 최종 payload hash를 유지한 정확한 cumulative count로 수렴한다. Clear tombstone generation도 별도 보존해 직후 기록한 새 source가 오래된 null block에 가려지지 않는다. Telemetry handoff completion과 persisted gap clear는 durable-required mutation이라 실패 시 memory와 disk source를 모두 pending으로 유지한다. Coordinator는 현재 batch를 즉시 중단하고 1초~30초 bounded exponential backoff로 같은 handoff를 재시도하며, retry가 처음 outbox work를 만들면 publisher를 깨우고 source clear가 durable해진 뒤에만 receipt를 release한다. Regular outbox/headroom 초기화 실패나 outbox JSON 손상은 `automation_telemetry_unavailable`로 격리되며 scheduler, manual intake와 local RF startup은 계속한다. Commit uncertainty는 nested `ENOSPC`가 있어도 journal acceptance로 재분류하지 않고 원래 typed error와 pending in-memory source를 유지해 records/gap 이중 분류를 막는다.
- `schedule_started|schedule_ended|vehicle_detected|event_started|event_extended|event_ended|action_result|telemetry_gap`은 `sites/{siteId}/gateways/{gatewayId}/events/automation/execution`에 exact JSON, MQTT QoS 1로 발행한다. Broker PUBACK으로 삭제하지 않으며 `acks/automation/execution-ingested`의 gateway/eventId/sequence/canonical payload hash가 모두 일치할 때만 제거한다. Hash conflict는 원본을 보존하고 reconnect/retry가 같은 immutable payload를 다시 발행한다. 종료 시 scheduler terminal handoff를 마친 뒤 telemetry publisher의 in-flight QoS 1 publish와 outbox queue를 drain하고 MQTT client를 닫는다.
- schedule occurrence와 override/event 종료 시 저장한 pre-state를 기준으로 다시 arbitrate해 현재 더 높은 source를 덮지 않는다. 성공한 manual-only override만 마지막 수동 밝기를 새 base로 사용한다. 이미 활성인 schedule/event 위에서 manual이 성공해도 해당 automatic source의 기존 pre-state를 바꾸지 않으므로 manual 만료 뒤 automatic source로, 그 source 종료 뒤 원래 pre-state로 복귀한다.
- system clock은 `/run/systemd/timesync/synchronized` marker와 5분 이상 역행 여부로 신뢰한다. Compose는 marker가 cold boot 뒤 생성될 수 있도록 `/run/systemd/timesync` 디렉터리를 read-only mount한다. Rollback 순간 marker mtime을 recovery fence로 잡아 최소 한 번 untrusted를 보장하고 이후 marker 갱신만 trust를 회복한다. Trusted manual은 수신 시점의 absolute `overrideUntil - now`만 monotonic deadline으로 변환한다. Untrusted manual은 원래 최대 30일 duration을 다시 시작하지 않고 MQTT command delivery 상한과 같은 최대 10초 fail-safe monotonic window만 허용한다.
- timed manual command는 acceptance와 실행 직전 expiry 검사를 통과한 뒤 override를 먼저 durable 저장하고 RF를 실행한다. Startup은 snapshot runtime을 활성화한 뒤 command journal handoff를 재생한다. Accepted timed record와 `automationHandoff=pending` record는 완료 전까지 24시간 TTL 및 일반 `maxRecords` eviction에서 보호하며 별도 10,000건 pending 상한이 가득 차면 `COMMAND_AUTOMATION_HANDOFF_CAPACITY`로 새 intake를 fail-closed한다. Prepare-before-RF restart는 indeterminate terminal로 닫고 completed-before-handoff restart는 RF 없이 handoff를 재생한다.
- Automation은 Health Current 완료 상태와 분리된 OnOff/Lightness observation callback으로 recovery fence를 해제하므로 Health timeout이 밝기 복구를 막지 않는다. Full Mesh resync는 concurrency 4 background worker에서 fixture 실패를 격리하며 MQTT, heartbeat, ACK와 manual control을 먼저 시작한다. `mesh_resync_pending|mesh_resync_failed`가 readiness를 나타내고 shutdown은 in-flight worker를 drain한다.
- API command publisher는 stored `overrideUntil`이 지난 outbox를 `MANUAL_OVERRIDE_EXPIRED`로 terminal 처리해 발행/재발행하지 않는다. Command `expiresAt`과 MQTT message expiry는 absolute `overrideUntil`을 넘지 않는다. Gateway command-expiry 검사는 trusted clock에서만 absolute 시각을 사용하며, untrusted 동안에는 broker retention 상한과 위 10초 monotonic fail-safe에 의존한다.
- 종료 시 `stopAndDrain()`이 새 automation intake를 차단하고 queued/in-flight tick, RF, state commit, terminal handoff를 모두 마친 뒤 MQTT runtime을 닫는다.

Task 13은 normalized 차량 sensor runtime API와 application-ACK execution telemetry를 production Gateway 수명주기에 연결했다. Task 14는 BlueZ Sensor Client/vendor event 입력, startup/reconnect Sensor Get, durable dedupe/application ACK와 capability report lifecycle을 연결했다. 실제 ESP32-H2 Sensor Server/vendor event 송신은 Task 15/16과 HIL 범위다.

```bash
pnpm --filter @led-control/gateway test -- storage-headroom-manager.test.ts automation-storage.test.ts automation-state-store.test.ts automation-arbiter.test.ts vehicle-event-runtime.test.ts automation-telemetry-outbox.test.ts automation-telemetry-coordinator.test.ts schedule-runtime.test.ts clock-trust-provider.test.ts automation-runtime.test.ts command-journal.test.ts gateway-command-handler.test.ts gateway-mqtt-runtime.test.ts index.test.ts
pnpm --filter @led-control/gateway build
```

## 차량 감지 자동제어 HIL 수동 절차

상태: **미실행**. 아래 절차는 Task 19의 Chromium software E2E와 별개인 실제 Raspberry Pi + BlueZ Mesh + ESP32-H2 시험이다. software simulator, native test, ESP-IDF target build 또는 MQTT publish 성공만으로 HIL을 통과 처리하지 않는다. 한 단계라도 실패하면 이후 단계를 진행하지 말고 실패 시각, 명령 출력, Gateway 로그, ESP serial log, MQTT capture와 전기 실측치를 보존한다.

시험 시작 전 실제 값만 설정한다. observer 인증서는 Gateway device key가 아닌 읽기 권한이 있는 별도 운영자/검증 principal을 사용하고, private key와 claim code는 기록 파일에 넣지 않는다.

```bash
export SITE_ID='<site UUID>'
export GATEWAY_ID='<gateway UUID>'
export SENSOR_FIXTURE_ID='<sensor fixture UUID>'
export TARGET_FIXTURE_ID='<target light fixture UUID>'
export PI_HOST='<user@raspberry-pi>'
export MQTT_HOST='<broker DNS or IP>'
export MQTT_HOST_IP='<broker IPv4 for the temporary cloud cut>'
export HIL_EVIDENCE_DIR="$PWD/.superpowers/sdd/2026-08-29-schedule-vehicle-event-control/hil-$(date +%Y%m%d%H%M%S)"
mkdir -p "$HIL_EVIDENCE_DIR"
```

`mosquitto_sub`를 사용할 검증 principal의 CA/certificate/key 경로를 환경에 설정한 뒤, 시작부터 종료까지 automation ACK와 execution을 수집한다.

```bash
set -euo pipefail
export HIL_CA='<observer CA path>'
export HIL_CERT='<observer certificate path>'
export HIL_KEY='<observer private key path>'
mosquitto_sub -h "$MQTT_HOST" -p 8883 --cafile "$HIL_CA" --cert "$HIL_CERT" --key "$HIL_KEY" \
  -t "sites/$SITE_ID/gateways/$GATEWAY_ID/events/automation/#" \
  -t "sites/$SITE_ID/gateways/$GATEWAY_ID/acks/automation/#" -v \
  >"$HIL_EVIDENCE_DIR/mqtt.log" 2>&1 &
MQTT_CAPTURE_PID=$!
printf 'mqtt_capture_pid=%s\nstarted_at=%s\n' "$MQTT_CAPTURE_PID" "$(date -Iseconds)" \
  | tee "$HIL_EVIDENCE_DIR/mqtt-capture.pid"

stop_mqtt_capture() {
  if ! kill -0 "$MQTT_CAPTURE_PID" 2>/dev/null; then
    set +e
    wait "$MQTT_CAPTURE_PID"
    status=$?
    set -e
    printf 'mqtt_capture_unexpected_exit=%s\n' "$status" >>"$HIL_EVIDENCE_DIR/mqtt-capture.pid"
    return 1
  fi
  kill "$MQTT_CAPTURE_PID"
  set +e
  wait "$MQTT_CAPTURE_PID"
  status=$?
  set -e
  if [ "$status" -ne 0 ] && [ "$status" -ne 143 ]; then
    printf 'mqtt_capture_exit=%s\n' "$status" >>"$HIL_EVIDENCE_DIR/mqtt-capture.pid"
    return "$status"
  fi
  test -s "$HIL_EVIDENCE_DIR/mqtt.log"
}

trap 'status=$?; trap - EXIT INT TERM; stop_mqtt_capture || status=1; exit "$status"' EXIT
trap 'exit 130' INT TERM
sleep 1
if ! kill -0 "$MQTT_CAPTURE_PID" 2>/dev/null; then
  stop_mqtt_capture || true
  exit 1
fi
```

이 shell에서 이후 단계를 실행한다. `mqtt-capture.pid`의 PID와 시작 시각을 증거에 포함하고, Step 8 종료 명령 또는 trap이 `kill`과 `wait`를 수행한다. subscriber가 종료 전에 죽거나 종료 후 `mqtt.log`가 비어 있으면 HIL 실패다.

### 1. 센서 전기 안전과 safe GPIO 실측

**경고: LED converter의 DIM+/DIM-, 0-10V/PWM DIM interface, LED 부하, converter 보조전원을 ESP GPIO 또는 ESP32-H2 3.3V rail에 직접 연결하지 않는다. 승인된 절연/레벨시프팅 interface 회로와 ESD/서지 보호를 거친 센서 3.3V digital output만 safe GPIO에 연결한다.** 회로 승인과 전원이 분리되지 않았거나 측정값이 범위를 벗어나면 flash·전원 인가·GPIO 연결을 중지한다.

1. ESP와 converter 전원을 분리하고 multimeter/oscilloscope로 sensor output-to-sensor GND를 측정한다. idle Low와 detection High가 모두 `0~3.3V` 범위이고 High가 Active High인지 확인한다.
2. 비절연 연결은 sensor GND와 ESP GND의 연속성, GPIO `4` 또는 실제 Kconfig safe GPIO가 PWM/factory-reset/UART/strapping/USB/flash pin과 충돌하지 않는지 확인한다. 긴 배선·서로 다른 전원·surge 환경은 승인된 isolation/level shifter를 사용한다.
3. 아래처럼 기록을 남긴다. 성공은 세 값이 회로 승인서와 일치하고 sensor output 외 converter 회로가 ESP GPIO/3.3V에 직접 연결되지 않은 경우다. 하나라도 불일치하면 실패다.

```bash
printf 'measured_at=%s\nsensor_idle_v=<measured>\nsensor_active_v=<measured>\ngnd_continuity_ohm=<measured>\nsafe_gpio=<GPIO>\ninterface_approval=<id>\n' \
  "$(date -Iseconds)" | tee "$HIL_EVIDENCE_DIR/electrical-measurement.txt"
```

### 2. Gateway deploy와 ESP production flash

Pi image와 signed firmware artifact를 각각 배포한다. `--test-build` binary는 intentional abort image이므로 HIL에 flash하지 않는다.

```bash
scripts/gateway-appliance-deploy.sh "$PI_HOST" \
  dist/gateway-appliance/led-control-gateway-<revision>-linux-arm64.tar

export IDF_PATH="${IDF_PATH:-$HOME/esp/esp-idf}"
export CONFIG_LED_CONTROL_BLUETOOTH_COMPANY_ID='<owner decimal Company ID>'
export LED_CONTROL_MANUFACTURING_APPROVAL_MANIFEST='<approved manifest>'
export LED_CONTROL_MANUFACTURING_APPROVAL_SIGNATURE='<approved signature>'
test -f "$IDF_PATH/export.sh"
test -f apps/esp32-h2-firmware/manufacturing/production-trust-policy.conf
scripts/esp32-h2-build.sh
scripts/esp32-h2-flash.sh /dev/cu.usbmodemXXXX
```

동일 shell에서 export한 Company ID, approval manifest/signature와 `IDF_PATH`가 build와 flash wrapper 모두에 전달된다. trust policy는 caller override가 아닌 repository/CI fixed policy이므로 위 파일이 `unprovisioned`이면 production build/flash는 의도적으로 실패한다. 성공은 Pi `led-control-gateway`가 `healthy`이고 ESP serial log에 unprovisioned beacon 또는 복원된 provisioned node가 보이며 production flash wrapper가 signed attestation을 검증한 경우다. 실패는 deploy/health/approval/attestation/flash 어느 하나의 non-zero exit, `GATEWAY_BLUETOOTH_COMPANY_ID`와 `CONFIG_LED_CONTROL_BLUETOOTH_COMPANY_ID` 불일치, 혹은 test-build flash 시도다. 아래 출력과 serial log를 보관한다.

```bash
ssh "$PI_HOST" 'cd /opt/led-control/gateway && docker compose -f compose.yml ps && docker exec led-control-gateway cat /var/run/led-control/health.json' \
  | tee "$HIL_EVIDENCE_DIR/gateway-health.txt"
```

### 3. Provisioning, AppKey, model binding

웹의 등록 흐름으로 Gateway claim, sensor fixture와 target fixture 등록을 완료한다. ESP는 unprovisioned beacon에서 발견한 뒤에만 등록하며, 이미 provisioned node를 재사용하면 fixture ID/unicast mapping을 대조한다. Gateway 로그에서 `AddNodeComplete`, NetKey/AppKey index `0`, Light Lightness/OnOff bind와 Sensor Server `0x1100` 및 vendor server `0x0000`의 AppKey/model publication Config Status를 확인한다.

```bash
ssh "$PI_HOST" 'docker logs --since 15m led-control-gateway' \
  | tee "$HIL_EVIDENCE_DIR/provisioning-gateway.log"
```

성공은 두 fixture의 unicast mapping, target Lightness Status, sensor Sensor Get/Status, Sensor/vendor model binding이 모두 확인된 경우다. 검색 0건, `STATUS_TIMEOUT`, model/AppKey/publication status 불일치, capability가 `supported`가 아닌 경우는 실패다. 이 단계의 증거는 등록 화면 결과, Gateway log, ESP serial log, `mqtt.log`이다.

### 4. Rule applied 확인

admin으로 schedule과 vehicle event rule을 같은 Gateway의 target fixture에 생성한다. event rule의 source는 위 sensor fixture, brightness는 schedule보다 높은 값, hold는 정확히 `5초`로 설정한다. UI에는 CRUD 저장 상태와 Gateway `APPLIED` 상태가 별도임을 확인하고, MQTT에서 matching revision/hash의 `config-applied`를 수집한다.

```bash
ssh "$PI_HOST" 'docker exec led-control-gateway sh -c "cat /var/lib/led-control/automation-snapshot.json; echo; cat /var/lib/led-control/automation-state.json"' \
  | tee "$HIL_EVIDENCE_DIR/applied-snapshot-and-state.json"
```

성공은 UI `APPLIED`, snapshot의 site/gateway/revision/hash와 matching `config-applied`, enabled schedule/event rule이 함께 존재하는 경우다. 저장 성공만 있고 `PENDING` 또는 `REJECTED`, hash/scope mismatch, snapshot 누락은 실패다.

### 5. High, Low, 5초 hold, retrigger

target fixture의 schedule brightness를 먼저 관측한 뒤 실제 센서를 High로 만든다. ESP serial log, Gateway log, MQTT execution과 target Lightness Status를 같은 시각에 기록한다. High가 유지되는 동안 software timeout으로 event가 끝나면 실패다.

```bash
date -Iseconds | tee -a "$HIL_EVIDENCE_DIR/physical-actions.log" # initial High 직전
# 실제 sensor output을 High로 만든다.
date -Iseconds | tee -a "$HIL_EVIDENCE_DIR/physical-actions.log" # initial High
# 실제 sensor output을 Low로 만든다.
date -Iseconds | tee -a "$HIL_EVIDENCE_DIR/physical-actions.log" # first Low, old 5초 hold 시작
sleep 4
# first Low 기준 old deadline 전 High edge를 만들어 retrigger한다.
date -Iseconds | tee -a "$HIL_EVIDENCE_DIR/physical-actions.log" # retrigger High
# High edge 직후 즉시 Low로 내려 새 5초 hold를 시작한다.
date -Iseconds | tee -a "$HIL_EVIDENCE_DIR/physical-actions.log" # retrigger Low, new 5초 hold 시작
sleep 2
date -Iseconds | tee -a "$HIL_EVIDENCE_DIR/physical-actions.log" # old deadline 직후: 80% event 유지 확인
sleep 4
date -Iseconds | tee -a "$HIL_EVIDENCE_DIR/physical-actions.log" # retrigger Low 기준 new deadline 직후: 40% schedule 복귀 확인
```

성공 순서는 `schedule -> initial High -> first Low -> old deadline 전 retrigger High/즉시 Low -> old deadline 직후 80% 유지 -> retrigger Low 기준 new deadline 직후 40% 복귀`다. `retrigger High`와 `retrigger Low`의 별도 timestamp, 두 deadline 관측의 target Lightness Status, `(sourceUnicast, bootId, sequence)` vendor ACK, execution kind를 수집한다. old deadline에 High가 남아 있으면 이 판정은 무효다. High/Low 반전, old deadline 직후 40% 복귀, new deadline 뒤에도 80% 유지, Status/ACK 누락은 실패다.

### 6. Cloud 단절

승인된 시험 창에 Pi에서 broker TLS egress만 차단한다. 다른 현장 또는 관리 plane을 차단하지 않으며, 작업 후 규칙을 즉시 삭제한다.

```bash
ssh "$PI_HOST" "sudo iptables -I OUTPUT -p tcp -d $MQTT_HOST_IP --dport 8883 -j DROP"
ssh "$PI_HOST" 'docker logs --since 2m led-control-gateway' | tee "$HIL_EVIDENCE_DIR/cloud-cut.log"
# 다음 schedule boundary와 sensor High/Low/hold/retrigger를 한 번 더 실제로 수행한다.
ssh "$PI_HOST" "sudo iptables -D OUTPUT -p tcp -d $MQTT_HOST_IP --dport 8883 -j DROP"
```

성공은 broker가 단절된 동안 마지막 applied snapshot으로 local schedule/event/hold가 실행되고, 복구 뒤 동일 event identity를 중복 실행하지 않는 경우다. snapshot 없이 실행, cloud 명령이 없으면 정지, duplicate RF/telemetry 또는 firewall rule을 제거하지 못한 경우는 실패다. 전후 `automation-state.json`, target Status와 `cloud-cut.log`를 증거로 남긴다.

### 7. Gateway와 ESP restart

event가 active인 상태와 마지막 Low hold 중 각각 한 번씩 Gateway restart, ESP reset을 수행한다. Gateway의 persisted snapshot/state와 ESP provisioning/AppKey/model state가 복원돼야 하며 re-provision은 발생하지 않아야 한다.

```bash
ssh "$PI_HOST" 'cd /opt/led-control/gateway && docker compose -f compose.yml restart gateway-appliance && docker compose -f compose.yml logs --tail=200 gateway-appliance' \
  | tee "$HIL_EVIDENCE_DIR/gateway-restart.log"
# ESP32-H2 RESET 또는 승인된 전원 cycle 후 serial log를 HIL_EVIDENCE_DIR/esp-restart.log에 저장한다.
ssh "$PI_HOST" 'docker exec led-control-gateway sh -c "cat /var/lib/led-control/automation-snapshot.json; echo; cat /var/lib/led-control/automation-state.json"' \
  | tee "$HIL_EVIDENCE_DIR/restart-state.json"
```

성공은 restart 뒤 같은 mapping/unicast와 model binding이 유지되고, current Sensor Status가 resync되며, active source의 우선순위·hold·schedule 복귀가 보존되고 already-observed desired에 duplicate RF가 없는 경우다. state corruption, re-provision 요구, restart pending fence가 관측 전 풀림, 잃은 hold, duplicate RF는 실패다.

### 8. Telemetry 재전달과 종료 판정

cloud 복구 뒤 MQTT capture에서 execution telemetry와 API ingested ACK의 exact `(gatewayId, eventId, sequence, payloadHash)` 일치를 확인한다. broker PUBACK만으로 telemetry가 삭제되면 안 되며, outbox가 ACK 후 drain돼야 한다.

```bash
ssh "$PI_HOST" 'docker exec led-control-gateway sh -c "cat /var/lib/led-control/automation-telemetry.json; echo; cat /var/lib/led-control/automation-state.json"' \
  | tee "$HIL_EVIDENCE_DIR/telemetry-after-replay.json"
stop_mqtt_capture
trap - EXIT INT TERM
sha256sum "$HIL_EVIDENCE_DIR"/* | tee "$HIL_EVIDENCE_DIR/SHA256SUMS"
```

성공은 MQTT execution과 API ingested ACK가 exact identity/hash로 짝지어지고, 재연결 후 immutable replay만 발생하며, terminal ACK 뒤 telemetry records가 drain되고 `telemetryGap`이 없거나 명시적 gap evidence가 남는 경우다. ACK 없는 삭제, hash conflict, replay 누락, duplicate execution identity, unexplained `telemetryGap`은 실패다. 성공 또는 실패 결과, 시험자, 보드 serial, Gateway revision, firmware attestation hash, 회로 승인 ID와 이 디렉터리 전체를 change record에 첨부한다.

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

Task 9 API consumer는 broker가 확인한 mTLS/ACL Gateway identity와 topic/payload의 site/gateway가 DB의 active claimed Gateway identity와 모두 일치할 때만 report service를 호출한다. 이 report에는 unauthenticated direct API route가 없다. Service는 ingestion transaction에 `vehicle-sensor-capability:<gatewayId>:<meshNodeId>:<eventId>:<reportPayloadHash>` key의 ACK outbox row를 저장한다. Cross-node eventId 충돌과 same-node altered payload는 incoming report hash별 rejected ACK가 되고 원본 ACK는 유지된다. Exact report 재전달은 해당 hash row의 최초 payload/hash/`ingestedAt`을 유지하며 published/deadletter/expired lease 상태를 재큐잉하지만 active lease는 뺏지 않는다. Task 9 publisher는 config와 application-ACK를 variant별 `FOR UPDATE SKIP LOCKED` 30초 lease로 claim하고 저장된 topic/exact payload를 재계산 없이 MQTT QoS 1으로 발행한다. 실패는 1초~60초 backoff 후 10회 또는 15분에 row를 보존한 deadletter로 전환하며, shutdown은 active batch를 drain한 뒤 MQTT를 닫는다. Task 14 Gateway runtime은 이 report/ACK topic을 production MQTT lifecycle과 ACL에 연결한다.

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
