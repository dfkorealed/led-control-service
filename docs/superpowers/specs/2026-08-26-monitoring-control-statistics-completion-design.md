# 모니터링·제어·통계 완료 설계

기준일: 2026-08-26

## 1. 목적

이 설계는 이미 구현된 모니터링과 수동 제어의 감사 누락을 양산 기준으로 보완하고, 조명 상태 이력에 근거한 통계를 제공하는 기준이다. 통계의 모든 수치는 실측 계량기가 아닌 BLE Mesh `fixture-state` 수신 이력으로 계산하므로 화면과 API에서 항상 **상태 기반 추정**으로 표기한다.

이번 달 절감 비교 기준은 조회 시점에 등록된 조명의 현재 정격 전력을 합산하여, 해당 월 전체를 하루 24시간·밝기 100%로 점등했을 때의 비용이다. 이 기준은 실제 사용량, 과거 조명 구성, 전력 계량값과 혼동하지 않는다.

## 2. 범위와 보류

### 2.1 이번 범위

- 모니터링: provisioning 전 점멸 확인 제거, 검색 완료·실패 상태, 0건·실패 화면, 지도 최초 조회 오류와 재시도, 등록 완료 후 query 갱신
- 제어: 사용자 저장 구역 CRUD와 멤버십, MeshControlGroup 준비 상태, ACK 대상 집합 검증, `clientRequestId` 멱등성
- 통계: 오늘·이번 달·올해 상태 기반 추정 사용량, 일별·월별 꺾은선, 이번 달 예상 비용과 24시간 100% 기준 절감 비용

### 2.2 명시적 보류

- WebSocket/SSE push, 장애 이력·운영 workflow, RSSI·hop count 기반 통신 품질, 고급 모니터링
- 스케줄 제어, 이벤트 제어, 다중 gateway 명령 집계 고도화
- 모바일 전용 화면과 React Native 네이티브 구현
- 실측 전력 계량기, 시간대별 복합 요금제, 통계 내보내기와 drill-down

## 3. 현재 감사 결과

### 3.1 모니터링

현장·gateway claim·자사 UUID 필터·일괄/개별 등록·10분 snapshot 조회·읽기 전용 Konva 지도·Health Current 최신 상태는 구현되어 있다. 그러나 표준 BLE Mesh는 provisioning 전 node의 점멸 확인을 지원하지 않는데 현재 화면과 API는 성공한 것처럼 상태를 바꾼다. 또한 scan이 끝나거나 실패했음을 전달하는 계약이 없고, 지도 최초 조회 오류가 빈 canvas와 구분되지 않으며 등록 완료 후 필요한 화면 query가 즉시 갱신되지 않는다.

### 3.2 제어

개별·임의 다중·층 제어는 Command, Outbox, MQTT v2, gateway BLE Mesh 전송, 상태 polling으로 연결되어 있다. 저장 구역은 데이터가 있을 때만 제어할 수 있고 사용자가 만들 수 없으며, floor/group의 MeshControlGroup이 `configuring` 또는 `failed`일 때도 UI가 준비 상태를 알리지 않는다. ACK가 일부 fixture 결과만 포함해도 terminal 처리될 수 있고, POST 응답 유실 뒤 같은 명령이 중복 생성될 수 있다.

### 3.3 통계

현재 `EnergyUsage`는 런타임에서 쓰지 않으며, 통계 API는 현재의 `Fixture.ratedWatt`, `brightness`, 고정 12시간을 곱한 snapshot을 반환한다. 과거 밝기·정격 전력·수신 공백을 반영하지 못하고 일별·월별 시계열, 월 예상 비용, 절감 비용도 없다.

## 4. 공통 원칙

