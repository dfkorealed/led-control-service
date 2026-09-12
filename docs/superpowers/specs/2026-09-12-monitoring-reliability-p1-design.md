# 모니터링 신뢰성 P1 설계

## 목표

모니터링 화면이 일시적인 API 실패에도 마지막 정상 데이터를 유지하고, 현장별 freshness 기준에 따라 30초 이내에 상태를 갱신하며, 운영자가 장애를 확인·담당 지정·해결하고 이력을 조회할 수 있게 한다.

## 설계 결정

### 1. 갱신과 stale 표시

- Web 모니터링 query는 30초 polling을 기본으로 사용한다. WebSocket/push는 별도 인프라와 인증·재연결 계약이 필요하므로 이번 P1에서는 도입하지 않는다.
- dashboard, 선택 층 fixture, map은 각각 마지막 성공 데이터를 유지한다. 최초 로드 실패만 전체 오류로 표시하고, 재조회 실패는 화면을 지우지 않고 상단 persistent banner로 표시한다.
- dashboard와 fixture page 응답에 서버 `generatedAt`을 추가한다. UI는 fixture 전체 page 중 가장 오래된 `generatedAt`과 query error를 기준으로 다음을 구분한다.
  - 정상: 마지막 fixture snapshot 성공 후 60초 이하이고 현재 오류 없음
  - 지연: 60초 초과 또는 일부 query 실패 — 마지막 데이터를 유지하며 stale banner와 재시도 제공
- “마지막 갱신”은 브라우저 요청 완료 시각이 아니라 서버 fixture snapshot `generatedAt`을 표시한다. 미래 시각은 정상으로 축약하지 않고 “시간 차이 확인”과 절대 ISO 시각을 함께 보여준다.
- React Query는 실패 시 2회 bounded retry 후 다음 30초 polling에서 다시 시도한다. window focus 재진입도 즉시 refetch한다.

### 2. 현장별 freshness 정책

- `Site.gatewayOfflineAfterSeconds` 기본 90, 허용 30–900.
- `Site.fixtureStaleAfterSeconds` 기본 180, 허용 60–3,600.
- monitoring dashboard/fixture connection status와 freshness sweep은 같은 Site 값을 사용한다. 등록·식별 등 장비 제어 안전성의 기존 90초 계약은 이번 monitoring 표시 정책과 분리해 유지한다.
- `GET /sites/:siteId/monitoring-policy`는 read capability, `PATCH`는 manage capability가 필요하다. PATCH는 두 값을 모두 받고 `expectedUpdatedAt`으로 optimistic concurrency를 검증한다.
- dashboard는 `monitoringPolicy`와 `generatedAt`을 반환해 Web이 서버 판정 기준을 설명할 수 있게 한다.

### 3. incident 도메인

`MonitoringIncident`는 단일 장애 occurrence의 이력이다.

- type: `gateway_offline`, `fixture_stale`, `fixture_fault`, `command_failed`
- status: `open`, `acknowledged`, `resolved`
- target: gateway 또는 fixture 중 정확히 하나. `targetKey`와 nullable unique `activeKey`로 같은 site/type/target의 active incident를 하나만 허용한다.
- 시각: `openedAt`, `lastObservedAt`, `acknowledgedAt`, `resolvedAt`, `createdAt`, `updatedAt`
- actor: `acknowledgedByUserId`, `assignedToUserId`, `resolvedByUserId`; 사용자 삭제 시 과거 이력을 위해 SetNull.
- resolution: `automatic_recovery` 또는 `operator_confirmed`, optional note.
- Site/target 삭제 시 incident는 cascade한다. 운영 이력을 Site 삭제 후에도 보존하는 범위는 아니다.

30초 freshness sweep이 현장 상태를 갱신한 뒤 현재 장애 집합을 reconcile한다.

