# 제어 메뉴 기능 현황

기준일: 2026-08-30

## 다음 구현 범위

- 스케줄 제어와 차량 감지 이벤트 제어 설계를 확정했다. 상세 계약은 `docs/superpowers/specs/2026-08-29-schedule-vehicle-event-control-design.md`를 따른다.
- 클라우드는 규칙 관리·배포 상태의 정본, Raspberry Pi Gateway는 무중단 hot reload와 offline 현장 실행의 정본, ESP32-H2는 3.3V Active High 마이크로웨이브 센서의 GPIO 상태 이벤트와 밝기 적용을 담당한다. High 동안 이벤트를 유지하고 Low 이후 규칙별 유지시간을 계산한다.
- shared 반복 일정 계약과 production DB schema에 이어 Task 7에서 schedule API, Task 8에서 차량 이벤트 규칙 API CRUD, exact Fixture snapshot과 full-snapshot outbox 저장을 구현했다.
- schedule/차량 이벤트 API CRUD는 완료했지만 Web CRUD와 Gateway 현장 실행은 아직 구현되지 않았다. 다음 구현은 MQTT publisher/application ACK, Gateway 규칙 엔진, ESP32-H2 센서 이벤트, Web CRUD, software E2E와 HIL 순서다.

## 확정 구현 범위

- 사용자가 명령을 적용하면 실제 BLE Mesh 상태 기반 terminal 결과가 나올 때까지 현재 제어 입력을 잠그는 사용자 관점의 동기 제어를 구현한다. HTTP 연결을 장시간 유지하지 않고 기존 Command/Outbox/MQTT 상태를 1초 polling으로 조회한다.
- 개별 조명, 임의 다중 선택, 층 전체, 저장 구역 단위 밝기 제어를 제공한다.
- 개별 조명은 unicast, 임의 다중 선택은 제한된 병렬 unicast를 사용한다.
- 층 전체와 저장 구역은 사전 구성된 BLE Mesh Group Address에 단일 전송한다.
- 임의 선택이 기존 층 또는 구역 구성과 정확히 같으면 Group Address 경로를 사용한다.
- 장비별 BLE Mesh Health Current의 현재 fault만 수집해 제어 가능 여부와 결과에 반영한다.
- gateway별 영속 `MeshControlGroup`/`MeshControlGroupMember` 저장 구조와 `0xC000~0xFEFF` group address allocator를 둔다. group은 `configurationVersion`, `operationPlanVersion`, `fullReconciliationRequired`를 분리하고, 버전별 `MeshControlGroupExpectedOperation`과 실제 pair snapshot인 `MeshControlGroupAppliedMember`를 영속 저장한다.
- API는 `configuring` group의 전체 desired member set과 `retiring` group의 빈 desired set, cloud가 발급한 expected operation 전체 set, `incremental | full_state` reconciliation mode를 10초 주기로 gateway-scoped MQTT subscription sync command로 재발행한다.
- gateway는 cloud operation ID를 보존해 Light Lightness Server `0x1300`의 Config Model Subscription Add/Delete를 수행한다. incremental 재전송에서 이미 만족된 operation은 동일 ID의 `ready`로 재보고하고, state-loss `full_state` plan은 로컬 membership snapshot과 무관하게 모든 Add/Delete를 Config Client에 멱등 재적용한다.
- API는 `siteId`, `gatewayId`, `groupId`, group address, version이 현재 group과 일치할 때만 subscription result를 처리한다. 현재 version의 영속 expected set과 ACK의 `operationId/action/meshNodeId/meshAddress`를 mutation 전에 exact-set으로 대조하며, 빈·부분·중복·외부 node·잘못된 action/address/operation ID를 fail-closed한다. 동일 node address 교체의 delete-old와 add-new 두 operation을 각각 반영하고 successful operation만 applied snapshot에 멱등 반영한다.

상세 계약은 `docs/superpowers/specs/2026-08-26-monitoring-control-statistics-completion-design.md`를 따른다.

## 명시적 보류 범위

- 다중 gateway command 최종 집계 고도화
- ACK 계약 전면 개편과 API MQTT 소비 내구성 재설계
- 명령 재시도, 취소, rollback과 명령 이력 전용 화면
- 스케줄 제어와 차량 감지 이벤트 제어 외의 센서·장면 자동제어
- RSSI, hop count와 제품별 상세 diagnostics
- 자동 HIL 판정. 실제 하드웨어 검증은 단일 gateway 기준으로 수동 수행한다.

## 구현 완료