- API는 `SiteAccessService`로 현장 권한을 확인하고, 다른 현장과 미배정 현장은 기존 정책대로 `404`로 숨긴다.
- MQTT 이벤트는 gateway-scoped v2 topic, `eventId`, `sequence`, `occurredAt`을 사용한다. 동일 `eventId`와 낮은 sequence는 기존 `ProcessedGatewayEvent` 처리 규칙에 따라 적용하지 않는다.
- 공유 Prisma 스키마와 MQTT 계약은 backend가 먼저 변경하고 API·gateway·web이 해당 커밋을 기준으로 순차 적용한다.
- 자동 테스트의 route fixture와 fake MQTT는 계약 회귀 검증에만 사용한다. 실제 Raspberry Pi, BlueZ, ESP32-H2 검증은 수동 HIL로 별도 기록한다.

## 5. 모니터링 설계

### 5.1 등록 검색 상태와 MQTT 계약

`ProvisioningSession.status`는 등록 세션의 수명(`active`, 완료, 취소)을 유지한다. 검색의 수명은 별도 필드로 관리한다.

| 필드 | 형식 | 규칙 |
| --- | --- | --- |
| `scanStatus` | `pending | scanning | completed | failed` | 세션 생성 직후 `pending`, scan-start publish 직전 `scanning` |
| `scanCorrelationId` | UUID nullable | 매 scan 시작마다 새 UUID를 기록하며, 현재 시도와 같은 이벤트만 허용 |
| `scanAttempt` | 정수 | scan 재시도마다 1 증가 |
| `scanStartedAt` | UTC nullable | 현재 scan 시작 시각 |
| `scanCompletedAt` | UTC nullable | 완료 또는 실패 수신 시각 |
| `scanFailureCode` | 문자열 nullable | gateway가 분류한 실패 코드 |
| `scanFailureMessage` | 문자열 nullable | 사용자에게 노출 가능한 비밀값 없는 설명 |

`GatewayCommandKind`에 `provisioning/scan-start`와 `provisioning/scan-stop`은 유지한다. start payload에는 `sessionId`, `scanCorrelationId`, `scanAttempt`, `siteId`, `gatewayId`, `floorId`, `requestedAt`을 포함한다. Gateway는 자사 `DFKLED` UUID registry 필터를 통과한 node만 발견 이벤트로 발행한 뒤, 종료 시 아래 event 중 정확히 하나를 발행한다.

```text
sites/{siteId}/gateways/{gatewayId}/events/provisioning/scan-completed
sites/{siteId}/gateways/{gatewayId}/events/provisioning/scan-failed
```

두 event는 `siteId`, `gatewayId`, `eventId`, `sequence`, `occurredAt`, `sessionId`, `scanCorrelationId`, `scanAttempt`을 공통으로 가진다. 완료 event는 `acceptedNodeCount`를, 실패 event는 `bluetooth_unavailable | mesh_unavailable | scan_start_failed | scan_runtime_failed | scan_timeout` code와 비밀값 없는 `message`를 추가한다.

API는 `siteId`, `gatewayId`, `sessionId`, `scanCorrelationId`, `scanAttempt`이 현재 세션 행과 모두 일치하는 event만 행 잠금 transaction에서 반영한다. 이전 시도의 완료·실패와 세션 종료 뒤 이벤트는 상태와 발견 node를 변경하지 않고 구조화 로그만 남긴다. `scan-completed`는 `scanStatus=completed`, `scan-failed`는 `scanStatus=failed`로 바꾸며, 둘 모두 `scanCompletedAt`을 기록한다. 0개 결과는 실패가 아닌 `completed`와 `acceptedNodeCount=0`이다.

`POST /registration-sessions/:sessionId/nodes/:nodeId/identify`는 `501`과 `code=pre_provision_identify_unsupported`을 반환한다. 이 endpoint는 `DiscoveredMeshNode.status`, `identifyState`를 변경하거나 MQTT 명령을 발행하지 않는다. 웹 등록 패널에서는 provisioning 전 `점멸 확인` 버튼과 점멸 상태 표시를 제거한다.

### 5.2 등록과 지도 조회 UI

