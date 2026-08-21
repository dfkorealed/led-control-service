# Task 11 보고서

기준일: 2026-08-21

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

## GREEN 증거

1차 검증에서 아래 명령이 통과했다.

```bash
pnpm --filter @led-control/api exec jest src/mqtt/mqtt.service.spec.ts src/registration/registration.service.spec.ts src/mesh-control-groups/mesh-control-group.service.spec.ts --runInBand
```

결과:

- Test Suites: 3 passed
- Tests: 47 passed

추가 검증:

```bash
pnpm --filter @led-control/api test
pnpm --filter @led-control/api typecheck
git diff --check 6dd17b5..HEAD
```

검증 결과:

- `pnpm --filter @led-control/api test`: 55 passed / 6 skipped / 388 total
- `pnpm --filter @led-control/api typecheck`: 성공
- `git diff --check 6dd17b5..HEAD`: 성공

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
