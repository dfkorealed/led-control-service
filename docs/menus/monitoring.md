# 모니터링 메뉴 기능 현황

기준일: 2026-08-11

## 구현 완료

- `GET /sites`는 로그인 사용자가 SiteAccess 권한으로 접근 가능한 현장의 고객사명과 현장명만 반환한다.
- `GET /sites/default/dashboard`는 접근 가능한 첫 현장을 반환하고, 접근 가능한 현장이 없을 때도 최초 설치 흐름을 위해 기존 빈 dashboard shape를 유지한다.
- `GET /sites/:siteId/dashboard`, 층별 fixture 조회, 기본 에너지 추정은 `AuthenticatedUser + SiteAccessService`로 현장 read 권한을 확인하며 미배정 또는 다른 고객사 현장은 `404`로 숨긴다.
- 현장이 없으면 service-provider `operator`에게 `초기 설치 설정` 마법사를 표시하고 customer `admin/viewer`에게는 `설치 담당자가 현장을 준비 중입니다` 상태를 표시한다.
- 현장은 있으나 등록된 조명이 없으면 service-provider `operator`에게만 Gateway claim 또는 `조명 등록` 패널을 표시한다. customer `admin/viewer`에게는 설치 대기 상태를 표시하며 시운전 기능을 노출하지 않는다.
- 로컬 실행에는 검색 결과 생성기가 없으며 Raspberry Pi/ESP32-H2가 꺼져 있으면 검색 결과 0개를 유지한다.
- 조명 등록 패널은 gateway scan/provisioning MQTT 흐름과 연결되어, 등록 완료 이벤트 후 dashboard polling으로 새 fixture를 표시할 수 있다. 이 시점의 fixture는 `offline + provisioning_waiting_state`이며 실제 offline과 구분해 `상태 확인 대기`로 표시한다.
- 층별 탭으로 지하/지상 층을 전환한다.
- 층별 2D 맵에 도면 이미지와 조명 위치를 표시한다.
- 조명 점은 기본 compact marker로 표시하고, 선택/hover/focus 시 상태, 밝기, 이름 카드로 확장하여 밀집 화면의 겹침을 줄인다.
- 조명 점의 접근성 라벨과 tooltip은 한국어 상태명(정상/오프라인/장애)을 사용하고, `provisioning_waiting_state`는 `상태 확인 대기`로 별도 표시한다.
- 선택 조명 상세 패널에 현재 밝기, 정격 전력, 마지막 수신, 해당 조명에 실제 매핑된 게이트웨이 이름/상태, RSSI, hop count, 명령 성공률을 표시한다.
- 선택 층 기준 전체 조명 수, 온라인 수, 장애 수, 평균 밝기를 표시한다.
- 장애 조명과 오프라인 조명을 점검 큐에서 바로 선택할 수 있다.
- 층 탭은 좁은 화면에서 가로 스크롤되고, 모바일 하단 내비게이션은 safe area 여백을 반영한다.
- MQTT `fixture-state` 이벤트가 fixture 최신 상태 snapshot을 갱신한다.
- provisioning 완료 MQTT event는 밝기, online/fault, lastSeenAt을 추정하지 않는다. 첫 실제 `fixture-state` event가 들어올 때만 이 snapshot을 확정한다.
- MQTT `gateway-heartbeat` 이벤트가 gateway online/offline 상태 판단에 반영된다.
- dashboard query는 React Query로 3초마다 polling한다.
- 기본 dashboard는 fixture 본문을 제외한 현장/층/gateway metadata와 DB aggregate summary만 반환한다. 제어 화면만 `includeFixtures=true`를 명시한다.
- 모니터링 fixture snapshot은 `GET /sites/:siteId/floors/:floorId/fixtures`에서 현장 read 권한을 검증한 뒤 최대 200개씩 ID cursor로 조회하며, 선택 층의 다음 페이지를 연속 병합한다. 존재하지 않는 층과 접근할 수 없는 층은 같은 `floor not found` 404 응답으로 처리한다.
- `Fixture(floorId, id)` 복합 인덱스로 OFFSET 없이 대규모 fixture를 순회한다.
- Playwright deterministic 1,000 fixture/5-page 시나리오가 Chromium에서 1,000개 marker 렌더링을 검증한다.
- `pnpm benchmark:fixtures`는 실제 인증 cookie와 floor ID로 100회 측정해 API p95가 1초를 넘으면 실패한다.
- 모니터링의 층 도면은 모든 역할에 읽기 전용으로 표시한다. 편집 버튼, editor state 조회와 editor 분기는 제공하지 않으며, 도면 변경과 version 복구는 설정 메뉴가 소유한다.
- gateway scoped v2 fixture state와 heartbeat는 topic/payload/DB의 site·gateway 관계가 모두 일치할 때만 반영한다.
- v2 상태 이벤트는 영속 `eventId`와 gateway sequence를 사용하며 QoS 1 중복과 낮은 sequence 역전을 폐기한다.
- gateway는 재시작 후에도 event sequence를 파일 권한 `0600`으로 이어간다. 시작 시에는 journal 추정 상태를 재발행하지 않고, 확인된 node의 AppKey/model bind/60초 publication 응답을 다시 확인·보정한 뒤 Generic OnOff, Lightness, Health 실제 상태를 조회한다.
- startup resync는 4개 node 제한 queue와 busy 재시도를 사용한다. 구성 성공 뒤 같은 generation의 OnOff/Lightness pair가 오면 8초 resync `observed`로 집계하고, Health Current 미관측은 `healthPending`으로 별도 집계한다. `meshResync` health field와 구조화 log는 lighting pair가 전혀 없거나 전송이 모두 실패한 경우에만 unhealthy를 유지하며, 이후 heartbeat만으로 이를 healthy로 덮지 않는다. 늦은 Health Current publication은 pending을 회복한다. reconnect가 겹쳐도 하나의 resync만 수행하며, 응답이 없는 경우에는 offline 이벤트를 만들지 않는다.
- BlueZ model status는 부분 관측으로 취급한다. Generic OnOff, Lightness, Health Current 실제 관측이 같은 generation의 65초 coherence window 안에 모두 모일 때만 fixture-state snapshot을 발행한다. 새 resync와 단일 model update는 새 generation을 시작하므로 Health-only, 역순, 누락 또는 stale counterpart가 밝기 `0`, power-off, online 상태로 DB를 오염시키지 않는다.
- BlueZ 자발 status는 확인된 primary unicast address가 fixture mapping과 일치할 때만 처리한다. Health Current Fault(`0x04`)만 operational fault로 반영하며, Current를 실제 관측하기 전에는 online/fault snapshot을 확정하지 않는다. Registered Fault(`0x05`)와 no-fault byte `0x00`는 장애 상태를 만들지 않는다. gateway는 assignment의 site/gateway 범위를 payload에 주입해 MQTT v2 fixture-state로 발행하고, unknown address는 폐기한다.
- heartbeat가 90초 이상 없으면 연결된 조명을 `gateway_offline`, fixture state가 180초(60초 publication 3회 window) 이상 없으면 해당 조명을 `fixture_stale` 사유로 offline 처리한다.
- dashboard gateway 연결 상태 기준을 서버 TTL과 동일한 90초로 통일하고 fixture의 `statusReason`을 API 응답에 포함한다.
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
- 조명 검색 실패 시 gateway offline, ESP32 provisioned 상태, BLE scan adapter 미설정 등 원인별 안내
- 모니터링 화면 내 빠른 밝기 제어

