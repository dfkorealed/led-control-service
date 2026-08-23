# 양산 장비 2-노드 실험실 검증

> 현재 판정: **자동 계약 구현·실기 미검증·일부 실기 차단**. 실제 Raspberry Pi/ESP32-H2 결과와 offline Root/Vault backup 승인 증거가 없으므로 아래 항목을 완료로 표시하지 않는다.

기준일: 2026-08-23

## 목적과 완료 기준

이 절차는 Raspberry Pi gateway 1대와 ESP32-H2 조명 노드 2대로 제조 등록, claim, 검색, 일괄 등록, BLE Mesh 그룹 설정, 제어, Health와 브라우저 복구를 검증한다. 자동 테스트나 route fixture 통과를 실제 RF/MQTT/BLE Mesh 성공으로 간주하지 않는다.

실기 완료 판정에는 다음 조건이 모두 필요하다.

1. 아래 7개 실기 Gate가 같은 firmware/image 조합에서 통과한다.
2. DB 수동 수정, mock gateway, demo seed, 테스트용 MQTT publish를 사용하지 않는다.
3. 실제 step adapter 구현 후 `pnpm gateway:hil:2node -- --repeat 3`의 세 run이 모두 `passed=true`다.
4. 각 단계의 화면, DB, gateway, ESP32 로그를 같은 `RUN_ID` 아래 보관한다.
5. 실패나 실행 불가 단계는 `failed` 또는 `not_executed`로 남기고 완료로 바꾸지 않는다.

## 자동 route fixture와 실제 HIL 경계

다음 Playwright 명령은 브라우저 렌더링과 API route 계약만 검증한다. 이 테스트는 실제 Bluetooth, MQTT, Raspberry Pi, ESP32-H2를 사용하지 않는다.

```bash
pnpm --filter @led-control/web exec playwright test e2e/monitoring-control-flow.spec.ts
pnpm --filter @led-control/web exec playwright test e2e/monitoring-1000.spec.ts
```

`apps/web/e2e`의 route fixture가 통과해도 아래 실기 Gate를 생략할 수 없다. 반대로 실기 시험 중에는 Playwright fixture 응답, mock gateway, demo seed를 API나 DB에 주입하지 않는다.

## 장비와 선행 조건

- Raspberry Pi 4 또는 CM5, 64-bit Raspberry Pi OS, 내장 Bluetooth
- ESP32-H2-MINI 개발 보드 2대와 데이터 USB 케이블
- 테스트용 절연 LED driver 또는 개발 LED 부하
- 제품 UUID 필터 부정 시험용 비-DFK unprovisioned BLE Mesh node 1대
- PostgreSQL, API, Web, Lab Vault, TLS Mosquitto가 실행 중인 개발 Mac
- 두 node에 같은 검증 대상 firmware가 flash된 상태
- gateway 제조 identity와 claim code, claim 후 발급된 MQTT 인증서
- operator 계정과 최초 설치를 마친 현장·층·gateway
- Mac의 ESP-IDF 5.5.1, OpenOCD/GDB, `jq`, `psql` 사용 가능 상태
- Pi의 gateway appliance가 `healthy`이고 gateway heartbeat가 최신인 상태

초기 설치와 PKI 절차는 `docs/runbooks/device-lab-first-install.md`를 먼저 수행한다.

## 보안과 증거 보관

claim code, private key, session token, Vault token을 stdout JSON이나 증거 파일에 포함하지 않는다. 인증서와 key는 경로와 fingerprint만 기록한다. 실기 결과는 Git에 추가하지 않는 `.local` 아래에 권한 `700/600`으로 보관한다.

```bash
cd "/Users/kim-jh/Documents/led-control-service"
export RUN_ID="$(date +%Y%m%d-%H%M%S)-2node"
export EVIDENCE_DIR="$PWD/.local/hil-evidence/$RUN_ID"
mkdir -p "$EVIDENCE_DIR"/{01-scan,02-registration,03-subscriptions,04-group-control,05-fixture-status,06-health,07-browser-recovery}
chmod 700 "$PWD/.local/hil-evidence" "$EVIDENCE_DIR"

export LAB_PI='dfkorea@dfkorea.local'
export HIL_GATEWAY_SERIAL='GW-RPI-000001'
export HIL_NODE1_PORT='/dev/cu.usbmodem1301'
export HIL_NODE2_PORT='/dev/cu.usbmodem1302'
export HIL_CA_PATH='/opt/led-control/gateway/data/identity/mqtt/current/mqtt-ca.crt'
export HIL_GATEWAY_CERT_PATH='/opt/led-control/gateway/data/identity/mqtt/current/gateway.crt'
export HIL_GATEWAY_KEY_PATH='/opt/led-control/gateway/data/identity/mqtt/current/gateway.key'
export HIL_STEP_TIMEOUT_MS=120000

jq -n \
  --arg runId "$RUN_ID" \
  --arg startedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --arg gitCommit "$(git rev-parse HEAD)" \
  --arg gatewaySerial "$HIL_GATEWAY_SERIAL" \
  '{runId:$runId,startedAt:$startedAt,gitCommit:$gitCommit,gatewaySerial:$gatewaySerial,status:"in_progress"}' \
  > "$EVIDENCE_DIR/manifest.json"
chmod 600 "$EVIDENCE_DIR/manifest.json"
```

