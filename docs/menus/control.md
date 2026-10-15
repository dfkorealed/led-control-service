# 제어 메뉴 기능 현황

## 2026-10-15 독립 Mac clock producer — 소프트웨어

### 구현 완료

- 별도 비로그인 `_kinda_clock` 계정용 launchd installer와 독립 시각 producer, UID0 관리자 `status/probe/approve` 도구를 구현했다. API UID는 kernel peer 확인 후 `read`만 허용한다. Root 보호 설치물/config·full artifact hash·정확 primary/process·sleep 포함 counter·100ms 관측과 요청 직전 재관측을 검증한다.
- 원 SNTP 시작시각을 유지하고 stdout/stderr/exit/750ms deadline을 분리 검증한다. In-flight 공유, 1초 미만 캐시/실패 backoff, single-producer lock, 세대4개 원자 저장, 시작/step/primary 변화 뒤 독립3표본과 exact 관측 관리자 승인을 적용한다. 잘못된/늦은/불완전 증거는 새 시작 허가로 바꾸지 않는다.
- 검토 보완: IPC 수신·송신마다 전체 1초 마감시간의 잔여값을 적용하고 취소 시 socket shutdown으로 대기 I/O를 깨운다. Daemon/operator/root installer는 local module import 전에 ancestor와 sibling의 ACL까지 확인한다. 지연 socketpair와 ACL 주입 sentinel 회귀로 검증했다.

### 미구현

- 실제 관리자 설치·서비스 기동·독립 UID의 native 프로세스 가시성·실시간 SNTP 건강·API reader 연결과 운영 승인 증거는 후속 단계다. 이번 테스트는 주입한 clock/command/socket 및 임시 파일만 사용했다. 실제 밝기 SET·시간제 시작/종료·센서 HIL은 실행하지 않았다.

### 부족하거나 개선이 필요한 기능

- 일반 SNTP는 NTS 인증 증명이 아니며 관리 호스트/네트워크를 신뢰한다. Remote/Docker VM DB와 epoch continuity는 지원하지 않는다. API의 동일 transaction primary 비교와 V3 적용 확인·MQTT·Gateway 운영 관문이 별도로 필요하다. Timeout을 늘리거나 UID/파일 권한을 넓혀 건강 판정을 만들지 않는다.

### 관련 파일

- `scripts/clock-attestor/{core.py,daemon.py,installer.py,operator.py,protocol-v1.json,test_daemon.py,test_installer.py}`, `scripts/clock-attestor/fixtures/evidence-v1.json`, `docs/runbooks/production-api-web-deployment.md`.

### 갱신 규칙

- 소프트웨어 테스트, 관리자 설치, 3표본/exact 승인, API 연결, 실장비 결과를 구분해 갱신한다. Fresh receipt·hash·primary를 재확인하며 credential이나 승인 관측을 재사용 가능한 설정으로 문서화하지 않는다.

## 2026-10-15 공휴일 보호 파일·provider 연결 — 소프트웨어

### 구현 완료

- 서버 전용 `KASI_HOLIDAY_SERVICE_KEY_PATH`에서 절대 경로의 현재 API UID 소유 regular 0600 키 파일과 상위 0700 디렉터리를 확인해 기존 `KasiHolidayProvider`를 실제 `HOLIDAY_PROVIDER` factory에 연결한다. Symlink와 잘못된 권한·형식·파일 오류는 키/경로/URL 출력 없이 unavailable이며 API 부팅은 계속한다.
- 기존 최초 당해/다음해와 일일 갱신, 12개월/모든 페이지·빈 월 검증, 같은 transaction의 pointer·revision·snapshot 승격을 유지한다. 한국 연도 전체의 실제 휴일이 0개면 새 coverage 승격과 기존 빈 캐시 소비를 거절하고 정상 검증 캐시를 보존한다.

### 미구현

- 실제 보호 키 설정·provider 수집·2026/2027 coverage 승격과 운영 API 재시작은 아직 실행하지 않았다. 테스트는 생성한 임시 키와 자기 소유 disposable PostgreSQL만 사용한다.

### 부족하거나 개선이 필요한 기능

- 실제 연결 전 두 연도의 완전 coverage, 공식 제공 범위/할당량과 기존 키 승인 유효성을 확인해야 한다. 누락 coverage는 평일로 간주하지 않으며 clock·V3 ACK·MQTT·Gateway/HIL의 별도 운영 관문도 유지한다.

### 관련 파일

- `apps/api/src/automation/holiday-provider-config.ts`, `holiday-provider-config.spec.ts`, `automation-runtime.module.ts`, `holiday-dataset.service.ts`, `holiday-dataset.service.spec.ts`(앞 두 파일과 같은 디렉터리), `.env.example`, `docs/runbooks/production-api-web-deployment.md`.

### 갱신 규칙

- 소프트웨어 fixture 검증과 실제 키 설정·수집·coverage 승격 증거를 구분한다. 키 값·원문 URL/오류 body는 문서·로그·클라이언트에 기록하지 않는다.

## 2026-10-15 메인·DB 반영 및 로컬 서비스 복구 완료

### 구현 완료

- 지정 ‘제어 UI 개선 담당자’와 시간제 제어/API 연결, 달력 대체 보기·띠/주말·휴일 제외, 목록/달력/이벤트 공통 추가 위치, 저장 구역·단일 하단 이력 및 모바일 지도/HTTPspinner를 통합했다. 독립 한정 검토 C/I0이며 직접6파일392PASS/기존5FAIL·5E2E·Webtype/UI/build를 확인했다. 업무모드 등 제거 기능은 복원하지 않았다.
- 별도 브랜치에서 로딩69변경을 보존·통합한 뒤 로컬 메인848dec0c에 merge했다. 사용자 AGENTS/랜딩/감사 변경은 unstaged로 보존했다. DB는 full custom backup 후138→139migration·기존119개 데이터 table의 행 수/hash 불변·신규8개 table/default/schema를 확인했다. 실제 main API client/type/build는 exit0이다.
- 추가사용자승인뒤기존API/Web/brokergroup을정확정상종료·같은환경/인증서/ACL재사용으로재기동했다. 새ownedgroupactualAPIlive/ready200/5up·Web200과총괄의독립검사·실제스케줄목록1건/달력1건읽기를확인했다. Static22file·1592제품/보호source 및4dirty는동일, Gateway/RF명령/설정생성/PKI/ACL변경·DB재적용·백업삭제는0이다. 원실패와복구제약은기록에유지한다.

### 미구현

- 기존watcher stale33/감시컴파일66오류·mtime-only1회실패는후속승인group재기동으로해소했다. 로컬API는정상이며이는모든기능·실장비사용준비완료와다르다. 다음실사용관문은아래와같다.
- Gateway/Pi 배포·USB/RF/HIL·운영clock attestor·현재 V3 적용확인·신규 MQTT scope/ACL·공휴일 ServiceKey/provider 연결은 아직이다. 시간제 새시작은 clock 미등록503/V3 미적용409 안전 관문을 유지하며 누락된 휴일 coverage를 평일로 간주하지 않는다.

### 부족하거나 개선이 필요한 기능

- 기존 ControlView5실패, 최종 Minor6와 색상/bundle경고는 유지한다. 이번 최소 검증을 전체 suite·실제 장비 성공으로 확대하지 않는다. Backup archive-list는 통과했지만 복원 drill은 하지 않았고 새 백업은 삭제하지 않았다.
- Persistentruntime12739의leader-onlySTOP은pnpmleaf orphan화를완전히막지않는다. `.local/bio-control-operations-runtime-20261015-zK0GOuyo/stop-owned-group.mjs`의현재신원/descendant관문·leaf-first정상TERM뒤STOPPED/EXIT를사용한다. Syntax/읽기전용owner검사만통과, live중지시험은하지않았으며신원이바뀌면재검토한다. 실행소스/원증거는feature삭제와분리해main.local에보관한다.

### 관련 파일

- `docs/database-schema.md`, `docs/project-status.md`, `docs/superpowers/plans/2026-10-14-bio-control-operations.md`와 위/아래 태스크별 제어 파일. 원증거는 `.local/bio-control-operations-evidence-20261015-L10bFdB0`에보존한다.

### 갱신 규칙

- 코드/UI·DB 실제 적용·API 가용성·Gateway/HIL 준비를 분리해서 기록한다. API 복구와 승인 범위가 확정될 때 상태판·체크리스트·이 문서를 같은 결과로 갱신한다. 아래 미적용/대기 문장은 중간 이력이며 현재 결과는 이 절을 우선한다.

## 2026-10-15 최종 리뷰: 전달 만료·이벤트 보류·서울 연도 경계

### 구현 완료

- 시간제 Start의 전달 권위는 원 command/hash/startedAt/endsAt와 분리해 큐와 실행기까지 전달한다. 비동기 clock/preflight·저장 이후와 최종 native 제출에서 전달/세션 만료의 기존 2,000ms 여유, 같은 부팅 monotonic deadline, 최근 신뢰 clock sample을 검사한다. 만료 후 새 적용 SET은 차단하고 이미 필요한 종료·복귀는 계속 처리한다. 재전송은 원 종료 시각을 연장하지 않는다.
- 임시 lease 때문에 적용하지 않은 이벤트 대상은 activation의 `skippedFixtureIds`에 미변경 근거를 영속 보존한다. 종료 시 RF/readback을 만들지 않고 기존 wire의 superseded/null로 처리해 이벤트 소유권을 닫는다. 과거 uncertain mutation은 건드리지 않으며, 진행 중 lease 해제 후 적용할 때는 capture 전에 skip 근거를 영속 제거한다. 재시작·명시 종료와 이후 스케줄 실행을 검증했다.
- 공휴일 변경 승격의 영향 Gateway를 서울 civil year 경계로 선택해 1월 1일만 포함하는 일정도 최신 dataset/revision/outbox를 받는다. 실제 자기 소유 PostgreSQL에서 pointer·revision·outbox의 같은 transaction 승격과 실패 시 전체 rollback을 확인했다.
- NB1의 historical skip 검사는 완료된 A의 RF0 근거와 이후 다른 activation의 capture를 구별한다. 진행 중 skip의 과거 미해결 mutation 차단과 같은 activation의 모순 차단은 유지하며, 완료된 A의 proof는 삭제하지 않는다. 실제 A 미적용·완료→임시 settlement→snapshot 규칙 B 교체→새 pulse→정상 preState capture·70% 설정 및 파일 재시작을 직접 검증했다.

### 미구현

- 운영 배포·실제 DB migration·clock attestor/provider/ACL 연결·실장비 USB/RF/HIL은 수행하지 않았다.

### 부족하거나 개선이 필요한 기능

- 확인은 지정 Gateway 5개 파일 164개 테스트, API의 지정 snapshot/promotion/rollback 16개 테스트와 두 package 타입 검사 범위다. 전체 suite·build·광출력·전원 장애 복귀의 완료 증거로 확대하지 않는다. 최종 리뷰의 별도 Minor 및 기존 Web ControlView 실패는 이 수정 범위 밖의 제한으로 남긴다.
- NB1 추가 수리 검증은 기존 store/production integration 두 파일 96개 테스트와 Gateway 타입 검사에 한정한다. 이전 164개/API/Web/build 전체를 재검증한 결과가 아니며, 총괄의 승인된 한정 재검토와 별도 운영 관문은 남아 있다.

### 관련 파일

- Gateway `automation/{temporary-control-mqtt,bio-temporary-control-runtime,bio-pulse-scheduler,automation-state-store}.ts` 및 직접 관련 MQTT/임시 적용·복귀/production integration/store 테스트.
- API `automation/automation-snapshot.service.ts`, `automation/{automation-snapshot.service,holiday-dataset.service}.spec.ts`.

### 갱신 규칙

- 전달 권위·clock guard·skip 증거·서울 연도 경계를 바꾸면 동일 caller/consumer의 지연·부분 쓰기·재시작·transaction rollback 회귀와 이 문서를 함께 갱신한다. 운영·HIL 완료는 별도 증거가 필요하다.

## 2026-10-15 Web BIO 시간제 제어·통합 이력·선택 연결

### 구현 완료

- 기존 기본 밝기 요청은 별도 영구 제어 경로로 유지한다. BIO 설정이 확인된 대상의 시간제 실행은 기본/시간제 선택,15/30/60/120분 preset, 정수1~1440분 입력, 고정 대상/밝기/기간 미리보기와 별도 시작 API를 사용한다. PC 기존350px 실행 패널과 모바일4열 실행행/More를 유지하며 기간 입력은 밝기 raw 검증 영역 밖에 있다.
- root ControlView의 별도 시간제 owner가 접수/적용/유지/부분/불확정/복귀/복귀 미확인/서버 완료를 소비한다. 최소 복구 식별자를 영구 Command 저장소와 분리 보존하고 재시작은 GET, 응답 유실 POST는 명시적인 동일 요청 확인으로만 재조회한다. 자동 새 시작/기간 연장/영구 제어 fallback은 없다. 입력·대상과 추가 적용은 unresolved 동안 잠근다.
- 종료는 사용자 확인 뒤 별도 end API로 요청하며 lost End의 clientRequestId를 재사용한다. 서버 immutable startedAt/endsAt와 대상별 설정/부분 변경·복귀 evidence를 표시한다. 카운트다운0/HTTP202는 복귀 확인이 아니며 이전 GET가 종료 revision을 되돌리지 않는다. 권한/site/principal 변경은 이전 요청 응답을 현재 scope에 표시하지 않는다.
- 시작 응답이 유실된 뒤 명시적 재확인의 4xx는 과거 미접수 증거로 취급하지 않는다. 원 clientRequestId/body와 안전 잠금을 유지하고 권한 회복 후 같은 요청으로 복구한다. 시간제 미리보기는 hook과 같은 사용자·역할·제어 권한·유효 현장 범위에 결속해 범위 변경 때 폐기하고 표시·확인 단계에서도 재검사한다.
- 수동 이력의 유일한 node를 workspace 최하단 전체폭으로 옮겼다. 기본/시간제 중 최신 한 건과 전체보기 한 개를 같은 ticker/Drawer로 표시하고 내부 종류별 조회·cursor·상세를 분리한다. 시간제 DTO를 Command로 cast하지 않는다. 원래 기본 상세와 관측/재송신/미확정 복구 기능은 유지하되 확인 필요한 명령 footer 버튼을 제거하고 Drawer에서 기존 복구 경로에 접근한다.
- 저장된 구역 선택 옵션을 실제 대상 목록 앞에 배치하고 기존 resolve/onChange→2대 멤버→실제 지도 강조→실행 대상 경로를 유지한다. 새 셸·지도·업무 모드·휴일 관리 기능은 만들지 않았다.
- 스케줄 Switch의 실제 focus 경계에서 해당 Dialog 배경만 스크롤하지 않게 제한하고 visible field 전체를 내부에서 노출한다. 닫을 때 원 inline 경계를 복원하며 공통 Dialog/전역 CSS/다른 overlay에는 적용하지 않는다.

### 미구현

- 운영 DB migration·실제 API/Gateway 배포·clock attestor/provider 설정·물리 장비 USB/RF/HIL은 실행하지 않았다. 로컬 제품 병합 및 운영 반영은 총괄 후속 관문이다.

### 부족하거나 개선이 필요한 기능

- 서버 historical settlement/설정 readback은 현재 광출력 증거가 아니다. 불확정·partialMutation·복귀 실패는 잠금을 유지하며 브라우저 시간이 끝나도 복귀 성공을 합성하지 않는다. 장치/Gateway 전원 차단 중 정확한 복귀 시각은 보장하지 않는다.
- Web 검증은 직접 unit과 실제 React→자기 fixture HTTP의 승인4개 E2E 경계다. fixture 성공을 실제 DB/브로커/장비 검증으로 확대하지 않는다. 기존 ControlView 알려진 실패와 Task8 deferred Minor는 최종 보고서/총괄 리뷰에서 별도로 기록한다.

### 관련 파일

- `apps/web/src/api/temporary-controls.ts`, `features/control/{useTemporaryControlSession,TemporaryControlPanel,TemporaryControlHistory,ControlView,ManualExecutionPanel,CommandHistoryPanel}`, `target-selection/SpatialTargetSelector`, `automation/ScheduleDialog`와 직접 관련 테스트.
- `apps/web/e2e/bio-control-operations.spec.ts`, `apps/web/playwright.bio-control-operations.config.ts`, `apps/web/e2e/support/bio-control-operations-server.mjs`.

### 갱신 규칙

- 시간제 DTO/복구 식별자/절대 시각/부분 설정/권한·세대·이력 종류를 바꾸면 직접 회귀와 이 문서를 함께 갱신한다. fixture/실장비·software/local merge/운영 적용은 각 증거가 있을 때 분리 기록한다.


## 2026-10-15 Web 서버 달력·일정별 제외·공통 추가 행

### 구현 완료

- 스케줄 목록/달력의 왼쪽 보기 전환과 오른쪽 추가 버튼, 이벤트의 오른쪽 추가 버튼을 같은 공통 상단행으로 연결한다. 화면별 추가 버튼은 한 개이며 권한·로딩·변경 잠금과 원본 Dialog 포커스 복귀를 유지한다. 검색/필터/페이지 이동은 목록에서만 보이고 스케줄 필터 초기화만 제거한다. 이벤트 필터 초기화는 유지한다.
- 달력은 전용 서버 API의 `complete:true`·revision·전체 schedules·occurrences를 소비하며 목록 검색/페이지에서 합성하지 않는다. 현장 시간대의 표시 월과 앞뒤 월 spill을 포함한 1~42일을 조회한다. 서버 발생 시작일만 정렬·중복 제거하고 빈 날짜/주 경계에서 띠를 분할하며 이름·반복·시간/야간 +1일을 표시한다. 띠 클릭은 서버 snapshot으로 기존 ScheduleDialog를 연다.
- 조회 요청은 현장/사용자 scope·generation·기간별 key와 AbortSignal로 분리한다. incomplete/범위·시간대 불일치/권한·coverage·저장 오류는 빈 달력 성공으로 바꾸지 않는다. 권한 상실 시 캐시와 편집/삭제를 차단하며 목록 복구에서도 달력 권한을 다시 조회한다. 일정 저장/활성/삭제 후 목록·달력·다음 실행을 함께 재조회한다.
- 원본 시간 입력 helper 아래 공통 주말 제외/휴일 제외 Switch를 추가한다. 신규/옛 응답 기본 false, 저장값 재열기·취소/Escape·다른 일정/신규 draft 격리를 유지하고 저장 시 두 값을 명시 전달한다. 휴일 제외는 Asia/Seoul 조건을 표시하고 서버 BIO/V3/coverage 거절 이유를 폼에서 안내한다. visible Switch label 포커스는 Dialog 내부에서 노출한다.

### 미구현

- 시간제 세션 UI·수동 이력 footer·저장구역 연결과 지정 브라우저 검증은 위 Task9에 이어 연결했다. 기존 영구 제어는 유지한다.
- 운영 API/Gateway 배포·실제 DB migration·provider 연결·실장비 USB/RF/HIL은 이번 Web 작업에 포함하지 않는다.

### 부족하거나 개선이 필요한 기능

- 검증은 제품 React/API 소비 함수와 격리된 HTTP/Query 응답의 지정 unit 경계다. 실제 장비 성공 또는 모바일의 실제 렌더링/스크롤 측정을 뜻하지 않는다. 실제 320×600/390×844 배치·지도 identity·띠/모달 스크롤 검증은 Task9의 승인된 최소 E2E에 남긴다.
- 실행일 제외의 BIO/V3 자격과 완전 공휴일 coverage는 서버가 검증한다. 미지원·불명확 정보에서 제외값을 false로 바꾸거나 영구 제어로 우회하지 않는다. 브라우저는 반복/공휴일 평가기를 새로 구현하지 않는다.

### 관련 파일

- `apps/web/src/api/automation.ts`, `features/control/automation/{ScheduleControlPanel,VehicleEventControlPanel,ScheduleDialog,schedule-form,automation-presenters}`, `automation/components/{AutomationRuleHeader,ScheduleCalendar,calendar-segments,AutomationRuleControls}`와 직접 관련 8개 테스트 파일.

### 갱신 규칙

- 공통 추가 위치·서버 완전성·scope/권한·제외 draft·API flags를 바꾸면 같은 소유 unit 검증과 이 문서를 갱신한다. 시간제/브라우저/운영/HIL 완료는 해당 후속 증거가 있을 때 별도로 기록한다.


## 2026-10-15 Gateway 최신 BIO 자동 복귀·V3·durable 결과 수신 확인

### 구현 완료

- 실제 BIO bootstrap에 임시 owner port/lease guard, 적용 완료된 V3·assignment·정확한 fixture/native UUID/address·독립 source 건강 권위를 연결했다. 센서 자격·telemetry wire는 기존 version2를 유지한다. canonical MeshNode ID는 API 원명령/lease/proof로 묶으며 로컬 discovered-node ID와 혼동하지 않는다.
- 종료/오프라인 만료는 예약 release generation의 durable intent 이후 독립 GET, 현재 event > schedule > normal 목표, 각 SET 직전 권위 재검사와 mutation intent 저장, 별도 full GET, durable 결과 순서로 처리한다. 같은 snapshot에서도 시간 경계가 지나면 목표를 다시 평가하고 과거 pulse/preState를 재생하지 않는다.
- Normal은 overlay 없는 독립 GET에서 확인한 full mode/high 설정만 사용한다. 신원/network/assignment/base marker와 capture 시점 revision을 검사하며, 증거 없는 신규 임시 SET은 RF0 거절한다. 기존 변경 가능 대상은 recovery_pending/lease를 유지한다. 영구 제어·인증된 ensure_sensor는 SET 전에 이 증거를 무효화하며 일반 scheduler도 sensor 설정을 scalar force-on/off로 덮지 않는다.
- V3 전체 공휴일 dataset의 내용 hash·정렬을 config 경계에서 검증하고 기존 공통 평가기를 실행에 사용한다. 원명령 hash와 UUID delivery hash/window를 분리 검증하며 MQTT PUBACK는 복귀 성공이 아니다. Exact APPLIED terminal receipt는 직렬화된 runtime에서 관측한 시점에 같은 admission/target/release pair의 서버 settlement로 보존한다. ACK 대기 중 최신 목표가 바뀌어도 이미 수락된 과거 event를 버리지 않고 일치하는 old lease만 해제한다. 과거 서버 settlement는 현재 광출력/readback 증거가 아니며, 일반 자동 경로가 독립 GET으로 최신 목표를 재조정한다. 거절된 immutable event는 새 독립 재검증/새 event로 갱신하고 successor나 이미 settlement된 대상을 되돌리지 않는다.
- 유효한 full normal 증거가 있으면 scalar baseline 없이도 기존 event/schedule 후보를 사용한다. 적용 완료 snapshot·source·신원/network·mapping epoch·lease를 GET/SET 경계에서 검사하고 시간 경계도 공통 평가기로 재확인한다. 신뢰된 bootstrap hook이 없거나 activation 중이면 full-configuration SET을 보류하며 generic scalar SET으로 우회하지 않는다. 기존 mapping onChange를 최종 native 제출까지 확인하고 종료 시 구독을 해제한다.
- 시작 전 종료와 이미 RF0 거절된 시작에도 원 Start를 꾸미지 않고 revision2 RF0를 보존한다. Outbox 정리 후 최소 proof/fence는 남고, 늦은 시작/종료/ACK가 후속 owner를 되찾지 않는다. 동일 부팅 monotonic과 재시작 후 원 absolute 만료를 사용하며 재전송·drain은 제한된 대기/재시도로 동작한다.

### 미구현

- Web 달력·제외 설정은 위 Task8에 연결했으며 임시 제어 UI·센서 준비 연결은 후속 범위다. 운영 배포, 실제 브로커/USB/RF/HIL, 공휴일 provider 실호출은 수행하지 않았다.

### 부족하거나 개선이 필요한 기능

- 검증은 지정 Gateway cohort와 self-owned file/fake USB에 한정한다. Configuration GET은 센서 광출력 증거가 아니다. 신규 임시 제어에 독립 normal 권위가 없고 자동 overlay가 활성인 경우 안전하게 거절하며, 기존 불확정 복귀는 권위가 회복될 때까지 잠금을 유지한다.

### 관련 파일

- `apps/gateway/src/index.ts`, `automation/{bio-temporary-control-runtime,bio-temporary-release,temporary-control-mqtt,temporary-control-result-outbox,automation-config-store,automation-state-store,schedule-runtime,automation-runtime}.ts`, 기존 BIO source/product/provider 및 지정 테스트.

### 갱신 규칙

- 최신 목표·각 RF 경계·receipt 순서·독립 normal 권위·대상별 ACK/fence를 바꾸면 같은 범위의 race/restart 회귀를 함께 갱신한다. Web/운영/HIL 완료는 별도 증거가 있어야 기록한다.

## 2026-10-15 Gateway BIO 시간제 소유권·부분 쓰기 기반

### 구현 완료

- 기존 V9 자동 운전 원장·native 필드를 보존하는 V10 상태에 immutable 시작, 대상별 정상 configuration preState, apply/release generation 쌍, 임시 fixture lease, 결과 outbox와 종료 tombstone을 저장한다. 중복·재시작은 endsAt을 연장하지 않고, 시작보다 먼저 받은 종료는 같은 durable transaction에 안전 소유권을 예약하여 늦은 시작의 RF를 막는다.
- BIO 밝기·모드 각 SET 직전에 변경 가능 intent를 durable 저장하고 소유권·신원·clock·deadline을 다시 검사한다. 설정의 독립 GET으로 전체 성공·밝기만 변경·mode만 변경·unknown을 구분하며, 첫 제출 전 중단이 확실한 RF0와 이미 제출했거나 재시작 중단된 unknown을 구분한다. ENOSPC는 다음 RF를 허용하지 않는다.
- 일반 BIO 제어·복구·센서 모드 SET 및 자동 target 쓰기는 같은 임시 lease를 검사한다. 선택 target의 쓰기만 보류하며 pulse 수신·건강·자동 발생 원장은 유지한다. 임시 출력은 baseline 승격·영구 suppression·retireManualTargets로 처리하지 않고 설정 활성화 rollback도 별도 임시 원장을 되돌리지 않는다.
- 절대 만료와 명시 종료는 예약한 release generation으로 revision2 intent부터 저장한다. 실제 복귀가 확인되기 전에는 unknown/부분 변경 소유권을 해제하거나 restored로 표시하지 않는다.

### 미구현

- Task6 당시 보류했던 current V3·공휴일 검증·MQTT ACK·최신 자동 복귀/실제 bootstrap은 위 Task7 기록에서 연결했다. Web 연결은 후속 작업이다.
- 운영 배포·실제 USB/RF/HIL 검증은 수행하지 않았다. 센서 configuration GET은 광출력 증거가 아니다.

### 부족하거나 개선이 필요한 기능

- Task7에서 현재 V3/assignment·UUID/address/source 권위·lease guard와 최신 목표/독립 GET/durable 결과 ACK를 연결했다. 과거 preState의 무조건 재생은 허용하지 않는다.
- 검증은 지정 Gateway 다섯 파일의 메모리·fake USB·자기 소유 임시 파일 테스트와 package typecheck 범위다. 전체 서비스/실장비 완료를 의미하지 않는다.

### 관련 파일

- `apps/gateway/src/automation/{bio-temporary-control-runtime,automation-state-store,bio-pulse-scheduler,schedule-runtime}.ts`, `apps/gateway/src/bio/bio-dongle-client.ts`, `apps/gateway/src/adapters/bio-usb-dongle-adapter.ts` 및 지정 다섯 테스트 파일.

### 갱신 규칙

- 임시 lease·mutation intent·RF0·재시작·만료·종료 tombstone 변경 시 부분 쓰기/unknown 유지와 실제 write 경계 회귀를 함께 갱신한다. 실제 자동 복귀·MQTT ACK·V3/Web 연결은 해당 검증 근거가 확보된 단계에서 별도 완료 기록한다.

## 2026-10-15 BIO 일정 제외·공통 달력 평가기·완전 달력 API

### 구현 완료

- 공통 engine의 기존 Temporal 발생 후보 iterator 한곳에서 일정별 주말/한국 공휴일 제외를 적용한다. 발생 목록·현재/다음 발생·겹침 검사·달력 projection이 같은 시작일 판정을 사용하고, 기존 V1 및 두 flag가 false인 일정은 기존 동작을 유지한다.
- 주말은 현장 시작일의 ISO 토/일이며 한국 휴일은 Asia/Seoul의 검증된 KR/kasi 전체연도 dataset으로 판정한다. 없는/부분/중복 coverage와 다른 TZ의 휴일 제외는 `coverage_unknown`으로 신규 시작을 차단한다. 제외된 once는 이월하지 않으며 31일·윤일·야간·Temporal DST 규칙을 유지한다.
- 달력 projection은 양끝 포함 최대42일의 모든 일정 시작일을 반환하며 목록 페이지 크기로 자르지 않는다. 야간 종료는 조회 마지막 날이나 미지원 다음 연도를 넘어도 원 시각을 유지하고, 최신 dataset revision을 전달하면 다음 발생과 겹침도 같은 내용으로 다시 평가한다.
- 일정 create의 두 제외 flag는 독립 boolean이며 기본 false다. PATCH에서 생략한 flag는 저장값을 보존하고 변경은 기존 desired revision/snapshot 발행 경로로 저장한다. true 제외에는 현재 선언·필수 capability를 갖춘 V3와 BIO 대상이 필요하며, 휴일 제외는 Asia/Seoul의 전체 active 기간 coverage를 저장·활성화 시 재검증한다. false/native 일정은 새 qualification이나 공휴일 cache를 요구하지 않는다.
- `GET /sites/:siteId/automation/schedules/calendar?from=YYYY-MM-DD&to=YYYY-MM-DD`는 SessionAuthGuard와 현장 read 검사 후 하나의 RepeatableRead transaction에서 모든 일정·Gateway desired/applied revision/hash·검증된 dataset을 조회한다. 양끝 포함 최대42일이며 filter/page/cursor/limit 인수는400이다. 101개 일정도 완전 단일 응답이며 조회는 `private, no-store`다. revisionKey는 같은 read view의 현장·Gateway·일정·dataset revision/hash를 묶는다.
- API next/overlap과 V3 snapshot은 같은 공휴일 cache reader 및 engine을 소비한다. 달력에는 조회 범위 안의 실제 시작 후보가 있을 때만 holiday coverage가 필요하며, 범위 밖 once·disabled·false/native 일정 및 이미 수용된 야간 종료 때문에 다음 연도 coverage를 요구하지 않는다. 필요한 coverage가 없거나 손상되면409, 저장소 불가면503이고 `complete:true` 빈 달력으로 합성하지 않는다. true flag를 V1/V2 snapshot으로 조용히 제거하는 downgrade도409이다.

### 미구현

- Gateway의 검증된 V3 dataset 소비 및 기존 Web 화면 연결은 후속 단계다. API/engine 완료만으로 현재 화면에서 사용할 수 있다고 표시하지 않는다.
- 운영 provider/DB/장비 연결 및 HIL은 수행하지 않았다. engine은 API cache/Gateway accepted V3 경계에서 canonical 내용/hash 검증을 끝낸 dataset을 입력받는다.

### 부족하거나 개선이 필요한 기능

- 알 수 없는 시작을 engine이 생략한 결과만으로 완전 달력을 증명할 수 없다. API는 먼저 engine의 실제 시작 후보를 확인하고 필요한 전체연도 coverage를 같은 transaction에서 검증한다. 이미 시작한 장비 동작의 end/release 유지·복구는 후속 Gateway 실행기가 보존해야 한다.
- 검증 범위는 지정 engine/API 각4개 테스트 파일, 관련 controller 1개 fixture와 package typecheck다. 실제 HTTP 경로·101개·공휴일 승격·범위/권한/오류는 격리된 메모리 DB 경계와 로컬 HTTP fixture로 검증하며 실제 조명 동작·운영 DB 동시성·UI 또는 전체 서비스 회귀 완료의 증거로 확대하지 않는다.

### 관련 파일

- `packages/automation-engine/src/{schedule-exclusions,schedule-calendar,recurrence,overlap,index}.ts` 및 해당 테스트 파일.
- `apps/api/src/automation/{schedule-calendar.service,schedules.service,automation-snapshot.service,automation.controller,automation.module}.ts`, `dto/schedule.dto.ts` 및 직접 관련 테스트 파일.

### 갱신 규칙

- 시작일 제외·coverage·달력 범위·야간/DST 계약 변경 시 next/active/overlap/calendar의 일치 회귀를 함께 갱신한다. API/Gateway/Web 및 운영 연결은 각 단계의 실제 검증 근거로 별도 완료 기록한다.

## 2026-10-15 BIO 시간제 제어 API·전달·결과 소비

### 구현 완료

- 현장별 시간제 시작·종료(202 접수), 단건·목록(private, no-store), 현재 권한 재검증, strict 입력·단일 Gateway·BIO 신원·활성 센서 source·기존 불확정 명령·임시 lease 충돌 검사를 연결했다. 실제 접수는 현재 assignment의 적용 확인된 V3 snapshot과 정확한 ACK/hash 및 기존 `CommandDbClockHealth`의 신뢰된 DB UTC sample이 있어야 한다. 같은 요청은 최소 fingerprint로 기존 세션을 반환하고 기간을 연장하지 않는다.
- 시작 transaction에서 고정 대상과 apply/release generation 쌍, 원 command hash/sequence, operation receipt, outbox를 원자 저장한다. 종료·만료는 이미 예약한 release generation을 재사용해 intent부터 기록한다. 기본 영구 SET도 같은 임시 lease를 검사한다.
- 독립 temporary-control MQTT 경로에서 30초 worker lease, 10초 publish timeout, CAS와 최대 60초 재시도를 적용한다. 시작 전달 window는 고정 endsAt 이내이고 종료는 별도 window다. 10회/15분 전달 batch가 끝나도 영속 release intent와 미해결 lease는 남겨 다음 batch에서 재시도한다. PUBACK은 RF 성공이 아니다.
- 결과의 원 admission·assignment·대상·generation·hash 및 최신 적용 V3 restoration revision/hash를 검증하고 receipt→대상 증거→owner 해결→ingested ACK를 한 transaction에 저장한다. 부분 쓰기/unknown은 유지하고 과거 결과가 새 소유자를 해제하지 않는다. 정상 BIO mode의 재평가·독립 GET은 후속 Gateway 실행기 책임이며 센서 mode를 광출력 확인으로 표시하지 않는다.
- V3 선언·스냅샷·ACK와 공휴일 승격 hook을 연결했다. 완전 dataset pointer 및 관련 desired revision/outbox가 함께 commit/rollback한다. BIO 센서 telemetry·capability wire2와 V2 호환을 유지한다.
- 기존 `COMMAND_DETAIL_REDACTION_ENABLED` ON/OFF와 DB UTC 3개월 경계를 사용해 terminal 상세만 정리한다. 최소 operation fingerprint, 결과 receipt/hash, fixture counter와 release tombstone은 삭제하지 않으며 정리 후 재시도도 원 세션을 반환한다.

### 미구현

- Gateway 임시 apply·재시작 관측·만료 intent 및 V3/MQTT·최신 자동 목표 복귀는 위 기록에서 구현했다. 기존 Web 화면 연결은 후속 작업이다. 달력 API는 위 기록에서 구현했다. 이 단계의 HTTP/MQTT/SQL 증거는 mock transport와 자기 소유 PostgreSQL 검증이다.
- 운영 clock attestor·공휴일 provider/ServiceKey, 운영 migration·서버/Pi 배포·PKI/ACL 적용·HIL은 수행하지 않았다. 현재 production clock attestor가 없으면 새로운 시간제 시작은 503으로 차단한다.

### 부족하거나 개선이 필요한 기능

- 사용자 권한 취소는 새 HTTP 쓰기를 차단한다. 이미 transaction에서 접수된 원 start는 후속 권한 변화만으로 자동 취소하지 않고 원 payload/endsAt 및 clock·현재 V3·assignment·lease 검사를 유지한다. 접수된 동작 중지는 권한 있는 사용자의 명시적 end를 사용하며 안전 만료·복구는 원 actor 권한과 독립이다.
- Gateway가 내려가 있거나 복귀 결과가 없으면 lease를 보류하고 recovery 상태를 유지한다. 카운트다운 종료나 전송 접수만으로 장비 복귀를 보장하지 않는다.

### 관련 파일

- `apps/api/src/temporary-controls/*`, `apps/api/src/commands/commands.service.ts`, `apps/api/src/automation/{automation-protocol-support,automation-snapshot.service,automation-mqtt-consumer.service,bio-pulse-telemetry,automation-runtime.module}.ts`, `apps/api/src/mqtt/{mqtt.service,mqtt.module,topic-scope}.ts`, `apps/api/src/app.module.ts`.

### 갱신 규칙

- admission·권한·generation·전달/결과/보존 조건 변경 시 실제 transaction과 stale/late 결과·상세 정리 후 replay 회귀를 함께 갱신한다. 실장비 검증과 후속 UI 완료는 별도 증거 없이 이 항목으로 승격하지 않는다.

## 2026-10-14 공식 한국 공휴일 dataset 갱신 기반

### 구현 완료

- 공식 KASI 특일 서비스의 `getRestDeInfo` JSON 응답 adapter와 전체연도 공휴일 cache 서비스를 추가했다. 응답 성공 코드, 연도·월·날짜·Y/N, 모든 월의 totalCount·페이지·행 수를 검증하고 정상 빈 월도 증거로 저장한다. 같은 날짜의 서로 다른 휴일명은 합치고 반복 페이지·동일 행·부분 자료를 거부한다.
- 정렬·중복 제거한 날짜/휴일명과 KR/kasi/연도/coverage의 canonical hash가 바뀐 완전 자료만 새 immutable revision을 저장한다. 기존 mutation lock 안에서 coverage pointer와 후속 snapshot 갱신 hook을 같은 transaction으로 처리하며 오류 시 이전 완전 revision을 보존한다. 내용이 같은 일일 수집은 revision을 유지하고, 과거 내용으로 되돌아와도 현재 자료와 다르면 새 revision을 만든다.
- 최초 및 하루 간격으로 한국 날짜의 당해·다음해를 갱신하며 종료 시 timer·요청을 취소한다. 실제 key가 주입된 provider가 없으면 갱신 불가를 반환하고, 해시·12개월 페이지 증거를 재검증한 cache만 읽는다. coverage 누락/손상은409, 저장소 장애는 민감한 원문 없는503이며 알 수 없는 날짜를 평일로 만들지 않는다.

### 미구현

- 실제 V3 snapshot revision 갱신 소비와 공통 일정 제외·달력 평가기, 일정 제외 저장/완전 달력 API는 위 2026-10-15 기록에서 구현했다. Gateway V3 및 Web 연결은 후속 단계이며 현재 화면에서 공휴일 제외 기능을 사용할 수 있는 완료 상태가 아니다.
- ServiceKey 설정·실제 provider 연결, 사용자 DB migration, 서버/Pi 반영, ACL reload 및 HIL은 수행하지 않았다. production module은 기본 live provider를 생성하거나 환경 변수를 읽지 않는다.

### 부족하거나 개선이 필요한 기능

- 공식 활용가이드와 mock JSON 응답을 기준으로 adapter를 검증했다. 실제 서비스 응답/자격 증명 연결은 별도 승인된 설정과 검증이 필요하다. HTTP 요청과 JSON body 처리는10초 deadline을 공유한다.
- 자기 소유 PostgreSQL16, HTTP mock 및 fake clock으로 직접 관련39개 테스트를 검증했다. 실제 조명 동작·광출력이나 전체 서비스 회귀 완료로 확대하지 않는다. 기존 native/BIO 등록·설정과 보존 정책은 변경하지 않았다.

### 관련 파일

- `apps/api/src/automation/holiday-provider.ts`, `holiday-dataset.service.ts`, `holiday-dataset.service.spec.ts`, `automation-runtime.module.ts`.
- 저장 구조는 위 서비스가 기존 `HolidayDataset`/`HolidayYearCoverage` 모델을 소비하며 이번 작업에서 schema/migration은 변경하지 않았다.

### 갱신 규칙

- provider 소프트웨어와 실제 연결, cache 검증과 snapshot/화면 소비를 구분한다. `HOLIDAY_DATASET_PROMOTION` hook과 같은 파일의 `loadHolidayCoverage(tx,from,to)`를 소비해 snapshot 서비스의 역방향 DI 순환을 만들지 않는다. 실패한 부분 자료를 coverage로 승격하거나 ServiceKey/URL query/원응답을 로그·브라우저로 보내지 않는다.

## 2026-10-14 BIO 시간제 제어·달력 DB 기반

### 구현 완료

- 독립 시간제 session/target/영속 fixture lease, start/end idempotency receipt, 전용 outbox·결과 receipt를 저장하는 Prisma 모델과 순방향 migration을 추가했다. 같은 조명은 하나의 owner만 갖고 apply/release generation을 한 쌍으로 원자 예약한다. 미해결 삭제·재배정·옛 결과의 새 조명 적용을 차단하며 상세 정리 후에도 최소 신원·fingerprint·generation/tombstone을 보존한다.
- 일정의 주말/공휴일 제외는 기존 행을 포함하여 기본false다. 공휴일 complete revision과 country/year coverage pointer를 분리하고 완전12개월 증거가 있는 같은 연도 dataset만 원자 승격한다.
- DB BIO 자격은 기존V2를 유지하고 V3에는 임시 제어version1과 readback/durable lease 두 증거를 요구한다. 기존 commission-mode 검증과 V2 센서 보고 형식은 유지한다.

### 미구현

- API 접수/권한·결과 판정·전송/상세 정리 worker, 공휴일 provider/cache 소프트웨어·공통 달력 평가기·완전 달력 API 및 Gateway durable 임시 apply·V3/MQTT·최신 자동 복귀는 위 후속 기록에서 구현했다. Web UI 연결은 후속 단계이며 DB/API/Gateway 기반 완료를 현재 화면에서 사용할 수 있는 기능 완료로 표시하지 않는다.
- 현재 사용자 DB migration·서버/장비 반영·ACL reload·HIL·ServiceKey/provider 연결은 수행하지 않았다.

### 부족하거나 개선이 필요한 기능

- SQL은 귀속/소유권/세대/최초 판정 보존을 강제한다. 위 후속 서비스/API가 공휴일 canonical hash·완전 provider 페이지, 대상1~1000개·권한의 transaction admission과 최신 적용 restoration revision/hash를 검증한다. 실제 자동 목표의 재평가와 독립 readback 일치는 후속 Gateway가 담당한다.
- 신규 SQL12/12와 직접 관련 기존V2 자격·활성화1/1을 자기 소유 PostgreSQL16에서 검증했다. 모든 변경은 소프트웨어 증거이며 실제 조명 복귀·광출력 증거가 아니다. 보존 ON/OFF 설정과 기존 native/BIO 등록·밝기는 변경하지 않았다.

### 관련 파일

- `apps/api/prisma/schema.prisma`, `apps/api/prisma/migrations/20261014090000_bio_temporary_control_calendar/migration.sql`.
- `apps/api/src/automation/bio-control-schema.integration.spec.ts`, `docs/database-schema.md`.

### 갱신 규칙

- 저장 구조, API 사용 가능 상태, Gateway/화면 연결, 운영 적용을 구분한다. 최소 receipt/tombstone 삭제는 일반 상세 보존 정책에 포함하지 않는다.

## 2026-10-14 BIO 시간제 제어·달력 공유 계약

### 구현 완료

- 시간제 시작·종료·start/end wire·대상별 결과·수신 확인·조회·목록의 strict 공유 schema를 추가했다. 밝기 정수0~100%, 기간 정수1~1440분, unique1~1000대, 예약 apply/release generation 쌍과 원 시작 귀속을 검증하며 legacy `overrideUntil`을 허용하지 않는다. BIO native UUID는12자리 소문자hex, logicalAddress는 기존0x unicast 형식이다.
- 알려진V2/V3 자동 운전 지원 helper와 V3의 두 제외 flag·전체연도 휴일 dataset·최대42일 완전 달력 계약을 추가했다. V3 임시 제어 선언에는 readback/durable lease capability가 필수이며 수신 확인은 동일 현장·게이트웨이·ACK id·revision·hash만 일치로 판정한다. 적용/복귀 결과를 전송 성공으로 합성하지 않는다.
- 새 MQTT 경로는 `sites/{siteId}/gateways/{gatewayId}/temporary-control/{command,result,ingested}`다. 기존 `commands/#` 권한을 상속하지 않으며 ACL renderer/publisher의 명시적 `temporaryControlScopes` 매핑에만 API write/read/write와 Gateway read/write/read를 부여한다. 매핑 없는 기본값과 production 예제에는 새 권한이 없다.

### 미구현

- DB session·lease·outbox·휴일 저장 구조, 시간제 제어 API, 공휴일 provider/cache 소프트웨어와 공통 달력 평가기·완전 달력 API는 위 후속 기록에서 구현했다. Gateway RF·Web UI 소비는 후속 단계다. 현재 화면에서 시간제 제어와 제외 달력을 사용할 수 있는 완료 기능이 아니다.
- 운영 환경의 실제 현장/Gateway 매핑, ACL 반영·reload, 서버/장비 배포·재시작·HIL·ServiceKey/provider 연결은 수행하지 않았다.

### 부족하거나 개선이 필요한 기능

- 공유 parser는 hash 형식과 결과 귀속을 검증한다. 공휴일 canonical hash·완전12개월 provider proof는 위 서비스가 검증하며 다른 payload의 canonical hash 계산·DB immutable snapshot/현재 lease·최신 복귀 revision 검증은 후속 소비자가 담당한다. readback은 조명 설정 증거이며 실제 광출력 증거가 아니다.
- 개발 준비는 명시적 `DEV_TEMPORARY_CONTROL_SCOPES` JSON 매핑을 검증·전달하는 소프트웨어만 제공한다. 환경 값을 설정하거나 현재 브로커 권한을 변경하지 않았다. 미설정 상태에서 신규 임시 제어 메시지는 거부된다.
- 지정 공유5파일70/70와 새 disposable mTLS·ACL/매핑/production 계약4/4(fail/skip0), 기존 직접 ACL·준비 경로6/6을 확인했다. CJS/ESM 두 신규 subpath 로딩·shared 타입 검사·shared→engine 준비가 통과했다. 전체 서비스 테스트·운영 장비 검증 완료로 확대하지 않는다.

### 관련 파일

- `packages/shared/src/{temporary-control-contracts,holiday-calendar-contracts,bio-automation-version,automation-contracts,mqtt}.ts`, 각 직접 테스트, shared exports/ESM 설정.
- `scripts/dev-runtime.mjs`, `scripts/dev-prepare.mjs`, disposable MQTT ACL 테스트, `infra/mosquitto.acl.example`, `tests/mqtt-production-config.node.mjs`.

### 갱신 규칙

- 공유 계약 제공과 후속 API/DB/Gateway/UI 사용 가능 상태를 구분하고, 운영 매핑·ACL 적용·RF/HIL 결과는 별도 승인·증거가 있을 때만 기록한다.
## 2026-10-14 공통 로딩 표시 적용

### 구현 완료

- 수동/스케줄/이벤트 화면 지연 로드·대상 초기조회·구역/명령 이력/확인 필요 상세·검색조건 적용·다음 페이지·저장/삭제/승인 요청에 공통 표시를 연결했다. 수동 적용은 HTTP 전송 중만 spinner를 표시하며 compact 적용 문구·실제 버튼 높이와 입력/실행 guard를 보존한다.
- 센서 준비/등록 연결 확인은 local 요청 처리 중만 별도 inline 상태를 표시한다. 준비 판정·장비 응답/미확정·진행 상태는 재해석하지 않는다. paused query는 연결 대기, 미완성 조회 기간은 입력 안내다.
- BIO 시간제 UI와 통합 시 단일 이력·목록/달력 전환·권한별 미리보기/복구 식별자를 보존한다. 모바일 기본 적용은 공통 spinner를 기존 버튼 안에 배치해 HTTP 대기 전후 실행행 폭을 유지하고, 전송이 끝난 뒤 미확정 잠금은 spinner와 분리한다. 이는 자기 소유 fixture HTTP의 검증이며 실제 장비 결과는 아니다.

### 미구현

- 실제 조명 명령/센서 준비 요청/HIL을 실행한 증거는 아니다.

### 부족하거나 개선이 필요한 기능

- 기존 ControlView5개 단위 실패를 구현 전 baseline과 최종 전체 Web 결과에서 구분해 보존한다. 공통 맵 portal/paint·카메라 상태와 disabled/error/미확정 잠금 로직은 변경하지 않는다.

### 관련 파일

- `features/control/{ControlView,ManualExecutionPanel,CommandHistoryPanel,CommandVerificationCases,CommandRiskReconcileDialog}.tsx`, `automation`·`groups` 소비자, `components/ui/{Button,ConfirmDialog,LoadingIndicator,LoadingState}.tsx`.

### 갱신 규칙

- API 전송 pending과 장비 결과 pending을 구별하고, 버튼 ref/네이티브 activation·44px 조작 영역/compact 높이를 확인한다.

## 2026-10-14 공통 등록 연결 확인 UI

### 구현 완료

- 기존 센서 준비 패널에서 등록연결 재확인이 필요한 조명은 공통 `등록 연결 확인` 버튼으로 기존 서버의 query→현재proof GET→검증/감사 apply를 사용한다. A/B ID를 고정하지 않고 현재 현장/조명/gateway/assignmentVersion에 결속한다. 권한·online·버전이 없거나 바뀌면 차단하며 응답유실 시 중복요청/SET을 자동 생성하지 않는다.
- 등록확인 완료는 센서사용 가능 판정이 아니다. dashboard 재조회 뒤 별도 센서사용설정/준비확인과 현재 sourceEligible를 통과해야 선택한다. 기본밝기/ID와 규칙 비활성을 보존하며 최대5회 자동GET 후 수동결과조회를 제공한다.

### 미구현

- 제품변경은 `c20a6529`로 메인/API watcher에 반영했고 실제 공통버튼 표시·오프라인차단을 확인했다. MQTT CRL은 사용자승인으로 갱신됐지만 실제등록재확인에는 DB시각 검증 제공자 연결이 남는다. 오프라인조명의 전원/연결, 실제 감지·유지·복귀 시험은 이 소프트웨어회귀의 완료범위가 아니다.

### 부족하거나 개선이 필요한 기능

- 조회 응답의 현재 assignmentVersion을 소비하므로 구형API 응답은 재확인 버튼을 차단한다. 임의버전1/ready를 대체하지 않으며 새적용 뒤 현재자격을 확인해야 한다.
- 2026-10-14 17:41 이후 현재 MQTT만down/4대offline이며 broker CRL은14:57:46KST 만료다. Gateway USB/transport/protocol/mapping은정상이므로 센서고장으로 추정하지 않는다. CRL갱신승인 후 기존Vault기동 확인대기이며 정상연결복구 전에는 조회/SET·규칙활성화를 실행하지 않는다.
- 후속17:55KST CRL갱신/동일broker reload·MQTT복구를확인했고18:59API도ready다. 새CRL은10월17일17:55:21KST까지이며 기존Root·폐기내역2건을유지한다. 실제등록POST1회500은필수 DBclock evidence provider가미등록이라차단된결과다. 서버조회가능과실제등록/센서준비를구분하며 fake증거/관문완화·등록apply/센서SET/규칙활성화는0이다. 조명4offline으로현재전체시험가능상태는아니다.

### 관련 파일

- `apps/web/src/features/control/automation/components/BioRegistrationConnectionCheck.tsx`, `BioSensorPreparationPanel.tsx`, `apps/web/src/api/{registration,queries}.ts`, API `sites/sites.service.ts`·`fixtures/fixtures.service.ts`, 관련unit/Chromium회귀.

### 갱신 규칙

- 등록확인·센서준비·규칙명시적활성화·실제움직임시험을 구분한다. unit/mock검증을 실장비사용 가능으로 승격하지 않는다.

- 2026-10-14 모든조명 UI시험 후속: 일반 이벤트추가/전체조명목록에서 모든조명의 준비상태를 볼 수 있다. 현재B1-L006은 approved fingerprint일치지만needs_setup, B1-L002는 완료등록의 발견상태가discovered로낮아져binding_changed/후보false다. 공통준비패널의 정상등록연결확인 UI 보완과 센서모드설정 승인을대기한다. 오프라인조명/미검증센서를강제허용하지 않고 실제시험완료로표시하지 않는다.

- 2026-10-14 후속09:14KST: 새 승인으로 동일image/등록/밝기/인증/센서 설정과 fresh 암호화 백업을 보존해 주소 교정/약27초 중단 뒤 MQTT·USB 통신을 복구했다. A의 정상 UI query1개는 식별 응답 없이unverified이며 현재online은B1-L002/B1-L006이다. 기존A(B1-L001)/B(B1-L004)는오프라인이므로 전원/연결 확인 또는 새 대상의 사용자 선택 전 시험은 불가하다. 규칙100%/60초/비활성/적용됨·활성화 차단을 유지하며 임의 조명 교체·SET·추가query·시험은 하지 않았다.

## 2026-10-14 실제 UI 시험 준비 판단

- 구현 완료: 기존 정상 UI·비활성 A→B100%/60초/적용됨을 확인하고 현재 연결 차단 원인을 읽기 전용으로 식별했다. 서버 ready/시간 측정은 정상이며 Gateway/USB/센서 transport는 정상이다.
- 미구현: 현재4대 오프라인·준비 확인 필요로 활성화가 차단되어 실제 UI 시험은 아직 불가하다. 현재 서버 주소 복구 뒤 새 정상 UI 준비 query와 자격 확인이 필요하다.
- 부족하거나 개선이 필요한 기능: 게이트웨이의 두 서버 별칭/ExtraHosts가 전날 PC 주소를 유지한다. 현재 주소 TCP8883은 성공하고 이전 주소는 실패하며 MQTT/heartbeat false다. 새 일시 중단·주소 교정 승인 전에는 실제 중단/재구성/시험을 하지 않는다.
- 관련 파일: 기존 `VehicleEventControlPanel.tsx`, `BioSensorPreparationPanel.tsx`, `docs/project-status.md`, BIO 운영 활성화 계획. 제품 소스는 이번 진단에서 변경하지 않았다.
- 갱신 규칙: UI 소프트웨어 검증·과거 online 기록·현재 네트워크/센서 자격·실제 감지 시험을 구분한다. 과거 중단 승인과 ready 기록을 재사용하지 않는다.

## 2026-10-13 이벤트 사용자 화면의 기술 진단 영역 정리

### 구현 완료

- 테스트 전용이 아닌 상시 제품 UI였던 규칙별 `BIO 운영 상태` 상세 영역을 제거했다. 이벤트 목록의 감지 센서 칸에 공통 상태 배지로 준비 여부와 필요한 점검·복귀 확인 경고만 표시한다. 펄스 시각·USB 장애 사유·설정 read-back·광학 출력 관련 기술 설명은 사용자 목록에 표시하지 않는다.
- 명시적 활성화/비활성화, 현재 현장·게이트웨이·센서 자격 검증, 장애 차단, 조명 선택과 유지시간 설정은 유지한다. 과거 센서 보고나 설정 조회 성공을 실제 복귀 완료 또는 준비 완료로 추정하지 않는다. 시험 전용 기록창·도구·기존 기록은 보존한다.

### 미구현

- 이번 UI 정리는 실제 규칙 활성화·장비 명령·센서 시험을 포함하지 않는다. 서버 PC 시간 동기화 승인과 새 준비 자격 확인은 별도 후속이다.

### 부족하거나 개선이 필요한 기능

- 센서 복귀 경고는 연결된 센서의 전체 규칙 보고이며 현재 규칙의 복귀 실패를 확정하지 않는다. 사용자에게 확인 요청만 표시하고 성공을 합성하지 않는다.
- 관련 패널84/84, 타입 포함 Web 빌드 exit0, mock Chromium320/390/1440px8/8을 확인했다. 모바일 터치 영역·수평 overflow와 PC 전체 페이지 스크롤, 준비 차단·명시적 활성화·유지시간10초 수정은 소프트웨어 회귀이며 실제 센서 시험 성공 증거가 아니다.
- 제품 수정 `ad1dcd5a`를 메인 개발 브랜치에 ff-only 반영하고 병합 후84/84·타입 포함 build exit0과 현재 로그인 화면의 제거 결과를 확인했다. 규칙은 비활성100%/60초/적용됨을 유지하며 현재4대 오프라인·준비 확인 필요 상태로 활성화가 차단된다. UI 정리 완료와 장비 시험 준비 완료를 구분한다.

### 관련 파일

- `apps/web/src/features/control/automation/VehicleEventControlPanel.tsx`, `components/EventSensorStatus.tsx`, 패널 단위 테스트 및 `apps/web/e2e/control-map-target-selection.spec.ts`.

### 갱신 규칙

- 제품 사용자 상태와 기술 진단·시험 도구를 구분한다. 짧은 상태 표시로 바꾸더라도 활성화 자격·장애 경고를 없애거나 하드웨어 검증 완료로 기록하지 않는다.

## 2026-10-13 공통 맵 로딩

### 구현 완료

- 수동·스케줄·이벤트 제어의 공통 지도 대상 선택은 데이터 조회와 맵의 실제 첫 paint까지 공통 loading overlay를 사용한다. 층/문서 교체는 다시 대기하고 같은 맵의 이동·줌은 반복 차단하지 않는다.
- native/legacy/이미지/배경 없는 맵은 공통 `FloorScene`의 paint·오류 처리와 접근 가능한 loading host를 재사용한다. 대상 선택 계약·제어 명령·MQTT·센서 자격은 변경하지 않는다.

### 미구현

- 실제 조명 제어/센서/HIL은 이번 UI 변경에서 수행하지 않는다.

### 부족하거나 개선이 필요한 기능

- 별도 브랜치 검증 후 로컬 `codex/mvp1-cloud-web`에 `3b43b988`까지 머지했다. 최종 전체 Web3,701PASS/기존 Control5FAIL/3SKIP와 타입 포함 build/UI0, 총괄 Chromium12/12 및 머지 후 관련378/378·build/UI0을 확인했다. 기존 실패를 전체 GREEN으로 표현하지 않는다.

### 관련 파일

- `apps/web/src/features/control/target-selection/SpatialTargetSelector.tsx`, 공통 `features/floor-map/{FloorScene,FloorMapViewport}.tsx`, `features/map-scene/MapSceneCanvas.tsx`, `components/ui/MapLoadingOverlay.tsx` 및 직접 unit 회귀.

### 갱신 규칙

- 공통 지도 UI 변경은 설정·모니터링 문서를 함께 갱신하고 지도 표시 검증을 실제 명령/장비 검증과 구분한다.

- 2026-10-13 17:38–17:43 KST 직접 UI 시험 준비 후속: 승인된 서버 별칭2개 교정·동일 이미지 Gateway 재구성/백업 보존으로 UI4online·통신 정상까지 복구했다. A의 정상 UI query는 mode/link true·ready 보고이나 서버 시각보다2.015초 미래라 stale 거절됐다. Mac Apple NTP 읽기 offset +2.041초를 확인했으며 PC 시간 동기화 추가 승인 대기다. 기존 시험 규칙100%/60초는 비활성·적용됨이고 활성화는 여전히 차단된다. 센서 SET/실제 시험은0이며 자격/시간 검증을 완화하지 않았다.

## 2026-10-13 BIO 보정 메인·현재 서비스 반영

- 구현 완료: 현재 메인에 이번 보정만 `e243110c`로 통합했다. Web103·API71·mock Chromium7/7·양쪽 타입/빌드를 새로 확인하고 같은 개발 watcher/환경으로 API를 재기동했다. 정상 로그인 UI에서 비활성 A→B100%/60초 시험 규칙의 Gateway 동기화가 `적용됨`이다. 기존 지도/공통 목록·사용자 AGENTS 변경·패키지/lock/schema와 원 센서 작업 공간을 보존했다.
- 미구현: 현재 현장 heartbeat가 오래돼 조명4대가 오프라인이다. 활성화 버튼은 현재 sourceEligible에 따라 안전하게 차단되며 새 장비 준비·규칙 활성화·감지/유지/복귀/실제10초 변경 시험은 하지 않았다.
- 부족하거나 개선이 필요한 기능: 서버 MQTT ready와 현장 Gateway online은 다른 증거다. 연결 확인이 다음 단계다.14:09 설정 보고 캐시 digest는 다르며4개 마지막 보고가 이번 통합 이전임만 확인했다. 현재 장비 GET/광학 밝기 보존까지 주장하지 않고 기존 기록을 보존한다.
- 관련 파일: `apps/api/src/automation/vehicle-event-rules.service.ts`, `apps/web/src/features/control/automation/{VehicleEventControlPanel,VehicleEventDialog}.tsx`, `docs/project-status.md`.
- 갱신 규칙: 이전 소프트웨어/운영 기록은 당시 상태다. 새 서비스 반영·현재 자격·현재 현장 연결과 RF/광학 시험을 각각 구분한다. 이번 직접 장비 명령/규칙 활성화0이다.

## 2026-10-12 BIO TIMEOUT 응답 유실의 제어 이력 분류 보완

### 구현 완료

- 2026-10-13 소프트웨어 보완: BIO 기본 USB ACK/startup/partial frame 대기는 300→1,000ms, 장치 확인 보고 대기는 300→2,000ms로 늘린다. 제품 factory의 USB·관측 override는 독립이며, 직접 client의 기존 `timeoutMs` 단독 지정은 두 대기에 적용되는 호환성을 유지한다. UUID/address/kind 검증, ACK보다 먼저 도착하는 report, generation 폐기, 자동 Set 재전송 금지 및 만료 뒤 Set fence는 유지한다.

- 수동 명령의 장비 결과가 `failed + TIMEOUT`이면 기존 `failed + STATUS_TIMEOUT`과 같이 관측 부재로 정규화한다. 해당 결과는 `timed_out`, 관측 밝기는 `null`, 원래 `faultCode`는 그대로 보존하며 명령은 `unknown`으로 분류해 이력에서 `실제 상태 확인 필요`를 표시한다. 일부 응답만 70%인 경우 전체 성공이나 확정된 일부 실패를 합성하지 않는다.
- 원문 aggregate·fixture 집합·신원·event hash 검증은 정규화 전에 유지한다. `state_mismatch` 같은 확정된 실패는 기존 `partially_applied`/`일부 조명 적용 실패` 의미를 유지한다. 기존 native `timed_out`, `STATUS_TIMEOUT`, unknown 이후 상태 확인과 겹치는 Set 차단도 유지한다. 공유 wire 계약과 DB 스키마는 변경하지 않았다.

### 미구현

- 응답 대기 보완은 새 bundle의 장비 배포·현재 Pi의 명시적 timeout 변경·원래 70% 명령의 성공 재검증을 포함하지 않는다. 기존 명령의 정확한 USB/RF 또는 brightness/mode Get 유실 단계도 미확정이다.

- 이미 저장된 명령 `337f5ac3-76fd-4abc-b41b-bab2a3d896c1`의 `partially_applied` 기록은 소스 수정만으로 변경되지 않는다. 과거 기록 재분류·런타임 반영·실제 장비 Get/Set·게이트웨이 배포는 이번 구현에서 실행하지 않았다.
- 문제 시각에 실행된 구버전 BIO 컨테이너(revision `27138ae5e35936f136d8e194712110ea8e13ae44`)의 catch가 관측 부재에도 `failed`를 반환하는 구조와 실제 기록이 일치한다. 다만 해당 명령 UUID 로그·원문 ACK가 없어 실행기록의 최종 귀속과 USB/RF 또는 brightness/mode Get 중 정확한 유실 단계는 미확정이며, 최신 Pi 실행 bundle의 적용·실장비 재검증은 이번 작업에서 수행하지 않았다.

### 부족하거나 개선이 필요한 기능

- 전체 수동 실행은 기본 8초와 남은 MQTT TTL 10초로 계속 제한된다. BIO는 4 worker여도 USB 전역 queue에서 비영 밝기 대상마다 두 Set·두 Get을 직렬 처리하므로 이번 기본값 조정만으로 1,000개 이상 일괄 제어를 지원하지 않는다. API 30초 accepted 제한, 분할 dispatch와 안전한 실행 소유권을 포함하는 대규모 설계는 별도 후속 범위다. 독립 BIO Compose의 timeout override 전달도 이번 변경에 포함하지 않는다.

- 원래 70%·네 조명 중 하나의 `TIMEOUT`과 세 조명의 `succeeded/70`을 넣는 API 회귀가 수정 전 `partially_applied`로 실패했다. 상태 저장을 모사하는 단위 경계에서 정규화·원문 hash 충돌 거부와 기존 실패/확인/잠금 회귀를 검증하며, PostgreSQL·실장비 동작 증거와 구분한다.
- 과거 명령을 무조건 `unknown`으로 바꾸면 원래 70%·네 대상에 대한 새 Set 잠금이 생긴다. 이후 성공한 0% 명령이 있는 경우, 현재 값을 읽는 Get을 과거 70% 적용 사실의 증명으로 해석하지 않는다. 과거 기록 보정은 원문·보관 경계·신원·후속 명령을 대조하고 감사 가능한 별도 절차로 결정해야 한다.

### 관련 파일

- `apps/gateway/src/bio/{bio-timeout-defaults,bio-usb-transport,bio-dongle-client}.ts`, `apps/gateway/src/adapters/adapter-factory.ts` 및 관련 단위 테스트
- `apps/gateway/.env.appliance.example`, `apps/gateway/README.md`

- `apps/api/src/mqtt/mqtt.service.ts`
- `apps/api/src/mqtt/mqtt.service.spec.ts`
- `apps/api/src/commands/command-delivery-reliability.spec.ts`
- 무변경 소비자 `apps/api/src/commands/{command-status.service,command-verification.service,commands.service}.ts`, `apps/web/src/features/control/command-history-presentation.ts`

### 갱신 규칙

- 응답 대기 보완은 가상 byte connection의 소프트웨어 증거와 실장비 배포·RF 관측을 분리해 기록한다. 전체 TTL·Set fence와 이미 실행 중인 Pi 설정의 실제 반영 여부를 확인 없이 완료로 표시하지 않는다.

- 응답 유실과 확정된 장비 실패를 구분하고, 원문 검증 뒤에만 호환 정규화를 적용한다. 성공을 추정하거나 원래 밝기·대상·UUID를 바꾸지 않는다.
- 단위 RED/GREEN·전체 API 검사·실제 운영 반영·과거 기록 보정·장비 확인을 분리해 기록한다. 장비 응답이 없었다는 이유로 과거 이력을 성공으로 덮지 않는다.

## 2026-10-12 실제 toolbar 조명 목록 hit 실패 후 compact 대상 외곽 보완

### 구현 완료

- 수동 `singleColumnLayout`에서만 외곽 제어 대상 Card에 `rounded-none!`을 적용한다. padding0/border0/overflow-hidden 상태에서 우상끝 조명 목록48×44가 부모14px 모서리에 잘리는 원인을 제거한다. 내부 지도 OperationMapPanel의 둥근 프레임·공통 Card/default/PC·scroll/높이/handler는 유지한다.
- toolbar/선택/More 좁은44px 대상의 실제 DOM ancestor를 함께 감사했다. 실행 More는 앞선 square SidePanel, 보조 콘텐츠는 기존 portal host와 padding8px body를 소비한다. 추가로 확정된 별도 miss는 없어 범위를 확대하지 않았다.

### 미구현

- e35c0c20의 320×600 light fake-API Chromium case3는 실제1PASS/0FAIL, exit0, 20.149886s로 완료됐으며 toolbar44·0/100 양끝8개 hit·raw31·상호배타 보조 패널·More 마지막 action/끝 스크롤·Escape 포커스·invalid101 첫 Apply 후31 복원/0POST·finite 최종 지도247px≥240을 확인했다([영구 결과 모음](../assets/map-workspace-comments-2026-10-12/README.md)).
- 실제 OS keyboard·pointer Slider drag·live API·장비/HIL은 미검증이며, 다른 case1/2/4는2290·case5는f28·case6는4093 PC와 source carry 근거로 별도 유지하므로 e35에서 새로 six-case PASS한 것으로 해석하지 않는다.

### 부족하거나 개선이 필요한 기능

- f2926e92 actual에서는0/100 각각 input/thumb/Apply/More 네 target continuous44=true까지 완료했다. 이후 toolbar 전체 검사에서 조명 목록48×44 hasMinimumArea=false로 새 중단됐다. 입력 실패로 기록하지 않으며 원fail·미도달aux/invalid 단계를 보존한다. 이는 당시 실패·미도달 이력이며, e35 case3 후속 검증에서는 해당 aux/invalid 단계까지 모두 도달해 통과했다.
- 원PNG·toolbar x8/y87/304×44 및 list48×44·source flush 배치가 같은 부모 clipping을 가리킨다. 개별 list 좌표는 source/toolbar로 유도한 것이며 새 browser 측정이 아니다. 소스 감사·직접81개 회귀를 실제 후속 hit GREEN으로 해석하지 않는다.

### 관련 파일

- `apps/web/src/features/control/ControlView.tsx` 외곽 target Card caller와 Control/Shell/Spatial/ManualExecution/Viewport 소비자 회귀.
- 감사한 무변경 `target-selection/{TargetSelectionToolbar,ManualSelectionPanel,SpatialTargetSelector}.tsx`, `manual-workspace/ManualAuxiliaryPanel.tsx`, 공통 `components/ui/{Card,SidePanel,maps/OperationMapPanel}.tsx`.

### 갱신 규칙

-48×44 가장자리 대상은 자신의 rect/radius와 실제 DOM parent의 round/overflow를 함께 확인한다. portal 콘텐츠는 React 논리 owner가 아니라 실제 host 계층으로 판단한다.
-0/100 통과·toolbar 새실패·미도달aux/invalid·새source/hash/cohort·후속actual 결과를 구분한다. UUID/gesture/ref/lifetime과 지도 높이 budget을 유지한다.

## 2026-10-12 실제 INPUT continuous44 실패 후 compact 부모 모서리 보완

### 구현 완료

- 수동 모바일 실행 SidePanel만 `rounded-none!`을 사용한다. padding0/border0인 부모의14px card 모서리가 가장자리 숫자 입력·더보기 hit를 잘라내는 예외를 제거한다. 공통 SidePanel/Card·PC/default 모서리·배경·scroll owner와 실행 행/지도 높이는 유지한다.
- 앞선 compact Slider 양끝28px 여백과 숫자 입력 사각 모서리를 유지한다. handler·native input/ref·draft/invalid 복원·첫 Apply 차단·명령 UUID/frozen request/query는 변경하지 않았다.

### 미구현

- 새 source의320×600 INPUT·thumb0/100·Apply/More continuous44, 지도240+·aux/invalid 후속 stage actual은 총괄 source freeze 뒤 case3 한정 UX 관문이다. 본 담당 browser 실행0, 이미 통과한 case5 재검사0.

### 부족하거나 개선이 필요한 기능

- f28ea638 실제 case3에서 INPUT `밝기 수치` x8/y480/48×44 continuous44=false가 확정됐다. thumb0은 입력과 분리됐지만 outer SidePanel rounded14px/overflow clipping이 남았다. 44높이에 세로 여유0·48너비에 가로 여유4px이므로 맨 위 radius edge 약10px를 피하는44 정사각형을 확보할 수 없다.
- source·원본 PNG·실측 좌표 대조를 바탕으로 최소 수리했다. 직접 React 동작 회귀·class 선언은 실제 geometry GREEN이 아니다. 원 actual RED와 미도달 stage를 보존하고 실제 OS touch/keyboard·장비/HIL 검증은 별도로 남긴다.

### 관련 파일

- `apps/web/src/features/control/ControlView.tsx`의 수동 실행 SidePanel caller와 Control/ManualExecution/Shell/Spatial/Viewport 직접 소비자 회귀.
- 무변경 공통 `apps/web/src/components/ui/{SidePanel,Card}.tsx`, `styles/theme.css`의 radius token 및 `features/control/ManualExecutionPanel.tsx`.

### 갱신 규칙

- 가장자리 control의 actual continuous44는 input/button 자체뿐 아니라 rounded/overflow ancestor를 함께 확인한다. 공통/default card 정책을 변경하지 않고 compact caller의 예외를 주석으로 남긴다.
- 원 f28 INPUT RED·source/hash/cohort·후속 실제 case3 판정을 분리한다. 지도 높이·scroll owner·raw/첫 Apply·UUID/frozen 복구 계약을 유지한다.

## 2026-10-12 실제 Home→0 실패 후 수동 compact 슬라이더 양끝 보완

### 구현 완료

- 수동 compact 실행 행의 Slider caller에만 좌우28px 여백을 둔다. 기존52px thumb가 트랙0/100%에서26px씩 바깥으로 나오는 범위를 자기 열 안에 확보해 숫자 입력/적용 버튼의 조작 영역을 침범하지 않도록 한다. 실행 행44px·지도 finite 높이 배치는 유지한다.
- 같은 compact 숫자 입력48×44는 사각 모서리를 사용해 연속44px 입력 영역의 모서리 손실을 피한다. 공통 Slider/NumberField와 기본·PC caller는 변경하지 않았다. 기존 native Home/End·draft/ref·invalid 복원/첫 Apply 차단·명령 UUID/handler는 유지한다.

### 미구현

- 변경 소스의 실제320×600/390×600 숫자 입력·thumb0/100·적용·더보기 continuous44 및 지도240+ 재판정은 총괄 source freeze 뒤 UX 후속 관문이다. 본 담당 actual browser 실행0.

### 부족하거나 개선이 필요한 기능

- 2290a877 actual case3는 Home→0 뒤48×44 target의 continuous44=false로 실패했다. 당시 지도269px·문서overflow0이었으며 실패 screenshot에는 thumb와 숫자 입력 오른쪽의 겹침이 보인다. 원본 RED는 보존한다.
- native Home/End 직접 소비자 테스트는 양끝 draft 동기화·slider DOM/focus·명시 적용 계약의 회귀 근거다. 기존 구현에서도 통과하는 동작 회귀이며, CSS 여백/모서리 선언이나 JSDOM 결과를 실제 hit GREEN으로 해석하지 않는다. 실제 OS touch/keyboard·장비/HIL 검증은 수행하지 않았다.

### 관련 파일

- `apps/web/src/features/control/ManualExecutionPanel.tsx`와 `ManualExecutionPanel.test.tsx`.
- 실제 Control/Shell/Spatial/Viewport 소비자 회귀 및 무변경 공통 `components/ui/fields/{Slider,NumberField}.tsx`.

### 갱신 규칙

- 슬라이더 끝값은0/100 모두에서 숫자 입력·thumb·적용·더보기의 독립 continuous44와 실행 행/지도 높이를 함께 확인한다. 원 actual RED·직접 동작 회귀·후속 actual geometry 판정을 구분한다.
- compact caller 이외의 공통/default/PC 스타일 및 draft/명령 경로 변경을 동반하지 않는다. source/hash/raw cohort와 후속 UX freeze 결과를 각각 기록한다.

## 2026-10-12 실제 continuous44 실패 후 수동 compact 버튼 보완

### 구현 완료

- 수동 compact camera 네 버튼은 기존52px coarse 프레임을 사용한다. compact overlay placement·zoom/reset/fit handler는 그대로이며 지도 flow 높이를 늘리지 않는다. 기본/editor/PC의 compactChrome=false 경로는 변경하지 않았다.
- 수동 compact Apply/More/조명 목록/전체 보기/reader close/빠른 값/선택 해제는 재사용 feature class로 사각 외곽·높이44·최소너비48을 사용한다. basic 행을52로 늘리지 않아 지도 높이 budget을 보존한다. 버튼의 keyboard/disabled/권한/Apply guard 및 handler는 그대로다.

### 미구현

- 최종 source continuous44 및 map240+·overlay control/reader 마지막 action의 actual 재측정은 총괄 source freeze 후 UX 관문이다. 본 담당 browser 자동 재실행0.

### 부족하거나 개선이 필요한 기능

- 이전4093 actual에서320 map251/390 map249·문서overflow0을 확인했으나 camera geometry44(배율47.625×44)의 usable43/연속44영역false가 실측됐다. 소스 보완·직접 동작 GREEN을 실제 hit 합격으로 해석하지 않는다.
- 넓은 층/범위 select의 기존44 프레임과 numeric/slider·긴 이력 action의 actual hit/가림은 같은 후속 UX 관문에서 확인한다. 기준44/지도240은 완화하지 않았다. 새 public API/공통Button/default 스타일 변경0.

### 관련 파일

- `apps/web/src/features/floor-map/FloorMapViewport.tsx`와 직접 테스트.
- `features/control/{ManualExecutionPanel,manual-workspace/ManualAuxiliaryPanel,target-selection/ManualSelectionPanel,target-selection/TargetSelectionToolbar}.tsx` 및 실제 Control/Shell/Spatial/ManualExecution 소비자 직접 테스트.

### 갱신 규칙

- geometry 선언과 실제 reachable continuous44를 구분하고 원 actual RED와 후속 source/실측 cohort를 각각 남긴다. compact true 전달 경로와 PC/default false 영향 경로를 명시한다.
- 이번 버튼 보완은 camera/renderer/UUID/frozen request/query/복구·권한/raw31/첫Apply 계약을 함께 확인하고 실제 UX 후 최종 수치를 기록한다.

## 2026-10-12 승인 후속 — 지도 하단 단일 보조 패널

### 구현 완료

- 수동 모바일의 목록·더보기는 지도 내부 하단의 하나의 nonmodal 보조 패널에서 상호배타로 표시한다. 고정 제목/닫기44와 공통 body 내부 scroll을 사용하며, 열기·전환·닫기가 지도 grid의 행 높이를 추가하지 않는다. 별도 drawer/selection/query/command owner를 만들지 않았다.
- 지도 아래 `선택 조명 N개` → 바로 아래 `전체 보기`44, 숫자/slider/적용/더보기44 한 행, 중요한 상태/live와 navigation을 유지한다. 선택 범위와 층 dropdown의 시각적 label 빈 간격을 수동 compact caller에서만 없애고 accessible label은 유지한다.
- 수동 모바일만 중복 현장 전체·층 집계·범례와 기존 제어 방식 전환을 더보기로 옮긴다. 기본 화면에는 현재 `수동 제어` 식별을 남긴다. 권한이 확인된 manual-active shell만 집계 행을 감추고 기존52px action을 가진 compact topbar 높이를 사용한다. 네 camera 기능은 같은 FloorMapViewport의 overlay chrome에서 접근하며 handler/camera/renderer는 그대로다.
- 보조 콘텐츠는 고정 portal target을 사용해 화면 폭 변경에도 이력/복구 상세·React owner/ref/subscription을 유지한다. 이동 직전 내부 포커스가 있으면 같은 연결된 표시 요소에 preventScroll로 복원한다. Escape(실제 opener 포함)/닫기/동일 opener 재클릭은 실제 opener에 돌아간다. 현장·주체·층·선택 방식 경계는 보조 패널을 닫는다.
- raw31·invalid blur/Enter·첫 invalid Apply 차단·별도 명시 적용, 권한/잠금·동일 UUID 복구를 유지한다. 기본 standalone/PC·자동화/editor/embedded 소비자는 기존 표시 정책을 유지한다. 공통 UI/public API 변경은 없다.

### 미구현

- 최종 source의 실제320/390×600 map240 목표·지도 우세·map rect/canvas/camera 불변, 마지막 action 도달·nav 겹침0·continuous44 hit·slider 끝 간섭 검증은 총괄 source freeze 이후 UX 후속 QA다.
- 실제 OS keyboard/touch/safe-area 및 장비/HIL 검증은 수행하지 않았다.

### 부족하거나 개선이 필요한 기능

- 원69b1 실제 QA에서 기본 지도62/70px,390 긴 목록 펼침 후 height0/canvas 연결 해제를 확인했다. 새 보조 패널의 overlay만으로 이 결함을 덮지 않고 기본 화면의 반복 chrome부터 줄였다. 지도 min240 강제나 새 overflow clip은 추가하지 않았다. 현재 직접 테스트/선언된 layout을 실제 높이 PASS로 해석하지 않는다.
- 보조 패널은 지도를 부분적으로 가리는 읽기 영역이다. 목록/더보기 전환과 두 펼침 상호배타, 내부 wheel/scroll 끝, 긴 오류·모드 전환 접근성·PC/모바일 portal 내부 포커스는 실제 QA에서도 확인한다. default-false 기존 compact opt-in과 manual-active 보고 경계를 유지한다.

### 관련 파일

- `apps/web/src/features/control/manual-workspace/ManualAuxiliaryPanel.tsx`와 ControlView/ManualExecutionPanel/target-selection 및 직접 테스트.
- `apps/web/src/features/shells/CustomerShell.tsx` 및 실제 Control 소비자 직접 테스트. FloorMapViewport/FloorScene/공통 ticker 제품은 변경하지 않았다.

### 갱신 규칙

- 원 actual RED, 직접 동작 RED/GREEN, source/static 및 actual geometry 결과를 구분한다. source commit과 실제 UX/review/MAIN 통합 관문은 별개다.
- 후속 보조 표현 변경은 renderer·command/query owner와 내부 focus/UUID/raw guard를 함께 확인하고, 메뉴의 이전 세로-flow 기록은 과거 구현으로 읽는다.

## 2026-10-12 실제 QA 후 수동 지도 높이·이력 폭 보완

### 구현 완료

- 수동 모바일 ControlView의 바깥 grid는 제어 방식 auto 행과 남은 높이 minmax(0,1fr) 행으로 나누고, manual tabpanel도 명시적인 남은 높이 행을 사용한다. 기존 implicit auto/content-start에서 size-contained 지도 intrinsic height0만 소비하던 경로를 수정했다. 새 지도 최소높이·overflow clip·renderer 재부모화는 추가하지 않았다.
- 수동 제어의 좁은 실행 패널에 옮겨진 이력 ticker는 caller의 기존 className으로 내용 행과 action 행을 나눈다. 오류 안내·다시 조회·전체 보기·확인 필요한 명령을 남기고, 공통 ticker/default/다른 메뉴의 배치와 query/handler는 그대로다.

### 미구현

- frozen bea0dacb의 실제 QA에서 320×600·390×600·717×1227 지도 높이0을 확인했다. 이번 소스 수리 이후 같은 실제 QA의 높이·canvas·노출 면적·도달성 재측정은 UX/총괄 후속 관문이다.

### 부족하거나 개선이 필요한 기능

- 직접 소비자 테스트는 명령·draft·scope/default 회귀 근거다. CSS 행 선언 변경을 실제 지도 복구 PASS로 해석하지 않는다. 지도240 목표·두 펼침 동시 도달·44px hit·slider0/100 간섭은 실제 QA에서 판정한다.
- PC1194 dark의 GET404 안내 세로 감김은 mock 오류 표현의 폭 경합이다. backend 고장으로 분류하지 않는다. 긴 메시지와 모든 action의 실제 줄바꿈/끝 도달은 기존 QA case6 재검증이 필요하다.

### 관련 파일

- `apps/web/src/features/control/ControlView.tsx` 및 Control/Shell/ManualExecution/Spatial/Viewport/CommandHistory/RecentActivityTicker 직접 소비자 테스트.

### 갱신 규칙

- 실제 QA RED 원본과 소스 수리·직접 회귀·실제 기하 GREEN을 구분해 기록한다. 수동 제어 caller의 높이/폭 수정은 명령 owner/UUID·input·camera·기본 embedded 수명을 유지한다.

## 2026-10-12 신규 지도 의견 C6–8 — 수동 제어

### 구현 완료

- 수동 제어 PC의 선택 대상 패널은 empty 상태에도 지도 행 높이를 소비하도록 구성하며, 선택 이름 목록은 해당 패널 내부 스크롤로 제한한다. 기존 resolved selection/UUID/clear/lock을 소비한다.
- 모바일은 지도 아래 `선택 조명 N개`와 바로 다음 `전체 보기`로 같은 패널의 이름 목록을 인라인으로 펼친다. 목록을 닫거나 Escape로 닫으면 opener로 포커스를 복원하고, 현장·주체·층·선택 방식 경계에서 펼침을 초기화한다. 이 펼침을 위해 새 drawer/query를 만들지 않는다. 기존 전체 조명 목록 버튼의 drawer는 유지한다.
- 권한이 확인된 manual-active 모바일만 finite h-dvh/min-h-0 shell과 기존 navigation safe reserve를 소비한다. 선택 toolbar는 층/선택 범위 dropdown/목록 icon 한 행, 실행은 숫자/slider/적용/더보기 한 행으로 구성한다. 자동화·그룹 관리·editor·embedded의 높이/renderer 기본 정책은 유지한다.
- 빠른 값·이력·긴 복구 상세는 `더보기` 내부 스크롤에 유지하며, 접어도 명령 소유자/query/UUID를 제거하지 않는다. 중요한 조회 오류·불확정·확인 필요·잠금 상태는 접힌 상태에도 live summary로 남긴다. raw draft31·invalid blur/Enter·첫 invalid Apply 차단·별도 explicit Apply를 유지한다.
- 선택적 `FloorMapViewport.compactChrome`은 수동 모바일 caller만 소비한다. 축소·100%·확대·화면 맞춤의 기존 동작, camera/renderer/gesture 수명과 기본 footer 최소240은 유지한다. compact caller는 실제 남은 높이를 사용하며 작은 화면에 강제 최소 높이를 두고 부모에서 잘라내지 않는다.

### 미구현

- 실제 브라우저의 PC panel full-row/empty/long list, 320·390×600 canvas240 목표, map 우세 비율·nav reserve·44px hit·한 행·document scroll0 검증은 총괄의 한정 Task3 QA 관문이다.
- 물리 WebView/touch/safe-area·Gateway/RF/HIL 검증은 수행하지 않았다.

### 부족하거나 개선이 필요한 기능

- 현재 검증은 직접 React 소비자의 명령·draft·selection·scope·default 수명 계약이다. CSS class 문자열 확인이나 JSDOM 크기를 실제 기하 통과로 해석하지 않는다. compact viewport는 min-h-0이므로 실제 chrome이 남긴 공간이240보다 작을 수 있으며 QA에서 수치와 모든 끝 내용의 도달을 확인해야 한다.
- desktop 이력은 단일 실행 보조 영역에 유지하고 모바일에 같은 노드를 더보기로 접는다. query/명령 소유자를 복제하지 않았다. 동시에 선택 목록·More를 펼친 짧은 화면, 큰 글꼴·긴 오류·층/구역 목록·본문 마지막 action과 drawer 반환 focus는 실제 QA가 남아 있다.

### 관련 파일

- `apps/web/src/features/control/ControlView.tsx`, `ManualExecutionPanel.tsx` 및 직접 테스트.
- `apps/web/src/features/control/target-selection/ManualSelectionPanel.tsx`, `SpatialTargetSelector.tsx`, `TargetSelectionToolbar.tsx` 및 직접 테스트.
- `apps/web/src/features/shells/CustomerShell.tsx`, `features/floor-map/FloorMapViewport.tsx` 및 직접 테스트.

### 갱신 규칙

- 수동 모바일 finite shell/선택 펼침/More 변경은 raw draft·explicit Apply·명령 복구/UUID·권한·scope/camera 수명을 함께 확인한다. 기본 embedded/자동화/다른 route에 compact 정책을 퍼뜨리지 않는다.
- source/direct test 완료와 실제 browser 기하·최종 QA·독립 review·MAIN 통합 상태를 구분하고, 실제 검증 뒤240 목표·44px·문서/내부 scroll 결과를 기록한다.

## 2026-10-11 신규 조작 의견 — 현장명 단순화

### 구현 완료

- 고객 공통 헤더의 현재 현장은 site.name만 표시한다. 고객사 접두사를 제거하되 권한 목록/URL scope·truncate/title·집계/action 폭 확보·52px 계정 링크와 기존 모바일 조작 영역은 유지한다.

### 미구현

- 실제 화면·통합 타입/UI 정책/빌드·최종 리뷰는 총괄/QA 후속 검증이다. API/DB/서버·운영·실장비/HIL 변경은 없다.

### 부족하거나 개선이 필요한 기능

- 번호 검색은 이름 문자열에 포함된 번호이고 이미 조회한 조명 목록을 대상으로 한다. 전체 서버 검색으로 표현하지 않으며 기존 다음 페이지·부분 오류·집계 확인 시점 차이 안내를 유지한다.
- 이전 short-mobile 하단 메뉴 공간과 desktop 헤더 폭 수리를 유지한다. 새 패널의 실제 모바일 마지막 action/중첩 select 도달과 5범례 footer 높이는 최종 QA 범위다.

### 관련 파일

- `apps/web/src/features/shells/CustomerShell.tsx` 및 직접 테스트.

### 갱신 규칙

- 공통 현장 정보 변경은 네 메뉴에 같이 기록한다. loaded 목록/서버 집계와 실제 UI/소프트웨어 검증·실장비 증거를 구분한다.

## 2026-10-11 추가 브라우저 의견 — 수동 지도 입력·툴바 (C13–16)

### 구현 완료

- 수동 제어에만 `manual-cad` 입력 정책을 적용했다. PC 중간 버튼/Space 드래그는 지도 이동, 왼쪽 드래그는 영역 선택, 마커 클릭은 개별 선택이다. 터치는 스와이프로 이동하고 마커 탭으로 선택하며 길게 누르기 영역 선택을 만들지 않는다. 일반 wheel 확대·축소와 pinch는 유지한다.
- 마커 입력은 8px 임계값 이후 capture하여 실제 pointerup 탭 선택을 보존한다. 드래그·취소·두 손가락 입력의 잘못된 선택을 차단하고 키보드/보조기기 선택은 유지한다. 잠금·층 전체·구역 선택에서는 대상 변경을 차단한 채 이동을 허용한다.
- 이동/개별/영역 도구와 전용 state를 제거했다. 층 선택과 `조명 목록`을 같은 행에 표시하고 대상 방식 탭을 유지한다. 수동 구역 관리/현황 버튼과 전용 Dialog state를 제거했으며 저장 구역 메뉴·대상 선택은 유지한다.
- 중앙 선택 목록에 테마 panel 배경·둥근 테두리를 적용하고 보이는 `조명 제어` 제목을 단일 sr-only h1으로 바꿨다. 선택 해제·raw31 밝기 초안·명시 적용·권한·명령 수명은 유지한다.

### 미구현

- 담당 단계에서 전체 Web·타입·UI 정책·빌드·브라우저·실장비/HIL 검증은 실행하지 않았다. 최종 한정 화면·정적 검증은 총괄 QA 단계다. API/DB/schema/Gateway/펌웨어 변경은 없다.

### 부족하거나 개선이 필요한 기능

- 최종 직접 5 suites 295/295 통과. 최초 지도 RED 4 FAIL/34 PASS, UI focused RED 5 FAIL/1 PASS/189 비선택은 별도 증거다. 중간 Dialog setter 잔여 참조의 162 FAIL/128 PASS와 이전 tool 기대 2 FAIL/293 PASS를 수정했으며 최종 통과에 합산하지 않는다.
- 단위 DOM의 pointer 경로는 실제 브라우저 capture·mobile/dark·짧은 viewport geometry의 증명이 아니다. 기존 240px 지도 최소 높이·내부 스크롤·명령 잠금 owner를 보존했으며 실제 사용성은 최종 화면 검증 대상이다.

### 관련 파일

- `apps/web/src/features/floor-map/FloorMapViewport.tsx`와 viewport/실제 `FloorScene` 조합 tests, `features/control/ControlView.tsx`, `target-selection/{SpatialTargetSelector,TargetSelectionToolbar}.tsx` 및 직접 tests. `FloorScene.tsx` 제품·monitoring/editor/embedded 기본 입력 정책은 변경하지 않았다.

### 갱신 규칙

- 수동 전용 입력과 공통 지도 기본 정책을 구분한다. pointerup·임계값·취소·Space/pinch·잠금·keyboard와 초안/명령 수명 근거를 유지하고 unit·browser·실장비 결과를 서로 확대하지 않는다.

## 2026-10-11 공통 필터·날짜·행 상세 교정

### 구현 완료

- 공통 FilterPanel은 모바일에서 하단 modal sheet, desktop에서 기존 popover를 사용한다. 중첩 달력/select와 닫기 잠금·포커스 복귀 계약을 유지한다.
- 날짜는 실제 달력 아이콘과 square 44px trigger, 안쪽 segment focus를 사용한다. 범위는 한 줄이며 raw draft·검증을 유지한다. DataGrid는 선택적 카드 요약 열과 stable row key에 연결된 인라인 상세를 제공한다.

### 미구현

- 실제 짧은 320/390px 화면·양 테마의 geometry와 최종 통합 검증은 후속 QA 범위다.

### 부족하거나 개선이 필요한 기능

- 날짜 숫자 segment는 텍스트 폭이다. 6개 segment와 달력을 320px 한 줄에 넣기 위해 segment 개별 44px 폭은 적용하지 않으며 전체 입력 높이와 달력/버튼 hit는 유지한다. 단위 테스트는 실제 화면의 겹침·터치 검증을 대신하지 않는다.

### 관련 파일

- apps/web/src/components/ui/{FilterPanel,DataGrid}.tsx, overlays/Popover.tsx, date/{DatePicker,DateRangePicker,date-field}.tsx 및 직접 테스트.

### 갱신 규칙

- 공통 소비 변경 시 네 메뉴 문서를 함께 갱신하고 실제 browser 증거를 단위 검증과 구분한다. API/권한·데이터·작업 수명은 유지한다.

## 2026-10-11 브라우저 의견 반영 — 선택 목록·자동화 툴바·표 간소화

### 구현 완료

- 수동 제어의 기존 중앙 상세 슬롯을 개별 선택에서도 유지하고 실제 선택 조명 이름을 표시한다. 선택 해제는 목록 우상단으로 이동하며 오른쪽 실행 패널의 중복 조명 목록을 제거했다. 선택 수 live announcement는 한 곳이고 밝기 표시에서 `초안` 문구만 제거했다.
- 제어 ATLAS 문구와 스케줄·이벤트 소제목을 제거했다. 스케줄 추가는 기존 목록 툴바로 이동하며 global 목록 계약이 없는 응답에서도 유일한 추가 버튼과 생성·삭제 후 포커스 복원 ref를 유지한다. 이벤트 추가와 조회 전용 상태도 유지한다.
- 스케줄 활성 열의 표시·정렬은 활성/비활성만 사용한다. 적용 기간의 시간대 보조 행을 제거하되 실제 현장 시간 변환과 편집 Dialog의 시간대 안내는 유지한다. 스케줄·저장 구역 표의 이름은 왼쪽, 나머지 열은 공통 DataGrid의 명시 align으로 가운데 정렬한다.
- 저장 구역의 게이트웨이 열과 불필요한 Mesh 버전·주소 안내를 제거하고 준비된 구역은 `준비됨` badge로 표시한다. 비정상 상태 사유·실제 오류와 수정·삭제·재동기화 권한 및 잠금은 유지한다.

### 미구현

- 이번 직접 검증에서는 전체 Web·타입·UI 정책·빌드·브라우저·실장비/HIL을 실행하지 않았다. 총괄·QA의 최종 묶음 검증은 후속 단계다. API/DB/schema/Gateway/펌웨어 계약 변경은 없다.

### 부족하거나 개선이 필요한 기능

- 직접 영향 7 suites 373개가 통과했다. 최초 RED는 변경 전 표시 계약에 대한 9 실패/329 통과였으며 최종 373 통과와 합산하지 않는다.
- 숨긴 스케줄 개별 Gateway 동기화 badge와 준비된 구역 metadata를 위한 새 상세 UI는 추가하지 않았다. 스케줄 sync 필터·조회 오류 알림·최근 실행 결과와 구역 비정상 상태/재동기화 경로는 유지한다.
- 중앙 목록의 실제 짧은 높이·모바일·양 테마 배치와 버튼 위치는 별도 QA 화면 검증 대상이다. 기존 실제 UUID/ACK·복구·전체 대상 선택 계약을 UI 정리의 검증으로 실장비 완료라고 기록하지 않는다.

### 관련 파일

- `apps/web/src/features/control/{ControlView,ManualExecutionPanel}.tsx`, `target-selection/SpatialTargetSelector.tsx`, `automation/{ScheduleControlPanel,VehicleEventControlPanel}.tsx`, `automation/components/AutomationRuleControls.tsx`, `groups/FixtureGroupsContent.tsx`와 직접 영향 테스트.

### 갱신 규칙

- 밝기 초안의 표시 문구 제거와 즉시 장비 제어를 혼동하지 않는다. raw 숫자 입력 검증·명시 Apply·selection/UUID/ACK/복구 owner와 표시 변경을 분리해 기록한다. focused 자동 검증과 후속 실제 화면/전체 검증의 증거를 구분한다.

## 2026-10-11 브라우저 의견 반영 — 공통 헤더·표 정렬

- PC 계정 링크는 기존 둥근44px 영역의 연속44px 조작 한계를 보완해 기존52px icon target 크기를 사용한다. 링크 의미/href/focus는 유지하고 모바일 비표시와 계정 기능 본문은 변경하지 않는다. 원형상 실패와 최종 세 폭 실제 조작 검증은 QA 증거로 구분한다.

- 긴 현장명 후속: desktop 헤더는 집계와 action의 내용 폭을 먼저 확보하고 현장명에 남은 폭을 배분해 줄임표가 동작하도록 grid track을 보완했다. 기존1280/760 실제 집계 overflow와 테마 버튼 가림은 원 증거에 보존한다. gap12·모바일 네 동일 폭 행·로고·권한/URL 수명은 유지하며1440/1280/760 실제 비겹침 후속 검증은 QA 보고서로 구분한다.

### 구현 완료

- 현재 customer admin/viewer의 단일 현장 계약에 맞춰 고객 헤더의 현장 선택과 전환 전용 dialog/hook/component를 제거하고, 권한 목록에서 확인한 현재 현장을 일반 텍스트로 표시한다. 현장 목록 권한 확인·dashboard·URL siteId·알람 scope와 로그아웃 dirty guard를 보존한다.
- PC 헤더 네 집계는 내용 폭과 균일한 간격으로 표시하며 모바일 네 동일 폭 셀은 유지한다. DataGrid의 명시 align은 헤더·정렬 버튼·본문·모바일 값에 적용한다. align이 없으면 기존 헤더 center/본문 left/customer compact card right 기본값을 유지한다.

### 미구현

- 이번 단계에서 전체 Web·타입·UI 정책·빌드·브라우저 검증은 실행하지 않았다. 최종 묶음 검증은 총괄 후속 범위다. API/DB 계약·운영·실장비/HIL 변경은 없다.

### 부족하거나 개선이 필요한 기능

- 공통/모니터링 직접 5 suites 190개가 통과했다. 설정 suite 첫 실행의 별도 홈 카드 group 조회 실패는 기본 d8dbfcd1의 정확 동일 테스트에서도 재현되어 이번 변경과 분리한다. 기존 실패를 전체 통과로 숨기지 않는다.
- 새 현장 정보 표시와 PC 집계 간격의 실제 긴 이름/양 테마/viewport 화면 검증은 최종 브라우저 단계에 남아 있다.

### 관련 파일

- `apps/web/src/features/shells/{CustomerShell,CustomerHeaderSummarySlot}.tsx`, `apps/web/src/components/ui/DataGrid.tsx` 및 직접 테스트. 전환 전용 `features/sites/{SiteSwitcher,useGuardedSiteSelection}`와 전용 테스트는 삭제했다.

### 갱신 규칙

- 현장 표시 제거와 서버 권한 조회 제거를 혼동하지 않는다. 공통 헤더·DataGrid 소비 변경 시 네 메뉴 문서를 같이 갱신하고, focused 검증과 최종 화면/전체 검증을 구분한다.

## 2026-10-10 충실도 교정 최종 확인

### 구현 완료

- 층→대상 방식→목록/관리 toolbar, 맵 상단 내부 도구·인라인 집계, 큰 대상 수/제한 목록/단일 밝기 초안·bare slider, 한 footer·이력·자동화 밀도·실제 그룹 DataGrid를 교정했다. 감사30행은 [담당 결과](../assets/atlas-ui-refresh-2026-10-07/audit-2026-10-10/implementation/task-6-report.md)를 따른다.
- Controlled1024×600 긴 recovery에서 document600/scrollY0·map viewport≥240·내부 scroll 후 모든 action44px·theme/resize/draft 추가 write0을 확인했다. PC/dark 대표 화면, 최종 타입·정책79/79·UI위반0/0·빌드 exit0·code/UI·UX 리뷰도 회수했다. 아래 Task6의 대기 상태는 당시 기록이다.

### 미구현

- 실제 command/장비/HIL·whole583/Lab/canonical·전체 runtime 행렬 미실행. CAD/whole-selection/offline 정책을 목업의 가상 부분 실행으로 바꾸지 않았다.

### 부족하거나 개선이 필요한 기능

- Browser12 고유사례는 최초 실행과 국소 수리의 source별 결과이며 최종HEAD전체12 일괄PASS가 아니다. 실제 map/status fixture 및 실차/BIO/canonical payload/ACK/복구 한계·큰 번들 경고를 유지한다.

### 관련 파일

- 위 Task6·공통 지도 보고서, `apps/web/e2e/atlas-ui-fidelity.spec.ts`, [화면/실측/로그](../assets/atlas-ui-refresh-2026-10-07/audit-2026-10-10/implementation/README.md).

### 갱신 규칙

- raw draft·명시 Apply·UUID·잠금 owner와 시각 표현을 분리해 기록한다. 실패와 targeted retry를 합산하지 않으며 로컬 통합 상태는 계획/상태판을 따른다.

## 2026-10-10 공통 eyebrow 후속

### 구현 완료

- 공통 PageHeader의 선택적 `eyebrow?: ReactNode`를 소비해 단일 h1 위에 목업 원문의 ATLAS / OPERATIONS를 중립 secondary 색상으로 표시한다. title/ref/ARIA/설명/status/actions를 유지하고 같은 헤더가 main/loading/error 분기를 계속 소유한다. 설정 제목은 단순형을 유지한다.
- 기존 overline11px/bold·8px 내부 gap을 재사용하고 자간은 기존 상속을 유지한다. 목업10/11px·.14/.16em 자간을 위한 신규 token/registry/policy는 추가하지 않으며 실제 pixel 일치는 최종 화면 검증 범위다.

### 미구현

- 실제 responsive/dark 화면 및 통합 type/UI/build 검증은 Task11에 남는다. 전체 Web/E2E/Lab/canonical/HIL은 이 후속에서 실행하지 않았다.

### 부족하거나 개선이 필요한 기능

- 공통 CustomerPresentation/Typography33개와 직접 소비자 focused10개가 통과했다. 소비자396개는 필터 비선택이며 전체 suite 통과로 확대하지 않는다. 하드웨어 상태/통계 값/보고서 결과를 목업 값으로 변경하지 않는다.

### 관련 파일

- `apps/web/src/components/ui/{PageHeader.tsx,CustomerPresentation.test.tsx}`, `features/monitoring/MonitoringView.tsx`, `features/control/ControlView.tsx`, `features/statistics/{StatisticsOverviewPage,analysis/StatisticsAnalysisPage,reports/StatisticsReportsPage}.tsx` 및 직접 제목/진입 focused tests.

### 갱신 규칙

- eyebrow는 공통 PageHeader 표현 slot만 사용하며 별도 header wrapper/제목 owner/query를 복제하지 않는다. 실제 검증 범위·비선택/미실행·pixel 근사를 함께 기록한다.

## 2026-10-10 ATLAS 충실도 교정 — Task 6

### 구현 완료

- 공통 Tasks 1–4의 고정 API 위에서 수동 toolbar를 층→대상 방식→목록/관리 순서의 wrap 행으로 정리했다. manual-workspace만 이 표현을 사용하며 embedded 스케줄/이벤트/구역 선택의 disclosure·선택 정책은 유지한다. 지도 도구는 공통 버튼의 active 상태와 아이콘을 소비한다.
- 우측 제어 대상의 제목·큰 선택 수·높이가 제한된 선택 조명 목록·선택 해제를 추가하고, 밝기를 단일 초안 패널과 bare slider로 표현했다. slider 접근 이름·native thumb와 NumberField raw 입력, 빈 값/소수/범위 오류·blur/Enter 복귀·같은 클릭 Apply 차단, draft-only 0/30/70/100과 명시 Apply handler를 유지한다.
- 제어 이력은 공통 ticker의 `제어 이력` 제목과 plain UUID 버튼을 사용한다. native 버튼/ref·잠금·5초 순환/hover/focus·전체 이력/기간/cursor·확인 필요 사례 연결을 유지한다. 자동화 filter 외곽 카드와 목록의 중복 제목을 정리하고, 그룹은 실제 이름/층/Gateway/대상 수/Mesh 상태·버전/오류/작업을 공통 DataGrid로 표시한다. 기존 query/workspace·membership editor·CRUD/resync·삭제 확인·최신 권한/잠금 handler는 바꾸지 않는다.
- Node 22.20.0/pnpm 9.15.0에서 새 직접 계약 5개를 RED 5FAIL→GREEN 5PASS로 확인했다(`-t fidelity`의 제외 203개는 필터 제외). 직접 소비자 11파일의 첫 실행은 420PASS/3FAIL/skip0이고, 실패는 이력 ticker의 이전 접근 이름 2개와 hit-shape 클래스 기대 1개였다. 이름만 새 표현으로 연결하고 원 모바일 square/PC 모서리 선언을 보존한 최종 두 파일(ControlView·CommandHistoryPanel) 실행은 192PASS/0FAIL/skip0이다. 나머지 9파일 231PASS 소스는 첫 실행 후 변경하지 않았으며 두 실행의 겹친 결과를 합산하지 않는다.

### 미구현

- Task6 당시 Task 11 실제 짧은 PC·모바일·dark 화면/연속 hit·추가 POST0 확인과 공통 PageHeader eyebrow 보완, 통합 타입/UI 정책/빌드·최종 리뷰·병합은 이 과제에서 실행하지 않았다. eyebrow는 위 공통 후속에서 해결했다. 전체 Web/583개/E2E/Lab/canonical·실장비/HIL은 Task6과 이번 후속 모두 실행하지 않았다.

### 부족하거나 개선이 필요한 기능

- 단위 DOM의 읽기 순서/선택·잠금 증거는 실제 geometry 증명이 아니다. 짧은 PC의 외부 document scroll0·지도 viewport 240px·workspace/안전 결과 내부 scroll·모든 CTA 접근, mobile 자연 scroll·52px 기존 지도 touch 유지 여부는 Task 11에서 확인해야 한다.
- 실제 차량/BIO source/hold/준비·동기화, frozen UUID/canonical payload/ACK 원대상·generation·복구/보관/storage 잠금, whole-selection 차단과 CAD 고유색의 기존 한계를 보존한다. 목업의 오프라인 제외 부분 실행·가상 synced/센서 이벤트·polygon 저장은 추가하지 않는다.

### 관련 파일

- `apps/web/src/features/control/{ControlView,ManualExecutionPanel,CommandHistoryPanel}.tsx`와 직접 테스트, `target-selection/{TargetSelectionToolbar,SpatialTargetSelector}.tsx`와 직접 테스트, `automation/components/{AutomationRuleControls,AutomationWorkspaceSurface}.tsx`, `groups/FixtureGroupsContent.tsx`, `groups/FixtureGroupsPanel.test.tsx`.
- 보존된 30항목 감사: [제어 감사](../assets/atlas-ui-refresh-2026-10-07/audit-2026-10-10/control.md). 현재 실행 순서와 후속 실제 확인은 [충실도 교정 계획](../superpowers/plans/2026-10-10-atlas-ui-fidelity.md)의 Task 6/11을 따른다.

### 갱신 규칙

- 공통/제어 표현 변경과 실제 command/automation/group 계약 변경을 구분한다. 기존 목업·BIO·실장비·실패 이력은 삭제하거나 새 PASS에 합산하지 않는다. 실제 화면·통합 결과와 로컬 병합은 총괄이 확인한 뒤 별도 갱신한다.

## 2026-10-10 공유 지도 chrome (Task 4)

### 구현 완료

- 공유 OperationMapPanel의 title/tools-left·실제 summary-right와 inset16/12를 적용했다. manual workspace의 기존 정상/장애/오프라인/선택 범례를 FloorMapViewport.footerStart에 전달하여 camera-right와 같은 wrapping static footer bar로 표시한다. 별도 중복 범례 strip은 제거했다.
- viewport/renderer identity·카메라/zoom/fit·선택/gesture·전체보기 owner와 기존44px 및 더 큰52px hit를 유지한다. footerStart 없는 소비자의 기존 footer 및 기본 overlay 배치는 불변이다. embedded/등록/그룹의 선택 정책과 기존 strip도 유지한다.

### 미구현

- 실제 mobile/short desktop/footer wrap·dark geometry 최종 확인은 Task11 범위다.

### 부족하거나 개선이 필요한 기능

- 두 공유 map suite와 selector 계약, monitoring 범례/zoom focused 검증이다. 실제 브라우저 시각 일치·CAD 성능·게이트웨이/조명 HIL 완료 증거는 아니다.

### 관련 파일

- `apps/web/src/components/ui/maps/OperationMapPanel.tsx`, `features/floor-map/FloorMapViewport.tsx`, `features/monitoring/FloorMap.tsx`, `features/control/target-selection/SpatialTargetSelector.tsx` 및 관련 focused tests.

### 갱신 규칙

- footer slot opt-in/default 경계·실제 상태·카메라 lifetime·최소 viewport240/사용성 hit와 추후 browser/HIL 한계를 함께 기록한다.

## 2026-10-10 고객 shell·제목·탭 소유 (Task 3)

### 구현 완료

- 고객 desktop header는 현장 선택/실제 네 집계/기존 상태·테마·계정 링크를 한 행으로 배치하며 mobile logo/select 및 집계 둘째 행을 유지한다. shell의 route h1을 본문으로 옮기고 공통 customer 탭·sidebar soft active 및 compact account strip을 연결했다.
- 조명 제어 h1 뒤에 모드 탭을 표시한다. 권한·URL mode/search/hash·키보드 전환 및 실제 제어 owner는 유지한다.

### 미구현

- 메뉴 상세 표현·지도 chrome의 후속 교정과 최종 통합 시각 검증은 남아 있다.

### 부족하거나 개선이 필요한 기능

- shell/summary/control tabs/settings shell targeted 계약 검증이며 실제 320–desktop geometry·dark 대비·실장비 완료 증거는 아니다.

### 관련 파일

- `apps/web/src/features/shells/{CustomerShell,CustomerHeaderSummarySlot,CustomerAccountPanel,SettingsNavigationItem}.tsx`, `settings/{SettingsShell,SettingsSubnavigation,settings-sections}.tsx`, `control/automation/ControlModeTabs.tsx`, `statistics/StatisticsSubnavigation.tsx` 및 메뉴 본문 제목 소비자.

### 갱신 규칙

- 단일 h1·실제 capability/summary0·unknown·라우트와 작업 잠금 계약을 유지하며 최종 browser 확인 및 mock/하드웨어 한계를 별도 기록한다.

## 2026-10-10 공통 고객 표현 기반 (Task 2)

### 구현 완료

- 고객 title/metric·card inset·soft pill navigation의 opt-in API와 단일 NavigationCard를 추가했다. 고객 theme 안 보조 버튼을 중립/transparent 표현으로 바꾸고 compact DataGrid는 label/value 두 열 카드로 표시한다. 필터는 라벨과 양수 count, ticker는 desktop 제목/mobile 접근성 제목, 지도 인라인 집계는 상태 dot과 중립 수치를 사용한다.

### 미구현

- 메뉴별 신규 API 소비·전체 상세 화면 교정은 후속 태스크에서 적용한다.

### 부족하거나 개선이 필요한 기능

- 공통 계약의 focused 검증만 수행했다. 메뉴의 실제 시각 일치·브라우저 geometry·실장비 연동 완료 증거는 아니다.

### 관련 파일

- `apps/web/src/components/ui/{Typography,PageHeader,Card,NavigationCard,UnderlineNavigation,Button,DataGrid,FilterPanel,SidePanel}.tsx`, `operations/{InlineStatusSummary,RecentActivityTicker}.tsx`, `fields/Slider.tsx`.

### 갱신 규칙

- 메뉴별 소비와 검증은 해당 후속 구현에서 갱신하며 기본 variant·실제 데이터/권한/작업 owner·44px hit의 한계를 함께 기록한다.

## 2026-10-09 ATLAS LEAN 마무리

- 고객 공통 UI·라이트/다크·모바일 레이아웃과 수동 제어 맵의 직접 도구·선택·명령 이력 표현을 구현했다. 기존 명령 수명과 CAD 색상은 보존한다.
- 이번 최종 검증의 실제 범위·결과는 [상태판](../project-status.md#2026-10-09-atlas-lean-최종화)을 따른다. 전체 583개·Lab·canonical은 축소 범위 밖/미실행이며 기존 mock·실장비·BIO·과거 실패 기록은 보존한다.
- 최종화 절차의 상태는 [계획 체크리스트](../superpowers/plans/2026-10-07-atlas-ui-refresh.md)를 정본으로 확인한다.


## 2026-10-09 모바일 최근 명령 연속 조작 영역 국소 보완 (Task 11)

### 구현 완료

- 기존 최근 명령 native 버튼에만 모바일 `<760px` square 모서리 표현을 적용했다. 기존 최소44px 프레임·PC 모서리와 compact 배치·공통 ticker 외곽/버튼 기본값은 변경하지 않는다. UUID·상태 접근 이름, 선택/callback·disabled handler, 복구/전체보기와5초 순환·retention 소유를 유지한다.
- 수정 전 대응 DOM 회귀는 mobile class 누락으로1FAIL/28PASS였으며 원320px Chromium의 연속44 실패도 별도 보존한다. 같은 수정 source에서 지정3 unit 파일200/200·Web type/UI0(정책 부채0), 원 제어 E2E 전체43/43을 확인했다. 실제 LIST/JSON43 identity 일치·retry/skip/flaky/미실행0이며 compact1440/390/320의 원 높이/연속44/전체보기/넘침 검사를 유지한다.

### 미구현

- 이 국소 보완은 Task11 전체18/ONE Lab/canonical·독립 검토·기본 checkout 병합 완료가 아니다. 운영 서비스·실장비/HIL·추가 제어 기능은 구현하거나 실행하지 않았다.

### 부족하거나 개선이 필요한 기능

- 원usable46×44의 독립 가로/세로 최대값은 연속44×44 증명이 아니며 strict native helper를 유지한다. 실제 corner miss/외부 가림 부재의 인과를 별도 point evidence 없이 확정하지 않는다. 52px 프레임 강제나 ticker 행 재설계·기준 완화로 우회하지 않는다.

### 관련 파일

- `apps/web/src/features/control/CommandHistoryPanel.tsx`, 기존 `.test.tsx`, unchanged `apps/web/src/components/ui/operations/RecentActivityTicker.tsx`, `apps/web/e2e/calm-operations-manual-control.spec.ts`, `apps/web/e2e/support/layout-assertions.ts`와 `.superpowers/sdd/2026-10-07-atlas-ui-refresh/task-11-recent-command-hit-fix-request.md`.

### 갱신 규칙

- 실제 동일 source의 DOM/native 검증과 source별 원실패·미실행 범위를 구분한다. 기존 목업/BIO/과거 기록을 보존하며 전체 검증·수명/명령 안전·실장비 완료로 국소 결과를 확대하지 않는다.

## 2026-10-09 ATLAS·BIO 고정 업스트림 합성 — 소스 보존, 최종 검증 전

### 구현 완료

- 같은 격리 branch에서 ATLAS의 직접 지도 도구·14/16px 인라인 상태·draft-only 밝기·명시적 Apply·원 UUID/잠금과 이미 승인된 BIO 검사/준비 계약을 함께 합성했다. 미준비 marker는 검사할 수 있지만 제어 대상 선택이나 source 확정은 현재 서버 eligibility를 통과해야 한다. 준비 응답만으로 ready를 합성하지 않는다.
- embedded 기본 gesture·camera/renderer·coarse hit/ghost 방어와 manual-workspace opt-in을 유지한다. BIO 검사 상세의 모바일 자연 높이/PC 내부 scroll, activation-only 차단·편집/삭제/명시 비활성화·52px BIO touch, hold10~1800초/기본60초와 source/target 분리는 보존한다.
- 새 합성 source에서 지정11 unit 파일288/288·Web type/UI/build0(정책 부채0)을 회수했다. 별도 support 원26 identity는24PASS/기존 opt-in2SKIP이며 실제 broker/DB transport·Gateway ACL2는 미실행이다. 기본값/skip/fixture를 바꾸지 않았고 owned 준비 output 원복·15174 해제와 잔여 Lab/backup 없음까지 확인했다.

### 미구현

- 새 통합 source의 전체18/ONE Lab/canonical·독립 whole review와 기본 checkout ff-only 병합은 아직이다. 국소288PASS/지원24PASS를 전체 QA·실제 transport2나 실장비 완료로 확대하지 않는다. 운영 migration/배포·profile 승인·USB/RF/광학 HIL은 수행하지 않는다.

### 부족하거나 개선이 필요한 기능

- catalogempty/policyOFF와 과거 software/제한된 A/B 시험 한계를 유지한다. 목업의 오프라인 제외 부분 실행을 실제 whole-selection 차단 정책으로 이식하지 않는다. 현재 합성을 과거 focused PASS나 실장비 준비/정상/지원·재실 판단으로 확대하지 않는다.

### 관련 파일

- `apps/web/src/features/control/target-selection/SpatialTargetSelector.tsx`, `apps/web/src/features/floor-map/FloorScene.tsx`, `apps/web/e2e/{calm-operations-manual-control,control-map-target-selection}.spec.ts`, 기존 BIO 자동화 소비자와 `.superpowers/sdd/2026-10-07-atlas-ui-refresh/task-12-upstream-integration-implementation.md`.

### 갱신 규칙

- 양쪽 과거 기록과 사용자 목업 원문을 정확히 한 번 보존한다. 검사/선택/source 권한·theme 전환/추가 POST0·UUID/240/44px와 actual source별 검증·software/HIL 한계를 구분하고 최종 실제 관문 후에만 완료를 갱신한다.

## 2026-10-07 고객 공통 키보드 포커스 합성 보완 (Task 11)

### 구현 완료

- 고객 light/dark root의 승인 border-focus 역할을 공통 `shadow-focus`의 고객 전용 compiler supplement에 연결한다. stock shadow·명시 shadow-color·다섯 inset/ring/offset/outer 슬롯과 3px geometry를 보존하고 고객 marker 제거 시 비고객 기본 표현을 복원한다. 선언적 shadow2/root alias를 utility가 동적으로 읽는다고 주장하지 않는다.
- exact base-only PostCSS 구조와 CSS 공백만 허용하는 경계 검증으로 utility1/rule1/declaration1을 제한한다. NBSP/VT·중복·변조·escape·외부 override를 거부하며 canonical734/승인 anchor `fac0d214`·빈 baseline을 유지한다.
- 현재 공통 소스의 compiled 계약85개·기존 공통 소비자341개, fresh Web 타입/UI 정책/빌드가 통과했다. public fixture의 양 팔레트40개 focus 대비·border 보존·합성/default/blur와 원 dark390 현장 선택의 실제 focus8.009:1 도달 경계를 확인했다.

### 미구현

- 전체 Task11 화면 매트릭스·후속 alarm/body/PDF 검증과 브랜치 병합은 완료하지 않았다. 새로운 API·장비 제어 기능을 추가하지 않았다.

### 부족하거나 개선이 필요한 기능

- 원 dark390 testcase는 포커스 관문 뒤 QA 색상 parser가 `oklab(0 0 0 / 0.5)`를 해석하지 못해 1FAIL이다. 공통 포커스의 scoped GREEN을 전체 testcase PASS로 확대하지 않는다. 원1.3116 focus 실패 및 중간82/1·83/1 로그는 보존한다.
- public CSS fixture와 Chromium software 검증이며 forced-colors·실제 OS/native WebView·Gateway/Mesh/조명 HIL 검증을 대체하지 않는다. 목업 이력과 실제 서비스 결과를 구분한다.

### 관련 파일

- `apps/web/src/styles/base.css`, `apps/web/scripts/ui-policy.mjs`, `apps/web/scripts/ui-policy.test.mjs`, `apps/web/scripts/ui-policy-baseline.json`, `apps/web/scripts/customer-theme-contract.test.mjs`, `docs/ui-spacing.md`.

### 갱신 규칙

- compiler recipe·기본 token·고객 경계·명시 색상/ring 합성과 실제 포커스 관문을 함께 검증한다. 원 QA parser 수리·후속 화면·물리 검증은 각각 실제 소스와 결과를 회수한 뒤 별도로 기록한다.


## 2026-10-07 공통 이력 empty/error 읽기 보완 (Task 11)

### 구현 완료

- 공통 `RecentActivityTicker`의 행이 없는 모바일 상태에서는 empty/pending/error 문구가 먼저 전체 너비를 사용하고 기존 다시 조회·전체 보기 버튼은 다음 행의 자연 흐름을 사용한다. 한 줄 로드된 명령·timestamp/상태·5초 순환과 PC 인라인 흐름, 원래 버튼/ref·조회/이력 owner는 유지한다.
- 기존 320×740 제어 사례에 실제 공개 오류 문구 `최근 명령을 불러오지 못했습니다.`의 첫 두 글자 Range 줄 위치를 추가했다. 원본 오류/fixture와 모든 기존 선택·42% 초안·touch·navigation·추가 POST 0 검증을 유지한 RED→GREEN에서 문구 너비 22.19→210px, 두 글자 y=402/424→577/577과 기존 재조회/전체 보기 각 높이 44px을 확인했다. 오류를 숨기거나 성공 fixture로 대체하지 않았다.
- 공통·제어 이력·실제 ControlView·모니터링 소비 단위 305개가 통과했다. retry/full history/확인 필요한 명령·초점 복귀, fail-closed 오류·retention/cursor·loaded 순환의 기존 기준을 보존한다. 확인 필요한 명령 버튼의 크기와 실제 명령 UUID/payload/owner source는 변경하지 않았다.

### 미구현

- 전체 Web·전체 E2E/폭/테마 매트릭스·실제 Backend Lab·물리 모바일/native frame·Gateway/LED HIL은 이번 국소 수정의 검증 범위가 아니다.

### 부족하거나 개선이 필요한 기능

- 새 실제 읽기 검증은 격리 mock Chromium의 320×740/light 한 사례다. 단위 flow 클래스 검증은 JSDOM 픽셀 증거가 아니며 pending/긴 오류 문구·PC/dark·모니터링 native 읽기와 전체 대비 승인으로 확대하지 않는다. 최근 이력 조회 오류의 실제 URL/status/code 원인은 여전히 미판정이다. 원래 6개 통과/첫 word-wrap 실패·PNG·후속 GREEN은 `task-11-ticker-error-report.md`에 별도로 보존한다.

### 관련 파일

- `apps/web/src/components/ui/operations/RecentActivityTicker.tsx`와 대응 시험, `apps/web/src/features/control/CommandHistoryPanel.test.tsx`, `apps/web/e2e/control-map-target-selection.spec.ts`, `docs/ui-spacing.md`.

### 갱신 규칙

- 오류 상태를 없애거나 문구·폰트·조작 크기를 줄여 읽기 문제를 숨기지 않는다. empty/error와 loaded 표현 경계, 최신 callback/ref·5초 수명·조회/명령 안전을 함께 검사하고 아래 기존 목업 23줄과 원 실패 증거를 그대로 보존한다.

## 2026-10-07 실제 수동 UI 소비 QA 이행 (Task 11)

### 구현 완료

- 기존 제어 E2E의 모바일 준비 helper는 제거된 펼침 버튼을 누르는 대신 실제 지도 상단의 대상 선택 방식·이동/개별 선택/영역 선택과 항상 표시되는 밝기 수치·슬라이더·Apply를 확인한다. 준비 단계에서 선택·도구·초안·초점·실행을 변경하지 않는다.
- 기존 desktop 이력 두 사례는 실제 `최근 명령 이력` 안의 정확한 `전체 보기` 버튼을 사용한다. 원래 50행·커서·내부 스크롤·상세 UUID·초점 복귀·문서 외부 스크롤 0 검증은 유지한다. 모바일 두 사례는 지도 선택 도구의 세 버튼이 각각 하나씩 표시되는지 확인한다.
- 격리 Node 22/Chromium fixture의 승인된 6개만 한 번 실행해 통과했다: 390×660 실행 도달성, 390×844 구역 이름 16px, PC 1440×900/1024×768 및 모바일 390×844/320×740. 원 선택·밝기 초안·44px hit·geometry·safe-area·query 기준을 삭제하지 않았고, 앞선 두 사례와 모바일 두 사례에는 기존 요청 기록의 추가 POST 0 검증을 더했다.

### 미구현

- 제품 UI·API·권한·명령 owner·공통 컴포넌트는 변경하지 않았다. 전체 파일/전체 Web·실제 Backend Lab·물리 모바일·native frame·Gateway/LED HIL 검증은 이번 6개 소비 QA 범위가 아니다.

### 부족하거나 개선이 필요한 기능

- 앞선 실제 timeout 두 개와 미실행 소스 충돌 네 개를 구분하며, TERM으로 종료된 세 번째 구역 생성 사례를 확정 실패나 이번 통과로 분류하지 않는다. 원 로그·PNG·동결 소스와 이번 별도 실행은 `task-11-control-consumer-report.md`에 보존한다. 이 결과만으로 전체 제어 회귀·실장비 안전·진행 중 명령 UUID 수명 전체가 승인됐다고 확대하지 않는다.

### 관련 파일

- `apps/web/e2e/control-map-target-selection.spec.ts`, `.superpowers/sdd/2026-10-07-atlas-ui-refresh/task-11-control-consumer-report.md`.

### 갱신 규칙

- 실제 공개 UI에 대한 한정 locator 이행과 제품 변경을 구분한다. fixture 권한·GET 형태·selection/UUID/POST·높이/초점 기준과 원 실패 증거를 보존하고, 아래 목업 전용 23줄과 기존 메뉴 이력은 원문 그대로 유지한다.

## 2026-10-07 ATLAS 자동 제어·그룹/구역 탭 (Task 8)

### 구현 완료

- 실제 제어 방식 URL에 `mode=group`을 추가했다. 수동/그룹 조회는 제어 capability, 스케줄/이벤트 노출은 manage capability를 따른다. 기존 siteId·다른 query·hash와 뒤로/앞으로 이동, Arrow/Home/End 순환 초점 및 tab/panel 연결을 보존한다. 테마·탭 변경은 dimming 명령을 발행하지 않는다.
- 기존 구역 Dialog의 query·CRUD·membership·map editor를 private workspace hook/content로 공유하는 그룹/구역 panel을 제공한다. 별도 가상 저장소나 API는 없다. Dialog의 동적 생성/수정 제목·레이아웃, pending 닫힘 차단, 중첩 삭제 확인과 초점 복귀를 유지하며 닫힌 Dialog·비활성 panel은 조회를 멈추고 초안을 초기화한다.
- 독립 검토 M1 보완으로 그룹 탭의 외곽 Card에 기존 승인 `p-4` inset을 적용했다. 공통 Card 기본값·Dialog 여백·private form/query/editor owner는 바꾸지 않는다. 목록·편집·저장 피드백의 PC light/dark에서 실제 16px 여백과 자식 좌우 경계를 확인했고 테마 전환 중 동일 편집기·초안·선택 및 추가 변경 요청 없음도 유지한다.
- 그룹 변경은 최신 canManage와 실제 제출·복구 대기·진행 명령·세션·storage 잠금을 UI와 handler 양쪽에서 확인한다. 조회 전용 사용자의 Mesh 준비 상태 조회는 유지한다. 원 요청 UUID·payload·ACK·복구 저장소와 전체 선택 안전 정책은 변경하지 않았다.
- configuring/retiring/failed-resync, 1~100개 중복 없는 전체 membership 교체와 고정 층/Gateway 경계를 보존한다. 이전 현장의 비동기 완료는 원래 현장 캐시에 반영하고 현재 현장 form/메시지를 덮지 않는다.
- 새 그룹 consumer만 실제 userId/siteId 경계로 구분한다. 같은 현장의 사용자 전환·A→B→A에서 초안/편집기/이전 pending 완료 표현을 격리하고, theme/잠금/반복 query는 이 identity에 포함하지 않는다. ControlView 명령 owner와 공통 provider는 재생성하지 않는다.
- 기존 스케줄·차량 이벤트의 공통 PageHeader/FilterPanel/DataGrid/RowActions/workspace 표현은 그대로 사용한다. 실제 밝기·유지 시간·차량 sensor·Gateway 동기화·현장 시간대·정렬·검색·커서·visible-page polling·오류/재시도는 삭제하거나 가상 데이터로 대체하지 않는다.

### 미구현

- 새 센서 이벤트 계약·API·DB·MQTT·장비 및 native frame 변경은 하지 않는다. 실제 Gateway/LED HIL, 물리 모바일 및 fractional viewport 검수는 별도 관문이다.

### 부족하거나 개선이 필요한 기능

- 자동화 화면 노출의 dashboard manage capability와 기존 mutation의 admin role 경계는 이번 표현 작업에서 임의로 통합하거나 권한을 확대하지 않는다. 관련 단위/실제 격리 Lab 및 후속 QA 증거는 `task-8-report.md`에 구분한다.
- 실제 자동화 browser suite는 새 테스트 DB/PKI/Postgres/Redis/MQTT/API와 simulated Gateway를 사용하는 기존 RealBackendLab이다. 운영 DB·기존 서비스·실장비 성공의 증거가 아니며 startup 실패와 body 검증 결과를 구분한다. 기존 전체 Web ApiError module-binding 원인 검수는 Task 11 carry로 남는다.
- Task 8 관련 단위 517개와 기존 retention 8개, 최종 격리 Lab의 스케줄·차량 이벤트·수동 기준 밝기·삭제/재시작 프로토콜 및 그룹 CRUD/URL/테마 흐름을 확인했다. 앞선 세 browser 실패(생성 Dialog label 범위, responsive 활성/APPLIED 필드, 수동 상세 펼침)는 원로그와 실제 UI에 맞춘 한정 locator 보완으로 구분해 보존한다. 숨겨진 공통 Grid 정렬 select의 복합 접근 이름 자체는 이 작업에서 고치지 않았으며 Task 11 carry다. 그룹 native 캡처는 PC 1280×720의 light/dark 목록 상태이며 별도 모바일·물리 장비 검수를 대체하지 않는다.
- M1 보완의 genuine 표현 RED→관련 192개 통과와 별도 Lab5 전체 시나리오·세 상태/양 테마 원본 6장은 `task-8-fix1-report.md`에 분리한다. 여백 단위 선언 검증은 JSDOM 픽셀 증거가 아니며 실제 inset 검증도 전체 contrast·연속 44px hit·모바일/native/HIL 승인을 대체하지 않는다. 이전 Lab1–4와 전체 Web 결과/소스 경계는 그대로 보존한다.

### 관련 파일

- `apps/web/src/features/control/{ControlView,FixtureGroupDialog}.tsx`, `automation/ControlModeTabs.tsx`, `groups/{FixtureGroupsPanel,FixtureGroupsContent}.tsx`, `groups/useFixtureGroupsWorkspace.ts`와 대응 시험, `apps/web/e2e/automation-control-flow.spec.ts`.
- 변경하지 않은 공통 표현 소비: `automation/{ScheduleControlPanel,VehicleEventControlPanel}.tsx`, `automation/components/{AutomationRuleTable,AutomationWorkspaceSurface}.tsx`; 실제 target/editor·command store·retention 회귀도 함께 검증한다.

### 갱신 규칙

- URL/권한·최신 잠금 handler·query/form/editor 단일 소유와 이전 현장 완료 격리, 원 명령/UUID와 추가 dimming POST 0을 함께 검증한다. software/Lab/HIL을 분리하고 아래 목업 전용 이력 23줄은 원문 그대로 보존한다.

## 2026-10-07 ATLAS 실제 수동 workspace·안전 실행·이력 (Task 7)

### 구현 완료

- 실제 수동 페이지가 해석한 manual 방식·제어 권한·실제 현장 일치를 안정적인 선택 콜백으로 shell에 보고한다. PC는 남은 높이와 내부 workspace 스크롤을 사용하고 모바일은 자연 문서 흐름을 유지한다. 조회 중·선택 없음·명령 복구 잠금은 이 높이 보고 조건이 아니다. 테마를 route/query/명령 key에 넣지 않는다.
- 도면 상단의 이동·개별 선택·영역 선택과 밝기 수치/슬라이더/Apply를 접힘 없이 표시한다. PC toolbar는 공통 첫 행, 실제 지도 chrome과 실행 aside는 같은 다음 행이다. 실제 canvas 최소 240px, 긴 결과·복구 조작은 내부 스크롤로 보존한다. 한 번도 실행하지 않은 빈 최근 결과 제목/패널은 표시하지 않지만 실제 진행·불확정·실패·404/410·storage 오류와 복구 동작은 삭제하지 않는다.
- 표시 층의 서버 `DashboardFloor.summary`를 공통 14px 라벨·16px 수치로 표시한다. 실제 0은 0, 누락은 `—`이며 현장 집계·선택 수·일부 로딩한 fixture로 대체하지 않는다. 도면 층 전환은 기존 선택 대상/도구/카메라 owner를 유지한다. embedded 기본 표현과 제스처는 변경하지 않는다.
- `ManualExecutionPanel`은 기존 raw 정수 0~100 유효성·blur 복원·첫 Apply 오클릭 차단 refs를 보존한 표현 경계다. 0/30/70/100% 빠른 값·수치·슬라이더·Enter는 초안만 변경하며 별도 Apply만 명령을 발행한다. frozen UUID·canonical payload·ACK·원래 대상·명령 owner·재진입/복구·전체 선택 차단은 기존 실제 정책을 유지한다. 부적격 조명을 제외한 부분 실행 목업 정책은 이식하지 않는다.
- 실제 최근 명령 GET limit을 1에서 5로 바꾸고 실제 UUID/시각/대상 수/밝기/상태·시각 거부를 공통 5초 ticker로 표시한다. 전체 보기의 검색·날짜 raw draft·상태·50/100/500/1000개·커서·retention·UUID 상세·확인 사례·초점 복귀와 원래 대상 안전 재적용은 기존 owner/query를 유지한다.
- Task 7 독립 검토 I1 보완: 같은 최근 내용의 새 filtered 배열·callback과 일반 부모/1초 명령 polling 렌더는 5초 순환을 초기화하지 않는다. 실제 표시/접근성 내용·순서·시간대·사용자/현장 변경은 초기화하며 최신 선택·잠금·상세 callback은 표현 전용 Context로 즉시 반영한다. 조회 중/paused/오류/retention 만료는 기존 hook의 fail-closed 결과를 그대로 소비해 과거 행으로 감추지 않는다. M1 보완으로 제어 이력의 전체 보기만 `aria-haspopup="dialog"`를 명시하고 다른 ticker 소비자의 기본 의미는 유지한다.

### 미구현

- Task 8 스케줄·이벤트·구역 탭 재배치와 실제 Gateway/LED/native HIL은 이번 범위가 아니다. API·공유 스키마·DB·MQTT·장비 및 기본 checkout 문서를 변경하지 않았다.

### 부족하거나 개선이 필요한 기능

- 격리 Node/Chromium software fixture 결과만 검증한다. 실제 물리 모바일·native frame·브라우저 fractional viewport·운영 장비 성공을 주장하지 않는다. 원 실패 로그와 최종 검증은 `.superpowers/sdd/2026-10-07-atlas-ui-refresh/task-7-report.md`에 분리한다. 기존 전체 Web `ApiError` module-binding 문제는 Task 11 후속이며 timeout/skip/assertion을 줄여 숨기지 않는다.
- I1/M1의 원 독립 지적·RED·보완 소스의 fresh 검증은 `task-7-fix1-report.md`에 별도로 남긴다. 이전 전체 Web 통과만으로 일반 polling 수명의 순환 정확성을 증명하지 않으며, 보완 후에도 독립 재검토·Task 11/HIL 관문은 별개다.

### 관련 파일

- `apps/web/src/features/control/{ControlView,ManualExecutionPanel,CommandHistoryPanel}.tsx`, `command-history-presentation.ts`, `target-selection/SpatialTargetSelector.tsx` 및 대응 시험, 공통 owner의 `apps/web/src/features/shells/CustomerShell.tsx`, `apps/web/e2e/{calm-operations-manual-control,operational-marker-control-height,command-retention}.spec.ts`.
- 선택적 dialog trigger 의미: `apps/web/src/components/ui/operations/RecentActivityTicker.tsx` 및 대응 시험. Generic ticker의 timer/pause/scope 계약은 변경하지 않는다.

### 갱신 규칙

- 실제 명령 owner 변화와 표현 변화·software/HIL 증거를 구분한다. dark/resize/도구/선택/필터의 추가 dimming POST 0과 UUID/payload 불변, raw invalid blur→Apply 차단, whole-selection 차단, 짧은 PC/모바일의 실제 canvas·44px 조작·모든 복구 버튼 도달성을 같이 검증한다. 아래 기본 checkout의 목업 전용 이력은 원문 그대로 보존한다.

## 2026-10-07 디자인 검토 목업 맵 상단 도구·가용 높이 수정

### 구현 완료

- 로컬 ATLAS 목업의 수동 제어 집계는 모니터링과 같은 한 줄 표시(PC 레이블 14px·수치 16px)로 되돌렸다. 이동·개별 선택·영역 선택 도구는 별도 영역에서 맵 상단 바로 옮겼다.
- PC(761px 이상)는 남은 화면 높이에 도면을 맞춰 페이지 스크롤 없이 하단 제어 이력을 유지한다. 짧은 창의 제어 패널·조명별 결과는 내부 스크롤로 모든 기능에 접근한다. 모바일은 도구·밝기 설정을 바로 표시하는 기존 목업 세로 흐름을 유지한다.

### 미구현

- 실제 서비스 적용·API·명령 계약·장비 연동은 하지 않았다. 아래 제품 구현 이력과 구분되는 목업 전용 수정이다.

### 부족하거나 개선이 필요한 기능

- 브라우저 PC 1304×1229/1440×900/1024×768에서 페이지 넘침 없음·하단 이력 노출을 확인했다. 가상 명령 성공 22/실패 0/오프라인 제외 2와 전체 이력 팝업을 확인했으며 실장비 성공의 증거는 아니다. 모바일 320/390px는 가로 넘침·한 줄 집계·44px 맵 도구를 확인했다. 매우 짧은 창·실제 휴대폰/HIL은 별도 검증이다.

### 관련 파일

- `.superpowers/brainstorm/40560-1791327706/content/atlas-operations.css`, `atlas-operations.js`, `atlas-prototype-v2-compact.html` (Git 제외 로컬 목업).

### 갱신 규칙

- 목업 변경과 제품 반영을 구분하며 도면 상태·반응형 배치 변경 시 모니터링 메뉴 문서도 함께 갱신한다.

## 2026-10-07 공통 작업 표현·수동 지도 opt-in (Task 5)

### 구현 완료

- 공통 인라인 상태(라벨 14px·수치 16px, 0/null 구분), 한 줄 5초 이력 ticker와 표현 전용 도면 chrome을 제공한다. ticker의 전체 보기·재조회는 기존 메뉴 query/상세 owner에 위임한다.
- Task 6 실제 브라우저 검증에서 최초 `body-sm/body` 소비가 13/14px였음을 확인했다. 공통 원 소유자의 보완 `a835fde6`는 기존 `body/body-lg` 의미 토큰으로 실제 14/16px를 제공하며 새 token이나 소비 wrapper를 추가하지 않았다. 최초 구현의 글꼴 완료 주장과 이 보완 증거를 구분한다.
- `SpatialTargetSelector.presentation="manual-workspace"`에서 이동·개별 선택·영역 선택을 도면 상단에 항상 표시하고 `FloorMapViewport.toolModePolicy="explicit"`로 실제 gesture 정책을 연결한다. 이동은 pin 선택을 차단하고 개별 선택은 영역 드래그를 실행하지 않는다. 층/구역 또는 잠긴 선택에서는 선택 도구만 차단하고 이동을 보존한다.
- 기존 embedded·interaction-default는 그대로다. Space/중간 버튼, touch hold/pinch/cancel/ghost click과 전체 선택의 gateway/부적격 차단 계약은 유지한다.
- Task 6 I1 공통 지도 보완은 유효한 명시적 fit/restore snapshot을 resize보다 우선해 frame 이전의 이전 카메라 복귀를 방지한다. 공통 viewport·SpatialTargetSelector 회귀를 확인했으며 제어의 대상 선택·수정 권한·실제 명령 계약을 바꾸지 않는다.

### 미구현

- 수동 페이지의 opt-in 소비·높이/밝기/결과 재배치·실제 명령 이력 adapter와 자동/구역 탭 재배치는 후속 제어 task다. 이번에 명령 owner/UUID/payload/ACK나 밝기 실행 정책을 변경하지 않는다.

### 부족하거나 개선이 필요한 기능

- 공통 제공과 단위·격리 Chromium 증거를 실제 명령/장비 HIL 완료로 확대하지 않는다. 전체폭·dark 시각 QA와 native 입력 검수는 후속 관문이다.
- I1 카메라 수정의 격리 회귀는 실제 장비 명령/응답이나 native WebView 검증이 아니다. 이전 실패 원본과 독립 검수 관문을 유지한다.
- I1 후 전체 Web에서 ScheduleControlPanel 83개가 `ApiError` 생성자/instanceof 경계로 실패했다. 동일 파일 focused 83개 통과와 원 전체 실패를 분리하며 baseline/flaky나 카메라 무관으로 단정하지 않는다. 모듈 해석 원인은 Task 11 canonical QA로 넘긴다.

### 관련 파일

- `apps/web/src/components/ui/{operations,maps}`, `apps/web/src/features/floor-map/FloorMapViewport.tsx`, `apps/web/src/features/control/target-selection/{SpatialTargetSelector,TargetSelectionToolbar}.tsx` 및 대응 단위 시험.

### 갱신 규칙

- opt-in 소비마다 명시적 Apply·명령 0건 부수효과·frozen 대상/UUID·전체 선택 차단을 검증한다. 스케줄/차량 이벤트/구역 편집의 embedded 기본 제스처와 수정 권한을 함께 보존한다.

## 2026-10-07 ATLAS 공통 shell·모바일 브랜드 (Task 4)

### 구현 완료

- 고객 모바일 첫 행에 실제 킨다 mark·현장 선택·알람센터·테마 버튼을 표시한다. dark는 실제 reversed mark를 사용하고 공개/default/landing/concept 브랜드는 그대로다. 현장 선택은 360px 미만 128px, 그 이상 모바일 144px이며 44px 조작 높이·전체 option 이름·기존 선택 callback/ref와 실패/로딩/없음 상태를 보존한다.
- 네 고객 메뉴 헤더의 두 번째 행은 서버 dashboard 현장 집계를 항상 표시한다. 0과 미확인 `—`·로딩·오류를 구분하고 principal/site/route stale guard를 유지한다. 핀에서 현장 집계를 재계산하지 않는다.
- 760–1023px는 80px rail, 넓은 화면은 220px 펼침/80px 접기를 전환한다. 동일 route link·접근성 이름·keyboard tooltip과 eager 계정/로그아웃·full-view·권한 gate 소유권을 유지한다. 고객 primary 버튼은 독립 foreground token을 사용한다.

### 미구현

- 페이지별 ATLAS 재배치, 지도/차트의 새 palette 소비와 실제 native/HIL 검증은 후속 범위다. API·DB·명령 계약·장비는 변경하지 않는다.

### 부족하거나 개선이 필요한 기능

- 이번 근거는 Web 단위·UI 정책·격리 Chromium 회귀이며 물리 모바일/실장비 완료로 확대하지 않는다. 별도 명령 실행/선택 disclosure는 이번 작업에서 바꾸지 않는다.

### 관련 파일

- `apps/web/src/features/shells/{CustomerShell,CustomerHeaderSummarySlot,SettingsNavigationItem}.tsx`, `apps/web/src/components/brand/KindaLogo.tsx`, `apps/web/src/components/ui/{Button.tsx,fields/SelectBox.tsx,utils/cn.ts}`, 대응 테스트 및 `apps/web/e2e/mobile-first-screen.spec.ts`.

### 갱신 규칙

- 고객/비고객 브랜드 경계·양 theme·현장 선택 width와 touch target·0/null 집계·route/query/명령 identity·계정 복구를 함께 검증한다. 별도 task의 페이지 변경과 HIL 한계는 그 실제 증거로 갱신한다.

## 2026-10-07 ATLAS 고객 공통 테마 경계 (Task 3)

### 구현 완료

- 고객 shell 헤더의 공통 44px 아이콘 버튼으로 라이트/다크를 전환한다. 접근 가능한 이름은 다음 동작을 알리고 aria-pressed는 현재 다크 여부를 표시한다. 저장 키 `led-control.customer-theme.v1`는 계정·현장·명령 저장소와 분리하며 기본/잘못된 값/읽기 실패는 light, 쓰기 실패는 현재 탭 테마를 유지한다. 다른 탭의 선호 변경과 삭제/clear도 반영한다.
- 안정된 provider가 고객 화면에서만 root marker를 소유하고 승인된 CSS alias/portal 색을 사용한다. layout 경계에서 computed palette를 발행하며 StrictMode·로그아웃·재진입 cleanup은 자기 marker만 정리하고 다른 owner/native 속성·스타일을 보존한다. 페이지·route·QueryClient·명령·editor identity에 theme를 추가하지 않는다.

### 미구현

- 이 단계는 공통 provider·전환·저장·palette hook만 구현했다. ATLAS 메뉴별 재배치, 모바일 로고/compact 현장 선택, 지도·차트의 hook 구독과 repaint 적용은 후속 소유 task이며 완료로 표시하지 않는다.

### 부족하거나 개선이 필요한 기능

- 테스트는 브라우저 저장소/React 소프트웨어 fixture 검증이다. 실제 native WebView·Gateway·LED HIL을 실행하지 않았으며 전체 페이지의 다크 대비/시각 QA와 독립 통합 검수는 후속 관문이다. CSS 외 palette를 캐시하는 소비자는 hook 연결 전까지 완전한 다크 repaint를 주장하지 않는다.

### 관련 파일

- `apps/web/src/components/ui/theme/{customer-theme.ts,CustomerThemeProvider.tsx,ThemeToggle.tsx,useThemeColors.ts,CustomerThemeProvider.test.tsx}`, `apps/web/src/features/shells/CustomerShell.tsx` 및 대응 테스트.

### 갱신 규칙

- 테마 경계 변경 시 저장 읽기/쓰기 실패·cross-tab clear·root cleanup·열린 portal·draft와 route/query identity 및 추가 명령0 회귀를 함께 확인한다. 공유 palette 소비자의 후속 적용과 실장비 한계는 실제 검증 범위에 맞춰 별도로 기록한다.
## 2026-10-13 BIO 이벤트 활성화·유지시간·동기화 표시 보정

- 구현 완료(소프트웨어): 현재 현장·Gateway·감지 센서 프로토콜이 일치하고 모든 저장된 감지 센서의 서버 `sourceEligible`이 true일 때만 관리자에게 BIO 활성화를 제공한다. 렌더링만으로 활성화하지 않으며 준비 상실·센서 누락/재매핑은 차단한다. 활성 규칙의 명시적 비활성화는 준비 상실 후에도 가능하다. 공통 목록 작업 UI·모바일 터치 영역·권한/요청 세대 보호를 재사용한다.
- 구현 완료(소프트웨어): 고정 OFF 문구 대신 현재 센서 준비와 규칙 활성 상태를 구분한다. 과거 운영 보고·실행/복원 미확인은 별도 표시한다. 새 BIO 규칙은 비활성 초안이고 기존 활성 규칙의 유지시간 60→10초 편집은 활성 상태를 보존한다. 서버의 현재 자격·대상 충돌 검증은 유지한다.
- 구현 완료(소프트웨어): API 응답·목록 필터·현장 집계가 같은 Gateway 구성 판정을 사용한다. BIO APPLIED는 양수 desiredRevision과 같은 해당 규칙의 appliedRevision이 추가로 필요하다. 이는 현재 V2 ACK에서만 쓰이는 근거이며 BIO를 포함하지 않는 V1 ACK/이전 revision/0은 PENDING이다. REJECTED는 Gateway 구성 거절이지 센서 건강·규칙 실행 성공이 아니다.
- 미구현: 메인 통합·실행 중 서비스 반영·규칙 실제 활성화·새 움직임/유지/복귀 및 실제 UI10초 변경 시험은 수행하지 않았다. 기존 실제 A 준비/비활성 초안 증거와 이번 합성 테스트를 구분한다.
- 부족하거나 개선이 필요한 기능: 사용자 단독 진행 지시에 따라 자체 검토만 수행했다. 독립 리뷰·실제 DB 목록 필터 통합·실장비 동작은 이번 검증에 포함하지 않는다. Web 빌드의 기존 500kB chunk 경고는 남지만 빌드는 성공했다.
- 관련 파일: `apps/web/src/features/control/automation/{VehicleEventControlPanel,VehicleEventDialog}.tsx` 및 관련 테스트, `apps/web/e2e/control-map-target-selection.spec.ts`, `apps/api/src/automation/vehicle-event-rules.service{,.spec}.ts`.
- 갱신 규칙: RED에서 UI 활성화/활성 편집/API 상태·필터 실패를 확인한 뒤 Web103/103·API71/71·Chromium7/7(320/390/1440px, mock API), 양쪽 타입/빌드·diff 검증으로 GREEN을 확인했다. 정상 운영 서비스 적용·현재 센서 자격·사용자 RF/광학 관찰은 별도 기록한다.

## 2026-10-13 테스트 현장 호환 프로파일 등록·전달·준비 후속

- 구현 완료(최신 14:01–14:09 KST): 기존 서버 별칭2개만 교정한 동일 이미지 Gateway가 MQTT·heartbeat·BIO transport/protocol/mapping 준비와 단독 USB 소유를 통과했다. 정상 UI로 A=B1-L001의 새 준비1개가 ready·결과/ACK 발행·현재 사용 가능을 확인했다. 지도에서 A→B=B1-L004, 밝기100%·유지60초인 `A → B 센서 연동 시험`을 비활성 초안1개로 저장했고 서버의 exact membership·설정 및 현재 configuration APPLIED를 확인했다. 실제 등록/설정밝기는 보존됐다.
- 미구현(최신): 규칙 활성화와 새 현장 움직임·재감지 연장·만료 복귀·UI10초 변경·장애/해제 시험은 하지 않았다. 활성 규칙0·준비 pending0이다.
- 부족하거나 개선이 필요한 기능(운영 적용): 당시 Web의 BIO 일괄 활성화 차단/고정 OFF와 API 고정 PENDING은 위 후속 소프트웨어에서 수정했다. 실행 중 서비스에는 아직 반영하지 않았으며 현재 장비 준비 실패나 MQTT 실패와 구분한다. 주소/권한 복구 시점에는 우회·서버 재시작·제품 코드 변경을 하지 않았다.
- 관련 파일(최신): `apps/web/src/features/control/automation/{VehicleEventControlPanel,VehicleEventDialog,BioSensorPreparationPanel}.tsx`, `apps/api/src/automation/vehicle-event-rules.service.ts`, `docs/superpowers/plans/2026-10-08-bio-sensor-operational-enablement.md`.
- 갱신 규칙(최신): 사용 가능·초안 저장·current snapshot ACK·규칙 활성화·RF/광학 관찰을 별도로 기록한다. 아래 오전/과거 실패는 당시 상태로 보존한다.

아래는 최신 복구 전의 역사적 상태다.

- 구현 완료(이번 전달 권한 재읽기): 준비3권한이 이미 있는 현재 native MQTT broker에09:16 KST SIGHUP1회만 보냈다. API/broker/ACL/config/TLS 보존·재시작0·현재 ready200/5개 up을 확인했다. Gateway SSH/기존440 container는 running이지만 실제 연결·준비 결과/ACK/sourceEligible·규칙 활성화는 아직 별도 확인이다.
- 부족하거나 개선이 필요한 기능(현재 연결):09:17 KST 실제 assignment의 MQTT hostname/해당 hosts·ExtraHosts가 현재 서버 Mac LAN IP와 불일치함을 확인했다. 기존 image/배정/신뢰/ID/밝기/state를 유지하는 주소 교정·필요한 container 재구성은 새 승인 대상이다. 준비 요청·규칙 활성화·점등 시험은 아직 하지 않는다.

- 구현 완료(현장 적용): 공통 센서 Gateway/API 호환 runtime을 적용하고 정상 operator UI에서 관측 장비의 profile revision1을 등록했다. current catalog4의 exact 귀속·revision/hash 적용 ACK는 실제 MQTT 경로로 확인했다. 제어 UI를 새로 만들거나 이벤트를 자동 활성화하지 않았다.
- 구현 완료(후속 정책 전달): 정상 현장 관리자 UI의 승인된 시험용 정책 ON과 새 catalog5 exact 적용 ACK를 확인했다. A=B1-L001 공통 센서 준비 요청은 단1회 접수했으며 중복 설정하지 않는다.
- 미구현: 10월12일 단1회 준비 요청은 발행 완료 전 timed_out·결과/ACK 없음이다. API 준비용 MQTT3권한 및 재시작 없는 반영은 10월13일 승인됐다. 실제09:05 읽기에서3권한은 이미 현재 파일에 있으나 기존 broker stopped/이전 private API 부재·Gateway heartbeat 오래됨을 확인했다. 현재 화면은 Gateway0/1 연결·조명4대 오프라인이다. 중복 write/reload/새 준비 요청 없이 현재 서비스 대상을 조율한다. 실제 sensor 모드·현재 sourceEligible와 이벤트 규칙 활성화·정식 감지/유지/복귀 확인은 남아 있다.
- 부족하거나 개선이 필요한 기능: 실제 GET3회는 force-off였다. 프로파일/카탈로그 적용은 sensor 모드·sourceEligible·현재 건강 증명이 아니다. 재사용은 관측 근거 범위의 설명이며 기술적 장치 allowlist가 아니고 다른 장치/회로의 실증을 대체하지 않는다. 유지시간10~1,800초와 source/target 분리 규칙은 그대로다.
- 관련 파일: `apps/web/src/features/control/automation/BioSensorPreparationPanel.tsx`, `apps/api/src/automation/bio-sensor-profiles.service.ts`, `apps/gateway/src/bio/bio-sensor-profile-catalog.ts`, `docs/project-status.md`.
- 갱신 규칙: 프로파일 저장·exact catalog ACK·장비 준비·정책/규칙 활성화·실제 점등 확인을 별도 단계로 기록한다. 아래 10월8일 기록은 당시 로컬 통합 상태다.

## 2026-10-08 BIO와 최신 모바일 제어 UI 로컬 통합

- 구현 완료(소프트웨어): 공통 Grid 정렬·작업 메뉴와 BIO 운영 보고를 함께 유지한다. 미준비·비활성 BIO의 활성화만 막고 수정·삭제 메뉴와 활성 BIO의 명시적 비활성화는 기존 권한·요청 잠금에 따라 제공한다. BIO 작업 버튼은 기존 52px 모바일 터치 영역을 유지하며 다른 규칙과 데스크톱 크기는 보존한다.
- 구현 완료(소프트웨어): 최신 직접 선택·pan·pinch 지도와 미준비 조명 검사·공통 센서 준비 패널을 결합했다. 작은 화면의 준비 상세는 자연 높이를 예약하여 지도 뒤에 겹치지 않으며 PC는 기존 내부 상세 스크롤을 유지한다. source 확정은 현재 서버 eligibility로 제한하고 10~1,800초·기본 60초와 source/target 분리를 유지한다.
- 미구현: 이번 통합은 로컬 소프트웨어 병합이며 운영 migration·배포, 승인 프로파일 공급, 실제 MQTT/RF·광학 HIL과 native WebView 검증을 수행하지 않았다.
- 부족하거나 개선이 필요한 기능: 초기 승인 프로파일은 빈 목록이고 현장 정책은 OFF다. 브라우저의 synthetic pointer pinch와 mock 준비 응답을 실제 장비 준비·건강·지원으로 해석하지 않는다.
- 관련 파일: `apps/web/src/features/control/{CommandHistoryPanel,ControlView}.tsx`, `automation/{VehicleEventControlPanel,components/AutomationRuleTable}.tsx`, `target-selection/SpatialTargetSelector.tsx`, `apps/web/e2e/{calm-operations-manual-control,control-map-target-selection}.spec.ts`.
- 갱신 규칙: 최신 공통 UI와 BIO 안전 경계를 함께 검증하고 양쪽 과거 기록을 보존한다. 실제 시험·운영 적용 증거와 이번 mock/타입/빌드 결과는 구분한다.

## 2026-10-08 활성 BIO 이벤트 대상 충돌 admission (Task 6)

- 구현 완료(소프트웨어): 서버는 현재 자동화 잠금 트랜잭션의 canonical 대상 membership으로 snapshot을 만들기 전에 활성 이벤트 규칙의 대상 교집합을 검사한다. 쌍 중 하나가 BIO이면 다른 활성 BIO·BlueZ 규칙과 대상 공유를 `bio_target_activation_conflict`와 안전한 안내로 거절하며, 규칙·revision·구성 hash·outbox 변경은 함께 rollback한다.
- 구현 완료(안전 경계): 비활성 규칙은 대상을 예약하지 않아 겹치는 초안을 보존할 수 있다. 기존 source/target 분리와 활성 BIO source 보호, BlueZ/BlueZ 정책은 유지한다. 새로운 다중 센서 arbitration이나 자동 삭제·재분배는 추가하지 않았다.
- 구현 완료(소프트웨어 통합): 공통 합성 fixture를 사용하는 별도 API disposable DB·Gateway fake-transport 검증에서 exact snapshot/ACK, 전체 hold·read-back 복원, degraded 재시작과 명시 복원 경로를 확인했다. 단일 프로세스·실제 MQTT/RF E2E 증거는 아니다.
- 미구현: 운영 API/Gateway 배포·실제 RF/HIL 검증은 수행하지 않았다.
- 부족하거나 개선이 필요한 기능: 기존 충돌 구성을 자동 수복하지 않는다. 동일 대상의 여러 활성 센서 규칙을 지원하려면 별도 제품 arbitration 설계가 필요하다.
- 관련 파일: `apps/api/src/automation/automation-snapshot.service.ts`, `apps/api/src/automation/automation-snapshot.service.spec.ts`, `apps/api/test/bio-sensor-catalog-preparation.integration.spec.ts`, `apps/gateway/src/automation/bio-pulse-scheduler.ts`, `test/fixtures/bio-sensor-common-path-v1.json`.
- 갱신 규칙: API 저장 거부·내구 rollback, Gateway 실제 설치·실행, 운영 배포·장비 검증의 증거를 구분한다.

## 2026-10-08 공통 센서 준비·이벤트 설정 UI (Task 5)

- 구현 완료(소프트웨어): 감지 센서 지도에 전체 등록 조명을 유지하고, 미준비 마커·목록도 검사할 수 있다. 현재 검사한 조명 한 개의 공통 준비 패널에서 복수 차단 사유와 다음 조치를 표시한다. `bioSensorPreparation.preparationCandidate`는 작업 가능 안내에만 사용하며 source 확정은 현재 서버 `vehicleEventSource.sourceEligible`로 제한한다.
- 구현 완료(소프트웨어): 현장 관리자 `commission` 권한으로 센서 사용 설정·읽기 전용 준비 확인을 요청한다. POST 접수·GET 초기 ready를 현재 사용 가능으로 승격하지 않고 dashboard를 갱신한다. 자동 GET은 최대 5회·요청 만료 안에서 종료하고 수동 GET 재시도, 중복 요청 identity·늦은 응답·현장/조명/공개 근거 변경 방어를 제공한다. 일반 제어 사용자는 상태를 읽고 준비된 source를 선택하되 준비 작업은 관리자에게 요청한다.
- 구현 완료(소프트웨어): 감지 센서/실행 조명 역할 문구, 동일 Gateway와 source·다른 활성 BIO source 대상 제외, 기본 60초·10~1,800초 수정 흐름을 유지한다. 기존 지도·버튼·카드·텍스트와 bounded 내부 상세 영역을 재사용한다.
- 미구현: 실제 승인 프로파일 공급, 운영 DB migration·API/Gateway 배포, 실장비 센서 설정과 RF·광학 검증은 수행하지 않았다. 최초 BIO 규칙은 기존 비활성 초안 정책을 유지하며 활성화는 서버의 현재 자격 판정을 따른다.
- 부족하거나 개선이 필요한 기능: 공개 DTO에는 raw binding/catalog identity가 없으므로 화면은 공개 command/profile/status/사유와 query 갱신 경계만 관찰한다. 최종 동일 장비·현재 권한 검증은 서버가 수행한다. 모드 GET·독립 연결 응답은 감지 회로 건강이나 자체 광학 출력이 아니다.
- 관련 파일: `apps/web/src/features/control/automation/{BioSensorPreparationPanel,VehicleEventSourceStatus,VehicleEventDialog}.tsx`, `apps/web/src/features/control/target-selection/{SpatialTargetSelector,FixtureSelectionDrawer}.tsx`, `apps/web/src/features/floor-map/FloorScene.tsx`, `apps/web/src/api/{automation,queries}.ts`, `apps/web/e2e/control-map-target-selection.spec.ts`.
- 갱신 규칙: 초기 준비 checkpoint, 현재 서버 eligibility, 실제 감지·광학·운영 적용을 분리한다. PC·모바일 browser fixture 결과를 실장비 HIL 또는 native WebView 검증으로 표현하지 않는다.

## 2026-10-08 공통 BIO current 준비와 조건부 규칙 admission (Task 4 API)

- 구현 완료(소프트웨어): 고정 제품 OFF 거절 대신 단일 DB predicate를 capability 수신·규칙 저장·dashboard와 직접 SQL enabled source guard가 함께 사용한다. 현재 유일 승인 full fingerprint/profile, accepted 준비·catalog ACK, 현재 귀속·유효 MQTT 권한·V2 선언, 활성 담당자 정책과 profile maxAge 안의 별도 live 관측이 모두 필요하다. 첫 live ready도 인증된 제안값으로 판정한다.
- 구현 완료(안전 경계): BIO source 1개·같은 Gateway·source/target 분리·10초 하한은 유지한다. fresh ready→ready와 동일 V2 지원 재선언은 snapshot revision/hash를 바꾸지 않는다. 철회·담당자/귀속 변경·live 만료는 enabled rule을 disable하고 내구 작업으로 snapshot을 수렴하며, 완료 전 옛 enabled snapshot 재전달/새 publish permit은 보류한다. disable/delete·명시 복원 경로와 과거 target attribution은 보존한다.
- 구현 완료(후속 소프트웨어): Web 준비/정책 소비는 위 Task 5, 공통 합성 fixture의 별도 API disposable DB·Gateway fake-transport 통합은 Task 6에서 확인했다. 최종 준비 큐 정체 보완은 집중 회귀와 별도 최종 수정 검토 대상으로 구분한다.
- 미구현: 단일 프로세스·실제 MQTT/RF E2E, 운영 migration·배포 및 실제 RF/HIL 검증. 초기 profile은 빈 목록·정책 OFF이며 이번 작업은 제품 ON이나 실제 장비 제어가 아니다.
- 부족하거나 개선이 필요한 기능: mode GET은 링크 응답이지 PIR 회로·광학·전력 증거가 아니다. 이미 발급된 network publish permit의 물리 race를 제거했다고 주장하지 않는다. 자연 시간만료는 eligibility 즉시 차단 후 bounded worker에서 실제 disable/snapshot으로 수렴한다.
- 관련 파일: `apps/api/src/automation/{bio-sensor-eligibility.ts,vehicle-sensor-capability.service.ts,vehicle-event-rules.service.ts,bio-sensor-profiles.service.ts,automation-outbox-publisher.service.ts}`, `apps/api/prisma/migrations/20261008060000_bio_sensor_current_eligibility/migration.sql`.
- 갱신 규칙: 아래 과거 제품 OFF·시험 기록과 현재 조건부 소프트웨어 admission을 구분하고 실제 운영 승인·적용 증거 없이 완료/ON으로 기록하지 않는다.

## 2026-10-08 A/B 센서 pilot — 제한된 실장비 기능 시험 통과

- 구현 완료(시험 경로 확인): 브라우저 없는 단1회에서 A의 accepted 시험 알림5건으로 B60% 적용1회·hold60초4회 연장·정상 만료 원복 및300초 종료/A 원복을 확인했다. 사용자도 B 밝아짐과 기존 상태 복귀를 보고했고 native closed/pending0·launcher0·원본 서비스/MQTT/heartbeat·DB 대기8종0을 확인했다.
- 미구현: 이 결과의 정식 이벤트 제어 공급/제품 활성화·일반 조명 qualification. 기존 profile/readiness/factory/운영 DB는 변경하지 않았고 제품OFF를 유지한다.
- 부족하거나 개선이 필요한 기능: accepted01 payload의 한정 시험이며05/motion·clear 의미/독립 PIR 건강/정확한 물리 시각은 미확정이다. GET은 링크 응답이지 센서 회로 건강이 아니다. 앞선 브라우저 전달 실패는 고치지 않았으며 이번에는 사용하지 않았다.
- 관련 파일: `apps/gateway/scripts/bio-sensor-event-pilot.ts`, `bio-sensor-event-pilot-runtime.ts`, `bio-sensor-event-pilot-launcher.ts`, `docs/project-status.md`, `docs/superpowers/plans/2026-09-30-bio-sensor-pulse-event-control.md`.
- 갱신 규칙: 보호 SM1fw4/ZXGJvD 증거(summary SHAd51412b6…fe63)와 정성 현장 보고를 제품 지원 판정과 분리한다. 자동 재시험/과거 START 재사용은 하지 않는다.

## 2026-10-07 A/B pilot 안전 host launcher — 로컬 코드/fixture만

- 구현 완료(시험용 코드): 새 보호 runroot/phase·one-use START, fresh exact 원본 ID/image/StartedAt, mapping/source/artifact hash·A/B binding·assignment·8개 대기0 관문을 연결한다. UID999 no-device/network-none read/syntax probe가 STOP보다 먼저다. diagnostic은 create ownership label+full ID 뒤 start/TERM하며 수명 unknown/alive면 competing 원본 재시작을 금지한다.
- 미구현: 이번 launcher의 실제 Pi/image/USB/RF 실행·장비 검증·제품 활성화. trusted operator receipt의 API/DB 현재성은 별도 운영자의 읽기 전용 확인이며 코드가 조회하거나 증명하지 않는다.
- 검토 보완(코드): 모든 host CLI에 bounded budget/취소·회수를 적용하고 cleanup은 독립 제어/예산을 사용한다. create/start 직전과 await 후 취소를 재검사하며 원본도 exact-ID TERM 뒤 terminal 증명만 허용한다. Docker stop의 자동 SIGKILL·컨테이너 forcekill은 없다.
- 부족하거나 개선이 필요한 기능: terminal·USB FD 해제·physical/driver 복귀가 확인되면 exact 원본 서비스를 복구하되 settings/pending/fsync/close 불확실은 nonzero·bio lock/evidence 보존이다. forcekill/USB reset/자동 retry는 없다.
- 관련 파일: `apps/gateway/scripts/bio-sensor-event-pilot-launcher.ts`, `bio-sensor-event-pilot-launcher-host.ts`, `bio-sensor-event-pilot-launcher.test.ts`, `docs/runbooks/raspberry-pi-gateway-appliance.md`.
- 갱신 규칙: fixture 성공과 실제 UID999/장비 확인을 분리한다. 과거10월6일 lifetime/phase/token/evidence/bundle을 재사용하지 않는다.

## 2026-10-06 A/B 시험용 센서 알림 연동 — 코드만 구현, 실장비 미실행

- 구현 완료(시험 스크립트): 제품 소비 경로 밖의 고정 A/B opt-in pilot가 A의 정확한 시험 알림 후보로 B 설정60%를 GET 확인하고, 추가 알림은 같은 발생의 유지시간만 갱신한다. 정상 만료는 독립 A mode GET·identity/generation 응답 뒤 B 원본 raw/mode를 복원한다. 취소/300초 종료는 독립 복구 예산으로 A/B 원복을 확인하며 불명확 pending은 보존한다.
- 미구현: 이번 코드의 실제 장비 검증·제품 지원 전환. 제품 profile/qualification/health provider와 기존 활성화 관문은 변경하지 않았다.
- 검토 보완(코드): 큐와 독립된 monotonic 상한 watchdog·매쓰기 fence로 느린 GET/apply의300초 이후 정상 쓰기를 차단한다. 원복/원장/닫기 실패는 pending을 보존하고 성공 종료로 숨기지 않는다.
- 부족하거나 개선이 필요한 기능: 수용 후보는 시험 알림일 뿐 motion/clear 의미가 아니다. A는 sensor 모드 자율 점등, 이벤트 밝기 쓰기는 B만이다. 단절/decoder/GET 실패 뒤 침묵 복원·새 activation은 차단한다.
- 관련 파일: `apps/gateway/scripts/bio-sensor-event-pilot.ts`, `bio-sensor-event-pilot-runtime.ts`, `bio-sensor-event-pilot.test.ts`.
- 갱신 규칙: 코드/모의 검증과 실장비·광학 증거를 분리한다. 운영 실행 전 원본 Gateway 정지·USB 독점의 별도 승인 launcher가 필요하며 이번 작업에서 실행하지 않았다.

## 2026-10-06 기존 BIO 등록 현재 재검증 — 소프트웨어 완료·운영 미적용

- 구현 완료(Task 2 소프트웨어): 독립 관리자 create/get·DB 보관이 현재 권한/binding을 검증하고 출력·센서 qualification을 보존한다. 실제 query 전달·B 수복·센서 지원 완료가 아니다.
- 구현 완료(Task 3 소프트웨어): 서버 조회 발행·fresh 결과·전용 durable ACK 경로를 추가했다. 짧은 lease와 현재 권한/binding/시계 재검증 뒤 최대2초 MQTT 발행을 transaction 밖에서 수행하며 원 payload/hash로 재시도한다. 출력·등록 이력·qualification·heartbeat는 변경하지 않는다.
- 구현 완료(Task 4 소프트웨어): apply는 후보 status와 필수 수복 감사·operation 소비만 함께 저장하며 출력 명령/원 등록 명령·terminal·ledger를 쓰지 않는다. 수복 뒤 기존 A/B 분류는 원자적으로 BIO/OFF만 변경하고 현재 장치 재검증 hash·수복 감사 ID를 근거로 구분한다. 이미 정상인 qualification은 유지한다.
- 계약 완료(Shared): registration 전용 query/result/전체 hash ACK `e902a393`, 관련38PASS·독립 검토 승인. Gateway 소프트웨어 소비도 완료했으나 실제 장비 조회·운영 수복은 후속이다.
- 관련 요청 파일: `apps/api/src/registration/bio-registration-revalidation.service.ts`, `bio-registration-revalidation-binding.ts`, `registration.controller.ts`.
- 구현 완료(Task 5 Gateway 소프트웨어): 기존 단일 adapter의 query만 사용하는 별도 handler/journal/result/전체 hash ACK와 runtime/ACL 계약을 추가했다. 재시작은 새 GET 없이 unknown으로 처리하고 최초 terminal을 재전송한다. rename 뒤 fsync 불확실 재수신은 원장 내구 barrier 성공 전 receipt를 거부한다. 관련 집중 검증·독립 수정 재검토를 통과했으며 실제 broker matrix는 opt-in1SKIP다.
- 검증 완료(Task 6 소프트웨어): API 요청→Gateway GET-only→immutable 결과/정확 ACK→명시 apply→별도 A/B 분류, ACK 유실·재시작·구 Gateway 무응답을 연결했다. 최종 신규 일회용 DB108/108·직접 API5/5·API/Gatewaytypecheck/build0, 독립 통합 및 전체 요청 최종 검토 Approved·새C0/I0/M0·기존 pnpm 경고M1을 확인했다. 가짜 USB/MQTT 경계이며 실제 RF/TLS/broker 성공은 아니다.
- 미구현: 실제 B 현재 조회·감사 수복·운영 적용과 실제 감지 profile/독립 건강 공급. 현재 운영 데이터·조명은 변경하지 않았다.
- 부족하거나 개선이 필요한 기능: force-off 설정 GET 성공을 과거 등록 완료·센서 감지/연결 건강으로 사용하지 않는다. 새 조회도 밝기/mode SET0이어야 하며 기존 ID·밝기·전원·이력을 보존한다. 감지 profile/독립 건강과 제품 활성화는 별도 관문이다.
- 관련 파일: `docs/superpowers/specs/2026-10-06-bio-registration-revalidation-design.md`, `docs/superpowers/plans/2026-10-06-bio-registration-revalidation.md`, 기존 `apps/api/src/commands/sensor-mode-operations.service.ts`, `apps/gateway/src/adapters/bio-usb-dongle-adapter.ts`.
- 갱신 규칙: 상세 설계 승인·소프트웨어 구현·현장 조회/수복·BIO 분류·센서 활성화를 각각 실제 증거로 구분한다.

## 2026-10-02 1~3단계 현장 연동 점검

- 구현 완료(소프트웨어·독립 검토): 재검색이 완료된 등록을 미등록 상태로 덮는 결함을 예방했다. 관련 consumer 120개 통과·기존 opt-in 1개 제외와 타입 검사·독립 검토 지적0을 확인했다. 이미 완료된 전체 회귀는 사용자 요청에 따라 반복하지 않았다.
- 확인 완료(현재 A 설정 조회): 17:51:17 KST exact A GET-only 단1회에서 raw140/force-off를 확인했다. 밝기 설정 GET1·mode GET1·B GET0·모든 SET0이며 driver release/close/kernel 복귀, USB 소유0·원본 Gateway 정지·mapping hash/inode/assignment/descriptor 불변을 확인했다. 이는 설정값 조회이며 실제 광학 출력·감지 신호·건강 또는 이전 복원 workflow PASS가 아니다. 기존 pending1 원장은 불변이다.
- 미구현: 실제 A/B의 BIO 분류 적용, 전체 복원 절차 확인, 감지 신호 승인과 독립 연결 건강 공급·제품 활성화. 현재 production factory에는 실제 자격/건강 공급자가 없고 승인 profile은 빈 목록이다.
- 부족하거나 개선이 필요한 기능: 실제 B의 과거 등록 상태는 여전히 불완전하며 분류 API가 원자 전환을 거부한다. 시험 연결의 만료 CRL 갱신은 허용 대기이고 fresh START는 받지 않았다. 후보 패킷·주기 신호·조회 응답만으로 감지 의미나 건강을 승인하지 않는다. 10초 최소 유지시간 및 UI 수정 가능 계약은 유지한다.
- 관련 파일: `apps/api/src/mqtt/mqtt.service.ts`, `mqtt.service.spec.ts`, `apps/gateway/src/adapters/adapter-factory.ts`, `apps/gateway/src/bio/bio-sensor-pulse-source.ts`, `docs/superpowers/plans/2026-09-30-bio-sensor-pulse-event-control.md`.
- 갱신 규칙: 1시간 제한의 부분 성과와 운영 미적용·미확정 신호를 명시하고 실제 센서 연동 완료로 표시하지 않는다.

## 2026-10-02 BIO 제품 연결 — 전달 계약

- 구현 완료(Shared 소프트웨어·독립 검토): 기존 V1을 보존하는 BIO V2 전달 envelope와 별도 수용 ACK 계약을 추가했다. 현장/게이트웨이/배정/이벤트/센서/버전/전체 전달 hash를 대조하며 ACK 귀속 일치는 센서 건강이나 제어 활성화를 뜻하지 않는다.
- 구현 완료(Gateway 수신·독립 검토): 실제 client 단일 후보 구독을 adapter 수명에 연결하고 exact 권한·독립 건강 관문을 통과한 typed pulse 출구와 변경/종료 철회를 추가했다. 첫 mapping 조회에서 발견한 기존 권한 잔존도 수정했다. 제품 profile은 빈 목록·provider는 null이라 실제 점등은 OFF다.
- 구현 완료(API 소프트웨어·독립 검토): 이미 BIO protocol이 확정된 node의 인증 보고를 현재 claim/배정/certificate에 대조해 qualification·ledger·별도 immutable V2 ACK를 원자 저장한다. KST timestamp·다중 node revision·재배정/변조·실제 publisher 발행 경로를 검증했다. 수용 ACK는 제어 사용 가능 판정이 아니다.
- 구현 완료(Gateway 실행 연결 소프트웨어·독립 검토): 실제 수신 출구를 제품 scheduler/target port와 연결하고 후보 없는 제어 전 재확인·만료 복원·규칙 교체/rollback·종료 대기를 추가했다. 서로 다른 Fixture/node ID를 구분하며 복원 불확실 원장은 보존한다. 담당 전체1,680/1,680·독립166/166이 통과했으나 실제 승인 profile/권한 provider가 없어 enabled BIO는 계속 거부한다.
- 구현 완료(신규 등록 소프트웨어·독립 검토): 정확한 V2 완료 등록 근거가 있는 새 canonical BIO node만 BIO/OFF로 분류한다. Legacy·기존 node·qualification·밝기는 보존하며 identify는 필수 조건도 완료 근거의 대체물도 아니다. 등록 회귀94/94·일회용 DB9/9을 확인했다. 분류 자체가 센서 사용 가능 판정은 아니다.
- 구현 완료(Gateway OFF 보고/ACK 소프트웨어·독립 검토): 실제 bootstrap의 현재 인증 sensor-mode 명령으로 canonical 조명↔node 식별 근거를 확인해 OFF/null 보고만 내구 전달한다. exact 배정/전체 hash ACK·재시작/만료/종료·양방향 binding 교체를 검증했고 미확인 pending 원본은 보존한다. 집중113/113·독립113/113을 확인했다. 식별 proof는 건강/제어 권한이 아니다.
- 구현 완료(센서 모드 소프트웨어·독립 검토): 조명/등록 ID와 canonical MeshNode ID가 달라도 인증 Fixture/native hash/주소·confirmed mapping·fresh discovery를 확인해 query/ensure한다. 조회 SET0·ensure의 별도 GET·await후 매핑 교체/취소/기한/연결 검증과 기존 수동/그룹/source 보호를 유지한다. 최종 Gateway1,727/1,727·독립 관련293/293이 통과했으며 실장비 성공은 아니다.
- 구현 완료(기존 등록 분류 보완 소프트웨어·독립 검토): 관리자 권한·현재 등록 완료/소유/배정 근거를 대조하는 명시 API로 기본 상태의 오분류만 BIO/OFF로 바꾼다. 같은 층의 최대10개 조명과 감사 기록은 원자 처리하며 실패 시 전체 취소한다. 밝기·전원·ID·그룹·이력과 이미 BIO인 검증 상태는 보존한다. DB30/30·등록115/115·타입/빌드·독립 검토 지적0을 확인했다. 실제 기존 A/B 운영 적용은 하지 않았다.
- 미구현: 독립 qualification/건강 provider·현장 지원 전환·운영 적용. 유지시간10~1,800초/UI 수정 계약은 그대로이며 분류 전환이 이벤트 활성화 승인은 아니다.
- 부족하거나 개선이 필요한 기능: 빈 profile·미검증 health·제품 OFF를 유지한다. 오늘 body03의 의미와 물리 신호/광학/독립 건강은 미검증이며 APK 일반 trigger callback을 제품 승인으로 대체하지 않는다.
- 관련 파일: `packages/shared/src/automation-contracts.ts`, `automation-contracts.test.ts`, `docs/superpowers/plans/2026-09-30-bio-sensor-pulse-event-control.md`.
- 관련 Gateway 파일: `apps/gateway/src/bio/bio-sensor-pulse-source.ts`, `bio-dongle-client.ts`, `bio-device-mapping-store.ts`, `apps/gateway/src/adapters/adapter-factory.ts` 및 대응 테스트.
- 관련 실행 연결: `apps/gateway/src/automation/bio-product-pulse-controller.ts`, `bio-pulse-scheduler.ts`, `schedule-runtime.ts`, `production-bio-pulse-integration.test.ts`, `apps/gateway/src/index.ts`.
- 관련 보고 연결: `apps/gateway/src/bio/bio-capability-delivery.ts`, `bio-capability-delivery.test.ts`, `apps/gateway/src/mesh/vehicle-sensor-capability.ts`, `apps/gateway/src/commands/bio-sensor-mode-handler.ts`.
- 관련 센서 모드 어댑터: `apps/gateway/src/adapters/bio-usb-dongle-adapter.ts`, `bio-usb-dongle-adapter.test.ts`.
- 관련 API 파일: `apps/api/src/automation/automation-mqtt-consumer.service.ts`, `vehicle-sensor-capability.service.ts`, `bio-capability-delivery.integration.spec.ts`, `apps/api/prisma/migrations/20261002110000_bio_capability_node_ledger/migration.sql`.
- 관련 등록 파일: `apps/api/src/mqtt/provisioning-device-terminal.service.ts`, `provisioning-device-terminal.service.spec.ts`, `new-bio-registration.integration.spec.ts`.
- 관련 기존 분류 보완: `apps/api/src/registration/bio-classification-reconciliation.service.ts`, 대응 unit/integration 테스트, `registration.controller.ts`, `registration.module.ts`, `docs/database-schema.md`.
- 갱신 규칙: 계약·실제 수신·실제 제어·현장 검증을 구분하고 미연결 경로를 완료로 표기하지 않는다.

## 2026-10-02 BIO 현장 시험 준비 — 임시 진단 도구, 제품 OFF

- 사용자 사후 보완: ‘같은 자리 정지’ 구간에도 몇 번 움직였다. 정지 구간 전체의 무움직임·무자극을 전제하지 않으며 원본 버튼/packet은 불변으로 보존하고 별도 operator follow-up을 남긴다. 정확한 움직임 시각/횟수는 미확정이다.
- 현장 종료(전체 관문 실패): 단1회 A-only09:50:50.072~09:55:50.072 KST300초와 실제 현재 기록창의 active→failed/기록 비활성을 확인했다. 사용자 행동5종·정성 밝기6건·종료 후 clock9를 별도 보존했다. A raw 복원 쓰기 미확인과 read-back timeout으로 journal unresolved/pending1·native exit1/host runner exit74다. 마지막 A GET raw140/force-off는 원본과 같지만 전체 복원 절차 PASS로 해석하지 않는다. USB/driver와 sameoriginal Gateway healthy/MQTT·새 heartbeat8·대기/새 제어0을 확인했고 B SET0/최종 B GET 미시작·제품OFF다. 시간 오차/행동 지연은 미확정이고 A 후보35/alive29를 감지 의미·독립 건강으로 확정하지 않는다. 예정 시각 대입·추가 원복·재시험·원장 소거를 자동 실행하지 않는다.
- 구현 완료(시험 준비): 승인된 타이머/기록·원복 도구에서 날짜/식별자/경로만 바꾼 미사용 소스46개와 보호 remote stage를 준비했다. Node24·격리Node22·exact Pi image 각183/183, 독립 검토 지적0, guarded preflight PASS를 확인했다. fixture만 정리했으며 요청512MiB 메모리 제한은 강제되지 않았다. 이 결과는 실제 센서/광학 HIL 성공이 아니다.
- 구현 완료(기록창 준비): 새8088 metadata 서버와 실제 브라우저 화면/reload에서 정상 HTML·대기/unavailable·행동/광학/clock 비활성·인증 오류0을 확인했다. START 전 대기 표시는 정상이고 자동 행동/clock POST는 없다. bootstrap 비밀은 보호된 로컬 경로에만 유지한다.
- 미구현: 전체 복원 절차 PASS와 B 최종 GET 검증, 반복 shadow·독립 건강·B60/10초 시험 및 제품 활성화. 오늘 A 행동·정성 밝기 관찰과 B 사전 GET은 위 시험에서 확보했으며 새 재시험/원장 소거는 승인하지 않았다. BIO gate/allowlist는 OFF다.
- 부족하거나 개선이 필요한 기능: T2의 첫 움직임 누락·정확한 행동 시각/광학 관찰 부족·B 최종 GET 실패는 별도 검증 대상이다. 예정 시각을 실제 행동으로 채우거나 추측성 timeout 완화/자동 retry를 하지 않는다. 시험 중 새로고침은 기록의 연속성을 깨뜨릴 수 있다.
- 관련 파일: `.local/task9-network/trial-preparation-20261002/{READY.md,source-manifest.json,review.diff}`, `.local/task9-network/trial-stage-20261002/{summary.json,fixture-result.json,remote-stage-preflight.json,fixture-cleanup.json}`, `docs/superpowers/plans/2026-09-30-bio-sensor-pulse-event-control.md`. 원본 증거/USED 권한과 새 미사용 권한은 분리 보존한다.
- 갱신 규칙: 소프트웨어·기록창 준비·실제 행동/광학·하드웨어 원복·제품 지원을 각각 실제 증거로 구분한다. 준비 완료를 서비스 연동 완료로 기록하지 않는다.

## 2026-10-01 BIO 현장 시험 기록 화면 — 임시 진단 도구

- 사용자 사후 설명: T2 첫 ‘움직임 시작’은 실제 미실행, 나머지 예정 행동은 수행했다고 정정했다. 이는 정확한 버튼 시각이나 광학 관찰을 대신하지 않으며 원본 기록과 분리 보존한다. 전체 시험 미통과/제품 gate OFF는 유지한다.
- 구현 완료(오프라인 증거 분석): B 마지막 GET 뒤 valid 응답 기록0이며 수신 응답을 matching이 버린 코드 결함의 증거는 없다. 구체적인 RF/동글/USB·부분/지연 응답 원인은 미확정이므로 timeout 완화/자동 retry 수정은 하지 않았다. exact A 후보29개/`0x0c`28개, 실제 퇴장 버튼 영수증 이후 후보0/`0x0c`12개를 원본과 분리된 보호 보고서에 보존했다. 이 분석은 실제 감지·밝기·독립 건강 검증 완료가 아니다.

- 구현 완료: 별도 시험 브라우저에 경과·단계 잔여 시간, 현재 행동과 다음 예고를 추가했다. 실제 관측창 기준50/30/60/30/130초 순서이며 늦게 열어도0초부터 재시작하지 않는다. 브라우저→로컬 기록 서버 연결/시계/가시성/종료·기록 후 새로고침 문제가 있으면 안내를 중단하고 실제 행동·밝기 기록은 사용자 버튼으로만 남긴다. 화면 GET 전용10분 HttpOnly 인증 복원은 API 인증을 대체하지 않는다.
- 미완료: 타이머 기반 전체 A 시험의 합격 판정과 반복/liveness/B 연동 시험. T2 관측창은 끝났지만 B 최종 조회와 실제 행동 시각/밝기 기록이 부족해 성공한 HIL이 아니다. 첫 시험의 새로고침 중단 원본도 보존한다. 제품 제어 페이지에 타이머를 추가하거나 BIO gate를 활성화한 작업이 아니다.
- 부족하거나 개선이 필요한 기능: Node24/Node22·독립168/168과 실제 브라우저의 failed/inactive·새로고침만 확인했다. active 단계는 실제 HTML VM 검증이며 실제 RF/광학·Pi–Mac 시각 오차·사용자 반응 시간은 별도 검증이 필요하다. 사용된 phase/token/native 참조는 새 시험에 재사용하지 않는다.
- 구현 완료(소프트웨어): 원격 전송의3초 유효시간을 별도 작은 영수증으로 확인하고 서버 조회·행동/광학 저장 직전에 검사한다. 화면은 남은 유효시간에서 요청 왕복 시간을 빼므로 GET·새로고침·서버 재시작이 만료를 연장하지 않는다. 종료 후 시계 비교는 기존 인증/window/issued sample/budget/replay 검증을 유지하며 전송 만료와 분리한다. Node24·격리Node22 각각183/183 및 scoped 독립 검토 지적0, 로컬8088 교체·인증 HTML/status 대기 상태까지 확인했다.
- 구현 완료(화면 확인): 사용자 재열기 요청 때 종료된 로컬 기록 서버만 같은 검토 소스로 다시 실행하고 기존bootstrap을 보호 보존했다. 실제 새 기록 탭 및 reload에서 정상 HTML·기록 창 대기/종료/unavailable·행동/광학/clock 비활성·인증 오류 없음으로 앞선 CDP 확인 관문을 해소했다. 서버 종료 원인은 미확정이다.
- 구현 완료(실제 화면 기록 경로): 사용자 현재 시작 신호 뒤 A300초 관측에서 실제 active 타이머/버튼과 사용자 기록 저장, 종료/failed 뒤 행동·광학 비활성 및 종료후clock3 저장을 확인했다. 실제기록은clock12·범위밖/퇴장2건이며 agent 자동POST는0이다.
- 부족하거나 개선이 필요한 기능: 이번 A 관측창300초는 끝났고 A exact 원복/pending0·USB/driver·동일 Gateway healthy 복귀를 확인했으나 B final GET timeout으로 trial은failed/exit1이다(BSET0). 움직임/정지/재움직임·광학 기록이 없으므로 센서 동작 상관관계나 전체HIL 통과로 처리하지 않는다. T2 token은USED이며 재사용/자동 재시험하지 않는다.
- 부족하거나 개선이 필요한 기능: 현재 현장 시작 신호 전 재START하지 않는다. 전송 최신성은 장비 프로세스 생존·물리 행동 시각의 증거가 아니다. 새 시험의 --run/게이트웨이 중단/USB/GET·SET0이고 제품 gate는 OFF다.
- 관련 파일: `.local/task9-network/marker-timer-20261001/{pilot-marker-page.html,pilot-marker-server.mjs,TIMER-READY.md,timer-manifest.json}`, `.local/task9-network/marker-freshness-fix1-20261001/{FRESHNESS-FIX1-READY.md,fix1-manifest.json,pilot-marker-server.mjs,marker-transfer-freshness.mjs,timer-status-bridge.mjs}`, `docs/superpowers/plans/2026-09-30-bio-sensor-pulse-event-control.md`. 보호된 로컬 진단 소스이며 비밀/원시증거는 소스 export에 포함하지 않는다.
- 갱신 규칙: 임시 기록 화면·자동 검증·실제 하드웨어 결과·제품 지원 상태를 분리하고 새 현장 시험 완료 전 미구현 표시를 유지한다.

## 2026-10-01 BIO 실행 이력·조회/ACK 기반

- 구현 완료: snapshot 생성 당시 source Fixture→MeshNode를 서버 metadata로 보존한다. 교체 전 펄스가 첫 수신/새 occurrence로 늦게 도착해도 새 센서 상태로 표시하지 않고 감사 격리+ACK한다. 같은 현장 재배정 뒤 이미 저장된 exact event는 현재 claim·인증 근거 확인 후 원래 ACK만 재발행하며 새 과거 배정 이벤트는 거절한다.
- 구현 완료: API는 strict V2 execution의 현재 claim·유효 MQTT 인증서·배정·V2 선언·snapshot hash/topic·source/target를 확인하고 별도 감사 이력과 조회 상태를 저장한다. 원래 assignment를 보존한 exact ACK는 DB commit 뒤 outbox로 발행하며 Gateway는 버전·배정·event ID·sequence·hash 일치 뒤에만 파일 기록을 제거한다. V1 소비는 유지한다.
- 구현 완료: 상세 dashboard Fixture의 서버 소유 `bioPulseTelemetry`는 실제 저장 기록의 마지막 펄스, 건강/장애 시각, 복원 대기와 구성 read-back을 제공한다. 알려진 과거 설정·늦은 sequence·출처가 정확한 시계 오류는 ACK 가능한 감사 격리만 하고 projection은 갱신하지 않는다. 배정·source node mapping·설정 변경 뒤 옛 projection은 표시하지 않으며 없는 증거는 NULL이다.
- 구현 완료: Web은 nullable `bioPulseTelemetry`의 마지막 펄스·건강/장애 시작·복원 대기와 사유를 현장 시간대의 과거 보고로 표시한다. 센서별 전체 규칙/occurrence 집계임을 명시하며 특정 규칙의 실행 결과로 귀속하지 않는다. source 교체 등으로 새 dashboard가 NULL을 반환하면 이전 표시를 즉시 제거하고 미확인으로 돌아간다.
- 구현 완료: 대상별 적용/복원 설정 확인의 성공·실패·대기, 설정 밝기와 BIO mode를 별도로 표시한다. 정상 건강 보고·새 펄스·성공한 설정 GET으로 복원 대기를 지우지 않고 서버 boolean만 소비한다. 펄스/시계/준비 상태에서 실행 결과를 추론하지 않는다.
- 미구현: 실제 broker/mTLS 송수신·Pi/RF·광학 HIL은 별도다. 합성 활성 snapshot의 일회용 DB 시험과 브라우저 route fixture를 제품 활성화로 해석하지 않는다.
- 부족하거나 개선이 필요한 기능: 제품 enabled BIO/allowlist는 OFF다. `configuration_readback`은 당시 설정 밝기/mode이며 현재 LED 광학 출력·Fixture.brightness·전력/에너지 또는 source readiness를 변경하지 않는다. 배정 없는 옛 시험 V2 파일과 출처를 검증할 수 없는 snapshot은 자동 ACK/재서명하지 않아 수동 복구가 필요하다. 운영 보존/대규모 조회 검증은 후속이다.
- 관련 파일: `apps/api/src/automation/bio-pulse-telemetry.ts`, `apps/api/src/sites/bio-pulse-telemetry-view.ts`, `apps/api/test/bio-pulse-telemetry.integration.spec.ts`, `packages/shared/src/bio-pulse-telemetry-contracts.ts`, `apps/gateway/src/automation/automation-telemetry-outbox.ts`, `apps/web/src/features/control/automation/BioPulseTelemetryStatus.tsx`, `apps/web/src/api/{automation,queries}.ts`.
- 갱신 규칙: 영속 수신·화면 소비·장비 건강·광학 결과·제품 지원 상태를 분리하고 schema 변경은 `docs/database-schema.md`와 함께 갱신한다.

## 2026-10-01 BIO 통합 경계 — 소프트웨어, 제품 OFF

- 구현 완료: V2 구성 ACK의 실제 MQTT topic 수신 경로에서 topic의 `channel`이 Prisma 조회 조건에 섞이던 오류를 수정했다. 지원 선언 조회에는 현장·Gateway·현재 assignment만 사용한다. 일회용 PostgreSQL 회귀는 topic 파싱부터 적용 번호·정확한 application receipt 저장과 Gateway ACK outbox 삭제까지 검사하며 제품 BIO 활성화와는 구분한다.
- 구현 완료: 일회용 PostgreSQL에서 실제 규칙 서비스의 disabled BIO 10/60초 저장 → 현재 claim·인증서·assignment에 묶인 V2 지원 선언 → V2 outbox 발행·전체 해시 → Gateway 파일 저장·V2 ACK·API 수신 확인을 연결했다. V1 5초 BlueZ 회귀, 미지원/인증 근거 상실/할당 변경/하향 선언과 잘못된 버전·해시 ACK의 차단을 함께 검증한다. API와 Gateway의 enabled BIO 거부는 유지한다.
- 구현 완료: 별도 in-process 시험 경로에서만 명시적 합성 profile·독립 healthy link와 CRC16 `0x09` 프레임을 decoder/intake/runtime에 연결했다. 10/60초 연장·B의 설정 밝기와 mode 복원·degraded/재시작 후 전체 건강 관찰창·A 쓰기 0건을 실제 파일 저널로 검증한다. 제품 bootstrap·환경변수·IPC에 BIO 양성 시험 입력은 연결하지 않았다.
- 구현 완료: BIO 수명주기·설정 read-back 결과는 별도 strict V2 telemetry로 outbox에 전달한다. malformed payload는 저널 append 전에 거절하고 장애·복구·연장 이력은 합치지 않는다. 연결 단절·파일 재시작·재접속 동안 순서·event identity·해시를 보존하며 broker 접수만으로 삭제하지 않는다. MQTT transport와 B 장비 read-back은 시험용 대체물이며 실제 broker/RF 검증이 아니다.
- 미구현: 실제 장비까지 이어지는 제품 end-to-end 검증. API 영속 수신·application ACK·조회 projection과 Web 소비는 위 구현을 따르며, 두 합성 시험 경로를 제품 저장부터 B 실행까지의 단일 end-to-end 성공으로 합치지 않는다.
- 부족하거나 개선이 필요한 기능: API 저장 시험의 ready source는 격리 DB에 주입한 합성 전제다. 제품 capability·allowlist는 계속 OFF이며 `configuredHighBrightnessPercent`와 `bioMode`는 구성 확인값이다. 실제 광학 밝기·전력·A 자율 동작, Pi·운영 DB·현장 MQTT는 검증하거나 변경하지 않았다.
- 관련 파일: `packages/shared/src/bio-pulse-telemetry-contracts.ts`, `apps/api/test/bio-pulse-config.integration.spec.ts`, `apps/gateway/src/automation/software-bio-pulse-integration.test.ts`, `software-automation-simulator.ts`, `automation-telemetry-handoff.ts`, `automation-telemetry-outbox.ts`, `bio-pulse-scheduler.ts`.
- 갱신 규칙: disabled 구성 적용, 합성 펄스 수명주기, API 실수신, 광학 HIL과 제품 ON을 각각 실제 증거로 구분한다.

## 2026-10-01 BIO 제어 화면 — 소프트웨어 검증, 제품 OFF

- 구현 완료: dashboard의 서버 계산 `vehicleEventSource`로 protocol·유효 readiness·차단 사유·활성 센서의 대상 제외 여부를 표시한다. 저장된 BIO `ready` 보고만으로 사용 가능을 만들지 않으며 현재 서버는 제품 gate OFF에 따라 source 선택·화면 저장을 차단한다. `shadow/degraded` 보고는 검증 중·재검증 안내로 구분한다. 기존 내부 disabled draft API 자격 정책은 바꾸지 않았다.
- 구현 완료: 기존 지도·목록 선택 흐름에서 현재 선택한 A와 서버가 보호 중인 A를 B 대상에서 제외한다. synthetic ready 화면도 BIO 초안을 비활성으로 저장하고 활성화 버튼은 막는다. A 밝기 설정 UI는 없으며 A의 자체 밝기 동작은 현장 검증 전이라고 설명한다.
- 구현 완료: BIO 유지시간 10~1,800초·기본 60초 입력/수정, 10초 신호 공백의 꺼짐·재점등 경고, 기존 BlueZ 5초 하한을 적용한다. 센서 모드 설정·읽기 전용 재조회와 별도 요청 결과 GET을 제공하며 POST 접수는 검증으로 표시하지 않는다. GET 확인 시점은 과거 기록이고 현재 readiness 근거가 아님을 명시한다.
- 구현 완료: 모드 확인 시점은 최신 dashboard 증거만 표시한다. 개별 GET 뒤에는 dashboard를 갱신하며, 새 작업·할당/물리 장비 무효화가 도착하면 이전 결과와 늦은 응답을 폐기한다. 동일한 이전 snapshot은 진행 중 요청을 유지하고, 갱신 실패는 과거 확인 시점을 되살리지 않고 확인 중 안내와 준비 상태 재조회 경로를 유지한다.
- 구현 완료: BIO 규칙에는 키보드로 접근 가능한 지속 운영 안내와 운영자 비활성화 해제 경로를 표시한다. 서버의 degraded capability와 runtime 건강 보고를 구분하고 실제 저장된 마지막 펄스·장애 시작·복원 대기/사유를 표시한다. 증거가 없으면 미확인이며 비활성화 요청이나 설정 확인만으로 해제 완료를 선언하지 않는다.
- 구현 완료: 수동 밝기 숫자 입력은 공통 NumberField의 16px 크기를 사용한다. 모바일 이벤트 카드의 관리 버튼은 둥근 모서리 안에 실제 44×44px 터치 영역을 확보하도록 52px 공통 Button을 사용한다. 320/390px의 입력·터치·overflow·지도와 두 포인터 확대/축소는 브라우저 회귀로 검증한다.
- 미구현: Task 9 HIL. UI fixture 테스트 결과를 실장비 지원으로 해석하지 않는다.
- 부족하거나 개선이 필요한 기능: 제품 capability·allowlist는 OFF다. 모드 증거는 현재 할당·Fixture·node·physical identity·address와 일치하는 최신 작업의 과거 GET만 표시하며 현 상태 지속을 보장하지 않는다. 실제 조명·운영 DB·MQTT 설정은 변경하지 않았다.
- 구현 완료: Task 8c에서 320/390px 수동 최근 이력 막대의 114px 높이 실패를 재현하고 모바일 상하 여백을 각각 8px에서 6px로 줄여 기존 112px 이하 계약을 만족시켰다. PC 여백과 44px 요약·52px 작업 버튼은 유지하며, 이력이 있는 상태의 실제 44×44px 터치 영역과 drawer 열기·가로 overflow를 Chromium 회귀로 함께 검사한다. 이 결과는 브라우저 소프트웨어 검증이며 실제 모바일 WebView·조명 HIL은 별도다.
- 관련 파일: `apps/api/src/sites/{sites.service,vehicle-event-source-view}.ts`, `apps/web/src/api/{automation,queries}.ts`, `apps/web/src/features/control/automation/{VehicleEventDialog,VehicleEventSourceStatus,VehicleEventControlPanel}.tsx`, `apps/web/src/features/control/automation/vehicle-event-form.ts`, `apps/web/e2e/control-map-target-selection.spec.ts`.
- 갱신 규칙: 서버 유효 준비 상태와 관찰 증거, 소프트웨어 화면과 실제 HIL, 요청 접수와 GET 검증을 구분해 기록한다.

## 2026-09-30 BIO 소스 A 대상 보호 — 소프트웨어 검증

- 구현 완료: API 공통 정책은 활성 BIO 규칙의 source를 수동 개별·다중·그룹·층 제어, 스케줄 생성·수정, 다른 이벤트 target, 등록 조명 식별과 그룹 구성 변경에서 거절한다. 그룹·층 선택은 현재 membership을 실제 Fixture ID로 확장한 뒤 같은 자동화 잠금 트랜잭션에서 검사한다. 준비 상태가 저하돼도 활성 source 보호를 해제하지 않는다.
- 구현 완료: Gateway는 최신 V2 snapshot의 활성 BIO source와 대상 교집합을 검사한다. 직접 MQTT 명령과 재전송, 자동화, 식별은 adapter 진입 및 BIO native write 직전 검사로 A의 밝기·mode 변경을 차단한다. 식별 후 복원도 source 보호를 우회하지 않으며, 명시적 센서 모드 확인 작업과 분리한다. B와 기존 BlueZ 경로는 유지한다.
- 미구현: 제품 BIO 활성화와 현장 HIL은 후속 작업이다. Web 선택 안내는 위 2026-10-01 항목에 구현했고 실제 capability·allowlist는 OFF이며 A 밝기 설정 UI는 없다.
- 부족하거나 개선이 필요한 기능: synthetic snapshot·가짜 USB/저장소 검증이다. 실제 A의 자율 밝기 반응, `CD 13`의 센서 보존 여부, 펄스 상관관계·독립 건강 판정은 검증하지 않았다. Pi·운영 DB·MQTT 설정은 변경하지 않았다.
- 관련 파일: `apps/api/src/automation/bio-source-target-policy.ts`, `apps/api/src/commands/commands.service.ts`, `apps/api/src/fixture-groups/fixture-groups.service.ts`, `apps/api/src/fixture-identify/fixture-identify.service.ts`, `apps/gateway/src/automation/bio-source-target-guard.ts`, `apps/gateway/src/commands/gateway-command-handler.ts`, `apps/gateway/src/runtime/fixture-identify-runtime.ts`, `apps/gateway/src/bio/bio-dongle-client.ts`.
- 갱신 규칙: 소프트웨어 차단, 제품 capability 활성화와 실장비 광학 검증을 구분한다.

## 2026-09-30 BIO 펄스 API 자격 판정 — 소프트웨어 초안만 지원

- 구현 완료: API는 저장된 node의 protocol과 capability로 source를 판정하며 클라이언트의 protocol 지정은 거절한다. BIO는 준비 근거가 있는 A 1개와 서로 다른 B 대상만 같은 현장·Gateway에 저장할 수 있다. BIO 유지시간은 10~1,800초, 기본 60초이고 기존 BlueZ는 5~1,800초를 유지한다. `off/shadow/degraded` source의 새 저장, 혼합 source, A를 같은 규칙의 target으로 지정하는 요청을 차단한다.
- 구현 완료: 내부 BIO 자격 보고는 인증된 Gateway 범위와 별도 단조 revision/내구적 중복 원장을 검사한다. 상태 하향 또는 검증 profile 변경 시 해당 활성 규칙을 먼저 비활성화하고 구성·상태·원장을 같은 거래로 저장한다. 오래되거나 중복된 보고와 V1 capability 보고는 BIO 준비 상태를 승격하지 않는다. BlueZ→BIO source 교체 시 기존 적용 번호를 초기화하고 지연된 V1 구성 ACK도 BIO 규칙의 적용 번호를 올리지 않는다. 일회용 PostgreSQL에서 실제 제약과 실패 시 전체 rollback을 검증한 소프트웨어 구현이다.
- 구현 완료: 명시적 Gateway V2 지원 선언을 현재 assignment·인증 범위와 대조해 별도 DB 이력에 저장한다. V1-only/지원 미확인은 BIO를 제외한 V1을 유지하며, V2 지원 확인 뒤에는 비활성 BIO 초안을 V2로 배포하고 전체 해시·ACK 버전을 검증한다. Gateway의 V2 저장·재시작·ACK outbox도 버전을 보존한다. 지원 하향·오래된 선언/ACK는 BIO readiness를 올리지 않는다. 이 결과는 구성 반영 근거일 뿐 sensor-mode 또는 광학 출력 근거가 아니다.
- 부족하거나 개선이 필요한 기능: 지원 선언 전용 수신 확인은 아직 없으므로 Gateway는 연결 동안 같은 선언 ID/내용을 제한된 재시도 간격(기본 1초에서 최대 30초 backoff + jitter)으로 계속 전송한다. 구성 수신/ACK만으로 선언 재전송을 종료하지 않는다. API는 동일 선언을 중복 저장하지 않지만 현재 구성 재전송 트래픽은 발생하며, 연결 종료 시 재시도를 멈추고 다음 연결은 새 선언을 사용한다.
- 구현 완료: A sensor-mode는 별도 `POST /sensor-mode-operations` 요청과 `GET /sensor-mode-operations/:commandId` 조회로 저장한다. 현장 제어 권한, 현재 claim/assignment와 BIO Fixture identity를 확인하며 `ensure_sensor` 명시적 요청만 센서 모드 SET 후 별도 GET을 한다. `query`와 timeout/unknown 후 새 ID 재조회는 모드 GET만 한다. Gateway 접수 journal·결과 outbox, API 동일 ID 재전송/중복 결과 ACK를 사용한다. 복구와 실시간 재전달은 명령별로 직렬화하여 결과 ID 하나를 보존한다. 시계 오차가 있는 비성공 terminal은 identity/hash 검증 후 비검증 감사 기록으로 ACK하며 원래 `occurredAt`은 신뢰하지 않는 Gateway 시각으로 보존한다. 서버 만료 상태를 바꾸거나 `verifiedAt`으로 사용하지 않는다. 실제 GET=`sensor`와 엄격한 시간 검증만 해당 작업의 `modeVerified`이고 configured high-brightness·MQTT 접수·구성 적용 ACK는 검증 근거가 아니다.
- 미구현: BIO 활성 규칙의 제품 실행은 별도 HIL·운영 승인 이후 범위다. Task 8의 소프트웨어 통합은 제품 gate를 켜지 않는다. 현재 준비된 BIO도 `disabled` 초안만 저장하며 활성화는 기존 `v2_support_unverified`로 거절한다. Gateway도 임의로 조작한 enabled-BIO V2를 저장·RF 전에 거절한다. BIO 초안은 V1 snapshot에 포함되지 않으며, V2 구성 적용 번호와 별개로 제품 준비 전 목록·필터·집계는 `PENDING`을 유지한다.
- 부족하거나 개선이 필요한 기능: 센서 모드 작업 UI는 Task 7에 남아 있다. 모드 성공 이력은 요청 당시 GET의 결과이며 지속적인 센서 건강이나 실제 자체 점등을 뜻하지 않는다. 프로세스 중단 작업은 재시작 후 `unknown`, 만료는 `timed_out`이며 재조회가 새 관측을 만든다. 실제 Pi/RF 시험과 운영 migration/ACL 적용은 수행하지 않았고 BIO capability·allowlist는 계속 OFF다. A 밝기 설정 UI는 제공하지 않는다.
- 부족하거나 개선이 필요한 기능: 실제 BIO readiness/HIL·제품 capability는 OFF다. 내부 보고 helper는 HTTP/MQTT 경로에 연결하지 않았으며, 보고의 모드 시각이나 구성 ACK는 별도 실제 mode GET·광학 출력 검증을 대체하지 않는다. 준비 상태·유지시간 안내 UI는 Task 7에 남아 있다.
- 관련 파일: `apps/api/src/automation/vehicle-event-rules.service.ts`, `target-snapshot.service.ts`, `vehicle-sensor-capability.service.ts`, `automation-snapshot.service.ts`, `automation-protocol-support.ts`, `automation-mqtt-consumer.service.ts`, `dto/vehicle-event-rule.dto.ts`, `apps/api/test/vehicle-event-rules.e2e-spec.ts`, `apps/gateway/src/automation/automation-runtime.ts`, `automation-config-store.ts`, `automation-config-ack-outbox.ts`, `automation-current-config-requester.ts`.
- 갱신 규칙: 소프트웨어 자격 판정·비활성 초안·V2 구성 적용·live source readiness·현장 HIL을 구분하고, 후속 검증 없이 BIO를 사용 가능 또는 제품 ON으로 기록하지 않는다.

센서 모드 작업 관련 파일: `packages/shared/src/bio-sensor-mode-contracts.ts`, `apps/api/src/commands/sensor-mode-operations.service.ts`, `sensor-mode-operations.controller.ts`, `apps/api/src/mqtt/sensor-mode-publisher.service.ts`, `apps/gateway/src/commands/bio-sensor-mode-handler.ts`, `apps/gateway/src/adapters/bio-usb-dongle-adapter.ts`, `apps/api/test/bio-sensor-mode.integration.spec.ts`.
## 2026-10-06 공통 Grid 현재 목록 정렬

- 최종 통합 관문 완료: 제품 `1c600eda`에서 전체 Web3258PASS·기존3SKIP, 타입/빌드/UI정책0·관련33브라우저33PASS, 코드/UI 검수 차단0을 확인해 로컬 기본 브랜치에 병합했다. 아래 표적 증거와 실제 장비/native/HIL 한계는 그대로 유지한다. 실제 localhost 스케줄 이름 정렬의 aria-sort=ascending을 확인했으며 실행/활성 변경은 하지 않았다.

- 구현 완료: 스케줄·이벤트 목록의 이름·활성/동기화·날짜·반복·대상 수·밝기·유지·최근 결과/감지에 의미에 맞는 정렬 값을 연결했다. 적용 기간은 시작 시각, 최근 결과는 발생 시각으로 정렬하고 관리 작업은 정렬에서 제외한다.
- 구현 완료: 기존 HTML table/caption/중앙 TH와 컨테이너 기반 카드 전환을 유지한다. 표 헤더의 공통 Button/Enter/Space, 활성 TH의 aria-sort/방향 아이콘과 카드의 공통 React Aria SelectBox/방향 버튼이 동일 상태를 소비한다. 한글·numeric 문자열, 숫자·날짜·boolean, 동일값 안정 순서와 누락/잘못된 날짜·비유한 숫자의 양방향 마지막 배치를 지원한다. 원본 행 배열을 변경하지 않고 데이터 갱신·정렬 컬럼 제거에도 유효한 상태만 사용한다.
- 미구현: 서버 커서 전체 정렬/API 정렬은 제공하지 않는다. 화면의 '현재 목록 안에서 정렬'은 전달받은 현재 행만 의미하며 기존 조회·필터·커서 계약을 유지한다.
- 부족하거나 개선이 필요한 기능: 격리 Chromium에서 스케줄·이벤트 2개가 1706×1226 표의 Enter/Space 오름·내림차순, 390×844 카드의 동일 상태·기준/방향 변경·44×44 hit·가로 넘침 없음·기존 수정 dialog와 자동화 쓰기 0을 통과했다. 공통/여섯 소비자의 표적 단위 235개와 정렬 브라우저 2개는 software fixture 범위다. 전체 Web 검증·독립 최종 검수는 총괄 관문이며 실제 native WebView·센서·Gateway·LED HIL의 증거가 아니다.
- 관련 파일: 공통 `apps/web/src/components/ui/DataGrid.tsx` 및 대응 테스트, `apps/web/src/features/control/automation/{ScheduleControlPanel,VehicleEventControlPanel}.tsx`, `apps/web/e2e/calm-operations-automation.spec.ts`.
- 갱신 규칙: 정렬 접근자/헤더/카드 변경 시 현재 목록 범위·표/카드 상태·동일값/누락값·원본 불변·행 작업·기존 pagination 회귀와 실제 키보드/44px 접근을 함께 확인한다.


## 2026-10-06 모바일 도면 우선 배치 (Task 2)

### 구현 완료

- 760px 미만 수동 제어는 기존 방식 탭 → 표시 층·현재 선택 방식/선택 수 → 도면 순서를 우선한다. 대상 선택 방식·목록·구역 관리는 `선택 도구 열기`, 밝기 입력/적용은 `밝기 실행 설정 열기`로 확인한다. desktop은 기존 도구와 실행 설정을 펼쳐 표시한다.
- 접힘은 표시만 바꾸고 명령 owner와 frozen request/원본 UUID를 유지한다. 진행·불확정·실패 복구는 접힘 밖에 남는다. 현장 A→B→A는 provider scope와 명령 owner props를 갱신하며 기존 복구 저장을 이용한다. 실제 unmount 복구도 유지하며 닫기·resize·현장 복귀는 자동 제어 POST를 만들지 않는다. 적용 버튼 스크롤 여백은 기존 68px + safe-area 계산을 재사용한다.

### 미구현

- 실제 native WebView·장비/HIL의 첫 도면 가시성 보장은 별도 검증이다.

### 부족하거나 개선이 필요한 기능

- 320×568/390×844/430×932 정상 100% 첫 진입 기준은 실제 도면을 렌더하는 interactive viewport의 헤더·clip·하단 메뉴 제외 가시 높이 120/240/240px이다. CAD 원본 비율과 camera fit 때문에 도면 이미지 자체가 이 높이를 채우거나 현장 전체를 항상 표시한다는 의미는 아니다. 긴 이름·오류·큰 글자는 자연 스크롤로 확인한다.

### 관련 파일

- `apps/web/src/features/control/ControlView.tsx`, `target-selection/{SpatialTargetSelector,TargetSelectionToolbar}.tsx`
- `apps/web/e2e/mobile-first-screen.spec.ts`, `control-map-target-selection.spec.ts`

### 갱신 규칙

- 첫 도면 배치·접힘·선택/카메라·복구 수명을 변경하면 해당 동작과 한계를 같은 작업에서 갱신한다.



## 2026-10-06 공통 모바일 헤더·최근 알림 (Task 1)

### 구현 완료

- 760px 미만 헤더는 기존 현장 선택·알람센터를 한 행에 표시한다. 중복 메뉴 제목은 화면 읽기용으로 유지하고 모니터링 현장 전체 집계는 명시적으로 펼쳐 확인한다. 기존 현장 변경 가드·최소 44px 조작·계정/로그아웃 controller와 설정 eager 접근을 유지한다.
- 모바일 toast는 화면 읽기 알림만 유지한다. 공통 provider가 독립적으로 만료시켜 desktop으로 전환해도 지난 toast를 다시 표시하지 않는다. desktop toast와 서버 현장 알람 저장·지우기는 기존 계약을 유지한다.
- 같은 알람센터의 최근 알림은 세션 메모리에 최대 50개를 보관한다. 상태 fingerprint 변경/새 작업은 미읽음이며 같은 polling은 추가하지 않는다. 최근 읽음과 toast 만료는 장애 해결·명령 실행·서버 알람 읽음/지우기와 분리한다.
- 모바일 배지는 서버 현장 알람 미읽음과 최근 알림 미읽음 합계이며 고유 장애 수가 아니다. 서버 수가 불명인 경우 `?`를 유지한다. 계정/허가된 현장 변경 시 provider의 scope 저장소·타이머·callback만 분리한다. 소비자와 계정 버튼 DOM은 유지해 초기 현장 조회 중 열린 로그아웃 확인의 취소/실패 포커스를 보존한다. 전체보기에서도 동일 센터를 여는 독립 행 버튼이 접근 가능하다.

### 미구현

- 최근 알림은 새 문서·로그아웃·다른 기기로 동기화하지 않는다. 별도 서버 API/DB/저장소와 실제 장비 HIL은 추가하지 않는다.

### 부족하거나 개선이 필요한 기능

- 브라우저 HTTP fixture 검증과 세션 단위 검증이며 실제 native 장비/HIL 완료를 의미하지 않는다. 큰 글자·긴 내용은 자연 스크롤을 허용한다.

### 관련 파일

- `apps/web/src/features/shells/CustomerShell.tsx`, `CustomerHeaderSummarySlot.tsx`
- `apps/web/src/components/ui/session-status/{SessionStatusProvider,SessionStatusCenter,ToastRegion}.tsx`
- `apps/web/e2e/mobile-first-screen.spec.ts`

### 갱신 규칙

- 공통 헤더·알림 의미와 세션 수명 변경 시 네 메뉴 문서를 함께 갱신한다.

## 2026-10-06 Control 가용 높이·완전한 적용 버튼 접근 보완

### 구현 완료

- 권한이 있는 일반 `/control` 경로의 Shell 콘텐츠 행이 남은 높이를 전달한다. 충분한 화면의 실제 지도는 1440×900의 387px에서 1440×1100의 587px로 성장하고, 확대 후 실제 resize에서도 논리 중심·선택·유효 초점을 유지한다. 다른 경로·권한 gate·모니터링·editor·전체 화면 분기 정책은 변경하지 않는다.
- 실행 입력은 전체 고유 높이를 예약하고 결과 피드백만 잔여 공간을 사용한다. fresh 1024×480·390×320·1440×900에서 최소 지도 240px, 자연 스크롤, 범례·footer와 완전한 44px 적용 버튼 접근을 확인했다. 클릭 가능한 중심만으로 43.5px 잘림을 통과시키지 않으며 실제 clipping ancestor와 native wheel을 측정한다. 입력·Enter·지도·이력 조작의 추가 장비 POST는 0이다.
- 두 열 상세는 크기 query container인 실제 피드백의 잔여 높이와 기존 16rem 상한 중 작은 값으로 제한한다. 같은 펼침 조건·handler·잠금의 명령 상세 닫기는 두 열에서 바깥 피드백 형제, 단일 열에서는 기존 안쪽 상세의 실제 action tail로 유지한다. Shell의 기존 759px 경계만 전달하고 닫기 DOM은 하나만 마운트한다. 전환 직전 닫기에 있던 초점만 preventScroll로 보존하며 다른 입력 초점·접기/재열기·현장/명령 scope를 빼앗지 않는다. 실제 9개 화면에서 native wheel/End 후 040 hit를 확인했으며, 두 열 잔여 피드백/상세는 실제 59·111·120px로 일치한다. 1024×768에서는 별도 native outer wheel 119px 뒤 전체 44px 닫기 clip/hit·클릭·원 상세 제거와 POST 0을 확인했다. 바깥 경고·안전 조작 스크롤은 유지한다.

### 미구현

- 실제 native WebView·물리 멀티 터치·Gateway/LED/센서 HIL 및 운영 API/DB 적용은 포함하지 않는다.

### 부족하거나 개선이 필요한 기능

- 원 전체 mock의 Apply·높이·dense 선택 실패와 후속 Monitoring Escape 실패, 앞선 91 PASS/3 FAIL 및 90 PASS/4 FAIL을 보존한다. 가벼운 첫 zoom 계측도 eligible121의 cached/input/current 중심과 정상 선택만 관측하여 반복된 원 실패의 인과는 미확정이다. 별도 승인된 테스트 입력 계약으로 기존 이동·두 paint 뒤 marker의 현재 중심을 한 번 재측정해 native click에 사용한다. 실제 소스 함수의 결정적 A→B/A→A·순서 검증을 RED→GREEN으로 확인했지만, 이는 원 과거 실패 원인의 해결 증거가 아니다. gesture/selection producer·disabled125·기존 단언/threshold는 변경하지 않는다.
- 현재 직접 Shell/Control 유닛 177 PASS에는 실제 Shell 전달·두 배치/단일 닫기·양방향 초점·관련 없는 초점·접기 및 현장/명령 scope 회귀가 포함된다. 9개 원 inline body의 040 hit·POST0 및 실제 잔여 상세/닫기 증거와 앞선 높이·Apply covering 4 PASS는 실행 시점별로 구분한다. 최신 타입/UI/94개 영향 검증의 실제 결과·source hash·일반 PNG·cleanup은 `.superpowers/sdd/2026-10-04-operations-ui-refinement/task-9-control-fix-report.md`의 최종 기록으로 확인하며 독립 검토/최종 통합은 별도다. whole-Web/root/build·native·zoom 검증은 재실행하지 않는다.

### 관련 파일

- `apps/web/src/features/shells/CustomerShell.tsx`, `apps/web/src/features/control/ControlView.tsx` 및 기존 인접 테스트.
- `apps/web/e2e/operational-marker-control-height.spec.ts`의 실제 native 스크롤 도달성 측정과 현 좌표 클릭 입력 계약; 기존 exact-ID·선택·camera·무전송 단언은 유지한다.

### 갱신 규칙

- Shell 전달 높이와 실행/결과 할당이 바뀌면 실제 resize 성장·카메라·짧은 화면 최소 높이·전체 44px clipping/hit·native wheel·가로 넘침 0을 함께 기록한다. UUID·고정 대상·잠금·명령 의미를 레이아웃 검증으로 대체하지 않으며 원 실패·계측 비재현·후속 covering의 시점을 구분한다.

- 2026-10-05 공통 초기 초점 안정성 보완: Dialog 내부 ref를 안정화해 중첩 Popover가 열린 동안 부모 재렌더·외부 object/callback ref 교체가 사용자 초점을 빼앗지 않으며 이전 ref 정리와 닫힘 시 정리는 유지한다. 직접 공통 회귀와 격리 Chromium 검증 범위이며 실제 native WebView·HIL 및 최종 통합 승인을 뜻하지 않는다.
- 2026-10-05 고객 알림 배치 보완: CustomerShell은 sticky 헤더 뒤·본문 앞의 단일 flow 알림 영역에 표시 중인 메시지의 실제 높이만 예약한다. 알림이 없으면 빈 간격은 없고 닫기·만료·revision·aria와 제어 요청 정책은 유지한다. 공통 기본 overlay는 변경하지 않는다. 직접 Shell/제어 회귀와 모니터링 격리 Chromium 범위이며 제어의 전체 상태 조합·native/HIL·최종 통합 승인은 별도다.

## 2026-10-05 공통 Grid·상세 필터·inline 결과 (operations-ui-refinement Task 6)

### 구현 완료

- 스케줄·차량 이벤트는 실제 목록 컨테이너 너비를 측정하는 공통 DataGrid의 표/카드를 사용한다. 활성 토글은 별도 44px 버튼이며 수정·삭제는 typed RowActions 더보기와 기존 확인·초점 복귀 경로를 사용한다. 중복 overview를 제거하고 스케줄 밝기는 목록 표시에서만 제거한다. 저장 payload, 이벤트 밝기·센서·유지 시간·대상, 현장 시간대·다음 실행·Gateway 적용 상태·최근 결과·실패/재시도는 유지한다.
- 검색은 상세 필터 밖에 남고 비검색 조건은 공통 Popover로 모은다. 자동화 기본 전체/전체/10건, 이력 기본 빈 기간·단계/50건과 50·100·500·1000 옵션, 300ms 검색, 사용자/현장 cursor 복구·보관 시각 계약은 유지한다. 날짜 원문은 부모가 소유하므로 부분·역순·존재하지 않는 날짜는 닫아도 보존하며 잘못된 조회를 보내지 않는다. 상세 초기화는 검색을 지우지 않는다. 실행 대상·층·선택 방식·밝기는 조회 필터가 아니다.
- 독립 검토 보완: 기존 이력 조회 오류가 남아 있어도 부분·존재하지 않는 날짜의 수동 재조회 버튼과 handler가 같은 유효성으로 추가 GET를 차단한다. 역순 초안의 기존 새 query-key 경로도 조회 없이 보존하며 유효한 날짜 수정 후 정상 읽기를 확인했다. 실제 필터 열기·닫기는 변경 callback 0이고 초기화는 검색을 보존한다. 세 mock E2E 경계 및 두 자동화 단위 목록 측정/행 메뉴는 지정된 test-only 공통 지원을 사용한다.
- 최근 결과 요약은 stage와 outcome이 일치하는 성공·일부 성공·실패만 확정한다. 처리 건수만 찼거나 outcome 모순·시간 초과·검증 필요·진행/불명인 결과는 성공으로 추정하지 않는다. 상세는 명시적 inline 펼침과 세로 스크롤이며 새 dialog/Drawer를 만들지 않는다. 미확정 안내·실제 상태 확인·안전 재적용은 접힘 바깥에 유지하고 원본 UUID·고정 대상·잠금·복구 owner를 변경하지 않는다.
- 제어 지도는 공통 viewport의 modifier 없는 wheel 확대 옵션을 소비한다. 기존 8px 영역 추가 선택, Space/가운데 버튼 이동, 터치 길게 누르기·핀치·취소와 정확 대상 판정은 유지한다. 데스크톱의 긴 층/구역 목록은 실제 지도 행 안에서 스크롤하도록 크기 containment를 적용하며 지도 최소 높이·footer·범례·48px hit와 카메라를 유지한다.
- 두 열 실행 패널에서는 최근 결과만 양의 높이를 가진 내부 스크롤로 유지하며 고정 입력·적용과 접힘 바깥 안전 조작을 보존한다. 760·768·1023·1024 경계와 짧은 화면에서 실제 wheel/End·040번째 결과·안전 버튼 도달성을 확인했다. 1440×600 자연 문서 흐름에서는 실제 wheel/key 후 지도 최소 240px·44px footer hit·범례 clip/겹침 0을 확인했고, 원래 넓은 화면의 페이지 고정·40행 내부 스크롤 계약은 유지한다.

### 미구현

- 실제 Gateway·LED·센서·RF 및 native WebView 물리 입력/HIL, 운영 API/DB 적용·배포·retention rollout은 이 작업 범위가 아니다.

### 부족하거나 개선이 필요한 기능

- 현재 검증은 격리 Node 22/Chromium mock lab 범위다. 합성 두-pointer/hold와 실제 Chromium mouse/wheel/key 입력을 구분하며 실제 모바일 멀티 터치 인증으로 쓰지 않는다. genuine browser 200%의 숫자/입력 관측과 비어 있는 이미지 문제는 분리해서 보고하며 비어 있는 캡처를 시각 검증 성공으로 기록하지 않는다.
- 직접 covering 350개와 App 69개, typecheck 및 UI 정책 실제 0개 위반을 확인했다. 기본 whole-Web는 한 번만 실행하여 3171 PASS/1 FAIL/3 SKIP였고, 실패한 기존 App 상세 단언은 명시적 펼침 한 줄 수정 후 App covering으로 확인했다. 격리 browser 원 79개 중 77 PASS/2 FAIL 뒤 해당 자동화 8개와 짧은 화면 1개 covering이 통과했다. 전체 suite를 수정 후 다시 실행했다고 주장하지 않으며 독립 검토·최종 통합/Task9 시각 관문은 별도다. 아래 기록도 당시 범위이며 실제 장비 완료로 확대하지 않는다.
- fixround1의 현재 직접 검증은 이력·스케줄·이벤트·목록 조건 4파일 176 PASS 및 typecheck·UI 정책 0위반이다. 영향받은 세 mock browser의 기존 79개는 통과했고 새 경계 테스트의 fixture 메시지 기대 1개 실패를 보존한 뒤 해당 1개 covering이 통과했다. pre-fixture context 404와 이후 page fixture의 404를 구분하고, page API fixture가 잡지 않는 외부 non-API sentinel의 실제 context abort만 증명한다. 기존 외부 API fixture의 응답을 abort 증거로 부풀리지 않는다. 앞선 350/App69와 전체 Web 수치는 이전 시점이며 전체 Web/root/zoom 재실행·최종 독립 재검토 승인·전역 warning 억제는 하지 않았다.

### 관련 파일

- `apps/web/src/features/control/{ControlView,CommandHistoryPanel}.tsx`, `command-result-presentation.ts`, `target-selection/SpatialTargetSelector.tsx` 및 인접 테스트.
- `automation/{ScheduleControlPanel,VehicleEventControlPanel}.tsx`, `automation/components/{AutomationRuleControls,AutomationRuleTable}.tsx`; 별도 AutomationRuleCard는 공통 DataGrid 카드로 이관했다.
- `apps/web/e2e/{calm-operations-automation,calm-operations-manual-control,control-map-target-selection}.spec.ts`.
- `apps/web/src/App.test.tsx`의 기존 partial polling 케이스는 상세 펼침 뒤 기존 70%·두 대상·UUID 및 결과 단언을 유지한다.
- test-only 지원: `apps/web/e2e/support/mock-api-boundary.ts`, `apps/web/src/test/automation-list.ts`.

### 갱신 규칙

- 조회/표시 변경과 장비 명령 owner 변경을 구분하고 펼침·필터·resize의 추가 제어 POST 0, 원본 UUID·대상·잠금, 더보기 삭제 초점, 정확 지도 ID·내부 넘침/스크롤 끝을 함께 회귀 검증한다. 단계/outcome 확정 표와 API/DB/HIL·mock·headless·genuine zoom의 실제 증거 경계를 유지한다.

## 2026-10-04 주석 수정 최종 소프트웨어 검증

- 구현 완료: 직접 선택 제스처·단일 밝기 입력/슬라이더·명시적 적용·스케줄 이름/기간/건수와 공통 명령 이력 UI를 구현했다. 실제 C1 OFF/C2 ON의50/100/500/1000·날짜·페이지·현장 scope400·S1복귀·명령POST0와 C3 자연 만료400/자동GET200·빈 첫 페이지 복구를 확인했다. 현재 소스 원 automation1PASS는 독립 실제 프로토콜/DB 적용 증거를 포함한다.
- 구현 완료(로컬 반영): 기본 개발 브랜치099로 fast-forward하고 새 API/기존 웹 재개 및 TLS live200·Web200·비인증 proxy401을 확인했다. 기존 명령 retention/recovery/purge profile은 그대로 유지하며 강제로 켜지 않았다.
- 미구현: 실제 RF/센서/조명 출력·native WebView·운영 retention rollout은 이번 UI 검증의 범위가 아니다. 10:06:37 UTC startup readiness 단일 관측은503/MQTT down·나머지4 up이며 이후 재측정·지속성·원인은 미확인이다. 실제 명령·장비 연결 복구는 수행하지 않았다.
- 부족하거나 개선이 필요한 기능: C3 안내 문구는 관측하지 못했으며 자동 복구를 안내 렌더의 증거로 대신하지 않는다. 단일 테스트 membership 순차 전환은 동시 현장 선택 인증이 아니다. 기존 command rollout/recovery/purge 및 권한·명령 안전성은 강제로 변경하지 않는다.
- 관련 파일: [22행 구현·검증 계획](../superpowers/plans/2026-10-01-operations-ui-comments.md), `apps/web/src/features/control/ControlView.tsx`, `automation/ScheduleControlPanel.tsx`, `CommandHistoryPanel.tsx`, `apps/api/src/fixtures/fixture-freshness.service.ts`.
- 갱신 규칙: mock/native 입력/소프트웨어 Gateway/실장비 결과와 DB 시각·보관 기한을 구분한다. 이력 열기·필터·선택·Enter가 장비 명령을 자동 실행하지 않는 회귀를 유지한다.

## 2026-10-04 PostgreSQL session 시간대에 독립적인 제어 freshness

- 구현 완료: persisted Fixture.status를 갱신하는 raw heartbeat/fixture cutoff Date 바인딩을 UTC timestamp로 정규화한다. 고정90초/20분·정확 경계·Gateway 장애 우선·수동 확인 실패·provisioning 제외·Site→Gateway→Fixture→Incident 잠금·activity/idempotence는 변경하지 않는다. 모니터링 현장별 정책으로 제어 안전 기준을 대체하거나 개인 읽음으로 장비 명령을 보내지 않는다.
- 부족하거나 개선이 필요한 기능: UTC·Asia/Seoul·America/New_York 겨울/여름의 자기 소유 임시 PostgreSQL 회귀는 운영 적용·실장비/HIL 증거가 아니다. 운영 DB/role/session TZ 변경과 기존 timestamp/data 복구는 수행하지 않는다.
- 관련 파일: `apps/api/src/fixtures/fixture-freshness.service.ts`, `apps/api/src/prisma/utc-timestamp-sql.ts`, `apps/api/src/monitoring-incidents/monitoring-incidents.integration.spec.ts`.
- 갱신 규칙: 고정 제어 freshness와 사용자 모니터링 정책·개인 읽음·장비 명령·임시 DB/운영 검증을 구분하고 실제 session·상태/reason·activity·명령/outbox 불변 회귀를 함께 유지한다.

## 2026-10-03 가용 지도 높이·설정 origin 회귀 보완 (Task 9 P2-A/B)

### 구현 완료

- 기존 tablet=1024 경계에서 shell의 콘텐츠 높이를 제어 화면과 지도까지 전달한다. 최소 콘텐츠가 더 크면 문서 스크롤을 유지한다. Chromium route fixture의 1440×900/1440×1100에서 실제 지도는 387/587px로 성장하며, 1024×480·390×320은 최소 240px와 범례·줌·밝기·이력의 일반 스크롤 접근을 유지한다.
- 기존 viewport의 resize camera 보존 옵션을 소비한다. 충분한 높이의 초기 fit이 가용 지도에 맞춰 커지고, 사용자가 확대한 뒤 resize해도 zoom·논리 중심·선택·유효 버튼 포커스를 유지한다.
- tracked 지도 fixture는 테스트의 configured baseURL origin을 명시적으로 받는다. baseURL 누락은 실패하며 document/static/알려진 API는 해당 origin에서만 처리한다. 외부 일반 요청과 알려진 API 경로도 차단하고 unknown API는 404를 유지한다. 16208 및 별도 16214 origin의 실제 좁은 회귀와 장비 POST 0건을 확인했다.

### 미구현

- 실제 WebView 물리 입력·safe-area 및 Gateway·LED RF HIL 검증.

### 부족하거나 개선이 필요한 기능

- 이전 원시 증거와 후속 source/browser 증거를 구분한다. 넓은 화면의 240px 고정은 이번 후속으로 보완됐으며 독립 reviewer 재검토·designer·최종 통합/실DB 검증은 별도 관문이다.
- 설정된 다른 origin의 실행 계약을 검증한 범위이며 일반 config의 전체 suite나 운영 서버 실행을 의미하지 않는다.

### 관련 파일

- `apps/web/src/features/control/ControlView.tsx`, `target-selection/SpatialTargetSelector.tsx`.
- `apps/web/e2e/operational-marker-control-height.spec.ts`, `e2e/support/operational-map-fixture.ts`.

### 갱신 규칙

- 실제 지도 높이와 shell 가용 공간 전달이 바뀌면 충분한 화면의 성장·짧은 화면 최소 높이·일반 스크롤·camera 보존을 함께 기록한다. fixture origin 변경은 외부 차단·unknown404와 실제 port 증거를 함께 갱신한다.

## 2026-10-02 운영 밀집 마커·짧은 지도 높이 보완 (Task 9)

### 구현 완료

- 운영 지도는 현재 화면의 실제 48×48px 버튼 경계와 중심 거리로 포인터 대상을 결정한다. 선택·hover·focus·DOM 순서에 영향을 받지 않으며, 20px 원형 조명 점과 저장 좌표를 유지한다. 장애 중심은 정상 이웃으로 우회하지 않고 기존 비활성 사유와 native Tab 제외를 유지한다. Enter/Space는 포커스된 조명 ID를 사용한다.
- 단일 포인터가 8 CSS px 이상 이동하거나 두 번째 포인터·취소·capture 손실·blur·Escape·snapshot/층/정책 변경·unmount가 발생하면 선택을 취소한다. 확대·이동 뒤에도 현재 DOM 좌표를 다시 측정하며 가려진 조명과 물리 ghost click을 활성화하지 않는다. 기존 영역 추가 선택·Space/가운데 버튼 이동·터치 핀치를 유지한다.
- 수동 제어는 문서 흐름으로 스크롤하며 실제 지도 viewport 최소 240px를 유지한다. 확대·축소는 기존 공통 viewport의 footer 옵션을 사용하고 범례는 별도 행에 놓는다. 1024×480, 390×320, 1440×900 route fixture에서 실제 높이 240px, 범례/조작 영역 분리, 밝기 입력·적용·명령 이력 접근과 문서 가로 overflow 0을 확인했다. 입력·Enter·선택·지도 조작의 장비 POST는 0건이다.

### 미구현

- 실제 모바일 WebView의 물리 멀티 터치와 Gateway·LED RF HIL 검증.

### 부족하거나 개선이 필요한 기능

- 검증은 격리 Chromium route fixture 및 소프트웨어 터치 입력이다. 실제 장비 영수증·DB·현장 도면·safe-area 실측을 인증하지 않는다.
- 완전히 같은 화면 중심을 가진 조명은 좌표만으로 구분할 수 없어 ID 순서로 안정적으로 선택한다. 별도 조명 목록에서도 개별 대상을 선택할 수 있다.
- 기존 Task 6 완료 범위를 유지하며 운영 보존 rollout과 별도 백엔드 랩은 이번 보완 범위에 포함하지 않는다.

### 관련 파일

- `apps/web/src/features/floor-map/FloorScene.tsx`, `marker-hit.ts` 및 대응 테스트.
- `apps/web/src/features/control/ControlView.tsx`, `target-selection/SpatialTargetSelector.tsx` 및 기존 직접 테스트.
- `apps/web/e2e/operational-marker-control-height.spec.ts`, `e2e/support/operational-map-fixture.ts`.

### 갱신 규칙

- 공통 마커 판정이 바뀌면 모니터링 문서도 함께 갱신한다. 실제 viewport 높이·스크롤·장비 전송 경계와 fixture/HIL 한계를 함께 기록한다.

## 2026-10-02 직접 지도 조작·밝기 입력·명령 이력 (Task 6)

### 구현 완료

- 직접 선택에서 조명 클릭은 선택을 토글하고 빈 지도 왼쪽 드래그는 기존 선택에 영역 내 적격 조명을 더한다. 별도 이동·개별·영역 도구 버튼을 제거했다. Space를 누른 지도 드래그와 가운데 버튼은 이동이며, 층 전체·저장 구역에서는 빈 지도 드래그가 이동이다. 터치는 조명 탭, 한 손가락 이동, 두 손가락 확대, 빈 지도 400ms 길게 누른 뒤 영역 선택을 제공한다. 이동 기준은 8 CSS px이며 두 번째 포인터·capture 손실·취소·창 blur·Escape·층/정책 변경·unmount에서 진행 중 조작과 타이머를 정리한다. 단일 Gateway·권한·offline/미배치·잠금·조명 1,000개·구역 100개 제한을 유지한다.
- 수동 밝기는 굵은 수치 입력과 `%`, 슬라이더로 편집하며 0/30/70/100% 버튼은 제거했다. 공통 `NumberField.inputClassName`으로 실제 입력에 기존 metric·굵기·정렬·padding 토큰을 적용하고 `className`은 기존 필드 외곽을 유지한다. 비어 있거나 소수·0~100 밖인 원문 입력은 적용을 차단한다. blur/Enter는 마지막 정상 값으로 복원하고 안내하며, 같은 blur 클릭은 전송하지 않는다. 이후 별도 적용만 명령을 생성하며 입력·슬라이더·Enter는 자동 전송하지 않는다.
- 현장 명령 이력 drawer는 기본 50건, 50/100/500/1000건과 시작·종료 날짜 조회를 제공한다. 최근 요약은 기존 1건 조회다. 검색·단계·기간·크기·사용자/현장·열림 상태 변경 시 첫 페이지로 돌아가며 A→B→A와 닫기/재열기에서도 이전 페이지를 재사용하지 않는다. 조회 중/오류의 현재 건수는 알 수 없음으로 표시하고 실제 빈 성공만 0건이다. 안정된 페이지 조작 영역은 요청 전 사용자 포커스를 보존하되 날짜·닫기·본문으로 의도적으로 이동한 포커스를 되돌리지 않는다. 기존 400 `command_history_cursor_expired` 복구, DB retention clock 거부, 상세 선택과 안전 잠금은 유지한다.
- 스케줄 이름은 긴 한글·공백 없는 영문까지 줄바꿈한다. PC 기간은 별도 열, 모바일은 기간 필드로 유지하며 이름 아래 중복 기간과 독립 Gateway 동기화 열/필드는 제거했다. 활성 상태 옆에 적용 대기·적용 실패를 표시하며 기존 요약·필터·polling·최근 실행 결과·오류/재시도는 유지한다. 목록 건수는 `조건에 맞는 규칙 N건` 하나로 표시한다.
- 실제 명령·진행/복구·스케줄 다음/최근 실행·차량 감지·새로고침 시각은 공통 Gregorian `yyyy-MM-dd HH:mm:ss`와 현장 시간대를 사용한다. 자정은 `00:00:00`, 잘못된 시각은 `—`이며 날짜 전용과 반복 `HH:mm`은 유지한다. 이력/조명 목록 drawer는 각각 safe-area에 opt-in하고 본문만 스크롤한다. 조명 목록은 첫 항목을 자동 선택하지 않으며 완료/닫기 뒤 opener로 포커스를 복원한다.

### 미구현

- 실제 모바일 WebView의 native 멀티 터치와 Gateway·조명 RF HIL 검증. 합성 PointerEvent의 두 포인터/길게 누르기 검증은 물리 터치 인증이 아니다.
- 운영 보존 rollout 활성화 및 별도 실제 백엔드 자동화 랩 검증. Task 6는 API/DB schema·migration·하드웨어 전송 경계를 변경하지 않는다.

### 부족하거나 개선이 필요한 기능

- 스케줄 적용 실패의 새 Gateway 상세 사유는 현재 API에 없으므로 추가하지 않았다. 기존 mutation 오류와 최근 실행 결과를 표시한다.
- DB가 제공하는 UTC 달력 3개월·현장 시간대 날짜 경계를 소비하며 브라우저에서 90일 cutoff를 만들지 않는다. 보존 OFF를 강제로 ON으로 변경하지 않는다.
- 아래 날짜별 기록의 이전 수동 프리셋·지도 도구 모드·16px 수치·compact 고정 시트 설명은 당시 구현 기록이며 현재 수동 UI는 이 Task 6 및 2026-09-25의 자연스러운 실행 패널 흐름을 따른다. 자동화 editor의 반복/밝기 프리셋은 별도 기능이다.

### 관련 파일

- `apps/web/src/features/control/ControlView.tsx`, `CommandHistoryPanel.tsx`, `control-time.ts`, `target-selection/`, `automation/ScheduleControlPanel.tsx`, `VehicleEventControlPanel.tsx`, `automation/components/AutomationRuleCard.tsx`, `AutomationRuleControls.tsx` 및 대응 테스트.
- `apps/web/src/features/floor-map/FloorMapViewport.tsx`, `map-gestures.ts`, `apps/web/src/api/commands.ts`, `apps/web/src/components/ui/fields/NumberField.tsx`, `fields.test.tsx`.
- `apps/web/e2e/control-map-target-selection.spec.ts`, `calm-operations-manual-control.spec.ts`, `operations-ui-comments.spec.ts`의 Task 6 사례와 기존 `command-retention.spec.ts`.

### 갱신 규칙

- 직접 조작·입력 편집만으로 명령이 생성되지 않는지와 제한/잠금/복구를 함께 회귀 검증한다. 기본 pan·카메라·wheel 및 공통 NumberField 기본/ref/null/범위/disabled/invalid 계약을 유지한다.
- 현재 건수/기간/포커스·짧은 화면·양의 safe-area의 실제 DOM/브라우저 검증과 mock API·실제 백엔드·하드웨어 증거를 구분한다. 독립 리뷰 전에는 통합 완료로 기록하지 않는다.

## 2026-10-02 명령 이력 기간·1,000건 API (Task 1)

- 구현 완료: `GET /commands`에 paired `fromDate`/`toDate`(`YYYY-MM-DD`)와 1–1,000건 상한을 추가했다. 현장 범위·읽기 권한·기본 20건·검색/단계·content redaction·결과 요약을 유지한다. 종료일은 저장된 Site 시간대의 다음 날짜 시작까지 포함하며 end는 동일 transaction의 DB `generatedAt`으로 제한한다. 보존 rollout ON일 때만 DB `retainedFrom`과 하한을 교차하고 OFF에는 강제로 3개월을 적용하지 않는다.
- 구현 완료: 새 v2 cursor는 사용자·현장·정규화 검색/단계·날짜·실효 조회 크기의 canonical SHA-256 scope와 원본 createdAt/id를 유지한다. 100자 검색어에서도 cursor 512bytes 상한을 유지하며 조건 불일치/잘못된 cursor는 400, 보존 만료는 기존 `command_history_cursor_expired`(400)다. 구 unversioned cursor는 날짜 조건 없이 기존 상한 100 이하에서만 허용하고 구 검색/단계 동작은 유지한다. 다음 cursor는 항상 v2다.
- 웹 소비: 기본 50건·50/100/500/1000 옵션과 기간 UI는 위 Task 6에서 구현했다. 최근 1건 조회는 유지한다. 이 API producer 변경 자체와 웹 소비 검증은 별도다.
- 부족하거나 개선이 필요한 기능: 이번 지원은 로그 읽기 producer 계약이며 명령 상세/복구/Get/Set·worker·rollout flag를 변경하거나 운영 활성화하지 않는다. 일회용 DB opt-in 통합·독립 리뷰와 웹 소비 검증은 별도 완료 증거가 필요하다.
- 관련 파일: `apps/api/src/retention/log-date-range.ts`, `apps/api/src/commands/command-status.service.ts`, `commands.controller.ts`와 관련 단위 테스트.
- 갱신 규칙: API 날짜·limit·v2/legacy cursor 계약과 UI 적용 상태를 따로 기록하고, 보존 OFF/ON·인가·검색 OR의 Site 격리·동일 시각 ID tie-break·응답 요약/메타데이터를 회귀 검증한다.
- 날짜 경계 보완: 현장 시간대에서 실제로 존재하지 않는 시작일·종료일을 선택하면 400으로 거부한다. 유효한 종료일 다음 날짜만 시간대 전환으로 사라진 경우에는 다음 실제 날짜 시작을 종료 경계로 사용하며, 보존 범위 밖의 유효한 기간은 그대로 빈 교집합이다. Pacific/Apia 역사 경계는 단위 테스트 증거이며 실제 DB 검증은 후속이다.

## 2026-09-27 종료 명령 상세 정리 helper와 기본 OFF worker

- 구현 완료: worker 성공·실패·지연/사유별 보류 지표는 production JSON 로거의 고정 event/context 계약을 통과한다. 숫자 범위와 허용 사유를 검증하며 원문 오류·명령 ID·SQL은 기록하지 않는다. 실제 로거 출력까지 연결한 소프트웨어 회귀를 포함한다.
- 구현 완료: 종료 outcome과 terminal dispatch/result, hold 없음, 종료 override, settled outbox를 확인한 뒤 원본과 파생 상세를 같은 거래에서 제거하는 내부 helper 및 DB tombstone 제약을 추가했다. Command/dispatch/수동 parent ID·FK·alias는 보존하며 exact 수동 replay는 keyed 증명으로 검증해 DB 상세/ACK hash 재생성 없이 응답한다. 실패하면 전체 거래를 rollback한다.
- 구현 완료: 기본 OFF인 `COMMAND_DETAIL_REDACTION_ENABLED` worker를 등록했다. ON에서 60초마다 기본 100개(허용 상한 1,000개) 후보를 DB UTC 3 calendar months 기준으로 잠그고 helper를 실행한다. 정확 cutoff·이미 제거된 행은 보존/제외하며 실패 거래 rollback 뒤 `detail_` 사유로 1시간 재시도를 미뤄 뒤 후보의 기아를 방지한다. batch의 처리/보류/지연 건수, 전체 사유별 보류 건수와 최고 경과 초를 기록한다. 오래된 미해결·활성 상태는 보류하고 제어 잠금을 유지한다.
- 미구현: 운영 중앙 DB migration/활성화와 외부 운영 경보 연결. 물리 Command purge, 보호 cutover, 복구 POST와 새 자동 Set/Get은 이번 변경으로 켜지지 않는다. 운영 적용은 백업·dry-run·DB 시계·raw 사본 감사 뒤 별도다.
- 부족하거나 개선이 필요한 기능: 연결할 수 없는 과거 ACK hash·고아 수동 실행·미완료 재위촉·증명/키 부족은 이유와 함께 보류된다. 일회성 ACK 발행 실패는 Gateway의 기존 보고 재전송에 의존하며 실제 broker/Gateway/RF HIL은 별도다.
- 관련 파일: `apps/api/src/retention/command-detail-redaction.ts`, `apps/api/src/retention/command-detail-retention.service.ts`, `apps/api/src/retention/retention.module.ts`, `apps/api/src/automation/redacted-manual-execution-replay.ts`, `apps/api/src/mqtt/mqtt.service.ts`, `apps/api/prisma/migrations/20260927160000_command_derived_content_redaction/migration.sql`.
- 갱신 규칙: software DB/transport 회귀와 실제 운영·하드웨어 검증을 구분하고, 사본 검증 실패를 정리 성공으로 기록하지 않는다.

## 2026-09-27 발행 세대와 보관 worker 안전 통합

- 구현 완료: 일회용 PostgreSQL의 제한 worker는 전체 member ACK, 시도별 absolute expiry, 같은 primary의 내구적 시각 연속성, 전체 broker/Gateway 증명과 독립 단조 대기를 통과해야 서명된 정확 cutoff로 원본을 삭제한다. 증명 누락·위조·다른 boot/세대는 삭제 0이다. Set quiesce와 독립인 원본 없는 Get publisher를 등록하고 MQTT 종료 전에 해당 Get도 drain한다.
- 미구현: 운영 물리 purge와 recovery POST 활성화, 운영 DB-host attestor, 되돌릴 수 없는 broker admission/인증서 원장, 전체 현장 Gateway census 및 Raspberry Pi/BlueZ/BIO 물리 RF HIL 인증.
- 부족하거나 개선이 필요한 기능: 소프트웨어 queue/submitted/unconfirmed 0과 재시작만으로 RF 완료를 인정하지 않는다. Gateway 버전 문자열 일치만으로도 허용하지 않으며 독립 release 인증의 clock proof·매 submit 만료 재검사·보수적 RF 계수 capability와 별도 물리 HIL이 모두 필요하다. 기본 인증 목록과 운영 adapter는 없다. broker digest에 worker identity→인증서 소유 증명이 없어 member ACK 하나라도 없으면 backlog로 남긴다. CLI는 별도 장벽 입력이 없는 경우 삭제 0이며 운영 스케줄러가 아니다. 제한 worker의 SQL 직접 호출도 정확한 hold 대상·밝기·Gateway와 late Set wire HMAC을 재검증하며 TS 사전 검사만으로 삭제를 허용하지 않는다.
- 관련 파일: `apps/api/src/commands/command-purge-barrier.service.ts`, `command-retention-worker.ts`, `apps/api/src/mqtt/gateway-command-drain.service.ts`, `recovery-outbox-publisher.service.ts`, `apps/api/prisma/cutovers/command-retention-protected-delete.sql`.
- 갱신 규칙: 운영 gate는 disposable 테스트와 별도로 기록하고 실제 broker/clock/HIL 증거 없이 완료 또는 purge ON으로 바꾸지 않는다. 기존 unknown/partial hold·늦은 ACK·Get 전용 복구와 자동 Set 재시도 금지 경계를 유지한다.

기준일: 2026-09-24

## 구현 완료

- 2026-10-08 BIO 실행 authority는 scoped 승인 catalog·명시 실행정책·accepted 준비 ACK·독립 fresh mode GET·exact live capability ACK를 함께 요구한다. 검증된 automation snapshot을 stage/commit/rollback하며 요청 revision 숫자만으로 pin을 만들지 않는다. 같은 건강 구간의 반복 GET은 live report의 revision/verifiedAt만 갱신하고 기존 snapshot pin과 healthySince는 유지한다. catalog/identity/connection/decoder/health age 변경은 queued/cached authority를 즉시 철회한다.
- 저장된 enabled BIO snapshot은 재시작 시 건강을 복구하지 않고 원상태 복원용 degraded 문맥으로 보존할 수 있다. 이때 current 실행 revision을 확인한 것으로 보고하지 않으며 fresh 준비/GET/ACK와 인증된 snapshot 재수용 전 자동 실행을 막는다. 기존 pending 원상태는 삭제하지 않는다. durable explicit operator_release만 별도 fresh identity GET·현재 mapping/generation guard로 복원하며, 이 증거는 pulse/hold/자동 만료 또는 healthy pin에 사용하지 않는다. 각 target GET/SET guard는 이미 받은 fresh 증거를 대조하며 전역 RF queue 안에서 새 GET을 중첩하지 않는다.
- Task 3 검토 보완: 다른 source의 준비/최초 healthy ACK/건강 실패는 해당 source만 철회한다. 건강한 F1은 latest live ACK가 증가해도 기존 snapshot capRev pin·queued receipt·healthySince·full-hold 복원을 유지한다. profile 철회/재연결/재시작 후에는 준비 journal의 exact 과거 귀속을 복원 전용으로 보존하고 현재 scope/assignment·confirmed mapping·fresh discovery/GET·connection generation이 저장된 binding과 일치할 때만 명시 해제한다. 승인 profile/sensor mode를 다시 요구하지 않으며, fresh identity 실패/불일치는 pending을 유지한다. 과거 ACK나 해제 증거로 자동 실행/healthy authority를 복원하지 않는다.
- Task 6 Gateway 연결 보완: 현재 commission/health epoch의 live capability가 서버에서 rejected되면 해당 Fixture의 기존 accepted revision·snapshot pin·대기 pulse를 즉시 차단한다. 거절 전에 완료한 GET proof는 나중에 더 높은 revision의 positive ACK가 와도 회복 근거가 아니며, 거절 뒤 새 독립 GET과 exact 새 positive ACK가 필요하다. 다른 Fixture나 이전 commission의 늦은 reject는 현재 건강한 source를 철회하지 않는다. live report의 `sensorModeVerifiedAt`은 준비 checkpoint 시각으로 고정하고 `verifiedAt`만 독립 GET 시각으로 갱신한다. 실제 장비 건강/광학 동작은 아직 검증하지 않았다.
- 제품 BIO target 소유권 검사에서 비활성 BIO/BlueZ 규칙은 target을 예약하지 않는다. 활성 BIO와 다른 활성 event 규칙의 target 중복은 계속 거절하며 여러 규칙을 합치는 arbiter를 추가하지 않았다. API 사전 저장 검증과 수정된 공통 snapshot의 Gateway 소프트웨어 통합을 확인했다.
- Task 6 공통 fixture는 서로 다른 세 registered identity의 exact 준비/live 보고·ACK와 snapshot/config ACK를 별도 API·Gateway harness에서 대조한다. Gateway 실제 source/provider/controller로 pulse의 전체 hold·read-back 복원, profile 철회 뒤 자동 실행 차단·명시 복원, 건강 없는 재시작의 RF0·currentRevision=null을 확인했다. 같은 revision 재검증이 원래 pending binding 때문에 실패해도 복원 전용 문맥은 남기며, fresh identity로 명시 해제한 뒤 같은 snapshot hash/revision을 다시 검증할 수 있다. retained 문맥은 healthy pin을 만들지 않는다. 단일 프로세스·실제 MQTT/RF E2E 또는 초기 운영 profile 승인/실행 ON 증거가 아니다.
- 2026-10-04: 공통 iOS WebView 셸이 가려진 텍스트 입력의 포커스 테두리까지 확인하여 현재 포커스/키보드 열림 시도당 중앙으로 한 번 스크롤한다. 뒤늦은 viewport 크기 변경도 아직 보정하지 않은 입력만 다시 확인하며, 이미 충분히 보이거나 보정한 입력은 이동하지 않는다. 사용자 스크롤 제스처, 키보드 숨김, 앱 비활성화, 오류와 문서 교체 시 대기 중인 보정을 취소한다. Android와 메뉴 업무 로직은 변경하지 않는다.

- 2026-10-04 모바일 제어 복구: strict native bootstrap이 React mount 전에 명시적으로 선택한 환경에서만 사용자·현장별 `led-control:active-command:mobile:v1:` localStorage에 원본 요청 ID·대상·밝기, commandId, 안전 거부/해소 marker와 미완료 수동 상태 확인 요청 ID를 보존한다. 일반 웹은 기존 sessionStorage를 유지하며 단순 mobile window flag로 저장 방식을 바꾸지 않는다. 앱 재시작은 저장된 원본의 상태 조회와 사용자가 누른 동일 요청 확인만 허용하고, 새 Set이나 재적용을 자동 실행하지 않는다. 수동 상태 확인 응답이 유실된 후에도 같은 확인 UUID로 명시적으로 확인하며 새 확인 시도로 대체하지 않는다.
- 모바일 복구 저장소의 읽기·쓰기·정리 실패나 오염은 기록이 없는 것으로 간주하지 않고 해당 문서의 제어를 잠그며 실행 영역에 이유를 표시한다. POST 전 원본 정보 저장이 실패하면 명령을 보내지 않는다. 최초 정상 인증 부팅은 복구를 보존하고, 인증 거부/로그아웃/계정 변경은 기존 인증 정리 경로에서 웹·모바일 명령 namespace를 함께 정리한다. 무관한 저장값과 인증 cookie/token은 복구 기록에 넣거나 지우지 않는다. 종결 결과에 따른 명령 정리에는 해당 상태 확인 기록도 포함한다.
- 제어 HTTP POST의 응답 대기 상한은 기존 API client의 30초를 사용한다. 이는 Gateway/RF 실행 deadline이나 자동 retry 정책이 아니며, 응답 시간 초과는 결과 불명으로 원본 key·잠금을 유지한다. 실제 상태 확인과 안전 재적용의 기존 사용자 명시 동작/최신 detail 검증은 유지한다. 저장소·실제 AppRoot 인증 경계·명령 UI/API의 소유 5개 테스트 파일 270개가 정상 패키지 환경에서 통과했다. 제어 관련 Chromium 57개도 통과했으나 통합 웹 타입/빌드와 실제 Android/iOS 종료·복귀·하드웨어 검증은 별도 게이트이며 단위/브라우저 결과를 실기기 완료로 기록하지 않는다.
- 수동 밝기는 프리셋 없이 `%` 옆의 단일 편집 가능한 수치 입력(0~100 정수)과 슬라이더를 사용하며, 모바일에서도 같은 입력의 직접 편집·Enter/blur 검증·복원 계약을 유지한다. PC 입력/버튼 크기와 제어 payload는 유지한다. 현재 수동 UI의 지도→실행→최근 이력 흐름, 내부 스크롤/페이지 이력 drawer에 맞춰 기존 회귀 테스트를 최신화했으며 mock 응답도 보존 시각 anchor 계약을 따른다.

- 2026-09-30 공통 지도 카메라 계약 보완: `지도 화면 맞춤`은 기본 배율 100%와 지도 중앙을 함께 복원한다. 제어의 기존 선택·pan/zoom·조명 실행 권한은 유지하며, 모니터링 전용 resize 카메라 보존과 사용자별 시야 저장은 제어에서 활성화하지 않는다. 관련 파일은 `FloorMapViewport.tsx`, `map-camera.ts` 및 공통 카메라 회귀다.

- 랜딩·Atlas 통합 검증에서 최근 이력의 `확인 필요한 명령`·`명령 이력 열기` 공통 버튼을 최소 높이 52px로 보정했다. 둥근 44px 외곽에서 실제 hit 영역이 부족했던 모바일 회귀를 수정하며, 전체 통합 검증 상태는 [통합 체크리스트](../superpowers/plans/2026-09-27-atlas-landing-integration.md)를 따른다.
- 2026-09-27 상세 내용 제거 상태(Task 2): `Command.contentRedactedAt`이 있는 행은 플래그 상태와 무관하게 일반 목록에서 제외하며, 인가된 상세와 기존 상태 확인은 내용 없는 `410 command_expired`를 반환한다. 동일 키 재제어와 사용자 삭제로 요청자를 알 수 없는 현장 내 기존 키 재사용은 `409 command_request_expired`로 차단하며 Set/Get/outbox를 생성하지 않는다. 기존 상태 확인의 기간 제한도 `COMMAND_HISTORY_RETENTION_ENABLED=1`에서 중앙 DB UTC transaction 시각의 3 calendar months를 사용하고 정확 경계는 유지한다. 생성 응답은 내부 요청자·요청 키·fingerprint를 숨기며, 늦은 ACK는 제거한 상세를 복원하지 않는다. 일회용 PostgreSQL과 API 소프트웨어 검증 범위이며 비식별 worker와 운영 migration은 아직 활성화하지 않았다.

- 2026-09-25 Final Atlas 자동화 목록 API(Task 7): 스케줄·차량 이벤트의 현장 전체 목록에서 이름의 trim된 리터럴 부분 검색(한글·`%`·`_` 포함), 활성 상태, Gateway 구성 동기화 상태 필터와 `limit=1..100`을 지원한다. 기존 `items,total,nextCursor`와 무필터 v1 cursor는 유지하고, 조건에 맞는 전체 `filteredTotal` 및 필터 없는 현장 전체 규칙 수·상태별 규칙 수 `siteSummary`를 같은 RepeatableRead 조회에서 반환한다. 설정이 없는 Gateway의 규칙은 `PENDING`이며 수치를 Gateway 대수나 현재 로드된 페이지 수로 해석하지 않는다. 필터 cursor v2는 인증 사용자·현장·규칙 종류·정규화된 조건에 묶고, 현장 `read` 권한을 cursor 해석 전에 확인한다. 집중 단위·일회용 PostgreSQL E2E 검증 범위이며 실제 현장 규모의 브라우저 조작과 장비 HIL 증거는 아니다.
- 2026-09-27 Gateway 중앙 Set 물리 전송 경계(Task 6): 명령별 cached permit을 실제 BlueZ D-Bus `Send`와 BIO native write 직전에 동기 재검사한다. 주소/queue/D-Bus interface 조회 지연 및 BIO brightness→force-on 사이의 proof 손실은 후속 Set을 차단한다. 현재 프로세스에서 write 0이 확인된 경우만 내구적 refusal/수동 pending abort로 끝내며, 첫 전송 이후 veto·USB/D-Bus 오류는 unknown/partial을 보존한다. 기존 로컬 일정·센서 자동화 및 Get(이미 보낸 Set의 read-back 포함)은 DB proof veto 대상이 아니다. scoped nonce/epoch drain 요청은 boot ID·Gateway 버전과 queued/submitted/unconfirmed 수를 응답하지만 제출 콜백·관측 성공을 물리 RF 종료로 인증하지 않는다.
- 2026-09-26 Final Atlas 수동 이력 시각 보완: 지도·밝기 실행 아래 최근 이력을 PC에서는 한 줄, 390/320px 모바일에서는 읽을 수 있는 두 줄의 compact bar로 표시한다. 최근 명령의 현장 시각·조명 수·밝기·상태를 요약하고, 요약을 누르면 기존 명령 상세로 진입한다. 전체 3개월 이력·검색·필터·보관 시작 시각은 기존 drawer에 유지하며 확인 필요 명령 진입과 안전 잠금은 변경하지 않았다. Mock API 기반 Vitest 및 Chromium 1440/390/320px 검증이며 실제 Gateway/조명 HIL은 별도다.
- 2026-09-25 Final Atlas 명령 이력·확인 필요 case Web UI(Task 3): 수동 화면의 최근 명령 1건은 무필터 `limit=1`로 조회하고, 일반 이력은 공통 오른쪽 drawer에서 검색·상태 필터와 서버 opaque cursor 4건 단위 이전/다음으로 탐색한다. `GET /commands`가 돌려준 UTC `retainedFrom`만 현장 시간대로 표시하며 클라이언트가 3개월 하한이나 가상 전체 페이지 수를 계산하지 않는다. 메타데이터가 없으면 기간 확인 불가로 표시하고 `command_history_cursor_expired`(400)는 첫 페이지를 재조회한다. 오래된 cursor 응답은 사용자·현장·필터 세대가 바뀐 뒤 페이지를 넘기지 못하며 끝 페이지의 키보드 초점은 사용 가능한 이전/다음으로 이동한다. 일반 이력과 별도로 `requiring-verification` 목록/상세를 Site `read`로 열고, Site `control`의 전용 Get-only 상태 확인과 Site `manage`의 명시적 위험 승인(기본 미체크·확인 방법·500자 이내 사유)을 분리했다. 상태 확인 HTTP 응답 유실의 `clientRequestId`는 사용자·현장·case 범위로 세션 보존해 새로고침 뒤에도 동일 키만 재시도한다. 목록/상세/drawer/승인 폼 열기와 승인 자체는 기존 dimming Set을 보내지 않는다. 원본 상세 404/410과 안전 관련 409/410은 잠금을 유지하며 일반 충돌의 새 제어 요청 문구를 표시하지 않는다. 명시적인 안전 거절은 응답 유실과 구분해 같은 dimming 요청의 재전송을 새로고침 뒤에도 금지한다. 정확히 연결된 case의 권한 있는 위험 승인 성공만으로는 잠금을 풀지 않고, 그 사실을 세션에 보존한 뒤 서버의 원본 ID exact-filter 새 조회가 비어 있음을 확인할 때 거절된 로컬 요청만 해제한다. 조회가 지연·실패하거나 case가 남으면 잠금을 유지한다. 새 제어에는 사용자의 재적용과 새 요청 ID가 필요하다. 이미 관측된 원본 명령 case도 권한 있는 원본 ID exact-filter 재조회에서 사라진 경우에만 해당 브라우저의 case 잠금 표시를 해제한다. 처음부터 빈 case 목록·상세 404·조회 실패만으로는 해제하지 않는다. 동일 현장에서 배경 재조회가 401/403이면 캐시된 이력/case/승인 동작을 숨긴다. 해소된 case는 사용자·현장 범위의 최근 case ID로 다시 조회해 서버의 최소 결과(`적용됨`/`미적용`/`일부 적용`, 대상 수, 확인 시각)만 보여주며, case 부재를 적용 성공으로 추정하거나 미적용·일부 적용을 자동 재전송하지 않는다. Web mock Vitest·Chromium software 검증 범위이며 실제 Gateway/조명 동작 증거는 아니다.
- 2026-09-25 게이트웨이 재위촉 차단 응답: 새 수동 Set이 HTTP 409 `gateway_recommission_in_progress`로 거절되면 서버가 기존 요청 ID 조회를 먼저 수행하고 새 Command를 생성하지 않았으므로, UI는 저장된 미전송 요청을 정리하고 별도 재위촉 안내를 표시한다. 같은 ID의 “동일 요청 확인” 버튼이나 미확정 명령 잠금을 남기지 않는다. 재위촉 완료 뒤 다시 제어하려면 사용자가 적용을 명시적으로 눌러 새 요청 ID를 발급해야 한다. 이 예외는 dimming POST에만 적용하며 알 수 없는 409·확인 필요 case의 안전 잠금은 유지한다. Web 단위 회귀 검증 범위이고 실제 재위촉 Gateway/조명 HIL은 별도다.
- 2026-09-25 Final Atlas 수동 제어 Task 1–2: 지도 툴바에 기존 구역 관리/조회 진입점을 한 번만 배치하고, 개별·층·구역 선택과 지도 이동·영역 선택, 조명 목록의 검색·상태/층 필터·100건씩 더 보기·제어 불가 사유를 유지한다. 조명 목록은 공통 오른쪽 drawer(최대 440px, 모바일 전체 폭)로 열고 닫기/완료 뒤 목록 opener로 포커스를 돌린다. 수동 화면에서만 지도 안의 중복 선택 요약을 숨기고, 실행 패널에 선택 수량 한 곳과 별도 차단 경고를 배치했다. PC는 지도와 약 350px 실행 패널, 모바일은 지도→실행→이력의 자연스러운 읽기 순서이며 `01/02` 중복 제목과 고정 하단 실행 시트를 제거했다. 명령 생성·멱등 ID·잠금·상태 조회·응답 불명/일부 적용/재확인 handler와 조명 1,000개·단일 Gateway 제한은 변경하지 않았다. focused Vitest는 통과했으며 실제 반응형 브라우저·Gateway HIL은 통합 검증이 남아 있다.
- 2026-09-25 Final Atlas 자동화 목록 UI: 스케줄·차량 이벤트 양쪽에서 공통 이름 검색(리터럴 부분 일치), 활성/Gateway 동기화 상태 필터, 10·20·50·100건 페이지 크기와 서버 cursor 이전/다음 이동을 제공한다. 조건·사용자·현장 전환 시 첫 페이지로 돌아가며, `filteredTotal`은 조건 전체 결과 수, `siteSummary.ruleCount`와 `syncRuleCounts`는 필터 없는 현장 전체 규칙·Gateway 상태별 규칙 수로 구분한다. 3초 갱신은 현재 보이는 cursor 페이지 하나만 조회하고 A→B→A 범위 전환에서 오래된 응답을 버린다. 구 API 응답에 새 필드가 없으면 전체 Gateway 수를 추정하지 않고 로드된 행 기준으로 명시한다. 기존 추가·수정·삭제·활성 전환과 권한·인증 차단은 유지하며, Chromium mock은 실제 Gateway/조명 HIL 증거가 아니다.
- 2026-09-24 제어 세션 상태는 사용자·현장 범위의 공통 상태 센터에 모인다. 스케줄·차량 이벤트 목록의 기존 페이지를 유지한 백그라운드 재조회 실패와 다음 페이지 실패는 본문을 막지 않는 별도 항목으로 표시하고, 각각 `상태 다시 조회`와 `다음 페이지 다시 시도`를 제공한다. 다음 페이지가 성공해도 이전 페이지의 재조회 실패는 실제 재조회 성공 전까지 남으며, 실패한 cursor가 갱신으로 사라지면 동작할 수 없는 재시도 항목도 해제한다. `마지막 성공`은 현재 사용자·현장 범위에서 실제 최초/전체 목록 조회가 성공한 시각을 현장 시간대로 표시한다. 다음 페이지 성공이나 수동 캐시 쓰기로 갱신하지 않으며, 사용자·현장 전환 또는 401 차단 뒤에는 새 전체 목록 조회가 성공하기 전까지 이전 시각을 표시하지 않는다.
- 활성화/비활성화 실패는 규칙별 독립 항목으로 이름과 함께 표시한다. 새 규칙 추가·다른 규칙 편집을 열거나 다른 규칙의 저장·토글·삭제가 성공해도 기존 실패는 남는다. 해당 규칙의 토글 또는 삭제가 현재 사용자·현장 범위에서 성공했을 때만 그 규칙의 실패를 해제하며, 삭제 실패 중에는 유지한다. 사용자·현장 범위 종료·401 차단에서도 해제한다. 같은 규칙의 같은 실패 toast는 재시도 중에도 반복 발행하지 않으며, 서로 다른 규칙의 같은 오류는 각각 유지한다. 성공은 짧은 toast로 알리고, 추가/수정·삭제 오류는 해당 dialog 문맥에 남긴다. viewer는 읽기 전용의 중립 badge만 보고 관리 동작은 사용할 수 없다. 최초 목록 조회 실패·인증 차단은 기존 본문 복구 표시를 유지하며, 캐시 목록에서 401이 나면 행과 열린 편집·삭제 dialog도 닫아 조작을 차단한다.
- 수동 명령의 전송·진행·상태 조회 실패, 응답 ID 불일치, `unknown`, 일부 적용 등 확인이 필요한 결과도 같은 상태 센터에 표시한다. 센터의 동작은 수동 제어 탭으로만 안전하게 돌아가며 명령 전송, 상태 확인 또는 재적용을 대신 실행하지 않는다. 실제 조회 재시도, 조명별 결과 확인 및 미적용 확인 후 재적용은 실행 패널의 `최근 결과`에서 수행한다. 현장·사용자 전환 뒤 이전 요청의 상태와 늦은 응답·toast는 새 범위에 넘어가지 않는다. 이 연계는 focused Vitest 소프트웨어 검증 범위이며 브라우저 E2E나 실제 Gateway/조명 HIL 통과로 간주하지 않는다.

- 2026-09-24 당시 수동 제어 화면은 `01 / 제어 대상 → 02 / 밝기 실행 → 03 / 최근 결과` 순서와 compact 고정 시트를 사용했다. 이 배치는 위 2026-09-25 Atlas 작업에서 지도→실행의 자연 흐름과 제목 없는 단일 실행 패널로 대체했다. 기술 전송 방식은 사용자 선택이나 실행 조건이 아니므로 고객 화면의 전면 문구에서 제거했고, 실제 명령의 전송 방식 결정과 기존 명령 잠금·멱등 요청·ACK·`unknown`·`verified_not_applied` 후속 조치 계약은 유지한다. 차량 이벤트 추가·수정도 `01 감지 센서 → 02 실행 조명 → 03 동작 설정`과 실행 요약으로 선택 순서를 명확히 하되 verified capability·동일 Gateway·감지 센서 변경 시 실행 대상 해제와 기존 payload를 유지한다. 760px 이하 스케줄·이벤트 규칙 목록은 가로 스크롤 표 대신 공통 카드로 표시한다. 스케줄 카드는 이름·활성·적용 기간·다음 실행·반복/시간·밝기·대상 수·Gateway 동기화·최근 결과를, 이벤트 카드는 이름·활성·감지 센서/제어 조명 수·밝기·유지 시간·Gateway 동기화·최근 감지를 표시하며 관리 권한의 기존 동작 버튼을 유지한다. PC는 기존 표, viewer는 읽기 전용을 유지한다. 당시 변경은 focused Vitest 범위였으며 390/320px 카드 조작·overflow와 PC 표를 확인하는 브라우저 E2E assertion은 작성만 하고 공유 checkout에서 실행하지 않았다. 실제 모바일 WebView·Gateway/조명 HIL 증거도 아니다.

- 2026-09-24 스케줄 추가·수정의 적용 시작일·종료일을 접힌 세부 설정에서 기본 `언제 켤까요?` 영역으로 옮겨, 반복 프리셋과 기간을 함께 확인할 수 있다. 새 스케줄은 기존처럼 현장 시간대의 오늘이 시작일과 종료일이며, 같은 날짜일 때 `오늘만 적용` 또는 선택한 날짜의 하루만 적용된다는 안내와 요약을 표시한다. 여러 날짜를 지정하면 요약에 양끝 날짜를 표시하고 종료일 이후에는 반복되지 않음을 안내한다. 날짜 검증·현장 시간대 ISO 변환·fixture snapshot·Gateway sync와 서버 payload는 바꾸지 않았다. focused Vitest 검증 범위이며 브라우저/실장비 HIL 검증은 총괄 통합 게이트와 별도 장비 절차를 기다린다.

- 2026-09-15 BIO 센서 shadow 캡처와 오프라인 분석은 opt-in 소프트웨어 경로로 구현했다. 기존 Gateway USB 소유자에서 허용된 비동기 패킷만 JSONL evidence로 기록하고 분석 결과도 production 활성화를 허용하지 않는다. 물리 센서 10회 HIL과 이벤트 제어 검증은 아직 실행하지 않았다. 운영 순서는 [BIO 센서 shadow 캡처 runbook](../runbooks/raspberry-pi-gateway-appliance.md#bio-센서-shadow-캡처)을 따른다.

- 2026-09-21 제어 대상 지도는 모니터링과 같은 공통 `FloorMapViewport`의 coalesced pointer camera를 사용한다. 핀치 중 React parent를 매 프레임 갱신하지 않으며 종료 시 한 번만 zoom을 동기화한다. 실제 모바일 WebView 성능 계측은 보류다.
- 제어 대상 CAD 지도도 새 raster가 준비되기 전 마지막 완성 raster를 유지하므로, 느린 타일 decode 또는 취소로 선택 대상 지도가 빈 상태가 되지 않는다.
- 2026-09-19 공통 맵 표면은 설정에서 적용한 네이티브 CAD를 읽기 전용 Pixi 타일로 합성하고 수동 도형·조명 선택 오버레이와 카메라를 동기화한다. 최대 32,768 논리 맵에서도 전체 논리 크기의 canvas를 할당하지 않는다. 기존 제어 권한, 대상 선택 및 MQTT/장비 명령 계약은 변경하지 않았으며 이번 CAD 검증은 실장비 제어 HIL을 대신하지 않는다.
- 2026-09-18 모니터링의 수동 읽기 전용 확인에서 fresh Gateway의 두 번 연속 검증된 조명 실패가 수신되면 `Fixture.lastUnreachableAt`과 운영 `offline/fixture_stale`을 저장해 기본 20분 stale 대기 없이 제어를 차단한다. Gateway/MQTT 자체 실패는 개별 조명의 unreachable 증거로 쓰지 않는다. 확인 작업은 밝기 제어 Command/이력을 만들거나 밝기·전원·BIO mode를 바꾸지 않는다.
- 2026-09-27 제어 API 읽기 계약: `GET /commands/requiring-verification`와 `GET /commands/requiring-verification/:caseId`는 현장 read 권한으로 확인 필요 case의 최소 정보만 제공한다. 목록 cursor는 사용자·현장·원본 명령 필터에 묶이고, 상세의 대상 ID는 권한 확인 후에만 제공한다. 원본 명령이 없고 접근 가능한 미해결 hold가 있으면 내용 없는 410, 외부 현장·없는 원본은 같은 404다. 이는 임시 PostgreSQL·단위 테스트의 소프트웨어 검증이며 case 상태 확인/위험 승인 POST를 등록하거나 Gateway Get/Set을 발행하지 않는다. 일반 명령 이력의 UTC 3 calendar months 조회 제한은 `COMMAND_HISTORY_RETENTION_ENABLED=1`만으로 동작하되 기본 OFF이고 운영 Compose preflight는 DB readiness 증거 연결 전 ON을 거부한다. 운영 purge·복구 POST·실장비 HIL은 미완료다.
- 일반 명령 이력 GET은 현장 read 인가 후 같은 짧은 DB 트랜잭션의 `transaction_timestamp() AT TIME ZONE 'UTC'`와 UTC 3 calendar months cutoff를 목록/상세·cursor 400·`generatedAt`/`retainedFrom`에 공통 사용한다. 정확한 cutoff는 포함하고 이전 행만 숨긴다. 오래된 기존 `clientRequestId`의 Set 재시도도 같은 DB cutoff로 내용 없는 409를 반환하며 새 Set/outbox를 만들지 않는다. 미해결 원본 한 건 때문에 현장 전체가 legacy 목록으로 되돌아가지 않는다. 별도 읽기 전용 preflight가 cutoff 이전의 hold 없는 pending/unknown을 검사하고, 양수·DB 오류면 활성화를 거부한다. 플래그 OFF에서는 기존 조회와 추가 DB-clock 질의 0건을 유지한다. 일회용 PostgreSQL에서 host ±60초 및 UTC·Seoul·New York 세션을 검증했으나 운영 Compose의 flag는 기본 OFF/활성화 거부이며 운영 DB, 원본 삭제, 복구 POST, Gateway HIL은 적용하지 않았다.
- 2026-09-27 제어 명령 API 캐시 보완: 인증된 일반 명령 이력·상세와 확인 필요 case 목록·상세의 GET HTTP 응답에 `Cache-Control: private, no-store`를 지정한다. 이력 만료 410도 같은 헤더를 반환한다. 실제 Nest HTTP 회귀 테스트로 확인했으며 서버 권한, 복구 POST 미등록 및 보관 기능 OFF 상태는 바꾸지 않았다.
- 수동 unreachable보다 더 최신의 수락 presence/state가 도착하면 `lastUnreachableAt`을 해제하고 freshness 차단을 복구한다. 늦은 이전 실패는 더 최신 성공 관측을 덮지 않는다. 생존 presence만으로 실제 Health fault·`command_failed`·등록 대기를 지우지 않으며 BIO sensor 설정 밝기를 실제 출력으로 추정하지 않는다.
- BlueZ D-Bus Send timeout은 Gateway 전송 실패이므로 조명 unreachable이나 제어 차단을 만들지 않는다. 요청 보존기간 뒤 요청/batch 모두 삭제된 correlated 결과는 상태 변경 없이 폐기 ACK만 반환하며, 오래된 재전송으로 밝기·전원·에너지나 제어 가능성을 바꾸지 않는다. 이후 정상 비연관 presence/state는 기존 수집·복구 규칙을 따른다.

- 2026-09-17 최종 지도 선택 보완: 스케줄·이벤트의 지도 단계와 구역 편집은 명시적인 반응형 너비와 제한된 높이를 공유하며, 데스크톱 지도 행이 남은 높이를 사용한다. 스케줄·이벤트는 빈 선택·잘못된 선택에서도 `설정으로 돌아가기`로 초안을 보존하고 원래 선택 버튼에 포커스를 돌려준다. 대시보드 갱신으로 없어진 직접 선택은 `선택 비우기`로 복구할 수 있다. 스케줄은 최종 저장에서도 최신 직접 fixture 스냅샷의 제어 가능 여부·단일 Gateway를 재검증하고 대상 필드로 오류/포커스를 돌린다. 기존 구역 편집과 빈 구역의 경계 변경은 해당 층 도면으로 이동하며 구역 이름 입력은 16px이다.
- 저장 구역 편집기는 390×660·320×740 compact 화면에서도 지도 선택 영역을 최소 높이로 유지하고 dialog 내부 폼이 스크롤을 소유한다. 기존 100개 구성원을 모두 제거하는 경우 추가·제거 예정 목록은 별도 제한 높이 영역에서 스크롤하므로 지도·toolbar를 0px로 축소하거나 가리지 않는다. compact 신규 구역의 실제 marker 선택과 데스크톱 100개 변경 목록·재선택을 Chromium 회귀로 검증한다.
- compact 수동 제어는 접힌 상태에서도 선택 수·상태·16px 밝기 수치 입력·적용 버튼을 하단 내비게이션 위에 유지한다. 펼친 밝기 프리셋·슬라이더·진행/복구 상세만 제한된 높이 안에서 스크롤한다. 본문은 실제 시트 높이와 셸 위치를 반영한 별도 스크롤 영역을 사용해 지도·목록 버튼이 고정 시트 아래에 가려지지 않게 한다. 선택 수는 한 곳의 polite live region으로 알리고, 선택 불가 후보의 정적 사유에는 alert를 쓰지 않는다. 층·구역의 구성원 목록은 읽기 전용으로 표시하며 직접 선택 전환 방법을 안내한다. Gateway·감지 capability·구역 경계 제한은 지도와 목록에서 같은 정책 사유를 제공한다.
- 공통 pinch는 시작 시 지도 좌표를 현재 두 손가락 중점 아래에 유지하므로 비대칭 확대와 두 손가락 이동을 함께 지원한다. 48px coarse marker의 중심은 도면 가장자리에서 반지름만큼 안쪽으로 제한해 실제 44px 이상 터치 영역을 보존한다. 이 보완은 실제 viewport 좌표·pointer buttons를 사용하는 Chromium 및 단위 회귀 범위이며 native WebView·물리 조명 HIL 증거가 아니다.

- 2026-09-17 제어 대상 선택은 수동 명령, 스케줄, 차량 감지 이벤트, 저장 구역 관리에서 공통 `SpatialTargetSelector`/`FixtureGroupMapEditor`의 지도 우선 흐름으로 통합했다. 지도에 배치되지 않았거나 도면을 읽을 수 없는 조명은 보조 목록 drawer로 선택할 수 있다. 지도는 이동·개별 선택·영역 선택 모든 모드에서 두 손가락 pinch를 우선 처리하고, wheel 확대·내부 pan/scroll은 viewport 안에 한정한다. marker는 시각 dot과 독립된 44px coarse hit target을 쓰며, pointer capture는 지도 밖 drag를 유지하되 marker button의 native click은 단일 선택으로 그대로 전달한다. 수동 개별 선택은 첫 조명의 단일 Gateway 및 최대 1,000개를, 저장 구역 멤버십은 단일 floor/Gateway·1~100개를 강제한다. compact 화면은 선택 요약을 펼쳐 밝기·실행·진행/복구를 한 흐름에서 제공하고, drawer·지도 detail·실행/이력은 모두 bounded internal scroll을 사용한다. compact 수치 입력은 16px, preset/action은 44px 이상(현재 preset 52px)이다.

- 2026-09-17 지도 제어 브라우저 검증에서 compact 밝기 수치 입력을 16px로, 프리셋 버튼을 높이 52px로 보완했다. 둥근 모서리를 제외해도 44×44px 터치 영역을 확보한다. 조명 목록 drawer는 PC에서도 높이를 제한하고 목록 자체를 스크롤하며, 내부 native checkbox 입력의 위치 기준을 목록으로 고정해 마지막 행 선택 시 overlay가 화면 밖으로 밀리지 않게 했다. 1024px의 100→121개 목록 확장·마지막 행 선택, 1440/1024px의 실제 지도·이력·구역 내부 휠 스크롤, 390/320px의 펼친 실행 영역·drawer 터치 영역과 입력 글꼴을 Chromium으로 검증한다. 이는 브라우저 회귀 범위이며 실제 WebView 터치·하드웨어 HIL 검증은 아니다.

- 2026-09-17 저장 구역 생성·수정의 조명 멤버십 편집을 지도 우선 `FixtureGroupMapEditor`로 교체했다. 첫 조명 선택은 같은 floor·Gateway 경계를 잠그며, 모두 제거해도 기존 구역의 경계는 자동으로 이동하지 않고 명시적인 경계 선택으로만 바뀐다. 지도 marker와 보조 목록 drawer는 같은 `SpatialTargetSelector` 상태를 공유하므로 미배치 조명도 목록에서 선택할 수 있다. 저장은 기존 생성/수정 mutation에 1~100개 unique fixture의 전체 교체 set만 전달하며, 편집 중 추가·제거 예정 멤버를 텍스트로 표시한다. 저장 전에는 `저장 후 Mesh 설정 중`을 안내하고 저장 응답의 `configuring` 상태는 `Mesh 설정 중`으로 표시한다. 경계 polygon은 저장하거나 렌더링하지 않는다. 카드·삭제 확인·재동기화·viewer 읽기 전용·cache/focus 계약은 유지했고, 모바일 44px marker/action, 16px field 및 내부 overflow는 공통 selector 정책을 따른다. 이는 Vitest UI 회귀 증거이며 실제 Mesh/조명 HIL 완료를 뜻하지 않는다.

- 2026-09-17 차량 감지 이벤트 추가·수정은 감지 센서와 실행 조명을 각각 지도 우선 `SpatialTargetSelector` 단계에서 선택한다. 감지 센서는 capability가 검증된 fixture 직접 선택만 허용하고, 지원하지 않는 센서는 지도에 `선택 불가`로 보인다. 새 이벤트에서는 적격 감지 센서의 단일 Gateway가 정해지기 전 실행 조명 선택 action을 비활성화하고 이유를 안내한다. 실행 조명은 감지 센서의 단일 Gateway로 제한한 개별·층·저장 구역 선택을 제공하며, 층·구역은 완료 시 정렬된 fixture ID 스냅샷으로 기존 이벤트 payload에 저장한다. 이후 멤버십 변경은 저장된 이벤트를 바꾸지 않고 API 재편집은 직접 fixture 스냅샷으로 시작한다. 감지 Gateway를 바꾸면 호환되지 않는 실행 대상은 비워 저장을 차단한다. 기존 validation/server error focus, 권한·pending lock, 밝기/디밍/유지 시간과 `VehicleEventRuleSnapshotV1` 계약은 유지한다. 지도 view와 목록 drawer는 compact bounded overflow, 44px action/marker, 16px field 정책을 따른다. Vitest 지도 선택·form·presenter·panel 41개는 Web UI 회귀 증거이며 실제 Mesh/조명 HIL은 아니다.

- 2026-09-17 스케줄 추가·수정의 전용 대상 선택 view를 지도 우선 `SpatialTargetSelector`로 교체했다. 개별 marker·목록 drawer·층 전체·저장 구역은 공통 단일 gateway/Mesh readiness 정책을 그대로 따르며, 층·구역을 고르면 그 시점의 fixture ID를 스케줄 payload에 스냅샷으로 저장한다. 따라서 뒤의 그룹 멤버십 변경은 기존 스케줄을 바꾸지 않고, API에서 다시 불러온 스케줄은 직접 fixture 스냅샷으로 표시한다. 대상 검증 focus, schedule overlap·고급 반복·현장 시간대, 권한/submit lock과 API schema는 유지한다. compact 대상 view와 보조 목록 drawer는 bounded full-screen content, 44px action과 16px field 계약을 따른다. 관련 Vitest schedule/contract 55개를 통과했으며 이는 브라우저 회귀 증거로 실제 Mesh/조명 HIL은 아니다.

- 2026-09-17 수동 제어는 지도 우선 `SpatialTargetSelector`로 개별·다중·층·저장 구역을 선택하고, 목록은 보조 drawer로 연다. 선택은 최대 1,000개 및 첫 개별 조명의 단일 gateway 조건을 유지하며, 실행 payload·명령 잠금·재시도·상태 확인 계약은 변경하지 않았다. PC는 지도/실행/이력 영역을 각각 bounded overflow로 유지하고, compact 화면에서는 대상 요약을 펼쳐 consumer-owned 밝기·적용 실행·명령 진행·후속 조치·동일 요청 재시도·상태 다시 조회 UI를 확인한 뒤 접힌 명령 이력으로 이동한다. 불가한 층·구역과 drawer 조명은 Mesh/Health 차단 사유를 보이며 viewer와 명령 잠금 상태에서는 marker·목록·밝기 입력을 모두 비활성화한다.

- 2026-09-16 Tailwind Task 12에서 공통 primitive와 수동·스케줄·이벤트 제어 화면의 legacy class/CSS adapter를 제거하고 의미 토큰·utility 및 `data-*` 테스트 계약으로 수렴했다. `Button`의 공개 `data-variant` 계약으로 제어 E2E가 시각 variant를 class 이름에 결합하지 않게 했고 정책 baseline은 빈 violation map을 사용한다. Fresh Web **1,224/1,224**, UI policy **53/53**, 전체 Chromium 직렬 **257 passed·5 환경 의존 skip·실패 0**, 별도 opt-in RealBackendLab 설치·제어 흐름 **3/3**을 통과했다. 실제 iOS/Android WebView와 MQTT/Gateway/Raspberry Pi/ESP32-H2 HIL은 실행하지 않았다.

- 2026-09-16 공통 셸·인증 UI 이전에서 제어 진입 셸의 내비게이션, 현장 배지, 로딩·복구 상태와 로그아웃을 Tailwind 의미 토큰 및 공통 `Heading`/`Text`/`FeedbackState`/`ConfirmDialog`로 통합했다. 로그아웃 중에는 기존 active-command 차단을 유지하고, 저장하지 않은 맵 편집 내용의 폐기 승인이 끝나기 전에는 session을 종료하지 않는다. 관련 Vitest 157개와 320/390/1024/1440px Chromium 셸·인증·복구 시나리오 19개로 검증했으며, 이는 mock API 기반 browser 회귀로 실제 Gateway 명령·BLE Mesh·조명 실장비 HIL 완료를 뜻하지 않는다.
- 수동·스케줄·이벤트 제어의 폼과 dialog를 공통 디자인 시스템으로 통일했다. 검색·선택·체크박스·밝기 입력·날짜·시간·확인 dialog는 공통 컴포넌트를 사용하고, 기존 API payload와 숫자 문자열 변환·검증 계약은 유지한다. 수동 제어는 PC 셸의 남은 높이 안에서 조명 목록·명령 이력·실행 body·결과 feedback 영역이 각각 내부 스크롤하며 선택 피드백이 추가돼도 대상·실행 UI가 겹치거나 밀리지 않는다. 공통 Modal의 focus trap·Escape·중첩 확인 dialog·호출 버튼 focus 복귀를 적용했고, Chromium에서 실제 사용자가 보는 체크박스 라벨을 클릭하는 경로까지 검증했다.

- 기존 published 수동 payload를 재처리할 때 `deliveryGeneration`, `deliveryGeneratedAt`, `deliveryWindowMs`, `expiresAt`을 보존하고 구 수동 종료·requester 필드만 영속적으로 제거한다. PUBACK 유실·재시작으로 배달 기한이 늘어나지 않는다. Gateway는 하드웨어 성공 시점의 활성 schedule occurrence·차량 activation 식별자를 terminal journal에 함께 저장해 UTC rollback 직후 crash에서도 현재 source 억제를 복구한다. 다음 occurrence·새 activation은 정확한 식별자 비교로 재개하며, 문맥이 없는 구 journal은 기존 UTC 기반 복구를 유지한다. 이 보완은 software 회귀 범위이며 실장비 HIL 증거는 아니다.

- 수동 기본 밝기 software E2E는 2026-09-15 RealBackendLab **1/1 passed (59.2초, body 32.1초)**, 실패·skip 0으로 확인했다. 현재 schedule/event 억제, 새 event와 다음 daily occurrence의 재개 및 각각 60% 복귀, 삭제·재연결·API 재시작을 검증했고 production execution/ACK/DB 각 19건·telemetry outbox 0/gap false가 일치했다. Lab support 14/14와 Web typecheck도 통과했다. 기본 포트 충돌 첫 실행은 시나리오 미실행이며 격리 포트 재실행 결과와 구분한다. 이번 기본 밝기 release의 사용자 DB 적용·운영 배포·Pi/BIO/BlueZ/ESP32-H2 HIL은 미실행이다.

- BIO direct-USB 제어를 Gateway의 실제 adapter로 연결했다. `GATEWAY_ADAPTER=bio-usb`는 제조사 앱·휴대전화·BlueZ 없이 USB 동글을 직접 열고, 확정된 BIO UUID↔주소 mapping만 개별 제어에 사용한다. 밝기/모드 SET 뒤 UUID·주소가 일치하는 GET report를 다시 확인해야 성공으로 판정하며, mode가 없거나 `sensor`이거나 table 밖 raw 값이면 요청값을 실제 상태로 추정하지 않는다. 프로세스 종료 시에는 MQTT 입력을 먼저 막고 runtime drain, USB polling 중지, interface release, 필요 시 kernel driver 재연결을 순서대로 기다린다. 전용 BIO 컨테이너는 UID 999, capability 0, exact USB 하나만 사용하고 D-Bus/HCI/BlueZ 권한을 받지 않는다. 2026-09-14 admin4 단일 장치 HIL에서 약 2초 점등과 sensor 복귀, 동일 장치 주소 `0x5fe4 → 0x0100` 1회 변경, 새 주소 재발견과 confirmed mapping, 서비스 수동 밝기 제어를 확인했다. 등록 직후 BIO Fixture를 해당 hardware-confirmed terminal 근거로 online 처리하되 센서 모드 밝기·전원은 추정하지 않는 API 보완도 유지한다.
- BIO 스케줄 엔진은 일반 Gateway와 같은 clock-trust 계약을 사용한다. BIO 전용 Compose는 호스트 `/run/systemd/timesync` 디렉터리만 동일 경로에 read-only bind하고 전체 `/run/systemd`는 노출하지 않는다. 이 mount가 없거나 `synchronized` 표식이 없으면 현재 시간이 맞아 보여도 새 스케줄 시작을 fail-closed하는 것이 정상이다. 2026-09-14 스케줄 미실행 원인은 BIO Compose의 해당 mount 누락으로 확인해 회귀 테스트와 설정을 보완했다. Raspberry Pi에 commit `03071d55` 기반 ARM64 image를 배포한 뒤 23:10~23:11 Asia/Seoul 경계 HIL에서 revision 5 스케줄의 70% 시작과 기존 0% 복귀를 모두 BIO SET/GET read-back `succeeded`로 확인했고, API에는 `schedule_started → action_result(70%) → schedule_ended → action_result(0%)` 네 실행 이벤트가 저장됐다. 이는 구 timed manual release의 기록이다. 현재 기본 밝기 release의 Pi/BIO HIL은 별도 미실행이며, 수동 성공 당시 occurrence만 억제되고 다음 새 occurrence는 재개한다.
- BIO 층·구역 제어는 native BLE Mesh group subscription 대신 Gateway의 local virtual membership과 최대 4개 bounded unicast를 사용한다. API의 MeshNode ID와 BIO 등록 mapping의 Fixture ID는 서로 다른 ID 공간이므로 같다고 비교하지 않는다. 양쪽이 공통으로 가진 confirmed logical address로 API member를 Fixture ID로 변환하고, 실제 제어 직전 요청 Fixture가 virtual membership에 포함되는지 다시 확인한다. 따라서 미확정 주소와 다른 Fixture 요청은 RF 전송 전에 실패하며 별도 ID alias 테이블이나 DB migration은 필요 없다. 실제 ID가 다른 회귀 테스트를 포함한 BIO adapter 48개 software test를 통과했고 Raspberry Pi 층·구역 HIL은 진행 중이다.
- BIO의 read-only presence가 fresh해지면 freshness 때문에 생긴 offline/stale 차단만 해소할 수 있다. health fault, `command_failed`, `provisioning_waiting_state` 등 실제 fault·명령 실패·등록 대기 차단이 남아 있으면 제어 가능 상태로 복원하지 않는다. presence는 설정값/통신 생존 증거일 뿐이므로 제어 명령의 GET read-back은 계속 실제 `fixture-state`만 발행한다.

- P0/P1 상태 조회 기반 계약을 연결했다. `Command.outcome`은 과거 행을 `NULL`로 보존하고 `CommandDispatch.kind`로 dimming과 status-check를 구분한다. Status-check wire는 dispatch당 대상 1~64개이며, 원 명령의 65~1,000개 대상은 하나의 논리 시도 안에서 정렬된 여러 dispatch로 나눈다. 최대 횟수는 dispatch 수가 아니라 논리 시도 3회다. 첫 chunk만 HTTP `clientRequestId`를 소유하고 동일 ID 재요청은 해당 시도의 전체 dispatch ID를 반환한다. 사용자 DB에는 `20260912090000_command_outcome_status_check` migration을 적용하지 않았다.
- 최종 리뷰에서 BlueZ의 Lightness Status 유실을 `timed_out`으로 보정하고 API가 기존 `failed + STATUS_TIMEOUT` wire도 원문 aggregate 검증 뒤 `unknown`으로 수렴하도록 했다. Publisher는 MQTT 호출 직전 `deliveryAttemptedAt`을 commit하여 PUBACK 유실 뒤 expiry/dead-letter와 pending timeout을 `unknown`으로 닫는다. 검증 단계의 발행 전 거절만 `not_applied`이며, 늦은 확정 ACK는 보존하고 불확실 명령의 Get 허용·겹치는 Set 차단을 유지한다.
- 최종 보정 검증은 API focused 209/209·전체 1,176 passed/272 environment-gated skipped, Gateway focused 77/77·전체 625/625, Shared 200/200 및 API/Gateway typecheck/build·Prisma validate다. Web 715/715와 Chromium 21/21은 `465984c` 시점의 이전 증거이며 이번 서버/Gateway 보정에서는 재실행하지 않았다.
- API timeout worker는 예약 batch를 single-flight로 실행해 느린 DB 작업과 다음 tick이 겹치지 않게 하고, 종료 시 interval을 해제한 뒤 진행 중 batch를 drain한다. 직접 호출하는 `closeExpired()`는 오류를 호출자에게 전달하고 예약 wrapper만 정제된 Prisma code 또는 `UNEXPECTED_ERROR`를 기록한다. 발행 전 delivery timeout은 `not_applied`, 발행 뒤 acceptance/status 유실은 `unknown`이며 status-check 자체 timeout은 원 명령의 `unknown`을 덮어쓰지 않는다.
- Gateway status-check는 durable command journal에 acceptance receipt를 먼저 저장한 뒤 Generic OnOff/Lightness Get을 실행한다. 같은 MQTT 명령의 live duplicate는 진행 중 Get과 receipt를 공유하고, 완료 duplicate는 journal 결과를 재사용한다. acceptance-only 재시작 복구는 Set이나 Get을 자동 재실행하지 않고 indeterminate 결과로 닫는다. API는 device-status ACK의 `eventId`와 canonical payload hash를 `ProcessedGatewayEvent`에 함께 기록해 exact duplicate를 무시하고 identity/hash 충돌 payload로 상태를 다시 바꾸지 않는다.
- 수동 제어의 `CommandHistoryPanel`은 사용자·현장 범위의 최근 명령, 300ms 검색, 단계 필터와 cursor 더 보기를 제공한다. 명령 행은 서버에서 상세를 새로 읽어 열고 닫은 뒤 다시 열 수 있다. 오래된 캐시의 미적용 결과로 재적용 버튼이 먼저 나타나지 않도록 상세를 재조회한다. PC에서는 대상 선택·실행 패널의 고정 배치를 유지하고 이력 목록과 상세 피드백 안에서 스크롤한다.
- `CommandOutcomeActions`는 불확정 결과에 경고·원인·시도 횟수와 “실제 상태 확인”만 제공한다. 상태 확인 중에는 제어 입력과 이력 선택을 잠그며 세 번 소진 시 현장 확인을 안내한다. HTTP 응답 유실은 동일 Get 요청 ID로 조회하고, 일반 제어 응답 유실은 “동일 요청 확인(새 제어 아님)”으로 저장된 원 요청을 재사용한다. `verified_not_applied`에서만 새 요청 ID로 원래 확정 조명 목록·밝기를 재적용하며, 층·구역의 현재 멤버나 편집 중인 선택을 재사용하지 않는다. 적용 완료는 설명만, 부분 적용은 마지막 확인의 대상별 현재값과 새 제어 안내를 제공한다. 세션 무효화·사용자/현장 전환의 요청 중단과 늦은 응답 무시는 유지한다.
- 저장된 명령 ID 복원은 과거 상세 캐시를 먼저 제거하고 새 서버 상세를 확인한 뒤 잠금을 해제한다. 상태 확인 POST의 응답·dispatch ID를 아직 받지 못했으면 상세가 이전 unknown이어도 조회를 유지한다. 로그아웃이 상태 확인 요청을 중단한 뒤 실패하면 같은 요청 ID로 복구할 수 있으며, 세 번째 시도도 새 시도를 만들지 않고 조회한다. 중단된 요청의 늦은 응답·정리 콜백은 재개한 HTTP 요청의 잠금을 해제하지 않는다.
- 차량 센서 capability는 node별 최신 revision과 event ID/hash를 영속 watermark에 보존한다. raw 원장 삭제 후 같은 revision을 다른 event로 바꾸면 mutation 없이 rejected ACK를 저장하고, exact replay는 기존 durable ACK를 재사용한다. 서로 다른 node의 같은 revision은 독립적으로 유지하며 임시 PostgreSQL에서 검증했다.
- 플랫폼 Task 4 최종 소프트웨어 검증은 root lint/typecheck/build exit 0, root script 58/58·Shared 203·Automation 28·Mobile 1·Web 64 files 712/712·API 120 suites 1,138 통과/289 환경 의존 제외·Gateway 64 files 608/608(총 2,748 통과/289 제외)다. 전체 Chromium은 194개 중 189 통과/5 opt-in 제외(188개 mock/브라우저 회귀 + 실제 disposable automation journey 1개), main 319.19 kB/gzip 99.21 kB다. Production 계약 18/18, 전체 audit의 MQTT 설정 2/2·Gateway container 24/24·required MQTT 2/2와 새 smoke `led-production-smoke-a9dac54a523c9484dbc4b9eade7b9d5e`의 당시 브랜치 빈 DB 57/57 migrations, TLS/mTLS·CRL·장애 복구·exact cleanup을 통과했다. Dependency 820개 중 기존 승인 예외 High 2/Moderate 1, unexpected 0이며 무취약 판정이 아니다. 운영 배포·사용자 DB·실제 외부 Vault/MQTT/Object Storage·native WebView·HIL·외부 관측 연결은 미검증이다. [운영 runbook](../runbooks/production-api-web-deployment.md)에 절차와 한계를 기록했다. 최종 독립 검토는 Critical/Important/Minor 0, PASS로 승인됐다.

- 플랫폼 Task 3에서 공통 앱 셸 복구를 구현했다. 초기 인증 401은 기존 로그인, 403과 그 밖의 비일시 오류는 권한·재로그인 안내로 분기한다. 브라우저가 부팅부터 offline이면 요청 없이 서비스 복구 화면을 표시하고 online 복귀 시 인증을 재개한다. 네트워크·전송 timeout·5xx는 자동 최대 2회 재시도하고 실패하면 `다시 시도`로 연결을 복구한다. `AppRoot`의 boundary는 App 자체의 hook/render와 Router/lazy shell 실패를 단일 main·alert·포커스 heading으로 표시한다. 인증 실패·재로그인·principal 전환 시 새 QueryClient를 먼저 활성화해 늦은 이전 mutation callback을 폐기된 client에 격리한다. 재로그인은 앱 active-command namespace와 tenant/auth 캐시·초안을 정리하고 최대 5초 logout 종료 뒤 로그인으로 수렴한다. 무관한 저장값과 최초 정상 부팅의 제어 복구 기록은 유지하며 원시 오류/응답/stack은 표시하지 않는다. Task 3 Web 64 files·712/712 unit, 관련 auth/shell Chromium 23/23(신규 복구 10개 포함), typecheck/build와 main `319.19 kB`/gzip `99.21 kB` bundle audit를 통과했다.

- Route 기능 코드 SHA `34261b6`에서 로그인·최초 비밀번호 변경은 초기 main에 유지하고 고객/운영자 shell과 제어 화면을 dynamic chunk로 분리했다. 역할 shell 전체 화면과 shell 내부 route는 공통 `RouteLoadingState`의 `role="status"`·`aria-live="polite"` 로딩 상태를 사용한다. 별도 Web route bundle 작업 당시 Task 4 Web 검증은 60 files·686/686 unit, 2,437 modules production build와 main `314.83 kB`/gzip `97.58 kB`(예산 `1,070.00 kB`/`325.00 kB`)를 통과했고, 14개 계획 route chunk와 main의 Konva·Recharts 격리를 audit으로 확인했다. 같은 별도 작업 당시 Task 3 Chromium 64/64는 1440/1024/760/390/320px에서 제어를 포함한 대표 route 전환을, disposable RealBackendLab 2/2는 실제 API/DB 기반 고객 여정을 검증했다.
- 공통 고객 셸 상단은 현재 메뉴 제목과 실제 현장명 배지만 표시한다. 기존 층명 기반 `B2 주차장` 표기와 동작 없는 Gateway 정상·오프라인·미등록 상태 배지는 제거하되 설정의 `Gateway 상태` 상세 카드는 유지한다. 로그아웃 위치와 인증·dirty editor 확인 로직은 유지하고, 고객·운영자 셸의 로그아웃은 공통 `IconTooltipButton`으로 아이콘만 표시한다. `로그아웃` 도움말은 hover와 키보드 focus에서 열리고 도움말 위로 포인터를 옮겨도 유지되며 `Escape`로 닫힌다. 모바일 버튼은 52px 실제 터치 영역을 사용한다.
- 수동·스케줄·이벤트 제어 탭을 통계 상단 메뉴와 같은 밑줄형 공통 `UnderlineNavigation`으로 통일했다. 탭 아이콘은 공통 label의 선택 옵션으로 제공해 제어의 기존 아이콘은 유지하고, 활성 밑줄·색상·44px 높이·가로 스크롤 동작은 통계와 공유한다. 기존 `mode` query, 권한별 탭 노출, `tablist`/`tab` ARIA 연결과 방향키·Home·End roving focus는 변경하지 않았다. 390·320·760px Chromium에서 세 모드 모두 탭과 panel 사이 16px 간격, overflow 내부 focus ring과 document 가로 overflow 부재를 확인했다.
- 현장 capability를 시스템 role과 분리했다. `read` 일반 유저는 제어 메뉴와 `/control` 직접 진입이 차단되고 수동 제어 API도 `403`이다. `control` 일반 유저는 모니터링·통계와 수동 제어만 사용할 수 있으며 `mode=schedule|event` 직접 URL은 `manual`로 replace된다. admin은 수동·스케줄·이벤트 전체를 사용한다. mock Chromium E2E에서 세 권한의 메뉴·직접 route와 수동 명령 API 허용/거절을 검증했으며, 이는 실제 Gateway/BLE Mesh HIL 증거가 아니다.

- 수동 밝기 제어의 오른쪽 실행 영역은 공통 `SidePanel`과 `ui-side-panel-layout`을 사용한다. 데스크톱에서는 280~340px 범위의 안전한 패널 폭을 확보하고 긴 대상명과 상태 문구를 패널 안에서 줄바꿈하며, 높이가 제한되면 패널 내부만 세로 스크롤한다. 1120px 이하에서는 대상 선택 다음 한 열로 쌓아 화면 밖 잘림을 막는다.

- 에디터의 식별 명령은 일반 밝기 제어와 별도 Health Attention 경로로 처리한다. 10초 식별 중에도 일반 수동·스케줄·이벤트 목표는 유지하고 종료 시 최신 목표로 복귀하도록 펌웨어를 보강했다. 실제 LED 복귀 검증은 후속이며 기존 제어 명령 성공/실패나 전력 상태를 식별 응답으로 덮어쓰지 않는다.

- 에디터 배치 상태와 제어 대상을 분리했다. 조명을 미배치로 바꿔도 Fixture/Mesh ID, 그룹 멤버와 스케줄·이벤트 대상은 유지한다. 배치 해제는 실제 소등/장비 삭제 명령을 보내지 않는다. 격리 DB 관계 보존 회귀와 두 층 브라우저 E2E의 배치 해제 후 70% 명령·MQTT 결과 확인을 통과했다. RF 경계는 테스트 simulator이므로 실장비 검증으로 확대하지 않는다.

- 실장비 provisioning 직후 Gateway가 발행하는 차량 센서 capability의 `meshNodeId`는 Gateway가 알고 있는 등록 후보/Fixture 식별자일 수 있다. API는 claimed Site/Gateway 범위 안에서 실제 `MeshNode.id` 또는 연결된 `Fixture.id`를 정확히 한 건으로 해석하고, 처리 원장과 capability metadata에는 canonical `MeshNode.id`를 저장한다. 0건 또는 중복 매핑은 fail-closed하며 ACK에는 Gateway가 보낸 식별자를 그대로 반환해 durable journal correlation을 유지한다. 2026-09-03 Raspberry Pi/ESP32-H2 HIL에서 capability revision 1, Sensor Server/vendor model binding, ACK outbox 발행을 확인했다.
- Web 응답 유실 복구 저장소는 shared canonical 스키마로 target+brightness 요청 fingerprint를 검증한다. 2026-09-02에 보존하던 legacy `overrideUntil`은 현재 복구 경계에서 제거하며 수동 종료 의미를 되살리지 않는다.
- Gateway dimming command topic의 MQTT QoS 1 `PUBACK`은 command journal 수락이 완료된 뒤에만 전송한다. API도 acceptance/device-status를 포함한 non-fixture QoS 1 메시지를 Site/Gateway별 bounded queue에서 DB 반영한 뒤 `PUBACK`하며, DB 실패 시 transport를 닫아 broker persistent session의 재전달을 보존한다.
- patched BlueZ 5.82의 로컬 AppKey 생성은 provisioner keyring과 로컬 node storage/runtime을 함께 갱신한다. exact source patch dry-run, 컨테이너 계약과 ARM64 `bluetooth-meshd` compile을 통과했다. 2026-09-03 Raspberry Pi 컨테이너 cold restart 뒤 `generic:hci0` raw-HCI에서 ESP32-H2 상태 resync와 90%·20%·60% 제어/상태 응답을 실 RF로 확인했다. 40% 명령은 ESP에 적용됐지만 단일 Status 응답이 유실돼 `STATUS_TIMEOUT`으로 끝났으므로 재시도 내구성은 후속 보완 대상이다.
- 수동 명령·저장 구역의 transport 오류는 공통 표시 전용 mapper를 사용해 `Gateway ACK timeout`을 `게이트웨이 장비 응답 시간 초과`로 표시하고, 원시 command/group API 값과 protocol identifier는 유지한다. 화면 결과에는 `Gateway`/`ACK`/`timeout`이 섞인 문구를 남기지 않는다.
- 스케줄, 차량 이벤트, 저장 구역 dialog의 취소·저장 액션은 공통 `Button`을 사용한다. 기존 submit/cancel event, disabled/loading 문구, Escape·focus 복귀와 기존 CSS class 계약은 유지한다.
- 스케줄과 차량 이벤트 dialog를 `빠른 설정 + 고급 설정` 구조로 단순화했다. 스케줄은 `언제 → 제어 대상 → 밝기`, 이벤트는 `감지 센서 → 실행할 조명 → 밝기·유지 시간` 순서로 읽히며, 긴 `ControlTargetPicker` 목록은 기본 화면에서 제거하고 같은 dialog의 전용 선택 view에서만 표시한다. 매일·평일·주말·한 번, 밝기, 유지 시간 프리셋과 실시간 요약 문장을 제공한다. 스케줄 적용 시작·종료일은 기본 `언제` 영역에 항상 표시하고, 월간/연간/사용자 지정 반복·이름·디밍 사용 여부는 접힌 고급 설정에 유지한다. 기존 advanced 규칙 수정 또는 해당 validation 오류에서는 필요한 영역을 자동으로 연다. 선택 카드 설명은 한 줄 말줄임으로 제한해 capability나 상태 문구가 늘어나도 footer와 주변 UI를 밀지 않는다. Dashboard에서 삭제된 조명과 capability가 해제된 차량 센서는 `확인 필요`로 표시하고 저장 전에 재선택을 요구한다. 1024×768의 121개 조명 picker는 dialog 남은 높이 안에서 목록만 스크롤하며 `더 보기`와 마지막 행까지 도달하고, 390px/320px 기본 화면의 프리셋·선택 버튼·밝기 range는 44px touch target을 유지한다.
- PC 2열 제어 화면은 셸의 남은 높이 안에서 고정되고 조명 목록과 자동화 panel만 내부 스크롤한다. 1440×900과 1121×900 Chromium에서 조명 80개를 표시해도 document 세로 스크롤 없이 조명 목록만 스크롤함을 검증했다. 761px 이상에서는 남는 높이를 탭 행에 분배하지 않으며 1440×900, 1024×768, 761×900에서 모드 전환 뒤 탭 크기를 유지한다. 760px 이하 가로 스크롤·44px touch target 계약도 유지한다. RealBackendLab은 미배치 조명을 수동 제어 목록에서 찾아 schedule 40%·event 80%·수동 기본값 60%의 현재 source 억제와 새 실행 재개, 삭제·재연결을 검증한다. 실행 결과는 아래 기록을 따르며 software Gateway 검증을 실제 HIL로 확대하지 않는다.
- PC 수동 제어의 우측 카드는 대상명·상태 배지를 고정 헤더로 유지하고, 핵심 입력과 상태 피드백을 서로 독립된 내부 스크롤 영역으로 분리한다. 긴 한글 대상명은 `minmax(0, 1fr)` 열 안에서 말줄임한다. 1440×900, 1121×900, 1366×768 Chromium에서 정상·장애 조명을 전환해 밝기·프리셋·적용 버튼 좌표와 카드 경계, document-level 세로 overflow 부재를 검증한다. 종료 입력을 제거한 레이아웃이 현재 계약이다.
- 1440×900, 1024×768, 390×844, 320×740 Chromium route fixture에서 대상 선택·밝기 실행 패널의 1120px 스택과 document-level horizontal overflow 부재를 검증한다. 390px/320px의 공통 helper는 disabled/hidden 및 숨긴 조상을 제외하고 viewport·overflow clip과 교차하는 target의 연속 44×44px hit 영역을 검사한다. 부분·완전 occlusion은 실패하며 checkbox/radio는 associated label과 input fallback 중 유효한 후보를 사용한다. Fixed containing block을 만드는 조상이 있을 때만 fixed target에 ancestor clip을 적용하고 scrollable control/dialog는 각 target을 viewport 중앙으로 옮겨 검사한다. 현재 대상은 검색·상태/층 filter·밝기 range·프리셋·적용 버튼이며 수동 종료 입력은 없다. 스케줄·이벤트 empty list와 add dialog의 시간·요약·고급 조건·target picker, 공통 focus ring과 reduced-motion 계약을 유지한다.
- 스케줄 제어와 차량 감지 이벤트 제어 설계를 확정했다. 상세 계약은 `docs/superpowers/specs/2026-08-29-schedule-vehicle-event-control-design.md`를 따른다.
- 클라우드는 규칙 관리·배포 상태의 정본, Raspberry Pi Gateway는 무중단 hot reload와 offline 현장 실행의 정본, ESP32-H2는 3.3V Active High 마이크로웨이브 센서의 GPIO 상태 이벤트와 밝기 적용을 담당한다. High 동안 이벤트를 유지하고 Low 이후 규칙별 유지시간을 계산한다.
- shared 반복 일정 계약과 production DB schema에 이어 Task 7에서 schedule API, Task 8에서 차량 이벤트 규칙 API CRUD, exact Fixture snapshot과 full-snapshot outbox 저장을 구현했다.
- schedule/차량 이벤트 API CRUD, production API MQTT 동기화, Gateway snapshot 원자 저장/hot reload, offline scheduler·priority arbiter·재시작 복구, durable execution telemetry, Gateway BLE Mesh Sensor Client, ESP32-H2 GPIO driver와 Sensor Server/reliable vendor event model을 완료했다. Task 17~19의 Web CRUD와 software E2E에 이어 2026-09-04 단일 Raspberry Pi 4·ESP32-H2 실장비 HIL에서 admin UI 생성·수정·비활성화·삭제, config revision `1~7`의 exact `APPLIED`, schedule 시작 `70% -> 35%`와 종료 복귀 `35% -> 70%`, 차량 High `70% -> 85%`, Low 후 5초 복귀, 수정된 규칙의 High `70% -> 80%`, Low 후 6초 복귀를 확인했다. 16개 execution event와 6개 fixture action result가 모두 성공했고 Gateway config ACK·telemetry outbox는 비었다.
- Bluetooth SIG Company ID 발급 전 실장비 검증을 위해 Gateway와 ESP32-H2에 명시적 `lab-hil` 프로파일을 추가했다. 실기에서 `0xFFFF`가 BlueZ SIG 모델 내부 표식과 vendor model ID를 중복시키는 원인을 확인해 Lab 전용 비양산 RFU 값을 `0xFFFE`로 교체했다. Gateway 확인값, firmware Lab manifest와 전용 flash wrapper가 모두 맞을 때만 RF에 사용하며 production 시작·flash 경로는 계속 거부한다. 단일 ESP32-H2의 검색·provisioning·등록·재시작 복구·개별 밝기·schedule/event sensor 제어는 실 RF로 통과했으며 다중 노드, Mesh Group, packet loss와 동시 전원 차단 HIL은 남아 있다.
- Scenes 17~21의 Calm Operations 자동화 표면은 공통 `StatusBadge`와 `FeedbackState`로 목록의 활성·Gateway sync·최근 실행/감지 상태와 loading/empty/error/stale polling을 구분한다. schedule/차량 이벤트의 PC 표는 각각 접근 가능한 이름을 유지하고, 760px 이하에서는 동일 데이터와 관리 동작을 공통 카드 목록으로 표시한다. admin empty state의 추가 action, 삭제 확인, 오류별 실제 retry, viewer read-only를 유지하며 query key, bounded pagination, polling, mutation auth/cache callback과 scope generation은 변경하지 않았다. 빠른 설정 editor는 기본 화면에 프리셋·선택 요약 카드·결과 요약만 노출하고, 조건별 입력과 긴 목록은 고급 설정 및 전용 picker view로 분리하면서 기존 controlled input·검증·focus trap/return을 보존한다. 기존 `calm-operations-automation.spec.ts`의 1440×900, 1024×768, 390×844, 320×740 route fixture 검증 기록은 당시 가로 스크롤 표와 editor 흐름에 대한 증거다. 2026-09-24 카드 전환 후 390/320px 카드 정보·관리 동작·가로 overflow 부재 및 PC 표 유지 assertion은 추가했지만 이번 공유 checkout에서 실행하지 않았다. empty/error/retry action variant는 React Query retry 시간을 제한하기 위해 별도 390×844 fixture에서 실행한다. 과거 route fixture 결과와 신규 assertion 모두 UI software 범위이며 Gateway/BlueZ/Raspberry Pi/ESP32-H2 HIL을 대체하지 않는다.

### 확정 구현 범위

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

### 명시적 보류 범위

- 다중 gateway command 최종 집계 고도화
- ACK 계약 전면 개편과 API MQTT 소비 내구성 재설계
- 자동 Set 재시도, 취소, rollback과 수동 제어 패널 외 독립 명령 이력 페이지
- 스케줄 제어와 차량 감지 이벤트 제어 외의 센서·장면 자동제어
- RSSI, hop count와 제품별 상세 diagnostics
- 자동 HIL 판정. 실제 하드웨어 검증은 단일 gateway 기준으로 수동 수행한다.
- ESP32-H2 vendor sensor model과 Raspberry Pi BlueZ RF의 packet loss, 반복 재부팅, sudden power-loss HIL. 정상 High/Low와 5초·6초 hold 실 RF는 통과했지만 손실·전원 장애 시험은 별도다.

### 구현 항목

- Calm Operations 제어 화면은 h1 `제어` 아래 h2 `조명 제어`와 공통 밑줄형 수동·스케줄·이벤트 탭을 표시한다. 내부 제목은 공통 `PageHeader` h3의 24px·0 margin·1.22 line-height를 사용한다. 수동 모드는 `제어 대상 선택`과 `밝기 실행`을 읽기 순서대로 배치하며 선택 수·0~100 슬라이더·프리셋·적용 액션과 단일 polite `명령 진행 상태` live region을 제공한다. Assertive 명령 오류는 형제 alert로 분리한다. 종료 입력 제거 뒤에도 URL mode query, command lock/recovery, polling/retry/timeout, viewer 제한과 Mesh readiness를 유지한다.
- Scenes 13~16 수동 제어는 `명령 접수 → Gateway 전송 → 장비 응답 → 조명 적용` 진행 목록을 표시한다. `ACK`는 원문 protocol/terminal/retry 판단에 유지하고 화면 설명만 `장비 응답`으로 바꾼다. 저장 구역 dialog의 CRUD·재동기화·삭제 확인·viewer 읽기 전용·focus trap/return focus를 유지하며 삭제 pending 중 Escape/backdrop/close로 후보를 지우지 않는다. Chromium route fixture는 종료 필드가 없는 밝기 payload, nonterminal 입력 잠금, configuring/failed Mesh 차단, 네 viewport overflow·모바일 44px target을 검증한다. 이는 Raspberry Pi/BIO/BlueZ/ESP32-H2 HIL 증거가 아니다.
- 수동 전송 가능 여부, 자동화 활성 여부, Gateway 동기화와 최근 실행·감지 상태는 WCAG AA 4.5:1 이상 text contrast를 검증한 공통 icon+text `StatusBadge`로 표시한다. 공통 tone뿐 아니라 더 높은 specificity의 monitoring 화면 override까지 실제 CSS cascade 결과로 대비 계약을 검증한다. Gateway sync 문구는 `적용됨 | 적용 대기 | 적용 실패`로 통일하며 색상만으로 상태를 구분하지 않는다. 스케줄·이벤트 목록은 16px bordered surface와 최소 56px 행을 사용하고 구역 관리/add/edit/retry/delete는 ref 전달을 지원하는 공통 `Button` variant를 사용하되 기존 accessible name과 mutation·pagination·`401`·validation·scope side effect 계약을 유지한다. 760px 이하에서는 제어 PageHeader와 action 영역을 세로·전체 폭으로 전환해 320px/390px 화면에서도 추가 버튼 문구가 비정상적으로 접히지 않는다.
- 제어 페이지에 `수동 제어 | 스케줄 제어 | 이벤트 제어` 탭을 추가했다. 선택 상태는 `mode=manual|schedule|event` URL query로 유지하고 누락되거나 잘못된 값은 기존 `siteId`를 보존한 채 `manual`로 정규화한다. 선택 탭만 일반 Tab 순서에 두고 좌우 방향키 순환, Home/End에서 focus·선택·URL을 함께 갱신하며 browser back/forward 뒤에도 roving focus 상태를 복원한다. Site 또는 사용자 scope가 바뀌면 열린 스케줄 dialog와 mutation 표시 상태를 새 scope로 넘기지 않는다. Schedule panel은 schedule mode에서 lazy-load하고 loading 동안 연결된 `tabpanel` 상태를 유지한다.
- schedule 목록은 서버 `schedules.service.ts`의 실제 응답 형태를 사용해 이름, 활성 상태, 현장 시간대의 다음 실행, 반복·시간, 밝기, 대상 수, Gateway `PENDING|APPLIED|REJECTED` 상태와 최근 실행 결과를 표시한다. 최근 `action_result`는 `@led-control/shared/automation-contracts`의 narrow production schema로 검증한 뒤 fixture별 성공·실패·시간 초과를 집계하고 legacy/unknown payload는 상세 확인 불가로 표시한다. subpath의 `browser`와 generic `import`는 shared build가 생성한 executable `dist/esm` artifact를 사용하고 CommonJS `require`는 기존 CJS artifact를 유지하며, shared root CommonJS runtime은 Web production graph에 포함하지 않는다. Shared build cleanup은 manifest 소유 파일만 제거하고 `dist` root/parent/target symlink와 non-directory를 fail-closed하며 unrelated 파일을 보존한다. Artifact logical path는 POSIX 상대 경로만 허용하고 colon/backslash, drive-relative, ADS, UNC/device와 terminal dot/space를 host OS와 무관하게 mutation 전에 거부한다. 목록은 기본 10건(선택 가능 10·20·50·100건) bounded cursor page로 조회하며 3초 polling한다. 첫 페이지, 다음 페이지, background 상태 갱신 오류를 구분하고 기존 행을 유지한 비차단 경고와 오류 종류에 맞는 재시도를 제공한다.
- admin은 schedule 추가·수정·삭제·활성화/비활성화를 수행할 수 있고 viewer는 같은 목록과 상태만 조회한다. mutation 성공 시 중앙 schedule query key와 dashboard query를 invalidate한다. `schedule_overlap`, `single_gateway_required`, 권한·입력 오류는 서버 원문을 노출하지 않는 한글 메시지로 표시한다.
- schedule dialog는 빠른 프리셋의 `매일`, `평일`, `주말`, `한 번`을 기존 daily/weekly/once 계약으로 변환하며 평일은 월~금, 주말은 토~일 exact day set을 사용한다. 적용 날짜 기간과 하나의 자정 통과 가능 시간 구간은 기본 화면에 표시하고, 고급 설정은 1회·매일·매주·매월·매년 전체 반복과 디밍 ON 밝기 0~100·디밍 OFF 100%를 유지한다. 개별/다중·층·구역 target도 유지한다. 날짜는 Site IANA timezone의 달력 날짜를 ISO instant로 변환하며 브라우저 local timezone과 분리한다. 직접 선택은 최대 1,000개이고 월 29~31일 및 매년 2월 29일의 건너뛰기 의미를 안내한다. 매월 29~31일은 허용하지만 매년 4월 31일·2월 30일처럼 Gregorian 달력에 영구히 존재하지 않는 조합은 저장 전에 거부한다.
- schedule list/poll/mutation의 `401`은 로그인 세션 만료로 안내하고 중앙 `auth/me` query를 현재 사용자·Site 세대당 한 번만 invalidate한다. scope가 바뀌었다가 같은 값으로 돌아온 경우에도 과거 세대의 지연된 `401`이 새 principal을 만료시키지 않으며 `403` 권한 오류와 network 오류는 별도 문구를 유지한다.
- 이벤트 탭은 lazy-load한 차량 이벤트 규칙 panel로 admin CRUD·활성화/비활성화와 viewer read-only 목록을 제공한다. 목록은 활성 상태, source·target 수, 밝기, hold, Gateway sync 상태와 최근 감지를 표시한다. 초기 목록·다음 cursor·background polling의 `401`은 모두 세션 만료로 안내하고 중앙 `auth/me` query를 invalidate한다. mutation의 auth/cache side effect는 mutation-level callback에서 수행해 panel unmount 뒤에도 보장하며, dialog/message 같은 UI state만 scope 세대로 제한한다.
- 스케줄·이벤트 목록 조회와 보이는 페이지 polling에서 `401` 세션 만료 또는 `403`/`404` 현장 조회 권한 상실이 확인되면 캐시된 행·관리 버튼·열린 수정/삭제 대화상자뿐 아니라 조건별 집계·페이지 이동도 즉시 차단한다. 앞선 일시적 polling `503`보다 새 목록 접근 오류를 우선 표시하고, `401`만 `auth/me`를 무효화한다. `403`/`404` 뒤에는 실제 목록 재조회 성공 시에만 관리를 다시 제공한다. 이는 Web mock 기반 차단 검증이며 실장비 동작 검증은 아니다.
- 이벤트 dialog는 감지 센서와 실행할 조명의 요약 카드를 원인→결과 순서로 배치하고, 밝기 50/70/80/100%와 유지 시간 30초/1분/5분 프리셋을 제공한다. 프리셋 밖의 5~1,800초는 직접 입력으로 유지한다. source picker는 전용 선택 view에서 Dashboard fixture의 Gateway 등록, `supported` vehicle sensor capability 및 canonical ISO verified timestamp가 모두 확인된 fixture만 노출한다. timestamp 누락·`null`·비정상 값은 fail-closed한다. target은 direct fixture selection만 지원하며 API의 단일 Gateway 제약을 그대로 적용한다. submit validation 오류는 stable error id로 해당 input/control group과 연결하고, 필요한 고급 설정 또는 picker view를 연 뒤 첫 invalid group 또는 input으로 focus를 이동한다.
- 수동 제어는 종료 시각 입력 없이 대상과 밝기를 전송한다. 성공한 조명별 밝기는 영속 기본값으로 저장하고 `조명 적용 완료 · 기본 밝기로 저장됨`으로 안내한다. 실패·시간 초과 조명은 기존 기본값을 유지한다. 응답 유실 복구는 target+brightness로 동일 요청을 재전송하며 유효한 legacy 저장 요청의 `overrideUntil`은 복구 시 제거한다.
- Gateway production runtime은 snapshot activation을 실제 offline scheduler와 priority arbiter에 연결한다. 수동 성공 시점에 활성인 exact schedule `(scheduleId, occurrenceKey)`와 vehicle `(ruleId, startedAt)`만 억제한다. 다음 occurrence/activation부터 `억제되지 않은 차량 event 중 최대 brightness > schedule > 기본 밝기` 순으로 동작하고 자동 실행 종료 후 수동 기본 밝기로 돌아온다. 진행 중 event의 Low hold 연장·재감지는 같은 activation이며 종료 후 새 감지부터 재개한다.
- Gateway automation state schema V6는 `pendingManualControls`, `manualAutomationSuppressions`, `baseBrightnessByFixture`, 확인된 desired와 차량 센서 bounded inbox를 저장한다. V1~V5 입력을 migration하며 확인된 V5 성공 manual만 기본값으로 승격하고 남은 종료 시간은 폐기한다. Pending/실패/불명확 값은 성공으로 추정하지 않는다. Lifecycle/terminal, telemetry handoff와 `(sourceUnicast,bootId,sequence)` receipt는 같은 atomic mutation으로 유지하며 restart pending/unverified fixture는 lighting observation까지 RF를 보류한다.
- Automation fixture observation은 Health Current telemetry와 분리된 OnOff/Lightness callback으로 수집한다. Health timeout이어도 밝기 recovery는 완료된다. Full resync는 MQTT/heartbeat/ACK/manual control startup 뒤 모든 confirmed fixture를 bounded-concurrency worker로 순회하고 fixture 실패를 격리한다. Error 또는 `timedOut`/`failed`가 있는 full report는 250ms~30초 capped exponential backoff로 자동 rerun하며, restart pending source도 observation listener 설치 뒤 targeted worker에 즉시 seed한다. Full/targeted worker는 fixture 경계, 관측 대기, busy retry에 `AbortSignal`을 전달하고 production shutdown은 timer를 취소한 뒤 기본 5초 상한으로 drain한다. Readiness는 full resync의 `mesh_resync_pending|mesh_resync_failed` blocker로 노출한다.
- Schedule recurrence는 wall clock, 현재 process의 vehicle Low hold는 monotonic clock을 사용한다. 수동 기본값에는 만료 시간이 없다. `deliveryGeneration`, `deliveryGeneratedAt`, `deliveryWindowMs`와 broker remaining TTL로 10초 command delivery와 RF 직전 deadline을 계속 검증한다. Legacy 종료 필드는 compatibility parser에서 읽되 기본값 유지 시간에 사용하지 않는다. Clock trust와 resync recovery fence는 새 schedule과 미확인 출력의 안전한 재개를 위해 유지한다.
- Manual command는 pending 제어와 transition을 RF 전에 저장한다. Startup은 snapshot 활성화 뒤 old/new journal pending handoff를 실제 `ScheduleRuntime`에 재생한다. Accepted manual/pending handoff는 완료 전까지 TTL과 일반 record eviction에서 보호하며 별도 10,000건 상한은 초과 intake를 capacity error로 차단한다. Live terminal은 실제 성공 시점의 source를 억제하며 복구 handoff는 그 뒤 시작된 새 source를 억제하지 않는다.
- BIO USB Gateway는 등록 직후 `sensor` mode여서 순간 밝기를 증명할 수 없는 경우에도 첫 수동 제어를 허용한다. 이 예외는 `adapterKind=bio-usb`에만 적용하며 일반 BlueZ의 `automation_current_state_unavailable` fail-closed는 유지한다. V6 pending 제어의 provisional `preBrightness`는 관측/current/base로 승격하지 않는다. `SET ACK → high-brightness GET → control-mode GET` 뒤 UUID·native UUID·논리 주소·밝기와 exact `force-on|force-off` mode가 일치한 성공 terminal만 current/lastDesired/base를 확정한다. USB 또는 read-back 실패 시 미관측 밝기를 성공으로 남기지 않는다.
- 성공한 manual은 자동 source 활성 여부와 관계없이 해당 fixture의 기본값을 갱신한다. 예를 들어 schedule 40%·event 80% 실행 중 수동 60%가 성공하면 현재 source가 끝나도 60%이며, 새 event는 80%로 재개 후 60%, 다음 daily schedule은 40%로 재개 후 60%로 복귀한다.
- 자동 RF는 terminal telemetry capacity reservation 밖에서 실행한다. Fixture-state enqueue가 전부 또는 일부 실패해도 로컬 제어 결과를 유지하고 누락 범위를 stable handoff identity와 `fixture_state_outbox` provenance가 있는 automation state `telemetryGap`에 합친다. 최초 gap 후보는 state write 전에 identity/count를 확정한다. Definite state `ENOSPC`이면 같은 후보를 preallocated fixed journal에 `fsync`하고, state와 journal이 모두 실패하면 하나의 cumulative retained source와 degraded health로 합쳐 RF를 계속하면서 bounded retry한다. Outbox `recordGap`은 cumulative snapshot을 idempotent하게 수락하고 fixed journal reimport는 durable accepted baseline 이후의 aggregate delta만 반영한다.
- Gateway는 `detected|cleared|current-state` 차량 입력을 규칙별 OR source set으로 정규화한다. High는 software timeout으로 해제하지 않고 마지막 Low에서 monotonic hold를 시작하며 retrigger가 deadline을 취소한다. Clock-untrusted restart는 trust 회복 뒤 persisted UTC hold를 현재 boot monotonic deadline으로 변환한다. 억제되지 않은 event는 최대 밝기를 사용하고 마지막 event 종료는 억제되지 않은 현재 schedule 또는 기본 밝기로 복귀한다.
- Gateway production runtime은 표준 Sensor Client와 제품 vendor client model을 BlueZ application composition에 등록한다. Confirmed node의 Sensor Server와 vendor event server를 AppKey에 bind하고 provisioner publication을 exact Config Status로 확인한다. Startup, reconnect와 automation hot reload에서 enabled 차량 규칙의 source에 Presence Sensor Get을 보내며 Presence/Motion Status를 `current-state`로 반영한다.
- Vendor event는 version, `bootId`, `sequence`, `eventKind`, `level`의 exact length와 값 조합을 검증한다. Source별 current boot와 최근 8개 boot high-water를 V6 automation state inbox에 영속 저장한다. 처음 보는 boot만 새 session으로 적용하고 이미 recent에 있는 이전 boot는 ACK만 재전송한다. Presence는 `0|1` strict boolean, Motion Sensed Percentage 8은 `0..100`에서 `>0`을 active로 정규화한다.
- Node별 capability journal은 model binding 결과가 실제로 달라질 때만 revision과 event ID를 새로 만든다. Startup/reconnect는 전체 pending ID를 한 번 저장하고 Config 결과를 직렬 수집한 뒤 성공 binding과 pending 완료를 한 번에 저장하므로 journal rewrite는 source 수와 무관하게 최대 2회이고 총 write bytes는 O(N)이다. Partial Config failure는 실패 node만 pending에 남기며 성공 node의 unchanged binding은 revision/event ID를 유지한다. 두 batch의 commit uncertainty는 target이 previous면 이전 identity 유지, next면 같은 revision/eventId/hash 채택, unknown이면 journal을 fence한다.
- Provisioning completed terminal은 QoS1 callback을 먼저 보장한다. 최초 refresh journal write가 definite failure여도 controller가 최대 10,000개 volatile pending ID를 보존하고 1초~30초 capped backoff로 같은 serial batch를 재시도하며 health를 degraded로 유지한다. Shutdown은 retry timer를 취소하고 이미 시작한 enqueue/Config batch를 drain한다. Volatile set은 process crash를 넘지 않으며, 재시작 시 confirmed/configured source 전체 startup refresh가 source of truth로 복구한다. Broker PUBACK 뒤에도 capability report를 유지하고 exact application ACK만 terminal로 만든다.
- Production Gateway와 Task 16 firmware는 Bluetooth SIG 자사 할당 Company Identifier를 각각 `GATEWAY_BLUETOOTH_COMPANY_ID`, `CONFIG_LED_CONTROL_BLUETOOTH_COMPANY_ID`로 같은 값에 설정해야 한다. 누락·미할당·Espressif `0x02E5`·테스트 예약값은 fail-closed하며 저장소에는 양산 기본값을 두지 않는다.
- ESP32-H2 차량 센서 driver는 interrupt-disabled boot sample을 32개 static queue에 먼저 넣고 critical enable/reconcile 뒤 양 edge를 수집한다. Sensor task는 handle publish 전 notification gate에서 대기한다. ISR은 IRAM/ROM audit된 level/time/enqueue 호출과 queue-full atomic dropped/resync flag만 수행한다. 일반 task는 queue drain 뒤 timestamp-before-level sample과 ISR generation 전후 비교로 stable GPIO resync만 publish하고 동일 level만 제거한다. Pull-down과 hardware hysteresis만 사용하며 software debounce, timing filter와 High timeout은 없다. GPIO allowlist와 PWM/factory-reset/strapping/flash/package/USB, 기본 UART0 GPIO23/24 및 custom console GPIO 충돌은 compile/runtime에서 fail-closed한다.
- Task 16 model worker와 static queue는 최초 start에서 한 번만 생성하고 stop 때 generation별 parked ack를 공개한 뒤 같은 task를 재사용한다. Sensor Status와 vendor event는 shared publication buffer 대신 pinned ESP-IDF v5.5.1의 repository-patched server-send 경로를 사용한다. `SERVER_MODEL_SEND` payload/context는 API thread에서 all-or-nothing snapshot하고 allocation/envelope/queue-post 실패는 handler 실행 없이 동기 오류와 exact cleanup, queue 수락은 기존 handler deep-free 1회를 보장한다. 따라서 back-to-back/16-slot same-deadline retry payload가 보존되고 failed event는 pending에서 재시도된다. NetKey `0`과 현재 publication의 AppKey/address/TTL/credential/SZMIC를 전송 context에 반영하고 period/retransmit가 `0`이 아니면 fail-closed한다. Token 없는 model send/publish completion은 advisory no-op이며 Sensor는 동기 API 수락/거부, vendor는 동기 API 결과와 exact ACK/retry exhaustion만 Health와 liveness에 반영한다. Client send는 기존 ESP-IDF deep-copy 동작을 유지한다. Sensor/vendor send fault active 조건은 분리되며 restart는 내부 zero Health source를 외부 current/registered 배열에도 exact 반영한다. Registered history Clear와 permanent sequence exhaustion current 의미는 유지한다.
- Firmware production trust anchor/fingerprint는 caller env가 아닌 고정 repository/CI policy에서만 읽으며 현재 `unprovisioned`라 production build는 의도적으로 실패한다. 향후 v2 approval은 CID/source commit/sdkconfig/partition digest를 서명하고 production artifact attestation v2는 approval identity와 app/bootloader/partition-table/otadata hash 및 ESP-IDF version/commit/patch/patched-source/identity digest를 release key로 서명한다. Build/flash wrapper는 exact source를 외부 build-only component overlay에만 patch하고 사용자 global IDF checkout은 수정하지 않으며, wrong revision/hash와 overlay 변조를 overwrite 없이 거부한다. Flash wrapper는 exact signature/hash를 재검증한다. Test `0xFFFF` image는 app 첫 분기에서 fail-stop해 raw flash 우회에도 NVS/Bluetooth/sensor를 시작하지 않는다.
- Gateway execution telemetry `appendBatch`는 handoff 전체를 한 atomic rewrite로 수락하거나 실제 dropped record set 전부를 반환해 prefix success를 만들지 않는다. Grouped `action_result` 한 payload의 여러 fixture result는 dropped count 1이다. Pretty JSON metadata를 포함한 regular outbox는 strict 64 MiB다. Automation state와 outbox는 startup에 한 번 실제 할당한 공용 64 MiB headroom을 사용하며 정상 commit은 reserve I/O를 만들지 않는다. 실제 `ENOSPC`에서만 reserve를 한 번 release/retry하고 verified free space 뒤 background로 복원한다. State mutation은 `durable|memory_only` outcome을 반환하고 schedule/vehicle/manual local transition만 memory-only fallback을 사용한다. Handoff/gap clear는 durable-required라 실패 시 memory/disk pending과 outbox receipt를 그대로 두고 coordinator batch를 중단해 1초~30초 bounded backoff로 같은 handoff를 재시도한다. Fixed journal은 마지막 일반 source와 cumulative source receipt 외에 outbox accepted aggregate baseline과 acceptance identity/hash를 고정 필드로 유지한다. Aggregate identity는 clear까지 유지하고 reimport는 `aggregate - acceptedBaseline`만 처리한다. Baseline에 이미 흡수되고 state/journal에서 재생 불가능한 general source receipt는 같은 outbox import commit에서 제거하되 현재 state pending handoff/gap, current journal source, cumulative source, aggregate와 active baseline identity는 보호하므로 clear 장기 실패와 restart에서도 recovery metadata가 O(1)이다. Cleanup commit의 definite failure와 previous·next uncertainty도 기존 visible target reconciliation으로 동일 event ID/sequence/final hash와 정확한 count에 수렴한다. 두 4 KiB block과 inode allocation은 고정이며 clear tombstone generation 뒤 기록한 새 source도 restart에서 보존한다. Durable clear 뒤에만 source receipt를 release하고, retry에서 처음 outbox work가 생기면 publisher를 깨우며, 미게시 `event_extended`는 latest record로 교체하고 MQTT application ACK exact match 전 record를 유지한다.
- Raspberry Pi Gateway production runtime은 `AutomationSnapshotV1` config topic을 MQTT QoS 1로 구독한다. Snapshot은 strict schema, assigned Site/Gateway scope, Task 9와 같은 canonical SHA-256를 검증하고 단일 automation serial queue에서 처리한다. 높은 revision은 temp write, file fsync, rename, parent directory fsync를 거치며 rename 뒤 fsync fault는 exact disk read-back과 parent 재-fsync로 commit 여부를 확정한다. 재-fsync까지 실패하면 이전 visible snapshot을 복구하고 non-acknowledgeable `snapshot_commit_uncertain`으로 전파해 durable rejected ACK와 inbound PUBACK을 만들지 않으며 broker redelivery/restart가 이전 durable revision 또는 같은 revision/hash applied 상태로 수렴하게 한다. 저장 뒤 desired state 재계산/적용 실패 시 active file과 memory를 직전 revision으로 원자 복구한다. 같은 revision/hash는 저장·재계산 없이 idempotent applied 처리하며 낮은 revision과 같은 revision의 다른 유효 hash는 기존 snapshot을 유지한 채 각각 `snapshot_old_revision`, `snapshot_revision_conflict`로 거부한다.
- Gateway는 재시작 시 마지막 원자 교체 snapshot을 복구하고 중단된 temp 파일을 제거한다. Config `applied|rejected` ACK는 local Gateway ID와 수신한 exact revision/hash를 포함해 별도 `0600` file outbox에 publish 전에 저장하며 MQTT.js `handleMessage` backpressure가 이 fsync와 hot reload 완료 전 broker PUBACK을 막는다. ACK publish 실패는 같은 payload를 지수 backoff로 재시도하고 reconnect/process restart 뒤에도 재발행한다. reconnect는 이전 generation drain이 남아도 새 exact ACK drain을 즉시 시작하며 ACK connect/retry는 health, provisioning, state, mesh resync 실패와 분리된다. Production-like handler 검증은 valid, invalid, old, conflict, store/recompute failure 전후 current revision, durable ACK, MQTT/heartbeat/BLE Mesh 무중단을 함께 확인한다.
- Gateway는 관련 subscription 준비가 끝난 모든 MQTT connect/reconnect에서 strict `AutomationCurrentConfigRequestV1`을 발행하고 1초부터 최대 30초의 bounded backoff/jitter로 응답 snapshot을 기다린다. API는 topic/payload Site·Gateway와 active claimed Gateway MQTT certificate ledger를 transaction lock으로 확인한 뒤, `APPLIED` 상태라도 exact latest desired revision/hash의 기존 full snapshot outbox를 revive한다. 최신 snapshot이 empty/deleted 규칙 집합이어도 그대로 재발행하므로 세션이 없던 최초 연결과 세션 소멸 뒤 재연결이 MQTT retained/session 보존에 의존하지 않는다.
- Config applied ACK file outbox는 v2 delivery envelope의 `acknowledgementId`, Site, Gateway, revision, payload hash와 ACK 본문을 보존하며 broker PUBACK으로 record를 삭제하지 않는다. API가 exact immutable snapshot을 확인하고 최초 ingest 또는 exact idempotent replay를 DB transaction으로 반영하면서 만든 strict `AutomationConfigAppliedReceiptV1`을 받은 경우에만 전체 identity가 같은 record를 삭제한다. Altered/conflict ACK에는 receipt를 만들지 않고, wrong Site/Gateway·old ID·본문 불일치 receipt는 현재 record를 변경하지 않는다. Publish와 receipt 유실은 reconnect 및 1초~30초 bounded retry로 복구한다.
- `POST /commands/dimming`의 canonical 요청·응답과 새 MQTT payload에는 종료 필드가 없다. 유효한 legacy `overrideUntil`은 입력 호환 경계에서 제거하고 잘못된 날짜는 거부한다. Command, `ManualOverride`, `ManualOverrideFixture`, dispatch, outbox는 advisory lock과 Site 재인가가 있는 하나의 transaction에 저장한다. `ManualOverride.overrideUntil`은 nullable legacy 감사 필드이며 새 row는 null이다. Publisher는 durable 10초 delivery generation과 exact retry payload를 유지하고 delivery 만료만 `COMMAND_DELIVERY_EXPIRED`로 처리한다. 배포는 **V5 state 백업 → Gateway → DB/API → Web**, rollback은 이전 Gateway release와 대응 V5 state backup을 함께 복원한다. Control freeze·publisher drain·broker TTL 10초 대기와 DB nullable 이력 호환성은 [Pi runbook](../runbooks/raspberry-pi-gateway-appliance.md#수동-기본-밝기-v6-rolloutrollback)을 따른다. 사용자 DB 적용·운영 배포는 이번 software 작업에서 실행하지 않는다.
- `GET/POST/PATCH/DELETE /sites/:siteId/automation/vehicle-event-rules`를 제공한다. viewer는 assigned Site 목록을 조회하고 assigned active customer admin만 생성·수정·삭제할 수 있으며 operator와 다른 Site의 규칙은 `404`로 숨긴다. 목록 query는 Site 읽기 인가 뒤 파싱한다.
- 차량 이벤트 규칙은 distinct source와 target Fixture를 각각 한 개 이상 요구하고 등록 완료 Fixture만 저장 시점의 exact ID set으로 고정한다. source는 MeshNode capability가 `supported`이고 검증 시각이 있는 Fixture만 허용하며 unknown/unsupported/다른 tenant 식별자는 일반화된 validation 오류로 거부한다. target capability 검증은 하지 않는다. source와 target 전체가 같은 Site와 한 Gateway에 속해야 하며 다중 Gateway는 stable `single_gateway_required`로 거부한다.
- hold는 기본 60초, 5~1800 정수 범위이고 밝기는 0~100 정수다. `dimmingEnabled=false`는 입력 밝기를 저장하지 않고 DB/API/Gateway snapshot 모두 100%로 정규화한다.
- 차량 이벤트 parent/source/target과 Gateway `desiredRevision`, 전체 automation snapshot `MqttOutbox`를 하나의 transaction에 저장한다. write transaction은 공통 automation advisory lock을 먼저 획득한 뒤 Site row `FOR UPDATE` 재인가를 수행하며 Gateway 이동은 이전 제거 snapshot과 새 추가 snapshot을 함께 생성한다.
- 차량 이벤트 목록은 schedule과 같은 기본 25개·최대 100개 versioned keyset cursor와 `REPEATABLE READ` total/page snapshot을 사용한다. source/target 수, desired/applied revision, sync status, 최신 `vehicle_detected`와 최신 실행을 제공한다. 최신 전체 실행은 일반 ordered index, 최신 감지는 `kind='vehicle_detected'` partial ordered index를 사용한다.
- MeshNode 차량 센서 capability와 source-only CRUD 검증에 더해 direct SQL source 삽입, Fixture node 변경, enabled rule re-enable, capability downgrade DB guard를 구현했다. source 삽입과 downgrade는 공통 automation statement lock으로 직렬화되고, migration은 기존 invalid source를 rule/node 단위 remediation 오류로 중단한다.
- strict `VehicleSensorCapabilityReportV1`에 positive safe integer `capabilityRevision`과 complete-report canonical SHA-256를 적용했다. `VehicleSensorCapabilityService.applyReport`는 전역 `eventId`와 node-local Gateway/MeshNode/revision/eventType 원장을 함께 확인해 duplicate/stale/conflict/out-of-order report를 mutation 전에 분류하고, 높은 revision만 적용한다. 같은 Gateway의 두 node는 같은 revision을 순차·동시에 각각 저장할 수 있고 같은 node 충돌은 거부한다. supported는 metadata만 갱신하고 unsupported는 해당 node를 쓰는 모든 enabled rule을 원자 disable한 뒤 변경이 있을 때만 complete Gateway snapshot/outbox revision을 정확히 하나 만든다.
- capability report topic은 `sites/{siteId}/gateways/{gatewayId}/events/automation/vehicle-sensor-capability`, strict ACK topic은 `sites/{siteId}/gateways/{gatewayId}/acks/automation/vehicle-sensor-capability-ingested`다. ACK는 report identity/revision, `applied|stale|duplicate|rejected`, nullable error code와 ingestion 시각을 담는다. Service는 분류 transaction 안에서 deterministic `applicationAckKey`의 ACK `MqttOutbox`를 저장하고 정상 재전달에는 최초 payload/ingestion 시각을 재사용한다. Capability ACK row는 integer `revision`을 쓰지 않아 safe integer 최대 capability revision도 보존한다. MeshNode는 revision, 두 model-binding flag, status/verifiedAt coherence를 DB CHECK로 보존하고 legacy `ProcessedGatewayEvent`는 nullable hash로 호환한다.
- `MqttService`는 config applied, execution, vehicle capability의 세 Gateway-scoped automation event filter를 MQTT QoS 1로 구독한다. `AutomationMqttConsumerService`는 exact topic에서 Site/Gateway를 추출하고 strict payload ID, 현재 Gateway Site assignment, active claim과 active MQTT certificate를 함께 잠가 검증한다. 알 수 없거나 재배정·비활성·topic spoof인 identity는 상태와 ACK를 만들지 않는다. Broker mTLS ACL은 publisher 인증을 담당하고 API는 이 topic/payload/DB identity 결합을 추가로 강제한다.
- Config applied/rejected ACK는 해당 Gateway에 저장된 config outbox의 exact revision/hash/full snapshot과 일치할 때만 반영한다. Applied revision은 감소하지 않고 desired보다 낮은 성공은 `PENDING`, exact desired 성공은 `APPLIED`가 된다. Exact desired reject만 정제된 code로 `REJECTED`가 되며 이후 lower applied ACK는 applied revision과 적용 시각만 전진시키고 current rejection/code를 보존한다. 오래된 reject나 future/hash mismatch ACK는 현재 상태를 덮지 않는다.
- Execution ingest는 strict event와 source tenant/rule/Fixture snapshot을 검증하고 `(gatewayId,eventId,sequence)` 및 canonical payload hash로 exact replay와 conflicting replay를 구분한다. Source/target authorization은 mutable current rule이 아니라 `event.revision`에 해당하는 stored config outbox의 strict full snapshot과 canonical hash를 사용한다. Current rule이 변경·이동·삭제돼도 old revision의 정상 report는 raw `ruleId`와 nullable live relation을 보존해 수집한다. DB trigger도 execution의 `revision` 또는 action payload `sourceType`/`sourceId`만 변경하는 UPDATE에 같은 snapshot/source 검증을 다시 적용한다. 실행 원장, terminal fixture 결과와 `AutomationExecutionIngestedAckV1` durable outbox를 같은 transaction에 저장하며 exact replay는 최초 ACK payload/hash/`ingestedAt`을 보존해 delivery 상태만 되살린다.
- `AutomationOutboxPublisherService`는 command publisher와 분리된 config/application-ACK claim SQL, `FOR UPDATE SKIP LOCKED` 30초 lease, publish 전 renewal/ownership fence와 10초 MQTT QoS 1 timeout을 사용한다. 저장 payload는 command expiry 없이 그대로 발행한다. Config는 최신 desired full snapshot만 남기고 이전 미발행 revision을 retained superseded로 전환한다. Config와 application ACK 모두 1~60초 backoff 뒤 10회 또는 생성 후 15분에 stored topic/payload/hash를 보존한 retained deadletter로 전환되며 exact report 재전달은 application ACK를 되살릴 수 있다. 종료 coordinator는 active automation batch를 bounded drain한 뒤 MQTT를 닫는다.
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
- 저장 구역 생성·수정·삭제의 에너지 차원 이력은 필수 `EnergyDimensionHistoryService` 의존성으로 같은 transaction 안에서 기록한다. PostgreSQL `pg_advisory_xact_lock()`은 반환값이 필요 없는 `$executeRaw`로 실행해 `void` 결과를 Prisma가 역직렬화하며 발생하던 구역 생성 HTTP 500을 제거했다. API DTO와 Prisma schema/migration은 변경하지 않았다.
- 테스트 데이터 조명도 공통 energy 서비스의 bulk identity/current dimension 보충을 거쳐 구역에 사용할 수 있다. 1,000개 신규·반복은 energy DB 호출 5회·3회이며 동일 version을 중복 생성하지 않는다. cleanup은 fixture 잠금 뒤 분석·membership 의존성을 확인한다. 잠금 대기 중 analytics 발생 시 `409`를 transaction ordering 회귀로 검증했으며 실제 PostgreSQL 동시 실행은 미검증이다.
- API command/scan outbox worker는 initial·interval batch의 transient DB 실패를 scheduler 경계에서 격리해 API process를 유지하고 다음 tick에서 회복한다. 각 batch와 Mesh group sync는 single-flight이며 종료가 시작되면 다음 record/group publish를 시작하지 않는다. `MqttShutdownCoordinator` 하나가 command/scan outbox와 `MeshGroupSyncWorker`의 멱등 `stopAndDrain()`, inbound MQTT listener 분리와 진행 중 handler drain을 모두 완료한 뒤에만 MQTT client close를 시작한다. Mesh subscription sync와 inbound application ACK는 PUBACK이 없으면 10초에 해당 packet ID를 취소하므로 drain이 무기한 대기하지 않으며, timeout rejection은 payload·topic·오류 상세를 남기지 않는 최상위 오류 경계에서 격리한다. 이후 close는 MQTT.js graceful `end` callback을 await하고 5초 안에 완료되지 않으면 force close callback을 추가 1초간 기다린 뒤 종료를 계속한다.
- 제어 생성은 `(siteId, requestedBy, clientRequestId)`와 안정 정렬한 target·brightness fingerprint로 멱등 처리한다. 동일 요청은 기존 command를 반환하고 다른 payload는 `409 client_request_id_payload_conflict`로 거부하며, 동시 unique 충돌은 새 transaction 재조회로 수렴한다. Web은 네트워크 오류·5xx·응답 유실에서만 같은 요청의 재전송을 제공하고, 4xx 확정 거부는 pending 요청을 제거해 UI를 즉시 잠금 해제한다. 전송 중 사용자·현장 전환 시 기존 요청을 abort하고 generation/scope가 다른 지연 성공·실패 결과를 현재 화면에 반영하지 않는다.
- `viewer`가 제어 화면에 진입하면 읽기 전용 안내를 표시하고 밝기 슬라이더, 프리셋, 대상 선택과 `밝기 적용` 버튼을 모두 비활성화한다. 이 경우 브라우저는 `POST /commands/dimming`을 보내지 않으며 권한 오류를 장비 장애로 오인하지 않는다.
- Task 9 격리 실백엔드 Chromium E2E는 assigned admin이 개별, 임의 다중, 층, 저장 구역 밝기 명령을 production command API로 전송하고 test-support software simulator가 MQTT acceptance/device-status ACK와 fixture-state를 반환해 각 명령이 terminal 상태로 수렴하는 것을 검증했다. simulator는 lab CA의 `CN=Gateway.id` client certificate와 own-gateway topic ACL을 사용하지만, production Gateway 인증서 발급·bootstrap·배포 ACL 또는 실제 BlueZ/RF 전송을 검증한 것은 아니다. operator는 customer route를 mount하지 않고 viewer는 읽기 전용이다.
- RealBackendLab Chromium E2E는 매 실행마다 격리 PostgreSQL·Redis·mTLS Mosquitto와 production Web/API/Gateway를 시작한다. Admin UI로 schedule 40%, vehicle event 80%, manual 60%를 전송하고 현재 event와 schedule의 억제, 다음 event 80%→60%, 다음 daily occurrence 40%→60%를 검증한다. `createSchedule`의 caller-supplied Date와 Asia/Seoul private clock이 같은 경계를 사용한다. Production Gateway execution을 독립 canonical hash·API exact ACK·DB row·producer PID·source FK로 결속하고 durable telemetry outbox records 0/gap false까지 확인한다. Baseline 복귀 telemetry는 종료된 rule/occurrence를 원인으로 보존한다. Sensor edge와 clock은 token 검증 private IPC만 사용하며 public simulator endpoint나 직접 자동화 state 변경은 없다. 실행 결과는 [수동 기본 밝기 계획](../superpowers/plans/2026-09-14-manual-baseline-control.md#task-6-실행-증거)에 기록한다.
- Task 19 simulator는 `NODE_ENV=test`와 `AUTOMATION_E2E_SIMULATOR=1`이 동시에 있을 때만 생성된다. production에서 활성화를 요청하면 정확히 `software automation simulator is forbidden in production`으로 즉시 실패하고, 일반 `scripts/dev.mjs`도 simulator 환경을 거부한다. E2E도 production identity store 검증과 certificate rotation startup을 유지해 실제 mTLS certificate로 연결하지만, 유효한 사전 발급 certificate를 사용하므로 bootstrap 재발급/rotation 갱신과 실제 BlueZ/RF는 검증하지 않는다. Production 기본 adapter 경로는 계속 BlueZ를 사용하며 software E2E를 Raspberry Pi/ESP32-H2 HIL 완료로 간주하지 않는다.
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
- Gateway 재시작 시 정상적인 durable group state는 그대로 복원한다. state 파일이 없거나 state/manifest revision이 다르거나 손상됐을 때는 로컬 applied membership을 신뢰하지 않고 빈 상태로 fail-closed하며, 같은 `eventId`의 `first_run/state_missing/state_corrupt` resync 요청을 영속화한다. API는 resync DB transaction commit 뒤 inbound QoS 1 `PUBACK`을 먼저 반환하고, 같은 MQTT parser가 outbound QoS 1 callback을 처리할 수 있게 된 뒤 추적 중인 handler에서 애플리케이션 ACK를 발행한다. Gateway는 이 ACK의 `requestEventId`를 확인할 때까지 재시작·재연결·heartbeat에서도 요청을 재전송한다. API는 cloud applied snapshot을 삭제하지 않고 full-state Add와 retiring Delete 근거로 사용하며, gateway는 성공 결과를 새 durable membership snapshot으로 원자 저장한다. cloud에도 gateway에도 남지 않은 미확인 물리 subscription address는 자동 복구할 수 없으므로 HIL/운영 감사 위험으로 남긴다.
- MQTT command subscribe 실패는 현재 연결에서 최대 30초 backoff로 재시도한다. 직전 SUBACK가 실패했다면 persistent session 재연결의 `sessionPresent`와 관계없이 command 및 resync ACK topic을 강제 재구독한다. subscription 결과에 member 누락, 중복 또는 미등록 node가 있으면 group을 `failed`로 저장한다.
- ESP32-H2 primary element는 Presence Detected Sensor Server와 Task 14 공통 Company ID의 vendor event server를 제공하며, 지원하지 않는 Sensor Setup Server는 composition에서 제거했다. Descriptor/Get/Column/Series는 공식 Status 의미로 응답하고 Sensor Get/주기 Status는 매번 Task 15 driver current를 읽는다. Gateway가 stack period를 0으로 설정해 custom worker의 `60s + FNV-1a(primary unicast) % 5000ms`만 동작한다. Vendor payload는 version, per-boot random `bootId`, 1부터 증가하는 uint32 sequence, detected/cleared와 exact level의 11바이트 계약이다.
- 센서 event는 16개 static pending slot에서 event별 initial publish와 250ms, 500ms, 1s, 2s, 4s, 8s의 6회 retry마다 실제 transport API를 호출한다. Exact bootId/sequence ACK만 slot을 제거하고 duplicate/out-of-order ACK는 무시한다. Completion callback 유실·지연·중복은 pending, retry, fault에 영향을 주지 않는다. Queue full은 current GPIO recovery를 예약하며 dropped/retry exhausted/send/unconfigured/sequence exhausted를 Health fault에 기록한다. Driver callback은 BLE API와 log 없이 static model worker에만 nonblocking handoff한다.
- ESP32-H2는 group Light Lightness Set Unacknowledged를 PWM에 즉시 반영하고 primary unicast 기반 `64~5,179ms` 결정적 지터 뒤 실제 Lightness Status를 publication한다. `(source, destination, TID)` 6초 cache가 중복 적용과 publication 재예약을 막는다.
- 펌웨어의 모델별 group subscription 상한은 16개이며, 서비스 계약은 조명 한 대당 층 group 1개와 사용자 fixture group 최대 15개다. API도 provisioning member 연결 시 같은 사용자 group 상한을 검증한다.

- 2026-09-26 Gateway Set 수신 경계: `GATEWAY_COMMAND_EPOCH_CUTOVER=1`에서 현장/Gateway scope, publish epoch 및 DB 시각 증거를 수신·group queue dequeue·journal 수락 직전·fsync/accepted ACK 이후에 재검사한다. 유효한 동일 epoch 증거로 확인한 만료와 상대 receipt TTL 소진은 `COMMAND_EXPIRED`, scope/epoch/증거 거부는 `GATEWAY_CLOCK_UNTRUSTED`로 기록한다. 최초 거부를 journal의 첫 원자 저장부터 terminal로 보존하고 DUP에 같은 ACK를 재생한다. 24시간 journal 정리 뒤 DUP도 다시 검증해 RF를 차단하며 로컬 journal의 기존 보관기간은 바꾸지 않는다. `prepare` 전 거부는 RF·자동화 handoff·fixture-state 성공을 만들지 않고 legacy accepted-only 또는 RF 시작 가능 기록의 재시작은 기존 불확정 결과를 보존한다. cutover 전 legacy Set, Get/status-check, 로컬 자동화는 기존 정책을 유지한다. 어댑터의 각 native write 직전 차단과 보수적 배수 응답(Task 6)은 소프트웨어 구현·자동 검증을 완료했으며, 물리 RF 종료·취소 및 submit→RF 상한을 확인하는 Pi/BlueZ/BIO HIL, 운영 DB-host attestor와 운영 cutover는 별도 출시 관문으로 남아 있다. 따라서 cutover·운영 purge·복구 POST는 OFF를 유지하며, 중앙 보존 정책은 모든 현장에 최근 3 calendar months만 적용한다. 관련 구현은 `apps/gateway/src/index.ts`, `commands/gateway-command-handler.ts`, `commands/command-journal.ts`, `commands/db-clock-proof.ts`다.

- 2026-09-27 Gateway 수동 prepare 취소: cutover Set은 journal 수락에 `pre_rf`, adapter 호출 전에 `may_have_written`을 각각 fsync한다. RF 이전 거부는 terminal 결과와 abort intent를 원자 저장하고 `abortManualControl(sourceId, fixtureIds)`로 저장된 원본 source/fixture에 일치하는 pending 수동 제어·transition만 해제한 뒤 abort 완료를 저장하고 ACK를 반환한다. prepare·terminal 저장·abort·완료 기록 경계에서 재시작해도 재생은 멱등이며 다른 명령, 기존 기본 밝기, 관측 상태를 변경하지 않는다. `pre_rf` 재시작은 `GATEWAY_CLOCK_UNTRUSTED`로 거부하고 로컬 일정·센서 실행을 다시 허용하지만, RF 시작 가능 단계와 legacy accepted 기록은 미적용으로 단정하거나 abort하지 않는다. 변조된 DUP와 journal 수락 경합도 저장된 원본 대상으로 취소를 완료한 뒤 같은 terminal을 재생한다. 구현·재시작 테스트는 `apps/gateway/src/automation/schedule-runtime.ts`, `commands/gateway-command-handler.ts`, `commands/command-journal.ts`, `index.ts`와 대응 테스트에 있으며 실제 RF/HIL·운영 cutover는 아직 검증·활성화하지 않았다.

- 2026-09-26 Gateway Set DUP 순서 보완: 수신 시 시각/epoch 거부가 결정되어도 동일 그룹 queue를 통과한다. 원본 RF가 진행 중이면 기존 accepted 기록을 재시작 잔여 명령으로 오인해 `timed_out`이나 자동화 handoff를 먼저 만들지 않고, 원본 완료 뒤 같은 terminal 결과를 재생한다. RF 재실행은 없으며 수신 시 거부 판정도 queue 대기 중 새 증거로 해제하지 않는다. 2026-09-27에는 journal instance·idempotencyKey별 진행 중 Promise를 첫 비동기 저장 전에 등록해 unicast를 포함한 모든 delivery mode에 이 순서를 적용했다. 원본 prepare가 진행 중인 DUP는 완료를 기다린 뒤 durable 결과를 읽으며 다른 key 또는 다른 journal의 명령은 병렬 실행한다.

- 2026-09-27 수동 prepare 취소의 저장 실패 보완: abort는 일반 로컬 제어의 ENOSPC 메모리 대체 저장을 사용하지 않고 영속 저장을 요구한다. 저장 실패 시 journal abort intent를 유지하고 terminal ACK를 반환하지 않아 재시작 후 정확한 취소를 다시 수행한다. 별도로 관측되지 않은 desired 밝기가 0%여도 기존 observation fence를 유지한다. 실제 gap journal·headroom 설정의 ENOSPC 주입과 새 runtime/journal 복구로 검증했으며 운영 cutover·purge는 계속 OFF다.

- 2026-09-27 API clock 거부 ACK 귀속: `GATEWAY_CLOCK_UNTRUSTED`는 site/Gateway/Command/dispatch/key/sequence가 일치한 새 Set의 terminal 사전 RF 거부로만 반영한다. `accepted`와 동시에 온 clock 오류, Get/status-check에 온 Set 전용 clock 거부, 이미 `unknown`인 명령의 늦은 clock 거부는 명령·조명 상태를 확정하지 않는다. `COMMAND_EXPIRED`의 기존 terminal 처리는 유지한다. 최근 이력 요약은 원본 Set의 전체 대상이 실패하고 outcome이 `not_applied`인 정확한 clock 거부에만 선택적 `errorCode`를 제공하며, 상세 조회는 기존 dispatch 오류 코드를 보존한다. 원본 삭제 뒤 늦은 RF 불확정 Set ACK와 Get-only 복구 실패는 hold/status-check 경로에 남고 자동 Set 재발행이나 성공 fixture 관측을 만들지 않는다. 해당 terminal clock ACK는 미발행 Set outbox도 같은 DB transaction에서 닫고, 기본/세대별 Set publisher는 native enqueue 직전 live dispatch를 잠가 재확인한다. 임시 PostgreSQL 두 연결의 ACK↔발행 경쟁과 PUBACK 유실 재획득 0건을 검증했지만 실제 Gateway RF/HIL 완료나 운영 purge/cutover 승인은 아니다.

- 2026-09-27 제어 이력의 시각 불신 거부 설명: 서버 이력의 선택적 `GATEWAY_CLOCK_UNTRUSTED` 코드가 `failed`·`not_applied`와 함께 온 경우에만 최근 이력과 이력 drawer에 조명 RF 전 거부 및 자동 재실행 없음 안내를 표시한다. `unknown`·부분 적용은 기존 확인 필요 진입과 상태 확인 경로를 유지하며, `COMMAND_EXPIRED` 표시는 바꾸지 않았다. 이력 범위는 계속 서버가 정의한 UTC rolling 3 calendar months이고 1년 보관 선택은 제공하지 않는다. Web 단위 테스트는 UI 표시와 GET 전용 경로를 확인한 소프트웨어 증거이며 실제 Gateway/조명 RF 검증은 아니다.
- 2026-09-27 제어 안전 UI 재검토 보완: 확인 필요 case 상세의 배경 재조회 중이나 404/500 실패 뒤에는 캐시 상세로 Get-only 상태 확인·위험 승인을 실행하지 않는다. 열린 위험 승인 폼도 닫고, 새 상세 조회가 성공해야 동작을 다시 제공한다. 정확한 시각 불신·전체 미적용·terminal 실패의 명령 상세에서는 Gateway 수신 이후 장비 응답을 미도달로 표시하고 조명 적용을 오류로 둔다. 일반 실패와 `COMMAND_EXPIRED` 단계 표시는 유지한다. Vitest/Chromium mock 검증은 실제 Gateway RF·운영 안전 인증을 대신하지 않는다.

## 미구현

- 완료된 오래된 Command 원본·파생 사본을 실제로 비우는 비식별 worker는 후속 작업이다. Task 2는 DB 상태 제약과 소비자 차단만 추가하며 기존 미확정 잠금·수동 Set·최근 상태 확인을 유지한다.

- BIO 센서 `0x09`의 detected/cleared boolean mapping, source capability `supported` 승격 및 production event 실행은 미구현이다. `0x0c`는 생존 관측이며 이벤트 입력이 아니다.

- 수동 제어의 현재 선택을 그대로 넘기는 `이 선택을 구역으로 저장` 단축 동작은 미구현이다. 현재는 `구역 관리 → 새 구역`에서 지도·목록으로 멤버를 선택해야 한다. 후속 구현에서는 다층/100개 초과 선택 처리, 생성 권한·명령 잠금, 열린 dialog의 초안 초기화와 focus 복귀, 저장 후 기존 수동 선택 보존을 함께 검증해야 하므로 최종 오류 수정 범위에서는 보류했다.

- 인체 감지, 외부 이벤트, 장면과 복합 조건 rule builder
- 수동 제어 이력 패널 외 독립 명령 이력 페이지
- 자동 Set retry, rollback, cancel
- 조명 on/off 전용 토글
- 위험 명령 확인 dialog
- gateway의 원격 `identify-device` 명령을 실제 BlueZ adapter의 Health Attention Set으로 전달하는 연결
- ESP32-H2 제품/진단 정보 report의 gateway/API 연동
- ESP32-H2 실제 보드 플래시 검증
- 실제 마이크로웨이브 센서의 전기 출력과 LED converter를 함께 연결한 전압·타이밍 HIL. 2026-09-04 시험은 ESP32-H2 GPIO4의 내부 pull만 전환해 firmware·BLE Mesh·Gateway·API·Web 전체 논리 경로를 검증했으며 센서/컨버터 전기 적합성 증거는 아니다.

## 부족하거나 개선이 필요한 기능

- 공통 BIO catalog/preparation/live authority 및 degraded 복원 경로는 소프트웨어·가짜 transport 검증 범위다. 실제 RF/USB/HIL·현장 프로필 승인·API eligibility 전환·운영 배포는 완료하지 않았다. legacy mode command의 OFF/TTL 경로와 V1/V2 strict wire는 유지하며, 연결/identity를 새로 확인할 수 없는 explicit release는 기존 미확정 pending을 남긴다. 미확정 delivery/result는 자동 삭제하지 않아 장기 장애 누적 시 용량 관문이 닫힐 수 있다.
- 2026-10-04 iOS 검증 경계: 공개 로그인 화면과 synthetic WebView 브리지·CSV 동작만 검증했다. 포커스 보정의 정식 셸 연결과 늦은 viewport 축소는 자동 회귀를 통과했다. 이 Mac의 iOS26.5 Simulator에서 observer 없이 실제 로그인 화면의 ID 최초 포커스 cold start 2회, Next, 별도 cold start의 비밀번호 최초 포커스·재포커스, 사용자 스크롤 유지와 Done 복원을 확인했다. 인증된 해당 메뉴, PDF, 구형 iOS와 실장비 조명 연동은 미검증이다.

- 모바일 제어 durable 복구는 OS가 해당 WebView origin의 localStorage를 보존하는 범위다. 앱 데이터 삭제·origin 변경·저장소 손상에서 원본이 복구된다고 보장하지 않는다. 실제 Android/iOS 강제 종료·renderer 재생성·세션 만료·계정 전환·네트워크 단절과 원본 명령 결과 확인은 실기기 검증이 필요하다. storage 오류의 해당 문서 잠금은 성공적인 상태 조회만으로 해제하지 않으며 자동 저장값 삭제/새 Set으로 복구하지 않는다. 공통 native bootstrap·focus/online 재조회 연계는 Shell writer 소유이며 제어에서 별도 lifecycle listener를 복제하지 않는다.

- Set epoch 발행 경계는 활성 세대·등록 worker·동일 DB primary의 시각 증거를 claim/prepare/attempt/publish마다 재확인하고, MQTT 전 `CommandPublishAttempt`에 절대 만료를 기록한다. Quiesce의 member ACK는 로컬 중지만 뜻하며 응답 없는 member를 시간 경과로 안전 처리하지 않는다. 원본 Command의 UTC rolling 3개월 cutoff와 Set 전용 permit을 적용하며, legacy status-check Get은 quiesce와 분리한다.
- 운영 DB-host attestor와 세대별 durable primary/step 연속성 제공자는 아직 없다. 새 API 프로세스는 이 증거 없이 ON Set을 발행할 수 없으며, 재시작을 가로지르는 시각 연속성은 아직 증명되지 않았다. Broker 구세대 admission 반롤백·Gateway/RF drain 및 parent-free recovery publisher의 전체 통합은 후속 게이트다. 운영 cutover, purge, recovery POST는 계속 OFF다.
- 확인 필요 case의 미해결 Hold는 기간이 지나도 먼저 조회하고 유지한다. 해결된 최소 요약만 중앙 DB 시각의 최근 UTC 3 calendar months를 상세 GET에서 보여 주며, 정확한 경계 행은 남긴다. 요약의 물리 sweep은 독립된 `RESOLVED_COMMAND_RECOVERY_RETENTION_ENABLED` 기본 OFF·운영 ON 거부 상태로, 일회용 PG에서만 회당 최대 1,000행·남은 backlog 로그를 검증했다. 목록 `generatedAt`은 표시용 API 시각이며 보존 cutoff가 아니다. DB-host 시계/failover 운영 증거와 migration 적용은 아직 없어 실제 삭제가 활성화된 것은 아니다. 일반 Command 원본 purge·HISTORY/RECOVERY_ACTIONS·복구 POST는 계속 OFF다.

- Set 전용 세대 mTLS egress는 준비 구현이며 `COMMAND_SET_EGRESS_ENABLED=0` 기본값에서 기존 Set/Get 발행을 유지한다. 전환 모드는 active DB member, wire `publishEpoch`, 일치하는 세대 인증서와 broker ACL이 없으면 Set을 거부하며 구 `api-service`로 우회하지 않는다. 원본 만료 전 Get과 recovery Get은 공유 연결을 계속 사용한다. 세대별 durable DB 시각 연속성, 전체 broker 반롤백·Gateway RF drain 증거는 후속 검증 사항이며 운영 cutover·purge·recovery POST는 OFF다. 관련 파일: `apps/api/src/mqtt/command-set-mqtt.service.ts`, `apps/api/src/mqtt/outbox-publisher.service.ts`, `scripts/dev-runtime.mjs`, `docs/runbooks/production-api-web-deployment.md`.

- Task 6 drain 카운터는 프로세스 메모리의 보수적 작업 현황이다. API/retention worker는 0건 응답이나 프로세스 재시작으로 초기화된 카운터를 물리 RF 종료 증거로 추론하면 안 된다. 응답 계약에는 물리 완료 인증 필드가 없고, 실장비 submit→RF 상한 측정·boot 세대/전체 subscriber 확인·broker fence가 필수다. Raspberry Pi/BlueZ/BIO HIL 미실행 상태이므로 cutover·운영 purge·복구 POST는 계속 OFF다.
- 자동화 전역 목록의 실제 현장 규모 사용성, 갱신 중 cursor 변화와 모바일 WebView는 추가 검증이 필요하다. 서버 cursor는 이전/다음 탐색만 보장하며 실시간 변경 중 고정 총 페이지 수나 임의 페이지 점프를 약속하지 않는다. 구 API 과도기 응답의 로드된 행 기준 수치는 현장 전체 집계가 아니다.
- 제어 세션 상태 센터 연계는 focused Vitest와 Web typecheck로 확인했으며 브라우저 E2E·실제 모바일 WebView 시각/조작 검증은 아직 완료 증거가 없다. 소프트웨어의 상태·재시도 표시와 실제 Gateway/Mesh 명령 적용·장애 복구 HIL을 구분해 검증해야 한다.

- BIO 센서 자극/회복 10-cycle 물리 HIL과 packet 의미 검토를 완료한 뒤, 별도의 production 통합 계획을 작성해야 한다. 현재 shadow evidence의 `readyForProtocolReview=true`는 protocol 검토 가능 여부일 뿐 `productionActivationAllowed=false`를 바꾸지 않는다.

- 수동 확인에 따른 즉시 제어 차단·새 presence/state 복구는 소프트웨어 검증 범위다. 물리 USB 동글과 조명 2대의 전원 차단/복구 HIL은 이번 작업에서 미수행이며, 실제 장비에서 모니터링 숫자·마커와 제어 가능 여부가 함께 바뀌는지 확인해야 한다.

- 모바일 두 손가락 확대·축소는 Web PointerEvent와 synthetic Chromium으로 검증했다. 실제 iOS/Android WebView의 safe area, gesture arbitration과 장시간 현장 사용성은 실기기 확인이 필요하다.
- 저장 구역은 fixture membership만 보존하며 polygon 경계는 저장하지 않는다. 맵의 영역 rectangle은 선택 도구이고 저장 데이터가 아니다.
- 스케줄·이벤트의 구역 선택은 저장 시점 fixture snapshot이다. 구역 멤버 변경은 기존 규칙에 자동 반영되지 않는다.

- 이번 제어 디자인 시스템 전환은 Chromium 자동 검증 범위다. Safari/Firefox, 실제 iOS·Android WebView의 segmented Date/Time 입력, safe-area와 OS별 focus ring은 수동 시각 QA가 추가로 필요하다. 제어 payload·API·Gateway 프로토콜은 변경하지 않았으며 실장비 HIL 완료 증거로 간주하지 않는다.

- capability 원장은 생성 후 365일보다 오래되고 현재 node revision과 watermark가 모두 해당 revision보다 높은 superseded 기록만 자동 정리한다. 최신 capability 보고는 보존하며 전체 이벤트 정리는 sweep당 합산 최대 10,000개다. scope/hash가 없는 legacy 원장이나 현재 node·watermark 안전 조건을 증명할 수 없는 기록은 남긴다. watermark는 최신 identity를 보존하고 임의 과거 ID의 exact dedupe는 raw 원장이 남아 있는 기간에 의존한다. 같은 worker의 heartbeat 7일·fixture state 30일 정책과 세부 조건은 [DB 보존 문서](../database-schema.md#운영-데이터-보존과-복구-범위)를 따른다. 사용자/운영 DB migration 적용과 Raspberry Pi/ESP32-H2 replay HIL은 미실행이다.
- 플랫폼 운영 배포 절차는 [API·Web runbook](../runbooks/production-api-web-deployment.md)을 따른다. 단일 호스트 Compose, 외부 Vault·공개 MQTT/Object Storage 연결, 장비 mTLS 공개 SAN, CRL 갱신 후 수동 broker SIGHUP, API 교체 후 nginx upstream 재해석·재시작이 운영 조건이다. Process-local 지표만 제공하며 외부 metrics/dashboard/alert/log shipping은 구성하지 않았다. 운영 배포·사용자 DB 적용·실장비 HIL과 native WebView·수동 시각 QA는 이번 자동 검증에 포함하지 않는다.

- 1440/390/320px 결과는 Chromium 자동 브라우저 software 증거다. 실제 iOS/Android native WebView, 수동 in-app 시각 QA, WebView safe-area 실측 또는 Raspberry Pi/ESP32-H2 HIL을 수행한 결과가 아니다. Lazy chunk 실패의 복구 UI는 플랫폼 Task 3에서 구현했으며, prefetch/offline cache는 후속 범위다. Task 3 오류 주입은 Vite에서 실제 앱 셸의 동적 import 요청을 차단한 deterministic Chromium 결과이며, 운영 CDN/container 배포나 실제 backend 장애·HIL 검증을 의미하지 않는다.
- 공통 우측 패널의 반응형·overflow 계약은 Chromium 1440/1024/390/320px route fixture로 검증했으며 실제 모바일 WebView safe-area와 브라우저별 scrollbar 표현은 별도 실측이 필요하다.
- 현재 개별 밝기 제어는 acknowledged Light Lightness Set을 한 번 전송하고 Status를 기다린다. 2026-09-03 HIL 4회 중 3회는 1~2초 내 성공했고 1회는 장치 적용 후 Status 한 패킷 유실로 timeout 됐다. 자동 Set 재전송 없이 후속 Lightness Get으로 실제 적용 여부를 확인하는 API·Gateway·웹 경로는 소프트웨어 구현을 완료했다. 해당 응답 유실 및 복구 경로의 실제 Raspberry Pi/BlueZ/ESP32-H2 HIL이 남아 있다.
- API/Gateway의 DB·journal 이후 PUBACK 계약은 자동화됐지만, API 종료·Gateway 종료·broker 재연결과 ESP32-H2 cold boot를 동시에 포함한 acceptance/device-status 중복 재전달 및 AppKey 복원은 실장비 전원 차단 HIL로 확인해야 한다.
- Automation full snapshot의 production MQTT publish, Gateway 원자 저장/hot reload/exact durable config ACK, Task 12 offline scheduler·priority arbiter, Task 13 execution outbox/application ACK와 Task 14 Sensor Client/vendor ACK 입력은 연결됐다. Snapshot activation과 production shutdown은 필요한 BLE Mesh terminal state/handoff, execution/capability queue와 in-flight QoS 1 publish를 순서대로 drain한다.
- Capability ACK의 필수 `reportPayloadHash`와 identity `vehicle-sensor-capability:<gatewayId>:<meshNodeId>:<eventId>:<reportPayloadHash>`는 cross-node eventId 충돌과 same-node altered payload를 원본과 분리한다. Exact report 재전달은 최초 payload/hash/`ingestedAt`을 유지하고 published/deadletter/expired lease delivery 상태만 재큐잉하며 live lease를 보호한다. 2026-09-03~04 Lab HIL에서 실제 Gateway 인증서·broker ACL로 capability revision 1과 Sensor/vendor binding, application ACK 및 후속 event 수신을 확인했다. Packet loss와 ACK exhaustion은 아직 실기하지 않았다.
- Task 14 Gateway Sensor/vendor client, Task 15 GPIO driver와 Task 16 ESP32-H2 model은 native exact wire/retry, production-source host fake와 patched ESP-IDF fullclean target build로 검증했다. 2026-09-04 단일 노드 HIL은 실제 RF의 정상 High/Low 경로까지 추가로 확인했다. device heap/queue 장기 부하, cache-disabled ISR stress, 실제 센서 전기 신호, packet loss와 전원 차단은 아직 증명하지 않았다.
- pending redirect와 네 가지 제어 target의 production API/MQTT ACK/state 경로는 Task 9 격리 실백엔드 software E2E로 검증했다. 실제 Raspberry Pi에서는 단일 BIO fixture의 개별·schedule 제어에 이어 2026-09-14 vendor USB virtual Mesh group 기반 층·구역 제어도 통과했다. 2026-09-15에는 Lab Ethernet 망 변경 뒤 서버/Pi endpoint와 TLS SAN·assignment를 복구하고 같은 Web session의 70%·0%·100%·30% 명령이 모두 `acknowledged/applied`, dispatch `completed`, fixture `succeeded` 및 요청 밝기 read-back으로 끝나는 것을 확인했다. 다중 BIO fixture와 표준 BlueZ/ESP32-H2 다중·층·구역 Mesh Group HIL은 아직 실행하지 않았다.
- `clientRequestId`와 payload를 보존하는 응답 유실 복구는 자동 테스트와 실제 Chromium 재로딩 흐름을 통과했다. 실장비 terminal ACK 왕복은 Raspberry Pi/ESP32-H2 HIL에서 확인해야 한다.
- Schedule API·Web CRUD, Gateway offline 실행, 차량 이벤트 Web CRUD와 수동 기본 밝기 제어를 구현했다. 종료 시각 입력과 변환은 제거했으며 event 목록·권한·source/target·capability 검증, auth/cache·접근성·scope reset 계약은 유지한다. RealBackendLab은 production API/Gateway와 실제 격리 DB/MQTT, 독립 execution hash/ACK/DB/outbox oracle를 검증한다. 현재 실행 결과는 아래 소프트웨어 검증 기록과 실행 계획을 따르며 bootstrap certificate 재발급과 실제 Raspberry Pi/BIO/BlueZ/ESP32-H2 HIL은 별도 후속 범위다.
- Final review P1 통합 fix의 RealBackendLab Chromium 검증은 non-persistent mTLS Mosquitto를 실제 재시작해 최초 Gateway 연결 전 publish `desired/applied 1/0→1/1`, 세션 소멸 재연결 revision 2, cloud 삭제 revision `2→3`, API session 소멸·재시작 revision `3→4`를 확인했다. 삭제 snapshot 적용 뒤 통제 clock을 3시간 전진해도 삭제 rule execution count는 `7→7`로 유지됐고, API가 없는 동안 config ACK는 broker PUBACK 뒤에도 Gateway outbox 1건으로 남아 API의 exact receipt 후 0건이 됐다. 이는 production API/Gateway와 software BLE simulator 검증이며 실제 RF/HIL 완료 증거는 아니다.
- 최근·과거 명령 검색/상세 재열기와 불확정 상태 확인·미적용 확인 후 재적용은 소프트웨어로 구현했다. 실제 Raspberry Pi/BlueZ/ESP32-H2 다중 조명·그룹 및 장애 주입 HIL은 별도 검증으로 남는다.
- 이번 P0/P1 software 검증은 status Get, chunking, 3회 제한, timeout single-flight/drain, durable journal replay, ACK `eventId`/hash dedupe, 이력/안전 재적용 UI를 자동 테스트로 확인한 범위다. 실제 다중 fixture·층 전체·저장 구역·Mesh Group, Raspberry Pi/ESP32-H2 전원 차단, MQTT broker 단절, Gateway 프로세스 강제 종료를 조합한 HIL은 모두 미실행이며 자동 테스트 통과로 완료 처리하지 않는다.
- P0/P1은 구버전 혼합 배포가 안전하지 않다. 구버전 API/publisher를 stop-and-drain하고 migration을 적용한 뒤 신규 publisher·Gateway·API ACK consumer의 준비를 확인해야 status-check producer/API와 UI를 활성화할 수 있다. 자동 테스트는 실제 DB partial index·concurrent ACK 경합이나 RF/HIL의 증거가 아니며, 발행 시도 기록 직후 MQTT 호출 전 crash는 보수적으로 `unknown`을 남긴다.
- Health Current는 최신 snapshot만 사용하며 fault 이력과 제품별 code 설명은 아직 제공하지 않는다.
- 이력·상세는 조회 계약을 사용하고 후속 상태 확인·재적용 버튼은 현장의 control capability와 세션 잠금을 따른다. 읽기 전용 사용자의 제어 route 접근 제한은 기존 정책을 유지한다.
- Raspberry Pi Phase 0의 daemon/HCI/network/token 재연결은 통과했지만 ESP32-H2 provisioning과 0/25/50/100% 왕복, 2-node HIL은 아직 실기 검증이 필요하다.
- 자동 테스트 adapter는 `apps/gateway/test`에만 있고 양산 gateway runtime과 배포 진입점에는 포함되지 않는다.
- ESP32-H2 custom two-OTA partition은 각 slot `0x1f0000` 바이트다. Task 16 breaker fullclean test-build binary는 `0xefa30`(`981,552`) 바이트, free는 `0x1005d0`(`1,050,064`, 약 52%)다. Production release gate는 free가 slot 20%와 256 KiB 중 큰 값인 현재 `406,324` 바이트보다 작으면 build를 거부한다. 실제 production trust root는 미등록이라 production build는 IDF 실행 전에 정상적으로 fail-closed한다.
- gateway가 acceptance 기록 직후 재시작하면 자동 재제어하지 않고 불확정 결과를 보존한다. 운영자는 명령 이력에서 실제 상태를 확인하고 미적용이 확인된 경우에만 재적용할 수 있다. 재시작·상태 응답 유실의 실장비 검증은 미실행이다.
- API target 해석, 확정 fixture snapshot, delivery mode와 Mesh group ID/address/version 영속화, strict full retry 복구, fresh publisher fencing, outbox row 기반 pending timeout 직렬화, Gateway 병렬 unicast/group 단일 전송과 durable group state 수명주기, 신규 웹 target picker 연결까지 반영됐다.
- 자동 테스트와 ESP-IDF target build는 통과했지만 Raspberry Pi BlueZ, 실제 ESP32-H2 여러 대, 실제 MQTT broker를 연결한 group subscription, 단일 RF 전송, 지터 publication, timeout/패킷 손실 RF/HIL은 아직 수동 검증이 필요하다. 특히 조명 수 증가에 따른 Status 충돌률과 Gateway 8초 수집 timeout의 적정성은 현장 규모별로 측정해야 한다.
- `sessionStorage` 새로고침 복구와 ACK terminal 전 입력 잠금의 브라우저 계약 검증은 Task 7에서 완료했다. 격리 실백엔드 Chromium E2E에서 저장 구역 생성·수정·삭제와 개별·다중·층·구역 제어 4건의 terminal 결과를 검증했다. 2026-09-14 Raspberry Pi와 단일 BIO 조명의 vendor USB HIL은 개별·schedule·층·구역 제어까지 통과했다. BIO 다중 fixture와 표준 BlueZ/ESP32-H2 다중·층·구역 Mesh Group 실장비 검증은 남아 있다.
- 저장 구역 생성·수정·삭제·재동기화 Web dialog와 Chromium route fixture 검증은 완료됐다. 실제 Raspberry Pi와 BIO USB 동글을 연결한 단일 조명 zone 제어도 2026-09-14 실행해 통과했다. 표준 BlueZ/ESP32-H2 zone 제어와 Health Fault Clear callback 실기는 Gateway 프로세스 내부에서 BlueZ node owner 권한으로 전송할 API/IPC가 없어 `not_executed` 상태이며, 이 두 표준 Mesh 항목은 BIO HIL 통과로 완료 처리하지 않는다.
- advisory lock 회귀와 구역 에너지 이력 호출은 단위 테스트로 검증했다. 전체 suite에서는 세 opt-in DB URL이 없어 rollback 구역 생성 통합 회귀 1건이 skip됐지만, 이후 로컬 개발 PostgreSQL URL을 `ENERGY_DIMENSION_HISTORY_TEST_DATABASE_URL`로 명시한 별도 실행에서 구역·에너지 이력 생성과 rollback 1/1을 통과했다.
- Task 20 Fix Round 4에서 temp directory는 fixed lock의 owner/coordination 상태가 아닌 publish 후보로 유지하되, cleanup은 원본 temp를 같은 parent의 unique quarantine path로 먼저 atomic rename해 소유권을 확보한 뒤 quarantine 내부만 정리한다. quarantine 내부가 empty directory이거나 exact regular `.owner.<token>` marker 하나만 가진 경우에만 삭제하고, publisher가 먼저 temp를 fixed lock으로 rename하면 cleaner는 원본 temp `ENOENT`로 중단한다. cleaner가 먼저 quarantine하면 publisher는 `ENOENT` 후 같은 token으로 새 temp를 만들어 retry한다. fixed lock directory 자체는 quarantine하지 않는다. temp/quarantine symlink·non-directory·marker symlink·multi-entry·외부 sentinel은 따라가거나 삭제하지 않고 fixed lock 획득을 막지 않는다. fixed lock은 계속 token/PID/`ps` process-start identity를 exact marker로 확인해 active owner wait, stale/PID reuse takeover, unknown identity fail-closed, exact release, successor ABA 보호와 same-output 직렬화를 유지한다. production `scripts/esp32-h2-build.sh`는 Bluetooth SIG 자사 Company ID와 signed manufacturing approval이 없는 현재 `unprovisioned` policy에서 의도적으로 fail-closed한다. 이는 HIL 실패나 HIL 완료 증거가 아니다.

## 관련 파일

- `apps/gateway/src/bio/{bio-pulse-authority-provider,bio-node-link-monitor,bio-sensor-runtime,bio-sensor-profile-catalog}.ts`
- `apps/gateway/src/commands/bio-sensor-preparation-handler.ts`
- `apps/mobile/src/ios-focus-visibility.ts`, `apps/mobile/src/ios-focus-visibility.test.ts`, `apps/mobile/src/WebShell.tsx`, `apps/mobile/src/WebShell.ios-focus.test.tsx`, `apps/mobile/README.md`: 공통 iOS 입력 가시성 보정과 회귀·실행 안내.

- 모바일 제어 복구: `apps/web/src/features/control/active-command-store.ts`, `active-command-store.test.ts`, `ControlView.tsx`, `ControlView.test.tsx`, `apps/web/src/api/commands.ts`, `commands.test.ts`, `apps/web/src/AppRoot.tsx`(기존 정리 경로), `App.recovery.test.tsx`, `App.test.tsx`, `apps/web/e2e/control-map-target-selection.spec.ts`, `calm-operations-manual-control.spec.ts`.

- `apps/api/prisma/migrations/20260927150000_command_content_redaction/migration.sql`, `apps/api/src/commands/command-redacted-state.spec.ts`, `apps/api/src/commands/command-redacted-state.integration.spec.ts`

- `apps/gateway/src/commands/command-rf-drain.ts`, `apps/gateway/src/commands/gateway-command-handler.ts`, `apps/gateway/src/mesh/bluez-transport.ts`, `apps/gateway/src/mesh/bluez-mesh-adapter.ts`, `apps/gateway/src/bio/bio-usb-transport.ts`, `apps/gateway/src/bio/bio-dongle-client.ts`, `apps/gateway/src/adapters/bio-usb-dongle-adapter.ts`, `apps/gateway/src/index.ts`
- `apps/gateway/src/bio/bio-command-codec.ts`
- `apps/gateway/src/bio/bio-sensor-shadow-capture.ts`
- `apps/gateway/scripts/bio-sensor-shadow-analyze.ts`
- `apps/gateway/src/adapters/adapter-factory.ts`
- `apps/gateway/compose.bio-runtime.yml`
- `docs/runbooks/raspberry-pi-gateway-appliance.md`

- `apps/api/src/monitoring-refresh/monitoring-refresh-ingestion.service.ts`
- `apps/api/src/fixtures/fixture-presence-ingestion.service.ts`
- `apps/api/src/energy/fixture-state-ingestion.service.ts`
- `apps/api/src/automation/dto/automation-list.dto.ts`, `apps/api/src/automation/automation-list-filters.ts`, `apps/api/src/automation/schedules.service.ts`, `apps/api/src/automation/vehicle-event-rules.service.ts`
- `apps/api/src/mqtt/mqtt.service.ts`, `apps/api/src/mqtt/outbox-publisher.service.ts`, `apps/api/src/commands/command-status.service.ts`, `apps/api/src/commands/command-late-set-ack.service.ts`, `apps/api/src/commands/command-recovery-ack.service.ts`, `apps/api/src/commands/command-legacy-get-ack.service.ts`
- `apps/api/src/monitoring-incidents/monitoring-conditions.ts`
- `infra/mosquitto.acl.example`
- `scripts/dev-runtime.mjs`

- `apps/web/src/features/control/ControlView.tsx`
- `apps/web/src/features/control/active-command-store.ts`
- `apps/web/src/api/commands.ts`
- `apps/web/src/features/control/CommandHistoryPanel.tsx`
- `apps/web/src/features/control/CommandVerificationCases.tsx`
- `apps/web/src/features/control/CommandRiskReconcileDialog.tsx`
- `apps/web/src/features/control/control-time.ts`
- `apps/web/src/components/ui/session-status/SessionStatusProvider.tsx`
- `apps/web/src/components/ui/session-status/SessionStatusCenter.tsx`
- `apps/web/src/components/ui/session-status/ToastRegion.tsx`
- `apps/web/src/features/control/FixtureGroupDialog.tsx`
- `apps/web/src/features/control/FixtureGroupDialog.test.tsx`
- `apps/web/src/features/control/target-selection/FixtureGroupMapEditor.tsx`
- `apps/web/src/features/control/target-selection/FixtureGroupMapEditor.test.tsx`
- `apps/web/src/features/control/target-selection/SpatialTargetSelector.tsx`
- `apps/web/src/features/floor-map/FloorMapViewport.tsx`
- `apps/web/src/features/floor-map/FloorScene.tsx`
- `apps/web/src/features/control/automation/ControlModeTabs.tsx`
- `apps/web/src/features/control/automation/ScheduleControlPanel.tsx`
- `apps/web/src/features/control/automation/ScheduleDialog.tsx`
- `apps/web/src/features/control/automation/VehicleEventControlPanel.tsx`
- `apps/web/src/features/control/automation/VehicleEventDialog.tsx`
- `apps/web/src/features/control/automation/components/AutomationRuleCard.tsx`
- `apps/web/src/features/control/automation/components/AutomationRuleControls.tsx`
- `apps/web/src/features/control/automation/components/AutomationWorkspaceSurface.tsx`
- `apps/web/src/features/control/automation/components/useAutomationListState.ts`
- `apps/web/src/features/control/automation/components/useAutomationVisiblePagePoll.ts`
- `apps/web/src/features/control/automation/components/AutomationQuickFields.tsx`
- `apps/web/e2e/calm-operations-manual-control.spec.ts`
- `apps/web/e2e/calm-operations-automation.spec.ts`
- `apps/web/e2e/automation-control-flow.spec.ts`
- `apps/web/e2e/control-map-target-selection.spec.ts`

- `apps/api/prisma/migrations/20260914090000_manual_control_baseline/migration.sql`
- `docs/superpowers/plans/2026-09-14-manual-baseline-control.md`
- `docs/runbooks/raspberry-pi-gateway-appliance.md`
- `apps/web/src/features/control/CommandHistoryPanel.tsx`
- `apps/web/src/features/control/CommandHistoryPanel.test.tsx`
- `apps/web/src/features/control/CommandOutcomeActions.tsx`
- `apps/web/src/features/control/CommandOutcomeActions.test.tsx`
- `apps/api/src/commands/command-delivery-reliability.spec.ts`
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
- `apps/web/e2e/site-user-management.spec.ts`
- `apps/api/src/access/site-access.service.ts`
- `apps/api/src/commands/commands.service.ts`

- `apps/web/src/components/ui/SidePanel.tsx`

- `apps/web/src/features/transport-copy.ts`
- `apps/web/src/features/transport-copy.test.ts`
- `apps/api/src/automation/automation.controller.ts`
- `apps/api/src/sites/sites.service.ts`
- `apps/api/src/automation/automation.module.ts`
- `apps/api/src/automation/schedules.service.ts`
- `apps/api/src/automation/vehicle-event-rules.service.ts`
- `apps/api/src/automation/vehicle-sensor-capability.service.ts`
- `apps/api/src/automation/automation-mqtt-consumer.service.ts`
- `apps/api/src/automation/automation-outbox-publisher.service.ts`
- `apps/api/src/automation/automation-runtime.module.ts`
- `apps/gateway/src/automation/vehicle-event-runtime.ts`
- `apps/gateway/src/automation/automation-telemetry-handoff.ts`
- `apps/gateway/src/automation/automation-telemetry-outbox.ts`
- `apps/gateway/src/automation/automation-telemetry-gap-journal.ts`
- `apps/gateway/src/automation/automation-telemetry-coordinator.ts`
- `apps/gateway/src/automation/automation-storage.ts`
- `apps/gateway/src/storage/storage-headroom-manager.ts`
- `apps/gateway/src/automation/schedule-runtime.ts`
- `apps/gateway/src/automation/software-automation-simulator.ts`
- `apps/gateway/src/automation/software-automation-simulator.test.ts`
- `apps/gateway/src/runtime/gateway-mqtt-runtime.ts`
- `apps/api/src/automation/target-snapshot.service.ts`
- `apps/api/src/automation/automation-snapshot.service.ts`
- `apps/web/e2e/automation-control-flow.spec.ts`
- `apps/web/e2e/monitoring-control-flow.spec.ts`
- `apps/web/e2e/layout-assertions.spec.ts`
- `apps/web/e2e/support/layout-assertions.ts`
- `apps/web/e2e/support/real-backend-lab.ts`
- `apps/web/playwright.config.ts`
- `scripts/dev.mjs`
- `.superpowers/sdd/2026-08-29-schedule-vehicle-event-control/task-19-report.md`
- `.superpowers/sdd/2026-08-29-schedule-vehicle-event-control/task-20-report.md`
- `apps/api/src/automation/dto/schedule.dto.ts`
- `apps/api/src/automation/dto/vehicle-event-rule.dto.ts`
- `apps/web/src/api/automation.ts`
- `apps/web/src/api/queries.ts`
- `apps/web/src/features/control/ControlView.tsx`
- `apps/web/src/features/control/ControlTargetPicker.tsx`
- `apps/web/src/features/control/automation/VehicleEventControlPanel.tsx`
- `apps/web/src/features/control/automation/VehicleEventDialog.tsx`
- `apps/web/src/features/control/automation/vehicle-event-form.ts`
- `apps/web/src/features/control/automation/automation-presenters.ts`
- `apps/web/src/features/control/automation/automation-presenters.test.ts`
- `apps/web/src/features/control/automation/components/AutomationQuickFields.tsx`
- `apps/web/src/features/control/automation/components/AutomationQuickFields.test.tsx`
- `apps/api/src/automation/schedules.service.spec.ts`
- `apps/api/src/automation/vehicle-event-rules.service.spec.ts`
- `apps/api/test/automation-schedules.e2e-spec.ts`
- `apps/api/test/vehicle-event-rules.e2e-spec.ts`
- `apps/api/src/automation/vehicle-sensor-capability-schema.spec.ts`
- `apps/api/prisma/migrations/20260830_vehicle_sensor_source_invariants/migration.sql`
- `apps/api/prisma/migrations/20260830_add_vehicle_event_execution_list_index/migration.sql`
- `apps/api/prisma/migrations/20260901_automation_mqtt_delivery/migration.sql`
- `apps/api/prisma/migrations/20260904_bind_manual_execution_command_source/migration.sql`
- `apps/api/prisma/migrations/20260902_snapshot_backed_automation_execution/migration.sql`
- `packages/shared/src/automation-contracts.ts`
- `packages/shared/src/automation-action-result-contracts.ts`
- `packages/shared/package.json`
- `packages/shared/tsconfig.esm.json`
- `packages/shared/scripts/build.mjs`
- `packages/shared/scripts/build-output-lock.mjs`
- `packages/shared/src/build-output-lock.test.ts`
- `packages/shared/src/package-exports.test.ts`
- `packages/shared/src/mqtt.ts`
- `apps/web/src/features/control/ControlView.tsx`
- `apps/web/src/features/control/ControlTargetPicker.tsx`
- `apps/web/src/features/control/ControlView.test.tsx`
- `apps/web/src/components/ui/UnderlineNavigation.tsx`
- `apps/web/src/features/control/automation/ControlModeTabs.tsx`
- `apps/web/src/features/control/automation/ScheduleControlPanel.tsx`
- `apps/web/src/features/control/automation/ScheduleControlPanel.test.tsx`
- `apps/web/src/features/control/automation/VehicleEventControlPanel.tsx`
- `apps/web/src/features/control/automation/VehicleEventControlPanel.test.tsx`
- `apps/web/e2e/calm-operations-automation.spec.ts`
- `apps/web/e2e/calm-operations-manual-control.spec.ts`
- `apps/web/src/components/ui/Button.tsx`
- `apps/web/src/components/ui/Card.tsx`
- `apps/web/src/components/ui/PageHeader.tsx`
- `apps/web/src/components/ui/StatusBadge.tsx`
- `apps/web/src/components/ui/FeedbackState.tsx`
- `apps/web/src/styles.css`
- `apps/web/src/features/control/automation/automation-contracts.test.ts`
- `apps/web/src/features/control/automation/ScheduleDialog.tsx`
- `apps/web/src/features/control/automation/schedule-form.ts`
- `apps/web/src/features/control/automation/schedule-form.test.ts`
- `apps/web/src/api/automation.ts`
- `apps/web/src/api/automation.test.ts`
- `apps/web/vite.config.ts`
- `apps/web/scripts/audit-schedule-bundle.mjs`
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
- `apps/api/src/energy/energy-dimension-history.service.ts`
- `apps/api/src/energy/energy-dimension-history.service.spec.ts`
- `apps/api/src/energy/energy-dimension-history.integration.spec.ts`
- `apps/api/src/commands/command-dispatch.service.ts`
- `apps/api/src/commands/command-status.service.ts`
- `apps/web/src/api/commands.ts`
- `apps/web/src/features/control/active-command-store.ts`
- `packages/shared/src/dimming-command.ts`
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
- `apps/gateway/src/automation/automation-config-store.ts`
- `apps/gateway/src/automation/automation-runtime.ts`
- `apps/gateway/src/automation/automation-state-store.ts`
- `apps/gateway/src/automation/automation-arbiter.ts`
- `apps/gateway/src/automation/schedule-runtime.ts`
- `apps/gateway/src/automation/clock-trust-provider.ts`
- `apps/gateway/src/automation/automation-config-ack-outbox.ts`
- `apps/gateway/src/automation/automation-current-config-requester.ts`
- `apps/gateway/src/automation/automation-config-production-path.test.ts`
- `apps/gateway/src/runtime/gateway-mqtt-runtime.ts`
- `apps/gateway/src/runtime/background-mesh-resync.ts`
- `apps/gateway/src/commands/gateway-command-handler.ts`
- `packages/shared/src/command-delivery.ts`
- `packages/shared/src/gateway-contracts.ts`
- `apps/gateway/docker/mqtt-persistence.integration.mjs`
- `apps/web/e2e/automation-control-flow.spec.ts`
- `apps/web/e2e/support/real-backend-lab.ts`
- `packages/shared/src/automation-contracts.ts`
- `packages/shared/src/mqtt.ts`
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
- `apps/esp32-h2-firmware/main/vehicle_sensor_driver.c`
- `apps/esp32-h2-firmware/main/vehicle_sensor_driver.h`
- `apps/esp32-h2-firmware/main/vehicle_sensor_model.c`
- `apps/esp32-h2-firmware/main/vehicle_sensor_model.h`
- `apps/esp32-h2-firmware/main/vehicle_sensor_runtime.c`
- `apps/esp32-h2-firmware/main/vehicle_sensor_runtime.h`
- `apps/esp32-h2-firmware/main/vehicle_sensor_mesh_adapter.c`
- `apps/esp32-h2-firmware/main/vehicle_sensor_mesh_adapter.h`
- `apps/esp32-h2-firmware/main/vehicle_sensor_health.c`
- `apps/esp32-h2-firmware/main/vehicle_sensor_health.h`
- `apps/esp32-h2-firmware/partitions.csv`
- `apps/esp32-h2-firmware/manufacturing/production-trust-policy.conf`
- `apps/esp32-h2-firmware/patches/esp-idf-v5.5.1-server-send-ownership.patch`
- `apps/esp32-h2-firmware/patches/esp-idf-v5.5.1-server-send-ownership.conf`
- `apps/esp32-h2-firmware/patches/README.md`
- `apps/esp32-h2-firmware/sdkconfig.defaults`
- `apps/esp32-h2-firmware/test/native/test_vehicle_sensor_driver.c`
- `apps/esp32-h2-firmware/test/native/test_vehicle_sensor_model.c`
- `apps/esp32-h2-firmware/test/native/test_vehicle_sensor_mesh_adapter.c`
- `apps/esp32-h2-firmware/test/native/test_vehicle_sensor_health.c`
- `apps/esp32-h2-firmware/test/native/test_vehicle_sensor_model_target_artifact.sh`
- `apps/esp32-h2-firmware/test/host_fake/test_vehicle_sensor_model_runtime.c`
- `apps/esp32-h2-firmware/test/host_fake/test_vehicle_sensor_driver_integration.c`
- `apps/esp32-h2-firmware/test/host_fake/test_vehicle_sensor_host_fake.sh`
- `apps/esp32-h2-firmware/test/native/test_esp32_h2_artifact_audit.sh`
- `apps/esp32-h2-firmware/test/native/test_esp32_h2_artifact_attestation.sh`
- `apps/esp32-h2-firmware/test/native/test_esp32_h2_idf_patch_gate.sh`
- `apps/esp32-h2-firmware/test/native/test_esp_idf_server_send_boundary.sh`
- `apps/esp32-h2-firmware/test/native/test_esp32_h2_trust_policy.sh`
- `apps/esp32-h2-firmware/test/idf_patch_fake/test_server_send_boundary.c`
- `scripts/esp32-h2-idf-patch.sh`
- `scripts/esp32-h2-build.sh`
- `scripts/esp32-h2-flash.sh`
- `scripts/esp32-h2-artifact-audit.sh`
- `scripts/esp32-h2-manufacturing-approval.sh`
- `.superpowers/sdd/2026-08-29-schedule-vehicle-event-control/task-15-report.md`
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

제어 메뉴의 개별/그룹/스케줄/이벤트 제어 기능이 바뀌면 이 문서를 같은 작업 안에서 갱신한다. software E2E 또는 HIL 증거 상태가 바뀌면 두 상태를 분리해 함께 갱신하며, 실장비 미실행 항목을 자동 검증 결과로 완료 처리하지 않는다.

## 2026-09-27 상세 보관 종료 화면 (Task 5)

- 구현 완료: 완료 명령은 컴포넌트에 상세 사본을 남기지 않고 ID만 보관하여 동일 GET을 포커스·재연결 때 재검증한다. 재조회 중·오프라인 대기·401/403/404/410/500 실패에는 이전 대상·밝기와 재적용/상태 확인을 숨긴다. 열린 최근 이력·전체 이력·최근 결과는 UTC 달력 3개월 경계에서도 숨기고 서버를 다시 조회한다. DB UTC `generatedAt`/`retainedFrom`과 요청 시작 단조 시계를 사용하여 브라우저 벽시계 ±60초 오차를 제거한다. 전체 왕복 시간을 경과 시간에 포함하여 경계에서 조금 일찍 숨길 수 있다.
- 구현 완료: `410 command_expired`만 ‘상세 보관 종료’로 표시한다. 404는 원본 없음, 다른 오류는 조회 실패로 구분한다. 과거 UI 구현 기록과 달리 현재 case 상태 확인 요청·위험 승인 버튼은 서버 기능 준비 전이라는 이유와 함께 비활성이다. 기존 최근 명령의 `/commands/:id/status-checks`는 유지한다.
- 구현 완료: 원본 404/410만으로 잠금을 해제하지 않는다. 이전에 관측한 정확한 case와 새 인가된 exact 조회의 0건 응답이 있어야 해제하며 캐시·오류·재조회·오프라인 대기는 근거가 아니다.
- 미구현: case POST 서버 활성화, 운영 DB 적용·보관 flag ON·실제 조명 HIL. 기존 위험 승인 dialog와 API helper는 향후 연결을 위한 코드로 남으며 현재 화면에서 실행되지 않는다.
- 부족하거나 개선이 필요한 기능: 서버 시각이 없거나 잘못된 응답은 상세·행동 권한을 부여하지 않는다. 기본 OFF 모드도 DB 시각과 `retentionEnabled:false`를 반환하며 기존 미확정 상세·상태 확인을 유지한다. ON 모드만 달력 기한을 적용한다. 최종 API↔Web 실제 프록시 통합 증거는 총괄 통합 관문에서 별도로 기록한다.
- 관련 파일: `apps/web/src/api/{commands,detail-retention}.ts`, `apps/web/src/features/control/{ControlView,CommandVerificationCases}.tsx`와 해당 테스트.
- 갱신 규칙: 보관 기간·오류 표시·case POST 가용성 또는 캐시 재검증 정책 변경 시 이 항목과 회귀 테스트를 함께 갱신한다.
- 검토 보완: 2월 말 기록은 3개월 뒤 여러 날짜가 같은 2월 말로 보정되므로 cutoff가 자정에 되돌아갈 수 있다. 다음 만료 시각은 각 UTC 날짜의 경계를 따로 검사하며 평년·윤년의 첫 경계와 이후 보정 날짜에 열린 결과/목록을 숨기는 테스트로 검증한다. ON 모드의 `createdAt` 없는 응답도 숨긴다. 최초 제외 시점을 지난 응답은 월말 cutoff가 되돌아가도 새 서버 조회 없이 복원하지 않는다. 클릭 순간에도 동일한 단조 시계와 현재 캐시 권한을 검사한다.

## 2026-10-07 고객 공통 테마 전환 조작 영역 (Task9 handoff)

- 구현 완료: 고객 공통 헤더의 테마 전환은 승인52px frame과 shrink 방지를 사용해 둥근 모서리 안에서도 연속44px 조작 영역을 제공한다. 실제320/390 Chromium 양 테마에서 헤더 로고·현장 선택·알람과 겹침/가로 넘침 없이 확인했고 테마 전환으로 추가 API 쓰기0을 유지한다.
- 미구현·한계: 실제 모바일 장비/HIL 및 전체 Task9 통합 완료를 뜻하지 않는다. 일반 Button/IconButton·공개/인증/운영자 기본 크기와 토큰은 변경하지 않았다.
- 관련 파일: `apps/web/src/components/ui/theme/ThemeToggle.tsx`, `CustomerThemeProvider.test.tsx`, `apps/web/e2e/support/layout-assertions.ts`, `apps/web/e2e/statistics-flow.spec.ts`.
- 갱신 규칙: 공통 헤더의 frame·조작 영역 변경 시 영향받는 네 메뉴의 검증 범위와 실제 장비 한계를 함께 갱신한다.

## 2026-10-07 공통 Grid 정렬 헤더 조작 영역 보완

- 구현 완료: 공통 DataGrid의 표 정렬 헤더만 기존 `rounded-none`을 사용한다. 내용 너비·44px 높이의 버튼에서 둥근 모서리가 연속44px hit 영역을 깎지 않도록 한 국소 예외이며 일반 Button/IconButton·카드 방향 버튼·토큰은 유지한다.
- 미구현: 서버 전체 정렬·새 API·실제 장비 기능을 추가하지 않는다. 정렬은 전달된 현재 목록 범위다.
- 부족하거나 개선이 필요한 기능: 단위 소비 회귀와 격리1023px Chromium은 소프트웨어 fixture 검증이며 전체 반응형 행렬·native200%·실제 모바일/HIL 완료를 뜻하지 않는다. 실제 hit 결과는 같은 작업 보고서에 기록한다.
- 관련 파일: `apps/web/src/components/ui/DataGrid.tsx`, `DataGrid.test.tsx`, `docs/ui-spacing.md`.
- 갱신 규칙: 헤더 radius·높이·너비 변경 시 실제 연속44px hit 및 표/카드·키보드·현재 목록 안정 정렬·행 작업과 API 쓰기0을 함께 회귀 검증한다.
