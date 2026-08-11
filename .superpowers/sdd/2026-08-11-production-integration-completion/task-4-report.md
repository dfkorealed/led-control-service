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

## Fix Round 1

### Review finding 대응

- Critical 1 - 동일 stable client ID takeover 중 command 유실:
  - `GatewayMqttRuntime.activate()`가 candidate `message` listener를 connect 이전에 부착한다. connect와 강제 subscribe 사이에 받은 command는 임시 buffer에 보관하고, identity commit과 runtime cutover가 성공한 뒤 순서대로 dispatch한다.
  - cutover 또는 identity commit 실패 시에도 buffer를 기존 runtime handler로 replay하고 candidate를 종료한다.
  - `gateway-mqtt-runtime.test.ts`는 CONNECT 후 SUBACK 전 message 이벤트를 발생시켜 실제 이벤트 순서에서 command가 한 번 처리되는지 검증한다.
- Critical 2 - runtime/disk pointer split-brain:
  - `MqttIdentityStore.prepare()`는 pending candidate만 만들고, `PreparedMqttIdentity.commit/rollback/finalize`가 pointer 전환, 이전 pointer 복구, 이전 generation 정리를 분리한다.
  - runtime은 candidate ready 후 transaction `commit()`을 실행하고, disk commit 실패 시 `rollback()`과 candidate 종료를 완료한 뒤 기존 client/identity를 유지한다.
  - `mqtt-identity-store.test.ts`는 prepare 동안 current pointer 유지, commit 뒤 rollback 복구, pointer rename 실패 뒤 candidate cleanup을 검증한다. runtime test는 commit 실패와 buffered command replay를 검증한다.
- Important 1 - readiness timeout, activate/stop race, rotation ownership:
  - candidate readiness는 기본 10초(1~60초만 허용) timeout을 사용한다. activation/stop은 단일 promise queue로 직렬화하고 stop은 진행 중 candidate를 즉시 취소·종료한다.
  - `CertificateRotation.stop()`은 timer를 취소하고 running rotation 완료를 기다린다. SIGTERM/SIGINT shutdown handler는 rotation과 runtime을 함께 stop한다.
  - runtime timeout/race, rotation timer cancel, shutdown ownership 테스트를 추가했다.
- Important 2 - cached BlueZ path를 health로 신뢰:
  - `bluezAttached`는 cached path가 있어도 private D-Bus의 `org.freedesktop.DBus.Introspectable.Introspect`로 `org.bluez.mesh.Node1` interface를 다시 확인한다.
  - `adapter-factory.test.ts`는 Node1 interface가 없을 때 unhealthy probe가 되는 경우를 검증한다.
- Important 3 - future heartbeat와 잘못된 heartbeat interval fail-open:
  - `ApplianceHealth`와 gateway startup은 `GATEWAY_HEARTBEAT_MS`를 양의 유한 정수(최대 24시간)로 검증한다. future heartbeat는 stale로 처리한다.
  - container healthcheck state script도 같은 범위 검증과 `age < 0` 거부를 수행한다. shell behavior test는 stale/future timestamp와 `NaN`, `Infinity`, 0, 음수 interval을 모두 실패시킨다.

### Fix Round 1 검증

- `pnpm --filter @led-control/gateway test`: exit `0`, 33 files / 152 tests passed.
- `pnpm --filter @led-control/gateway typecheck`: exit `0`.
- `pnpm --filter @led-control/gateway test:contracts`: exit `0`, 9 tests passed.
- `sh -n apps/gateway/docker/healthcheck.sh`, `sh -n apps/gateway/docker/entrypoint.sh`, `git diff --check`: exit `0`.

## Fix Round 2

### Critical finding 대응

- Critical 1 - same client ID takeover, buffered replay와 old reconnect 경합:
  - rotated client는 `manualConnect: true`로 생성한다. runtime은 candidate `reconnect()` 전에 현재 stable client를 `end(true)`로 quiesce하여 자동 reconnect가 candidate readiness 중 broker session을 다시 빼앗지 못하게 한다.
  - candidate `message` listener는 SUBACK/identity commit 대기 중에도 기존 command handler를 즉시 호출한다. 따라서 MQTT.js PUBACK 뒤에 application buffer를 다시 replay하지 않는다. QoS 1 redelivery는 기존 command journal의 idempotency key로 물리 실행을 한 번으로 수렴시킨다.
  - rollback이 정상일 때만 old client를 명시적으로 reconnect하고, candidate 종료와 local payload replay 사이의 중복 경로를 제거했다.
  - `gateway-mqtt-runtime.test.ts`는 old `end(true)` -> candidate `reconnect()` -> candidate CONNECT/message -> identity failure -> candidate end -> old reconnect -> broker redelivery 순서를 발생시켜 delivery는 두 번 가능하지만 journal side effect는 한 번임을 검증한다.
