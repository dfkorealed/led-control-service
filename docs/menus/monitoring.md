# 모니터링 메뉴 기능 현황

기준일: 2026-09-18

## 확정 구현 범위

- 조명 검색 결과에서 여러 장치를 선택한 뒤 일괄 또는 개별 정보를 설정할 수 있게 한다. 일괄 설정 이름은 층별 prefix와 서버가 원자 예약한 순번으로 자동 생성한다.
- ESP32-H2 firmware device UUID의 자사 namespace를 검증해 자사 제품만 검색 결과와 provisioning session에 반영한다.
- 설정 에디터에서 저장한 도면 배경, 도형, 텍스트, 색상과 조명 위치를 동일한 Konva renderer로 읽기 전용 표시한다.
- 도면 배경은 DB에 공개 URL을 저장하지 않고 인증된 `/api/floors/{floorId}/assets/{assetId}/content` 경로로 조회한다. API는 현장 read 권한을 확인한 뒤 300초 signed GET으로 연결하며 pending·타 현장·삭제 자산은 표시하지 않는다.
- 장비 상태는 BLE Mesh Health Current의 현재 fault만 수집하고 통신 품질 평가는 확장하지 않는다.

상세 계약은 `docs/superpowers/specs/2026-08-19-monitoring-control-focused-completion-design.md`를 따른다.

## 명시적 보류 범위

- WebSocket/SSE push
- RSSI, hop count, 명령 성공률 기반 통신 품질 고도화
- 장애 escalation/SLA 등급, 외부 ticket 연결과 production notification 전송. 장애 이력·담당자·조치 workflow 자체는 P1에서 구현했다.
- 통신 음영 heatmap, 차량 감지, 이벤트 타임라인, gateway coverage와 빠른 제어
- 자동 HIL 판정. 실제 하드웨어 검증은 수동으로 수행한다.

## 구현 완료

- 2026-09-17 공통 `FloorMapViewport`의 pinch는 시작 시 지도 좌표를 현재 두 손가락 중점에 맞춰 확대와 평행 이동을 함께 반영한다. 실제 지도 bounds와 눌림 상태를 사용하는 synthetic Chromium 회귀는 pan/select/area 모두에서 비대칭 pinch, 두 손가락 이동과 한 손가락 해제 후 jump 방지를 확인한다. `FloorScene` coarse marker는 48px hit target의 반지름만큼 가장자리 중심을 보정해 도면 경계에서 터치 영역이 잘리지 않도록 했다. 모니터링의 단일 선택 및 20px 시각 dot 계약은 유지하며 실제 iOS/Android WebView와 Gateway/조명 HIL은 별도 검증이다.

- 2026-09-17 모니터링은 공통 `FloorMapViewport`를 사용하고, 기존 읽기 전용 `FloorScene`에 명시적인 `single` selection adapter를 전달한다. 따라서 marker와 `상세 조명 선택`의 단일 선택·상세 패널 동기화 의미는 바뀌지 않았다. viewport는 wheel 확대, pointer pan과 모든 interaction mode의 두 손가락 pinch를 제공한다. pointer capture로 지도 밖 이동도 추적하지만 marker button은 단일 pointer gesture를 시작하지 않아 native marker click을 보존한다. marker는 시각 20px dot과 별도 44px coarse hit target을 유지한다.

- 2026-09-17 지도 viewport의 fit·pan·Ctrl/Cmd+wheel 배율·zoom control을 재사용 가능한 `FloorMapViewport`로 분리했다. 모니터링은 기존 읽기 전용 `FloorScene`, marker 단일 선택, 범례와 안내를 어댑터로 유지한다. 모바일의 pan/select/area 상호작용은 모두 두 touch pointer의 중점에 고정한 pinch zoom을 제공하며, pinch는 진행 중인 pan/영역 선택을 취소하고 남은 touch가 갑자기 이동하지 않도록 one-pointer gesture로 이어지지 않는다. 확대 지도 overflow는 viewport 내부에만 두고 0.1~4 배율과 층 변경 시 100% 화면 맞춤을 유지한다. `FloorMapViewport`·gesture·모니터링 집중 Vitest 21개와 인접 모니터링/scene 61개, web typecheck를 통과했다. 이는 jsdom의 포인터 회귀 검증이며 실제 모바일 WebView gesture 및 현장 도면 시각 QA는 후속 확인이 필요하다.

- 2026-09-16 Tailwind Task 12에서 공통 primitive와 모니터링 화면의 legacy class/CSS adapter를 제거하고 의미 토큰·utility 및 `data-*` 테스트 계약으로 수렴했다. 정책 baseline은 빈 violation map을 사용하며 1440/1024/390/320px 가로 overflow 계약을 canonical 회귀에 포함한다. Fresh Web **1,224/1,224**, UI policy **53/53**, 전체 Chromium 직렬 **257 passed·5 환경 의존 skip·실패 0**을 통과했다. 자동 Chromium·mock API 기반 소프트웨어 증거이며 실제 iOS/Android WebView, 현장 도면, Raspberry Pi/BlueZ/ESP32-H2 HIL은 실행하지 않았다.

- 2026-09-16 공통 셸·인증 UI 이전에서 모니터링 진입 셸의 내비게이션, 현장 배지, 로딩·복구 상태와 로그아웃을 Tailwind 의미 토큰 및 공통 `Heading`/`Text`/`FeedbackState`/`ConfirmDialog`로 통합했다. 저장하지 않은 맵 편집 내용이 있으면 `window.confirm` 대신 접근 가능한 `alertdialog`에서 취소 시 원래 로그아웃 버튼으로 초점을 복원하고, 승인 후에만 draft와 session을 정리한다. 관련 Vitest 157개와 320/390/1024/1440px Chromium 셸·인증·복구 시나리오 19개로 검증했으며, 이는 mock API 기반 browser 회귀로 Raspberry Pi·Gateway·ESP32-H2·조명 실장비 HIL 완료를 뜻하지 않는다.
- 설정이 소유하는 조명 검색·등록과 맵 편집 화면을 공통 React Aria/Tailwind UI로 이전하면서 기존 등록 상태·payload와 모니터링 캐시 동기화 계약을 유지했다. 이미 등록된 장비는 등록 가능 목록에서 분리하고 새 장비만 선택·제출하며, 저장한 네모·세모·선·텍스트와 조명 위치는 모니터링의 읽기 전용 `FloorScene`에 즉시 반영한다. Konva의 정적 렌더링 색상은 `themeColor` 의미 토큰을 사용하고 저장 좌표·viewport·배율만 runtime geometry 예외로 유지한다. 이 범위는 deterministic Vitest/Chromium 회귀이며 Raspberry Pi·ESP32-H2·LED 실장비 HIL 완료를 뜻하지 않는다.
- 모니터링 화면을 공통 Tailwind 디자인 시스템으로 이전했다. 맵·조명 선택은 공통 `SelectBox`, 새로고침·지도 배율 제어와 공간 조명 마커는 공통 `Button`/`IconButton`, 로딩·오류·빈 상태는 `FeedbackState`, 요약은 `MetricCard`, 상세 상태는 `StatusBadge`, 제목·본문은 `Heading`/`Text`를 사용한다. 저장 도형과 조명 위치는 기존 공통 `FloorScene` 렌더러를 유지하고, 조명 밝기와 빛 번짐은 `fixture-brightness-1..10`·`fixture-marker` 의미 토큰으로 표시한다. 지도 및 마커의 저장 좌표·측정 viewport·줌 배율처럼 실행 중 계산되는 값만 inline geometry 예외로 남긴다.

- BIO direct-USB Gateway의 상태 판정은 transport 연결, protocol 준비, durable mapping 유효성, MQTT 연결, heartbeat freshness가 모두 참일 때만 healthy다. 외부 health 응답에는 adapter 종류와 boolean 상태만 포함하고 USB 경로·descriptor·장치 UUID·raw protocol payload·인증정보는 노출하지 않는다. BIO sensor cloud source는 지원하지 않으므로 빈 목록을 반환하고 configure/send는 명시적으로 실패한다. 전용 배포는 exact-one USB 장치와 숫자 GID를 host/container 양쪽에서 재검증하며 BIO 프로세스에 D-Bus/HCI/BlueZ를 제공하지 않는다.

- P1 Task 1 서버 계약: `GET/PATCH /sites/:siteId/monitoring-policy`는 read/manage capability와 `expectedUpdatedAt`을 적용해 gateway 만료 `30~900`초(기본 90), fixture stale `60~3600`초(기본 1,200)를 저장한다. 변경 충돌은 `409 MONITORING_POLICY_CONFLICT`다. 기존 장비 제어·등록의 90초 안전성 기준은 별도로 유지한다.
- `MonitoringIncident`는 네 유형(`gateway_offline`, `fixture_stale`, `fixture_fault`, `command_failed`)의 발생·확인·담당·해결을 저장한다. Task 2의 30초 freshness sweep은 조건을 자동 수집해 active incident를 생성·갱신하고 조건 회복 시 `automatic_recovery`로 자동 해결한다. 목록 API는 활성 우선 최신순, 현장·필터에 바인딩된 cursor와 최대 100건 limit, 대상·사용자 요약을 제공한다. 관리자는 open 확인, active 담당 지정/해제, 복구 확인 뒤 메모와 수동 해결을 수행한다. 장애 지속은 `409 INCIDENT_STILL_ACTIVE`, 이전 revision은 `409 INCIDENT_CONFLICT`이며 모든 성공 변경은 같은 transaction의 감사 로그로 남긴다.
- 2026-09-13부터 사용자용 모니터링 SidePanel은 탭 없이 선택 조명의 상태·밝기·장비 정보만 표시한다. `인시던트 {활성 건수}`, 인시던트 이력·필터·조치와 `판정 기준` UI를 제거했으며, 모니터링 route는 인시던트·현장 사용자 API를 요청하지 않는다. 서버의 자동 장애 판정, 이력 저장과 관리 API는 내부 운영 기반으로 유지한다.
- P1 Task 5의 cached dashboard/fixture/map 복구 계약은 유지한다. background 부분 실패에도 기존 KPI·도면·선택 층/조명·지도 배율을 보존하고, 더 최신 성공 응답에서 해당 source 경고만 해제한다. 정지한 browser clock의 60,000ms fresh/60,001ms stale 경계와 네 장애 원인의 selector·marker·badge·상세 원인·권장 조치 일관성도 유지한다.
- 수동 해결의 현재 장애 판정은 `Site → Gateway → Fixture → Incident` 순서 잠금 아래 다시 읽는다. Gateway는 heartbeat 변경을 막으면서 상태 수집의 FK 검사를 허용하는 `FOR NO KEY UPDATE`를 사용한다. fixture stale 판단에 영향을 주는 연결 Gateway heartbeat도 해결 commit까지 고정하며, 잠금 대기 중 소유 Gateway가 바뀌면 `409 INCIDENT_TARGET_CHANGED`로 재조회를 요구한다.
- Gateway heartbeat와 조명 상태 수신은 원장과 compact watermark를 같은 transaction에 저장한다. 원장 삭제 후에도 최신 조명 상태의 exact duplicate와 payload 충돌을 구분하고 낮은 sequence로 snapshot/적산이 되돌아가지 않는다. 임시 PostgreSQL 검증이며 실장비 결과는 아니다.
- 플랫폼 Task 4 최종 소프트웨어 검증은 root lint/typecheck/build exit 0, root script 58/58·Shared 203·Automation 28·Mobile 1·Web 64 files 712/712·API 120 suites 1,138 통과/289 환경 의존 제외·Gateway 64 files 608/608(총 2,748 통과/289 제외)다. 전체 Chromium은 194개 중 189 통과/5 opt-in 제외(188개 mock/브라우저 회귀 + 실제 disposable automation journey 1개), main 319.19 kB/gzip 99.21 kB다. Production 계약 18/18, 전체 audit의 MQTT 설정 2/2·Gateway container 24/24·required MQTT 2/2와 새 smoke `led-production-smoke-a9dac54a523c9484dbc4b9eade7b9d5e`의 당시 브랜치 빈 DB 57/57 migrations, TLS/mTLS·CRL·장애 복구·exact cleanup을 통과했다. Dependency 820개 중 기존 승인 예외 High 2/Moderate 1, unexpected 0이며 무취약 판정이 아니다. 운영 배포·사용자 DB·실제 외부 Vault/MQTT/Object Storage·native WebView·HIL·외부 관측 연결은 미검증이다. [운영 runbook](../runbooks/production-api-web-deployment.md)에 절차와 한계를 기록했다. 최종 독립 검토는 Critical/Important/Minor 0, PASS로 승인됐다.

