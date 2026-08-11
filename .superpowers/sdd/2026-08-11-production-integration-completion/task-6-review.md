# Task 6 조명 등록 소유권과 실제 초기 상태 최종 엄격 리뷰

## 결론

**CHANGES REQUESTED**

- Critical: 1
- Important: 3
- Minor: 0
- 총 finding: 4

## Load-bearing Findings

### Critical 1. 웹 등록 경로가 필수 `gatewayId`를 보내지 않아 조명 검색을 시작할 수 없다

**근거:** `apps/web/src/api/registration.ts:30`, `apps/web/src/api/registration.ts:31`, `apps/web/src/features/registration/RegistrationPanel.tsx:31`, `apps/web/src/features/registration/RegistrationPanel.tsx:49`, `packages/shared/src/schemas.ts:298`, `apps/api/src/registration/registration.controller.ts:25`, `apps/web/src/App.test.tsx:112`, `apps/web/src/App.test.tsx:119`

API는 세션 생성 body에 `siteId`, `floorId`, `gatewayId`를 모두 요구하고 strict schema로 파싱한다. 그러나 제품 웹 클라이언트의 `createRegistrationSession()`은 여전히 두 인자만 받고 `{ siteId, floorId }`만 POST한다. `RegistrationPanel`도 첫 floor를 암묵 선택할 뿐 gateway를 선택하거나 전달하지 않는다. 따라서 사용자가 `조명 검색 시작`을 누르면 API 입력 파싱 단계에서 실패하며 Task 6의 실제 등록 workflow 전체가 막힌다.

웹 테스트 mock은 요청 body에 없는 gateway를 dashboard 첫 gateway로 자동 주입해 이 계약 파손을 숨긴다. 명시적 floor/gateway 선택 UI와 `gatewayId` 전달, 누락 시 실패하는 실제 request assertion이 필요하다.

### Important 1. 정확히 90초 된 heartbeat를 등록 API는 허용하지만 같은 서버의 상태 판정은 offline으로 표시한다

**근거:** `apps/api/src/registration/registration.service.ts:15`, `apps/api/src/registration/registration.service.ts:36`, `apps/api/src/fixtures/fixtures.service.ts:48`, `apps/api/src/fixtures/fixtures.service.ts:49`, `apps/api/src/sites/sites.service.ts:145`, `apps/api/src/sites/sites.service.ts:146`, `apps/api/src/registration/registration.service.spec.ts:115`

세션 생성 query는 `lastHeartbeatAt >= now - 90s`라서 정확히 90초인 gateway를 허용한다. 반면 fixture/dashboard의 connection status는 `age < 90s`일 때만 online이므로 같은 순간 해당 gateway를 offline으로 반환한다. 문서의 "90초 이상 없으면 offline" 계약과도 등록 query가 어긋난다.

현재 테스트는 Prisma mock이 null을 반환하는지만 확인하며 89,999ms/90,000ms/90,001ms 경계를 검증하지 않는다. 하나의 strict 경계 규칙으로 통일하고 고정 시각 boundary test가 필요하다.

### Important 2. `provisioning_waiting_state` fixture를 점검 큐에서 다시 실제 오프라인으로 집계한다

**근거:** `apps/web/src/features/monitoring/MonitoringView.tsx:31`, `apps/web/src/features/monitoring/MonitoringView.tsx:32`, `apps/web/src/features/monitoring/MonitoringView.tsx:149`, `apps/web/src/features/monitoring/MonitoringView.tsx:208`, `apps/web/src/features/monitoring/MonitoringView.tsx:211`, `apps/web/src/features/monitoring/MonitoringView.tsx:212`, `apps/web/src/features/monitoring/FloorMap.test.tsx:50`

지도 marker와 상세 status text는 대기 상태를 `상태 확인 대기`로 분기하지만, 점검 큐의 `firstOfflineFixture`와 `offlineCount`는 `status === "offline"`만 본다. 그래서 아직 첫 실제 상태를 받지 않은 fixture가 `오프라인 N대`에 포함되고 오프라인 점검 대상으로 선택된다. 이는 report의 "실제 offline과 별도 표시" 주장과 provisioning 상태 의미론을 UI의 주요 운영 목록에서 깨뜨린다.

대기 상태를 실제 offline 집계/선택에서 제외하거나 별도 대기 항목으로 분리하고, MonitoringView 수준의 회귀 테스트가 필요하다.

### Important 3. 모든 `P2002`를 cross-site device UUID 충돌로 처리해 다른 원자성 실패를 잘못 확정한다