각 Gate 결과는 다음 필드를 가진 JSON으로 남긴다.

```json
{
  "gate": "01-scan",
  "status": "passed | failed | not_executed",
  "startedAt": "ISO-8601",
  "completedAt": "ISO-8601",
  "siteId": "UUID",
  "gatewayId": "UUID",
  "fixtureIds": ["UUID"],
  "evidence": ["상대 경로"],
  "failureReason": null
}
```

화면은 PNG, 브라우저 요청은 HAR 또는 response JSON, DB 결과는 CSV, gateway/ESP32 출력은 UTF-8 text로 저장한다. 시험 종료 후 hash 목록을 만든다.

```bash
find "$EVIDENCE_DIR" -type f ! -name SHA256SUMS -print \
  | LC_ALL=C sort \
  | while IFS= read -r evidence; do shasum -a 256 "$evidence"; done \
  > "$EVIDENCE_DIR/SHA256SUMS"
find "$EVIDENCE_DIR" -type d -exec chmod 700 {} +
find "$EVIDENCE_DIR" -type f -exec chmod 600 {} +
```

## Gate 1. 자사 제품 UUID 필터 검색

### 목적

Gateway가 `DFKLED` prefix와 format version `0x01`인 unprovisioned node만 API에 보고하고 타사 또는 형식이 잘못된 node를 제외하는지 확인한다.

### 선행 조건

- ESP32-H2 두 대는 unprovisioned 상태다.
- 부정 시험용 node는 DFK 형식이 아닌 device UUID로 unprovisioned beacon을 송신한다.
- 웹 모니터링 화면에서 등록 대상 층과 online gateway를 선택할 수 있다.
- ESP32 부팅 로그의 `BLE Mesh node initialized ... uuid=` 값을 기록했다.

### 실행 명령과 화면 조작

Pi 로그를 먼저 수집한다.

```bash
ssh "$LAB_PI" 'docker logs --since=2m -f led-control-gateway' \
  > "$EVIDENCE_DIR/01-scan/gateway.log" 2>&1 &
export SCAN_LOG_PID=$!
```

1. 두 DFK node와 부정 시험용 node를 켠다.
2. 웹 `모니터링 > 조명 등록`에서 층과 gateway를 선택한다.
3. `조명 검색 시작`을 누르고 10초 scan과 1.5초 session polling이 끝날 때까지 기다린다.
4. 후보 목록, UUID, RSSI가 보이는 화면을 `01-scan/result.png`로 저장한다.
5. 브라우저 Network에서 `POST /api/registration-sessions`와 `GET /api/registration-sessions/{sessionId}` 응답을 저장하고 `SESSION_ID`를 기록한다.

```bash
kill "$SCAN_LOG_PID" 2>/dev/null || true
printf 'SESSION_ID (Network 응답 UUID): '
read -r SESSION_ID
export SESSION_ID
: "${SESSION_ID:?SESSION_ID를 입력해야 합니다}"

docker compose exec -T postgres psql -U led -d led_control \
  -v session_id="$SESSION_ID" -P pager=off --csv \
  > "$EVIDENCE_DIR/01-scan/discovered-nodes.csv" <<'SQL'
SELECT "deviceUuid", "serialNumber", rssi, status, "discoveredAt"
FROM "DiscoveredMeshNode"
WHERE "sessionId" = :'session_id'
ORDER BY "deviceUuid";
SQL
test "$(wc -l < "$EVIDENCE_DIR/01-scan/discovered-nodes.csv")" -gt 1 || {
  printf '검색 결과 CSV가 비어 있습니다. SESSION_ID와 검색 결과를 확인하세요.\n' >&2
  exit 1
}
```

### 기대 로그와 API/DB 상태

- 화면과 DB에는 DFK node 두 대만 있다.
- 두 UUID의 앞 12 hex는 `44464b4c4544`, 다음 byte는 `01`이다.
- ESP32 부팅 UUID와 `DiscoveredMeshNode.deviceUuid`가 일치한다.
- 비-DFK node마다 gateway 로그에 `event=mesh_scan_device_ignored`, `reason=unsupported_product_identity`가 있다.
- DFK node는 `status=discovered`, 실제 RSSI와 `discoveredAt`을 가진다.