- 플랫폼 Task 3에서 공통 앱 셸 복구를 구현했다. 초기 인증 401은 기존 로그인, 403과 그 밖의 비일시 오류는 권한·재로그인 안내로 분기한다. 브라우저가 부팅부터 offline이면 요청 없이 서비스 복구 화면을 표시하고 online 복귀 시 인증을 재개한다. 네트워크·전송 timeout·5xx는 자동 최대 2회 재시도하고 실패하면 `다시 시도`로 연결을 복구한다. `AppRoot`의 boundary는 App 자체의 hook/render와 Router/lazy shell 실패를 단일 main·alert·포커스 heading으로 표시한다. 인증 실패·재로그인·principal 전환 시 새 QueryClient를 먼저 활성화해 늦은 이전 mutation callback을 폐기된 client에 격리한다. 재로그인은 앱 active-command namespace와 tenant/auth 캐시·초안을 정리하고 최대 5초 logout 종료 뒤 로그인으로 수렴한다. 무관한 저장값과 최초 정상 부팅의 제어 복구 기록은 유지하며 원시 오류/응답/stack은 표시하지 않는다. Task 3 Web 64 files·712/712 unit, 관련 auth/shell Chromium 23/23(신규 복구 10개 포함), typecheck/build와 main `319.19 kB`/gzip `99.21 kB` bundle audit를 통과했다.

- Route 기능 코드 SHA `34261b6`에서 로그인·최초 비밀번호 변경은 초기 main에 유지하고 고객/운영자 shell과 모니터링 화면을 dynamic chunk로 분리했다. 역할 shell 전체 화면과 shell 내부 route는 공통 `RouteLoadingState`의 `role="status"`·`aria-live="polite"` 로딩 상태를 사용한다. 별도 Web route bundle 작업 당시 Task 4 Web 검증은 60 files·686/686 unit, 2,437 modules production build와 main `314.83 kB`/gzip `97.58 kB`(예산 `1,070.00 kB`/`325.00 kB`)를 통과했고, 14개 계획 route chunk와 main의 Konva·Recharts 격리를 audit으로 확인했다. 같은 별도 작업 당시 Task 3 Chromium 64/64는 1440/1024/760/390/320px에서 모니터링을 포함한 대표 route 전환을, disposable RealBackendLab 2/2는 실제 API/DB 기반 고객 여정을 검증했다.
- 공통 고객 셸 상단은 현재 메뉴 제목과 실제 현장명 배지만 표시한다. 기존 층명 기반 `B2 주차장` 표기와 동작 없는 Gateway 정상·오프라인·미등록 상태 배지는 제거하되 설정의 `Gateway 상태` 상세 카드는 유지한다. 로그아웃 위치와 인증·dirty editor 확인 로직은 유지하고, 고객·운영자 셸의 로그아웃은 공통 `IconTooltipButton`으로 아이콘만 표시한다. `로그아웃` 도움말은 hover와 키보드 focus에서 열리고 도움말 위로 포인터를 옮겨도 유지되며 `Escape`로 닫힌다. 모바일 버튼은 52px 실제 터치 영역을 사용한다.
- 현장 일반 유저의 `read`와 `control` capability는 모두 모니터링 메뉴와 해당 현장 dashboard 조회를 허용한다. 신규 일반 유저는 임시 비밀번호로 최초 로그인한 뒤 전용 강제 변경 화면을 완료해야 모니터링으로 진입한다. mock Chromium은 read/control/admin의 주 메뉴 exact 범위와 강제 변경 전 보호 API `403`을 검증한다. 격리 PostgreSQL/API Chromium은 실제 `403 PASSWORD_CHANGE_REQUIRED`, 변경 후 read 메뉴, `/settings/users` 직접 접근 차단, 비활성 세션의 다음 보호 요청 `401`과 재로그인 거절을 검증했다. Gateway나 ESP32-H2를 사용한 검증은 아니다.

- 설정에서 실행하는 테스트 데이터 도구가 `VITE_TEST_DATA_TOOLS_ENABLED=true`일 때만 `POST/DELETE /test-data/sites/:siteId`를 사용해 층별 marker Gateway 1개와 MeshNode/Fixture 200개씩을 생성·삭제한다. 생성은 idempotent하며 `led-control-test-data/v1/`과 `[TEST DATA] Fixture `를 도구 전용 예약 namespace로 사용한다. 삭제는 Gateway·MeshNode·Fixture marker chain이 모두 일치하는 테스트 데이터만 대상으로 하므로 실제 장비 데이터는 보존된다. 예상하지 않은 종속 데이터가 marker 장비 또는 조명에 연결돼 있으면 삭제는 `409`로 전체 거부된다. 의존성 조회 전에 검증된 fixture ID를 정렬 잠금해 동시에 수집된 분석 이력도 보존하며, 생성·재실행은 공통 energy 서비스의 bulk 처리로 누락 identity/current dimension을 보충하고 동일 이력을 중복 생성하지 않는다. 생성 직후 recent online이더라도 실제 heartbeat가 없으면 freshness 정책으로 offline 전환될 수 있다. 이 데이터는 실장비/MQTT 시뮬레이션이 아니며 DB schema/migration 변경도 없다.

- 신규 등록은 지도 공간과 무관하게 미배치로 생성한다. 목록/개수/제어/전력 집계에서는 유지하고 지도 마커만 제외한다. 등록 조명은 있으나 배치가 없을 때 `배치된 조명이 없습니다`와 설정 편집 진입을 제공하며, 등록 0개 안내와 구분한다. 기존 조명 좌표는 migration으로 보존한다. 두 층 실제 API/DB 브라우저 E2E에서 저장 전/후 및 배치 해제 후 마커 분리를 검증했다.

