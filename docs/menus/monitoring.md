# 모니터링 메뉴 기능 현황

기준일: 2026-09-03

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

- 조명 등록 진행 표시는 session·scan·node 상태를 하나의 순서 상태 머신으로 파생한다. 진행 중에는 정확히 한 단계만 `aria-current="step"`이고, 선행 단계는 완료, scan/장비 등록 실패는 실제 발생 단계의 오류, 완료 session은 전체 완료로 표현한다. 서버의 `errorMessage`, 개별 등록 검증 오류와 `scanFailureMessage`는 API 값 자체를 바꾸지 않고 공통 표시 경계에서 `Gateway ACK timeout` 같은 transport 원문을 `게이트웨이 장비 응답 시간 초과`처럼 한국어로 바꾼다.
- 390px·320px commissioning 회귀는 버튼뿐 아니라 setup/Gateway claim/조명 등록의 enabled input·select·checkbox/radio associated label을 실제 clipping·occlusion을 고려한 연속 44×44px reachable area로 검증한다. 등록 form input과 select는 최소 44px이고, 18px checkbox/radio 시각 크기는 유지하되 label hit 영역을 44px 이상 제공한다.
- 1440×900, 1024×768, 390×844, 320×740 Chromium route fixture에서 지도·상세 패널 배치와 document-level horizontal overflow를 검증한다. 760px 이하의 공통 helper는 root 아래 interactive element 중 disabled/hidden, `.sr-only`/`aria-hidden`, `display`/`visibility`/`opacity`로 숨긴 조상을 제외하고 현재 viewport 및 실제 overflow clip과 교차하는 effective target을 검사한다. usable intersection을 1 CSS px 이하 cell로 나누고 각 cell 중앙 hit sample이 target 또는 그 descendant인 연속 44×44px 후보가 하나 이상일 때만 통과하며, 부분·완전 occlusion은 정상 peer가 있어도 실패한다. checkbox/radio는 모든 associated label과 input fallback 중 이 조건을 만족하는 후보를 사용한다. viewport-fixed target은 transform/filter/perspective 등 fixed containing block을 만드는 조상이 있을 때만 ancestor overflow clip을 적용한다. 이 계약으로 새로고침, 층·현장·등록 대상 select, 등록 방식 radio label, 로그아웃과 주 메뉴를 검증한다. 특히 390px와 320px에서 enabled `조명 검색 시작`·검색 실패 재시도의 actual bounding box가 44px 이상인지, 390px에서 pending setup·Gateway claim·조명 등록·reconciliation의 enabled primary/secondary action이 44px 이상인지를 route fixture로 고정한다. 밀집 도면 marker는 34px compact scale을 유지해 hit overlap을 만들지 않으며 helper에서 명시적으로 제외한다. 대신 모든 조명을 노출하는 `상세 조명 선택` select가 44px 대체 선택 경로를 제공하고 marker/selector/상세 상태를 같은 selection state로 동기화한다. 이 검증은 deterministic API fixture 기반이며 실제 Raspberry Pi/ESP32-H2 HIL 증거는 아니다.
- Calm Operations scenes 10~12는 `PageHeader`와 KPI 뒤에 `빠른 상태`, `층 도면`, `선택 조명 상세`를 같은 DOM 순서로 제공한다. `빠른 상태`의 점검 필요·실제 오프라인 button은 해당 첫 조명을 선택하며 `provisioning_waiting_state`는 오프라인 수에서 제외한다. 데스크톱은 큰 지도와 280px 흰 상세 패널을 병렬로 두고, 태블릿/모바일은 지도 뒤 상세 패널을 쌓는다.
- 선택 층 기준 전체 조명·정상·점검 필요·평균 밝기는 공통 `MetricCard`로 표시한다. KPI 열/행 계약은 1440px 4/1, 1024px 2/2, 390px 2/2, 320px 1/4이고 해당 네 viewport에서 document horizontal overflow를 자동 검증한다. 모바일의 quick-state와 상세 selector는 44px 이상 touch target으로 측정한다.
- 선택 조명 상세는 도면보다 좁은 고정 범위 패널에 배치하며 현재 밝기와 장비 사실 아래에 장애·실제 오프라인 점검 큐를 둔다. 정상·장애·오프라인·첫 상태 확인 대기는 선택 상세의 `StatusBadge`와 지도 범례에서 icon + visible text로 구분하고, compact marker도 상태별 solid/double/dashed/dotted border pattern을 함께 사용한다. marker별 상태 문구나 SVG를 1,000개까지 반복 렌더링하지 않으며 기존 한국어 접근성 이름과 선택 hit target은 유지한다.
- 모니터링 표현 계층을 개편해도 설치 guard, Gateway claim, active registration session 복구, 등록 조명이 존재할 때의 admin 등록 패널, viewer 읽기 전용 empty state는 유지한다. 일반 모니터링의 KPI·빠른 상태·지도·상세를 먼저 두고 등록 패널을 후속 영역에 둬 진행 중 등록이 정상 운영 화면을 대체하지 않는다. 등록은 여전히 실제 Gateway/BlueZ/ESP32-H2 상태와 HIL에 의존하며 Calm Operations UI를 실장비 등록 완료로 간주하지 않는다.
- Task 8에서 pending assigned admin이 `/monitoring`, `/control`, `/statistics`, 설정 하위 직접 URL로 들어오면 CustomerShell이 조회한 dashboard의 selected/default `siteId`를 유지해 `/settings?siteId=...`로 replace한다. `/settings`에서는 배정된 고객사·현장명을 읽기 전용으로 표시하고 주소·단가·층만 입력하는 최초 설치 화면을 제공한다.
- CustomerShell은 admin dashboard의 `installationStatus`가 확인되기 전에는 customer child route를 mount하지 않는다. 확인 중에는 설치 상태 loading UI를, 최초 조회 실패에는 retry UI를 표시하며 성공 setup 응답은 actual site key와 `['dashboard', 'default']` cache에 함께 반영해 실패한 background refetch가 있어도 installed guard 상태를 유지한다.
- 설치 완료 후 등록 조명이 0개인 모니터링은 admin에게 Gateway claim 또는 조명 등록 패널을 제공한다. viewer는 설치 대기 안내만 보며 claim, 등록, setup mutation UI를 볼 수 없다. operator는 customer shell을 mount하지 않는다.
- `GET /sites`는 assigned active customer `admin`의 정확히 한 현장과 유효한 `SiteMembership`을 가진 customer `viewer` 현장만 반환한다. service-provider `operator`의 고객 현장 목록은 빈 배열이다.
- `GET /sites/default/dashboard`는 접근 가능한 첫 현장을 반환하고, 접근 가능한 현장이 없을 때도 빈 dashboard shape를 유지한다.
- `GET /sites/:siteId/dashboard`, 층별 fixture 조회와 기본 에너지 추정은 `AuthenticatedUser + SiteAccessService`로 현장 read 권한을 확인한다. 다른 admin 현장, 미배정 viewer와 operator 고객 현장은 `404`로 숨긴다.
- dashboard `site`는 `customerName`, nullable `address`/`tariffKwhRate`, `timeZone`, 그리고 주소·단가·층 존재 여부에서 계산한 `pending|installed` 설치 상태를 함께 반환한다.
- assigned admin은 pending Site의 최초 주소·단가·시간대·층을 API로 완료할 수 있으며, 설치가 끝난 뒤 자기 현장의 Gateway claim과 조명 검색·등록 commissioning API를 호출할 수 있다. `POST /gateways/claim`은 정규화한 serial별 transaction advisory lock 아래 Site row 재검증, rolling failure count, terminal audit와 inventory claim을 한 decision boundary에서 처리한다. 병렬 invalid 요청은 최대 5회의 claim-code 검증만 수행하고 invalid·unavailable·already-consumed·rate-limited·success를 모두 commit한 뒤 정제된 응답을 반환하며, 다른 serial은 전역 잠금을 공유하지 않는다.
- registration session 생성은 body `siteId`, 조회·재검색·identify·개별/일괄 등록·완료는 저장된 session `siteId`의 `commission` capability를 검사한다. create/retry/register/register-batch/complete mutation은 transaction 첫 단계에서 Site를 잠그고 assigned admin을 다시 확인한 뒤 `Site -> Gateway -> Session -> Node` 순서로 잠가 재배정·비활성화된 stale admin의 session/outbox/node/complete mutation을 차단한다. get/identify는 read-only service 권한 검사만 수행한다. 기존 durable scan outbox, allocator와 provisioning 상태 전이는 그대로 유지한다.
- `GET /registration-sessions/active?siteId=...`는 현장 commission 권한을 검사하고 active 세션을 최신순으로 반환한다. 웹은 페이지 재진입과 새로고침 시 가장 최근 세션의 층, 게이트웨이, 검색 attempt와 발견 노드를 자동 복구하며 여러 세션이 있으면 사용자가 전환할 수 있다. active 조회가 끝나거나 실패 복구되기 전에는 새 검색을 시작하지 않는다.
- admin의 조명 등록 패널은 조명이 1개 이상 생성된 일반 모니터링 화면에서도 유지한다. 따라서 provisioning 완료로 dashboard 조명 수가 증가한 뒤 새로고침해도 active 세션을 완료·취소할 수 있으며 추가 조명 검색에도 같은 진입점을 사용한다.
- 로컬 실행에는 검색 결과 생성기가 없으며 Raspberry Pi/ESP32-H2가 꺼져 있으면 검색 결과 0개를 유지한다.
- ESP32-H2 unprovisioned UUID는 `DFKLED`, format version, 제품군, 모델, 하드웨어 revision과 6바이트 장치 식별자로 구성한다. Raspberry Pi Gateway는 shared parser로 현재 format의 자사 UUID만 scan 결과에 포함하고 타사 장치는 구조화 로그만 남긴다.
- 등록용 자동 이름 순번은 층별 `Floor.nextFixtureSequence`, Mesh unicast 주소는 게이트웨이별 `Gateway.nextMeshUnicastAddress`에서 소유 행 잠금 후 연속 범위로 원자 예약한다. 삭제되거나 건너뛴 값은 재사용하지 않으며 Mesh 주소는 `0x0001~0x7fff`만 허용한다.
- `POST /registration-sessions/:sessionId/nodes/register-batch`는 일괄·개별 설정을 하나의 요청으로 받고, session/node 행 잠금과 Task 5 allocator를 같은 transaction에서 사용한다. 유효한 node는 `accepted`, 존재하지 않거나 이미 처리 중인 node는 `validation_failed`로 분리해 성공한 등록을 유지한다.
- 일괄 이름은 서버가 prefix, 시작 번호, 자릿수와 예약 순번으로 생성한다. 자동 좌표는 도면 크기 또는 `1200x800` 기본 canvas 안의 기존 fixture와 겹치지 않는 행 우선 grid cell을 사용하며 이름·전력·좌표·marker 크기를 provisioning 전에 저장한다.
- 조명 등록 패널은 검색된 등록 가능 node의 개별/전체 checkbox 선택과 `일괄 설정`·`개별 설정` 전환을 지원한다. 일괄 설정은 선택 층 이름을 기본 prefix로 사용하고, 개별 설정은 조명별 이름·정격 전력·marker 크기와 선택적 좌표를 입력한다. X/Y를 모두 비우면 자동 배치하고 둘 다 입력하면 수동 배치하며 한쪽만 입력하면 해당 node에 검증 오류를 표시한다.
- 일괄·개별 등록 요청에서 서버가 수락한 node만 선택 해제하고, `validation_failed`는 오류와 선택을 유지한다. 물리 provisioning 중인 node는 재등록할 수 없으며 이후 `failed` 또는 `reconcile_required`로 확인되면 검토 대상으로 다시 선택해 node 행에 원인을 표시한다.
- Gateway는 여러 provision-device 명령을 FIFO로 직렬 처리해 BlueZ provisioning 작업이 겹치지 않게 한다. MQTT publish 오류 또는 provisioning failure event처럼 물리 적용 여부가 불명확하면 node를 `reconcile_required`로 전환하며 확인 없이 자동 재시도하지 않는다.
- `reconcile_required` 노드는 `상태 다시 확인`으로 늦게 도착한 provisioning 완료를 먼저 조회한다. 여전히 불확실하면 관리자가 장비가 미등록 또는 초기화 상태임을 확인한 뒤 `POST /registration-sessions/:sessionId/nodes/:nodeId/exclude`로 현재 세션에서만 제외할 수 있다. 이 동작은 Mesh 주소와 pending 정보를 감사 증거로 보존하며 재프로비저닝 명령을 발행하지 않는다.
- 이전 scan attempt에 남은 `provisioning/reconcile_required`도 현재 후보와 함께 복구 화면에 표시해 숨은 상태로 세션을 차단하지 않는다. 상태 재조회가 실패하면 오류를 표시하고 제외 동작을 잠근다. 여러 active 세션 중 하나를 종료하면 다음 세션을 즉시 복구한다.
- provisioning 완료 MQTT 처리는 `Session -> Node` 행 잠금 뒤 active session과 `provisioning/reconcile_required` 상태를 재검증한다. 제외·취소가 먼저 commit되면 늦은 완료 이벤트는 fixture를 만들지 않고, MQTT 완료가 먼저 commit되면 뒤따른 제외·취소가 상태 재검증에서 거부되어 명시적 운영 결정과 장비 이벤트가 경합해도 상태가 뒤집히지 않는다.
- 등록 검색은 세션별 `pending/scanning/completed/failed` lifecycle, correlation ID와 attempt를 사용한다. 신규 검색과 retry는 `pending` session과 scan-start durable outbox를 같은 transaction에서 만들며 publisher가 lease 아래 `pending -> scanning` 전이 후 발행한다. 0건은 `completed`이며, 완료/실패/발견 이벤트는 session 행 잠금과 `ProcessedGatewayEvent` 원장 transaction 안에서 site, gateway, correlation, attempt, eventId, sequence가 현재 scan과 모두 일치할 때만 반영한다. 검증된 발견 이벤트의 correlation ID와 attempt는 `DiscoveredMeshNode` create/update 양쪽에 저장해 동일 장치가 다음 attempt에서 재발견되면 최신 identity로 덮어쓴다. 늦은 발견, 중복·낮은 sequence, 이전 시도 이벤트는 무시한다.
- Gateway는 shared DFKLED UUID parser를 통과한 장치만 `scan-found` v2 topic으로 발행한다. `(sessionId, scanCorrelationId, scanAttempt)`별 0600 atomic journal은 running duplicate가 scanner를 다시 시작하지 않게 하고, terminal은 원래 eventId/sequence를 가진 동일 event로 재발행한다. restart에서 남은 running record는 새 scan 대신 정제된 failed terminal로 수렴하며, 손상·권한 오류 journal은 fail-closed 한다. application ACK를 받지 못한 terminal과 running은 retention·capacity eviction에서 제외하고, 이 보호 record 때문에 1,000개 한도를 채우면 새 scan을 fail-closed 한다. ACK를 받은 delivered terminal만 24시간 보존한다.
- `POST /registration-sessions/:sessionId/scan/retry`는 terminal scan이며 `provisioning` 또는 `reconcile_required` 노드가 없을 때만 재시작한다. gateway별 `status=active`인 `pending/scanning` partial unique 제약으로 같은 gateway의 동시 검색을 막고, 신규·retry 충돌 모두 `gateway_scan_in_progress`를 반환한다. publisher MQTT timeout은 기본 10초로 30초 lease보다 짧으며 process crash는 lease 만료 뒤 같은 attempt를 재시도한다. timeout/reject는 backoff를 증가시키고 최대 3회 또는 5분 실패는 사용자용 고정 메시지와 함께 `failed`로 복구한다.
- API provisioning scan/command outbox worker는 initial·interval batch의 transient DB 실패를 scheduler 경계에서 격리하고 worker별 single-flight로 실행한다. Mesh group sync도 single-flight로 실행하며 종료가 시작되면 다음 record/group publish를 시작하지 않는다. `MqttShutdownCoordinator`가 두 outbox worker와 `MeshGroupSyncWorker`를 멱등 drain하고, inbound MQTT listener를 분리한 뒤 진행 중 handler와 ACK publish를 모두 기다린 다음에만 `MqttService.close()`를 호출한다. Mesh subscription sync, provisioning terminal ACK와 mesh resync ACK는 PUBACK 무응답 시 10초에 packet ID를 취소해 active drain을 끝내며 timeout rejection은 payload·topic·오류 상세를 노출하지 않는 최상위 오류 경계에서 격리한다. MQTT close는 graceful `end` callback을 await하고 5초 timeout에 force close callback을 추가 1초간 기다려 영구 hang 없이 Nest module 종료를 마친다.
- scanning 또는 pending scan, 미해결 `provisioning/reconcile_required`, 등록 성공 조명 0개는 registration session 완료를 거부한다. 성공 조명이 없고 미해결 노드도 없는 terminal session은 `POST /registration-sessions/:sessionId/cancel`로 `cancelled` 종료한다. provisioning 전 identify API는 session site의 commission 권한과 404 경계를 확인한 뒤 `501 pre_provision_identify_unsupported`를 반환하며, 발견 node 상태를 바꾸거나 MQTT 명령을 발행하지 않는다.
- 웹 등록 패널은 `completed` 0건에서 검색 결과 없음과 `다시 검색`을, `failed`에서 API가 제공한 정제된 실패 메시지와 `다시 검색`을 표시한다. provisioning 전 점멸 확인 UI와 호출 경로는 제거했다.
- 등록 세션 polling은 `pending/scanning` 또는 provisioning node가 있을 때만 1.5초 간격으로 수행한다. terminal scan과 `reconcile_required`에서는 자동 polling을 중지하고 사용자가 상태를 다시 확인한다. 등록 요청 또는 서버 응답이 provisioning을 관측하면 polling을 다시 시작한다. 다시 검색 요청을 시작하는 즉시 이전 후보, 선택, 제출 상태와 개별 초안을 비우고 POST 응답은 relation이 없는 상태 전이 응답으로 취급한 뒤 canonical session GET으로 수렴한다.
- 등록 후보는 현재 scan이 `completed`이고 node의 `scanCorrelationId`와 `scanAttempt`가 session의 현재 identity와 모두 exact match일 때만 노출하고 등록할 수 있다. 서로 다른 API/Gateway wall-clock의 `scanStartedAt`과 `discoveredAt`은 attempt 판정에 사용하지 않으며, identity가 `null`인 legacy row와 이전 attempt relation은 fail-closed로 숨긴다.
- provisioning 완료를 session polling으로 관측하면 현재 층 `floor-fixtures`, `floor-map`과 해당 `registration-session`을 갱신해 등록 화면을 유지한다. 사용자가 `등록 세션 완료`를 누른 뒤 현 화면 `dashboard`와 기본/현장별 dashboard cache를 갱신해 운영 화면으로 전환한다. 새 fixture는 첫 실제 상태 전까지 기존 API 계약대로 `상태 확인 대기`로 표시한다.
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
- 층 탭은 좁은 화면에서 가로 스크롤되고, 모바일 하단 내비게이션 CSS는 `env(safe-area-inset-bottom)` 여백 계약을 적용한다. 현재 Chromium route fixture는 non-zero safe-area inset을 에뮬레이션하지 않으므로 실제 WebView inset 실측을 주장하지 않는다.
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
- `pnpm benchmark:fixtures`는 `API_BENCH_SITE_ID`, `API_BENCH_FLOOR_ID`, 실제 인증 cookie로 현장 범위 fixture API를 기본 100회 측정해 p95가 1초를 넘으면 실패한다. site/floor ID는 URL encoding하며 스크립트 계약은 `node --test scripts/benchmark-fixture-api.test.mjs`로 검증한다.
- 모니터링의 층 도면은 모든 역할에 읽기 전용으로 표시한다. 편집 버튼, editor state 조회와 editor 분기는 제공하지 않으며, 도면 변경과 version 복구는 설정 메뉴가 소유한다.
- `GET /sites/:siteId/floors/:floorId/map-snapshot`은 현장 read 권한을 확인한 뒤 지도 revision, 선택적 도면 배경과 visible 도형만 반환한다. fixture runtime 상태는 기존 cursor API가 담당하며, 배경이 없으면 `1200x800` 기본 canvas를 사용한다.
- 층 지도 snapshot은 도형을 `zIndex`, 생성 시각 순으로 고정해 반환한다. 존재하지 않거나 접근할 수 없는 층은 같은 `floor not found` 404 응답으로 처리한다.
- 웹은 `useFloorMapSnapshot`으로 선택 층의 저장된 배경과 도형을 10분마다 조회하고, 설정 에디터와 공통 `FloorMapObjectNode` geometry를 사용해 Konva scene에 읽기 전용으로 합성한다. 조명 marker는 같은 좌표계의 접근 가능한 HTML 버튼으로 표시한다.
- 모니터링 수동 새로고침은 dashboard metadata, 현재 층 fixture 페이지와 현재 층 map snapshot 세 요청을 함께 갱신하며 일부 실패 시 기존 성공 데이터를 유지한다.
- 지도 snapshot의 최초 조회가 실패하면 기본 빈 canvas를 만들지 않고 오류와 `지도 다시 시도`를 표시한다. 이전 성공 snapshot이 있는 갱신 실패는 현재 지도를 유지한 채 실패 표기와 재시도만 추가하며, 수동 갱신 실패 상태는 해당 floor ID에 귀속되어 다른 층으로 전환할 때 누수되지 않는다.
- deterministic Playwright route fixture는 0건 완료, relation 없는 retry 응답, canonical GET의 `pending -> scanning -> completed` 진행과 terminal polling 중지, 실패 메시지, 명시적 다시 검색, 등록 조명이 존재하는 상태의 active 세션 자동 복구와 최초 지도 오류 복구를 Chromium에서 검증한다. route fixture는 실제 API/DB 또는 하드웨어 검증을 대체하지 않는다.
- Task 9 격리 실백엔드 Chromium E2E는 operator의 현장/admin 발급과 customer route 차단 뒤 assigned admin이 pending setup, Gateway claim, 0건 검색·재검색, 자사 node 2개 등록과 모니터링 진입을 수행하는 새 계약을 검증했다. test support의 software MQTT publisher는 production API, 인증, claim, registration과 state-ingested ACK를 통과하고 shared `parseDfkDeviceUuid` 정본으로 invalid/타사 UUID 1개를 제외한다. 다만 실제 `apps/gateway`의 BlueZ scan/RF, production Gateway certificate principal·bootstrap·broker ACL 배포, Raspberry Pi/ESP32-H2 HIL 증거는 아니다.
- gateway scoped v2 fixture state와 heartbeat는 topic/payload/DB의 site·gateway 관계가 모두 일치할 때만 반영한다.
- v2 상태 이벤트는 영속 `eventId`와 gateway sequence를 사용하며 QoS 1 중복과 낮은 sequence 역전을 폐기한다.
- 모든 production 상태 producer는 `0700` 전용 디렉터리의 `0600` atomic durable outbox에 먼저 기록한다. 별도 manifest가 최초 생성과 운영 중 파일 소실을 구분하며 missing/corrupt/unsafe permission은 `state_outbox_missing`, `state_outbox_corrupt`, `state_outbox_permissions` health로 시작을 차단한다. 최대 `100,000건/100MiB` 용량을 예약할 수 없으면 command·scan·identify·provision RF 작업 전에 공통 gate가 fail-closed하고 `state_outbox_capacity`를 sticky 상태로 남긴다.
- 자발 Mesh publication은 한 이벤트 용량을 미리 예약한 동안에만 listener를 연다. 이벤트를 durable 저장한 뒤 다음 예약이 실패하면 listener를 닫고, application ACK로 용량이 회복되면 재구독한 뒤 강제 상태 resync를 수행한다.
- Gateway는 QoS 1 PUBACK 이후에도 exact `state-ingested` application ACK를 받기 전에는 상태 이벤트를 삭제하지 않으며 reconnect/restart 후 재전송한다. API는 이벤트 원장, 최신 Fixture 상태, 에너지 cursor/checkpoint와 일별 집계를 같은 DB transaction으로 commit한 뒤에만 `ingested`, `duplicate`, `stale_sequence`, `reverse_time`, `stale_checkpoint` ACK를 발행한다.
- gateway는 재시작 후에도 event sequence를 파일 권한 `0600`으로 이어간다. 시작 시에는 journal 추정 상태를 재발행하지 않고, 확인된 node의 AppKey/model bind/60초 publication 응답을 다시 확인·보정한 뒤 Generic OnOff, Lightness, Health 실제 상태를 조회한다.
- Gateway provisioning scan journal은 `(sessionId, scanCorrelationId, scanAttempt)` 논리 실행을 `0600` atomic file에 보존한다. process restart 시 남은 `running`은 새 물리 scan 없이 정제된 `scan-failed` terminal로 먼저 수렴한다. MQTT가 runtime listener보다 먼저 연결된 경우도 command/application ACK subscription 준비 뒤 connect recovery를 정확히 한 번 실행한다. recovery terminal publish는 기본 10초 timeout을 적용하고 connection 안의 동시 drain을 single-flight로 직렬화한다. 연결 뒤 새 terminal은 durable 저장 직후 최초 publish 결과를 기다리기 전에 scheduler를 깨우며, ACK가 없으면 1초부터 최대 30초까지 exponential bounded backoff로 같은 event를 재발행한다. idle journal은 polling하지 않는다. MQTT close는 예약 timer와 active publish를 취소하고 reconnect는 새 connection generation에서 즉시 drain을 재시작한다.
- broker PUBACK만으로 terminal을 delivered 처리하지 않는다. API는 exact terminal의 `ProcessedGatewayEvent` 생성과 `ProvisioningSession` terminal 변경 transaction이 commit된 뒤 strict `acks/provisioning/scan-terminal-ingested` ACK를 발행하고, transaction 실패 뒤 동일 event 재전달 또는 commit 뒤 ACK publish 실패에 따른 duplicate에도 commit 원장과 terminal snapshot을 확인해 ACK를 재발행한다. Gateway는 ACK의 `eventId`, `sequence`, `sessionId`, `scanCorrelationId`, `scanAttempt`가 journal terminal과 모두 일치할 때만 `deliveredAt`을 기록하고 retry timer를 정리한다. API offline, transaction 실패, ACK publish 실패에서는 journal을 유지한다. Gateway certificate의 ACK write 권한은 실제 producer topic인 `acks/acceptance`, `acks/device-status`로 제한하며 `acks/state-ingested`, `acks/provisioning/scan-terminal-ingested`는 read-only다.
- startup resync는 4개 node 제한 queue와 busy 재시도를 사용한다. 구성 성공 뒤 같은 generation의 OnOff/Lightness pair가 오면 8초 resync `observed`로 집계하고, Health Current 미관측은 `healthPending`으로 별도 집계한다. Automation terminal commit recovery의 durable pending fixture snapshot은 restart에도 복원되고 targeted queue에 seed된다. Queue는 최대 4,096개를 coalesce하고 64개씩 조회하며, 각 targeted/full pass 뒤 실제 관측으로 해제되지 않은 source ID를 회전된 capacity window로 다시 채운다. 따라서 선두 영구 offline fixture의 fence는 유지되지만 capacity 밖 정상 fixture도 starvation 없이 관측 기회를 얻는다. Full error와 `timedOut`/`failed` report도 250ms~30초 capped backoff rerun을 예약한다. Pending transition/fence는 실제 OnOff/Lightness 관측이 durable state에 반영될 때까지 남고, shutdown은 retry timer와 현재 signal을 취소한 뒤 5초 안에 drain한다. `meshResync` health field와 구조화 log는 lighting pair가 전혀 없거나 전송이 모두 실패한 경우에만 unhealthy를 유지하며, 이후 heartbeat만으로 이를 healthy로 덮지 않는다. 늦은 Health Current publication은 pending을 회복한다. reconnect가 겹쳐도 하나의 resync만 수행하며, 응답이 없는 경우에는 offline 이벤트를 만들지 않는다.
- BlueZ model status는 부분 관측으로 취급한다. Generic OnOff, Lightness, Health Current 실제 관측이 같은 generation의 65초 coherence window 안에 모두 모일 때만 fixture-state snapshot을 발행한다. 새 resync와 단일 model update는 새 generation을 시작하므로 Health-only, 역순, 누락 또는 stale counterpart가 밝기 `0`, power-off, online 상태로 DB를 오염시키지 않는다.
- BlueZ 자발 status는 확인된 primary unicast address가 fixture mapping과 일치할 때만 처리한다. Health Current Fault(`0x04`)만 operational fault로 반영하며, Current를 실제 관측하기 전에는 online/fault snapshot을 확정하지 않는다. Registered Fault(`0x05`)와 no-fault byte `0x00`는 장애 상태를 만들지 않는다. gateway는 assignment의 site/gateway 범위를 payload에 주입해 MQTT v2 fixture-state로 발행하고, unknown address는 폐기한다.
- gateway는 Health Current의 숫자 fault code와 실제 관측 시각을 MQTT v2 `health` 객체로 전달한다. API는 `0x00` 제거, 중복 제거와 정렬 후 `Fixture.healthFaultCodes`, `Fixture.healthLastSeenAt` 최신 snapshot에 저장하며 Health가 없는 명령 결과 이벤트는 기존 snapshot을 지우지 않는다.
- 층별 fixture API와 dashboard는 Health snapshot을 `{ faultCodes, observedAt }` 또는 `null`로 반환한다. fault가 하나라도 있으면 조명 상태와 제어 가능 여부를 장애로 취급하고, 모니터링 상세 패널은 `정상`, `장애 (fault code)`, `확인 대기`와 Health 수신 시각을 표시한다.
- ESP32-H2의 application-driven Sensor Status는 shared publication buffer가 아니라 pinned ESP-IDF v5.5.1의 repository-patched server-send 경로를 사용한다. Payload/context를 API thread에서 all-or-nothing snapshot하므로 allocation/envelope/queue-post 실패는 handler 실행 없이 동기 오류가 되고, queue 수락 후에는 기존 BTC handler가 두 snapshot을 한 번 해제한다. 연속 current/recovery Status는 호출별 snapshot을 보존하며 Gateway가 설정한 NetKey/AppKey, publication address, TTL, credential, SZMIC를 사용한다. Stack period/retransmit가 `0`이 아니면 firmware readiness가 fail-closed하므로 잘못된 Config에서 상태 전송을 시도하지 않는다.
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