### 실패 판정

- 하드웨어가 꺼져 있는데 후보가 나타난다.
- 비-DFK UUID가 화면이나 DB에 저장된다.
- DFK node가 누락되거나 ESP32 부팅 UUID와 다르다.
- 부정 시험용 node가 없어 필터의 제외 동작을 검증하지 못한 경우 `not_executed`다.

### 저장할 증거

`gateway.log`, `discovered-nodes.csv`, ESP32 두 대의 serial log, Network response, 후보 목록 PNG, Gate 결과 JSON을 저장한다.

## Gate 2. batch 일괄 등록

### 목적

한 요청으로 여러 node의 이름·정격 전력·크기·자동 배치를 확정하고, 각 node가 실제 provisioning을 완료한 뒤에만 fixture로 생성되는지 확인한다.

### 선행 조건

- Gate 1의 active `SESSION_ID`와 DFK node 두 대가 있다.
- floor group address 할당이 가능한 gateway다.
- 도면이 없어도 기본 `1200 x 800` 자동 배치를 사용할 수 있다.

### 실행 명령과 화면 조작

1. `등록 가능 조명 전체 선택`을 누른다.
2. `일괄 설정`에서 이름 접두사 `B2-L`, 시작 번호 `1`, 자리 수 `3`, 정격 전력 `40.00`, 크기 `20`을 입력한다.
3. `선택 조명 등록`을 한 번 누른다.
4. Network의 `POST /api/registration-sessions/{SESSION_ID}/nodes/register-batch` response를 저장한다.
5. 두 행이 `등록 완료`가 될 때까지 기다린 뒤 `등록 세션 완료`를 누른다.

```bash
ssh "$LAB_PI" 'docker logs --since=10m led-control-gateway' \
  > "$EVIDENCE_DIR/02-registration/gateway.log" 2>&1
: "${SESSION_ID:?Gate 1에서 SESSION_ID를 설정해야 합니다}"

docker compose exec -T postgres psql -U led -d led_control \
  -v session_id="$SESSION_ID" -P pager=off --csv \
  > "$EVIDENCE_DIR/02-registration/registration.csv" <<'SQL'
SELECT d."deviceUuid", d.status AS discovered_status,
       d."meshAddress" AS discovered_mesh_address,
       m.id AS mesh_node_id, m."meshAddress" AS mesh_node_address,
       f.id AS fixture_id, f.name, f."ratedWatt", f.x, f.y, f.size,
       f.status AS fixture_status, f."statusReason"
FROM "DiscoveredMeshNode" d
LEFT JOIN "MeshNode" m ON m."deviceUuid" = d."deviceUuid"
LEFT JOIN "Fixture" f ON f."meshNodeId" = m.id
WHERE d."sessionId" = :'session_id'
ORDER BY f.name;
SQL
test "$(wc -l < "$EVIDENCE_DIR/02-registration/registration.csv")" -gt 1 || {
  printf '등록 결과 CSV가 비어 있습니다. SESSION_ID와 provisioning 결과를 확인하세요.\n' >&2
  exit 1
}
```

### 기대 로그와 API/DB 상태

- batch response의 두 item은 `accepted`이고 이름은 `B2-L001`, `B2-L002`다.
- provisioning 전 node는 `provisioning`, 성공 후 `provisioned`다.
- 두 node의 `meshAddress`는 다르고 `MeshNode` mapping과 일치한다.
- fixture 이름·정격 전력·크기는 일괄 기본값과 같고 좌표는 겹치지 않는다.
- 최초 fixture 상태는 실제 상태 수신 전까지 `offline / provisioning_waiting_state`일 수 있다. 이를 online으로 임의 보정하지 않는다.

### 실패 판정

- 같은 요청이 중복 fixture 또는 중복 unicast address를 만든다.
- 하나라도 `failed`, `reconcile_required`, `validation_failed`다.
- 실제 provisioning 완료 이벤트 전에 fixture를 online으로 표시한다.
- SQL 수정, seed 또는 mock event로 상태를 통과시킨다.

### 저장할 증거

batch request/response JSON, `registration.csv`, gateway와 ESP32 provisioning 로그, 등록 완료 PNG, Gate 결과 JSON을 저장한다.

## Gate 3. floor/zone Mesh subscription ready

### 목적

floor와 zone(`fixture_group`)의 group address가 Gateway별로 할당되고, 모든 대상 node의 Light Lightness Server subscription 응답이 적용된 version과 일치한 뒤에만 `ready`가 되는지 확인한다.

### 선행 조건

- Gate 2의 fixture 두 대와 confirmed mesh mapping이 있다.
- floor group은 등록 완료 시 자동 생성된다.
- zone 시험은 **지원되는 API/UI로 미리 생성되고 fixture가 배정된 `FixtureGroup`**이 있어야 한다.

