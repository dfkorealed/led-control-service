# Outbox Worker Crash Fix Round 1 Report

기준일: 2026-08-26

## Review Findings

독립 리뷰의 P1/P2를 두 worker에서 재현했다.

- `onModuleDestroy()`는 interval만 제거하고 즉시 반환해 이미 실행 중인 batch와 MQTT/Prisma 종료가 경쟁했다. 종료 중 첫 publish가 끝난 뒤 같은 batch의 다음 record publish도 시작됐다.
- scheduler 로그 분류는 임의의 `error.code` 또는 `Error.name`을 그대로 출력해 민감한 문자열이 노출될 수 있었다.

## Implementation

- scheduler가 현재 batch의 contained promise를 `activeBatch`로 소유한다.
- `onModuleDestroy()`는 먼저 worker를 stopped 상태로 전환하고 interval을 제거한 뒤 `activeBatch` 완료를 기다린다.
- `processBatch()`는 이미 시작한 record publish는 완료시키지만 shutdown 시작 뒤 다음 record publish를 시작하지 않는다.
- 로그에 노출할 오류 코드는 정규식 `^P\d{4}$`와 일치하는 Prisma code로 제한한다. 그 외 code/name/message는 모두 `UNEXPECTED_ERROR`로 정제한다.
- 개별 record의 기존 publish failure, backoff, dead-letter 동작은 변경하지 않았다.

## RED

명령:

```text
pnpm --filter @led-control/api exec jest src/mqtt/outbox-publisher.service.spec.ts src/mqtt/provisioning-scan-outbox-publisher.service.spec.ts --runInBand
```

결과: 2 suites failed, 4 tests failed, 29 tests passed.

- 종료 hook은 active publish 해제 전에 완료됐다: `completedBeforeRelease: true`.
- shutdown 뒤 같은 batch의 두 번째 publish가 시작됐다: expected 1, received 2.
- `P2028-code-secret`과 `name-secret-without-code`가 두 worker 로그에 그대로 출력됐다.

## GREEN

Focused 결과:

```text
Test Suites: 2 passed, 2 total
Tests:       33 passed, 33 total
```

전체 API 검증의 최초 시도는 병렬 Task 4 RED 작업 파일에서 실패했다. outbox spec은 전체 실행에서도 통과했으며 실패는 `mesh-control-group.service.spec.ts`와 `mqtt.service.spec.ts`에 한정됐다. typecheck/build도 병렬 작업 중인 `mesh-control-group.service.spec.ts:1092`의 TS2339로 중단됐다. 이 범위 밖 파일은 수정하지 않는다. 오케스트레이터가 Task 4 커밋 후 API 전체 test, typecheck, build를 통합 실행해야 한다.

## Scope

- `apps/api/src/mqtt/outbox-publisher.service.ts`
- `apps/api/src/mqtt/outbox-publisher.service.spec.ts`
- `apps/api/src/mqtt/provisioning-scan-outbox-publisher.service.ts`
- `apps/api/src/mqtt/provisioning-scan-outbox-publisher.service.spec.ts`

Task 4가 수정 중인 `mqtt.service.ts`, fixture-groups, sites, docs 파일은 변경하거나 stage하지 않는다.