## 부족하거나 개선이 필요한 기능

- 현재 실시간성은 3초 polling이므로 대규모 현장에서는 서버 부하와 반응성 조정이 필요하다.
- 조명 등록 완료 후 dashboard 반영은 polling에 의존하므로, 실제 현장에서는 provisioning event 기반 push 업데이트가 필요하다.
- gateway offline 기준은 현재 90초, fixture stale 기준은 180초(60초 publication 3회 window) 고정값이다. 대규모 현장 검증 후 site/gateway별 정책 설정으로 분리해야 한다.
- `lastSeenAt` 상대 시간은 클라이언트 현재 시간 기준이므로 서버 기준 freshness와 완전히 일치하지 않을 수 있다.
- RSSI, hop count, 명령 성공률은 표시만 하며, 품질 등급이나 설치 가이드로 연결되지 않는다.
- 1,000개 marker 조회/렌더링 기준은 자동 검증하지만, 더 큰 현장에는 공간 클러스터링과 검색이 추가로 필요하다.
- 현재 선택 로직은 첫 장애 조명 또는 첫 조명을 자동 선택하므로, 사용자가 이전에 보던 조명을 유지하는 정책을 더 정교하게 만들 수 있다.

## 관련 파일

- `apps/web/src/features/monitoring/MonitoringView.tsx`
- `apps/web/src/features/monitoring/FloorMap.tsx`
- `apps/web/src/api/queries.ts`
- `apps/api/src/sites/sites.controller.ts`
- `apps/api/src/sites/sites.service.ts`
- `apps/api/src/fixtures/fixtures.service.ts`
- `apps/api/src/mqtt/mqtt.service.ts`
- `apps/api/src/mqtt/topic-scope.ts`
- `apps/api/src/fixtures/fixture-freshness.service.ts`
- `apps/gateway/src/state/event-sequence-store.ts`
- `apps/gateway/src/mesh/bluez-mesh-adapter.ts`
- `apps/gateway/src/mesh/bluez-model-codec.ts`
- `apps/gateway/src/runtime/gateway-mqtt-runtime.ts`
- `apps/gateway/src/identity/certificate-rotation.ts`
- `apps/gateway/src/health/appliance-health.ts`
- `apps/gateway/docker/healthcheck.sh`
- `packages/shared/src/schemas.ts`
- `packages/shared/src/mqtt.ts`

## 갱신 규칙

모니터링 메뉴의 UI, API, DB, MQTT, 실제 gateway, 펌웨어 계약이 바뀌면 이 문서를 같은 작업 안에서 갱신한다.