현재 clean install에는 FixtureGroup 생성·멤버십 API/UI가 아직 없다. 따라서 새 현장에서 zone을 SQL로 만들지 않는다. 기존에 정상 경로로 생성된 FixtureGroup이 없다면 floor만 시험하고 zone 결과는 `not_executed`로 남기며 전체 floor/zone Gate를 통과로 표시하지 않는다.

### 실행 명령과 화면 조작

등록 완료 후 worker 주기 10초와 MQTT 왕복 시간을 고려해 최대 30초 기다린다. `SITE_ID`, `GATEWAY_ID`, `FLOOR_ID`는 claim/dashboard 응답에서 기록한다.

```bash
printf 'SITE_ID: '; read -r SITE_ID; export SITE_ID
printf 'GATEWAY_ID: '; read -r GATEWAY_ID; export GATEWAY_ID
printf 'FLOOR_ID: '; read -r FLOOR_ID; export FLOOR_ID
: "${SITE_ID:?SITE_ID를 입력해야 합니다}"
: "${GATEWAY_ID:?GATEWAY_ID를 입력해야 합니다}"
: "${FLOOR_ID:?FLOOR_ID를 입력해야 합니다}"

docker compose exec -T postgres psql -U led -d led_control \
  -v gateway_id="$GATEWAY_ID" -P pager=off --csv \
  > "$EVIDENCE_DIR/03-subscriptions/group-status.csv" <<'SQL'
SELECT g.id, g."targetType", g."targetId", g."groupAddress", g.status,
       g."configurationVersion", g."lastError",
       m."meshNodeId", m."subscriptionStatus", m."appliedVersion",
       m."statusVersion", m."lastError" AS member_error
FROM "MeshControlGroup" g
LEFT JOIN "MeshControlGroupMember" m
  ON m."groupId" = g.id AND m."gatewayId" = g."gatewayId"
WHERE g."gatewayId" = :'gateway_id'
ORDER BY g."targetType", g."targetId", m."meshNodeId";
SQL
test "$(wc -l < "$EVIDENCE_DIR/03-subscriptions/group-status.csv")" -gt 1 || {
  printf 'Mesh group CSV가 비어 있습니다. GATEWAY_ID와 worker 상태를 확인하세요.\n' >&2
  exit 1
}

ssh "$LAB_PI" 'docker logs --since=10m led-control-gateway' \
  > "$EVIDENCE_DIR/03-subscriptions/gateway.log" 2>&1

ssh "$LAB_PI" \
  'docker exec led-control-gateway sh -c "cat /var/lib/led-control/mesh-groups.json; cat /var/lib/led-control/mesh-groups.json.manifest"' \
  > "$EVIDENCE_DIR/03-subscriptions/gateway-mesh-groups.json" 2>&1
```

### 기대 로그와 API/DB 상태

- floor와 준비된 zone은 서로 다른 `0xc000~0xfeff` group address를 가진다.
- group은 `status=ready`, `lastError=NULL`이다.
- 모든 member가 `subscriptionStatus=applied`다.
- `appliedVersion=statusVersion=configurationVersion`이다.
- Gateway `mesh-groups.json`의 group ID/address/version/status가 DB와 일치한다.
- node 하나라도 실패한 version은 group 전체가 `ready`가 아니다.

### 실패 판정

- group이 30초 뒤에도 `configuring`이거나 `failed`다.
- member가 `pending/failed`, version 불일치 또는 `lastError`를 가진다.
- zone CRUD 부재를 SQL insert로 우회한다.
- floor만 ready인데 floor/zone 전체를 통과로 기록한다.

### 저장할 증거

`group-status.csv`, `gateway-mesh-groups.json`, gateway log, 각 ESP32의 Config Model Subscription 수신 로그, zone 생성·멤버십 API response 또는 미실행 사유, Gate 결과 JSON을 저장한다.

## Gate 4. group destination BLE Mesh 단일 전송

### 목적

층 또는 zone 제어 한 번이 fixture별 unicast 반복이 아니라 하나의 group destination `Node1.Send`로 송신되는지 확인한다.

### 선행 조건

- Gate 3에서 해당 floor 또는 zone group과 모든 member가 `ready`다.
- 두 fixture가 online이고 fault가 없다.
- 다른 제어 작업이나 gateway 재시작이 없는 안정 구간이다.

### 실행 명령과 화면 조작

Pi 컨테이너의 private D-Bus에서 `Node1.Send`를 캡처한다. 다음 명령은 60초 후 자동 종료한다.