- 등록 패널은 `scanStatus=scanning` 또는 node가 `provisioning`인 동안 세션 조회를 1.5초 간격으로 수행한다. scan이 terminal이고 진행 중인 node가 없으면 polling을 중지하며, 등록 요청 뒤에는 provisioning 결과를 위해 다시 시작한다.
- 완료·0건 화면은 자사 BLE Mesh 조명이 검색되지 않았음을 표시하고 `다시 검색`으로 새 `scanCorrelationId`를 가진 scan만 시작한다.
- 실패 화면은 `scanFailureMessage`과 재시도 동작을 제공한다. gateway 인증서, 내부 예외 원문, Bluetooth adapter 식별자는 화면에 노출하지 않는다.
- provisioning 완료를 세션 polling으로 관측하면 `dashboard`, 현재 floor fixture pages, `map-snapshot`, registration session query를 모두 invalidate한다. 신규 fixture는 기존 정책대로 첫 실제 상태 전까지 `상태 확인 대기`로 표시한다.
- `map-snapshot`의 첫 요청이 실패했고 마지막 성공 snapshot이 없으면 기본 canvas를 렌더링하지 않는다. 지도 영역에는 오류와 재시도 버튼을 표시한다. 이전 snapshot이 있을 때 refetch가 실패하면 그 snapshot을 유지하고 갱신 실패 표기와 재시도만 추가한다. 성공 응답이 배경·도형 없음일 때만 빈 기본 canvas를 렌더링한다.

## 6. 제어 설계

### 6.1 저장 구역 데이터 모델과 경계

기존 `FixtureGroup`을 사용자 저장 구역으로 완성한다. 다음 필드를 추가한다.

| 모델 | 추가 필드·제약 | 목적 |
| --- | --- | --- |
| `FixtureGroup` | `floorId`, `gatewayId`, `deletedAt` | 구역을 정확히 한 층과 한 gateway에 고정하고 안전한 삭제 상태를 보존 |
| `FixtureGroup` | `@@index([siteId, floorId, gatewayId, deletedAt])` | 제어 대상과 관리 dialog 조회 |
| `GroupFixture` | 기존 복합 PK 유지 | 동일 조명 중복 가입 방지 |
| `MeshControlGroup` | `retiring`, `retired` 상태 추가 | 삭제 시 subscription 제거가 끝날 때까지 group 명령을 차단 |

서비스 transaction은 group, floor, gateway, 선택 fixture를 안정된 ID 순서로 잠그고 다음을 검증한다.

1. group의 floor와 gateway가 같은 site에 속한다.
2. 모든 fixture가 group의 `floorId`에 속하고 `MeshNode.gatewayId`가 group의 `gatewayId`와 일치한다.
3. fixture 하나는 삭제되지 않은 사용자 구역에 최대 15개까지만 가입한다.
4. 빈 구역, 중복 fixture ID, 제어 불가능 fixture는 생성·수정 입력으로 허용하지 않는다.

같은 제약을 PostgreSQL migration의 `GroupFixture` `BEFORE INSERT OR UPDATE` trigger로도 강제한다. trigger는 group/fixture 관계 불일치와 15개 초과를 거부하므로 직접 DB 변경도 서비스 규칙을 우회할 수 없다. `FixtureGroup`의 floor/gateway site 일치도 `BEFORE INSERT OR UPDATE` trigger에서 검증한다.

구역 삭제는 즉시 hard delete하지 않는다. 삭제 요청은 해당 MeshControlGroup을 `retiring`으로 바꾸고 membership 제거 subscription sync를 발행한다. gateway가 모두 적용했다고 ACK하면 `FixtureGroup.deletedAt`과 MeshControlGroup `retired`를 기록한다. `retiring`, `retired`, `failed` group은 제어 대상에서 제외하며, 실패한 삭제는 권한 있는 사용자가 재동기화할 수 있다. 과거 CommandDispatch의 group 참조는 삭제하지 않는다.

### 6.2 구역 API와 UI

```text
GET    /sites/:siteId/fixture-groups?floorId={floorId}
POST   /sites/:siteId/fixture-groups
PATCH  /sites/:siteId/fixture-groups/:groupId
DELETE /sites/:siteId/fixture-groups/:groupId
POST   /sites/:siteId/fixture-groups/:groupId/resync
```

