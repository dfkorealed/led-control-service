# 모니터링 메뉴 기능 현황

기준일: 2026-08-26

## 확정 구현 범위

- 조명 검색 결과에서 여러 장치를 선택한 뒤 일괄 또는 개별 정보를 설정할 수 있게 한다. 일괄 설정 이름은 층별 prefix와 서버가 원자 예약한 순번으로 자동 생성한다.
- ESP32-H2 firmware device UUID의 자사 namespace를 검증해 자사 제품만 검색 결과와 provisioning session에 반영한다.
- 설정 에디터에서 저장한 도면 배경, 도형, 텍스트, 색상과 조명 위치를 동일한 Konva renderer로 읽기 전용 표시한다.
- 장비 상태는 BLE Mesh Health Current의 현재 fault만 수집하고 통신 품질 평가는 확장하지 않는다.

상세 계약은 `docs/superpowers/specs/2026-08-19-monitoring-control-focused-completion-design.md`를 따른다.

## 명시적 보류 범위

- WebSocket/SSE push
- RSSI, hop count, 명령 성공률 기반 통신 품질 고도화
- 장애 이력, 등급, 원인, 담당자와 조치 workflow
- 통신 음영 heatmap, 차량 감지, 이벤트 타임라인, gateway coverage와 빠른 제어
- 자동 HIL 판정. 실제 하드웨어 검증은 수동으로 수행한다.

## 구현 완료

