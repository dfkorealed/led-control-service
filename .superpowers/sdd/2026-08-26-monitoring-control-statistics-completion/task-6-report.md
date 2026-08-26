# Task 6 제어 요청 멱등성 구현 보고서

## 구현 결과

- API는 `(siteId, requestedBy, clientRequestId)`로 기존 명령을 먼저 조회한다.
- 동일 `clientRequestId`와 동일 canonical payload는 기존 `Command`와 기존 dispatch 정보를 반환하며 새 sequence, dispatch, outbox를 만들지 않는다.
- 동일 `clientRequestId`에 다른 target 또는 brightness가 들어오면 `409`와 `client_request_id_payload_conflict`를 반환한다.
- 동시 생성이 `P2002`로 충돌하면 실패한 transaction을 재사용하지 않고 새 transaction에서 기존 명령을 조회해 수렴한다. 다른 unique constraint 오류는 그대로 전달한다.
- 다중 조명 target은 fixture ID를 안정 정렬한 뒤 API 전송, fingerprint 계산, `sessionStorage` 저장에 사용한다.
- Web은 POST 전에 `clientRequestId`와 canonical payload를 현장 범위 `sessionStorage`에 저장한다. POST 응답을 잃으면 입력을 잠그고 `동일 요청 다시 전송`으로 같은 요청을 재사용한다.
- 명령 ID를 받은 뒤에도 요청 정보를 유지하고, 장비 결과가 terminal이 된 뒤에만 활성 명령 저장값을 제거한다. 기존 `{ commandId }` 저장 형식도 계속 복원한다.

## RED

- API service focused: 동일 요청이 두 개의 command/outbox를 생성하고, payload 충돌이 성공하며, 동시 `P2002`가 그대로 전파되는 3개 실패를 확인했다.
- Web focused: 요청 저장 API 부재, POST 응답 유실 뒤 재전송 버튼 부재, canonical payload 미보존 실패를 확인했다.
- Web production build: shared CommonJS의 runtime Zod named export를 Vite가 해석하지 못하는 실패를 확인했다. shared 경계를 수정하지 않고 허용 범위의 저장소 구조 검증기로 교체했다.

## GREEN 및 검증

- `pnpm --filter @led-control/api test -- src/commands/commands.service.spec.ts --runInBand`: 14개 통과
- `pnpm --filter @led-control/api test -- src/commands --runInBand`: 35개 통과, PostgreSQL 환경 의존 3개 skip
- `pnpm --filter @led-control/api test -- --runInBand`: 490개 통과, 32개 skip
- `pnpm --filter @led-control/api typecheck`: 통과
- `pnpm --filter @led-control/api build`: 통과
- `pnpm --filter @led-control/web test -- src/api/commands.test.ts src/features/control/active-command-store.test.ts src/features/control/ControlView.test.tsx`: 52개 통과
- `pnpm --filter @led-control/web typecheck`: 통과
- `pnpm --filter @led-control/web build`: 통과. 기존 PDF 및 main chunk 크기 경고만 남는다.
- `git diff --check`를 Task 6 파일 범위에 실행해 통과했다.

## 전체 Web 회귀의 격리 이슈

전체 Web 테스트는 215개 중 214개가 통과했고 `App.test.tsx` 1개가 실패했다. 직전 App 테스트가 terminal이 아닌 제어 요청을 `sessionStorage`에 남기는데 `afterEach`가 storage를 초기화하지 않아 다음 테스트가 의도대로 제어 잠금 상태를 복원한 것이 원인이다. 제품 코드의 응답 유실 보존 계약과 focused 테스트는 통과했다. `App.test.tsx`는 이번 독립 write scope 밖이므로 수정하거나 stage하지 않았으며, 상위 통합 단계에서 테스트 간 `sessionStorage.clear()`를 추가해야 한다.

## HIL 및 브라우저 한계

- Raspberry Pi, MQTT broker, ESP32-H2를 사용한 HIL은 실행하지 않았다.
- 이번 Task는 cloud/Web 요청 멱등성 범위이며 자동 테스트에서 command/outbox 중복 방지와 응답 유실 재전송을 검증했다.
- 실제 브라우저의 네트워크 응답 차단과 실장비 terminal ACK 왕복은 Task 7 브라우저 QA 및 최종 HIL에서 확인해야 한다.

## 범위 준수

- `ec9011b`의 group 동작 및 MQTT/outbox 구현 파일은 수정하지 않았다.
- 동시에 진행 중인 MQTT shutdown, mesh worker, `docs/menus/control.md`, `docs/menus/monitoring.md` 변경은 stage하지 않는다.
