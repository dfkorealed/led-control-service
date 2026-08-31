# Task 19 software integration + Chromium E2E 보고서

기준일: 2026-08-31

## 결과

- 상태: software integration과 Chromium E2E 완료
- 최종 검증 명령 exit code: `0`
- Task 19 Chromium 시나리오: `1 passed (1.4m)`, test body `1.0m`
- 실제 Raspberry Pi, BlueZ Mesh, ESP32-H2 RF HIL: 미실행

## RED

1. simulator production-forbidden 테스트는 모듈 부재로 시작했다. 구현 중에는 factory가 `null`을 반환하고, private IPC 함수와 환경 parser 및 test clock trust가 없는 상태를 각각 RED로 확인했다.
2. 실제 Chromium 흐름의 최초 RED에서는 production API가 `AutomationModule`의 `SessionAuthGuard` 의존성을 해석하지 못해 기동에 실패했다. `AutomationModule` compile regression test를 추가하고 `AuthModule` import로 수정했다.
3. production Gateway 연결 과정에서 claim 완료 대기, production Gateway 시작 연결, active MQTT certificate ledger, trusted E2E clock, 기존 setup publisher와 production Gateway 사이 event sequence handoff가 빠진 상태를 차례로 실제 DB/MQTT RED로 확인했다.
4. schedule과 event가 적용된 뒤 수동 60% 명령은 `/api/commands/dimming` 500으로 실패했다. Prisma nested `ManualOverrideFixtureCreateManyManualOverrideInput`은 `fixtureId`만 허용하는데 부모 복합 FK `siteId`, `gatewayId`를 중복 전달한 것이 원인이었다. 기존 commands 단위 테스트의 기대값을 먼저 변경해 RED를 확인하고 최소 수정했다.

## GREEN

- `software-automation-simulator.test.ts`: production exact throw, 비활성 조건, dimming/lighting observation, trusted test clock, detected/cleared Sensor Status, token 검증 private IPC, strict fixture 환경 parser를 포함해 `7/7` 통과했다.
- `automation.module.spec.ts`: production controller authentication guard를 포함한 실제 Nest module compile을 통과했다.
- `commands.service.spec.ts`: nested fixture snapshot 계약 수정 후 `23/23` 통과했다.
- Chromium은 `schedule 40% -> event detected 80% -> manual override 60% -> override 만료 후 event 80% -> clear와 5초 hold 후 schedule 40%`를 UI, DB, MQTT telemetry에서 모두 확인했다.

## Process topology

1. Playwright worker가 `RealBackendLab`을 소유한다.
2. Lab은 매 실행마다 별도 PostgreSQL socket/port `15432`, Redis `16379`, mTLS Mosquitto `18883`을 시작한다.
3. Lab은 migration과 operator bootstrap 뒤 production API dist를 `14000`, Vite Web을 `15173`에서 child process로 시작한다.
4. 기존 등록용 MQTT publisher가 UI 설치, Gateway claim, 두 Fixture provisioning과 초기 state를 완료한다.
5. 등록 publisher의 마지막 event sequence를 별도 Gateway state 파일에 넘기고 publisher를 종료한다.
6. Playwright worker는 실제 발급된 Gateway client certificate와 assignment를 사용해 production `apps/gateway/dist/gateway.mjs`를 child process로 시작한다.
7. Gateway는 production MQTT runtime, snapshot activation, scheduler, priority arbiter, automation telemetry를 그대로 사용하고 BLE adapter만 명시적인 test simulator로 교체한다.
8. 센서 edge는 Playwright worker와 Gateway child 사이의 token 검증 Node child IPC message로만 전달한다. HTTP route, UI action, public API endpoint, network listener는 없다.

## DB 증거

최종 successful run의 `automation-database-evidence.json`:

```json
{
  "siteId": "6c213f34-42ba-473e-a36d-14310e16a05c",
  "gatewayId": "261b403b-98cc-4b9c-9b54-e3a55196c744",
  "scheduleCount": 1,
  "vehicleEventRuleCount": 1,
  "manualOverrideCount": 1,
  "automationExecutionCount": 9,
  "desiredRevision": 2,
  "appliedRevision": 2,
  "syncStatus": "APPLIED",
  "targetBrightness": 40,
  "sensorCapability": "supported"
}
```

