# Task 12 구현 보고서

기준 커밋: `f62ca34`

구현 커밋: `9aeea66`

## RED 증거

- shared target/gateway 계약 테스트: 신규 `createDimmingCommandSchema`가 없어 2건, `deliveryMode`와 floor target이 없어 2건 실패했다.
- API commands 테스트: 신규 target을 controller/service가 받지 못하고 `resolveSingleGateway`가 없어 compile/행동 테스트가 실패했다. delivery mode 응답, 다중 gateway 거부, ready group 조회, nullable target 상태 응답도 기대값과 달랐다.
- 검토 보강 테스트: 잘못된 요청이 `BadRequestException`이 아니라 원본 `ZodError`로 빠지는 것을 확인한 뒤 공개 400 오류로 변환했다.

## 구현 내용

- 공개 dimming target을 `fixture | fixtures | floor | group`으로 확장하고 빈/중복 다중 fixture를 거부한다.
- Task 14 전 기존 웹 `{targetType,targetId}` 요청은 controller에서만 신규 target으로 정규화한다.
- 대상 Fixture/Floor/FixtureGroup을 현장 범위 DB 관계로 transaction 안에서 다시 조회한다.
- 단일은 `unicast`, 임의 다중은 `parallel_unicast`, ready floor/group은 `mesh_group`으로 결정한다.
- 임의 다중 exact match는 floor 우선, 같은 종류 ID 정렬로 ready destination을 선택한다.
- 논리 target이 여러 gateway에 걸치면 전체 거부하고, 요청한 floor/group이 준비되지 않으면 fallback하지 않는다.
- Command에 nullable `targetId`와 확정 `targetFixtureIds`, Dispatch에 `deliveryMode`, `destinationAddress`, Mesh group ID/version snapshot을 저장한다.
- Gateway outbox payload와 command 상태 응답에 같은 delivery metadata를 반영한다.
- migration은 기존 Command와 Dispatch/outbox를 실제 fixture result 목록과 physical mode로 정규화한 뒤 NOT NULL을 적용한다.

## 검증 결과

- shared: 30개 통과
- commands: 20개 통과
- API 전체: 371개 통과, 기존 opt-in 26개 skip
- Gateway 전체: 189개 통과
- Prisma generate/validate 및 API typecheck 통과

## 남은 한계

- Gateway가 `parallel_unicast`와 `mesh_group`을 실제 BLE Mesh 송신으로 분기하는 동작은 Task 13 범위다. Gate 12 커밋만으로 group 하드웨어 제어를 검증하거나 배포하면 안 된다.
- 신규 다중/층/구역 target을 사용하는 웹 화면은 Task 14 범위다. 현재 개별/그룹 화면은 controller의 한시 legacy adapter로 유지된다.
- 실제 PostgreSQL migration 적용 및 실장비 RF/HCI 검증은 이 자동 검증에 포함하지 않았다.

## 독립 리뷰 Fix round 1

### RED 증거

- Shared Gateway wire 불변식 테스트는 중복 fixture, 1,000개 초과, target type/ID/fixture 수/delivery mode 모순, Group Address 범위, Mesh metadata 누락·혼입을 허용해 11건 실패했다.
- Migration SQL 계약 테스트는 기존 Command/Dispatch/outbox backfill과 Mesh snapshot FK/index가 없어 4건 실패했다. 이후 권위 있는 fixture result가 없는 outbox를 차단하는 전제 테스트도 1건 실패하는 것을 확인했다.
- Mesh destination/Commands 테스트는 group ID/version을 반환·영속화하지 않아 4건 실패했다.
- Outbox publisher 테스트는 발행 직전 snapshot 검증, 동일 version configuring 재시도, stale 즉시 실패가 없어 9건 실패했다.

### 수정 내용