- `GET /sites`는 로그인 사용자가 SiteAccess 권한으로 접근 가능한 현장의 고객사명과 현장명만 반환한다.
- `GET /sites/default/dashboard`는 접근 가능한 첫 현장을 반환하고, 접근 가능한 현장이 없을 때도 최초 설치 흐름을 위해 기존 빈 dashboard shape를 유지한다.
- `GET /sites/:siteId/dashboard`, 층별 fixture 조회, 기본 에너지 추정은 `AuthenticatedUser + SiteAccessService`로 현장 read 권한을 확인하며 미배정 또는 다른 고객사 현장은 `404`로 숨긴다.
- 현장이 없으면 service-provider `operator`에게 `초기 설치 설정` 마법사를 표시하고 customer `admin/viewer`에게는 `설치 담당자가 현장을 준비 중입니다` 상태를 표시한다.
- 현장은 있으나 등록된 조명이 없으면 service-provider `operator`에게만 Gateway claim 또는 `조명 등록` 패널을 표시한다. customer `admin/viewer`에게는 설치 대기 상태를 표시하며 시운전 기능을 노출하지 않는다.
- 로컬 실행에는 검색 결과 생성기가 없으며 Raspberry Pi/ESP32-H2가 꺼져 있으면 검색 결과 0개를 유지한다.
- ESP32-H2 unprovisioned UUID는 `DFKLED`, format version, 제품군, 모델, 하드웨어 revision과 6바이트 장치 식별자로 구성한다. Raspberry Pi Gateway는 shared parser로 현재 format의 자사 UUID만 scan 결과에 포함하고 타사 장치는 구조화 로그만 남긴다.
- 등록용 자동 이름 순번은 층별 `Floor.nextFixtureSequence`, Mesh unicast 주소는 게이트웨이별 `Gateway.nextMeshUnicastAddress`에서 소유 행 잠금 후 연속 범위로 원자 예약한다. 삭제되거나 건너뛴 값은 재사용하지 않으며 Mesh 주소는 `0x0001~0x7fff`만 허용한다.
- `POST /registration-sessions/:sessionId/nodes/register-batch`는 일괄·개별 설정을 하나의 요청으로 받고, session/node 행 잠금과 Task 5 allocator를 같은 transaction에서 사용한다. 유효한 node는 `accepted`, 존재하지 않거나 이미 처리 중인 node는 `validation_failed`로 분리해 성공한 등록을 유지한다.
- 일괄 이름은 서버가 prefix, 시작 번호, 자릿수와 예약 순번으로 생성한다. 자동 좌표는 도면 크기 또는 `1200x800` 기본 canvas 안의 기존 fixture와 겹치지 않는 행 우선 grid cell을 사용하며 이름·전력·좌표·marker 크기를 provisioning 전에 저장한다.
- 조명 등록 패널은 검색된 등록 가능 node의 개별/전체 checkbox 선택과 `일괄 설정`·`개별 설정` 전환을 지원한다. 일괄 설정은 선택 층 이름을 기본 prefix로 사용하고, 개별 설정은 조명별 이름·정격 전력·marker 크기와 선택적 좌표를 입력한다. X/Y를 모두 비우면 자동 배치하고 둘 다 입력하면 수동 배치하며 한쪽만 입력하면 해당 node에 검증 오류를 표시한다.
- 일괄·개별 등록 요청에서 서버가 수락한 node만 선택 해제하고, `validation_failed`는 오류와 선택을 유지한다. 물리 provisioning 중인 node는 재등록할 수 없으며 이후 `failed` 또는 `reconcile_required`로 확인되면 검토 대상으로 다시 선택해 node 행에 원인을 표시한다.
- Gateway는 여러 provision-device 명령을 FIFO로 직렬 처리해 BlueZ provisioning 작업이 겹치지 않게 한다. MQTT publish 오류 또는 provisioning failure event처럼 물리 적용 여부가 불명확하면 node를 `reconcile_required`로 전환하며 확인 없이 자동 재시도하지 않는다.
- 등록 검색은 세션별 `pending/scanning/completed/failed` lifecycle, correlation ID와 attempt를 사용한다. 신규 검색과 retry는 `pending` session과 scan-start durable outbox를 같은 transaction에서 만들며 publisher가 lease 아래 `pending -> scanning` 전이 후 발행한다. 0건은 `completed`이며, 완료/실패/발견 이벤트는 session 행 잠금과 `ProcessedGatewayEvent` 원장 transaction 안에서 site, gateway, correlation, attempt, eventId, sequence가 현재 scan과 모두 일치할 때만 반영한다. 늦은 발견, 중복·낮은 sequence, 이전 시도 이벤트는 무시한다.
- Gateway는 shared DFKLED UUID parser를 통과한 장치만 `scan-found` v2 topic으로 발행한다. `(sessionId, scanCorrelationId, scanAttempt)`별 0600 atomic journal은 running duplicate가 scanner를 다시 시작하지 않게 하고, terminal은 원래 eventId/sequence를 가진 동일 event로 재발행한다. restart에서 남은 running record는 새 scan 대신 정제된 failed terminal로 수렴하며, 손상·권한 오류 journal은 fail-closed 한다. journal은 terminal 24시간 보존과 최대 1,000 record를 넘지 않는다.
- `POST /registration-sessions/:sessionId/scan/retry`는 terminal scan만 재시작한다. gateway별 `status=active`인 `pending/scanning` partial unique 제약으로 같은 gateway의 동시 검색을 막고, 신규·retry 충돌 모두 `gateway_scan_in_progress`를 반환한다. publisher MQTT timeout은 기본 10초로 30초 lease보다 짧으며 process crash는 lease 만료 뒤 같은 attempt를 재시도한다. timeout/reject는 backoff를 증가시키고 최대 3회 또는 5분 실패는 사용자용 고정 메시지와 함께 `failed`로 복구한다.
- scanning 또는 pending scan은 registration session 완료를 `409 scan_session_not_terminal`로 거부한다. provisioning 전 identify API는 session site의 commission 권한과 404 경계를 확인한 뒤 `501 pre_provision_identify_unsupported`를 반환하며, 발견 node 상태를 바꾸거나 MQTT 명령을 발행하지 않는다.
- 등록 batch transaction은 실제 provisioning publish 전에 해당 층의 `MeshControlGroup`을 선확보해 group address 소진이나 gateway/site 불일치를 미리 실패시킨다.
- 조명 등록 패널은 gateway scan/provisioning MQTT 흐름과 연결되어, 등록 완료 이벤트 후 dashboard polling으로 새 fixture를 표시할 수 있다. 이 시점의 fixture는 `offline + provisioning_waiting_state`이며 실제 offline과 구분해 `상태 확인 대기`로 표시한다.
- provisioning 완료 transaction은 생성 또는 재사용한 `MeshNode`/`Fixture`를 같은 transaction 안에서 floor control group과 기존 `FixtureGroup` membership의 control group member에 연결한다. 이때 fixture group 대상은 요청 payload가 아니라 DB의 `GroupFixture` 관계를 권위 데이터로 조회한다.
- 이미 다른 층에 매핑된 기존 fixture가 같은 device UUID로 다시 발견되면 자동 이동하지 않고 provisioning 완료를 `failed`로 종료해 현장 매핑 충돌을 드러낸다.
- 층별 탭으로 지하/지상 층을 전환한다.
- 층별 2D 맵에 도면 이미지와 조명 위치를 표시한다.
- 조명 점은 기본 compact marker로 표시하고, 선택/hover/focus 시 상태, 밝기, 이름 카드로 확장하여 밀집 화면의 겹침을 줄인다.
- 조명 점의 접근성 라벨과 tooltip은 한국어 상태명(정상/오프라인/장애)을 사용하고, `provisioning_waiting_state`는 `상태 확인 대기`로 별도 표시한다.
- 선택 조명 상세 패널에 현재 밝기, 정격 전력, 마지막 수신, 해당 조명에 실제 매핑된 게이트웨이 이름/상태, RSSI, hop count, 명령 성공률을 표시한다.
- 선택 층 기준 전체 조명 수, 온라인 수, 장애 수, 평균 밝기를 표시한다.
- 장애 조명과 실제 오프라인 조명을 점검 큐에서 바로 선택할 수 있다. 첫 상태를 기다리는 `provisioning_waiting_state` 조명은 오프라인 대수와 선택 대상에서 제외한다.
- 층 탭은 좁은 화면에서 가로 스크롤되고, 모바일 하단 내비게이션은 safe area 여백을 반영한다.
- MQTT `fixture-state` 이벤트가 fixture 최신 상태 snapshot을 갱신한다.
- provisioning 완료 MQTT event는 밝기, online/fault, lastSeenAt을 추정하지 않는다. 첫 실제 `fixture-state` event가 들어올 때만 이 snapshot을 확정한다.
- MQTT `gateway-heartbeat` 이벤트가 gateway online/offline 상태 판단에 반영된다.
- dashboard metadata와 선택 층 fixture snapshot은 React Query로 10분마다 polling한다. 브라우저 focus만으로 다시 조회하지 않는다.
- 모니터링 상단의 `새로고침` 버튼은 dashboard metadata와 현재 층 fixture 전체 페이지를 함께 다시 조회한다. 실행 중에는 중복 요청을 막고, 완료 시각과 전체/부분 실패를 표시하며 기존 성공 데이터는 유지한다.
- 모니터링 새로고침은 클라우드 DB snapshot 조회이며 전체 조명에 BLE Mesh Get을 일괄 전송하지 않는다.
- 기본 dashboard는 fixture 본문을 제외한 현장/층/gateway metadata와 DB aggregate summary만 반환한다. 제어 화면만 `includeFixtures=true`를 명시한다.
- 모니터링 fixture snapshot은 `GET /sites/:siteId/floors/:floorId/fixtures`에서 현장 read 권한을 검증한 뒤 최대 200개씩 ID cursor로 조회하며, 선택 층의 다음 페이지를 연속 병합한다. 존재하지 않는 층과 접근할 수 없는 층은 같은 `floor not found` 404 응답으로 처리한다.
- `Fixture(floorId, id)` 복합 인덱스로 OFFSET 없이 대규모 fixture를 순회한다.
- Playwright deterministic route fixture는 Chromium에서 수동 새로고침과 마지막 갱신 시각 변경, 10분 자동 갱신 경계, 5페이지로 나뉜 조명 1,000개의 마지막 페이지 상태 반영, 저장된 지도 객체의 실제 Konva canvas pixel 렌더링을 검증한다. 이 fixture는 브라우저와 API 계약 회귀용이며 실제 Raspberry Pi/ESP32-H2 하드웨어 E2E 증거가 아니다.
- `pnpm benchmark:fixtures`는 실제 인증 cookie와 floor ID로 100회 측정해 API p95가 1초를 넘으면 실패한다.
- 모니터링의 층 도면은 모든 역할에 읽기 전용으로 표시한다. 편집 버튼, editor state 조회와 editor 분기는 제공하지 않으며, 도면 변경과 version 복구는 설정 메뉴가 소유한다.
- `GET /sites/:siteId/floors/:floorId/map-snapshot`은 현장 read 권한을 확인한 뒤 지도 revision, 선택적 도면 배경과 visible 도형만 반환한다. fixture runtime 상태는 기존 cursor API가 담당하며, 배경이 없으면 `1200x800` 기본 canvas를 사용한다.
- 층 지도 snapshot은 도형을 `zIndex`, 생성 시각 순으로 고정해 반환한다. 존재하지 않거나 접근할 수 없는 층은 같은 `floor not found` 404 응답으로 처리한다.
- 웹은 `useFloorMapSnapshot`으로 선택 층의 저장된 배경과 도형을 10분마다 조회하고, 설정 에디터와 공통 `FloorMapObjectNode` geometry를 사용해 Konva scene에 읽기 전용으로 합성한다. 조명 marker는 같은 좌표계의 접근 가능한 HTML 버튼으로 표시한다.
- 모니터링 수동 새로고침은 dashboard metadata, 현재 층 fixture 페이지와 현재 층 map snapshot 세 요청을 함께 갱신하며 일부 실패 시 기존 성공 데이터를 유지한다.
- gateway scoped v2 fixture state와 heartbeat는 topic/payload/DB의 site·gateway 관계가 모두 일치할 때만 반영한다.
- v2 상태 이벤트는 영속 `eventId`와 gateway sequence를 사용하며 QoS 1 중복과 낮은 sequence 역전을 폐기한다.
- gateway는 재시작 후에도 event sequence를 파일 권한 `0600`으로 이어간다. 시작 시에는 journal 추정 상태를 재발행하지 않고, 확인된 node의 AppKey/model bind/60초 publication 응답을 다시 확인·보정한 뒤 Generic OnOff, Lightness, Health 실제 상태를 조회한다.
- startup resync는 4개 node 제한 queue와 busy 재시도를 사용한다. 구성 성공 뒤 같은 generation의 OnOff/Lightness pair가 오면 8초 resync `observed`로 집계하고, Health Current 미관측은 `healthPending`으로 별도 집계한다. `meshResync` health field와 구조화 log는 lighting pair가 전혀 없거나 전송이 모두 실패한 경우에만 unhealthy를 유지하며, 이후 heartbeat만으로 이를 healthy로 덮지 않는다. 늦은 Health Current publication은 pending을 회복한다. reconnect가 겹쳐도 하나의 resync만 수행하며, 응답이 없는 경우에는 offline 이벤트를 만들지 않는다.
- BlueZ model status는 부분 관측으로 취급한다. Generic OnOff, Lightness, Health Current 실제 관측이 같은 generation의 65초 coherence window 안에 모두 모일 때만 fixture-state snapshot을 발행한다. 새 resync와 단일 model update는 새 generation을 시작하므로 Health-only, 역순, 누락 또는 stale counterpart가 밝기 `0`, power-off, online 상태로 DB를 오염시키지 않는다.
- BlueZ 자발 status는 확인된 primary unicast address가 fixture mapping과 일치할 때만 처리한다. Health Current Fault(`0x04`)만 operational fault로 반영하며, Current를 실제 관측하기 전에는 online/fault snapshot을 확정하지 않는다. Registered Fault(`0x05`)와 no-fault byte `0x00`는 장애 상태를 만들지 않는다. gateway는 assignment의 site/gateway 범위를 payload에 주입해 MQTT v2 fixture-state로 발행하고, unknown address는 폐기한다.
- gateway는 Health Current의 숫자 fault code와 실제 관측 시각을 MQTT v2 `health` 객체로 전달한다. API는 `0x00` 제거, 중복 제거와 정렬 후 `Fixture.healthFaultCodes`, `Fixture.healthLastSeenAt` 최신 snapshot에 저장하며 Health가 없는 명령 결과 이벤트는 기존 snapshot을 지우지 않는다.
- 층별 fixture API와 dashboard는 Health snapshot을 `{ faultCodes, observedAt }` 또는 `null`로 반환한다. fault가 하나라도 있으면 조명 상태와 제어 가능 여부를 장애로 취급하고, 모니터링 상세 패널은 `정상`, `장애 (fault code)`, `확인 대기`와 Health 수신 시각을 표시한다.
- heartbeat가 90초를 초과해 없으면 연결된 조명을 `gateway_offline`, fixture state가 180초(60초 publication 3회 window) 이상 없으면 해당 조명을 `fixture_stale` 사유로 offline 처리한다. 정확히 90초 전 heartbeat는 fresh로 유지한다.
- freshness worker는 `provisioning_waiting_state` fixture를 gateway offline/stale 재집계에서 제외한다. 또한 한 실행에서 기록한 `gateway_offline`을 일반 `fixture_stale`이 덮어쓰지 않는다. 첫 실제 `fixture-state`가 대기 사유를 지운 뒤에만 일반 freshness 대상이 된다.
- dashboard gateway 연결 상태 기준을 등록 API와 동일한 inclusive 90초(`<= 90초`)로 통일하고 fixture의 `statusReason`을 API 응답에 포함한다.
- dashboard fixture 응답에 소유 gateway ID/이름/연결 상태와 `controllable`, `controlBlockReason`을 포함한다.
- Gateway startup resync는 command 이력을 상태로 재발행하지 않고, 확인된 fixture마다 실제 Mesh status 응답을 새 sequence로 반영한다.
- Gateway MQTT runtime은 MQTT close에서 heartbeat timer를 즉시 정리해 disconnected 상태의 healthy 기록과 offline heartbeat 적재를 막고, reconnect마다 하나의 timer만 다시 시작한다. persistent session 재접속(`sessionPresent=true`)에는 command topic을 다시 구독하지 않는다. 모든 command/provisioning topic handler 오류는 MQTT event loop 밖으로 새지 않도록 오류 경계에서 health 오류로 기록하며, SIGTERM/SIGINT 종료 시 timer, client listener와 MQTT client를 정리한다.
- MQTT certificate rotation은 old client quiesce와 identity pointer commit 뒤 candidate를 runtime current client로 지정한 다음 broker에 연결한다. CONNACK 전 실패만 old identity/client로 rollback하고, CONNACK 뒤 subscription 실패는 candidate authoritative 상태에서 fail-closed 해 old session command replay를 막는다. dimming·scan·identify·provision handler는 각 MQTT message source client로 결과를 발행한다. pointer write/fsync와 restore가 모두 실패하면 candidate generation을 보존하고 runtime을 fail-closed 한다. appliance health는 D-Bus owner, 실제 `Node1` interface introspection, HCI powered bit, mapping JSON parse, 마지막 heartbeat publish freshness를 실제 probe해 기록하며 future heartbeat와 잘못된 heartbeat interval은 unhealthy로 처리한다.

