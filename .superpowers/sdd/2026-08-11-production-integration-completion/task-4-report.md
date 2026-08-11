# Task 4 보고서 - MQTT 인증서 rotation 전환과 실상태 healthcheck

## 상태

완료

## 변경 내용

- `apps/gateway/src/identity/certificate-rotation.ts`, `apps/gateway/src/identity/certificate-rotation.test.ts`
  - pending MQTT identity의 broker probe가 성공한 뒤에만 `activateMqttIdentity(candidate)` callback을 실행한다. callback 실패는 `MqttIdentityStore` pointer 교체 전의 installation failure가 되어 기존 generation을 유지한다.
- `apps/gateway/src/runtime/gateway-mqtt-runtime.ts`, `apps/gateway/src/runtime/gateway-mqtt-runtime.test.ts`, `apps/gateway/src/index.ts`, `apps/gateway/src/index.test.ts`
  - candidate mTLS client가 connect하고 command topic subscription callback까지 성공한 뒤 runtime client reference를 교체한다. 이전 listener/client 종료는 reference 교체 뒤에만 수행한다. candidate connect 실패는 기존 runtime client를 종료하지 않고 candidate만 종료해 MQTT.js 자동 재시도를 막는다.
  - publish 경로는 runtime의 현재 client를 사용하고, heartbeat health 시각은 MQTT publish callback 성공 뒤에만 갱신한다.
- `apps/gateway/src/adapters/adapter-factory.ts`, `apps/gateway/src/mesh/mesh-address-store.ts`, `apps/gateway/src/health/appliance-health.ts`, `apps/gateway/src/health/appliance-health.test.ts`
  - health state에 `dbusOwner`, `bluezAttached`, `hciPowered`, `mappingValid`, `lastHeartbeatPublishedAt`, `heartbeatFresh`를 기록한다. private D-Bus owner, 실제 Attach node path, HCI flags powered bit, mapping parse 결과와 heartbeat freshness를 기준으로 healthy를 판정한다.
- `apps/gateway/docker/healthcheck.sh`, `docs/runbooks/raspberry-pi-gateway-appliance.md`, `docs/menus/monitoring.md`
  - container healthcheck은 새 probe 필드와 마지막 heartbeat publish 시각을 검사한다. runbook과 모니터링 기능 현황에 rotation 실패 보존 계약과 장애 진단 기준을 반영했다.

## Red-Green 증거

- RED: `pnpm --filter @led-control/gateway test -- --run src/identity/certificate-rotation.test.ts src/health/appliance-health.test.ts src/runtime/gateway-mqtt-runtime.test.ts`
  - exit `1`; `activateMqttIdentity`, runtime `activate`, probe 기반 health API가 없어 4개 테스트가 실패했다.
- GREEN: 같은 focused test command가 exit `0`; 3 files / 14 tests가 통과했다.
- RED: `pnpm --filter @led-control/gateway test -- --run src/index.test.ts`
  - exit `1`; candidate 경로를 사용해 runtime activation을 만드는 helper가 없어 실패했다.
- GREEN: gateway entrypoint integration 후 관련 focused tests 5 files / 24 tests, typecheck, shell syntax check가 exit `0`으로 통과했다.

## 검증

- `pnpm --filter @led-control/gateway test`: exit `0`, 33 files / 136 tests passed.
- `pnpm --filter @led-control/gateway typecheck`: exit `0`.
- `sh -n apps/gateway/docker/healthcheck.sh`: exit `0`.
- `git diff --check`: exit `0`.

## 남은 범위

- Raspberry Pi에서 실제 HCI flags, private D-Bus owner/Attach와 broker certificate rotation을 사용하는 HIL/soak 증거는 별도 실기 관문으로 남는다.