API는 실제 PostgreSQL transaction으로 schedule, vehicle event rule, manual override와 fixture snapshot을 저장했다. `GatewayAutomationConfiguration`의 desired/applied revision은 모두 `2`이며 최종 상태는 `APPLIED`다.

## MQTT 증거

- broker: lab CA와 CRL을 요구하는 실제 Mosquitto mTLS listener
- API principal: lab API certificate
- Gateway principal: claim된 Gateway ID가 CN인 실제 client certificate
- certificate authorization: 발급 X509 serial, SHA-256 fingerprint, issuer, validity를 active `GatewayCertificate` ledger에 저장
- 수집한 evidence record: 136건
- `/commands/automation/config-sync`: 2건
- `/events/automation/config-applied`: 2건
- `/events/automation/execution`: 18건. QoS 1 재전달을 포함하며 DB 원장은 immutable identity로 9건이다.
- `/events/automation/vehicle-sensor-capability`: 1건
- `/commands/dimming`: 1건
- `/state/fixtures`: 14건

MQTT evidence에는 config applied application ACK, execution ingested ACK, vehicle sensor capability ACK, fixture state application ACK도 포함된다.

## 실행 명령과 결과

```bash
pnpm --filter @led-control/gateway test -- software-automation-simulator.test.ts
# GREEN: 7 passed

pnpm --filter @led-control/api exec jest src/commands/commands.service.spec.ts --runInBand
# RED 1, GREEN 23 passed

pnpm --filter @led-control/web exec playwright test e2e/automation-control-flow.spec.ts --project=chromium
# 최종 focused GREEN: 1 passed

pnpm --filter @led-control/web exec playwright test e2e/real-backend-lab-support.spec.ts --project=chromium
# GREEN: 8 passed

pnpm typecheck && pnpm test && pnpm --filter @led-control/web exec playwright test e2e/automation-control-flow.spec.ts --project=chromium
# exit 0
# root node tests 15 passed
# mobile 1, shared 133, automation-engine 28, Web 352, API 728, Gateway 554 passed
# Chromium 1 passed
```

`pnpm test`의 기존 API opt-in integration suite 18개, test 159개는 기존 조건에 따라 skipped로 집계됐다. Task 19 Chromium spec에는 `test.skip`이 없고 PostgreSQL, Redis, Mosquitto, certificate, API, Web 또는 Gateway setup 실패는 모두 test failure로 전파된다.

## Cleanup

- success와 startup failure 모두 child process group을 역순으로 종료한다.
- MQTT handler를 drain하고 observer와 publisher를 bounded close한 뒤 API, Web, Gateway, PostgreSQL, Redis, Mosquitto process group을 정리한다.
- IPC pending request는 timeout 또는 child exit/cleanup에서 모두 reject하고 timer를 해제한다.
- latest run 종료 뒤 `15173`, `14000`, `15432`, `16379`, `18883`은 모두 free이며 Task 19 child process와 최근 lab run directory는 남지 않았다.
- dependency setup 실패 시 관련 process log tail을 failure message에 포함하고 동일 cleanup을 수행한다.

## Production fail-closed

- simulator factory는 `NODE_ENV=test`와 `AUTOMATION_E2E_SIMULATOR=1`이 모두 정확히 설정된 경우에만 instance를 만든다.
- `createSoftwareAutomationSimulator({ nodeEnv: "production", enabled: true })`는 정확히 `software automation simulator is forbidden in production`을 throw한다.
- simulator가 활성화됐지만 private child IPC가 없으면 Gateway는 `software automation simulator requires private child IPC`로 시작을 거부한다.
- `scripts/dev.mjs`는 simulator flag가 있는 일반 개발 시작을 거부한다.
- production 기본 경로의 `createProductionAdapters`, BlueZ requirement와 certificate rotation은 simulator가 비활성일 때 변경되지 않는다.

## 우려사항

- 실제 Raspberry Pi BlueZ Mesh와 ESP32-H2의 provisioning, RF Sensor Status/vendor event, packet loss/retry, reboot, power-loss 및 실제 밝기 왕복 HIL은 미실행이다.
- software adapter가 같은 물리 관측을 mesh publication과 automation terminal state로 연속 발행할 때 API는 더 늦게 도착한 과거 `occurredAt`을 `reverse_time`으로 ACK한다. Latest run에서 동시 state transaction의 `UNEXPECTED_ERROR/P2028` 로그와 QoS 1 재전달이 있었지만 immutable event가 최종 ACK됐고 DB revision, execution 9건과 최종 40%는 수렴했다. 이 production ingest contention 로그는 HIL과 장시간 broker 시험에서 관찰할 필요가 있다.