생성·수정 body는 `{ name, floorId, gatewayId, fixtureIds }`이며 `fixtureIds`는 1~100개를 허용한다. 수정은 전체 membership 교체로 정의해 부분 수정의 순서 경쟁을 없앤다. 삭제는 `202`와 현재 `retiring` 상태를 반환한다. 목록과 dashboard control metadata는 `floorId`, `gatewayId`, fixture count, `MeshControlGroup.status`, `configurationVersion`, `lastError`를 반환한다.

제어 화면은 대상 선택 옆에 구역 관리 dialog를 둔다. `operator`, `admin`만 생성·수정·삭제·재동기화할 수 있고 `viewer`는 목록과 상태만 읽을 수 있다. 구역은 층과 gateway를 먼저 선택한 뒤 해당 경계의 fixture만 선택한다. 변경 직후 해당 구역은 `configuring`으로 표시하고 `ready` 전에는 구역 제어를 비활성화한다. floor도 동일한 MeshControlGroup 상태를 dashboard metadata로 반환해 `configuring`이면 준비 중, `failed`이면 실패 이유와 재동기화 동작을 표시하고 제어를 비활성화한다. API는 기존처럼 `ready`가 아닌 group 명령을 거부하며 unicast로 자동 대체하지 않는다.

### 6.3 ACK 완전성과 요청 멱등성

`device-status ACK` 처리 transaction은 dispatch와 모든 `CommandFixtureResult`를 잠근 뒤 ACK 결과의 fixture ID 집합을 dispatch snapshot의 fixture ID 집합과 정확히 비교한다. 중복 ID, 누락 ID, 예상 밖 ID가 하나라도 있으면 ACK 결과를 부분 반영하지 않는다. dispatch와 모든 예상 fixture result를 `failed`로 terminal 처리하고 오류 코드는 `ack_fixture_set_mismatch`로 기록한다. 실제 상태 snapshot은 별도 `fixture-state` event만 갱신한다.

`CreateDimmingCommandInput`과 `POST /commands/dimming` body에 UUID `clientRequestId`를 추가한다. `Command`에는 `clientRequestId`와 안정 정렬한 target·brightness로 계산한 SHA-256 `requestFingerprint`을 추가하고 `@@unique([siteId, requestedBy, clientRequestId])`를 둔다.

같은 사용자·현장·`clientRequestId` 요청은 transaction에서 기존 Command를 먼저 조회한다. fingerprint가 같으면 기존 command, dispatch 정보, terminal status URL을 반환하고 Outbox·sequence·BLE 명령을 새로 만들지 않는다. fingerprint가 다르면 `409 client_request_id_payload_conflict`를 반환한다. 웹은 적용 클릭 시 UUID를 만들고 POST 성공 응답, command status 복구, terminal 결과 확인 전까지 site/user 범위 `sessionStorage`에 요청 ID와 canonical payload를 보존한다. 네트워크 오류나 POST 응답 유실 뒤 재시도는 같은 값으로 수행한다.

## 7. 통계 설계

### 7.1 데이터 모델

`EnergyUsage`는 삭제하거나 의미를 바꾸지 않고 legacy 테이블로 유지한다. 신규 상태 기반 추정의 정본은 아래 모델이다.

| 모델 | 필드·제약 | 목적 |
| --- | --- | --- |
| `Site` | `timeZone String @default("Asia/Seoul")` | 현장별 일·월 경계 결정. IANA timezone만 허용 |
| `FixtureEnergyDailyAggregate` | `fixtureId`, `localDate @db.Date`, `estimatedKwh Decimal(16,6)`, `estimatedCost Decimal(16,2)`, `knownSeconds Int`, `unknownSeconds Int`, `createdAt`, `updatedAt` | 조명·현지 일자별 상태 기반 추정 합계 |
| `FixtureEnergyDailyAggregate` | `@@unique([fixtureId, localDate])`, `@@index([localDate])` | idempotent upsert와 기간 조회 |