**근거:** `apps/api/src/mqtt/mqtt.service.ts:432`, `apps/api/src/mqtt/mqtt.service.ts:444`, `apps/api/src/mqtt/mqtt.service.ts:476`, `apps/api/src/mqtt/mqtt.service.ts:477`, `apps/api/src/mqtt/mqtt.service.ts:498`, `apps/api/src/mqtt/mqtt.service.ts:533`, `apps/api/prisma/schema.prisma:257`, `apps/api/prisma/schema.prisma:435`, `apps/api/prisma/migrations/20260702143000_add_registration_flow/migration.sql:48`, `apps/api/prisma/migrations/20260702143000_add_registration_flow/migration.sql:51`

provisioning 완료 transaction의 rollback 자체는 DB 경계 안에 있지만 catch는 Prisma `P2002`의 target을 확인하지 않는다. 이 transaction에서는 `MeshNode.deviceUuid` 외에도 `(gatewayId, meshAddress)`, `Fixture.meshNodeId`, fixture/event ID 관련 unique 충돌이 발생할 수 있다. 어느 제약이 실패해도 현재 attempt를 `device UUID is already registered by another site`로 확정해 실제 원인을 숨긴다.

특히 별도 UUID의 concurrent registration이 같은 mesh address를 충돌시키면 cross-site UUID 충돌로 오표시될 수 있다. `P2002.meta.target`이 `MeshNode_deviceUuid_key`일 때만 해당 경쟁 처리로 전환하고, 실제 PostgreSQL transaction에서 winner fixture 보존, loser 전체 rollback, cross-site loser만 failed가 되는 통합 테스트가 필요하다. 현재 unit test는 callback을 같은 mock 객체에서 실행하고 임의의 `{ code: "P2002" }`를 던져 실제 제약 대상과 rollback 원자성을 검증하지 않는다.

## 판정 근거

tenant/site/floor/gateway 범위를 제한하는 서버 query, provisioning 직후 `offline + provisioning_waiting_state + lastSeenAt null`, 첫 scoped fixture-state의 snapshot 갱신, DB transaction 사용 방향은 확인했다. 그러나 제품 웹이 새 필수 계약을 호출하지 못하는 Critical 회귀가 있고, heartbeat와 UI 의미론 및 UUID race 분류에도 load-bearing 불일치가 남아 Task 6를 완료로 승인할 수 없다.

## 검증 범위

- 정적 검토: `3c61281..ed7cc7b` diff, Task 6 brief/report, 관련 API/web/shared/Prisma 구현과 테스트
- 확인: 소유권 query, 90초 비교 연산자, provisioning transaction과 unique index, 초기 fixture 값, fixture-state 갱신 경로, 모니터링 표기/집계
- 미실행: 사용자 요청에 따라 추가 test/typecheck 및 실제 PostgreSQL 동시성 통합 테스트 없이 현재 확보한 증거로 즉시 마감

## Fix Round1

### 결론

**CHANGES REQUESTED**

- Critical: 0
- Important: 2
- Minor: 0
- 잔존 finding: 1
- 신규 finding: 1

### 이전 finding 처리 상태

- **기존 Critical 1 해결:** 등록 UI가 층과 gateway를 명시적으로 선택하게 하고, 실제 POST body에 `siteId`, `floorId`, `gatewayId`를 모두 전달한다. 제품 호출 body assertion도 추가됐다.
- **기존 Important 1 해결:** shared freshness helper로 등록 query, dashboard/fixture 응답, 명령 검사와 worker가 inclusive 90초 경계를 공유한다. 89,999ms/90,000ms/90,001ms 경계 테스트도 추가됐다.
- **기존 Important 2 미해결:** `MonitoringView`의 offline 점검 큐 집계/선택 코드는 수정되지 않았다. 아래 잔존 finding과 같다.
- **기존 Important 3 해결:** `P2002.meta.target`이 `deviceUuid` unique target일 때만 UUID 경쟁 처리로 전환하고, mesh address 등 다른 unique constraint와 일반 transaction 오류는 rethrow한다.

### Important 1. `provisioning_waiting_state`가 여전히 실제 오프라인 점검 큐에 포함된다

**근거:** `apps/web/src/features/monitoring/MonitoringView.tsx:31`, `apps/web/src/features/monitoring/MonitoringView.tsx:32`, `apps/web/src/features/monitoring/MonitoringView.tsx:149`, `apps/web/src/features/monitoring/MonitoringView.tsx:208`, `apps/web/src/features/monitoring/MonitoringView.tsx:211`, `apps/web/src/features/monitoring/MonitoringView.tsx:212`