- `GET/POST/PATCH/DELETE /sites/:siteId/automation/vehicle-event-rules`를 제공한다. viewer는 assigned Site 목록을 조회하고 assigned active customer admin만 생성·수정·삭제할 수 있으며 operator와 다른 Site의 규칙은 `404`로 숨긴다. 목록 query는 Site 읽기 인가 뒤 파싱한다.
- 차량 이벤트 규칙은 distinct source와 target Fixture를 각각 한 개 이상 요구하고 등록 완료 Fixture만 저장 시점의 exact ID set으로 고정한다. source는 MeshNode capability가 `supported`이고 검증 시각이 있는 Fixture만 허용하며 unknown/unsupported/다른 tenant 식별자는 일반화된 validation 오류로 거부한다. target capability 검증은 하지 않는다. source와 target 전체가 같은 Site와 한 Gateway에 속해야 하며 다중 Gateway는 stable `single_gateway_required`로 거부한다.
- hold는 기본 60초, 5~1800 정수 범위이고 밝기는 0~100 정수다. `dimmingEnabled=false`는 입력 밝기를 저장하지 않고 DB/API/Gateway snapshot 모두 100%로 정규화한다.
- 차량 이벤트 parent/source/target과 Gateway `desiredRevision`, 전체 automation snapshot `MqttOutbox`를 하나의 transaction에 저장한다. write transaction은 공통 automation advisory lock을 먼저 획득한 뒤 Site row `FOR UPDATE` 재인가를 수행하며 Gateway 이동은 이전 제거 snapshot과 새 추가 snapshot을 함께 생성한다.
- 차량 이벤트 목록은 schedule과 같은 기본 25개·최대 100개 versioned keyset cursor와 `REPEATABLE READ` total/page snapshot을 사용한다. source/target 수, desired/applied revision, sync status, 최신 `vehicle_detected`와 최신 실행을 제공한다. 최신 전체 실행은 일반 ordered index, 최신 감지는 `kind='vehicle_detected'` partial ordered index를 사용한다.
- MeshNode 차량 센서 capability와 source-only CRUD 검증은 완료됐다. 실제 Gateway 모델 바인딩이 capability status와 검증 시각을 설정하는 작업은 Task 14 범위다.
- `GET/POST/PATCH/DELETE /sites/:siteId/automation/schedules`를 제공한다. assigned active customer admin만 생성·수정·삭제할 수 있고 viewer는 목록만 조회하며 operator와 다른 Site 요청은 `404`로 숨긴다.
- schedule mutation은 같은 transaction의 첫 statement에서 공통 automation advisory lock을 획득한 뒤 Site row를 잠그고 assigned admin을 다시 인가한다. fixture·fixture set·floor·active group 선택은 저장 시점의 등록 완료 Fixture ID 전체 set으로 고정하고 한 Gateway 대상만 허용한다.
- enabled schedule은 공통 automation engine의 실제 recurrence occurrence와 Fixture 교집합으로 충돌을 검사한다. disabled schedule은 충돌에서 제외하고 enable 시 다시 검사하며, 같은 Site에서 동시에 쓰는 서로 충돌하는 enabled schedule만 Site lock 아래 하나가 성공한다. 종료와 시작 경계가 맞닿지만 겹치지 않는 schedule은 함께 허용한다.
- schedule parent, deferred cardinality를 만족하는 child snapshot, Gateway `desiredRevision`, 전체 automation snapshot `MqttOutbox`를 원자 저장한다. Gateway 이동 update는 이전 Gateway의 제거 snapshot과 새 Gateway의 추가 snapshot을 함께 만들고 새 Gateway의 `appliedRevision`은 0으로 초기화한다.
- `dimmingEnabled=false` action은 DB와 Gateway snapshot 모두 `brightnessPercent=100`으로 정규화한다. 같은 local start/end는 full-day로 해석하지 않고 거부한다. 목록은 기본 25개·최대 100개이며 Site/생성 시각/ID를 담은 versioned base64url keyset cursor를 사용한다. Site 인가, 전체 수, page는 하나의 `REPEATABLE READ` snapshot에서 읽고 다음 occurrence, desired/applied revision, sync status와 최근 실행을 page row에만 결합한다.
- pending assigned admin이 제어 직접 URL로 들어오면 CustomerShell이 제어 화면을 계속 열지 않고 selected/default `siteId`를 보존한 최초 설치 설정으로 replace한다. 설치 완료 전에는 제어 mutation UI가 노출되지 않는다.
- dashboard의 fixture, 층, 저장 구역 목록을 기반으로 `개별/다중`, `층`, `구역` 제어 대상을 선택할 수 있다.
- 개별/다중 조명 목록은 이름 검색, 상태·층 필터, checkbox 선택을 제공하고 선택 개수와 제어 불가 개수를 표시한다.
- 개별/다중 조명은 최대 1,000개까지 선택할 수 있으며, 목록은 최초 100개를 렌더링하고 `더 보기`로 100개씩 추가해 대규모 현장의 브라우저 부하를 제한한다.
- 선택 조명의 현재 밝기를 슬라이더에 반영한다.
- 0%, 30%, 70%, 100% 프리셋 버튼으로 밝기 값을 바꿀 수 있다.
- `POST /commands/dimming`으로 선택한 개별·다중 조명, 층 또는 구역의 밝기 명령을 전송한다.
- 웹은 1개 조명에 `fixture`, 2개 이상에 `fixtures`, 층에 `floor`, 구역에 `group` 구조의 신규 `target` payload를 사용한다. 명령 API는 실제 현장 DB 관계를 같은 transaction 안에서 다시 조회해 확정된 `targetFixtureIds` snapshot을 저장한다.
- 단일 조명은 `unicast`, 임의 다중 선택은 `parallel_unicast`, 준비 완료된 층/저장 구역은 `mesh_group` delivery mode로 저장한다. 임의 선택이 준비 완료된 층 또는 구역 구성과 정확히 같으면 층 우선, 같은 종류 ID 정렬 순으로 Group Address 경로를 선택한다.
- 하나의 논리 target이 여러 gateway에 걸치면 `현재 여러 게이트웨이에 걸친 대상은 지원하지 않습니다`로 전체 거부하며, 준비되지 않은 floor/group은 unicast로 fallback하지 않는다.
- 명령 생성 응답은 `selectedTargetCount`, `transmissionCount`, `deliveryMode`, `terminalStatusUrl`을 제공하고 상태 응답은 nullable `targetId`, 확정 fixture snapshot과 dispatch의 delivery metadata를 반환한다. Mesh group dispatch에는 선택 당시 `meshControlGroupId`, `meshControlGroupVersion`, Group Address가 함께 보존된다.
- 명령 생성 응답은 command ID와 gateway dispatch 수를 반환하고, `GET /commands/:commandId`는 command의 현장 read 권한이 있는 사용자에게만 조회를 허용한다. 존재하지 않는 command와 접근할 수 없는 command는 같은 `command not found` 404 응답으로 처리한다.
- 제어 화면은 최근 명령을 1초 polling하며 접수, MQTT 발행, gateway 수신, 조명 적용 완료, 일부 실패, 실패, timeout 단계를 표시하고 종료 상태에서 polling을 중단한다.
- 제어 화면은 POST 전에 인증 사용자·현장별 `sessionStorage`에 canonical 요청을 저장하고, 명령 생성 직후 active command ID를 함께 보존해 새로고침 후 같은 사용자와 현장의 진행 명령만 복구한다. 로그아웃은 현재 사용자의 모든 복구 레코드만 제거하며 다른 사용자의 레코드는 건드리지 않는다. 저장소 helper는 접근 불가·손상 데이터·잘못된 UUID를 안전하게 무시한다.
- `completed`, `partial_failed`, `failed`, `timed_out` terminal 상태를 확인하기 전까지 대상 선택, 검색·필터, 밝기 slider, preset, `밝기 적용` 버튼을 잠근다. 상태 응답의 command ID가 현재 추적 ID와 일치할 때만 terminal 결과로 반영하고 잠금을 해제한다. ID가 불일치하면 terminal로 처리하지 않고 1초 polling과 `명령 상태 다시 조회`를 유지한다.
- terminal 결과는 화면에 유지하며, 네트워크 오류와 5xx는 명령 실패로 확정하지 않고 command ID를 보존해 `명령 상태 다시 조회`로 재조회한다. cached nonterminal 상태가 남아 있어도 최신 조회에서 인증된 404로 명령이 더 이상 존재하지 않음이 확인되면 저장된 active command를 CAS 방식으로 제거하고 잠금을 해제한다.
- active command 저장·삭제는 RFC 4122 UUID 검증과 `(authenticated userId, siteId)` key 격리를 사용한다. terminal command 삭제는 기대 command ID, 확정 거부 요청 삭제는 기대 client request ID를 다시 비교해 오래된 비동기 결과가 새 저장값을 지우지 못하게 한다.
- Playwright deterministic route fixture는 실제 Health snapshot 표시, 개별·다중 조명 명령 생성, 다중 unicast 전송 수, terminal 전 모든 제어 입력 잠금, `partial_failed`의 성공·timeout 조명별 결과, 동일 탭 새로고침 후 active command 복구와 terminal 완료 추적을 검증한다. 이는 브라우저와 API 계약 회귀이며 실제 BLE Mesh 전송 검증이 아니다.
- 최근 명령의 전체/처리 조명 수와 조명별 실패 또는 timeout 사유를 표시한다.
- 대상 picker의 `개별/다중`, `층`, `구역` 버튼으로 제어 모드를 전환하고 각 모드에서 실제 전송 대상을 선택한다.
- 백엔드는 SiteAccess `manage` 권한이 있는 assigned customer admin만 해당 현장의 fixture 또는 group을 제어 대상으로 허용하며, 미배정 또는 다른 고객사 현장은 `404`로 숨긴다. operator는 customer shell과 고객 Site capability를 갖지 않는다.
- `viewer` 권한 사용자는 배정 현장을 조회할 수 있지만 조명 제어 명령 생성은 `403`으로 거부한다.
- 사용자 역할은 service-provider `operator`, customer `admin`, 조회 전용 `viewer` 세 가지다. customer control은 assigned admin의 SiteAccess `manage` 범위로 한정되고, viewer는 화면 비활성화와 API `403` 양쪽에서 변경이 차단된다. operator는 전용 shell로 customer control을 mount하지 않는다.
- `GET /sites/:siteId/fixture-groups`, `POST /sites/:siteId/fixture-groups`, `PATCH /sites/:siteId/fixture-groups/:groupId`, `DELETE /sites/:siteId/fixture-groups/:groupId`, `POST /sites/:siteId/fixture-groups/:groupId/resync`를 제공한다. 목록은 read 권한의 viewer도 볼 수 있고, 생성·수정·삭제·재동기화는 assigned admin만 수행한다.
- 제어 화면의 `구역 관리` dialog에서 assigned admin은 같은 층·gateway의 조명 1~100개를 선택해 저장 구역을 생성·수정하고, 확인 후 삭제하거나 실패한 Mesh 설정을 재동기화할 수 있다. viewer는 동일 dialog에서 lifecycle과 Mesh 상태만 조회한다.
- 대상 picker는 층과 저장 구역의 `Mesh 설정 중`, `Mesh 설정 실패`, `제어 준비 완료` 상태를 표시한다. 층은 포함 조명의 모든 gateway별 Mesh group metadata가 존재하고 `ready`일 때만 선택할 수 있으며, 하나라도 누락되거나 준비되지 않으면 fail-closed한다.
- 저장 구역 생성·수정은 이름, 한 floor, 한 gateway와 1~100개의 unique fixture 전체 set을 입력으로 받는다. transaction은 기존 group, floor, gateway, fixture ID 순으로 잠가 같은 조명의 active/retiring 사용자 구역 15개 한도를 직렬화하고, mesh node가 없거나 선택 경계를 벗어난 fixture를 거부한다.
- 저장 구역 변경은 `GroupFixture`와 `MeshControlGroupMember.desired`를 전체 교체하고 configuration version을 증가시켜 `configuring`으로 전환한다. provisioning 중 configuring group에 새 desired member가 실제 삽입되는 경우도 version을 증가시켜 이미 발행된 이전 ACK를 stale로 무시하고 새 expected operation set으로 자동 수렴한다. 중복 member attach는 version을 바꾸지 않는다.
- foundation migration에서 active로 판정됐지만 MeshControlGroup이 없던 legacy 구역은 update/delete/resync transaction이 group을 생성해 복구한다. resync는 기존 `GroupFixture`의 controllable node를 새 desired set으로 복원한 뒤 version을 증가시킨다.
- PATCH에서 gateway 변경은 전체 replacement로 정의한다. 이전 gateway의 MeshControlGroup은 version을 증가시킨 빈 desired set과 `retiring` 상태로 남겨 subscription cleanup을 계속하고, 새 gateway에는 별도 MeshControlGroup과 전체 desired set을 구성한다. 이전 cleanup ACK는 active FixtureGroup을 retired로 바꾸지 않으며 과거 dispatch 참조도 보존한다.
- 삭제는 과거 `CommandDispatch`의 MeshControlGroup 참조를 보존하는 soft delete다. FixtureGroup은 `retiring`, member desired set은 빈 배열, MeshControlGroup은 `retiring`이 되며, 기대한 모든 Delete operation의 exact ACK가 성공할 때만 두 group 모두 `retired`가 된다. publish 실패, gateway 재시작 또는 ACK 실패에는 같은 version/set을 계속 재발행하며 resync는 version만 증가시킨다.
- gateway reconnect resync는 `configuring/ready/failed`를 새 `configuring` version으로 재발행하고 `retiring`은 `retiring`을 유지한다. member의 이전 `operationId/operation`과 version 진행 상태를 초기화하고 새 version plan에 fresh operation ID를 발급한다. `first_run/state_missing/state_corrupt`는 영속 full-state reconciliation을 설정해 active/configuring은 모든 desired pair를 Add로 재확인하고 retiring은 cloud applied snapshot의 모든 pair를 Delete한다. exact ACK가 현재 version을 수렴시킨 뒤에만 full-state flag를 해제하며, 일반 `startup` resync는 미완료 flag를 지우지 않는다. `retired`는 조회·version 증가·member reset에서 제외해 다시 활성화하지 않는다.
- gateway A에서 B로 이동한 뒤 B 삭제가 진행 중이어도 지연된 A cleanup ACK는 FixtureGroup의 현재 gateway ownership과 다르므로 lifecycle을 `retired`로 바꾸지 못한다. 현재 owning gateway의 MeshControlGroup이 빈 applied set으로 수렴한 ACK만 soft delete를 완료한다.
- legacy `invalid`와 `retiring`/`retired` 저장 구역은 일반 명령 target과 exact-set mesh group 승격에서 제외한다. invalid/retired는 읽기 전용이며, 아직 retiring인 구역은 subscription 정리 완료 전 제어할 수 없다.
- dashboard는 active 저장 구역에 lifecycle, floor/gateway, fixture count, MeshControlGroup status/version/error를 제공하고 층에도 gateway별 MeshControlGroup 상태를 제공한다. Web은 `ready`가 아닌 층·저장 구역을 제어 picker에서 비활성화하며 retired/invalid 구역은 dashboard 제어 target에 포함되지 않는다.
- 비접근 site의 저장 구역 요청은 query/body 형식 검증보다 SiteAccess를 먼저 수행해 malformed 입력이어도 일관된 `404` 경계를 유지한다.
- API command/scan outbox worker는 initial·interval batch의 transient DB 실패를 scheduler 경계에서 격리해 API process를 유지하고 다음 tick에서 회복한다. 각 batch와 Mesh group sync는 single-flight이며 종료가 시작되면 다음 record/group publish를 시작하지 않는다. `MqttShutdownCoordinator` 하나가 command/scan outbox와 `MeshGroupSyncWorker`의 멱등 `stopAndDrain()`, inbound MQTT listener 분리와 진행 중 handler drain을 모두 완료한 뒤에만 MQTT client close를 시작한다. Mesh subscription sync와 inbound application ACK는 PUBACK이 없으면 10초에 해당 packet ID를 취소하므로 drain이 무기한 대기하지 않으며, timeout rejection은 payload·topic·오류 상세를 남기지 않는 최상위 오류 경계에서 격리한다. 이후 close는 MQTT.js graceful `end` callback을 await하고 5초 안에 완료되지 않으면 force close callback을 추가 1초간 기다린 뒤 종료를 계속한다.
- 제어 생성은 `(siteId, requestedBy, clientRequestId)`와 안정 정렬한 target·brightness fingerprint로 멱등 처리한다. 동일 요청은 기존 command를 반환하고 다른 payload는 `409 client_request_id_payload_conflict`로 거부하며, 동시 unique 충돌은 새 transaction 재조회로 수렴한다. Web은 네트워크 오류·5xx·응답 유실에서만 같은 요청의 재전송을 제공하고, 4xx 확정 거부는 pending 요청을 제거해 UI를 즉시 잠금 해제한다. 전송 중 사용자·현장 전환 시 기존 요청을 abort하고 generation/scope가 다른 지연 성공·실패 결과를 현재 화면에 반영하지 않는다.
- `viewer`가 제어 화면에 진입하면 읽기 전용 안내를 표시하고 밝기 슬라이더, 프리셋, 대상 선택과 `밝기 적용` 버튼을 모두 비활성화한다. 이 경우 브라우저는 `POST /commands/dimming`을 보내지 않으며 권한 오류를 장비 장애로 오인하지 않는다.
- Task 9 격리 실백엔드 Chromium E2E는 assigned admin이 개별, 임의 다중, 층, 저장 구역 밝기 명령을 production command API로 전송하고 test-support software simulator가 MQTT acceptance/device-status ACK와 fixture-state를 반환해 각 명령이 terminal 상태로 수렴하는 것을 검증했다. simulator는 lab CA의 `CN=Gateway.id` client certificate와 own-gateway topic ACL을 사용하지만, production Gateway 인증서 발급·bootstrap·배포 ACL 또는 실제 BlueZ/RF 전송을 검증한 것은 아니다. operator는 customer route를 mount하지 않고 viewer는 읽기 전용이다.
- 백엔드는 조명의 gateway 매핑, gateway 90초 heartbeat, fixture online/fault 상태를 명령 생성 전에 검증하며 하나라도 제어할 수 없는 그룹 전체를 거부한다.
- 제어 화면은 서버의 `controllable`, `controlBlockReason`에 따라 대상 선택과 `밝기 적용`을 차단하고 미매핑, gateway offline, fixture offline/fault 사유를 한국어로 표시한다.
- 초기 데이터가 없으면 loading 또는 empty state를 구분해 표시한다. 기존 캐시가 있는 상태에서 dashboard 백그라운드 갱신이 실패해도 제어 화면과 캐시 데이터를 유지한다.
- 그룹 제어 명령은 MQTT payload에 `targetFixtureIds`를 포함해 게이트웨이가 실제 대상 조명 목록을 바로 처리할 수 있게 한다.
- MQTT `command-ack` 이벤트가 command 상태를 갱신한다.
- Raspberry Pi gateway 앱 골격이 `sites/{siteId}/commands/dimming` MQTT 명령을 수신하고 ACK, fixture state, heartbeat를 발행한다.
- ESP32-H2 펌웨어는 PlatformIO 대신 ESP-IDF 구조로 작성하며, LEDC PWM 기반 밝기 적용 골격을 제공한다.
- ESP-IDF `v5.5.1` + `esp32h2` 환경을 로컬에 구성했고 `scripts/esp32-h2-build.sh`로 실제 펌웨어 빌드를 통과했다.
- 게이트웨이 smoke test 스크립트(`pnpm gateway:smoke`)는 mTLS와 gateway-scoped v2 명령, acceptance/device-status ACK 흐름만 검증한다.
- ESP32-H2 실제 보드 플래시 절차와 라즈베리파이 게이트웨이 로컬 실행 절차를 문서화했다.
- ESP32-H2 펌웨어는 Health Server, Generic OnOff Server, Light Lightness Server를 제공한다. provisioning 및 gateway startup 보정 시 세 Server model에 AppKey bind와 provisioner 주소 60초 publication을 응답으로 확인한다. ESP-IDF publication update callback은 OnOff/Lightness publication buffer만 실제 상태로 갱신하고, 전송은 Mesh stack 자동 publication에 맡겨 중복 송신하지 않는다.
- ESP32-H2 펌웨어는 BLE Mesh Health Attention 이벤트를 250ms identify 점멸로 처리하고 종료 시 원래 밝기로 복원한다. Health fault test/clear와 watchdog fault 기록도 펌웨어 경계에서 구현했다.
- ESP32-H2 펌웨어는 active-low GPIO를 8초간 누르면 앱 NVS와 BLE Mesh credential을 지우고 재부팅하는 물리 factory reset을 수행한다.
- Gateway adapter 계약을 fixture별 장비 리포트 기반으로 확장해 일부 노드 실패 시 command ACK와 fixture state가 함께 동기화되도록 했다.
- Raspberry Pi gateway는 BlueZ 5.82 D-Bus application, network 생성/attach, fixture-unicast 영속 mapping, acknowledged Light Lightness Set/Status adapter를 양산 경로로 사용한다.
- 실제 조명 Status 수신 전에는 제어 성공으로 처리하지 않으며 mapping 없음, status 불일치, timeout을 fixture별 실패 코드로 반환한다.
- ESP32-H2 등록 후 AppKey 0 추가, Health Server `0x0002`, Generic OnOff Server `0x1000`, Light Lightness Server `0x1300` bind와 provisioner 주소 60초 publication을 설정한다.
- Docker appliance는 Raspberry Pi 실제 HCI에서 mesh network 생성과 token 재시작 attach를 통과했다.
- API와 gateway의 legacy MQTT v1 dimming, fixture-state, command-ack, heartbeat 경로를 제거하고 gateway-scoped MQTT v2만 사용한다.
- 양산 gateway에 mock, stub, shell command adapter를 포함하지 않는다. 자동 테스트 adapter는 `apps/gateway/test`에만 둔다.
- 수동 명령은 현재 단일 gateway `CommandDispatch`로 만들고 gateway 독립 sequence와 idempotency key를 발급한다. 여러 gateway에 걸친 논리 target은 후속 fan-out 설계 전까지 생성하지 않는다.
- Command, gateway별 dispatch, 조명별 pending 결과, MQTT outbox를 하나의 DB transaction에 저장한다.
- MQTT outbox publisher가 PostgreSQL `FOR UPDATE SKIP LOCKED`와 30초 worker lease로 다중 API 인스턴스의 중복 발행을 차단한다.
- Publisher는 strict draft/full 저장 payload를 모두 처리하되 full payload의 과거 `expiresAt`만 제거한다. Mesh snapshot 검증 직후 fresh clock으로 현재 worker의 유효 lease만 30초 연장하고 payload는 아직 수정하지 않는다. Final ownership query가 반환된 뒤 fresh clock으로 준비 lease가 20초 MQTT timeout 전체를 엄격히 덮는지 확인한 다음 새 expiry를 만들고 즉시 발행한다. Full payload와 `publishedAt`은 MQTT 성공 transaction에서 함께 저장한다. Timeout 시 해당 message ID를 outgoing store에서 제거하며 backoff/dead-letter 시각도 실제 실패 시각을 사용한다.
- Pending timeout은 active lease를 조회 결과에서 추정하지 않고 transaction에서 미발행 outbox row를 먼저 dead-letter 선점한다. Outbox가 없거나 active lease가 있으면 fail-closed하고, 선점 뒤 Dispatch 경쟁을 잃으면 transaction을 rollback한다. Published/accepted timeout은 outbox 선점 없이 기존 조건부 종료를 유지한다.
- Mesh group outbox는 발행 직전 현재 group의 ID, gateway, 주소, 구성 버전, `ready` 상태가 명령 생성 snapshot과 같은지 다시 검증한다. 같은 버전의 `configuring`은 재시도하고 삭제·실패·버전/주소/gateway 불일치는 MQTT로 보내지 않고 `MESH_GROUP_STALE`로 즉시 실패 처리한다.
- broker 전송 실패에는 지수 backoff와 jitter를 적용하며 최대 10회 또는 15분을 넘으면 outbox를 dead-letter 처리하고 dispatch, 조명별 결과, 상위 명령을 실패로 종료한다.
- API timeout worker는 미발행 명령 15분, MQTT 발행 후 acceptance 10초, acceptance 후 장비 상태 30초 deadline을 적용하고 종료되지 않은 명령을 `timed_out`으로 확정한다.
- gateway는 v2 dimming command를 로컬 `0600` journal에 먼저 기록한 뒤 acceptance ACK를 보내고, BLE Mesh adapter 결과 후 fixture별 device-status ACK를 보낸다.
- 동일 idempotency key의 최종 결과가 journal에 있으면 실제 조명을 다시 제어하지 않고 기존 ACK를 재발행한다.
- Broker가 명령을 받은 직후 API 프로세스가 종료되면 outbox에는 기존 draft/full payload와 lease만 남아 재시도될 수 있다. 이 at-least-once 경계에서 Gateway journal이 동일 idempotency key의 BLE 재실행을 차단한다.
- API는 gateway/site/command/dispatch identity가 모두 일치하는 ACK만 반영한다. rejected acceptance는 같은 transaction에서 dispatch, 남은 조명별 결과, 상위 Command를 failed로 종료하며, acceptance 발행 뒤 만료된 rejection도 `accepted` dispatch를 같은 terminal 상태로 닫는다. terminal dispatch의 늦은 ACK는 무시한다.
- API는 `device-status ACK` 처리 transaction에서 active dispatch와 해당 `CommandFixtureResult` 전체를 먼저 잠근다. ACK의 fixture ID 집합은 dispatch snapshot과 개수까지 정확히 같아야 하며 누락·중복·외부 fixture는 `ack_fixture_set_mismatch`로 전체 dispatch와 fixture 결과를 실패 처리한다. 개별 결과에서 유도한 상태는 모두 성공 `succeeded`, 모두 timeout `timed_out`, 성공이 포함된 혼합 `partially_succeeded`, 성공 없이 실패가 포함된 결과 `failed`이며 ACK status가 다르면 `ack_status_mismatch`로 fail-closed한다. 검증이 끝나기 전에는 개별 결과를 부분 반영하지 않는다.
- BLE Mesh fixture status는 기본 8초 timeout을 적용하고 adapter가 반환하지 않아도 fixture별 `timed_out` 결과로 명령을 종료한다.
- Gateway 재시작 후 accepted-only 명령은 실제 조명을 다시 제어하지 않고 `indeterminate after gateway restart` timeout 결과로 닫는다.
- Gateway journal은 idempotency 결과를 24시간·최대 10,000건만 유지한다. restart resync는 journal 추정값을 상태로 발행하지 않고 확인된 node에 OnOff/Lightness/Health Get을 보내 실제 응답만 fixture-state로 반영한다.
- Gateway startup state는 OnOff, Lightness, Health Current가 같은 관측 generation의 65초 window 안에 모두 확인될 때만 제어 화면과 API에 새 snapshot으로 반영한다. Health Current가 아직 오지 않았거나 한 model만 갱신된 경우에는 기존 상태를 보존한다.
- Health Current fault code는 MQTT v2 구조화 payload와 `Fixture` 최신 snapshot으로 저장된다. API는 fault가 하나라도 있는 조명을 `fixture_fault`로 제어 차단하고, 제어 목록은 각 조명을 `Health 정상`, `Health 장애`, `Health 확인 대기`로 표시한다. Health가 없는 명령 결과 이벤트는 확인된 최신 Health snapshot을 지우지 않는다.
- gateway health artifact는 startup resync의 `total/configured/observed/healthPending/timedOut/failed`를 `meshResync`로 기록한다. `observed`는 같은 generation의 OnOff/Lightness 실제 pair 기준이며, Health Current는 이후 publication까지 pending으로 보존한다. lighting pair 전체 실패만 unhealthy로 유지되어 제어 가능 상태를 heartbeat만으로 잘못 회복하지 않는다.
- Gateway는 assignment의 gateway ID 기반 MQTT 5 persistent session으로 QoS 1 command subscription을 유지한다. Outbox는 실제 MQTT publish 직전에 `expiresAt`을 API의 10초 acceptance deadline 기준으로 계산해 DB payload에 기록하고, 같은 기준의 10초 MQTT message expiry를 설정한다. Gateway는 `requestedAt`이 아니라 `expiresAt`을 사용하며, 최대 2초 느린 gateway clock도 deadline 이후 BLE를 실행하지 않도록 acceptance ACK 뒤 BLE 직전에 다시 만료를 검사한다. BLE 실행 또는 장비 상태 관측이 없었던 만료/불확정 결과는 fixture-state와 journal의 최신 실제 관측을 갱신하지 않아 기존 실제 상태를 보존한다. Production broker는 gateway별 최대 100개 또는 1 MiB QoS 1 queue를 유지하므로 이 한도를 넘는 offline 명령은 보장하지 않는다. API의 global event consumer는 deployment instance ID가 포함된 고유 client ID를 쓰되 clean session으로 연결한다.
- `MeshControlGroupService.ensureFloorGroup/ensureFixtureGroup`은 호출자 transaction 안에서 gateway row를 잠그고 기존 group을 재사용하며, 증가 전 `Gateway.nextMeshGroupAddress` 값을 실제 group address로 예약한다. 새 group은 `configurationVersion = 1`로 시작한다. 대상이 다른 site에 있으면 거부하고 `0xFF00` 이상이면 명시적 소진 오류를 반환한다.
- `RegistrationService.registerBatch`는 provisioning publish 전에 층 control group을 선확보하고, provisioning 완료 transaction은 floor group과 기존 `FixtureGroup` membership의 control group member를 idempotent하게 연결한다.
- 새 member가 실제로 추가되면 기존 group이 `configuring`, `ready`, `failed` 중 어느 상태여도 `configurationVersion`을 1 올리고 group을 `configuring`으로 전환하며, 해당 group의 전체 member를 `pending`, `statusVersion = 0`, `operationId/operation = null`, `lastError = null`로 초기화한다. `appliedVersion`은 마지막 성공 이력으로 보존한다.
- `MeshControlGroupService.getReadyDestination`은 floor/fixture-group과 gateway site 경계를 확인한 뒤 `ready` group의 ID, address, configuration version을 반환하고, 아직 준비되지 않은 target은 `mesh control group is not ready`로 거부한다.
- control group member 추가와 subscription ACK 반영은 둘 다 group row를 먼저 잠그는 같은 순서로 직렬화해 중복 member attach, version 이중 증가와 group/member 교착 경계를 줄인다.
- 기존 fixture가 다른 층에 이미 연결돼 있으면 provisioning 완료는 `fixture is already assigned to another floor` 오류로 실패시키고, 자동 재배치나 잘못된 floor group attach를 허용하지 않는다.
- Gateway는 `unicast`, 동시성 8의 `parallel_unicast`, `mesh_group` delivery mode를 실제 BlueZ BLE Mesh 경로로 분기한다. 병렬 unicast와 group 경로는 queue 획득 뒤, TID 할당 뒤, BlueZ 호출 직전에 중단 여부를 재확인해 timeout 이후 새로운 RF 전송이 시작되지 않게 한다.
- `mesh_group`은 group address에 Light Lightness Set Unacknowledged를 정확히 한 번 전송한 뒤, 명령 snapshot의 각 fixture primary unicast에서 오는 실제 Lightness Status를 집계한다. 주기 publication의 이전 상태를 최종 결과로 즉시 확정하지 않고 목표 Lightness와 일치하는 Status를 기다리며, 제한 시간까지 일치하지 않으면 마지막 실제 관측값을 `state_mismatch`, 응답이 없으면 `timed_out`으로 확정한다.
- Gateway 명령은 주소 조회, queue 대기, TID 저장, BlueZ 전송과 Status 수집 전 구간에 하나의 절대 deadline을 적용한다. 내부 Status 수집 종료 뒤에는 250ms 비상 grace만 허용해 확정된 `state_mismatch` 결과를 보존하고 deadline 이후 신규 RF 송신을 차단한다.
- Mesh TID는 목적지별 독립 순환을 보장하는 v2 형식으로 저장하며 기존 v1 파일은 자동 마이그레이션한다. 최대 1,000개 목적지의 다음 32개 TID 블록을 한 번의 원자 저장으로 예약하고, 저장 실패 시 TID를 발급하지 않으며 재시작 시 미사용 예약분을 건너뛴다.
- 명령 결과 뒤 fixture-state는 실제 ACK 또는 `state_mismatch` Status가 관측된 조명만 발행한다. 부분 timeout 또는 전송 실패 조명을 임의의 0%·꺼짐·fault 상태로 덮어쓰지 않는다.
- Gateway는 group ID/address/version별 `configuring | ready | failed` 상태를 임시 파일 저장, 파일 fsync, rename, 디렉터리 fsync 순으로 영속화한다. 첫 subscription 요청 전에 `configuring`을 저장하고 전체 member 결과가 정확히 일치한 경우에만 `ready`를 저장한다. 같은 group의 sync/control은 직렬화하고 다른 group은 병렬 실행한다.
- Gateway 재시작 시 정상적인 durable group state는 그대로 복원한다. state 파일이 없거나 state/manifest revision이 다르거나 손상됐을 때는 로컬 applied membership을 신뢰하지 않고 빈 상태로 fail-closed하며, 같은 `eventId`의 `first_run/state_missing/state_corrupt` resync 요청을 영속화한다. API가 DB 반영 후 보낸 애플리케이션 ACK의 `requestEventId`를 확인할 때까지 재시작·재연결·heartbeat에서도 재전송한다. API는 cloud applied snapshot을 삭제하지 않고 full-state Add와 retiring Delete 근거로 사용하며, gateway는 성공 결과를 새 durable membership snapshot으로 원자 저장한다. cloud에도 gateway에도 남지 않은 미확인 물리 subscription address는 자동 복구할 수 없으므로 HIL/운영 감사 위험으로 남긴다.
- MQTT command subscribe 실패는 현재 연결에서 최대 30초 backoff로 재시도한다. 직전 SUBACK가 실패했다면 persistent session 재연결의 `sessionPresent`와 관계없이 command 및 resync ACK topic을 강제 재구독한다. subscription 결과에 member 누락, 중복 또는 미등록 node가 있으면 group을 `failed`로 저장한다.
- ESP32-H2는 group Light Lightness Set Unacknowledged를 PWM에 즉시 반영하고 primary unicast 기반 `64~5,179ms` 결정적 지터 뒤 실제 Lightness Status를 publication한다. `(source, destination, TID)` 6초 cache가 중복 적용과 publication 재예약을 막는다.
- 펌웨어의 모델별 group subscription 상한은 16개이며, 서비스 계약은 조명 한 대당 층 group 1개와 사용자 fixture group 최대 15개다. API도 provisioning member 연결 시 같은 사용자 group 상한을 검증한다.