```bash
ssh "$LAB_PI" \
  'docker exec led-control-gateway timeout 60 dbus-monitor --system "type='"'"'method_call'"'"',interface='"'"'org.bluez.mesh.Node1'"'"',member='"'"'Send'"'"'"' \
  > "$EVIDENCE_DIR/04-group-control/dbus-send.log" 2>&1 &
export DBUS_MONITOR_PID=$!
```

1. 웹 `제어`에서 `층` 또는 `구역`을 선택한다.
2. Gate 3에서 ready인 대상을 고르고 밝기 `70%`를 설정한다.
3. `밝기 적용`을 한 번만 누른다.
4. POST response의 `id`를 기록하고 완료 또는 부분 실패가 표시될 때까지 추가 제어를 하지 않는다.

```bash
wait "$DBUS_MONITOR_PID" || true
: "${SITE_ID:?Gate 3에서 SITE_ID를 설정해야 합니다}"
printf 'COMMAND_ID (POST response UUID): '
read -r COMMAND_ID
export COMMAND_ID
: "${COMMAND_ID:?COMMAND_ID를 입력해야 합니다}"

docker compose exec -T postgres psql -U led -d led_control \
  -v site_id="$SITE_ID" -v command_id="$COMMAND_ID" -P pager=off --csv \
  > "$EVIDENCE_DIR/04-group-control/latest-command.csv" <<'SQL'
SELECT c.id AS command_id, c."targetType", c.brightness, c.status,
       d.id AS dispatch_id, d."deliveryMode", d."destinationAddress",
       d."meshControlGroupId", d."meshControlGroupVersion", d.status AS dispatch_status
FROM "Command" c
JOIN "CommandDispatch" d ON d."commandId" = c.id
WHERE c.id = :'command_id'
  AND c."siteId" = :'site_id';
SQL
test "$(wc -l < "$EVIDENCE_DIR/04-group-control/latest-command.csv")" -gt 1 || {
  printf '명령 CSV가 비어 있습니다. SITE_ID와 제어 요청을 확인하세요.\n' >&2
  exit 1
}
```

### 기대 로그와 API/DB 상태

- `deliveryMode=mesh_group`, `destinationAddress`는 ready group address다.
- command response의 `dispatchCount=1`, `transmissionCount=1`이다.
- 캡처 구간에서 해당 밝기 payload의 `Node1.Send`는 group destination으로 정확히 한 번 호출된다.
- ESP32 두 대가 같은 명령을 적용하고 각자 Lightness Status를 publish한다.
- D-Bus method reply만으로 성공 처리하지 않고 fixture별 Status까지 기다린다.

### 실패 판정

- `parallel_unicast` 또는 fixture 수만큼 `Node1.Send`가 발생한다.
- group address/version이 DB의 ready group과 다르다.
- 하나의 `Send` 성공만으로 fixture 결과를 전부 succeeded 처리한다.
- 캡처에 다른 제어가 섞여 호출 수를 구분할 수 없으면 재시험한다.

### 저장할 증거

`dbus-send.log`, command POST response, `latest-command.csv`, 두 ESP32의 밝기·publication serial log, 제어 전후 LED 영상/사진, Gate 결과 JSON을 저장한다.

## Gate 5. fixture별 status와 부분 실패

### 목적

그룹 1회 전송 후 각 fixture의 실제 Lightness Status를 독립적으로 기록하고, 응답 누락을 전체 성공으로 숨기지 않는지 확인한다.

### 선행 조건

- Gate 4의 `COMMAND_ID`가 있다.
- 두 ESP32 serial log와 브라우저 Network response를 저장할 수 있다.

### 실행 명령과 화면 조작

1. 브라우저 Network에서 `GET /api/commands/{COMMAND_ID}` response를 저장한다.
2. 두 node가 켜진 정상 시험에서는 두 결과가 끝날 때까지 기다린다.
3. 별도 부분 실패 시험에서는 명령 직전 node 2 전원을 끄고 같은 floor group 제어를 한 번 실행한다.
4. timeout 뒤 node 2 전원을 복구하고 gateway를 재시작해 상태를 다시 동기화한다.

```bash
: "${COMMAND_ID:?Gate 4에서 COMMAND_ID를 설정해야 합니다}"
docker compose exec -T postgres psql -U led -d led_control \
  -v command_id="$COMMAND_ID" -P pager=off --csv \
  > "$EVIDENCE_DIR/05-fixture-status/results.csv" <<'SQL'
SELECT d."commandId", d.id AS dispatch_id, d.status AS dispatch_status,
       r."fixtureId", f.name, r.status, r.brightness, r."faultCode",
       r."errorMessage", r."occurredAt"
FROM "CommandDispatch" d
JOIN "CommandFixtureResult" r ON r."dispatchId" = d.id
JOIN "Fixture" f ON f.id = r."fixtureId"
WHERE d."commandId" = :'command_id'
ORDER BY f.name;
SQL
test "$(wc -l < "$EVIDENCE_DIR/05-fixture-status/results.csv")" -gt 1 || {
  printf 'fixture 결과 CSV가 비어 있습니다. COMMAND_ID와 terminal 상태를 확인하세요.\n' >&2
  exit 1
}
```

