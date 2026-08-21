# Task 10 보고서

## RED 증거

- shared RED: `mqttTopics.meshGroupSubscriptionSync is not a function`
- gateway RED:
  - `encodeModelSubscriptionAdd is not a function`
  - `parseModelSubscriptionStatus is not a function`
  - `client.addModelSubscription is not a function`
  - `Failed to load url ./group-subscription-handler`
- API RED:
  - `Cannot find module './mesh-group-sync.worker'`
  - `meshControlGroup.findFirst` 기대 호출이 발생하지 않아 result persistence 미구현이 드러남

## 변경 파일

- `packages/shared/src/mqtt.ts`
- `packages/shared/src/schemas.ts`
- `packages/shared/src/schemas.test.ts`
- `apps/gateway/src/gateway.ts`
- `apps/gateway/src/index.ts`
- `apps/gateway/src/commands/gateway-command-handler.test.ts`
- `apps/gateway/src/adapters/adapter-factory.test.ts`
- `apps/gateway/test/stub-adapters.ts`
- `apps/gateway/src/mesh/bluez-config-codec.ts`
- `apps/gateway/src/mesh/bluez-config-codec.test.ts`
- `apps/gateway/src/mesh/bluez-config-client.ts`
- `apps/gateway/src/mesh/bluez-config-client.test.ts`
- `apps/gateway/src/mesh/bluez-mesh-adapter.ts`
- `apps/gateway/src/mesh/bluez-mesh-adapter.test.ts`
- `apps/gateway/src/mesh/group-subscription-handler.ts`
- `apps/gateway/src/mesh/group-subscription-handler.test.ts`
- `apps/api/src/mesh-control-groups/mesh-control-group.module.ts`
- `apps/api/src/mesh-control-groups/mesh-group-sync.worker.ts`
- `apps/api/src/mesh-control-groups/mesh-group-sync.worker.spec.ts`
- `apps/api/src/mqtt/mqtt.service.ts`
- `apps/api/src/mqtt/mqtt.service.spec.ts`
- `docs/menus/control.md`
- `docs/superpowers/plans/2026-08-19-monitoring-control-focused-completion.md`

## MQTT 계약

- command topic: `sites/{siteId}/gateways/{gatewayId}/commands/mesh-group/subscription-sync`
- result topic: `sites/{siteId}/gateways/{gatewayId}/events/mesh-group/subscription-result`
- command payload:
  - `siteId`, `gatewayId`, `groupId`, `version`, `groupAddress`, `members[]`, `requestedAt`
  - `members[]`는 `meshNodeId`, `meshAddress`
  - worker는 `configuring` group 중 현재 member가 1개 이상인 경우에만 발행
- result payload:
  - `siteId`, `gatewayId`, `groupId`, `version`, `groupAddress`, `members[]`, `occurredAt`
  - `members[]`는 `meshNodeId`, `status(applied|failed)`, `error?`
- API와 gateway 모두 topic scope의 `siteId/gatewayId`와 payload의 `siteId/gatewayId`를 교차 검증한다.

## 상태 전이

- worker 발행 대상:
  - `MeshControlGroup.status = configuring`
  - 현재 member 수가 1개 이상
- gateway 처리:
  - 같은 `groupId/version` 재수신 허용
  - 각 member에 대해 Light Lightness Server `0x1300`로 표준 Config Model Subscription Add 재적용
  - member별 `applied/failed` 결과를 한 번 발행
- API result persistence:
  - `configurationVersion === result.version`인 현재 group만 갱신
  - 현재 group/gateway에 속하지 않는 member 결과는 DB 갱신과 ready 집계에서 제외
  - 누락 member는 `pending` 유지
  - 현재 member 전원이 `appliedVersion == version`인 `applied`일 때만 group `ready`
  - 현재 member 중 하나라도 `failed`면 group `failed`
  - 그 외에는 `configuring` 유지

## 실행 테스트와 결과

- `pnpm --filter @led-control/shared test` -> PASS
- `pnpm --filter @led-control/gateway exec vitest run src/mesh/bluez-config-codec.test.ts src/mesh/bluez-config-client.test.ts src/mesh/group-subscription-handler.test.ts src/mesh/bluez-mesh-adapter.test.ts src/adapters/adapter-factory.test.ts` -> PASS
- `pnpm --filter @led-control/gateway exec vitest run src/commands/gateway-command-handler.test.ts` -> PASS
- `pnpm --filter @led-control/gateway typecheck` -> PASS
- `pnpm --filter @led-control/api exec jest src/mesh-control-groups/mesh-group-sync.worker.spec.ts src/mqtt/mqtt.service.spec.ts --runInBand` -> PASS
- `pnpm --filter @led-control/api typecheck` -> PASS

## 커밋

- 커밋 메시지: `feat(mesh): synchronize control group subscriptions`

## 우려 사항

- `MeshControlGroupMember` 자동 생성은 아직 Task 11 범위다. 이번 Task 10은 이미 존재하는 member를 대상으로만 subscription sync와 상태 집계를 구현했다.
- floor/group actual dimming을 BLE Mesh group 단일 전송으로 연결하는 경로는 이번 Task 범위가 아니다.
