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
