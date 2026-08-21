# Task 11 보고서

기준일: 2026-08-21

## Fix round 1 요약

- `attachProvisionedNode()`는 group row를 `SELECT ... FOR UPDATE`로 먼저 잠그고, member 삽입을 compound PK 기준 `createMany(..., skipDuplicates: true)`로 바꿔 동시 duplicate attach와 ready group version 이중 증가를 막았다.
- `storeMeshGroupSubscriptionResult()`도 현재 site/gateway/group/version row를 먼저 잠그고 member를 갱신하도록 바꿔 attach와 같은 group->member 잠금 순서를 유지했다.
- provisioning 완료에서 기존 fixture를 재사용할 때 `floorId`까지 함께 조회하고, 다른 층에 이미 배정된 fixture면 `fixture is already assigned to another floor`로 실패 처리해 잘못된 floor group attach를 막았다.
- `ensureGroup()`은 existing fast path에서도 gateway/target site 경계를 다시 조회해, 잘못 남은 group row가 있어도 그대로 반환하지 않게 했다.

## Fix round 2 요약

- subscription result 잠금 SQL의 마지막 절을 `FOR UPDATE OF g`로 좁혀 `Gateway` row까지 함께 잠그지 않도록 수정했다.

## 작업 요약

- `RegistrationService.registerBatch()` transaction에서 provisioning publish 전에 `MeshControlGroupService.ensureFloorGroup()`을 호출하도록 연결했다.
- `MqttService`의 provisioning 완료 transaction에서 `MeshNode`/`Fixture`를 생성 또는 재사용한 뒤, DB의 `GroupFixture` 관계를 기준으로 floor 및 fixture-group control group membership을 연결하도록 바꿨다.
- `MeshControlGroupService.attachProvisionedNode()`와 `getReadyDestination()`를 추가해 site/gateway 경계 검증, idempotent member 연결, version reset 규칙을 구현했다.
- `MeshControlGroupModule`과 `MqttModule`의 의존 방향을 정리해 순환 의존성을 제거하고 `MeshGroupSyncWorker`를 `MqttModule`로 이동했다.

## RED 증거

실패 테스트 명령:

```bash
pnpm --filter @led-control/api exec jest src/mqtt/mqtt.service.spec.ts src/registration/registration.service.spec.ts src/mesh-control-groups/mesh-control-group.service.spec.ts --runInBand
```

초기 실패 원인:

- `RegistrationService`가 `ensureFloorGroup()`을 호출하지 않아 선확보 테스트가 실패했다.
- `MqttService`가 `MeshControlGroupService`를 주입받지 않아 provisioning 완료 hook 테스트가 컴파일 단계에서 실패했다.
- `MeshControlGroupService`에 `attachProvisionedNode()`와 `getReadyDestination()`가 없어 신규 상태 전이 테스트가 실패했다.

fix round 1 추가 실패 원인:

- existing fast path가 target/site 경계를 재검증하지 않아 잘못된 기존 group을 그대로 반환했다.
- `attachMemberToGroup()`이 `findUnique -> create` 경로라 duplicate attach에서 원자성이 없고, group 잠금 없이 stale status를 사용했다.
- subscription ACK 반영이 group row 잠금 없이 member부터 갱신해 attach와 잠금 순서가 달랐다.
- 기존 fixture가 다른 층에 있어도 provisioning 완료가 현재 session floor group에 attach를 계속 진행했다.

fix round 2 추가 실패 원인:

- subscription result lock SQL이 `INNER JOIN Gateway`와 함께 bare `FOR UPDATE`로 끝나 PostgreSQL이 `Gateway` row까지 잠글 수 있었다.

## GREEN 증거

1차 검증에서 아래 명령이 통과했다.

```bash
pnpm --filter @led-control/api exec jest src/mqtt/mqtt.service.spec.ts src/registration/registration.service.spec.ts src/mesh-control-groups/mesh-control-group.service.spec.ts --runInBand
```

결과:

- Test Suites: 3 passed
- Tests: 47 passed

fix round 1 검증에서 아래 명령이 통과했다.

```bash
pnpm --filter @led-control/api exec jest src/mqtt/mqtt.service.spec.ts src/registration/registration.service.spec.ts src/mesh-control-groups/mesh-control-group.service.spec.ts --runInBand
```

결과:

- Test Suites: 3 passed
- Tests: 52 passed

fix round 2 검증에서 아래 명령이 통과했다.

```bash
pnpm --filter @led-control/api exec jest src/mqtt/mqtt.service.spec.ts --runInBand
```

결과:

- Test Suites: 1 passed
- Tests: 24 passed

추가 검증:

```bash
pnpm --filter @led-control/api test
pnpm --filter @led-control/api typecheck
git diff --check 5d9a26c..HEAD
```

검증 결과:

- `pnpm --filter @led-control/api test`: 55 passed / 6 skipped / 393 total
- `pnpm --filter @led-control/api typecheck`: 성공
- `git diff --check 5d9a26c..HEAD`: 성공

## 변경 파일

- `apps/api/src/mesh-control-groups/mesh-control-group.module.ts`
- `apps/api/src/mesh-control-groups/mesh-control-group.service.ts`
- `apps/api/src/mesh-control-groups/mesh-control-group.service.spec.ts`
- `apps/api/src/mqtt/mqtt.module.ts`
- `apps/api/src/mqtt/mqtt.service.ts`
- `apps/api/src/mqtt/mqtt.service.spec.ts`
- `apps/api/src/mqtt/mqtt-v2-state.spec.ts`
- `apps/api/src/registration/registration.module.ts`
- `apps/api/src/registration/registration.service.ts`
- `apps/api/src/registration/registration.service.spec.ts`
- `docs/menus/monitoring.md`
- `docs/menus/control.md`
- `docs/superpowers/plans/2026-08-19-monitoring-control-focused-completion.md`

## 남은 확인

- 실제 BLE Mesh group dimming 단일 전송 경로와 delivery mode 연결은 Task 12 이후 범위다.
