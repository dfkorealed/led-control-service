# 모니터링 수동 장치 상태 확인 설계

기준일: 2026-09-15

## 목적

모니터링의 `새로고침`을 단순 HTTP 재조회가 아니라 선택한 맵의 실제 조명 통신 상태를 확인하는 동작으로 바꾼다. 사용자가 물리적으로 조명 전원을 차단한 뒤 새로고침하면 Gateway가 해당 조명에 읽기 전용 조회를 수행하고, 두 번 연속 응답하지 않은 조명을 오프라인으로 반영해야 한다.

현재 BIO 장치는 Gateway가 10분마다 조회하고 마지막 성공 응답 후 20분을 초과해야 오프라인이 된다. Web의 수동 새로고침은 dashboard, fixture, map API만 다시 호출하므로 이 20분 안에는 마지막 `online` snapshot을 그대로 보여준다. 프론트 캐시 오류가 아니라 수동 사용자 동작과 장치 상태 수집 경로가 연결되지 않은 것이 원인이다.

## 확정 범위

- 대상은 모니터링에서 현재 선택된 맵(층)의 등록 조명이다.
- admin과 viewer 모두 기존과 같이 새로고침을 사용할 수 있다. 이 작업은 밝기·모드·주소를 바꾸지 않는 read-only 장치 조회다.
- 새로고침 한 번은 장치 확인 요청을 한 번만 생성한다. 처리 중 중복 클릭과 동일 `clientRequestId` 재전송은 같은 요청으로 수렴한다.
- Gateway는 첫 조회에서 실패한 조명만 한 번 더 확인한다. 두 번 모두 장치 미발견, GET timeout 또는 검증된 read 실패인 경우에만 해당 조명을 오프라인으로 확정한다.
- Gateway 또는 MQTT 경로 자체를 확인하지 못한 경우에는 조명을 개별 오프라인으로 확정하지 않는다. Gateway freshness가 만료됐다면 기존 `gateway_offline` 규칙을 사용하고, 그 외에는 `확인 실패`로 안내하며 마지막 상태를 보존한다.
- 응답한 BIO sensor 장치는 온라인으로 갱신하되 설정 밝기를 실제 출력 밝기로 사용하지 않는다. 기존 presence/state/energy 분리 계약을 유지한다.
- 자동 10분 조회와 20분 stale 판정은 백그라운드 안전망으로 유지한다.
- ESP32-H2 firmware는 변경하지 않는다. Gateway 애플리케이션, API, Web, shared contract와 DB만 변경한다.

## 고려한 접근

### A. 수동 targeted reachability check — 채택

Web이 API에 선택 층 확인을 요청하고, API가 등록된 fixture를 신뢰 가능한 Gateway별로 묶어 durable MQTT command를 생성한다. Gateway는 기존 adapter의 읽기 경로를 재사용해 fixture별 성공/실패를 보고한다. 성공은 presence ingestion으로, 검증된 연속 실패는 unreachable ingestion으로 반영한다.

사용자가 누른 새로고침과 실제 장치 확인이 직접 연결되고, 자동 주기를 줄이지 않아 평상시 USB/MQTT 부하를 늘리지 않는다.

### B. 자동 polling과 stale 기준 단축 — 제외

예를 들어 1분 polling과 2분 stale을 사용하면 구현은 상대적으로 단순하지만 모든 현장에서 지속적인 USB/MQTT 부하가 증가한다. 버튼을 눌렀을 때 완료를 알 수 없고, polling 사이에는 여전히 이전 상태가 보인다.

### C. 20분 정책 유지와 마지막 확인 시각만 표시 — 제외

현재 동작을 더 잘 설명할 수는 있지만 물리 전원 차단 뒤 수동 확인이라는 사용자 요구를 해결하지 못한다.

## 사용자 흐름