FixRound1은 freshness worker에서 waiting fixture를 제외했지만 이전 finding은 worker가 아니라 운영 UI의 의미론 문제였다. 점검 큐는 여전히 `status === "offline"`만으로 `firstOfflineFixture`와 `offlineCount`를 계산하므로 초기 상태 대기 fixture를 `오프라인 N대`에 포함하고 오프라인 점검 대상으로 선택한다. marker/detail의 `상태 확인 대기` 표기와 점검 큐가 서로 모순된다.

대기 reason을 실제 offline 집계에서 제외하거나 별도 대기 큐로 분리하고 `MonitoringView` 회귀 테스트가 필요하다.

### Important 2. fixture stale query가 모든 offline fixture를 다시 매치해 `gateway_offline` 사유를 즉시 덮어쓴다

**근거:** `apps/api/src/fixtures/fixture-freshness.service.ts:23`, `apps/api/src/fixtures/fixture-freshness.service.ts:31`, `apps/api/src/fixtures/fixture-freshness.service.ts:33`, `apps/api/src/fixtures/fixture-freshness.service.ts:36`, `apps/api/src/fixtures/fixture-freshness.service.ts:38`, `apps/api/src/fixtures/fixture-freshness.service.ts:41`, `apps/api/src/fixtures/fixture-freshness.service.spec.ts:25`

FixRound1은 두 번째 `fixtureStale` update에서 기존 `status: { not: "offline" }` 조건을 제거했다. 따라서 첫 update가 heartbeat 단절 fixture를 `offline + gateway_offline`으로 만든 직후, 같은 실행의 두 번째 update가 `lastStateOccurredAt`이 180초보다 오래됐거나 null인 동일 fixture를 다시 매치해 `statusReason = fixture_stale`로 덮어쓴다. 기존 offline, command-failed 상태도 같은 방식으로 원인 우선순위를 잃을 수 있다.

waiting fixture는 원래 `status = offline`이므로 기존 status 조건만으로도 stale update에서 제외됐다. waiting 제외 조건을 추가하더라도 기존 offline guard를 보존하고, 한 번의 worker 실행 뒤 gateway-offline reason이 유지되는 순차 update 테스트가 필요하다.

### FixRound1 판정 근거

필수 gateway 전달, 90초 경계, UUID unique target 분기는 해결됐다. 그러나 이전 UI 의미론 finding이 그대로 남았고, freshness worker가 더 구체적인 gateway outage 원인을 stale로 덮는 신규 회귀를 만들었으므로 Task 6를 승인할 수 없다.

### FixRound1 검증 범위

- 정적 검토: `ed7cc7b..d9736c9` diff와 이전 4 findings 관련 구현/테스트
- PASS: `git diff --check ed7cc7b..d9736c9`
- 미실행: 사용자 요청에 따라 추가 test/typecheck 없이 즉시 판정

## Fix Round2

### 결론

**APPROVED**

- Critical: 0
- Important: 0
- Minor: 0
- 잔존/신규 finding: 0

### 이전 잔존 finding 처리 상태

- **모니터링 점검 큐 해결:** `operationallyOfflineFixtures`가 `status === "offline"`이면서 `statusReason !== "provisioning_waiting_state"`인 fixture만 포함한다. offline 대수와 첫 선택 대상이 같은 filtered collection을 사용하므로 waiting fixture는 실제 오프라인 점검 큐에서 제외된다. App 회귀 테스트도 waiting fixture와 실제 offline fixture를 함께 제공해 `오프라인 1대` 및 선택 결과를 검증한다.
- **freshness 사유 보존 해결:** `fixtureStale` update에 `status: { not: "offline" }` guard를 복원했다. 앞선 update가 설정한 `offline + gateway_offline`은 같은 worker 실행의 stale query 대상에서 제외되므로 더 구체적인 gateway outage 사유가 유지된다. waiting reason 제외 조건도 함께 보존된다.

### 신규 회귀 검토

`d9736c9` 이후 미커밋 변경에서 위 두 수정과 직접 관련된 신규 Critical/Important 회귀는 확인하지 못했다. UI 집계와 선택 대상은 동일한 배열을 사용하고, worker의 두 순차 update는 offline guard로 원인 우선순위를 유지한다. 관련 메뉴 문서도 실제 동작과 일치한다.

### Fix Round2 검증

- PASS: `pnpm --filter @led-control/api test -- --runInBand src/fixtures/fixture-freshness.service.spec.ts` (1 suite, 1 test)
- PASS: `pnpm --filter @led-control/web test -- --run src/App.test.tsx` (1 file, 40 tests)
- PASS: `git diff --check d9736c9`
- 정적 검토: `d9736c9` 이후 미커밋 diff의 monitoring queue, freshness worker, 관련 테스트와 문서