`estimatedCost`는 해당 구간을 적산할 당시의 `Site.tariffKwhRate`로 함께 증가시켜, 이후 단가 변경이 과거 적산 비용을 바꾸지 않게 한다. 이번 달 예상 비용과 24시간 baseline은 조회 시점의 단가와 현재 등록 fixture를 사용하므로 응답에 이 기준을 명시한다.

### 7.2 상태 이벤트 적산

별도 interval 테이블이나 API process의 timer worker는 만들지 않는다. API는 **수락된** MQTT `fixture-state` event를 처리하는 기존 transaction 안에서, 현재 Fixture 행을 잠그고 이전 `lastStateOccurredAt`, `brightness`, `ratedWatt`을 사용해 이전 상태 구간을 닫는다.

1. 이전 시각이 없거나 incoming `occurredAt`이 이전 시각보다 같거나 이르면 적산하지 않는다.
2. `elapsedSeconds = incomingOccurredAt - previousLastStateOccurredAt`을 계산한다.
3. 이전 brightness와 정격 전력으로 `[previousLastStateOccurredAt, min(incomingOccurredAt, previousLastStateOccurredAt + 180초)]`만 known 구간으로 계산한다.
4. 180초를 넘는 나머지 시간은 unknown 구간으로 기록한다. 밝기 0%도 관측된 known 시간이며 `estimatedKwh=0`으로 적산한다.
5. known·unknown 구간 모두 `Site.timeZone`의 자정 경계에서 분할한다. 각 조각은 `FixtureEnergyDailyAggregate`에 `fixtureId + localDate` 기준으로 idempotent upsert한다.
6. known kWh는 `ratedWatt * (brightness / 100) * seconds / 3,600,000`으로 계산하고, 해당 구간의 현재 `tariffKwhRate`로 `estimatedCost`를 증가시킨다.
7. aggregate upsert와 Fixture 최신 상태 갱신은 같은 transaction으로 commit한다. transaction rollback, 중복 event, 낮은 sequence, 잘못된 site/gateway mapping, 역순 event에는 aggregate를 변경하지 않는다.

정격 전력 변경은 fixture 수정 transaction에서 먼저 같은 180초 규칙으로 기존 전력의 미닫힌 구간을 적산한 뒤 새 `ratedWatt`을 저장한다. 이로써 이후 `fixture-state`의 이전 전력 값이 바뀌어 과거 구간을 덮어쓰는 일을 막는다. `luxon`을 API 의존성으로 추가해 IANA timezone과 일광 절약 시간제의 일 경계를 정확히 계산한다.

### 7.3 통계 API와 계산식

기존 `/energy/default/estimate`, `/energy/sites/:siteId/estimate` snapshot endpoint는 웹 전환과 같은 배포에서 제거한다. 다음 두 API가 현장 통계의 유일한 조회 경로다.

```text
GET /energy/sites/:siteId/summary
GET /energy/sites/:siteId/series?granularity=day|month&from=YYYY-MM-DD&to=YYYY-MM-DD
```

두 API는 `read` 권한을 요구한다. `summary`는 현장 timezone 기준 오늘, 현재 달, 현재 연도와 조회 시각을 고정한다.

```ts
type EnergyPeriod = { estimatedKwh: number; estimatedCost: number; knownSeconds: number; unknownSeconds: number; dataStatus: "no_data" | "partial" | "available" };
type EnergySummary = {
  siteId: string; timeZone: string; source: "state_based_estimate"; generatedAt: string;
  today: EnergyPeriod; monthToDate: EnergyPeriod; yearToDate: EnergyPeriod;
  monthForecast: { estimatedKwh: number | null; estimatedCost: number | null; observedKnownSeconds: number; reason: "available" | "insufficient_state" | "no_registered_fixture" };
  baseline24Hours: { estimatedKwh: number; estimatedCost: number; fixtureCount: number; daysInMonth: number };
  estimatedSavings: { kwh: number | null; cost: number | null }; lastAggregatedAt: string | null;
};
```