- Gateway wire schema가 `targetFixtureIds` unique/최대 1,000개, BLE Mesh Group Address `0xc000..0xfeff`, target별 ID·fixture 수·delivery mode, Mesh metadata 필수·금지를 하나의 불변식으로 검증한다.
- 기존 Command fixture snapshot과 Dispatch physical mode를 `CommandFixtureResult`로 backfill한다. 과거 outbox의 `group`은 Mesh group으로 가장하지 않고 `fixtures`로 정규화하며 1개는 `unicast`, 2개 이상은 `parallel_unicast`로 만든다.
- 권위 있는 fixture result가 없거나 strict wire 한도인 1,000개를 초과하는 outbox가 있으면 migration을 명시적으로 중단한다. 이 파일은 Task 12 migration이 아직 실제 환경에 적용되지 않았다는 전제에서 같은 파일을 수정했다.
- `CommandDispatch`에 nullable Mesh control group ID/version과 `(meshControlGroupId, gatewayId)` 기준 `ON DELETE RESTRICT` 복합 FK, 상태 조회 index를 추가했다. ready destination은 group ID/address/configurationVersion을 반환하고 명령 생성 transaction에서 Dispatch와 outbox payload에 함께 저장한다.
- Publisher는 payload 준비 transaction 안에서 Dispatch snapshot 및 현재 group의 gateway/address/version/status를 재검증한다. 동일 version `configuring`은 backoff 재시도하며 missing/failed/mismatch는 MQTT 발행 없이 `MESH_GROUP_STALE`로 Dispatch, fixture 결과, Command를 즉시 terminal failure 처리한다.

### GREEN 증거

- Shared 전체: 41개 통과
- API commands/outbox/mesh 관련: 56개 통과
- API 전체: 383개 통과, 기존 opt-in 26개 skip
- Gateway 전체: 189개 통과
- Shared/API/Gateway typecheck, API build, Prisma generate/validate 통과

### 남은 한계

- Publisher의 DB 검증 transaction 커밋과 MQTT publish 사이에는 제거할 수 없는 극소 race가 남는다. Task 13 Gateway가 payload group ID/version을 로컬 적용 완료 subscription version과 비교하고 불일치 시 BLE 송신 전에 거부해야 한다.
- 실제 PostgreSQL 데이터에 migration을 적용하는 검증과 실제 BLE Mesh 송신은 각각 배포 전 migration rehearsal과 Task 13 범위다.

## 재리뷰 1 Fix round 2

### RED 증거

- Migration SQL 계약 2건이 명시 transaction/preflight 순서와 허용 키 기반 payload 재구성 부재로 실패했다.
- PostgreSQL 16.14 격리 schema rehearsal 3건이 실패했다. Retry payload는 `legacyDebug`/`expiresAt` 때문에 strict draft parse가 실패했고, guard 및 후반 index 오류 뒤 신규 컬럼 5개가 남았다.
- CommandTimeoutService 신규 테스트 3건이 초기 조회와 transaction update에 active lease 제외 조건이 없어 실패했다.
- MqttService는 `timeoutMs` 계약이 없어 동시 publish 취소 테스트가 compile 실패했고, OutboxPublisher 3건은 lease fencing/갱신과 20초 publish timeout 부재로 실패했다. Publish promise를 정지한 경쟁 테스트에서는 timeout worker가 같은 dispatch를 `timed_out`으로 종료했다.

### 수정 내용

- Legacy outbox payload는 strict draft가 허용하는 identity/command 키만 `jsonb_build_object`로 재구성한다. 과거 `expiresAt`, group metadata와 임의 legacy 키는 남지 않는다.
- Result 없음/1,000개 초과 preflight를 모든 DDL 앞에 두고 migration 전체를 명시적 `BEGIN/COMMIT`으로 감쌌다.
- `COMMAND_MIGRATION_TEST_DATABASE_URL` opt-in rehearsal은 매 실행 무작위 schema를 생성해 fresh/retry strict parse, Dispatch mode/FK, guard rollback, 후반 DDL rollback을 검증하고 종료 시 schema를 삭제한다.
- Timeout worker는 현재 유효 outbox lease를 가진 pending dispatch를 초기 조회와 transaction 조건부 update 모두에서 제외한다. Query 이후 claim이 발생하면 update count 0으로 terminal 전이를 중단한다.
- Publisher는 prepare update에서 lease 유효성을 다시 검사하고 시작 시점부터 30초로 갱신한다. MqttService의 기존 계약은 유지하면서 선택적 `timeoutMs`를 추가하고, OutboxPublisher만 20초를 사용한다. Timeout 시 MQTT.js 5.15의 실제 message ID를 `removeOutgoingMessage`로 제거하며 늦거나 중복된 callback은 한 번만 완료 처리한다.
- Task 13 계획/설계에는 group ID/address/version별 durable `configuring | ready | failed`, sync 전 fsync barrier, group별 sync/control 직렬화, 부분 실패 fail-closed, 재시작 복원, state 유실·손상 시 cloud ready group 전체 resync 흐름과 테스트를 추가했다. BLE 송신 코드는 변경하지 않았다.

