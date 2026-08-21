# Task 10 보고서

## RED 증거

- shared RED:
  - `pnpm --filter @led-control/shared exec vitest run src/schemas.test.ts`
  - 실패: `Invalid enum value. Expected 'applied' | 'failed', received 'ready'`
- gateway RED:
  - `pnpm --filter @led-control/gateway exec vitest run src/mesh/group-subscription-handler.test.ts src/mesh/bluez-mesh-adapter.test.ts src/mesh/bluez-config-client.test.ts`
  - 실패 1: `bluez-mesh-adapter`가 성공 member result를 여전히 `applied`로 발행
  - 실패 2: 동시 `addModelSubscription` 요청에서 역순 응답이 들어오면 `Config Model Subscription Status does not match the request`
- API RED:
  - `pnpm --filter @led-control/api exec jest src/mesh-control-groups/mesh-group-sync.worker.spec.ts src/mqtt/mqtt.service.spec.ts src/mesh-control-groups/mesh-control-group.schema.spec.ts --runInBand`
  - 실패 1: worker publish reject가 전체 tick을 중단해 두 번째 group이 발행되지 않음
  - 실패 2: result schema가 외부 `ready` 상태를 허용하지 않음
  - 실패 3: `20260821093000_add_mesh_control_group_member_status_version` migration 부재

## 변경 파일

- `packages/shared/src/schemas.ts`
- `packages/shared/src/schemas.test.ts`
- `apps/gateway/src/mesh/bluez-config-client.ts`
- `apps/gateway/src/mesh/bluez-config-client.test.ts`
- `apps/gateway/src/mesh/bluez-mesh-adapter.ts`
- `apps/gateway/src/mesh/bluez-mesh-adapter.test.ts`
- `apps/gateway/src/mesh/group-subscription-handler.test.ts`
- `apps/api/src/mesh-control-groups/mesh-group-sync.worker.ts`
- `apps/api/src/mesh-control-groups/mesh-group-sync.worker.spec.ts`
- `apps/api/src/mqtt/mqtt.service.ts`
- `apps/api/src/mqtt/mqtt.service.spec.ts`
- `apps/api/src/mesh-control-groups/mesh-control-group.schema.spec.ts`
- `apps/api/prisma/schema.prisma`
- `apps/api/prisma/migrations/20260821093000_add_mesh_control_group_member_status_version/migration.sql`
- `docs/database-schema.md`
- `docs/menus/control.md`
- `docs/superpowers/plans/2026-08-19-monitoring-control-focused-completion.md`
- `docs/lesson_leared.md`

## MQTT 계약

- command topic: `sites/{siteId}/gateways/{gatewayId}/commands/mesh-group/subscription-sync`
- result topic: `sites/{siteId}/gateways/{gatewayId}/events/mesh-group/subscription-result`
- command payload:
  - `siteId`, `gatewayId`, `groupId`, `version`, `groupAddress`, `members[]`, `requestedAt`
  - `members[]`는 `meshNodeId`, `meshAddress`
  - worker는 `configuring` group 중 현재 member가 1개 이상인 경우에만 10초 주기로 발행
- result payload:
  - `siteId`, `gatewayId`, `groupId`, `version`, `groupAddress`, `members[]`, `occurredAt`
  - `members[]`는 `meshNodeId`, `status(ready|failed)`, `error?`
- API와 gateway 모두 topic scope의 `siteId/gatewayId`와 payload의 `siteId/gatewayId`를 교차 검증한다.

## 상태 전이

- worker 발행:
  - `MeshControlGroup.status = configuring`
  - 현재 member 수가 1개 이상
  - 한 group publish 실패 시 구조적 로그를 남기고 다음 group 발행은 계속 진행
- gateway 처리:
  - 같은 `groupId/version` 재수신 허용
  - Light Lightness Server `0x1300`에 표준 Config Model Subscription Add 재적용
  - Config Model Subscription Status는 `source`, `elementAddress`, `groupAddress`, `modelId`가 모두 요청과 일치할 때만 해당 waiter가 소비
  - member별 `ready/failed` 결과를 한 번 발행
- API result persistence:
  - `configurationVersion === result.version`인 현재 group만 갱신
  - 현재 group/gateway에 속하지 않는 member 결과는 DB 갱신과 ready/failed 집계에서 제외
  - 외부 `ready`는 내부 `subscriptionStatus="applied"`로 변환
  - 성공/실패 모두 `statusVersion = result.version`을 기록
  - 성공일 때만 `appliedVersion = result.version`
  - 누락 member는 기존 상태를 유지한다
  - 현재 member 중 `subscriptionStatus = failed`이면서 `statusVersion = current version`인 member가 있으면 group `failed`
  - 현재 member 전원이 `subscriptionStatus = applied`, `appliedVersion = current version`, `statusVersion = current version`이면 group `ready`
  - 그 외에는 group `configuring`

## GREEN 증거

- shared GREEN:
  - `pnpm --filter @led-control/shared exec vitest run src/schemas.test.ts`
  - 결과: PASS
- gateway GREEN:
  - `pnpm --filter @led-control/gateway exec vitest run src/mesh/group-subscription-handler.test.ts src/mesh/bluez-mesh-adapter.test.ts src/mesh/bluez-config-client.test.ts`
  - 결과: PASS
- API GREEN:
  - `pnpm --filter @led-control/shared build`
  - `pnpm --filter @led-control/api prisma:generate`
  - `pnpm --filter @led-control/api exec jest src/mesh-control-groups/mesh-group-sync.worker.spec.ts src/mqtt/mqtt.service.spec.ts src/mesh-control-groups/mesh-control-group.schema.spec.ts --runInBand`
  - 결과: PASS

## 실행 테스트와 결과

- `pnpm --filter @led-control/shared test` -> PASS (`4 files, 27 tests`)
- `pnpm --filter @led-control/gateway exec vitest run src/mesh/bluez-config-codec.test.ts src/mesh/bluez-config-client.test.ts src/mesh/group-subscription-handler.test.ts src/mesh/bluez-mesh-adapter.test.ts src/adapters/adapter-factory.test.ts src/commands/gateway-command-handler.test.ts` -> PASS (`6 files, 40 tests`)
- `pnpm --filter @led-control/gateway typecheck` -> PASS
- `pnpm --filter @led-control/api exec jest src/mesh-control-groups/mesh-group-sync.worker.spec.ts src/mqtt/mqtt.service.spec.ts src/mesh-control-groups/mesh-control-group.schema.spec.ts --runInBand` -> PASS
- `pnpm --filter @led-control/api typecheck` -> PASS
- `pnpm --filter @led-control/api prisma:generate` -> PASS
- `DATABASE_URL='postgresql://postgres:postgres@localhost:5432/led_control_service' pnpm --filter @led-control/api exec prisma validate` -> PASS
- `git diff --check` -> PASS

## 커밋

- 커밋 메시지: `fix(mesh): harden group subscription synchronization`
- 커밋 해시: 현재 HEAD (`git rev-parse --short HEAD`)

## 우려 사항

- `MeshControlGroupMember` 자동 생성은 여전히 Task 11 범위다. 이번 수정은 기존 membership 동기화 계약만 강화한다.
- 실제 group dimming 단일 전송 경로 연결은 이번 라운드 범위가 아니다.