---

## Fix Round 1 결과

기준일: 2026-08-31

- 상태: 리뷰 P1 4건, P2 3건 수정 완료
- 최종 Chromium: `1 passed (44.3s)`, test body `22.3s`
- 최종 execution oracle: production Gateway unique event `10`, API exact ACK `10`, PostgreSQL row `10`
- 최종 API/Gateway clean-log gate: `UNEXPECTED_ERROR`, `P2028`, inbound ingest failure, pending execution ACK 모두 `0`
- 이 절의 최종 증거가 위 최초 Task 19 결과의 execution 9건 및 P2028 허용 기록을 대체한다.

### Fix Round 1 RED

1. P1-1 focused API test에서 Gateway manual payload의 `sourceId=commandId`와 별도 `ManualOverride.id`를 사용하자 consumer가 manual execution을 생성하지 못했다. Consumer를 command lookup으로 바꾼 뒤 실제 E2E는 기존 DB trigger가 command ID와 override PK를 직접 비교해 PostgreSQL `23514 manual execution cannot contain ruleId`를 발생시키는 두 번째 RED를 드러냈다.
2. P1-2 기존 eventually assertion을 deadline 양쪽 assertion으로 바꾸자 고정된 test clock이 실제 경과 시간을 반영하지 않아 expiry 직전 기대 60% 대신 80%가 관찰됐다. Clock을 live elapsed time과 controlled offset의 합으로 바꾼 뒤에는 상대 4,999ms advance 전에 DB 대기 시간이 지나 hold deadline을 넘는 RED가 발생해, DB `event_extended.payload.holdUntil` 절대 시각을 기준으로 advance하도록 교정했다.
3. P1-3 RealBackendLab handoff test는 기존 구현이 publisher background promise 완료 전에 MQTT close와 child start로 진행하는 것을 RED로 확인했다. Background error와 close callback timeout도 기존 helper가 성공으로 삼았다.
4. P1-4 원래 Chromium 증거에서 unique execution 10건 중 manual ACK가 pending이고 API에 `UNEXPECTED_ERROR/P2028`가 남았다. Gateway별 일반 automation ingest와 fixture custom PUBACK ingest를 동시에 시작하는 focused test도 transaction 동시 진입을 RED로 확인했다.
5. P2-1 oracle test는 lab 자기 발행 event와 ACK/DB 일부만 있어도 aggregate count가 통과하는 기존 동작을 RED로 고정했다.
6. P2-2 IPC disconnected channel test는 channel이 끊긴 뒤에도 sensor injection이 실행되는 것을 RED로 확인했다. Wrong/missing token, malformed type/request/fixture/edge, unknown fixture도 각각 no-injection 또는 strict error response 계약으로 고정했다.
7. P2-3 simulator의 MQTT identity no-op을 제거한 첫 Chromium run은 production identity validation에서 invalid bootstrap URL로 실패했다. HTTPS bootstrap 설정과 실제 identity store layout, certificate/key/CA/current generation을 제공한 뒤 production identity/rotation startup을 유지했다.

### Fix Round 1 GREEN

- API consumer는 manual payload `sourceId`를 `ManualOverride.commandId`로 Site/Gateway 범위 조회하고, 찾은 실제 override PK를 `AutomationExecution.manualOverrideId`에 저장한다.
- 순방향 migration `20260904_bind_manual_execution_command_source`는 manual action의 `payload.sourceId=Command.id`와 `AutomationExecution.manualOverrideId=ManualOverride.id`를 `ManualOverride.commandId` 조인으로 결속한다.
- API MQTT inbound는 Site/Gateway별 최대 256개의 bounded serial queue를 공유한다. 일반 automation handler와 fixture custom PUBACK ingest가 같은 queue를 사용해 같은 Gateway의 transaction을 직렬화하고, capacity 초과는 명시적으로 실패한다.
- Simulator clock은 실제 경과 시간과 controlled offset을 함께 사용하며 한 요청 최대 24시간만 전진한다. Clock advance와 sensor edge는 exact token을 요구하는 private child IPC만 사용하고, clock 응답 전에 production schedule tick이 끝난다.
- Publisher handoff는 MQTT handler와 모든 background task를 bounded drain하고 background error를 전파한 뒤 strict close callback 완료를 확인한다. 그 뒤에만 최종 event sequence를 state file에 저장하고 production Gateway를 시작한다.
- Readiness heartbeat는 production Gateway child PID, Site/Gateway, serial, firmware payload에 결속한다. Lab publisher나 이전 observer record는 readiness를 만족시키지 못한다.
- Oracle은 production Gateway child PID가 발행한 execution만 event ID/sequence로 dedupe하고 duplicate payload exact equality를 요구한다. 각 event의 exact API ACK와 DB row, revision/kind/rule/occurrence/payload/hash/source FK를 일대일 비교하며 lab 자기 발행, partial ACK와 pending ACK는 실패한다.