- pending redirect와 admin commissioning은 React/Vitest 회귀와 Task 9 격리 실백엔드 Chromium E2E로 검증했다. Calm Operations 모바일 390px/320px의 화면 계층·overflow·touch target은 route fixture로 검증했지만, 실제 WebView safe-area와 재설치는 별도이며 Raspberry Pi/ESP32-H2 HIL은 아직 실행하지 않았다.
- 모니터링 화면은 10분 snapshot 정책이므로 publication 반영 직후 확인이 필요하면 사용자가 수동 새로고침해야 한다.
- durable state outbox의 파일 권한·용량 차단과 application ACK 재전송은 자동 테스트로 검증했지만, 실제 broker/API 재시작과 Raspberry Pi 전원 차단을 포함한 HIL은 아직 실행하지 않았다.
- Health 정보는 최신 Current snapshot만 보존하며 fault 이력, 발생 횟수와 해제 이력은 명시적 보류 범위다.
- 조명 provisioning 진행 상태는 session polling으로 반영하고, 사용자가 등록 세션을 완료할 때 dashboard query를 갱신한다. WebSocket/SSE push는 명시적으로 보류한다.
- gateway offline 기준은 현재 90초, fixture stale 기준은 180초(60초 publication 3회 window) 고정값이다. 대규모 현장 검증 후 site/gateway별 정책 설정으로 분리해야 한다.
- `lastSeenAt` 상대 시간은 클라이언트 현재 시간 기준이므로 서버 기준 freshness와 완전히 일치하지 않을 수 있다.
- RSSI, hop count, 명령 성공률은 표시만 하며, 품질 등급이나 설치 가이드로 연결되지 않는다.
- 1,000개 marker 조회/렌더링 기준은 자동 검증하지만, 더 큰 현장에는 공간 클러스터링과 검색이 추가로 필요하다.
- 자사 UUID 검색, batch 등록, 실제 Health Current 수집을 포함한 Raspberry Pi/ESP32-H2 실장비 HIL은 아직 실행하지 않았다. 자동 route fixture 통과를 검색·등록·상태 수집의 실기 완료로 간주하지 않는다.
- Sensor server-send breaker는 actual patched source allocator fault harness와 fullclean target compile로 검증했다. 실제 device heap pressure, BTC queue saturation과 Sensor Status RF 전달은 HIL에서 확인해야 하며 software allocation test를 실장비 완료로 간주하지 않는다.
- 현재 선택 로직은 첫 장애 조명 또는 첫 조명을 자동 선택하므로, 사용자가 이전에 보던 조명을 유지하는 정책을 더 정교하게 만들 수 있다.
- 등록 패널은 `pending/scanning` 또는 provisioning 중에만 1.5초 registration session polling으로 결과를 반영한다. `reconcile_required`의 서버 상태 재조회, 명시적 제외와 세션 취소는 구현했지만 장비가 실제로 provisioned 되었는지 Gateway/BlueZ에 질의하고 자동 정리하는 기능은 없다. 현장 관리자가 장비를 확인·초기화하지 않은 채 제외하면 안 되며 이 절차는 Raspberry Pi/ESP32-H2 HIL로 검증해야 한다.
- scan lifecycle 자동 테스트는 mock MQTT와 scanner adapter를 사용한다. 실제 host Mosquitto mTLS negative ACL integration에서 Gateway CN certificate의 `acks/state-ingested`, `acks/provisioning/scan-terminal-ingested` publish 거부를 확인했다. Docker 전용 broker persistence 재시작 test는 현재 로컬 Docker daemon 부재로 skip됐다. 실제 Raspberry Pi BlueZ adapter의 scan timeout, broker/Pi/API 재시작을 가로지르는 terminal application ACK 재전달, ESP32-H2 자사 UUID 필터와 terminal event 전달은 HIL에서 별도로 확인해야 한다.