- 실장비 검색 완료 이벤트와 Gateway application ACK를 API의 직접 MQTT publish 성공 여부에 결합하지 않는다. API는 검색 terminal 상태·중복 방지 원장·ACK용 `MqttOutbox`를 같은 DB transaction에 저장한 뒤 broker PUBACK을 반환하고, 별도 outbox worker가 연결 복구 후 ACK를 재전송한다. 따라서 ACK 전송 중 일시적인 MQTT 연결 종료가 persistent session을 막아 이후 provisioning 명령까지 `Connection closed`로 실패시키지 않는다. 같은 terminal event 재전달은 기존 ACK outbox를 재활성화하며 payload identity 충돌은 fail-closed 한다.
- 2026-09-03 Raspberry Pi/ESP32-H2 HIL에서 자사 UUID 한 건 검색, `0x0100` provisioning, `B2-L002` Fixture 생성, B2층 `0xC000` Mesh group subscription version 2 적용과 application ACK 발행을 확인했다. 등록 완료 직후 첫 `fixture-state` publication 전에는 `offline`을 `상태 확인 대기`로 표현하는 기존 계약을 유지한다.
- BIO 장치는 표준 BLE Mesh 장치와 달리 등록 뒤 자발적인 `fixture-state`를 발행하지 않는다. Gateway는 confirmed UUID/native UUID/address mapping만 10분마다 한 번 scan한 뒤 high-brightness GET과 control-mode GET을 직렬로 수행하고, 둘 다 같은 장치로 검증된 경우에만 `fixture-presence`를 발행한다. 이 polling은 GET만 사용하며 주소·밝기·모드를 바꾸지 않는다. read-only capability 확인 뒤에는 `BioDongleClient` 원본 객체를 그대로 호출해 `this`에 결속된 scan cache와 USB operation queue를 보존한다. 메서드 참조를 임시 객체에 복사해 실제 GET 전에 TypeError가 나던 receiver 분리 회귀는 전용 테스트로 차단한다. API는 presence 수신 시각을 freshness 근거로 쓰되 실제 `fixture-state`와 분리해 저장한다. 센서 모드의 실제 밝기와 전원 여부는 여전히 알 수 없으므로 설정값을 순간 출력으로 표시하지 않으며, `brightness=0`, `powerOn=null`은 첫 수동 제어 read-back 전 실제 소등을 뜻하지 않는다. 일반 BLE Mesh의 `provisioning_waiting_state` 계약은 변경하지 않는다.
- BIO의 첫 수동 제어는 polling에서 읽은 sensor용 high-brightness 설정을 현재 출력으로 재사용하지 않는다. Gateway가 실제 SET과 두 GET read-back을 검증한 뒤에만 force mode의 밝기·전원 상태를 자동화 기준과 `fixture-state`로 저장하므로, 등록 직후 모니터링 값이 비어 있어도 제어는 시작할 수 있고 실패한 명령이 가짜 현재 밝기를 만들지 않는다.
- 2026-09-02 무장비 회귀 점검에서 등록 API도 Web과 동일하게 `scanStatus=completed`, non-null correlation ID와 attempt의 exact match를 강제한다. 따라서 이전 검색 시도나 identity가 없는 legacy 발견 행을 요청에 직접 넣어도 provisioning 대상으로 수락하지 않는다.
- 조명 목록의 최초 로딩·층 전환 로딩·최초 오류를 빈 조명 0개 상태와 분리한다. 기존 데이터가 있는 갱신 실패는 지도와 KPI를 유지하면서 오류 및 재시도를 표시하고, 지도 snapshot 로딩도 `등록된 층 없음`과 구분한다. 상단의 운영 현황 제목과 자동 갱신 설명은 제거하고 `맵 선택` 문구 옆 SelectBox와 우측 끝 수동 새로고침을 제공한다.
- P1 Task 3 Web은 dashboard, 선택 층 fixture page, map snapshot을 10분 polling·10분 staleTime·focus refetch·2회 retry로 조회한다. map snapshot이 수동 또는 background 갱신에서 최종 실패하면 해당 query만 30초 뒤 자동 복구를 시도하고, 성공하면 정상 10분 주기로 복귀한다. dashboard와 fixture page의 polling 주기는 이 복구 정책의 영향을 받지 않는다. cached dashboard/fixture/map의 background 실패는 현재 지도·층/조명 선택을 지우지 않고 persistent stale banner와 재시도로 표시한다. 지도 실패 표시는 실패 당시 같은 층의 `dataUpdatedAt`을 기준선으로 저장해 cached observer 상태 변화에는 유지하고, 더 최신 성공 응답에서 지도 경고와 지도 source의 toolbar 오류만 자동 해제한다. 다른 층의 실패 상태는 현재 층 경고에 섞지 않는다. 현장에 층이 없으면 floor fixture/map query는 비활성 상태이므로 해당 loading/error/stale 안내를 만들지 않는다. 선택 층의 모든 fixture page `generatedAt` 중 가장 오래된 유효 시각이 60초를 초과하면 stale이며, 경계 60초는 정상이다. `마지막 갱신`은 React Query 수신 시각이 아니라 그 서버 ISO를 표시하고 미래/잘못된 snapshot은 `시간 차이 확인` 또는 안전 경고로 표시한다. `provisioning_waiting_state`, gateway offline, fixture stale, command failed, Health fault/fault, online, generic offline은 공통 presenter를 통해 selector, marker 접근성 이름, badge, 상세 원인·권장 조치에서 같은 문구를 사용한다.
- Dashboard 요약은 저장된 fixture status뿐 아니라 최신 Health Current fault를 합성한 최종 상태로 정상·장애 수를 계산한다. `includeFixtures=false` 요약도 같은 규칙을 사용하며, 주기적 freshness DB 갱신 실패는 정제된 오류 코드만 기록하고 다음 주기를 계속 실행한다.
- 조명 등록 진행 표시는 session·scan·node 상태를 하나의 순서 상태 머신으로 파생한다. active workflow는 오류가 없는 동안 정확히 한 단계만 `aria-current="step"`이고, 선행 단계는 완료, scan/장비 등록 실패는 실제 발생 단계의 오류로 표현한다. `completed`는 전체 완료, `cancelled`는 도달 단계 이후를 pending으로 유지해 current가 없고, session-level `failed`는 도달한 실제 단계가 error가 되어 terminal session을 진행 중으로 오인하지 않는다. 서버의 `errorMessage`, 개별 등록 검증 오류와 `scanFailureMessage`는 API 값 자체를 바꾸지 않고 공통 표시 경계에서 `Gateway ACK timeout` 같은 transport 원문을 `게이트웨이 장비 응답 시간 초과`처럼 한국어로 바꾼다.
- 390px·320px commissioning 회귀는 버튼뿐 아니라 setup/Gateway claim/조명 등록의 enabled input·select·checkbox/radio associated label을 실제 clipping·occlusion을 고려한 연속 44×44px reachable area로 검증한다. 등록 직후 기본 일괄 form의 다섯 input을 먼저 검사하고, 개별 설정으로 전환한 뒤 개별 input을 다시 검사한다. 등록 form input과 select는 최소 44px이고, 18px checkbox/radio 시각 크기는 유지하되 label hit 영역을 44px 이상 제공한다.
- 1440×900, 1024×768, 390×844, 320×740 Chromium route fixture에서 지도·상세 패널 배치와 document-level horizontal overflow를 검증한다. `맵 선택` 문구와 SelectBox의 수평 정렬, 새로고침 버튼의 우측 끝 정렬, 지도 오버레이 순서와 compact marker 상태 배지 위치도 같은 네 viewport에서 실제 픽셀로 검증한다. 1440×900 데스크톱은 문서 세로 스크롤 없이 뷰포트 안에 운영 화면을 고정하고, 상세 내용만 패널 안에서 세로 스크롤되는 계약을 추가로 검증한다. `2400×600`, `600×2400`처럼 가로·세로 비율이 극단적인 도면도 지도 영역의 가로·세로 경계 안에서 원본 비율을 유지한다. 760px 이하의 공통 helper는 root 아래 interactive element 중 disabled/hidden, `.sr-only`/`aria-hidden`, `display`/`visibility`/`opacity`로 숨긴 조상을 제외하고 현재 viewport 및 실제 overflow clip과 교차하는 effective target을 검사한다. usable intersection을 1 CSS px 이하 cell로 나누고 각 cell 중앙 hit sample이 target 또는 그 descendant인 연속 44×44px 후보가 하나 이상일 때만 통과하며, 부분·완전 occlusion은 정상 peer가 있어도 실패한다. checkbox/radio는 모든 associated label과 input fallback 중 이 조건을 만족하는 후보를 사용한다. viewport-fixed target은 transform/filter/perspective 등 fixed containing block을 만드는 조상이 있을 때만 ancestor overflow clip을 적용한다. 이 계약으로 새로고침, 맵·현장·등록 대상 select, 등록 방식 radio label, 로그아웃과 주 메뉴를 검증한다. 특히 390px와 320px에서 enabled `조명 검색 시작`·검색 실패 재시도의 actual bounding box가 44px 이상인지, 390px에서 pending setup·Gateway claim·조명 등록·reconciliation의 enabled primary/secondary action이 44px 이상인지를 route fixture로 고정한다. 밀집 도면 marker는 선택·hover·focus에서도 20px, 모서리 3px 네모 시각 크기를 유지해 hit overlap을 최소화하며 helper에서 명시적으로 제외한다. 대신 모든 조명을 노출하는 `상세 조명 선택` select가 44px 대체 선택 경로를 제공하고 marker/selector/상세 상태를 같은 selection state로 동기화한다. 이 검증은 deterministic API fixture 기반이며 실제 Raspberry Pi/ESP32-H2 HIL 증거는 아니다.
- 운영 화면 상단은 선택 층 기준 `전체 조명`, `정상`, `점검 필요`, `오프라인` 4개 `MetricCard`를 compact하게 표시한다. 오프라인은 등록 직후 첫 상태를 기다리는 `provisioning_waiting_state`를 포함하며 점검 필요 오른쪽에 배치한다. 평균 밝기와 별도 빠른 상태 영역은 제거해 지도 높이를 확보했다. KPI 열/행 계약은 1440px 4/1, 1024px 2/2, 390px 2/2, 320px 1/4이고 해당 네 viewport에서 document horizontal overflow를 자동 검증한다.
- KPI 다음에는 `층 도면`, `선택 조명 상세` 순서를 유지한다. 데스크톱 지도는 남은 뷰포트 높이를 모두 사용하고 현재 viewport에 맞춘 100%를 기준으로 10% 단위 확대·축소와 화면 맞춤을 제공한다. `Ctrl`/`Cmd`+휠은 브라우저 기본 확대를 취소하는 non-passive listener로 포인터 중심 zoom만 수행하고, 배경 이미지의 native drag를 비활성화해 빈 지도 drag와 일반 scroll로 안정적인 상하좌우 이동을 제공한다. marker 선택은 그대로 유지한다. 확대된 원본 비율 지도는 전용 viewport 안에서만 overflow되고 모바일 zoom control은 48px touch target을 제공한다.
- 선택 조명 상세는 도면보다 좁은 고정 범위 패널에 배치하고 현재 밝기와 장비 사실만 표시하며 별도 점검 큐는 제공하지 않는다. 패널과 하위 grid item은 축소 가능한 너비를 사용하고 긴 장비·게이트웨이 이름을 패널 안에서 줄바꿈해 document-level 가로 스크롤을 만들지 않는다. 정상·장애·오프라인·첫 상태 확인 대기는 선택 상세의 `StatusBadge`와 지도 범례에서 icon + visible text로 구분한다. 모든 marker는 모서리 3px의 20px 네모로 표시하고 내부에 이름·밝기 문자와 bar를 렌더링하지 않으며, 정확한 정보는 기존 `title`/`aria-label`과 우측 상세 패널에 유지한다. online marker는 `0~9`, `10~19`, …, `80~89`, `90~100`% 밝기를 10단계로 분류하고 범위 밖은 clamp한다. 각 단계는 brown/orange 없이 cool slate/gray에서 neutral light, lemon/bright ivory로 이어지는 정적 fill·glow를 사용하며 단계가 높아질수록 실제 렌더링 밝기와 glow가 증가한다. fault는 red/double 테두리를 제거하고 같은 밝기 단계의 일반 border/fill/glow와 우상단 red 8px 배지만 사용한다. offline과 `provisioning_waiting_state`는 저장 밝기와 무관하게 무발광 dashed/dotted 상태 스타일을 유지한다. 도면 좌측 상단의 층/`실시간 조명 배치` 라벨은 제거하고, 상태 범례는 지도와 함께 스크롤되지 않는 비상호작용 overlay로 이동 안내 바로 위에 고정해 아래 marker·drag·wheel 입력을 가로채지 않는다. 모바일에서는 기존 공간 절약 정책에 따라 이동 안내를 숨기고 범례만 유지하되 줌 컨트롤과 겹치지 않도록 상단 간격을 확보한다. marker별 상태 문구나 SVG를 1,000개까지 반복 렌더링하지 않으며 기존 한국어 접근성 이름과 선택 상태는 유지한다.
- 모니터링은 등록 조명 유무와 무관하게 Gateway claim, 조명 등록 패널·버튼·dialog 및 인시던트 이력·조치·판정 기준 UI를 렌더링하지 않는다. 등록 0개인 admin에게는 설정의 admin 전용 `/settings/registration` 이동 경로를 제공하고 viewer에게는 관리자가 설정에서 등록해야 한다고 안내한다. Gateway claim, active registration session 복구와 조명 등록 workflow는 설정 메뉴만 소유한다.
- Task 8에서 pending assigned admin이 `/monitoring`, `/control`, `/statistics`, 설정 하위 직접 URL로 들어오면 CustomerShell이 조회한 dashboard의 selected/default `siteId`를 유지해 `/settings?siteId=...`로 replace한다. `/settings`에서는 배정된 고객사·현장명을 읽기 전용으로 표시하고 주소·단가·층만 입력하는 최초 설치 화면을 제공한다.
- CustomerShell은 admin dashboard의 `installationStatus`가 확인되기 전에는 customer child route를 mount하지 않는다. 확인 중에는 설치 상태 loading UI를, 최초 조회 실패에는 retry UI를 표시하며 성공 setup 응답은 actual site key와 `['dashboard', 'default']` cache에 함께 반영해 실패한 background refetch가 있어도 installed guard 상태를 유지한다.
- 설치 완료 후 등록 조명이 0개인 모니터링은 admin에게 설정의 조명 등록 페이지 링크만 제공한다. viewer는 읽기 전용 안내만 보며 claim, 등록, setup mutation UI를 볼 수 없다. operator는 customer shell을 mount하지 않는다.
- `GET /sites`는 assigned active customer `admin`의 정확히 한 현장과 유효한 `SiteMembership`을 가진 customer `viewer` 현장만 반환한다. service-provider `operator`의 고객 현장 목록은 빈 배열이다.
- `GET /sites/default/dashboard`는 접근 가능한 첫 현장을 반환하고, 접근 가능한 현장이 없을 때도 빈 dashboard shape를 유지한다.
- `GET /sites/:siteId/dashboard`, 층별 fixture 조회와 기본 에너지 추정은 `AuthenticatedUser + SiteAccessService`로 현장 read 권한을 확인한다. 다른 admin 현장, 미배정 viewer와 operator 고객 현장은 `404`로 숨긴다.
- dashboard `site`는 `customerName`, nullable `address`/`tariffKwhRate`, `timeZone`, 그리고 주소·단가·층 존재 여부에서 계산한 `pending|installed` 설치 상태를 함께 반환한다.
- assigned admin은 pending Site의 최초 주소·단가·시간대·층을 API로 완료할 수 있으며, 설치가 끝난 뒤 자기 현장의 Gateway claim과 조명 검색·등록 commissioning API를 호출할 수 있다. `POST /gateways/claim`은 정규화한 serial별 transaction advisory lock 아래 Site row 재검증, rolling failure count, terminal audit와 inventory claim을 한 decision boundary에서 처리한다. 병렬 invalid 요청은 최대 5회의 claim-code 검증만 수행하고 invalid·unavailable·already-consumed·rate-limited·success를 모두 commit한 뒤 정제된 응답을 반환하며, 다른 serial은 전역 잠금을 공유하지 않는다.
- registration session 생성은 body `siteId`, 조회·재검색·identify·개별/일괄 등록·완료는 저장된 session `siteId`의 `commission` capability를 검사한다. mutation은 Site 권한을 transaction 안에서 다시 확인하고 등록 domain의 `Floor -> Gateway -> Session -> Node -> Outbox` 잠금 순서를 지켜 재배정·비활성화된 stale admin과 식별/등록 lifecycle 경합을 차단한다. 조회는 read-only 권한 검사와 일관된 polling snapshot을 사용한다. 기존 durable scan outbox, allocator와 provisioning 상태 전이는 그대로 유지한다.
- `GET /registration-sessions/active?siteId=...`는 현장 commission 권한을 검사하고 active 세션을 최신순으로 반환한다. 웹은 페이지 재진입과 새로고침 시 가장 최근 세션의 층, 게이트웨이, 검색 attempt와 발견 노드를 자동 복구하며 여러 세션이 있으면 사용자가 전환할 수 있다. active 조회가 끝나거나 실패 복구되기 전에는 새 검색을 시작하지 않는다.
- 조명 수와 관계없이 모니터링 화면에는 `조명 등록` 버튼이나 등록 dialog를 제공하지 않는다. 진행 중 session의 복구·완료·취소와 추가 검색은 설정의 `/settings/registration`에서만 수행한다.
- 로컬 실행에는 검색 결과 생성기가 없으며 Raspberry Pi/ESP32-H2가 꺼져 있으면 검색 결과 0개를 유지한다.
- ESP32-H2 unprovisioned UUID는 `DFKLED`, format version, 제품군, 모델, 하드웨어 revision과 6바이트 장치 식별자로 구성한다. Raspberry Pi Gateway는 shared parser로 현재 format의 자사 UUID만 scan 결과에 포함하고 타사 장치는 구조화 로그만 남긴다.
- 등록용 자동 이름 순번은 층별 `Floor.nextFixtureSequence`, Mesh unicast 주소는 게이트웨이별 `Gateway.nextMeshUnicastAddress`에서 소유 행 잠금 후 연속 범위로 원자 예약한다. 삭제되거나 건너뛴 값은 재사용하지 않으며 Mesh 주소는 `0x0001~0x7fff`만 허용한다.
- `POST /registration-sessions/:sessionId/nodes/register-batch`는 일괄·개별 설정을 하나의 요청으로 받고, session/node 행 잠금과 Task 5 allocator를 같은 transaction에서 사용한다. 유효한 node는 `accepted`, 존재하지 않거나 이미 처리 중인 node는 `validation_failed`로 분리해 성공한 등록을 유지한다.
- 일괄 이름은 서버가 prefix, 시작 번호, 자릿수와 예약 순번으로 생성한다. 자동 좌표는 도면 크기 또는 `1200x800` 기본 canvas 안의 기존 fixture와 겹치지 않는 행 우선 grid cell을 사용하며 이름·전력·좌표·marker 크기를 provisioning 전에 저장한다.
- 조명 등록 패널은 검색된 등록 가능 node의 개별/전체 checkbox 선택과 `일괄 설정`·`개별 설정` 전환을 지원한다. 일괄 설정은 선택 층 이름을 기본 prefix로 사용하고, 개별 설정은 이름·정격 전력·marker 크기를 입력한다. 등록 단계의 좌표 입력은 제거했으며, 위치는 등록 후 설정의 해당 층 에디터에서 배치한다.
- 일괄·개별 등록 요청에서 서버가 수락한 node만 선택 해제하고, `validation_failed`는 오류와 선택을 유지한다. 물리 provisioning 중인 node는 재등록할 수 없으며 이후 `failed` 또는 `reconcile_required`로 확인되면 검토 대상으로 다시 선택해 node 행에 원인을 표시한다.
- API는 선택 node의 `provisioning` 상태, Mesh 주소, pending Fixture 정보와 strict v2 `provision-device` outbox를 한 transaction에 저장한다. HTTP `accepted`는 MQTT 연결과 무관하게 이 durable 기록이 commit됐음을 뜻한다. worker는 `SKIP LOCKED` lease, 10초 publish timeout, 최대 10회/15분 bounded backoff로 QoS 1 발행하고 PUBACK 뒤 `publishedAt`을 기록한다. 한계 초과는 주소와 pending 정보를 보존한 채 node를 `reconcile_required`로 전환한다. Gateway는 command를 RF 전에 `0600` atomic journal에 저장하고 exact duplicate를 FIFO에 다시 넣지 않으며, terminal도 atomic 저장 뒤 exact application ACK 전까지 재발행한다. accepted-only restart는 RF를 반복하지 않고 적용 여부 확인 불가 terminal로 수렴한다.
- `reconcile_required` 노드는 `상태 다시 확인`으로 늦게 도착한 provisioning 완료를 먼저 조회한다. 여전히 불확실하면 관리자가 장비가 미등록 또는 초기화 상태임을 확인한 뒤 `POST /registration-sessions/:sessionId/nodes/:nodeId/exclude`로 현재 세션에서만 제외할 수 있다. 이 동작은 Mesh 주소와 pending 정보를 감사 증거로 보존하며 재프로비저닝 명령을 발행하지 않는다.
- 이전 scan attempt에 남은 `provisioning/reconcile_required`도 현재 후보와 함께 복구 화면에 표시해 숨은 상태로 세션을 차단하지 않는다. 상태 재조회가 실패하면 오류를 표시하고 제외 동작을 잠근다. 여러 active 세션 중 하나를 종료하면 다음 세션을 즉시 복구한다.
- provisioning 완료 MQTT 처리는 `Session -> Node` 행 잠금 뒤 active session과 `provisioning/reconcile_required` 상태를 재검증한다. 제외·취소가 먼저 commit되면 늦은 완료 이벤트는 fixture를 만들지 않고, MQTT 완료가 먼저 commit되면 뒤따른 제외·취소가 상태 재검증에서 거부되어 명시적 운영 결정과 장비 이벤트가 경합해도 상태가 뒤집히지 않는다.
- 등록 검색은 세션별 `pending/scanning/completed/failed` lifecycle, correlation ID와 attempt를 사용한다. 신규 검색과 retry는 `pending` session과 scan-start durable outbox를 같은 transaction에서 만들며 publisher가 lease 아래 `pending -> scanning` 전이 후 발행한다. 0건은 `completed`이며, 완료/실패/발견 이벤트는 session 행 잠금과 `ProcessedGatewayEvent` 원장 transaction 안에서 site, gateway, correlation, attempt, eventId, sequence가 현재 scan과 모두 일치할 때만 반영한다. 검증된 발견 이벤트의 correlation ID와 attempt는 `DiscoveredMeshNode` create/update 양쪽에 저장한다. 이전 시도에서 제외되어 `failed`가 된 동일 장치를 다음 attempt에서 실제로 재발견하면 상태를 `discovered`로 복원하고 최신 scan identity와 측정값으로 덮어쓴다. 늦은 발견, 중복·낮은 sequence, 이전 시도 이벤트는 무시한다.
- Gateway는 shared DFKLED UUID parser를 통과한 장치만 `scan-found` v2 topic으로 발행한다. `(sessionId, scanCorrelationId, scanAttempt)`별 0600 atomic journal은 running duplicate가 scanner를 다시 시작하지 않게 하고, terminal은 원래 eventId/sequence를 가진 동일 event로 재발행한다. restart에서 남은 running record는 새 scan 대신 정제된 failed terminal로 수렴하며, 손상·권한 오류 journal은 fail-closed 한다. application ACK를 받지 못한 terminal과 running은 retention·capacity eviction에서 제외하고, 이 보호 record 때문에 1,000개 한도를 채우면 새 scan을 fail-closed 한다. ACK를 받은 delivered terminal만 24시간 보존한다.
- `POST /registration-sessions/:sessionId/scan/retry`는 terminal scan이며 `provisioning` 또는 `reconcile_required` 노드가 없을 때만 재시작한다. gateway별 `status=active`인 `pending/scanning` partial unique 제약으로 같은 gateway의 동시 검색을 막고, 신규·retry 충돌 모두 `gateway_scan_in_progress`를 반환한다. publisher MQTT timeout은 기본 10초로 30초 lease보다 짧으며 process crash는 lease 만료 뒤 같은 attempt를 재시도한다. timeout/reject는 backoff를 증가시키고 최대 3회 또는 5분 실패는 사용자용 고정 메시지와 함께 `failed`로 복구한다.
- API provisioning scan/device command outbox worker는 initial·interval batch의 transient DB 실패를 scheduler 경계에서 격리하고 worker별 single-flight로 실행한다. Mesh group sync도 single-flight로 실행하며 종료가 시작되면 다음 record/group publish를 시작하지 않는다. `MqttShutdownCoordinator`가 command, scan, provisioning device, automation outbox worker와 `MeshGroupSyncWorker`를 멱등 drain하고, inbound MQTT listener를 분리한 뒤 진행 중 handler와 ACK publish를 모두 기다린 다음에만 `MqttService.close()`를 호출한다. Mesh subscription sync, provisioning terminal ACK와 mesh resync ACK는 PUBACK 무응답 시 10초에 packet ID를 취소해 active drain을 끝내며 timeout rejection은 payload·topic·오류 상세를 노출하지 않는 최상위 오류 경계에서 격리한다. MQTT close는 graceful `end` callback을 await하고 5초 timeout에 force close callback을 추가 1초간 기다려 영구 hang 없이 Nest module 종료를 마친다.
- scanning 또는 pending scan, 진행 중 `identifying`, 미해결 `provisioning/reconcile_required`, 등록 성공 조명 0개는 registration session 완료를 거부한다. 성공 조명이 없고 미해결 노드도 없는 terminal session은 `POST /registration-sessions/:sessionId/cancel`로 `cancelled` 종료한다. provisioning 전 BIO identify는 commission 권한·활성 session·Gateway와 현재 scan 후보를 transaction에서 다시 확인한 뒤 durable outbox로 접수하며, 표준 BlueZ adapter는 미지원 terminal을 반환한다.
- 웹 등록 패널은 `completed` 0건에서 검색 결과 없음과 `다시 검색`을, `failed`에서 API가 제공한 정제된 실패 메시지와 `다시 검색`을 표시한다. 발견 BIO 조명의 `식별`은 고정 force-on 뒤 sensor mode 복원을 확인하는 비동기 동작이며 주소/Fixture/mapping 생성과 분리된다. 소프트웨어 경합 회귀를 검증했으며 실제 BIO HIL 재검증은 후속이다.
- 등록 세션 polling은 `pending/scanning` 또는 identifying/provisioning node가 있을 때 1.5초 간격으로 수행한다. 식별 mutation의 operation ID와 서버 node의 `identifyOperationId`/`identifyOperationStartedAt`/`updatedAt`를 보존·대조하여 이전 요청 terminal이 새 retry의 polling을 끝내지 못하게 한다. timeout 뒤 등록이 진행된 이전 식별 terminal은 ledger/ACK만 기록하고 등록 상태는 변경하지 않는다. terminal scan과 `reconcile_required`에서는 진행 operation이 없으면 자동 polling을 중지하고 사용자가 상태를 다시 확인한다. 다시 검색 요청을 시작하는 즉시 이전 후보, 선택, 제출 상태와 개별 초안을 비우고 POST 응답은 relation이 없는 상태 전이 응답으로 취급한 뒤 canonical session GET으로 수렴한다.
- 등록 후보는 현재 scan이 `completed`이고 node의 `scanCorrelationId`와 `scanAttempt`가 session의 현재 identity와 모두 exact match일 때만 노출하고 등록할 수 있다. 서로 다른 API/Gateway wall-clock의 `scanStartedAt`과 `discoveredAt`은 attempt 판정에 사용하지 않으며, identity가 `null`인 legacy row와 이전 attempt relation은 fail-closed로 숨긴다.
- provisioning 완료를 session polling으로 관측하면 현재 층 `floor-fixtures`, `floor-map`과 해당 `registration-session`을 갱신해 등록 화면을 유지한다. 사용자가 `등록 세션 완료`를 누른 뒤 현 화면 `dashboard`와 기본/현장별 dashboard cache를 갱신해 운영 화면으로 전환한다. 새 fixture는 첫 실제 상태 전까지 기존 API 계약대로 `상태 확인 대기`로 표시한다.
- 등록 batch transaction은 실제 provisioning publish 전에 해당 층의 `MeshControlGroup`을 선확보해 group address 소진이나 gateway/site 불일치를 미리 실패시킨다.
- 조명 등록 패널은 gateway scan/provisioning MQTT 흐름과 연결되어, 등록 완료 이벤트 후 dashboard polling으로 새 fixture를 표시할 수 있다. 이 시점의 fixture는 `offline + provisioning_waiting_state`이며 실제 offline과 구분해 `상태 확인 대기`로 표시한다.
- provisioning 완료 transaction은 생성 또는 재사용한 `MeshNode`/`Fixture`를 같은 transaction 안에서 floor control group과 기존 `FixtureGroup` membership의 control group member에 연결한다. 이때 fixture group 대상은 요청 payload가 아니라 DB의 `GroupFixture` 관계를 권위 데이터로 조회한다.
- 이미 다른 층에 매핑된 기존 fixture가 같은 device UUID로 다시 발견되면 자동 이동하지 않고 provisioning 완료를 `failed`로 종료해 현장 매핑 충돌을 드러낸다.
- 상단 `맵 선택` SelectBox로 지하/지상 층을 전환하며 문구와 SelectBox를 한 줄에 배치한다.
- 층별 2D 맵에 도면 이미지와 조명 위치를 표시한다.
- 조명 점은 선택/hover/focus에서도 크기가 변하지 않는 모서리 3px의 20px 네모 marker로 표시하고 outline과 적층으로만 현재 선택을 구분한다. online은 10개 밝기 단계별 정적 fill/glow를 적용하고 실제 computed 스타일의 단조 증가와 같은 단계의 동일함을 검증한다.
- 조명 점의 접근성 라벨과 tooltip은 한국어 상태명(정상/오프라인/장애)을 사용하고, `provisioning_waiting_state`는 `상태 확인 대기`로 별도 표시한다.
- 선택 조명 상세 패널에 현재 밝기, 정격 전력, 마지막 수신, 해당 조명에 실제 매핑된 게이트웨이 이름/상태, RSSI, hop count, 명령 성공률을 표시한다.
- 선택 층 기준 전체 조명 수, 온라인 수, 점검 필요 수와 상태 확인 대기를 포함한 오프라인 수를 상단 KPI로 표시한다.
- 지도 마커 또는 모바일 `상세 조명 선택` SelectBox로 개별 조명을 선택하며 두 입력과 상세 패널의 선택 상태를 동기화한다. 읽기 전용 Konva object 입력 상태는 HTML marker 버튼까지 비활성화하지 않도록 DOM 속성을 분리한다.
- 층 탭은 좁은 화면에서 가로 스크롤되고, 모바일 하단 내비게이션 CSS는 `env(safe-area-inset-bottom)` 여백 계약을 적용한다. 현재 Chromium route fixture는 non-zero safe-area inset을 에뮬레이션하지 않으므로 실제 WebView inset 실측을 주장하지 않는다.
- MQTT `fixture-state` 이벤트는 API가 packet 수신을 시작한 `receivedAt`을 한 번 고정하고, 장비 `occurredAt`이 그 시각보다 기본 5분(`300,000ms`, 정확한 경계 포함)을 넘게 미래가 아닐 때만 fixture 최신 상태 snapshot을 갱신한다. 수락 시 `lastSeenAt`은 서버 수신 시각, `lastStateOccurredAt`은 장비 발생 시각으로 분리 저장한다. 장비 발생 시각은 energy 순서·cursor/checkpoint에 쓰고, 모니터링 freshness에는 쓰지 않는다.
- provisioning 완료 MQTT event는 밝기, online/fault, lastSeenAt을 추정하지 않는다. 첫 실제 `fixture-state` event가 들어올 때만 이 snapshot을 확정한다.
- MQTT `gateway-heartbeat` 이벤트도 같은 5분 미래 경계를 통과한 경우에만 gateway online/offline 상태 판단에 반영한다. `lastHeartbeatAt`은 서버 수신 시각, `lastHeartbeatOccurredAt`은 장비 발생 시각이다.
- dashboard metadata와 선택 층 fixture snapshot은 React Query로 10분마다 polling한다. 브라우저 focus만으로 다시 조회하지 않는다.
- 모니터링 상단 우측 끝의 `새로고침`은 선택한 활성 맵의 등록 조명을 실제 Gateway 읽기 경로로 확인한다. read 권한 사용자(admin/viewer)가 `POST /sites/:siteId/floors/:floorId/monitoring-refreshes`에 UUID `clientRequestId`만 보내며, 서버가 대상과 Gateway를 snapshot한다. 최대 1,000개·Gateway batch 64개, 동일 요청/active 층 요청 재사용, 완료 후 30초 cooldown과 30초 deadline을 적용한다. 등록 조명 0개는 HTTP 데이터만 다시 조회한다.
- 처리 중 버튼은 `장치 상태 확인 중`으로 바뀌고 비활성화된다. GET 상태를 500ms 간격으로 조회하고 terminal/오류 뒤 dashboard·선택 층 fixture 전체 페이지·map을 다시 읽는다. 첫 pass 실패만 250ms 뒤 한 번 재조회하며 두 번의 검증된 `not_found/read_timeout/read_failed`만 즉시 오프라인으로 반영한다. Gateway/MQTT 전체 실패와 deadline 미확인 결과는 개별 offline으로 만들지 않는다. 자동 10분 조회·기본 20분 stale 안전망은 유지한다.
- 수동 확인은 BIO brightness GET→mode GET 또는 BlueZ 읽기 경로만 사용하고 기존 transport queue로 직렬화한다. 밝기·전원·sensor mode·주소·group membership·에너지 checkpoint를 변경하지 않는다. BIO sensor의 설정 밝기를 실제 출력으로 추정하지 않는다. 성공 presence와 두 번 실패 terminal, batch 완료는 durable journal/outbox와 application ACK로 수렴한다.
- BlueZ `Node1.Send`의 D-Bus `TIMEOUT/ETIMEDOUT`은 Gateway 전송 실패로 처리해 개별 조명을 오프라인으로 만들지 않는다. 두 GET 전송 성공 뒤 실제 응답 대기 시간 초과만 `read_timeout`으로 재확인한다.
- batch 완료는 모든 조명 결과의 API application ACK를 Gateway 저널에 먼저 영속화한 뒤 발행한다. 선행 완료 패킷은 API가 MQTT PUBACK만 보내 다음 결과를 받을 수 있게 하고 완료 application ACK는 보류한다. Gateway v3 저널은 command 수락 시 고정 폭 handoff/결과 ACK 진행 공간을 예약해 파일 상한에서도 ACK 저장 크기가 늘지 않으며, 완료 ACK는 축소 저장한다. 저장 실패 시 outbox 삭제를 하지 않는다. v1/v2는 atomic 변환하며 v1의 미완료 ACK 기록은 같은 event ID로 재전송하고 v2 결과 ACK는 보존한다. 순서가 바뀐 새 batch는 수락하고 같은 sequence/identity의 다른 payload는 거부한다. 만료 전에는 중복 기록을 보존하며, 만료 후 완료 ACK를 받은 기록과 결과 없는 실패 기록은 atomic 정리한다. 미ACK 결과는 10,000건·32 MiB 상한 안에서 계속 보존한다. 재발행 drain은 배치별 index로 진행을 조회하고 16배치마다 이벤트 루프에 양보하여 전체 결과 반복 복제로 MQTT ACK 처리가 막히지 않게 한다.
- terminal 요청의 7일 보존기간 후에는 API가 요청과 batch 모두 없음을 DB에서 확인한 correlated 결과에만 폐기 ACK를 반환한다. state/presence/unreachable은 기존 `state-ingested`의 `duplicate`, 완료는 전용 ACK를 사용하며 조명·밝기·전력·freshness·tenant 데이터는 쓰지 않는다. 한쪽 기록이 남아 있거나 소유 관계/identity가 다르면 거부하고 DB 오류에는 ACK하지 않는다. Gateway가 새 정상 상태를 계속 전송할 수 있게 하는 폐기 계약이며, 삭제된 요청이 과거에 유효했다는 인증은 아니다.
- 완료 application ACK의 `acks/fixture-presence-check-completed` 읽기는 운영 ACL과 개발 allowlist 모두 인증서 CN에 결속된 자기 Gateway에만 허용한다. Gateway가 이 ACK를 발행하거나 다른 Gateway의 ACK를 읽을 권한은 없다. 기존 ACL의 site `+` 구조는 유지되며 site와 Gateway의 실제 소속·topic/payload identity는 API가 검증한다. 따라서 같은 Gateway ID의 site 구분까지 broker ACL 단독으로 보장한다고 해석하지 않는다.
- 완료 시 별도 성공 toast 없이 KPI·마커·상세를 함께 갱신한다. partial은 `일부 조명의 상태를 확인하지 못했습니다.`, failed는 `장치 상태를 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.`, expired/timeout은 `장치 응답 시간이 초과되었습니다. 잠시 후 다시 시도해 주세요.`를 표시한다. 확인된 상태와 기존 성공 데이터를 보존하며 source별 조회 오류는 독립적으로 관리한다. 맵·현장 변경과 unmount는 polling을 취소하고 늦은 응답이 새 화면을 덮지 못하게 한다.
- 기본 dashboard는 fixture 본문을 제외한 현장/층/gateway metadata와 DB aggregate summary만 반환한다. 제어 화면만 `includeFixtures=true`를 명시한다.
- 모니터링 fixture snapshot은 `GET /sites/:siteId/floors/:floorId/fixtures`에서 현장 read 권한을 검증한 뒤 최대 200개씩 ID cursor로 조회하며, 선택 층의 다음 페이지를 연속 병합한다. 존재하지 않는 층과 접근할 수 없는 층은 같은 `floor not found` 404 응답으로 처리한다.
- `Fixture(floorId, id)` 복합 인덱스로 OFFSET 없이 대규모 fixture를 순회한다.
- Playwright deterministic route fixture는 Chromium에서 수동 새로고침과 마지막 갱신 시각 변경, 10분 자동 갱신 경계, 5페이지로 나뉜 조명 1,000개의 마지막 페이지 상태 반영, 저장된 지도 객체의 실제 Konva canvas pixel 렌더링을 검증한다. 이 fixture는 브라우저와 API 계약 회귀용이며 실제 Raspberry Pi/ESP32-H2 하드웨어 E2E 증거가 아니다.
- `pnpm benchmark:fixtures`는 `API_BENCH_SITE_ID`, `API_BENCH_FLOOR_ID`, 실제 인증 cookie로 현장 범위 fixture API를 기본 100회 측정해 p95가 1초를 넘으면 실패한다. site/floor ID는 URL encoding하며 스크립트 계약은 `node --test scripts/benchmark-fixture-api.test.mjs`로 검증한다.
- 모니터링의 층 도면은 모든 역할에 읽기 전용으로 표시한다. 편집 버튼, editor state 조회와 editor 분기는 제공하지 않으며, 도면 변경과 version 복구는 설정 메뉴가 소유한다.
- `GET /sites/:siteId/floors/:floorId/map-snapshot`은 현장 read 권한을 확인한 뒤 지도 revision, 선택적 도면 배경과 visible 도형만 반환한다. fixture runtime 상태는 기존 cursor API가 담당하며, 배경이 없으면 `1200x800` 기본 canvas를 사용한다.
- 층 지도 snapshot은 도형을 `zIndex`, 생성 시각 순으로 고정해 반환한다. 존재하지 않거나 접근할 수 없는 층은 같은 `floor not found` 404 응답으로 처리한다.
- 웹은 `useFloorMapSnapshot`으로 선택 층의 저장된 배경과 도형을 10분마다 조회하고, 설정 에디터와 공통 `FloorMapObjectNode` geometry를 사용해 Konva scene에 읽기 전용으로 합성한다. 조명 marker는 같은 좌표계의 접근 가능한 HTML 버튼으로 표시한다.
- 설정 맵의 atomic save 또는 revision 복구가 성공하면 응답의 `mapRevision`, 배경·맵 크기·도형을 동일 현장/층의 `floor-map` 캐시에 즉시 기록하고, 조명 이름·위치·크기·정격 전력·배치 상태는 기존 `floor-fixtures` 페이지의 밝기·장애·Gateway 운영 상태를 보존한 채 병합한다. 이후 scoped query invalidation과 서버 재조회도 유지하므로 설정에서 모니터링으로 이동할 때 이전 10분 캐시를 먼저 표시하지 않는다.
- 네모·세모·선·텍스트는 맵 편집 저장 성공 뒤 공통 `FloorScene`/`FloorMapObjectNode`를 통해 읽기 전용 모니터링 Konva scene에 같은 좌표와 색상으로 표시한다. `.floor-scene-canvas`, `.konvajs-content`, canvas는 모두 floor map 콘텐츠 높이를 채우므로 0px 합성 높이로 저장 도형이 사라지지 않는다. 브라우저 회귀는 접근성용 숨김 데이터 존재만 확인하지 않고 네 종류를 한 번에 저장한 뒤 최종 합성 높이와 사각형·삼각형·선·텍스트의 hand-derived RGB 픽셀을 검사한다.
- 모니터링 수동 새로고침은 dashboard metadata, 현재 층 fixture 페이지와 현재 층 map snapshot 세 요청을 함께 갱신하며 일부 실패 시 기존 성공 데이터를 유지한다.
- 지도 snapshot의 최초 조회가 실패하면 기본 빈 canvas를 만들지 않고 오류와 `지도 다시 시도`를 표시한다. 이전 성공 snapshot이 있는 갱신 실패는 현재 지도를 유지한 채 실패 표기와 재시도만 추가하며, 수동 갱신 실패 상태는 해당 floor ID에 귀속되어 다른 층으로 전환할 때 누수되지 않는다.
- deterministic Playwright route fixture는 0건 완료, relation 없는 retry 응답, canonical GET의 `pending -> scanning -> completed` 진행과 terminal polling 중지, 실패 메시지, 명시적 다시 검색, 등록 조명이 존재하는 상태의 active 세션 자동 복구와 최초 지도 오류 복구를 Chromium에서 검증한다. route fixture는 실제 API/DB 또는 하드웨어 검증을 대체하지 않는다.
- Task 9 격리 실백엔드 Chromium E2E는 operator의 현장/admin 발급과 customer route 차단 뒤 assigned admin이 pending setup, Gateway claim, 0건 검색·재검색, 자사 node 2개 등록과 모니터링 진입을 수행하는 새 계약을 검증했다. test support의 software MQTT publisher는 production API, 인증, claim, registration과 state-ingested ACK를 통과하고 shared `parseDfkDeviceUuid` 정본으로 invalid/타사 UUID 1개를 제외한다. 다만 실제 `apps/gateway`의 BlueZ scan/RF, production Gateway certificate principal·bootstrap·broker ACL 배포, Raspberry Pi/ESP32-H2 HIL 증거는 아니다.
- gateway scoped v2 fixture state와 heartbeat는 topic/payload/DB의 site·gateway 관계가 모두 일치할 때만 반영한다.
- v2 상태 이벤트는 영속 `eventId`와 gateway sequence를 사용하며 QoS 1 중복과 낮은 sequence 역전을 폐기한다. 같은 identity의 canonical payload가 같으면 이미 commit한 결과를 재응답하고, payload가 다르면 fail-closed 한다.
- 업그레이드 이전 `payloadHash=null` fixture-state/heartbeat 원장은 topic/DB 소유권을 검증하고 소유 행을 잠근 뒤 exact gateway·fixture·sequence·eventType·occurredAt을 확인한다. 첫 인증 재전송의 hash를 `eventId AND payloadHash IS NULL` 조건부 갱신으로 확정하며, 경합 시 재조회한 hash가 같은 경우만 기존 terminal 결과를 반환한다. migration-default `accepted` fixture event의 `duplicate` ACK는 Gateway의 정확한 pending head를 해제하고 다음 저장 event를 실제 publisher가 발행하게 한다. snapshot·energy·freshness는 다시 반영하지 않는다.
- 모든 production 상태 producer는 `0700` 전용 디렉터리의 `0600` atomic durable outbox에 먼저 기록한다. 별도 manifest가 최초 생성과 운영 중 파일 소실을 구분하며 missing/corrupt/unsafe permission은 `state_outbox_missing`, `state_outbox_corrupt`, `state_outbox_permissions` health로 시작을 차단한다. 최대 `100,000건/100MiB` 용량을 예약할 수 없으면 command·scan·identify·provision RF 작업 전에 공통 gate가 fail-closed하고 `state_outbox_capacity`를 sticky 상태로 남긴다.
- 자발 Mesh publication은 한 이벤트 용량을 미리 예약한 동안에만 listener를 연다. 이벤트를 durable 저장한 뒤 다음 예약이 실패하면 listener를 닫고, application ACK로 용량이 회복되면 재구독한 뒤 강제 상태 resync를 수행한다.
- Gateway는 QoS 1 PUBACK 이후에도 exact `state-ingested` application ACK를 받기 전에는 상태 이벤트를 삭제하지 않으며 reconnect/restart 후 재전송한다. API는 이벤트 원장, 최신 Fixture 상태, 에너지 cursor/checkpoint와 일별 집계를 같은 DB transaction으로 commit한 뒤에만 `ingested`, `duplicate`, `stale_sequence`, `reverse_time`, `stale_checkpoint` ACK를 발행한다. 5분을 1ms라도 넘는 future fixture-state/heartbeat는 `ProcessedGatewayEvent`에 `rejected_future_timestamp` terminal 결과만 durable commit하며 snapshot·energy·gateway freshness를 갱신하지 않는다. fixture-state는 exact terminal ACK 뒤 outbox head를 제거해 같은 Gateway의 다음 event가 진행할 수 있다.
- gateway는 재시작 후에도 event sequence를 파일 권한 `0600`으로 이어간다. 시작 시에는 journal 추정 상태를 재발행하지 않고, 확인된 node의 AppKey/model bind/60초 publication 응답을 다시 확인·보정한 뒤 Generic OnOff, Lightness, Health 실제 상태를 조회한다.
- Gateway provisioning scan journal은 `(sessionId, scanCorrelationId, scanAttempt)` 논리 실행을 `0600` atomic file에 보존한다. process restart 시 남은 `running`은 새 물리 scan 없이 정제된 `scan-failed` terminal로 먼저 수렴한다. MQTT가 runtime listener보다 먼저 연결된 경우도 command/application ACK subscription 준비 뒤 connect recovery를 정확히 한 번 실행한다. recovery terminal publish는 기본 10초 timeout을 적용하고 connection 안의 동시 drain을 single-flight로 직렬화한다. 연결 뒤 새 terminal은 durable 저장 직후 최초 publish 결과를 기다리기 전에 scheduler를 깨우며, ACK가 없으면 1초부터 최대 30초까지 exponential bounded backoff로 같은 event를 재발행한다. idle journal은 polling하지 않는다. MQTT close는 예약 timer와 active publish를 취소하고 reconnect는 새 connection generation에서 즉시 drain을 재시작한다.
- broker PUBACK만으로 terminal을 delivered 처리하지 않는다. API는 exact terminal의 `ProcessedGatewayEvent` 생성과 `ProvisioningSession` terminal 변경 transaction이 commit된 뒤 strict `acks/provisioning/scan-terminal-ingested` ACK를 발행하고, transaction 실패 뒤 동일 event 재전달 또는 commit 뒤 ACK publish 실패에 따른 duplicate에도 commit 원장과 terminal snapshot을 확인해 ACK를 재발행한다. Gateway는 ACK의 `eventId`, `sequence`, `sessionId`, `scanCorrelationId`, `scanAttempt`가 journal terminal과 모두 일치할 때만 `deliveredAt`을 기록하고 retry timer를 정리한다. API offline, transaction 실패, ACK publish 실패에서는 journal을 유지한다. Gateway certificate의 ACK write 권한은 실제 producer topic인 `acks/acceptance`, `acks/device-status`로 제한하며 `acks/state-ingested`, `acks/provisioning/scan-terminal-ingested`는 read-only다.
- startup resync는 4개 node 제한 queue와 busy 재시도를 사용한다. 구성 성공 뒤 같은 generation의 OnOff/Lightness pair가 오면 8초 resync `observed`로 집계하고, Health Current 미관측은 `healthPending`으로 별도 집계한다. Automation terminal commit recovery의 durable pending fixture snapshot은 restart에도 복원되고 targeted queue에 seed된다. Queue는 최대 4,096개를 coalesce하고 64개씩 조회하며, 각 targeted/full pass 뒤 실제 관측으로 해제되지 않은 source ID를 회전된 capacity window로 다시 채운다. 따라서 선두 영구 offline fixture의 fence는 유지되지만 capacity 밖 정상 fixture도 starvation 없이 관측 기회를 얻는다. Full error와 `timedOut`/`failed` report도 250ms~30초 capped backoff rerun을 예약한다. Pending transition/fence는 실제 OnOff/Lightness 관측이 durable state에 반영될 때까지 남고, shutdown은 retry timer와 현재 signal을 취소한 뒤 5초 안에 drain한다. `meshResync` health field와 구조화 log는 lighting pair가 전혀 없거나 전송이 모두 실패한 경우에만 unhealthy를 유지하며, 이후 heartbeat만으로 이를 healthy로 덮지 않는다. 늦은 Health Current publication은 pending을 회복한다. reconnect가 겹쳐도 하나의 resync만 수행하며, 응답이 없는 경우에는 offline 이벤트를 만들지 않는다.
- BlueZ model status는 부분 관측으로 취급한다. Generic OnOff, Lightness, Health Current 실제 관측이 같은 generation의 65초 coherence window 안에 모두 모일 때만 fixture-state snapshot을 발행한다. 새 resync와 단일 model update는 새 generation을 시작하므로 Health-only, 역순, 누락 또는 stale counterpart가 밝기 `0`, power-off, online 상태로 DB를 오염시키지 않는다.
- BlueZ 자발 status는 확인된 primary unicast address가 fixture mapping과 일치할 때만 처리한다. Health Current Fault(`0x04`)만 operational fault로 반영하며, Current를 실제 관측하기 전에는 online/fault snapshot을 확정하지 않는다. Registered Fault(`0x05`)와 no-fault byte `0x00`는 장애 상태를 만들지 않는다. gateway는 assignment의 site/gateway 범위를 payload에 주입해 MQTT v2 fixture-state로 발행하고, unknown address는 폐기한다.
- gateway는 Health Current의 숫자 fault code와 실제 관측 시각을 MQTT v2 `health` 객체로 전달한다. API는 `0x00` 제거, 중복 제거와 정렬 후 `Fixture.healthFaultCodes`, `Fixture.healthLastSeenAt` 최신 snapshot에 저장하며 Health가 없는 명령 결과 이벤트는 기존 snapshot을 지우지 않는다.
- 층별 fixture API와 dashboard는 Health snapshot을 `{ faultCodes, observedAt }` 또는 `null`로 반환한다. fault가 하나라도 있으면 조명 상태와 제어 가능 여부를 장애로 취급하고, 모니터링 상세 패널은 `정상`, `장애 (fault code)`, `확인 대기`와 Health 수신 시각을 표시한다.
- ESP32-H2의 application-driven Sensor Status는 shared publication buffer가 아니라 pinned ESP-IDF v5.5.1의 repository-patched server-send 경로를 사용한다. Payload/context를 API thread에서 all-or-nothing snapshot하므로 allocation/envelope/queue-post 실패는 handler 실행 없이 동기 오류가 되고, queue 수락 후에는 기존 BTC handler가 두 snapshot을 한 번 해제한다. 연속 current/recovery Status는 호출별 snapshot을 보존하며 Gateway가 설정한 NetKey/AppKey, publication address, TTL, credential, SZMIC를 사용한다. Stack period/retransmit가 `0`이 아니면 firmware readiness가 fail-closed하므로 잘못된 Config에서 상태 전송을 시도하지 않는다.
- 모니터링 응답과 incident 판정은 Site별 `gatewayOfflineAfterSeconds`(기본 90초), `fixtureStaleAfterSeconds`(기본 1,200초)를 사용한다. 정확한 threshold 경계는 fresh, 1ms 초과는 offline/stale이다. `reportedStatus/reportedStatusReason`에 마지막 수락 장비 보고를 보존하고, `Gateway.lastHeartbeatAt`과 `Fixture.lastSeenAt` 서버 수신 시각으로 표시 상태를 계산한다. 기존 `status/statusReason`은 Commands·Identify가 사용하는 고정 90초/1,200초 운영 freshness로 유지한다.
- `provisioning_waiting_state` fixture는 freshness 변경에서 제외한다. Gateway offline이 우선하며, Gateway가 복구됐지만 조명 수신이 오래되면 이미 offline인 조명도 즉시 `gateway_offline → fixture_stale`로 전환한다. `fixture_stale`은 현재 online Gateway에 매핑된 조명에만 적용한다.
- dashboard와 층별 fixture page는 서버 `generatedAt`을 응답마다 한 번 고정한다. dashboard는 `monitoringPolicy:{gatewayOfflineAfterSeconds,fixtureStaleAfterSeconds}`도 반환하며 현장 없는 기본 응답은 90/1,200초 정책을 포함한다. 모든 표시용 Gateway `connectionStatus`는 현장 정책을 사용한다. `controllable/controlBlockReason`과 등록·식별·제어 안전성의 90초 기준은 유지한다.
- API freshness sweep은 외부 장치 polling이 아닌 30초 내부 worker다. 실행 중 다음 tick을 건너뛰며, 20분 exactly는 fresh이고 마지막 성공 수신 뒤 20분 + 1ms부터 stale로 판정한다. 현장별 transaction은 획득 대기 2초/실행 5초로 제한하며, 실패한 현장만 rollback하고 식별자·원문 없는 정제 오류를 기록한 뒤 다음 tick에서 재시도한다. `Site → Gateway → Fixture → Incident` 순서로 잠그고 고정 운영 상태 변경과 Site 정책 incident reconcile을 같은 transaction에서 commit한다. Gateway `FOR NO KEY UPDATE`는 heartbeat 변경을 직렬화하면서 상태 수집의 Gateway FK key-share를 허용한다.
- Gateway당 `gateway_offline` 하나, online Gateway 소속의 오래된 조명에 `fixture_stale`, Health Current fault에 `fixture_fault`, 마지막 수락 보고 사유에 `command_failed` 이력을 생성한다. command 실패는 Gateway/Fixture freshness 만료와 독립적으로 유지되고, 이후 실제 fixture-state 보고가 다른 사유로 수락될 때 해소된다. 계속 관측되면 `lastObservedAt`만 전진시키고 확인·담당·사용자 수정 revision은 유지한다. 조건 해소는 `automatic_recovery`로 해결하고 `activeKey`를 null로 바꾸며, 재발은 새 occurrence로 기록한다. Site 잠금과 unique active key가 중복 활성 이력을 차단한다.
- 30초 Site 정책으로 모니터링이 offline을 표시해도 제어·식별의 고정 90초 안전성 경계는 바뀌지 않는다. 반대로 300초 Site 정책은 고정 운영 상태가 offline이 된 뒤에도 마지막 보고 online을 300초 경계까지 표시할 수 있다. 모니터링 상태와 `controllable/controlBlockReason`은 서로 다른 정책의 결과다.
- dashboard fixture 응답에 소유 gateway ID/이름/연결 상태와 `controllable`, `controlBlockReason`을 포함한다.
- Gateway startup resync는 command 이력을 상태로 재발행하지 않고, 확인된 fixture마다 실제 Mesh status 응답을 새 sequence로 반영한다.
- Gateway MQTT runtime은 MQTT close에서 heartbeat timer를 즉시 정리해 disconnected 상태의 healthy 기록과 offline heartbeat 적재를 막고, reconnect마다 하나의 timer만 다시 시작한다. persistent session 재접속(`sessionPresent=true`)에는 command topic을 다시 구독하지 않는다. 모든 command/provisioning topic handler 오류는 MQTT event loop 밖으로 새지 않도록 오류 경계에서 health 오류로 기록하며, SIGTERM/SIGINT 종료 시 timer, client listener와 MQTT client를 정리한다.
- MQTT certificate rotation은 old client quiesce와 identity pointer commit 뒤 candidate를 runtime current client로 지정한 다음 broker에 연결한다. CONNACK 전 실패만 old identity/client로 rollback하고, CONNACK 뒤 subscription 실패는 candidate authoritative 상태에서 fail-closed 해 old session command replay를 막는다. dimming·scan·identify·provision handler는 각 MQTT message source client로 결과를 발행한다. pointer write/fsync와 restore가 모두 실패하면 candidate generation을 보존하고 runtime을 fail-closed 한다. appliance health는 D-Bus owner, 실제 `Node1` interface introspection, HCI powered bit, mapping JSON parse, 마지막 heartbeat publish freshness를 실제 probe해 기록하며 future heartbeat와 잘못된 heartbeat interval은 unhealthy로 처리한다.

