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
