# 모니터링 수집 시각 신뢰성 P0 설계

## 목표

게이트웨이 시계가 크게 미래로 틀어진 상태 이벤트와 heartbeat가 에너지 집계 루프, checkpoint, 모니터링 freshness를 오염시키거나 같은 QoS 1 메시지의 무한 재전송으로 후속 이벤트를 막지 않게 한다.

## 확인된 원인

- 공통 v2 envelope는 `occurredAt`의 ISO 형식만 검사하고 API 수신 시각과의 허용 오차를 검사하지 않는다.
- fixture-state 수집은 장비 `occurredAt`을 에너지 checkpoint와 `Fixture.lastSeenAt`에 함께 저장한다. 먼 미래 시각은 날짜/시간 버킷 분할에 과도한 작업을 만들고 이후 freshness 만료를 막는다.
- heartbeat도 장비 `occurredAt`을 `Gateway.lastHeartbeatAt`에 저장해 gateway offline 판정을 무력화할 수 있다.
- MQTT fixture-state 처리 실패는 PUBACK 없이 연결을 닫는다. 영구적으로 거부해야 하는 poison 이벤트가 예외로만 끝나면 같은 gateway의 직렬 큐에서 계속 재전송되어 후속 메시지를 막는다.

## 결정

1. API가 한 메시지를 받기 시작한 시각을 `receivedAt`으로 한 번 확정한다. 기본 허용 미래 오차는 5분(`300_000ms`)이며 `occurredAt <= receivedAt + limit`는 허용하고 이를 1ms 초과하면 거부한다. `GATEWAY_EVENT_MAX_FUTURE_SKEW_MS`로 0 이상의 정수 밀리초를 설정할 수 있으며 잘못된 값은 시작/사용 시 fail closed 한다.
2. `ProcessedGatewayEvent`에 서버 `receivedAt`과 terminal 처리 상태를 additive migration으로 추가한다. 정상·stale·reverse·checkpoint 이벤트는 `accepted`, 허용 범위 초과 fixture-state/heartbeat는 `rejected_future_timestamp`로 기록한다. 기존 행은 `createdAt`을 수신 시각으로 backfill한다.
3. 장비 시각과 서버 수신 시각을 분리한다.
   - `Fixture.lastStateOccurredAt`, 에너지 cursor/checkpoint: 검증된 장비 `occurredAt`
   - `Fixture.lastSeenAt`: API `receivedAt`
   - `Gateway.lastHeartbeatOccurredAt`: 검증된 장비 `occurredAt`
   - `Gateway.lastHeartbeatAt`: API `receivedAt`
4. fixture-state는 scope/소유권을 잠금으로 검증한 뒤 미래 시각을 판정한다. 거부 이벤트는 payload hash와 terminal 상태만 원장에 커밋하고 에너지 cursor/aggregate/fixture snapshot에는 접근하지 않는다. MQTT는 이 결과를 application ACK의 `rejected_future_timestamp`로 발행하고 PUBACK하여 outbox head를 제거할 수 있게 한다.
5. heartbeat도 scope를 검증한 뒤 같은 원장 상태를 커밋한다. 미래 heartbeat는 Gateway freshness/sequence를 갱신하지 않지만 handler는 성공 종료해 broker PUBACK을 보낸다.
6. 동일 event 재전송은 canonical payload hash까지 일치해야만 기존 terminal 결과로 응답한다. 같은 identity에 다른 payload가 오면 conflict로 fail closed 한다.
7. freshness sweep은 fixture의 `lastSeenAt`, gateway의 `lastHeartbeatAt`만 사용한다. 두 값은 모두 서버 수신 시각이므로 장비 시계가 미래여도 stale/offline 판정을 미룰 수 없다.

## 스키마 및 호환성

- `ProcessedGatewayEvent.receivedAt DateTime @default(now())`
- `ProcessedGatewayEvent.ingestionStatus GatewayEventIngestionStatus @default(accepted)`
- enum: `accepted`, `rejected_future_timestamp`
- 기존 application state ACK enum에 `rejected_future_timestamp`를 추가한다. 기존 Gateway는 알 수 없는 상태를 거부할 수 있으므로 API/Shared 계약과 Gateway consumer를 같은 배포 단위로 검증한다.
- migration 파일만 생성하며 사용자 로컬 DB에는 적용하지 않는다.

## 검증 경계

- 시간 정책 단위 테스트: 경계 바로 전/정확한 경계/1ms 초과, 환경설정 오류.
- fixture-state 단위 테스트: 큰 미래 연도가 energy cursor와 버킷 분할 경로에 진입하지 않고 durable rejection을 남김, 정상 이벤트가 `lastSeenAt=receivedAt`과 `lastStateOccurredAt=occurredAt`을 분리 저장, payload-conflicting replay 거부.
- heartbeat/MQTT 단위 테스트: 미래 heartbeat가 원장에 남고 Gateway를 갱신하지 않으며 handler가 성공 종료, 미래 fixture-state ACK 뒤 같은 gateway의 다음 이벤트 처리.
- freshness 단위 테스트: fixture stale 기준이 `lastSeenAt`임을 고정.
- disposable PostgreSQL 통합 테스트: migration된 빈 DB에서 미래 poison fixture event 뒤 정상 후속 이벤트가 처리되고 aggregate/checkpoint/freshness가 미래로 오염되지 않음.
- Shared/API/Gateway focused tests, Prisma validate/generate, typecheck/build를 실행한다. 실제 사용자 DB migration, broker 배포, Raspberry Pi/ESP32-H2 HIL은 수행하지 않는다.

## P1 분리 경계

P0 커밋과 검증이 끝난 뒤 별도 설계 checkpoint에서 자동 polling 또는 push/fallback, cached 화면 유지 stale banner, 현장별 threshold, incident 이력·확인·담당·해결 workflow를 확정한다. P1은 화면 표시 개선과 incident 도메인 모델 변경을 포함하므로 P0의 수집 원장 변경과 같은 커밋에 섞지 않는다.

## P0 구현 결과 (2026-09-12)

P0는 수신 시각 기준 fixture/gateway freshness, 5분 future gate, terminal rejection 원장과 Gateway exact ACK consumer까지 구현했다. disposable PostgreSQL에 전체 migration을 적용해 future poison fixture event 뒤 정상 event가 aggregate/checkpoint/freshness를 오염시키지 않고 진행하는 것을 확인했다. 이 결과는 software 자동 검증 범위이며 사용자 DB migration, 실제 MQTT broker 연결, Raspberry Pi/BlueZ/ESP32-H2 HIL은 수행하지 않았다. P1 production 코드는 별도 설계 checkpoint 전까지 시작하지 않는다.

## 별도 발견 사항

이번 P0 밖에서 자동화 RF 경로의 state outbox capacity 사전 예약 누락과 gateway event sequence 파일의 운영 중 소실 복구 문제가 확인됐다. 두 항목은 실제 조명 상태와 cloud 상태의 불일치를 만들 수 있어 후속 P0 후보로 유지하되, 현재 시간 신뢰성 변경과 결합하지 않는다.