### GREEN 증거

- Shared 전체: 41개 통과
- Migration SQL 계약: 5개 통과
- PostgreSQL 16.14 격리 rehearsal: 3개 통과
- Timeout/MQTT/Outbox 관련: 43개 통과
- Commands/MQTT/Mesh 관련 API: 92개 통과, opt-in rehearsal 3개 skip
- API 전체: 391개 통과, 기존 및 opt-in 29개 skip
- Gateway 전체: 189개 통과
- Prisma generate/validate, Shared/API/Gateway typecheck와 API build 통과

실행 명령:

```bash
COMMAND_MIGRATION_TEST_DATABASE_URL='postgresql:///postgres' pnpm --filter @led-control/api test:command-migration
```

### 남은 한계

- MQTT QoS 1 packet이 broker에 이미 전달되고 PUBACK만 유실된 경우 outgoing 제거는 물리 적용을 되돌릴 수 없다. 기존 command idempotency key, 10초 message/command expiry와 Gateway journal 재전송 방어를 함께 사용한다.
- Gateway durable group state 및 BLE Mesh 실제 group 송신은 문서화된 Task 13 구현/HIL 범위다.

## 재리뷰 2 Fix round 3

### RED 증거

- OutboxPublisher service 회귀에서 첫 publish 실패 후 DB에 남은 strict full payload를 두 번째 시도가 draft로 읽지 못해 MQTT 호출이 1회에 머물렀다.
- Snapshot 조회가 31초 지연된 테스트에서 prepare update가 fresh 시각이 아닌 기존 `T0`를 사용해 이미 만료된 lease를 통과시켰다.
- MQTT 직전 worker ownership/잔여 lease 조회가 없어 fencing 테스트가 실패했다.
- Pending timeout 테스트 5건이 outbox 선점 부재, Dispatch 우선 update, active publisher claim, Dispatch 경쟁 rollback 부재와 published/accepted 불필요 outbox cleanup 때문에 실패했다.

### 수정 내용

- 저장 payload는 strict draft를 먼저 검사하고, 실패하면 strict full wire만 허용한다. Full payload는 `expiresAt`만 제거해 draft로 재검증하며 임의 extra key는 계속 거부한다. 첫 publish 실패로 실제 저장된 full payload를 두 번째 service 호출에 넣어 새 expiry로 MQTT가 다시 호출되는 회귀를 추가했다.
- `PublisherOptions.clock`을 주입해 snapshot 검증 직후 fresh 시각으로 유효 lease를 30초 연장하고 같은 시점의 expiry를 저장한다. MQTT 직전에는 worker ownership, 미발행·미-dead-letter 상태와 20초 timeout 전체를 덮는 잔여 lease를 `count = 1`로 재확인한다.
- Publish 성공, catch/backoff, dead-letter 시각은 시작 시각을 재사용하지 않고 각 경로의 fresh clock을 사용한다.
- Pending timeout은 transaction에서 inactive/expired lease를 가진 outbox를 먼저 dead-letter 선점한다. Outbox가 없거나 active lease이면 fail-closed하고, Dispatch update 경쟁을 잃으면 sentinel exception으로 outbox 변경까지 rollback한다. Published/accepted timeout은 outbox 선점 없이 기존 조건부 Dispatch 종료를 유지한다.

### GREEN 증거

- Publisher/timeout 집중: 23개 통과
- Shared 전체: 41개 통과
- Commands/MQTT/Mesh 관련 API: 98개 통과, opt-in rehearsal 3개 skip
- API 전체: 397개 통과, 기존 및 opt-in 29개 skip
- Gateway 전체: 189개 통과
- PostgreSQL 격리 migration rehearsal: 3개 통과
- Prisma generate/validate, Shared/API/Gateway typecheck와 API build 통과

### 남은 한계

- Pending timeout과 publisher의 PostgreSQL row 경쟁은 동일 outbox 조건과 transaction 호출 순서를 service 단위 테스트로 검증했다. 실제 다중 프로세스 lock wait를 강제로 만드는 별도 PostgreSQL concurrency rehearsal은 포함하지 않았다.
- QoS 1 PUBACK 유실은 at-least-once 경계이므로 Gateway idempotency journal과 Task 13 BLE 실행 직전 expiry/version 검증이 계속 필요하다.