### 실제 process topology

1. Playwright worker가 매 run 전용 RealBackendLab과 private IPC token을 소유한다.
2. Lab은 격리 PostgreSQL, Redis, CRL 검증 mTLS Mosquitto를 시작하고 모든 Prisma migration을 적용한다.
3. Production API dist와 Vite Web을 child process로 기동한다.
4. Test publisher는 UI 설치, Gateway claim, 두 fixture provisioning과 초기 telemetry만 담당한다.
5. Production Gateway handoff 전에 publisher handler/background task와 MQTT close를 strict drain한다. 완료된 최종 event sequence만 Gateway state file로 전달한다.
6. Lab은 claim된 Gateway CN certificate, key, CA와 device/MQTT identity store generation/current symlink를 실제 production 경로에 제공한다. Gateway는 production identity validation과 certificate rotation startup을 실행하고 mTLS Mosquitto에 연결한다.
7. Production Gateway runtime은 production MQTT, snapshot activation, scheduler, manual/event priority, telemetry outbox를 그대로 사용한다. BLE Mesh adapter만 두 fixture의 software simulator다.
8. Sensor edge와 clock advance는 Playwright worker에서 Gateway child의 private Node IPC로만 전달된다. HTTP/UI/public API/network listener는 없다.
9. Observer는 production Gateway child PID event와 API ACK를 분리 기록한다. 최종 oracle과 evidence write가 끝난 뒤 Gateway/API/Web/broker/DB/Redis를 역순 정리한다.

### DB/MQTT exact evidence

최종 run scope:

```json
{
  "siteId": "37ed546b-7a1f-4428-8b0d-5e680a961256",
  "gatewayId": "2f120cb4-6472-4263-8554-5c00b37b69ed",
  "scheduleCount": 1,
  "vehicleEventRuleCount": 1,
  "manualOverrideCount": 1,
  "automationExecutionCount": 10,
  "desiredRevision": 2,
  "appliedRevision": 2,
  "syncStatus": "APPLIED",
  "targetBrightness": 40,
  "sensorCapability": "supported",
  "uniqueProductionEventCount": 10,
  "uniqueAckCount": 10,
  "databaseRowCount": 10
}
```

Manual exact binding:

```json
{
  "eventId": "cad431ce-d3dd-4bf5-96e9-869e501a1179",
  "sequence": 6,
  "payloadSourceId": "69be4770-c594-46e8-ab28-c5a9dad10703",
  "manualCommandId": "69be4770-c594-46e8-ab28-c5a9dad10703",
  "manualOverrideId": "5f2745fa-c172-4cd7-8862-8205e3a274a7",
  "payloadHash": "sha256:6ff3b5e8182f77321d37476bfa5b12cb3aafee0840997003ad6e3b35a3473a51"
}
```

Production Gateway PID `44186`의 action sequence는 `schedule 40(seq 2, rev 1) -> vehicle 80(seq 5, rev 2) -> manual 60(seq 6, rev 2) -> vehicle 80(seq 7, rev 2) -> schedule 40(seq 10, rev 2)`다. Lifecycle을 포함한 sequence 1~10 모두 동일 event ID/sequence의 API ACK가 있고 각 ACK `reportPayloadHash`는 DB `payloadHash`와 같다.

통제 시계의 시간/원인 순서:

| 순서 | phase | 원인 | 밝기 |
| --- | --- | --- | --- |
| 1 | manual expiry 998ms 전 | `manual_override_active` | 60 |
| 2 | expiry 15ms 후 | `manual_override_expired_vehicle_priority_resumed` | 80 |
| 3 | clear 직후 | `vehicle_hold_started` | 80 |
| 4 | DB hold deadline 999ms 전 | `vehicle_hold_active` | 80 |
| 5 | hold deadline 13ms 후 | `vehicle_hold_expired_schedule_resumed` | 40 |