## 미구현

- 첫 sweep 전 과거 장애 backfill은 하지 않는다.

- WebSocket/SSE 기반 push 실시간 업데이트
- 층별/구역별 통신 음영 heatmap
- 장애 escalation/SLA 등급과 외부 알림 연결
- 차량 감지 이벤트 표시
- 이벤트 타임라인
- 게이트웨이별 커버리지 표시
- 여러 게이트웨이가 같은 층을 담당할 때의 경로/coverage 시각화
- 조명 등록 중 provisioning 진행률 표시
- 모니터링 화면 내 빠른 밝기 제어

## 부족하거나 개선이 필요한 기능

- 수동 장치 확인의 물리 BIO USB 동글·조명 2대 연결 증거가 없어 이번 작업의 HIL은 미수행이다. 후속 현장 절차는 두 대 online → 한 대 실제 전원 차단 → 새로고침 → `정상 1 / 오프라인 1` → 전원 복구 → 새로고침 → `정상 2 / 오프라인 0`이며 Gateway 버전/API revision·가린 장비 identity·시각·결과를 기록해야 한다. 자동 unit/Chromium route fixture와 lab 발행 terminal은 실제 two-pass RF/USB 검증을 증명하지 않는다.
- 실제 API/PostgreSQL/Redis/MQTT transport 회귀는 `E2E_REAL_BACKEND_LAB=1 pnpm --filter @led-control/web exec playwright test e2e/real-backend-lab-support.spec.ts --project=chromium`으로 opt-in한다. PostgreSQL 도구·Redis·Mosquitto·OpenSSL과 API/Web build가 필요하며 미설정 시 해당 transport 시나리오는 명시적으로 skip한다. 환경이 준비돼 실행한 실패는 skip 또는 HIL 성공으로 바꾸지 않는다.
- 2026-09-18 Task 7 검증: retention 단위 6개·disposable PostgreSQL 42개, 기존 조회 fixture 보정 33개, monitoring Chromium 32개, lab 지원 17개(transport opt-in 1개 제외; ACK payload 계약·식별자 음성 회귀 포함), 실제 Docker Mosquitto persistence/운영·개발 ACL 3개가 통과했다. 정식 lint/typecheck/build와 opt-in lab 기동은 기존 CAD `confirmMapReset` 누락에 막히며 root test는 기존 CI cgroup 기대값 불일치로 실패한다. 이를 우회하지 않는 정식 명령은 실패 상태로 남긴다. 별도 일회성 진단에서 Web 타입 검사만 Vite build로 대체한 lab transport 1개는 실제 API POST/GET·MQTT application ACK·`정상 1 / 오프라인 1`·동일 결과 재전송 멱등성·새 presence의 `정상 2 / 오프라인 0` 복구를 통과했다. 진단 우회 코드는 제거했고, 이 결과를 정식 build 통과나 물리 장비 HIL로 확대하지 않는다.