## 미구현

- 스케줄 제어 Web CRUD와 Gateway 무중단 offline 실행
- 차량 이벤트 규칙 Web CRUD와 ESP32-H2 센서 이벤트 전달
- 인체 감지, 외부 이벤트, 장면과 복합 조건 rule builder
- 명령 전송 이력 화면
- 명령 retry, rollback, cancel
- 조명 on/off 전용 토글
- 위험 명령 확인 dialog
- gateway의 원격 `identify-device` 명령을 실제 BlueZ adapter의 Health Attention Set으로 전달하는 연결
- ESP32-H2 제품/진단 정보 report의 gateway/API 연동
- ESP32-H2 실제 보드 플래시 검증

## 부족하거나 개선이 필요한 기능

- Task 7은 automation full snapshot을 durable `MqttOutbox`에 저장하지만 실제 MQTT publish와 exact revision application ACK 처리는 Task 9 범위다. 따라서 API 저장 성공은 Gateway 적용 완료를 의미하지 않는다.
- Task 8 차량 이벤트 규칙 API도 같은 durable full-snapshot outbox까지만 구현했다. 최근 감지/실행 필드는 실행 원장이 수집된 경우에만 채워지며 실제 센서 감지와 Gateway 실행 완료를 의미하지 않는다.
- pending redirect와 네 가지 제어 target의 production API/MQTT ACK/state 경로는 Task 9 격리 실백엔드 software E2E로 검증했다. 실제 Raspberry Pi/BlueZ/ESP32-H2 HIL은 아직 실행하지 않았다.
- `clientRequestId`와 payload를 보존하는 응답 유실 복구는 자동 테스트와 실제 Chromium 재로딩 흐름을 통과했다. 실장비 terminal ACK 왕복은 Raspberry Pi/ESP32-H2 HIL에서 확인해야 한다.
- schedule API CRUD는 구현 완료했다. schedule Web CRUD와 Gateway schedule 실행은 후속 범위이며, 아직 동작하지 않는 Web 버튼은 양산 UI에서 제거했다.
- 최근 명령은 ACK 완료/실패까지 추적할 수 있지만, 이전 명령을 검색하고 다시 열 수 있는 명령 이력 화면은 아직 없다.
- Health Current는 최신 snapshot만 사용하며 fault 이력과 제품별 code 설명은 아직 제공하지 않는다.
- viewer의 읽기 전용 안내는 구현됐지만, 향후 명령 이력 화면에서도 동일한 권한 설명을 재사용하도록 공통화할 수 있다.
- Raspberry Pi Phase 0의 daemon/HCI/network/token 재연결은 통과했지만 ESP32-H2 provisioning과 0/25/50/100% 왕복, 2-node HIL은 아직 실기 검증이 필요하다.
- 자동 테스트 adapter는 `apps/gateway/test`에만 있고 양산 gateway runtime과 배포 진입점에는 포함되지 않는다.
- BLE Mesh group publication, TID cache, 모델별 group 16개 설정을 포함한 ESP32-H2 app partition 여유가 약 10%(`0x1aa90` 바이트)이므로 OTA와 추가 진단 기능을 넣기 전에 partition 크기를 재검토해야 한다.
- gateway가 acceptance 기록 직후 재시작하면 자동 재제어하지 않고 불확정 timeout으로 닫는다. 운영자 재시도 UI는 명령 이력 기능과 함께 보완해야 한다.
- API target 해석, 확정 fixture snapshot, delivery mode와 Mesh group ID/address/version 영속화, strict full retry 복구, fresh publisher fencing, outbox row 기반 pending timeout 직렬화, Gateway 병렬 unicast/group 단일 전송과 durable group state 수명주기, 신규 웹 target picker 연결까지 반영됐다.
- 자동 테스트와 ESP-IDF target build는 통과했지만 Raspberry Pi BlueZ, 실제 ESP32-H2 여러 대, 실제 MQTT broker를 연결한 group subscription, 단일 RF 전송, 지터 publication, timeout/패킷 손실 RF/HIL은 아직 수동 검증이 필요하다. 특히 조명 수 증가에 따른 Status 충돌률과 Gateway 8초 수집 timeout의 적정성은 현장 규모별로 측정해야 한다.
- `sessionStorage` 새로고침 복구와 ACK terminal 전 입력 잠금의 브라우저 계약 검증은 Task 7에서 완료했다. 격리 실백엔드 Chromium E2E에서 저장 구역 생성·수정·삭제와 개별·다중·층·구역 제어 4건의 terminal 결과를 검증했다. Raspberry Pi Gateway와 ESP32-H2를 연결한 HIL은 아직 실행하지 않았다.
- 저장 구역 생성·수정·삭제·재동기화 Web dialog와 Chromium route fixture 검증은 완료됐다. 다만 실제 Raspberry Pi/BlueZ/ESP32-H2를 연결한 zone 제어 실기는 `not_executed` 상태다. 표준 Health Fault Clear callback 실기도 Gateway 프로세스 내부에서 BlueZ node owner 권한으로 전송할 API/IPC가 없어 `not_executed` 상태이며, 두 항목 모두 자동 fixture 통과로 완료 처리하지 않는다.