### 실행 명령과 결과

```bash
pnpm --filter @led-control/api exec jest src/automation/automation-mqtt-consumer.service.spec.ts src/mqtt/mqtt-v2-state.spec.ts src/mqtt/mqtt.service.spec.ts src/mqtt/mqtt-shutdown-coordinator.spec.ts --runInBand
# 4 suites, 92 passed

pnpm --filter @led-control/api exec jest src/automation/automation-schema.spec.ts --runInBand
# schema contract 19 passed; opt-in PostgreSQL cases 37 skipped
# 같은 forward migration은 아래 RealBackendLab 새 PostgreSQL에 실제 적용됐다.

pnpm --filter @led-control/gateway exec vitest run src/automation/software-automation-simulator.test.ts
# 11 passed

E2E_REAL_BACKEND_LAB=1 pnpm --filter @led-control/web exec playwright test e2e/real-backend-lab-support.spec.ts --project=chromium
# 12 passed

pnpm typecheck && pnpm test
# exit 0
# root 15, mobile 1, shared 133, automation-engine 28, Web 352, API 732, Gateway 558 passed

TZ=UTC E2E_REAL_BACKEND_LAB=1 pnpm --filter @led-control/web exec playwright test e2e/automation-control-flow.spec.ts --project=chromium
# 1 passed (44.3s), test body 22.3s
```

첫 전체 명령 시도는 workspace의 Web/automation-engine pretypecheck가 shared build cleanup을 동시에 시작해 기존 `unlink ENOENT` race로 중단됐다. 코드 변경 없이 같은 요구 명령을 재실행해 exit 0과 위 전체 결과를 얻었다.

### Cleanup

- 최종 run 종료 뒤 `15173`, `14000`, `15432`, `16379`, `18883` listener는 모두 `0`건이다.
- `/tmp/led-control-e2e-*` lab directory는 `0`건이며 production Gateway/API/Web/PostgreSQL/Redis/Mosquitto child가 남지 않았다.
- Handoff와 final teardown은 pending IPC request, handler/background publish, observer/publisher MQTT close를 bounded drain한다. Background error나 close timeout은 test failure로 전파한다.
- Dependency setup, migration, mTLS, child readiness 실패에는 skip이 없고 startup error와 cleanup error를 함께 보고한다.

### Production fail-closed

- Built `apps/gateway/dist/gateway.mjs`를 `NODE_ENV=production AUTOMATION_E2E_SIMULATOR=1`로 실행한 결과 exit code `1`, exact line `software automation simulator is forbidden in production`을 다시 확인했다.
- Simulator는 `NODE_ENV=test`와 `AUTOMATION_E2E_SIMULATOR=1`이 모두 exact일 때만 생성되고 private child IPC가 없으면 startup을 거부한다.
- Wrong/missing token, malformed type/request/fixture/edge는 injection과 response가 없고, unknown fixture는 no-injection strict failure response, disconnected channel은 no-injection/no-response다.
- Production 기본 adapter, identity validation, certificate rotation 코드는 simulator 분기에서도 우회하지 않는다. Public remote-control surface는 추가하지 않았다.

### Fix Round 1 우려사항과 coverage 경계

- Software E2E는 유효한 사전 발급 certificate로 production identity store validation과 certificate rotation startup을 통과한다. Certificate가 갱신 threshold 밖이므로 bootstrap API 재발급과 live rotation activation은 이 run이 증명하지 않는다.
- BLE adapter와 sensor source는 software simulator다. 실제 Raspberry Pi/BlueZ, ESP32-H2 firmware/RF, packet loss, reboot/power-loss HIL은 별도 검증 범위다.
- Fixture의 동일 물리 변화에서 mesh publication과 reported state가 연속 도착하면 API가 후행 과거 timestamp를 documented `reverse_time`으로 ACK할 수 있다. 이 상태는 latest snapshot을 퇴행시키지 않으며 Fix Round 1 clean error gate의 실패 패턴은 아니다.
- Workspace shared build cleanup은 동시 pretypecheck에서 드물게 `unlink ENOENT` race가 있다. 재실행은 통과했지만 build tooling 자체의 원자성 보강은 Task 19 범위 밖이다.