1. 사용자가 모니터링에서 맵을 선택하고 `새로고침`을 누른다.
2. 버튼은 `장치 상태 확인 중`으로 바뀌고 완료될 때까지 비활성화된다.
3. Web은 선택 층의 식별자와 새 UUID `clientRequestId`만 API에 전송한다. fixture ID나 Gateway ID는 브라우저가 지정하지 않는다.
4. API는 현재 DB 관계에서 선택 층의 등록 fixture와 Gateway를 확정하고 확인 요청을 생성한다.
5. Gateway가 fixture별 읽기 전용 조회를 수행한다. 첫 실패 fixture만 한 번 재시도한다.
6. API가 모든 결과 또는 제한 시간 종료를 terminal 상태로 저장한다.
7. Web은 terminal 상태를 확인한 뒤 dashboard, 선택 층 fixture, map snapshot을 다시 조회한다.
8. 응답한 조명은 정상, 두 번 연속 응답하지 않은 조명은 오프라인으로 KPI·마커·상세 패널에 함께 반영된다.
9. 일부 결과를 확인하지 못한 경우 확인된 조명 상태는 반영하고 `일부 조명의 상태를 확인하지 못했습니다.`를 표시한다.

층에 등록 조명이 없으면 hardware request를 만들지 않고 기존 HTTP 데이터만 새로고침한다.

## HTTP 계약

### 요청 생성

```text
POST /sites/:siteId/floors/:floorId/monitoring-refreshes
Content-Type: application/json

{ "clientRequestId": "uuid" }
```

응답은 다음 최소 정보를 제공한다.

```json
{
  "id": "refresh-uuid",
  "status": "pending",
  "totalFixtures": 2,
  "terminalStatusUrl": "/sites/site-id/monitoring-refreshes/refresh-uuid"
}
```

### 상태 조회

```text
GET /sites/:siteId/monitoring-refreshes/:refreshId
```

```json
{
  "id": "refresh-uuid",
  "status": "completed",
  "totalFixtures": 2,
  "onlineFixtures": 1,
  "offlineFixtures": 1,
  "unverifiedFixtures": 0,
  "completedAt": "2026-09-15T08:00:00.000Z"
}
```

`status`는 `pending | completed | partial | failed | expired`다. `partial`은 online/offline 결과와 unverified가 함께 있는 경우, `failed`는 확인 가능한 fixture 결과가 하나도 없는 경우다. HTTP 응답에는 raw USB packet, native UUID, Mesh address, 내부 exception 문구를 포함하지 않는다.

### 권한·중복·제한

- 두 endpoint 모두 현재 site의 `read` capability가 필요하고, floor가 해당 site의 active floor인지 확인한다.
- 같은 `siteId + requestedBy + clientRequestId`는 같은 payload이면 기존 요청을 반환하고 다른 floor이면 `409`다.
- 같은 site/floor에 active 요청이 있으면 새 hardware job을 만들지 않고 기존 요청을 반환한다.
- terminal 요청 완료 뒤 30초 동안 같은 사용자/site/floor의 새 요청은 `429`와 재시도 가능 시각을 반환한다.
- 한 요청은 최대 1,000 fixture, 한 Gateway batch는 최대 64 fixture다. 이 범위를 넘는 층은 여러 batch로 나누고 1,000개 초과는 명시적으로 거부한다.
- 요청 전체 deadline은 생성 시각부터 30초다. deadline 이후 도착한 실패 결과는 조명 상태를 offline으로 되돌리지 않는다.

## DB 구조

일반 조명 제어의 `Command.brightness`와 제어 이력을 거짓 값으로 채우지 않기 위해 전용 모델을 사용한다.

### `MonitoringRefresh`

- `id`, `siteId`, `floorId`, `requestedById`, `clientRequestId`
- `status`: `pending | completed | partial | failed | expired`
- `totalFixtures`, `onlineFixtures`, `offlineFixtures`, `unverifiedFixtures`
- `deadlineAt`, `completedAt`, `createdAt`, `updatedAt`
- unique: `(siteId, requestedById, clientRequestId)`
- index: `(siteId, floorId, status)`, `(createdAt)`

### `MonitoringRefreshBatch`

- `id`, `refreshId`, `gatewayId`, `sequence`, `idempotencyKey`
- `targetFixtureIds` JSON snapshot
- `status`: `pending | published | completed | failed | expired`
- `errorCode`, `publishedAt`, `completedAt`, `createdAt`, `updatedAt`
- unique: `(gatewayId, sequence)`, `(idempotencyKey)`

### `MonitoringRefreshFixture`