### 기대 로그와 API/DB 상태

- 정상 시험은 command `stage=completed`, 두 result가 `succeeded`, brightness가 요청값이다.
- 부분 실패 시험은 응답 node가 `succeeded`, 전원 OFF node가 `timed_out`, command `stage=partial_failed`다.
- `completedFixtureCount=totalFixtureCount`는 성공과 실패를 모두 포함한 terminal count이며 성공 수로 오해하지 않는다.
- 모니터링 fixture state는 실제 status event의 sequence가 증가할 때만 갱신된다.

### 실패 판정

- node별 result 수가 대상 fixture 수와 다르다.
- Status를 보내지 않은 node가 `succeeded`다.
- 일부 timeout이 전체 `completed`로 표시된다.
- timeout 이후 전원을 복구해도 재동기화되지 않는다.

### 저장할 증거

정상/부분 실패 command response JSON, `results.csv`, gateway log, 두 ESP32 serial log, 모니터링 PNG, Gate 결과 JSON을 저장한다.

## Gate 6. ESP32 Health fault 발생·해제·수집

### 목적

production firmware를 변경하지 않고 panic reset fault `0x01`을 발생시켜 Gateway와 API가 이를 수집하고, 정상 reset 뒤 상태가 해제되는지 확인한다. 표준 Health Fault Clear는 Gateway 내부 송신 경로가 구현되기 전까지 별도 차단 항목으로 판정한다. 이 시험은 field sensor 고장을 대신하지 않고 현재 구현된 panic/watchdog 경로만 검증한다.

### 선행 조건

- Gate 2를 마친 provisioned node 1대와 해당 `FIXTURE_ID`가 있다.
- flash에 사용한 정확한 ELF와 ESP-IDF/OpenOCD가 Mac에 있다.
- gateway provisioner의 Health Client model은 AppKey index `0`에 bind돼 있다.
- 시험 중 조명 출력을 안전하게 분리하거나 관찰할 수 있다.

### 실행 명령과 화면 조작

#### 6-1. fault 발생

브라우저 또는 Gate 2 등록 CSV에서 시험할 fixture ID를 입력하고 빈 값이면 중단한다.

```bash
printf 'FIXTURE_ID: '
read -r FIXTURE_ID
export FIXTURE_ID
: "${FIXTURE_ID:?FIXTURE_ID를 입력해야 합니다}"
```

Terminal A에서 OpenOCD를 실행한다.

```bash
. "$HOME/esp/esp-idf/export.sh"
cd "$HOME/esp/led-control-esp32-h2-build"
idf.py openocd
```

Terminal B에서 같은 build의 GDB를 연다.

```bash
. "$HOME/esp/esp-idf/export.sh"
cd "$HOME/esp/led-control-esp32-h2-build"
idf.py gdb
```

GDB prompt에서 production image에 일회성 panic을 발생시킨다.

```text
(gdb) monitor reset halt
(gdb) call esp_system_abort("HIL_HEALTH_FAULT")
(gdb) continue
```

ESP32가 재부팅되면 GDB/OpenOCD를 종료하고 serial monitor에서 panic reset과 BLE Mesh 재접속 로그를 저장한다. GDB 함수 호출이 대상 build에서 지원되지 않으면 DB 값을 조작하지 말고 이 Gate를 `failed`로 남긴다.

즉시 gateway를 재시작해 OnOff, Lightness, Health Current를 같은 resync generation에서 다시 조회한다.

```bash
ssh "$LAB_PI" 'docker restart led-control-gateway'
sleep 15
ssh "$LAB_PI" 'docker logs --since=3m led-control-gateway' \
  > "$EVIDENCE_DIR/06-health/fault-gateway.log" 2>&1
```

#### 6-2. 현재 가능한 fault 해제와 표준 Clear 차단점

현재 Gateway는 Health Client로 Current Fault를 조회할 수 있지만, 운영 중인 Gateway 프로세스 안에서 Health Fault Clear를 보내는 API나 IPC는 아직 제공하지 않는다. 별도 `docker exec` 프로세스가 `Node1.Send`를 직접 호출하면 BlueZ가 Attach owner 불일치로 거부하므로 성공 절차로 사용하지 않는다.

현재 구현으로 fault 상태를 해제하려면 ESP32-H2의 EN 버튼을 눌러 **panic이 아닌 정상 reset**을 한 번 수행한다. 이 방법은 재부팅으로 volatile current fault가 초기화되는지만 검증하며, firmware의 표준 Health Fault Clear callback을 검증하지 않는다. 정상 reset 뒤 Gateway가 Health Current를 다시 조회하게 한다.