## 관련 파일

- `apps/api/src/automation/automation.controller.ts`
- `apps/api/src/automation/automation.module.ts`
- `apps/api/src/automation/schedules.service.ts`
- `apps/api/src/automation/vehicle-event-rules.service.ts`
- `apps/api/src/automation/target-snapshot.service.ts`
- `apps/api/src/automation/automation-snapshot.service.ts`
- `apps/api/src/automation/dto/schedule.dto.ts`
- `apps/api/src/automation/dto/vehicle-event-rule.dto.ts`
- `apps/api/src/automation/schedules.service.spec.ts`
- `apps/api/src/automation/vehicle-event-rules.service.spec.ts`
- `apps/api/test/automation-schedules.e2e-spec.ts`
- `apps/api/test/vehicle-event-rules.e2e-spec.ts`
- `apps/api/prisma/migrations/20260830_add_vehicle_event_execution_list_index/migration.sql`
- `apps/web/src/features/control/ControlView.tsx`
- `apps/web/src/features/control/ControlTargetPicker.tsx`
- `apps/web/src/features/control/ControlView.test.tsx`
- `apps/web/src/features/control/FixtureGroupDialog.tsx`
- `apps/web/src/features/control/FixtureGroupDialog.test.tsx`
- `apps/web/src/api/fixture-groups.ts`
- `apps/web/src/api/fixture-groups.test.ts`
- `apps/web/e2e/monitoring-control-flow.spec.ts`
- `apps/api/src/commands/commands.controller.ts`
- `apps/api/src/commands/commands.service.ts`
- `apps/api/src/fixture-groups/fixture-groups.controller.ts`
- `apps/api/src/fixture-groups/fixture-groups.service.ts`
- `apps/api/src/fixture-groups/fixture-groups.service.spec.ts`
- `apps/api/src/commands/command-dispatch.service.ts`
- `apps/api/src/commands/command-status.service.ts`
- `apps/web/src/api/commands.ts`
- `apps/web/src/features/control/active-command-store.ts`
- `apps/web/src/features/control/active-command-store.test.ts`
- `apps/api/src/mqtt/mqtt.service.ts`
- `apps/api/src/mqtt/mqtt.service.spec.ts`
- `apps/api/src/mqtt/mqtt.module.ts`
- `apps/api/src/mqtt/mqtt-shutdown-coordinator.service.ts`
- `apps/api/src/mqtt/mqtt-shutdown-coordinator.spec.ts`
- `apps/api/src/mesh-control-groups/mesh-group-sync.worker.spec.ts`
- `apps/api/src/fixtures/fixture-health.ts`
- `apps/api/src/mqtt/outbox-publisher.service.ts`
- `apps/api/src/mqtt/outbox-publisher.service.spec.ts`
- `apps/gateway/src/gateway.ts`
- `apps/gateway/src/index.ts`
- `apps/gateway/src/commands/gateway-command-handler.ts`
- `packages/shared/src/command-delivery.ts`
- `packages/shared/src/gateway-contracts.ts`
- `apps/gateway/docker/mqtt-persistence.integration.mjs`
- `infra/mosquitto.production-tls.conf`
- `docker-compose.production.yml`
- `apps/gateway/src/commands/command-journal.ts`
- `apps/gateway/src/commands/gateway-command-handler.ts`
- `apps/gateway/src/mesh/bluez-mesh-adapter.ts`
- `apps/gateway/src/mesh/bluez-provisioner.ts`
- `apps/gateway/src/mesh/bluez-config-client.ts`
- `apps/gateway/src/mesh/group-subscription-handler.ts`
- `apps/gateway/src/mesh/group-state-store.ts`
- `apps/gateway/src/mesh/bluez-model-codec.ts`
- `apps/gateway/src/runtime/keyed-serial-task-queue.ts`
- `apps/api/src/mesh-control-groups/mesh-control-group.service.ts`
- `apps/api/src/mesh-control-groups/mesh-group-sync.worker.ts`
- `apps/api/prisma/migrations/20260821093000_add_mesh_control_group_member_status_version/migration.sql`
- `apps/api/prisma/schema.prisma`
- `apps/api/prisma/migrations/20260819093000_add_mesh_control_groups/migration.sql`
- `apps/api/prisma/migrations/20260819094000_extend_command_targets/migration.sql`
- `docs/runbooks/raspberry-pi-gateway-appliance.md`
- `apps/esp32-h2-firmware/main/app_main.c`
- `apps/esp32-h2-firmware/main/ble_mesh_node.c`
- `apps/esp32-h2-firmware/main/ble_mesh_platform.c`
- `apps/esp32-h2-firmware/main/control_state.c`
- `apps/esp32-h2-firmware/main/led_driver.c`
- `apps/esp32-h2-firmware/main/mesh_state.c`
- `apps/esp32-h2-firmware/main/mesh_transaction_cache.c`
- `apps/esp32-h2-firmware/README.md`
- `apps/esp32-h2-firmware/sdkconfig.defaults`
- `apps/gateway/README.md`
- `scripts/esp32-h2-build.sh`
- `scripts/esp32-h2-flash.sh`
- `apps/gateway/scripts/local-smoke-test.mjs`
- `apps/api/src/mqtt/mqtt.service.ts`
- `packages/shared/src/schemas.ts`
- `packages/shared/src/mqtt.ts`

## 갱신 규칙

제어 메뉴의 개별/그룹/스케줄/이벤트 제어 기능이 바뀌면 이 문서를 같은 작업 안에서 갱신한다.