- Critical 2 - pointer write/fsync 뒤 previous restore failure의 dangling symlink:
  - `MqttIdentityStore`는 pointer rename 성공 뒤 fsync가 실패하면 `pointerMayReferenceCandidate`를 유지한다. rollback은 previous pointer 복구가 성공한 경우에만 candidate generation을 삭제한다.
  - rollback 복구도 실패하면 `MQTT identity rollback is unsafe`를 반환하고 candidate generation을 보존한다. runtime은 이 transaction rollback 실패를 MQTT fail-closed 상태로 수렴시켜 old identity를 재연결하지 않는다.
- `mqtt-identity-store.test.ts`는 candidate pointer rename 성공, pointer fsync 실패, previous pointer restore 반복 실패를 순서대로 주입해 `current`가 유효한 candidate generation을 계속 가리키는지 검증한다.

### Fix Round 2 검증

- `pnpm --filter @led-control/gateway test`: exit `0`, 33 files / 153 tests passed.
- `pnpm --filter @led-control/gateway typecheck`: exit `0`.
- `pnpm --filter @led-control/gateway test:contracts`: exit `0`, 9 tests passed.
- `sh -n apps/gateway/docker/healthcheck.sh`, `sh -n apps/gateway/docker/entrypoint.sh`, `git diff --check`: exit `0`.

## Fix Round 3

### Critical finding 대응

- Critical 1 - candidate immediate dispatch가 quiesced old client를 사용하고 post-CONNACK rollback이 ACK된 command를 replay할 수 있음:
  - runtime transition을 `old quiesce -> identity commit -> currentClient=candidate -> candidate reconnect`으로 변경했다. candidate는 identity commit 전에 broker CONNECT/PUBLISH를 받을 수 없다.
  - candidate CONNECT 전의 connection/timeout 오류만 identity rollback, candidate 종료, old reconnect를 수행한다. CONNECT가 한 번이라도 발생하면 candidate가 disk/runtime의 authoritative identity가 되며, forced subscription 오류는 old session으로 rollback하지 않고 candidate를 fail-closed 한다.
  - topic handler signature에 source MQTT client를 추가했다. dimming acceptance/status/fixture-state와 scan/provision 결과 publish는 모두 message source client를 사용하며 identify handler도 source-client contract를 받는다.
  - `gateway-mqtt-runtime.test.ts`는 `commit -> candidate reconnect -> CONNACK -> SUBACK failure`에서 rollback/old reconnect가 발생하지 않는지 검증한다. 같은 파일은 dimming, scan, identify, provision 네 topic을 candidate SUBACK 대기 중에 순서대로 전달해 source가 candidate이고 각 handler/publish가 한 번씩만 실행되는지 검증한다. 기존 stop/activation race test도 유지한다.

### Fix Round 3 검증

- `pnpm --filter @led-control/gateway test`: exit `0`, 33 files / 154 tests passed.
- `pnpm --filter @led-control/gateway typecheck`: exit `0`.
- `pnpm --filter @led-control/gateway test:contracts`: exit `0`, 9 tests passed.
- `sh -n apps/gateway/docker/healthcheck.sh`, `sh -n apps/gateway/docker/entrypoint.sh`, `git diff --check`: exit `0`.
## Fix Round 4

- Runtime의 CONNACK 이후 실패가 바깥 certificate rotation catch에서 identity rollback으로 되돌아가던 경계를 수정했다.
- `PreparedMqttIdentity.isCommitted()`를 추가해 runtime이 이미 pointer를 확정한 경우 rollback하지 않고 candidate generation을 유지·정리한다.
- 회귀 테스트는 post-CONNACK 실패를 모사해 old identity 복귀, non-idempotent command 재전달 위험과 runtime/disk identity 분리를 차단한다.
- 검증: certificate rotation, identity store, MQTT runtime, index 테스트 47건과 gateway typecheck, `git diff --check` 통과.

## Fix Round 5

- `isCommitted` 메모리 플래그만으로 authoritative identity를 판단하지 않고 실제 `current` symlink가 candidate generation을 가리키는지 확인한다.
- pointer 복구 중 fsync가 실패했지만 실제 pointer는 old generation인 경우 candidate finalize로 old generation을 삭제하지 않는다.
- fault-injection 회귀를 포함한 관련 테스트 48건, gateway typecheck와 `git diff --check`를 통과했다.