```bash
ssh "$LAB_PI" 'docker restart led-control-gateway'
sleep 15
ssh "$LAB_PI" 'docker logs --since=3m led-control-gateway' \
  > "$EVIDENCE_DIR/06-health/clear-gateway.log" 2>&1

docker compose exec -T postgres psql -U led -d led_control \
  -v fixture_id="$FIXTURE_ID" -P pager=off --csv \
  > "$EVIDENCE_DIR/06-health/final-health.csv" <<'SQL'
SELECT id, name, status, "healthFaultCodes", "healthLastSeenAt",
       brightness, "lastSeenAt", "statusReason"
FROM "Fixture"
WHERE id = :'fixture_id';
SQL
test "$(wc -l < "$EVIDENCE_DIR/06-health/final-health.csv")" -gt 1 || {
  printf 'Health CSV가 비어 있습니다. FIXTURE_ID를 확인하세요.\n' >&2
  exit 1
}
```

표준 Health Fault Clear 실기는 Gateway 내부 송신 경로가 구현된 뒤 opcode `80 2f e5 02`를 같은 attached node owner로 전송하고, ESP32 serial의 `Health faults cleared`와 다음 Health Current를 함께 확인해야 한다. 그 전까지 표준 Clear 항목은 `not_executed`이며 Gate 6 전체를 완전 통과로 표시하지 않는다.

### 기대 로그와 API/DB 상태

- fault 발생 후 ESP32 boot reason은 panic이고 firmware가 current fault `0x01`을 publish한다.
- gateway `mesh_resync`는 해당 fixture의 Health Current를 수집한다.
- API/DB는 `status=fault`, `healthFaultCodes=[1]`, 최신 `healthLastSeenAt`을 기록하고 모니터링의 `장비 Health` 값은 `장애 (0x01)`이다.
- 정상 reset과 재수집 후 DB는 empty fault array와 `status=online`이며 모니터링의 `장비 Health` 값은 `정상`이다.
- 표준 Clear 경로를 별도로 시험하려면 ESP32의 `Health faults cleared`와 fault update 완료 로그가 모두 필요하다.

### 실패 판정

- panic 뒤 fault가 DB/UI까지 도달하지 않는다.
- registered Fault Status만 받고 Current Fault를 수집하지 못한다.
- 정상 reset 뒤에도 ESP32 current fault와 API fault 상태가 해제되지 않는다.
- Gateway 내부 표준 Clear 경로가 없는데 Gate 6을 완전 통과로 기록한다.
- DB의 health JSON을 직접 수정해 정상으로 만든다.
- exact ELF가 아닌 다른 build로 GDB를 연결한다.

### 저장할 증거

GDB/OpenOCD log, ESP32 fault/reset serial log, `fault-gateway.log`, `clear-gateway.log`, fault/reset 시점 DB CSV와 모니터링 PNG, Gate 결과 JSON을 저장한다. 표준 Clear는 미실행 사유를 Gate JSON에 남긴다.

## Gate 7. 브라우저 재접속 active command 복구

### 목적

명령 진행 중 같은 탭을 reload해도 site별 `sessionStorage`의 command ID로 동일 명령을 재조회하고, matching terminal response 전에는 제어를 잠근 채 중복 POST를 만들지 않는지 확인한다.

### 선행 조건

- operator/admin으로 로그인했고 floor group이 ready다.
- 두 fixture가 직전 dashboard에서 online이다.
- 부분 실패 시험을 위해 node 2 전원을 즉시 차단할 수 있다.
- 이 검증은 같은 브라우저 탭의 reload/reconnect 대상이다. 브라우저 전체 종료로 sessionStorage가 제거되는 시나리오는 포함하지 않는다.

### 실행 명령과 화면 조작

1. DevTools Network의 Preserve log를 켠다.
2. `제어 > 층`에서 두 fixture가 있는 floor를 선택하고 밝기를 지정한다.
3. node 2 전원을 끈 직후 `밝기 적용`을 한 번 누른다.
4. POST response에서 `commandId`를 기록하고 `밝기 적용 중`이 disabled인지 확인한다.
5. terminal response 전에 같은 탭을 즉시 reload한다.
6. reload 후에도 `밝기 적용 중`과 잠금이 유지되고 같은 `GET /api/commands/{COMMAND_ID}`만 polling되는지 확인한다.
7. `partial_failed` 또는 다른 matching terminal stage가 표시된 뒤 잠금이 해제되는지 확인한다.

reload 시험에서 새로 생성된 command ID를 입력한다.