## 관련 파일

- `apps/web/src/features/transport-copy.ts`
- `apps/web/src/features/transport-copy.test.ts`
- `apps/web/src/components/ui/MetricCard.tsx`
- `apps/web/src/components/ui/PageHeader.tsx`
- `apps/web/src/components/ui/StatusBadge.tsx`
- `apps/web/src/components/ui/FeedbackState.tsx`
- `apps/web/src/features/monitoring/MonitoringView.tsx`
- `apps/web/src/features/monitoring/FloorMap.tsx`
- `apps/web/src/features/floor-map/FloorScene.tsx`
- `apps/web/src/features/registration/RegistrationPanel.tsx`
- `apps/web/src/features/registration/RegistrationPanel.test.tsx`
- `apps/web/src/features/registration/FixtureBatchForm.tsx`
- `apps/web/src/features/registration/FixtureIndividualForm.tsx`
- `apps/web/src/api/registration.ts`
- `apps/web/e2e/monitoring-control-flow.spec.ts`
- `apps/web/e2e/calm-operations-monitoring.spec.ts`
- `apps/web/e2e/layout-assertions.spec.ts`
- `apps/web/e2e/support/layout-assertions.ts`
- `apps/web/e2e/support/settings-api.ts`
- `apps/web/playwright.config.ts`
- `apps/web/src/api/queries.ts`
- `apps/api/src/sites/sites.controller.ts`
- `apps/api/src/sites/sites.service.ts`
- `apps/api/src/access/site-access.service.ts`
- `apps/api/src/fixtures/fixtures.service.ts`
- `apps/api/src/fixtures/fixture-health.ts`
- `apps/api/src/mqtt/mqtt.service.ts`
- `apps/api/src/mqtt/mqtt.service.spec.ts`
- `apps/api/src/mqtt/mqtt.module.ts`
- `apps/api/src/mqtt/mqtt-shutdown-coordinator.service.ts`
- `apps/api/src/mqtt/mqtt-shutdown-coordinator.spec.ts`
- `apps/api/prisma/schema.prisma`
- `apps/api/prisma/migrations/20260826170000_add_discovered_node_scan_identity/migration.sql`
- `apps/api/src/mqtt/provisioning-scan-outbox-publisher.service.ts`
- `apps/api/src/mqtt/provisioning-scan-outbox-publisher.service.spec.ts`
- `apps/api/src/mesh-control-groups/mesh-control-group.service.ts`
- `apps/api/src/mesh-control-groups/mesh-group-sync.worker.ts`
- `apps/api/src/mesh-control-groups/mesh-group-sync.worker.spec.ts`
- `apps/gateway/src/mesh/bluez-mesh-adapter.ts`
- `packages/shared/src/gateway-contracts.ts`
- `apps/api/src/registration/registration-allocation.service.ts`
- `apps/api/src/registration/registration.service.ts`
- `apps/api/src/registration/registration.controller.ts`
- `scripts/benchmark-fixture-api.mjs`
- `scripts/benchmark-fixture-api.test.mjs`
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
- `apps/gateway/docker/mqtt-persistence.integration.mjs`
- `apps/gateway/src/runtime/serial-task-queue.ts`
- `apps/gateway/src/identity/certificate-rotation.ts`
- `apps/gateway/src/health/appliance-health.ts`
- `apps/gateway/docker/healthcheck.sh`
- `apps/esp32-h2-firmware/patches/esp-idf-v5.5.1-server-send-ownership.patch`
- `apps/esp32-h2-firmware/patches/esp-idf-v5.5.1-server-send-ownership.conf`
- `apps/esp32-h2-firmware/test/native/test_esp_idf_server_send_boundary.sh`
- `apps/esp32-h2-firmware/test/native/test_esp32_h2_idf_patch_gate.sh`
- `scripts/esp32-h2-idf-patch.sh`
- `scripts/esp32-h2-build.sh`
- `scripts/esp32-h2-artifact-audit.sh`
- `infra/mosquitto.acl.example`
- `scripts/dev-runtime.mjs`
- `packages/shared/src/schemas.ts`
- `packages/shared/src/product-identity.ts`
- `packages/shared/src/mqtt.ts`

## 갱신 규칙

모니터링 메뉴의 UI, API, DB, MQTT, 실제 gateway, 펌웨어 계약이 바뀌면 이 문서를 같은 작업 안에서 갱신한다.