- `refreshId`, `fixtureId`, `batchId`
- `status`: `pending | online | offline | unverified`
- `errorCode`, `observedAt`, `createdAt`, `updatedAt`
- primary key: `(refreshId, fixtureId)`

### `Fixture`

- nullable `lastUnreachableAt`을 추가한다.
- manual check 실패 수신 시 API 수신 시각을 저장한다.
- 이후 더 최신 presence/state가 들어오면 `lastUnreachableAt`을 `null`로 되돌린다.
- `monitoringFixtureState`는 `lastUnreachableAt`이 `lastSeenAt`보다 최신이면 20분 threshold를 기다리지 않고 `offline + fixture_stale`로 판정한다.
- `reportedStatus`와 `reportedStatusReason`은 장치가 실제로 보고한 값이므로 manual failure로 변경하지 않는다.

`MqttOutbox`에는 nullable `monitoringRefreshBatchId` relation을 추가해 command가 broker PUBACK만 받고 사라지지 않도록 한다. terminal batch result가 같은 transaction에서 반영된 뒤 해당 outbox를 제거한다. terminal 요청과 fixture 결과는 7일 보존 후 기존 retention worker가 안전하게 정리한다.

DB schema와 migration 변경이 있으므로 `docs/database-schema.md`를 함께 갱신한다.

## MQTT 계약

### Gateway command

```text
sites/{siteId}/gateways/{gatewayId}/commands/fixture-presence-check
```

payload는 다음 identity와 scope를 포함한다.

- `refreshId`, `batchId`, `idempotencyKey`, `sequence`
- `siteId`, `gatewayId`
- `targetFixtureIds` 1..64, 중복 없음
- `requestedAt`, `expiresAt`

Gateway는 site/gateway scope, UUID, sequence, idempotency와 expiry를 검증한 뒤 durable journal에 수락한다. 같은 identity의 같은 payload는 재실행하지 않고 이전 terminal 결과를 재발행한다. 같은 identity의 다른 payload는 거부한다.

### 성공 결과

성공한 fixture는 기존 `fixture-presence` event에 nullable `refreshId`와 `batchId`를 추가해 발행한다. API는 presence와 `MonitoringRefreshFixture=online`을 같은 transaction에서 저장한 뒤 기존 `state-ingested` ACK를 반환한다. BIO sensor 응답은 `lastSeenAt`과 BIO metadata만 갱신하며 실제 brightness/power/energy는 그대로 둔다.

### 실패 결과

두 번 연속 실패한 fixture는 새 topic으로 발행한다.

```text
sites/{siteId}/gateways/{gatewayId}/state/fixture-unreachable
```

payload는 ordered event identity, `refreshId`, `batchId`, `fixtureId`와 정제된 `reason`을 갖는다. `reason`은 `not_found | read_timeout | read_failed`만 허용한다. API는 요청·batch·fixture scope와 아직 유효한 deadline을 확인한 뒤 `MonitoringRefreshFixture=offline`, `Fixture.lastUnreachableAt=receivedAt`, operational `status=offline/statusReason=fixture_stale`을 같은 transaction에 저장한다.

fixture success/unreachable event는 기존 Gateway state outbox의 exact event identity, sequence, payload hash와 application ACK 원칙을 재사용한다. API commit 전에는 ACK하지 않고, Gateway 재시작·MQTT 단절 뒤에도 ACK 전 event를 재전송한다.

### Batch 종료

```text
sites/{siteId}/gateways/{gatewayId}/events/fixture-presence-check-completed
```

Gateway는 모든 fixture terminal event를 durable outbox에 넣은 뒤 batch-completed event를 발행한다. API는 fixture 결과가 모두 수신된 경우에만 batch를 completed로 바꾼다. batch-completed가 먼저 도착하면 ACK하지 않아 broker redelivery로 수렴한다. deadline까지 빠진 결과는 `unverified`로 종료하며 offline으로 만들지 않는다.

## Gateway 동작