## 미구현

- WebSocket/SSE 기반 push 실시간 업데이트
- 층별/구역별 통신 음영 heatmap
- 장애 이력, 장애 등급, 장애 원인 표시
- 알림 확인, 담당자 배정, 조치 완료 workflow
- 차량 감지 이벤트 표시
- 이벤트 타임라인
- 게이트웨이별 커버리지 표시
- 여러 게이트웨이가 같은 층을 담당할 때의 경로/coverage 시각화
- 조명 등록 중 provisioning 진행률 표시
- 모니터링 화면 내 빠른 밝기 제어

## 부족하거나 개선이 필요한 기능

- 모니터링 화면은 10분 snapshot 정책이므로 publication 반영 직후 확인이 필요하면 사용자가 수동 새로고침해야 한다.
- Health 정보는 최신 Current snapshot만 보존하며 fault 이력, 발생 횟수와 해제 이력은 명시적 보류 범위다.
- 조명 등록 완료 후 dashboard 반영은 query invalidation 또는 10분 polling에 의존하며 WebSocket/SSE push는 명시적으로 보류한다.
- gateway offline 기준은 현재 90초, fixture stale 기준은 180초(60초 publication 3회 window) 고정값이다. 대규모 현장 검증 후 site/gateway별 정책 설정으로 분리해야 한다.
- `lastSeenAt` 상대 시간은 클라이언트 현재 시간 기준이므로 서버 기준 freshness와 완전히 일치하지 않을 수 있다.
- RSSI, hop count, 명령 성공률은 표시만 하며, 품질 등급이나 설치 가이드로 연결되지 않는다.
- 1,000개 marker 조회/렌더링 기준은 자동 검증하지만, 더 큰 현장에는 공간 클러스터링과 검색이 추가로 필요하다.
- 자사 UUID 검색, batch 등록, 실제 Health Current 수집을 포함한 Raspberry Pi/ESP32-H2 실장비 HIL은 아직 실행하지 않았다. 자동 route fixture 통과를 검색·등록·상태 수집의 실기 완료로 간주하지 않는다.
- 현재 선택 로직은 첫 장애 조명 또는 첫 조명을 자동 선택하므로, 사용자가 이전에 보던 조명을 유지하는 정책을 더 정교하게 만들 수 있다.
- 등록 패널은 1.5초 registration session polling으로 provisioning 결과를 반영한다. 실시간 push와 단계별 진행률은 명시적 보류 범위이며, `reconcile_required` 장비의 현장 확인·복구 workflow는 후속 구현이 필요하다.
- scan lifecycle 자동 테스트는 mock MQTT와 scanner adapter를 사용한다. 실제 Raspberry Pi BlueZ adapter의 scan timeout, broker PUBACK 유실 뒤 outbox replay/journal terminal 재발행, ESP32-H2 자사 UUID 필터와 terminal event 전달은 HIL에서 별도로 확인해야 한다.

