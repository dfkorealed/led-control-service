# Task 6 Fix Round 1 구현 보고서

## 결과

`task-6-rereview.md`의 Important 3건을 모두 수정했다.

- 제어 복구 저장소를 `(authenticated userId, siteId)` 범위로 격리했다. 같은 탭과 현장에서도 다른 사용자의 pending 요청이나 command ID를 복원하지 않는다.
- 로그아웃 시 현재 사용자의 복구 레코드만 제거한다. 다른 사용자 레코드는 유지한다.
- `400~499` 확정 거부는 client request ID를 비교해 pending 레코드를 제거하고 입력 잠금을 해제한다. `403`과 `409`는 사용자가 원인을 구분할 수 있는 문구를 표시한다.
- 네트워크 오류, 응답 유실, 재시도 가능한 `5xx`는 canonical payload와 기존 client request ID를 보존해 동일 요청 재전송을 유지한다.
- POST마다 `AbortController`와 사용자·현장 generation을 부여했다. 사용자 또는 현장 전환 시 이전 요청을 abort하고, 지연된 성공·실패 콜백은 새 화면 상태와 저장소를 덮어쓰지 않는다.

## RED

구현 전 focused 테스트에서 다음 실패를 확인했다.

- 저장 API가 사용자 범위를 받지 않아 동일 현장의 사용자 A 요청이 사용자 B에게 노출됐다.
- `clearActiveCommandRequest`, `clearActiveCommandsForUser`가 없어 확정 거부와 로그아웃 정리가 실패했다.
- `403`, `409`도 응답 유실로 남아 재전송 버튼과 전체 입력 잠금이 유지됐다.
- POST에 abort signal이 없고 지연된 이전 현장 결과가 현재 현장 상태를 변경했다.
- 결과: 96개 중 25개 실패, 71개 통과.

## GREEN

- 저장소 focused, ControlView, App 테스트: 96개 통과.
- 사용자 전환: 같은 현장의 다른 사용자 pending 요청을 복원하지 않음을 검증했다.
- 로그아웃: 인증 사용자 레코드만 제거하고 다른 사용자 레코드를 유지함을 검증했다.
- 현장 전환: 진행 중 POST signal abort와 지연 성공·실패 결과 무시를 각각 검증했다.
- 확정 실패: `403`, `409`에서 pending 삭제, 재전송 제거, UI 잠금 해제를 검증했다.
- 응답 유실: 정렬된 canonical payload와 동일 client request ID 재사용을 검증했다.

## 전체 검증

- `pnpm --filter @led-control/web test`: 22 suites, 224개 통과.
- `pnpm --filter @led-control/web typecheck`: 통과.
- `pnpm --filter @led-control/web build`: 통과. 기존 PDF/main chunk 크기 경고만 발생했다.
- `pnpm --filter @led-control/api test -- src/commands`: 6 suites, 35개 통과, PostgreSQL 환경 의존 3개 skip.
- `pnpm --filter @led-control/api typecheck`: 통과.
- `pnpm --filter @led-control/api build`: 통과.

## HIL 한계

- Raspberry Pi, MQTT broker, ESP32-H2 실장비 HIL은 이번 Fix Round에서 실행하지 않았다.
- 이번 수정은 Web 요청 복구와 화면 비동기 경계만 변경하며 MQTT, outbox, BLE Mesh 전송 코드는 변경하지 않았다.
- 실제 응답 유실 상태에서 게이트웨이까지 한 번만 전달되는지는 실장비 구성에서 네트워크 응답 차단 후 동일 client request ID 재전송과 terminal ACK를 수동 확인해야 한다.

## 범위 준수

- Task 4, MQTT, mesh, gateway, shared, Prisma 파일을 수정하거나 stage하지 않았다.
- 현재 작업 트리의 다른 에이전트 변경은 검증에 포함됐지만 본 커밋 대상에서 제외한다.