- 기존 `resyncLightingFixtures(fixtureIds)`의 scan/read/identity 검증 로직을 공통 probe 단위로 추출해 자동 resync와 수동 check가 같은 장치 판정을 사용한다.
- BIO는 한 pass에서 scan 한 번 후 fixture별 brightness GET → mode GET을 직렬 실행한다.
- 첫 pass에서 실패한 fixture만 250ms 뒤 두 번째 pass로 보낸다. 성공 fixture는 다시 조회하지 않는다.
- BlueZ는 OnOff/Lightness 관측 성공을 reachable로 사용하고 기존 Health 결과를 보존한다.
- manual check는 기존 USB/BlueZ operation queue를 통과하므로 제어·등록 요청과 transport access가 겹치지 않는다. 진행 중 제어를 취소하거나 우회하지 않는다.
- manual check는 읽기 opcode만 사용하며 brightness, control mode, address, group membership을 변경하지 않는다.
- Gateway 전체 전송 실패, process shutdown, command expiry는 fixture별 unreachable이 아니라 batch 실패다.
- 로그는 refresh/batch ID 전체와 장치 identity를 기록하지 않고 aggregate count와 canonical error code만 남긴다.

## API 상태 반영과 경합

- API는 `Site → Gateway → Fixture → MonitoringRefresh` 순서로 잠금을 획득해 freshness sweep과 state ingestion의 기존 lock order를 유지한다.
- manual failure event를 처리할 때 `lastSeenAt`이 refresh 생성 시각 이후라면 더 최신 성공 관측이므로 fixture를 offline으로 만들지 않고 online 결과로 수렴한다.
- presence/state event가 `lastUnreachableAt`보다 최신이면 `lastUnreachableAt`을 지우고 기존 `reportedStatus/reportedStatusReason`을 복원한다. 실제 fault와 `command_failed`는 생존 응답만으로 지우지 않는다.
- 늦은 이전 refresh 결과는 더 최신 presence/state 또는 더 최신 refresh 결과를 덮어쓰지 못한다.
- Gateway heartbeat가 offline이면 fixture별 unreachable event를 적용하지 않고 기존 gateway-level offline 판정을 사용한다.
- fixture event ingestion은 child row만 idempotent하게 갱신한다. 모든 batch 완료 또는 deadline 처리 transaction이 child row를 다시 집계해 parent counter와 terminal status를 한 번에 저장하므로 중복 event가 counter를 늘리지 않는다.
- 확인 실패는 에너지 checkpoint, brightness, powerOn, Health fault를 변경하지 않는다.

## Web 동작

- `MonitoringView`의 기존 버튼 위치와 크기는 유지한다.
- hardware request가 진행 중이면 `장치 상태 확인 중`과 spinner를 표시하고 버튼을 비활성화한다.
- POST 성공 후 terminal URL을 500ms 간격으로 조회하되 30초 server deadline을 넘기지 않는다.
- terminal 또는 HTTP 오류 뒤에는 dashboard, floor fixtures, floor map을 다시 조회해 Gateway/freshness 상태도 최신화한다.
- `completed`는 별도 성공 toast 없이 화면 숫자와 marker를 갱신한다.
- `partial`은 `일부 조명의 상태를 확인하지 못했습니다.`를, `failed/expired`는 `장치 상태를 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.`를 표시한다.
- component unmount, 맵 변경, site 변경 시 이전 polling을 abort하고 늦은 응답이 현재 화면의 loading/error를 바꾸지 못하게 한다.
- background query 실패와 hardware refresh 실패는 기존 source별 오류 보존 규칙을 유지한다.

## 오류 및 안전 정책

- 한 번의 실패만으로 offline을 만들지 않는다.
- 장치가 두 번 응답하지 않았더라도 Gateway heartbeat나 command delivery를 신뢰할 수 없으면 `unverified`다.
- `not_found`, `read_timeout`, `read_failed` 이외의 raw error는 외부 응답에 노출하지 않는다.
- 요청 생성, outbox publish, state ingest, terminal 집계는 각각 idempotent하다.
- 30초 deadline과 30초 cooldown으로 느린 Gateway와 반복 클릭이 작업을 무한 적재하지 못하게 한다.
- 읽기 권한 사용자가 임의 fixture/Gateway를 지정할 수 없고 서버가 선택 층의 현재 관계를 snapshot한다.
- 물리적으로 전원을 다시 켜면 다음 수동 확인 또는 자동 presence/state 수신에서 정상으로 복구된다.

## 테스트 전략