- gateway heartbeat 만료는 gateway당 하나의 `gateway_offline` incident를 연다.
- fixture의 `fixture_stale`, Health fault, `command_failed`는 fixture당 해당 type incident를 연다.
- 계속 관측되면 `lastObservedAt`만 갱신하고 acknowledge/assignee는 보존한다.
- 조건이 사라지면 active incident를 `automatic_recovery`로 해결한다.
- operator-confirmed 해결은 API 시점에 대상 조건이 이미 해소된 경우만 허용한다. 아직 장애 상태면 `409 INCIDENT_STILL_ACTIVE`다.
- 첫 reconcile 이전의 과거 상태를 별도 migration으로 backfill하지 않는다. 배포 후 첫 sweep부터 이력을 만든다.

### 4. incident API와 권한

- `GET /sites/:siteId/monitoring-incidents?status=open|acknowledged|resolved|all&type=&cursor=&limit=`: read capability, 기본 active 우선 최신순, cursor pagination.
- `PATCH /sites/:siteId/monitoring-incidents/:incidentId`
  - `action=acknowledge`: open만 acknowledged로 전환.
  - `action=assign`: active incident의 assignee를 active site admin/member 또는 null로 변경.
  - `action=resolve`: 대상 조건 해소를 재검증하고 note와 함께 해결.
- 변경은 manage capability와 `expectedUpdatedAt`을 요구하며 Site row → incident row 순서 잠금, 재인가, optimistic concurrency를 적용한다.
- 모든 변경은 `AuditLog`에 actor/site/incident/action/outcome을 기록한다.

### 5. Web UI

- 오른쪽 공통 SidePanel 안에 `조명 상세` / `인시던트` 탭을 둔다. 지도 영역 너비는 유지한다.
- status reason presenter를 하나로 분리해 selector, marker aria-label, badge, 상세 원인/권장 조치에서 같은 용어를 사용한다.
- incident 탭은 active 건수를 표시하고 상태/type filter, 이력 목록, acknowledge/assignee/resolve action을 제공한다. read-only 사용자는 action 없이 이력만 본다.
- manage 사용자는 같은 탭의 “판정 기준” dialog에서 두 threshold를 수정한다. 설정 성공 후 dashboard/fixture/incident query를 invalidate한다.
- dashboard/fixture 일부 갱신 실패 시 현재 지도·선택 조명·incident 목록을 유지하며 banner에서 실패 범위와 마지막 서버 snapshot 시각을 보여준다.

## migration과 배포 순서

1. additive Site columns, incident enum/table/index/check migration 배포.
2. API deploy: policy defaults, generatedAt metadata, reconciler/API 제공.
3. Web deploy: 30초 polling, cached fallback, incident UI.

구버전 Web은 추가 응답 필드를 무시한다. 구버전 API는 새 Site column DB default와 incident table을 사용하지 않아도 동작한다. 사용자 DB migration과 실제 배포는 이 작업에서 수행하지 않는다.

## 검증

- Prisma/migration: 빈 disposable PostgreSQL 전체 migration 및 기존 Site upgrade/default 확인.
- API unit/integration: threshold 경계/권한/concurrency, incident open→ack→assign→recovery/resolve, target scope, cursor.
- freshness: 서로 다른 두 Site threshold, single-flight, incident reconcile.
- Web unit: cached dashboard error 유지, 30초 polling/retry/focus, stale banner, reason presentation, incident 권한/action/policy optimistic conflict.
- Chromium: cached data 중 dashboard/fixture/map 부분 실패, 60초 stale 경계, 네 status reason, incident workflow와 1440/1024/390/320 overflow.
- 실제 MQTT broker, Raspberry Pi/BlueZ/ESP32-H2 HIL과 production notification 연동은 수행하지 않는다.

## 제외 및 후속

- push/WebSocket/SSE와 email/SMS/메신저 notification은 제외한다.
- incident escalation/SLA, 코멘트 thread, 첨부, 외부 ticket 연동은 제외한다.
- P0 감사에서 확인한 automation RF capacity gate와 event-sequence 파일 내구성은 별도 P0 후보로 유지한다.