`dataStatus`는 aggregate가 없으면 `no_data`, `unknownSeconds > 0`이면 `partial`, 그 외 known 값이 있으면 `available`이다. `monthForecast`는 이번 달 누적 `estimatedKwh / knownSeconds`를 평균 전력량으로 환산한 뒤, **조회 시점의 등록 fixture 수 × 해당 월 전체 초**에 곱해 계산한다. known 시간이 0이거나 등록 fixture가 없으면 forecast와 savings는 `null`이다.

`baseline24Hours.estimatedKwh`는 `sum(current registered Fixture.ratedWatt) * 24 * daysInMonth / 1000`이다. 비용은 조회 시점 `Site.tariffKwhRate`를 곱한다. `estimatedSavings`는 baseline에서 월 forecast를 뺀 값이며 음수는 0으로 표시하지 않고 실제 음수를 반환해 기준보다 사용량이 높다는 사실을 보존한다.

`series`의 `day`는 요청한 현지 날짜 범위의 각 일자를, `month`는 요청한 현지 월 범위의 각 월을 반환한다. 각 point는 `{ period, estimatedKwh: number | null, estimatedCost: number | null, knownSeconds, unknownSeconds, dataStatus }`이다. aggregate가 전혀 없는 point는 `estimatedKwh=null`로 반환해 웹이 0kWh 선을 그리지 않게 한다. 웹은 day 조회를 현재 달 전체, month 조회를 현재 연도 전체로 고정한다.

### 7.4 통계 UI

- 상단 카드에 오늘, 이번 달 누적, 올해 누적의 kWh와 비용을 표시하고 모두 `상태 기반 추정` 라벨과 dataStatus를 붙인다.
- `recharts` `LineChart`로 `일별`과 `월별` 탭을 제공한다. `null` point는 선을 연결하지 않고, partial point는 tooltip에서 수집 공백 시간을 표시한다.
- 비용 panel은 이번 달 예상 비용, 24시간 100% baseline 비용, 예상 절감 비용을 함께 표시한다. 기준은 `현재 등록 조명`, `해당 월 전체`, `24시간`, `100% 밝기`, `현재 단가`로 고정해 표시한다.
- 신규 현장, 조명은 있으나 첫 상태가 없는 현장, known 시간이 0인 현장은 0 통계·0 그래프 대신 상태 수집 후 표시된다는 empty state를 보인다. 수집 공백만 있는 현장은 마지막 누적값과 공백 표기를 유지한다.

## 8. 권한, 오류와 복구

| 기능 | operator | admin | viewer |
| --- | --- | --- | --- |
| 모니터링·통계 조회 | 가능 | 가능 | 가능 |
| 등록 검색·등록 | 가능 | 불가 | 불가 |
| 개별·다중·층·구역 제어 | 가능 | 가능 | 불가 |
| 구역 생성·수정·삭제·재동기화 | 가능 | 가능 | 불가 |

- scan failure와 map fetch failure는 기존 성공 데이터를 지우지 않는다. 새 session의 scan 실패는 재시도 전까지 이전 후보를 등록 대상으로 사용할 수 없게 한다.
- group sync 실패, 삭제 subscription 실패, ACK fixture 집합 불일치, `clientRequestId` payload conflict는 감사 로그에 actor·site·대상·오류 코드만 남긴다. 인증서, claim code, MQTT payload 원문은 기록하지 않는다.
- gateway 재연결과 MeshControlGroup resync는 기존 fail-closed 규칙을 유지한다. `ready`가 아닌 group에는 제어 송신을 하지 않는다.
- energy aggregation에서 timezone이 유효하지 않거나 aggregate upsert가 실패하면 상태 이벤트 transaction 전체를 rollback하고 재전달 가능한 MQTT 처리로 남긴다. 부분 aggregate만 commit하는 경로는 만들지 않는다.

## 9. 테스트와 HIL

### 9.1 자동 테스트