- 모바일 두 손가락 확대·축소, marker hit 및 pointer-capture 경로는 Web PointerEvent와 synthetic Chromium으로 검증했다. 실제 iOS/Android WebView의 safe area, gesture arbitration, native click 전달과 장시간 현장 사용성은 실기기 확인이 필요하며, 이는 BLE/Mesh·firmware·물리 조명 HIL 검증이 아니다.

- 공통 디자인 시스템 이전은 deterministic Vitest와 Chromium route fixture를 기준으로 검증한다. 실제 현장 도면의 수동 시각 QA와 Raspberry Pi/ESP32-H2/LED 연결 HIL 결과는 포함하지 않는다.

- 자동으로 저장되는 인시던트 이력과 현장별 판정 기준을 사용자 화면에서 관리하는 UI는 제공하지 않는다. 필요해질 경우 일반 사용자 모니터링과 분리된 내부 운영자 화면으로 별도 설계해야 한다.
- 원장 정리 worker는 생성 후 7일보다 오래된 heartbeat와 30일보다 오래된 fixture state를 최신 Gateway/Fixture snapshot·watermark 및 fixture energy cursor가 해당 기록을 포괄할 때만 삭제한다. superseded capability는 365일 정책이며 전체 이벤트는 sweep당 합산 최대 10,000개다. cutoff와 같은 시각, scope/hash가 없는 legacy 원장, 삭제된 fixture·누락된 cursor 등 안전 조건을 증명할 수 없는 기록은 보존한다. watermark는 stream별 최신 identity만 유지하므로 임의 과거 ID의 exact dedupe는 raw 원장이 남아 있는 기간에 의존한다. 세부 조건은 [DB 보존 문서](../database-schema.md#운영-데이터-보존과-복구-범위)를 따르며 사용자/운영 DB migration 적용과 실장비 replay HIL은 아직 실행하지 않았다.
- 플랫폼 운영 배포 절차는 [API·Web runbook](../runbooks/production-api-web-deployment.md)을 따른다. 단일 호스트 Compose, 외부 Vault·공개 MQTT/Object Storage 연결, 장비 mTLS 공개 SAN, CRL 갱신 후 수동 broker SIGHUP, API 교체 후 nginx upstream 재해석·재시작이 운영 조건이다. Process-local 지표만 제공하며 외부 metrics/dashboard/alert/log shipping은 구성하지 않았다. 운영 배포·사용자 DB 적용·실장비 HIL과 native WebView·수동 시각 QA는 이번 자동 검증에 포함하지 않는다.

- 1440/390/320px 결과는 Chromium 자동 브라우저 software 증거다. 실제 iOS/Android native WebView, 수동 in-app 시각 QA, WebView safe-area 실측 또는 Raspberry Pi/ESP32-H2 HIL을 수행한 결과가 아니다. Lazy chunk 실패의 복구 UI는 플랫폼 Task 3에서 구현했으며, prefetch/offline cache는 후속 범위다. Task 3 오류 주입은 Vite에서 실제 앱 셸의 동적 import 요청을 차단한 deterministic Chromium 결과이며, 운영 CDN/container 배포나 실제 backend 장애·HIL 검증을 의미하지 않는다.
- 지도 배율과 스크롤 위치는 현재 화면 세션 상태이며 층 전환·새로고침 시 100% 화면 맞춤으로 초기화된다. 사용자별 마지막 viewport를 저장하는 기능은 제공하지 않는다.
- 저장 도형 표시 회귀는 deterministic route fixture Chromium에서 검증한다. mock snapshot과 브라우저 합성 결과를 확인하는 범위이며 실제 Gateway, Raspberry Pi, ESP32-H2 또는 현장 도면의 HIL 검증은 아니다.
- 테스트 데이터는 설정 개요의 설치 완료 assigned `admin` 전용 개발·검증 도구이며, 기본 off 상태이고 API도 비활성화 시 404를 반환한다. 따라서 표시되는 online 상태는 일시적 recent online일 수 있고 freshness 재집계 뒤 offline이 될 수 있으며, 실제 Gateway·Mesh·MQTT 상태나 HIL 검증 증거로 해석할 수 없다.
- 개별 `provision-device`의 API DB transaction -> MQTT PUBACK과 Gateway RF 전 durable accept, terminal atomic 저장, exact `device-terminal-ingested` ACK 전 bounded replay는 software로 구현됐다. 다만 이 ACK를 생성하는 API terminal ingest/ACK outbox는 Task 3 범위여서 현재 production 통합에서는 device terminal이 계속 pending replay로 남는다. API/Gateway 프로세스 전원 차단 전체 구간의 자동 수렴과 실제 broker/Raspberry Pi/ESP32-H2 재시작 HIL은 Task 3 이후 검증해야 한다.
- pending redirect와 admin commissioning은 React/Vitest 회귀와 Task 9 격리 실백엔드 Chromium E2E로 검증했다. Calm Operations 모바일 390px/320px의 화면 계층·overflow·touch target은 route fixture로 검증했지만, 실제 WebView safe-area와 재설치는 별도이며 Raspberry Pi/ESP32-H2 HIL은 아직 실행하지 않았다.
- 모니터링 화면과 Gateway BIO full-resync는 모두 10분 polling 정책이다. publication 반영 직후 확인이 필요하면 수동 새로고침을 사용할 수 있으며 push는 제공하지 않는다. 10분 주기 사이에는 최대 20분 동안 마지막 성공 presence를 fresh로 표시할 수 있다.
- durable state outbox의 파일 권한·용량 차단과 application ACK 재전송은 자동 테스트로 검증했지만, 실제 broker/API 재시작과 Raspberry Pi 전원 차단을 포함한 HIL은 아직 실행하지 않았다.
- Health 수신 경로는 최신 Current snapshot을 보존하며, fault 발생·해제 이력은 다음 freshness sweep에서 자동 반영한다. Health 관측 이력 전체를 별도로 저장하는 범위는 아니다.
- 조명 provisioning 진행 상태는 session polling으로 반영하고, 사용자가 등록 세션을 완료할 때 dashboard query를 갱신한다. WebSocket/SSE push는 명시적으로 보류한다.
- incident는 수집 event와 동시에 생성되지 않고 다음 30초 sweep에서 수렴한다. 고정 운영 상태 변경과 reconcile 사이의 commit 간격은 없지만, 현장 간에는 개별 transaction이며 sweep 실행 시간·잠금 대기·실패 시 반영이 늦어질 수 있다. sweep은 잠금 후 시각을 다시 샘플링한다. 모니터링은 마지막 장비 보고를 Site 정책으로 다시 계산하므로 heartbeat 복구 후 보고 시각이 아직 fresh이면 표시 상태도 복구한다.
- `20260912110000_fixture_reported_state` migration은 기존 운영 상태/사유를 reported 컬럼으로 보수적으로 복사한다. 과거 sweep이 이미 덮어쓴 실제 보고는 복원할 수 없으며 다음 수락 fixture-state부터 보존된다. migration 뒤 모든 상태 수집 API를 새 버전으로 교체해야 보고 필드가 계속 갱신된다. 구버전 API와 장기 혼용하는 배포는 지원하지 않으며 사용자 DB에는 이번 migration을 적용하지 않았다.
- dashboard와 fixture page의 `generatedAt`은 각 응답의 판정 기준 시각이며 여러 SQL 조회·페이지를 하나의 DB snapshot으로 묶는 보장은 없다. 대규모 현장의 전체 대상 row 잠금 비용과 장기 부하는 별도 운영 검증이 필요하다.
- 5분 future gate, durable terminal rejection, 서버 수신 시각 freshness, 에너지 발생 시각 순서는 Shared/API/Gateway의 mock·software 자동 회귀와 disposable PostgreSQL migration DB에서 검증하는 범위다. 실제 broker, Raspberry Pi, BlueZ Mesh, ESP32-H2/LED를 연결한 HIL이나 사용자 DB migration은 이 작업에서 수행하지 않았다.
- legacy null hash는 원본 payload와 같다는 증거가 없으므로 첫 인증 replay가 hash를 확정한다는 한계가 있다. 이후에는 exact hash만 허용하며, 새 future rejection에는 처음부터 hash가 있다. migration과 replay 보완은 과거 `Fixture.lastSeenAt`/`Gateway.lastHeartbeatAt` 및 energy 값을 재작성하지 않는다. 새 정상 event 수락 시 freshness가 서버 수신 시각으로 바뀌며, 과거 energy 오염의 소급 정정은 별도 범위다.
- `lastSeenAt` 상대 시간은 클라이언트 현재 시간 기준이므로 서버 기준 freshness와 완전히 일치하지 않을 수 있다.
- RSSI, hop count, 명령 성공률은 표시만 하며, 품질 등급이나 설치 가이드로 연결되지 않는다.
- 1,000개 marker 조회/렌더링 기준은 자동 검증하지만, 더 큰 현장에는 공간 클러스터링과 검색이 추가로 필요하다.
- 자사 UUID 검색, batch 등록, 실제 Health Current 수집을 포함한 Raspberry Pi/ESP32-H2 실장비 HIL은 아직 실행하지 않았다. 자동 route fixture 통과를 검색·등록·상태 수집의 실기 완료로 간주하지 않는다.
- Sensor server-send breaker는 actual patched source allocator fault harness와 fullclean target compile로 검증했다. 실제 device heap pressure, BTC queue saturation과 Sensor Status RF 전달은 HIL에서 확인해야 하며 software allocation test를 실장비 완료로 간주하지 않는다.
- 현재 선택 로직은 첫 장애 조명 또는 첫 조명을 자동 선택하므로, 사용자가 이전에 보던 조명을 유지하는 정책을 더 정교하게 만들 수 있다.
- 등록 패널은 `pending/scanning` 또는 provisioning 중에만 1.5초 registration session polling으로 결과를 반영한다. `reconcile_required`의 서버 상태 재조회, 명시적 제외와 세션 취소는 구현했지만 장비가 실제로 provisioned 되었는지 Gateway/BlueZ에 질의하고 자동 정리하는 기능은 없다. 현장 관리자가 장비를 확인·초기화하지 않은 채 제외하면 안 되며 이 절차는 Raspberry Pi/ESP32-H2 HIL로 검증해야 한다.
- scan lifecycle 자동 테스트는 mock MQTT와 scanner adapter를 사용한다. 실제 host Mosquitto mTLS negative ACL integration에서 Gateway CN certificate의 `acks/state-ingested`, `acks/provisioning/scan-terminal-ingested` publish 거부를 확인했다. 2026-09-18 Task 7에서는 Docker broker persistence 재시작과 운영·개발 ACL 검증 3/3을 통과해 과거 Docker daemon 부재로 인한 skip 상태를 갱신했다. 이는 소프트웨어 broker 검증이며 실제 Raspberry Pi BlueZ adapter의 scan timeout, broker/Pi/API 재시작을 가로지르는 terminal application ACK 재전달, ESP32-H2 자사 UUID 필터와 terminal event 전달은 HIL에서 별도로 확인해야 한다.

## 관련 파일

- `apps/api/src/monitoring-refresh/`
- `apps/api/src/retention/data-retention.service.ts`
- `apps/api/prisma/migrations/20260918100000_monitoring_manual_refresh/migration.sql`
- `apps/gateway/src/commands/fixture-presence-check-handler.ts`
- `apps/gateway/src/state/monitoring-refresh-journal.ts`
- `apps/web/src/api/monitoring-refresh.ts`
- `apps/web/e2e/real-backend-lab-support.spec.ts`
- `apps/gateway/docker/mqtt-persistence.integration.mjs`

- `apps/web/src/features/monitoring/MonitoringView.tsx`
- `apps/web/src/features/monitoring/MonitoringView.test.tsx`
- `apps/web/src/App.test.tsx`
- `apps/web/e2e/calm-operations-monitoring.spec.ts`
- `apps/web/src/features/shells/CustomerShell.monitoring.test.tsx`
- `apps/api/src/monitoring-incidents`
- `apps/api/prisma/migrations/20260912100000_monitoring_policy_incidents/migration.sql`
- `apps/api/src/retention/gateway-event-watermark.ts`, `apps/api/src/retention/gateway-event-watermark.integration.spec.ts`
- `apps/api/src/retention/data-retention.service.ts`, `apps/api/src/retention/data-retention.integration.spec.ts`
- [API·Web 운영 배포와 장애 대응](../runbooks/production-api-web-deployment.md)

- `apps/web/src/components/ui/AppRecoveryState.tsx`
- `apps/web/src/components/ui/AppErrorBoundary.tsx`
- `apps/web/src/AppRoot.tsx`
- `apps/web/src/App.recovery.test.tsx`
- `apps/web/e2e/app-shell-recovery.spec.ts`

- `apps/web/src/App.tsx`
- `apps/web/src/components/ui/RouteLoadingState.tsx`
- `apps/web/src/features/shells/CustomerShell.tsx`
- `apps/web/scripts/audit-schedule-bundle.mjs`
- `apps/web/e2e/site-user-management.spec.ts`
- `apps/web/e2e/site-user-management-real.spec.ts`
- `apps/api/src/site-users`

- `apps/web/src/features/transport-copy.ts`
- `apps/web/src/features/transport-copy.test.ts`
- `apps/web/src/components/ui/MetricCard.tsx`
- `apps/web/src/components/ui/PageHeader.tsx`
- `apps/web/src/components/ui/StatusBadge.tsx`
- `apps/web/src/components/ui/FeedbackState.tsx`
- `apps/web/src/components/ui/SidePanel.tsx`
- `apps/web/src/features/monitoring/MonitoringView.tsx`
- `apps/api/src/test-data/test-data.controller.ts`
- `apps/api/src/test-data/test-data.service.ts`
- `apps/api/src/test-data/test-data.controller.spec.ts`
- `apps/api/src/test-data/test-data.service.spec.ts`
- `apps/web/src/features/settings/TestDataToolsPanel.tsx`
- `apps/web/src/api/test-data.ts`
- `apps/web/src/features/monitoring/FloorMap.tsx`
- `apps/web/src/features/monitoring/FloorMap.test.tsx`
- `apps/web/src/features/floor-map/FloorMapViewport.tsx`
- `apps/web/src/features/floor-map/FloorMapViewport.test.tsx`
- `apps/web/src/features/floor-map/map-gestures.ts`
- `apps/web/src/features/floor-map/map-gestures.test.ts`
- `apps/web/src/features/floor-map/FloorScene.tsx`
- `apps/web/src/features/floor-editor/FloorEditorView.tsx`
- `apps/web/src/features/floor-editor/editor-monitoring-cache.ts`
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
- `apps/web/e2e/settings-floor-editor.spec.ts`
- `apps/web/playwright.config.ts`
- `apps/web/src/api/queries.ts`
- `apps/api/src/sites/sites.controller.ts`
- `apps/api/src/sites/sites.service.ts`
- `apps/api/src/access/site-access.service.ts`
- `apps/api/src/fixtures/fixtures.service.ts`
- `apps/api/src/fixtures/fixture-health.ts`
- `apps/api/src/mqtt/mqtt.service.ts`
- `apps/api/src/mqtt/legacy-gateway-event-replay.ts`
- `apps/api/src/mqtt/mqtt.service.spec.ts`
- `apps/api/src/mqtt/mqtt.module.ts`
- `apps/api/src/mqtt/mqtt-shutdown-coordinator.service.ts`
- `apps/api/src/mqtt/mqtt-shutdown-coordinator.spec.ts`
- `apps/api/prisma/schema.prisma`
- `apps/api/prisma/migrations/20260826170000_add_discovered_node_scan_identity/migration.sql`
- `apps/api/src/mqtt/provisioning-scan-outbox-publisher.service.ts`
- `apps/api/src/mqtt/provisioning-scan-outbox-publisher.service.spec.ts`
- `apps/api/src/mqtt/provisioning-device-outbox-publisher.service.ts`
- `apps/api/src/mqtt/provisioning-device-outbox-publisher.service.spec.ts`
- `apps/api/prisma/migrations/20260905090000_add_provisioning_device_outbox/migration.sql`
- `apps/api/src/mesh-control-groups/mesh-control-group.service.ts`
- `apps/api/src/mesh-control-groups/mesh-group-sync.worker.ts`
- `apps/api/src/mesh-control-groups/mesh-group-sync.worker.spec.ts`
- `apps/gateway/src/mesh/bluez-mesh-adapter.ts`
- `packages/shared/src/gateway-contracts.ts`
- `packages/shared/src/gateway-contracts.test.ts`
- `packages/shared/src/schemas.test.ts`
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
- `apps/api/src/fixtures/fixture-freshness.service.spec.ts`
- `apps/api/prisma/migrations/20260912110000_fixture_reported_state/migration.sql`
- `apps/api/src/monitoring-incidents/monitoring-control-boundary.integration.spec.ts`
- `apps/api/src/energy/fixture-state-ingestion.service.ts`
- `apps/api/src/energy/fixture-state-ingestion.service.spec.ts`
- `apps/api/src/energy/fixture-state-ingestion.integration.spec.ts`
- `apps/api/src/mqtt/mqtt-v2-state.spec.ts`
- `apps/api/prisma/migrations/20260912090000_gateway_event_received_time/migration.sql`
- `apps/gateway/src/state/state-event-outbox.test.ts`
- `apps/gateway/src/state/event-sequence-store.ts`
- `apps/gateway/src/state/provisioning-scan-journal.ts`
- `apps/gateway/src/state/provisioning-device-journal.ts`
- `apps/gateway/src/state/provisioning-device-journal.test.ts`
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