```bash
printf 'COMMAND_ID (reload 시험 POST response UUID): '
read -r COMMAND_ID
export COMMAND_ID
: "${COMMAND_ID:?COMMAND_ID를 입력해야 합니다}"
```

진행 중과 종료 후 DevTools Console에서 storage를 확인한다.

```js
Object.fromEntries(Array.from({ length: sessionStorage.length }, (_, index) => {
  const key = sessionStorage.key(index);
  return [key, key ? sessionStorage.getItem(key) : null];
}));
```

명령 수와 fixture 결과를 DB에서 저장한다.

```bash
docker compose exec -T postgres psql -U led -d led_control \
  -v command_id="$COMMAND_ID" -P pager=off --csv \
  > "$EVIDENCE_DIR/07-browser-recovery/command.csv" <<'SQL'
SELECT c.id, c.status AS command_status, c."createdAt",
       d.id AS dispatch_id, d.status AS dispatch_status,
       r."fixtureId", r.status AS fixture_status, r."errorMessage"
FROM "Command" c
JOIN "CommandDispatch" d ON d."commandId" = c.id
JOIN "CommandFixtureResult" r ON r."dispatchId" = d.id
WHERE c.id = :'command_id'
ORDER BY r."fixtureId";
SQL
test "$(wc -l < "$EVIDENCE_DIR/07-browser-recovery/command.csv")" -gt 1 || {
  printf '복구 명령 CSV가 비어 있습니다. COMMAND_ID와 polling 결과를 확인하세요.\n' >&2
  exit 1
}
```

### 기대 로그와 API/DB 상태

- 진행 중 storage key는 `led-control:active-command:{encodedSiteId}`이고 값의 `commandId`가 POST response와 같다.
- reload 후 새 command POST 없이 같은 ID의 GET만 1초 간격으로 이어진다.
- matching terminal 전에는 대상 선택, slider, preset, 적용 버튼이 잠긴다.
- matching terminal 뒤 storage key가 compare-and-clear되고 결과가 화면에 남는다.
- 전원 OFF node가 있으면 fixture별 결과와 terminal stage는 Gate 5의 부분 실패 계약을 따른다.

### 실패 판정

- reload 시 잠금이 먼저 풀리거나 새 command POST가 생긴다.
- 다른 command ID의 response로 storage가 삭제된다.
- 일시적 5xx/network error에서 잠금이 풀린다.
- matching 404가 아닌 오류에서 active command가 제거된다.

### 저장할 증거

reload 전/후/terminal PNG, Network HAR, storage 출력, `command.csv`, gateway log, Gate 결과 JSON을 저장한다. 시험 후 node 2 전원을 복구하고 gateway restart/resync로 두 fixture가 online인지 확인한다.

## HIL runner 실행 경계

`pnpm gateway:hil:2node` runner 자체는 존재하지만 필요한 12개 실제 장비 step adapter는 저장소에 없다. 따라서 현재는 runner를 실행해 위 수동 Gate 결과를 대체하지 않는다. claim, bootstrap, secure MQTT, scan, provision, bind, individual/group control, stale event, offline, restart recovery와 ACL negative adapter가 repository script로 구현되고 검증된 뒤에만 3회 결과를 추가한다. 빈 성공 JSON이나 임시 helper는 금지한다.

## PKI HIL과 72시간 soak 경계

`pnpm gateway:pki:hil`과 `pnpm gateway:soak` runner도 존재하지만 제조/보안/rotation/secret scan과 soak-health 실제 step adapter가 없다. adapter를 repository script로 구현하고 검증하기 전에는 실행 결과를 만들지 않는다. 구현 후에는 PKI 3회와 5분 간격 72시간 soak의 전체 JSONL, 같은 기간 장비 로그와 첫 실패 non-zero 결과를 함께 보관한다.

## 현재 실기 상태와 알려진 차단점

- UUID parser/filter, batch API, group subscription state machine, group 단일 send, fixture별 result, Health decode/store, active command 복구는 코드와 자동 테스트가 있다.
- Raspberry Pi와 ESP32-H2를 연결한 이 문서의 7개 Gate는 아직 실행하지 않았다.
- clean install에서 FixtureGroup을 생성·편집하는 지원 API/UI가 없어 zone subscription Gate는 현재 실행 불가다. SQL seed로 우회하지 않는다.
- Gateway 프로세스 내부 Health Fault Clear 송신 API/IPC가 없어 표준 Clear callback 실기는 현재 실행 불가다. 별도 D-Bus client로 우회하지 않는다.
- HIL/PKI/soak 실제 장비 adapter는 저장소에 없다. runner 구현과 실기 step 구현을 구분한다.
- 2-node 3회 반복, 72시간 soak, offline Root/Vault backup 승인 증거가 없다.
- 따라서 현재 프로젝트를 양산 준비 완료로 판정하지 않는다.