### Shared

- command가 exact scope, 1..64 unique fixture, expiry를 검증한다.
- presence의 refresh identity와 unreachable/batch-completed event가 strict schema를 통과한다.
- raw error, brightness/power 필드가 unreachable event에 들어가면 거부한다.

### Gateway

- 첫 pass 실패 fixture만 두 번째 pass에서 다시 조회한다.
- 두 번 실패한 fixture만 unreachable을 발행하고 성공 fixture는 refresh identity가 포함된 presence를 발행한다.
- BIO sensor 성공이 brightness/power observation을 만들지 않는 기존 계약을 유지한다.
- command duplicate/restart는 장치 조회를 반복하지 않고 durable terminal을 재발행한다.
- invalid scope, altered replay, expired command와 shutdown은 fixture offline 결과를 만들지 않는다.
- 64 fixture 경계, operation queue 직렬화와 timeout을 검증한다.

### API

- read 권한, floor/site scope, 서버 선택 target, idempotency, active dedupe, cooldown을 검증한다.
- online presence와 unreachable result가 child/parent/Fixture를 transactionally 갱신한다.
- 첫 실패만으로 offline이 되지 않으며 두 번째 terminal failure에서만 offline이 된다.
- 더 최신 presence가 늦은 failure를 이기고 offline에서 다시 online으로 복구한다.
- Gateway offline, delivery timeout, deadline 이후 결과는 unverified이며 fixture를 개별 offline으로 만들지 않는다.
- duplicate/reverse/altered event와 batch-completed 선행을 fail closed 한다.
- migration constraint, relation, retention과 기존 command/freshness/energy 회귀를 검증한다.

### Web

- 클릭이 선택 층으로 POST하고 terminal까지 `장치 상태 확인 중`을 유지한다.
- completed 뒤 2개 중 1개 offline 응답이 `전체 2 / 정상 1 / 오프라인 1`과 marker·상세에 반영된다.
- partial/failed/expired copy와 재시도 가능 상태를 검증한다.
- 중복 클릭, 맵/site 변경, unmount에서 중복 요청과 stale callback이 없다.
- 1440×900, 1024×768, 390×844, 320×740에서 loading/error copy가 toolbar를 자르지 않는다.

### 통합 및 실장비

- deterministic MQTT/API integration에서 command → Gateway result → fixture API → Web KPI 전체 흐름을 검증한다.
- 실제 BIO USB 동글과 조명 2개 HIL에서 두 장치 online → 한 장치 물리 전원 차단 → 수동 새로고침 → `정상 1 / 오프라인 1`을 확인한다.
- 전원 복구 뒤 재새로고침으로 `정상 2 / 오프라인 0` 복구를 확인한다.
- HIL 장비가 없으면 software 검증 완료와 실장비 미검증을 구분해 문서화하며 완료를 가장하지 않는다.

## 문서 갱신

- `docs/database-schema.md`: refresh 모델, Fixture reachability 필드, 관계·보존 정책
- `docs/menus/monitoring.md`: 수동 hardware 확인 UX, 결과/오류, 자동 10분·20분 안전망
- `docs/menus/control.md`: manual unreachable이 제어 가능성에 즉시 반영되고 presence에서 복구되는 조건

## 완료 조건

- 물리적으로 전원이 차단된 조명은 사용자가 새로고침을 누른 뒤 두 번의 read-only 실패가 확인되면 20분을 기다리지 않고 오프라인으로 표시된다.
- 같은 층에서 응답한 조명은 정상 상태를 유지해 `전체 2 / 정상 1 / 오프라인 1`이 된다.
- Gateway/MQTT 자체 실패는 fixture 개별 offline으로 오판하지 않고 확인 실패로 표시된다.
- 수동 확인은 실제 밝기, power, sensor mode, 에너지 데이터를 추정하거나 변경하지 않는다.
- 요청과 MQTT 결과는 재전송·재시작·중복에 안전하고 더 최신 성공 관측을 늦은 실패가 덮어쓰지 않는다.
- 자동 10분 polling과 20분 stale 기준은 유지된다.
- 관련 단위·통합·Chromium 테스트, typecheck, build가 통과하고 메뉴/DB 문서가 최신 상태다.