- scan completed, 0개 completed, failed, 이전 correlation 무시, identify `501` 무상태 변경, provisioning 완료 query invalidation
- map 최초 오류·재시도, 이전 snapshot 유지, 성공한 빈 지도와 오류 지도 구분
- 구역 floor/gateway 경계, fixture당 15개 한도, CRUD 권한, 삭제와 subscription removal, configuring/failed UI 차단
- floor/group ready 전 명령 차단, ACK 누락·중복·외부 fixture 집합 실패, 동일·상이한 `clientRequestId` 재시도
- energy duplicate·역순 event, 0% 밝기, 180초 경계, 자정·월말·DST timezone 분할, 정격 전력 변경, unknownSeconds, aggregate idempotency
- summary/series 권한 격리, 신규·부분 수집·공백 현장, forecast와 24시간 baseline 계산, Recharts의 `null` point와 empty state

### 9.2 수동 HIL

실제 HIL은 자동 테스트와 별도로 전용 Raspberry Pi, broker, ESP32-H2에서 수행한다. 자사 UUID 장치만 검색되는지, scan 완료·0건·Bluetooth 실패 화면, 일괄 등록 뒤 즉시 지도 갱신, 구역 subscription 준비·실패·재동기화, 단일/다중/floor/group 밝기 반영과 완전 ACK, 60초 publication 기반 180초 적산을 확인한다. 계량기가 있는 경우에는 통계값을 같은 시간대의 분전반 계측값과 비교하되, 차이가 있어도 화면 표기는 상태 기반 추정을 유지한다.

## 10. 마이그레이션과 배포 순서

1. backend가 Prisma schema, SQL trigger, shared MQTT/API schema와 migration을 추가한다. 기존 `EnergyUsage`와 기존 `FixtureGroup` 데이터는 보존하고, 기존 group은 운영자가 floor/gateway/membership을 검증한 뒤 migration script로만 backfill한다. 경계를 확정할 수 없는 legacy group은 `failed`로 옮겨 제어 대상에서 제외한다.
2. API가 scan lifecycle, identify unsupported, group CRUD·sync metadata, ACK completeness, command idempotency, energy aggregation·summary·series를 적용하고 migration 후에 배포한다.
3. gateway가 scan complete/failed event와 모든 대상 fixture 결과를 포함한 ACK를 발행하도록 shared contract에 맞춰 배포한다.
4. web이 등록·지도 오류·구역 dialog·group 상태·idempotent 재시도·Recharts 통계를 새 API로 전환한다. API와 웹이 전환된 뒤 기존 energy snapshot endpoint를 제거한다.
5. 자동 테스트, API build, web build, gateway contract test를 통과한 뒤 전용 실장비에서 수동 HIL을 수행한다. HIL 증거가 없으면 메뉴 기능은 코드 검증 완료로만 기록한다.

## 11. 완료 조건

- provisioning 전 identify는 UI에 없고 API도 상태 변경 없이 명시적으로 미지원 응답을 반환한다.
- scan session은 correlation 기반 completed/failed/0건 상태를 가지며, 등록 완료 뒤 모니터링 query가 즉시 갱신된다.
- 지도 최초 조회 오류가 빈 지도와 구분되고 재시도할 수 있다.
- operator/admin이 한 층·한 gateway 경계와 fixture당 15개 한도 안에서 구역을 관리하고, configuring/failed 구역은 제어할 수 없다.
- 모든 device-status ACK는 dispatch fixture 집합과 정확히 일치할 때만 성공 또는 부분 성공으로 반영된다.
- 같은 `clientRequestId`의 같은 제어 요청은 하나의 command만 만들고, 다른 payload는 conflict가 된다.
- 통계는 상태 기반 추정으로 오늘·이번 달·올해 누적, 일별·월별 LineChart, 이번 달 예상 비용과 24시간 100% baseline 대비 절감 비용을 표시한다.
- 기존 `EnergyUsage`는 보존되고, 신규 aggregate는 180초 한계·현장 timezone·idempotent upsert 규칙을 만족한다.
- 자동 테스트와 실제 HIL 결과가 문서와 상태판에서 구분되어 기록된다.