## 관련 파일

- `apps/web/src/features/monitoring/MonitoringView.tsx`
- `apps/web/src/features/monitoring/FloorMap.tsx`
- `apps/web/src/features/floor-map/FloorScene.tsx`
- `apps/web/src/features/registration/RegistrationPanel.tsx`
- `apps/web/src/features/registration/FixtureBatchForm.tsx`
- `apps/web/src/features/registration/FixtureIndividualForm.tsx`
- `apps/web/src/api/queries.ts`
- `apps/api/src/sites/sites.controller.ts`
- `apps/api/src/sites/sites.service.ts`
- `apps/api/src/fixtures/fixtures.service.ts`
- `apps/api/src/fixtures/fixture-health.ts`
- `apps/api/src/mqtt/mqtt.service.ts`
- `apps/api/src/mqtt/provisioning-scan-outbox-publisher.service.ts`
- `apps/api/src/mesh-control-groups/mesh-control-group.service.ts`
- `apps/gateway/src/mesh/bluez-mesh-adapter.ts`
- `packages/shared/src/gateway-contracts.ts`
- `apps/api/src/registration/registration-allocation.service.ts`
- `apps/api/src/registration/registration.service.ts`
- `apps/api/src/registration/registration.controller.ts`
- `apps/api/src/floor-map/floor-map.service.ts`
- `apps/api/src/floor-map/floor-map.controller.ts`
- `apps/api/src/mqtt/mqtt.service.ts`
- `apps/api/src/mqtt/topic-scope.ts`
- `apps/api/src/fixtures/fixture-freshness.service.ts`
- `apps/gateway/src/state/event-sequence-store.ts`
- `apps/gateway/src/state/provisioning-scan-journal.ts`
- `apps/gateway/src/mesh/bluez-mesh-adapter.ts`
- `apps/gateway/src/gateway.ts`
- `apps/gateway/src/mesh/bluez-model-codec.ts`
- `apps/gateway/src/runtime/gateway-mqtt-runtime.ts`
- `apps/gateway/src/runtime/serial-task-queue.ts`
- `apps/gateway/src/identity/certificate-rotation.ts`
- `apps/gateway/src/health/appliance-health.ts`
- `apps/gateway/docker/healthcheck.sh`
- `packages/shared/src/schemas.ts`
- `packages/shared/src/product-identity.ts`
- `packages/shared/src/mqtt.ts`

## 갱신 규칙

모니터링 메뉴의 UI, API, DB, MQTT, 실제 gateway, 펌웨어 계약이 바뀌면 이 문서를 같은 작업 안에서 갱신한다.
