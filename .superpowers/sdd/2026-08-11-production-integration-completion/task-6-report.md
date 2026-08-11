# Task 6 완료 보고: 조명 등록 소유권과 실제 초기 상태

## 구현 범위

- 등록 세션 입력은 `siteId`, `floorId`, `gatewayId`를 명시적으로 요구한다.
- 서버는 operator의 시운전 권한, 층과 Gateway의 현장 소유권, 90초 이내 heartbeat를 확인한 뒤 검색 명령을 발행한다.
- provisioning 직후 조명은 `offline + provisioning_waiting_state`, 밝기 0, `lastSeenAt = null`로 생성한다.
- 첫 실제 `fixture-state` MQTT 이벤트만 online/fault, 밝기, 통신 품질과 마지막 수신 시각을 확정한다.
- `MeshNode.deviceUuid` 전역 unique 제약을 동시성 방어선으로 유지한다. `P2002`가 실제 `deviceUuid` 충돌일 때만 현장 간 UUID 충돌로 처리하며 다른 트랜잭션 오류는 재전파한다.
- 웹은 층과 Gateway를 명시적으로 선택해 등록을 시작한다.
- 모니터링은 초기 상태 대기를 실제 오프라인 점검 큐와 대수에서 제외한다.
- freshness worker는 초기 상태 대기를 제외하고, `gateway_offline` 사유가 같은 실행의 `fixture_stale` 판정으로 덮이지 않게 한다.

## 데이터베이스

- 스키마 또는 migration 변경은 없다. 기존 `MeshNode.deviceUuid` 전역 unique index를 사용한다.
- 초기 상태, Gateway freshness, UUID 충돌 계약은 `docs/database-schema.md`에 반영했다.

## 검증 결과

- Task 6 전체 검증: shared 17개, API 318개, 웹 140개 테스트 통과 및 shared/API/web typecheck 통과.
- 최종 회귀 검증: 등록·MQTT·freshness API 28개, 모니터링 웹 42개 테스트 통과.
- 정확히 90초 heartbeat 경계, 필수 Gateway 전달, UUID unique target 분기, 초기 상태 대기 표시·집계, 오프라인 사유 보존을 회귀 테스트로 고정했다.

## 커밋

- `ed7cc7b fix(registration): require owned gateway and real initial state`
- `d9736c9 fix(registration): close task 6 review gaps`
- 최종 점검 큐 및 freshness 원인 보존 보완 커밋은 이 보고서와 함께 기록한다.

## 중지 및 재개 지점

- Task 6을 완료한 상태에서 사용자 요청에 따라 중지한다.
- 다음 작업은 Task 7 `조명 등록 UI와 post-provision identify`이다.
- Task 7 이후 Task 8 모니터링 도형 정합성, Task 9 BLE Mesh 그룹 주소 제어, Task 10 Gateway HIL 실행기, Task 11 전체 회귀와 양산 판정을 순서대로 진행한다.
- 실제 Raspberry Pi 및 ESP32-H2를 사용하는 HIL 검증은 Task 10과 Task 11에서 수행한다.
