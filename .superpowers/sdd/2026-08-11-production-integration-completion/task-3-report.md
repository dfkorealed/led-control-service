# Task 3 보고서 - Gateway reconnect 생명주기와 오류 경계

## 상태

완료

## 변경 파일

- `apps/gateway/src/runtime/gateway-mqtt-runtime.ts`, `apps/gateway/src/runtime/gateway-mqtt-runtime.test.ts`
  - MQTT listener, heartbeat timer, session-aware subscription과 shutdown을 `GatewayMqttRuntime.start()`/`stop()`으로 소유한다. reconnect마다 기존 timer를 정리하고, topic handler의 sync/async 오류와 error reporter의 rejection을 event loop 밖으로 누출하지 않는다.
- `apps/gateway/src/index.ts`, `apps/gateway/src/index.test.ts`
  - 기존 inline MQTT listener를 runtime callback으로 교체했다. SIGTERM/SIGINT는 runtime stop 완료 후 종료하며, stop 실패는 exit code 1로 처리한다.
- `docs/menus/monitoring.md`
  - 실제 gateway reconnect, persistent session subscription, handler 오류 경계와 shutdown cleanup 상태를 기록했다. 기존 `미구현` 목록은 변경하지 않았다.

## Red-Green 증거

- RED: `pnpm --filter @led-control/gateway test -- --run src/runtime/gateway-mqtt-runtime.test.ts src/index.test.ts`
  - exit `1`; runtime 모듈과 shutdown helper가 없어 import/behavior 테스트가 실패했다.
- GREEN: 같은 focused test command가 exit `0`; reconnect 후 heartbeat timer 1개, 신규 session 한 번만 subscribe, 네 topic handler rejection의 `onMessageError` 전달, unhandled rejection 부재, stop cleanup과 SIGTERM shutdown을 검증했다.
- RED: MQTT client shutdown error test는 stop Promise가 resolve되어 exit `1`로 실패했다.
- GREEN: MQTT.js callback error를 stop Promise rejection으로 전파한 뒤 targeted tests와 gateway typecheck가 exit `0`으로 통과했다.

## 테스트

- `pnpm --filter @led-control/gateway test`: exit `0`, 33 files / 131 tests passed.
- `pnpm --filter @led-control/gateway typecheck`: exit `0`.
- `git diff --check`: exit `0`.

## 커밋

- `fix(gateway): harden mqtt reconnect lifecycle`

## 남은 범위

- MQTT 인증서 교체 중 client의 원자적 교체와 실제 health probe는 Task 4 범위다.
- Raspberry Pi/ESP32-H2 실장비 reconnect/HIL 증거는 자동 runtime lifecycle 테스트와 별도로 남겨야 한다.
