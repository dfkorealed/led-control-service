# 설정 메뉴 기능 현황 및 구현 설계

> 모든 설계와 완료 판정은 양산 기준을 사용한다. 코드·자동 테스트 완료와 Raspberry Pi/ESP32-H2 실기 검증 완료를 구분하며, 실기 증거가 없으면 양산 E2E 완료로 표시하지 않는다.

기준일: 2026-09-11

## 현재 우선순위

- 2026-09-09 승인 맵 편집 개선은 소프트웨어 구현과 최종 회귀 검증을 완료했다. 층별 미배치 목록 드래그 배치, 단일 조명 우상단 `배치 해제`와 확인 팝업, Undo/Redo·검색·일괄 편집·등록 후 식별을 연결했다. 두 층 실제 API/DB 브라우저 E2E는 2026-09-10 통과했다. PDF/JPG/PNG 업로드·교체 및 CAD/AI 활용은 보류하되 기존 자산과 좌표는 보존한다. 최신 범위와 Task 1~11은 [에디터 설계](../superpowers/specs/2026-07-06-floor-editor-design.md) 및 [실행 계획](../superpowers/plans/2026-07-06-floor-editor-implementation.md)의 2026-09-09 절을 따른다. 실장비 검증·배포는 사용자 요청으로 후속이다.
- Scene 24~26 설정 개요·역할별 navigation·도면 목록/편집·비밀번호 변경 UI 교정은 완료했다. 새로운 설정 도메인 기능은 아래 미구현 목록과 후속 범위를 유지한다.
- 기존 맵 편집기는 계속 설정 메뉴가 소유하며, 저장한 배경, 도형, 텍스트, 색상과 조명 배치를 모니터링에서 읽기 전용으로 재사용한다.
- 현장 일반 유저 관리와 본인 비밀번호 변경은 구현 완료했다. MFA·세션 관리·공통 감사 조회, 현장/층 운영 CRUD, 조명/그룹 관리, 정책/알림, OTA, 외부 연동의 미구현 상태는 유지한다.
- BLE Mesh floor/zone Group Address와 subscription 동기화는 설정 화면 확장이 아니라 제어 기반 기능으로 구현한다. 기존 FixtureGroup 데이터만 사용하며 이번 범위에서 그룹 CRUD UI는 추가하지 않는다.
- Task 6에서 로그인 화면을 `loginId` 전용으로 정리하고 operator/customer shell을 분리했다. Task 7에서 operator는 설정을 포함한 고객 메뉴 대신 `/operator/site-admins` 전용 목록으로 replace되며, 현장·관리자 생성, 기존 현장 관리자 지정, 수정, 비밀번호 재설정과 삭제를 제공한다. 삭제는 현장명을 다시 입력한 경우에만 실행하며 해당 현장의 층·도면·조명·게이트웨이·제어·통계 데이터와 고객사 계정을 영구 삭제한다. Task 8에서 assigned admin의 최초 설치와 commissioning 역할 노출을 웹에 연결했다.

상세 계약은 `docs/superpowers/specs/2026-08-19-monitoring-control-focused-completion-design.md`를 따른다.

## 목표와 기능 경계

- 설정 메뉴를 현장 구성, 맵 관리, 장비 시운전, 운영 정책, 보안, 유지보수의 관리 허브로 만든다.
- 실시간 상태 확인은 모니터링, 조명 명령 실행은 제어, 에너지 분석은 통계에서 담당한다.
- 맵 편집기는 설정의 `맵 관리`에서만 열고, 모니터링은 읽기 전용 상태 확인에 한정한다.
- assigned customer `admin`이 자기 pending Site의 최초 주소·단가·시간대·층 설치와 Gateway claim·조명 검색·등록 commissioning API를 수행한다. Gateway claim은 Site row lock 뒤 할당·활성 상태·고객사 소속을 다시 확인하며, operator, 다른 admin, viewer는 고객 Site를 `404`로 접근할 수 없다. Task 9 격리 실백엔드 E2E가 이 웹/API 역할 계약을 검증했다.
- 설치 완료 후 고객사의 `admin`은 도면 배경, 도형, 조명 배치, 일반 조명 정보와 운영 정책을 직접 관리한다.
- 설정값은 임의 JSON 한 필드에 모으지 않고 검증 가능한 명시적 모델과 컬럼으로 관리한다.

## 권한 기준

| 기능 | operator | admin | viewer |
| --- | --- | --- | --- |
| 설정 조회 | 고객 현장 capability 없음 | 직접 배정된 한 현장 | 배정 현장 |
| 최초 현장·층 설치 | 금지 | 직접 배정된 pending 현장만 허용 | 금지 |
| Gateway claim·BLE Mesh 검색·provisioning | 금지 | 설치 완료 후 웹 UI와 API 허용 | 금지 |
| 현장 정보와 층 관리 | 금지 | 허용 | 금지 |
| 도면 배경·도형 편집 | 금지 | 허용 | 금지 |
| 조명 이름·정격전력·위치 편집 | 금지 | 허용 | 금지 |
| 그룹 관리와 운영 정책 | 금지 | 허용 | 금지 |
| 맵 버전 복구 | 금지 | 허용 | 금지 |
| Gateway 해제·장비 교체·초기화 | 후속 계약 확정 대기 | 후속 계약 확정 대기 | 금지 |
| 고객사 일반 유저 관리 | 금지 | 허용 | 금지 |
| 알림 규칙 | 후속 계약 확정 대기 | 후속 계약 확정 대기 | 금지 |
| operator 배정·인증서·OTA 변경 | 허용 | 금지 | 금지 |
| 편집 잠금 강제 해제 | 금지 | 허용 | 금지 |

- 프론트의 버튼 노출과 무관하게 모든 변경 API가 서버에서 조직, 현장 접근 범위와 역할을 검사한다.
- `operator`는 서비스 운영사 소속이지만 고객 Site의 `read/manage/commission` capability와 Site 목록을 갖지 않는다.
- `admin`은 `Site.adminUserId`로 직접 배정된 한 customer Site만 `read/manage/commission`할 수 있으며 같은 Organization의 다른 Site도 `404`다.
- `viewer`는 자기 고객사 조직 안에서도 `SiteMembership`으로 배정된 현장만 접근하며, membership의 `read | control` capability를 따른다.
- 마지막 고객사 admin은 비활성화하거나 viewer로 낮출 수 없다.
- operator 배정, 현장 초기화, Gateway 해제, 인증서 폐기, 전체 OTA에는 재인증과 감사 로그를 적용한다.
- admin은 자기 현장에 일반 유저만 생성할 수 있으며 두 번째 admin이나 operator를 생성·배정할 수 없다.

## 설정 정보 구조

| 하위 메뉴 | 책임 |
| --- | --- |
| 설정 개요 | 현장, 조명, Gateway, 사용자, 펌웨어 상태 요약과 필요한 조치 표시 |
| 현장 및 층 | 현장 기본 정보, 층 추가·수정·정렬·보관 |
| 맵 관리 | 층별 배경 도면, Konva 편집기, 버전 조회·복구 |
| 조명 및 그룹 | 조명 일반 정보, 그룹과 구성원 일괄 관리 |
| Gateway 및 네트워크 | Claim, 담당 층·구역, 연결·Mesh·인증서 진단 |
| 설치 및 시운전 | BLE Mesh 검색, provisioning, 배치, 통신 품질 검사, 시운전 보고서 |
| 운영 정책 | 오프라인·stale·명령 제한 시간, 디밍 범위, 정전 복구 정책 |
| 알림 | 장애 조건, 수신자, 채널, 지연·cooldown, 점검 시간 |
| 사용자 및 보안 | 초대, 역할, 현장 접근, MFA, 세션, 감사 로그 |
| 펌웨어 및 유지보수 | 버전, 서명된 OTA, 단계 배포, 중단·롤백, 인증서 수명주기 |
| 외부 연동 | API key, Webhook, BMS/BACnet 연동과 접근 범위 |

- PC 웹에서는 주 메뉴의 설정 항목 hover/focus disclosure로 역할별 하위 메뉴를 열고, 설정 본문은 별도 내부 사이드바 없이 평탄한 콘텐츠 계층으로 표시한다.
- coarse pointer에서는 설정 주 메뉴 활성화가 현재 route를 유지한 채 역할별 하위 메뉴 bottom sheet를 열며, 데스크톱 disclosure와 동일한 역할 필터와 API를 사용한다.
- 설정과 에디터는 URL을 가지며 새로고침, 브라우저 뒤로 가기와 직접 진입을 지원한다.

## 구현 완료

- admin 전용 `/settings/users`에서 현장 일반 유저를 최대 100명까지 조회·검색·생성·수정·비활성화·재활성화·비밀번호 초기화·영구 삭제한다. 일반 유저는 시스템 role `viewer`를 유지하고 현장 capability만 `read | control`로 분리한다. `control`은 `read`를 포함하며 admin 설정 화면에는 접근하지 못한다. 비활성화는 기존 세션을 즉시 폐기하고 재로그인을 차단하며, 영구 삭제는 로그인 아이디 확인 뒤 사용자·membership·세션을 제거한다. 비밀번호가 포함된 생성·초기화 요청은 React Query mutation cache를 사용하지 않고 응답·화면·trace에도 평문을 남기지 않는다.
- 사용자 수정과 상태 변경은 `expectedUpdatedAt`으로 충돌을 감지한다. 비밀번호 변경처럼 다른 요청이 user revision을 갱신해 상태 변경이 `SITE_USER_CHANGED`로 거부되면, UI는 최신 목록을 다시 조회해 사용자가 요청한 상태만 한 번 재시도한다. 서버는 모든 쓰기 transaction 안에서 호출자 admin과 대상 Site를 다시 인가한다.
- 맵 편집기의 오른쪽 속성·배치·레이어 영역은 이름 있는 공통 `SidePanel`과 `ui-side-panel-layout` overflow 계약을 사용한다. 긴 조명명과 속성값은 패널 폭 안에서 줄바꿈하고, 높이가 제한되면 오른쪽 영역 내부에서 스크롤해 속성 UI가 화면 밖으로 잘리지 않는다.

- 맵 편집 화면의 기능명과 진입 메뉴를 `맵 관리`/`맵 편집`으로 통일했다. 아무 요소도 선택하지 않으면 우측 속성 패널에는 맵 너비·높이·격자 간격만 표시하고, 조명 단일/다중 선택과 네모·세모·선·텍스트 선택 시에는 해당 요소에 유효한 속성만 표시한다. 선택이 바뀌면 속성 탭으로 자동 복귀한다.
- 맵 크기와 층별 격자 간격(5~200)을 `FloorPlan`에 저장한다. 배경 파일이 없는 층도 `sourceType = none`인 맵 설정을 저장할 수 있다. 격자 스냅은 화면 이동량이 아니라 맵 절대 좌표를 사용하며, 조명·도형의 생성·드롭·이동·크기 변경·키보드 이동에 동일하게 적용한다. 도형은 모서리와 변, 선은 양 끝, 조명은 비율 고정 모서리 핸들로 크기를 바꾼다. 도형 전체가 맵 경계 안에 남도록 보정하고, 기존 요소가 밖으로 밀려나는 맵 축소는 UI에서 거부한다. 격자는 고배율/대형 맵에서도 그리기 부하가 제한되며 배경 이미지 위에 표시된다.
- 2026-09-10 맵 편집 보강 검증: Shared 172개, API 825개(환경 의존 172개 skip), Web 512개 단위 테스트와 Web/API production build를 통과했다. Chromium은 1440/1024/390/320px 레이아웃, 선택별 패널, 20px 절대 격자 드래그를 포함한 25개 시나리오를 통과했다. Raspberry Pi/ESP32-H2 HIL 범위는 변경하지 않았다.
- 2026-09-10 맵 탐색과 정렬 보강: 마우스와 트랙패드 입력을 동일하게 취급해 휠 계열 입력은 포인터 중심 확대·축소, `이동` 도구의 드래그는 상하좌우 이동으로 처리한다. 조명·도형은 이동 중 포인터를 그대로 따라가고 이동을 끝낸 시점에만 가장 가까운 격자 좌표로 확정한다. 단순 도형 이동은 크기를 변경하지 않으며 리사이즈를 끝낼 때만 시작·끝 모서리를 격자에 맞춘다. 조명 단일·다중 이동과 도형 이동 중에는 맵 및 다른 요소의 좌·중앙·우, 상·중앙·하 정렬점에 6px 이내로 접근하면 PPT 방식의 가로·세로 보조선을 표시하고 임시 정렬한다. 격자 스냅이 켜져 있으면 이동 종료 시 격자 좌표가 최종 위치를 결정한다. Web 515개 단위 테스트, production build와 관련 Chromium 27개 시나리오를 통과했으며 DB/API 변경은 없다.
- 2026-09-10 최종 검증: 웹 단위 497개, 편집기 Chromium 29개 및 추가 성능 1개, 실제 설치 여정 2개, 두 층 배치 여정 1개 통과. 1,000개 배치 조명 준비 시간은 warm reload 20회 p95 220.6ms였다(mock API/macOS M2 Pro/Chromium, 운영 cold start 보장 아님). 실제 PostgreSQL 대량 저장 100회 main 재검증은 p95 549ms였다. 전체 결과와 재현 경로는 실행 계획에 기록했다.

- 테스트 데이터 도구는 단일 `VITE_TEST_DATA_TOOLS_ENABLED=true` opt-in 환경에서만 Web UI와 API를 활성화하며, off이면 endpoint가 `404`다. 설치 완료 현장의 assigned `admin` 설정 개요에만 생성·삭제 카드를 노출하며, 다른 역할이나 미설치 현장에는 노출하지 않는다. `POST/DELETE /test-data/sites/:siteId`로 현재 모든 층에 marker Gateway 1개와 MeshNode/Fixture 200개씩을 idempotent하게 생성한다. `led-control-test-data/v1/`과 `[TEST DATA] Fixture ` 접두사는 이 도구의 예약 namespace이며, Gateway·MeshNode·Fixture marker chain이 모두 일치하는 데이터만 삭제해 실제 장비 데이터는 보존한다. marker 장비에 예상하지 않은 노드·그룹·명령·통계 등 종속 데이터가 있으면 부분 삭제하지 않고 `409`로 전체 작업을 거부한다. 생성 직후 recent online으로 표시될 수 있으나 실제 heartbeat가 없으면 freshness 정책에 따라 offline으로 전환될 수 있으며, 실장비나 MQTT 동작을 시뮬레이션하는 기능은 아니다. 2026-09-10 전체 회귀는 API 824개와 Web 505개 단위 테스트, 양쪽 typecheck/build를 통과했다.

- 각 층 편집 route와 층 선택을 제공하고 지도·목록·선택·Undo/Redo·미리보기·편집권을 층별로 분리한다. 저장하지 않은 변경이 있으면 층 전환을 확인하며, 저장 응답이 늦게 도착해도 다른 층/계정의 작업을 덮어쓰지 않는다. 상단 층 배지도 편집 중인 층과 일치시킨다.
- 좌측 가상 목록에서 이름/시리얼/Mesh 주소 검색과 전체/배치/미배치 필터, 전체 선택을 제공한다. 미배치 조명을 드래그해 현재 확대율·팬 좌표의 포인터 위치에 배치하고, 배치 조명 검색 결과를 선택하면 해당 위치를 보여 준다. 선택한 한 조명 우상단의 휴지통은 장비 삭제가 아닌 `배치 해제`다. 확인 팝업의 취소는 변경하지 않고, 승인은 로컬 초안에서 미배치로 되돌린다. 저장 전에는 모니터링에 반영하지 않으며 Undo/재배치가 가능하다.
- 박스/Shift 선택, 다중 조명 이동, 화살표 이동, 격자 스냅, 정렬/균등 분배, 격자·선형 배치 미리보기/취소/적용과 이름·표시 크기·정격 W 일괄 속성을 제공한다. 잠기거나 숨긴 조명은 변경하지 않는다. 선형 배치는 좌·상 방향과 음수 각도도 처리한다. 조명 등록을 복제하거나 제어 그룹을 변경하지 않는다.
- 맵 맞춤·선택 맞춤·휠 줌·팬·미니맵, 배경/도형/조명 레이어 표시와 편집 잠금을 제공한다. 레이어 보기 상태와 조명 잠금은 편집 세션 상태이며 층 전환 시 초기화한다. 도형의 저장된 표시/잠금 속성은 기존 데이터로 유지한다. 화면 크기의 Konva Stage, 분리된 레이어, 조명 노드 memo와 안정적인 ref, 저배율 이름 생략으로 대량 편집을 처리한다.
- 저장 후 편집 화면을 유지하며 응답을 baseline/cache에 반영한다. 로컬 초안은 사용자/현장/층/revision으로 구분하고 복구 전 검증한다. 저장 중 초안 복구를 차단하며 인증 변경 시 저장소와 에디터 이력을 함께 비운다. `pagehide` keepalive 반납, BFCache 복귀의 새 편집권 획득과 `편집 권한 다시 요청`을 제공한다. 네트워크 손실로 반납에 실패하면 서버 lease 만료를 기다리며 다른 탭의 편집권을 강탈하지 않는다.
- 두 층 실제 API/PostgreSQL/Redis/MQTT 브라우저 E2E는 신규 미배치 등록, 드롭·저장·새로고침, 층 전환 취소/승인, 배치 해제 취소/승인/Undo, 모니터링 마커 분리, 미배치 조명 70% 제어 완료, 통계 대상 보존과 재배치까지 1개 통합 시나리오로 검증했다(2026-09-10, 43.9초). RF/장비 상태 송신은 테스트 전용 simulator이며 실제 BLE/LED 증거가 아니다.

- 등록 조명 위치 확인용 `POST /floors/:floorId/fixtures/:fixtureId/identify`와 전용 MQTT command/result를 구현했다. 현장 admin·현재 편집 lease·등록/연결 상태를 확인하고 10초 절대 만료와 게이트웨이별 단일 대상을 강제한다. 시작 시 lease 잔여가 10초 미만이면 갱신이 필요하다. 실제 Health Attention Status만 장비 응답으로 인정하며 PUBACK·응답 누락은 성공으로 표시하지 않는다. 정확한 session 중지, 오래된 중지/시작·중복·재시작 직후 명령 차단과 제한 시간/종료 정리를 포함한다. API/실DB·Redis 17개와 Gateway 관련 12개를 독립 재실행했다. 웹의 시작/중지/다음/건너뛰기/재시도와 명시적 위치 확인을 연결했다. ACK와 사람이 확인한 위치는 구분한다. 실제 broker/RF/LED 식별 검증은 후속이다.

- 층별 배치 상태를 `Fixture.placementStatus`와 `positionVerifiedAt`으로 분리했다. 신규 등록은 미배치, 기존 조명은 좌표를 보존한 배치/위치 미확인 상태다. 에디터는 미배치를 포함한 전체 조명과 검색용 시리얼/Mesh 주소를 반환한다. 배치 해제와 좌표 변경은 위치 확인만 무효화하며 장비·그룹·자동화·통계 정보는 유지한다. 새 snapshot V2와 기존 V1 복구를 함께 지원한다.
- 에디터 저장/복구를 묶음 SQL로 처리하고 JSON 요청 한도를 에디터 PUT에만 1 MiB로 확장했다. 초과는 413, 충돌은 409, transaction 만료는 503으로 구분한다. 실제 정격 W 변경에만 에너지 checkpoint를 생성한다. 격리 DB/HTTP 18개 회귀와 조명 1,000개·도형 2,000개 100회 저장을 통과했다. 관련 migration과 이번 `gridSize` migration은 로컬 개발 DB에 적용했으며 운영 DB에는 배포 절차의 백업·사전 검증을 거쳐 적용한다.

- 등록 후 위치 확인의 펌웨어 출력 단위를 보강했다. Health Attention은 자체 만료되며 명시적 중지·재시작에 대응한다. 식별 중 수동/자동제어의 최신 밝기 목표를 보존해 종료 후 복귀하고, 지연된 timer callback이나 PWM 오류 후 재시도가 새 요청을 덮어쓰지 않는다. Host 12개 시나리오·portable 테스트와 ESP-IDF 빌드를 통과했으며 API/Gateway/웹 통합은 진행 중이다. 실제 조명의 점멸·가시성 검증은 후속이다.

- 최초 setup, Gateway claim, 등록 대상·일괄/개별 form의 input/select와 checkbox/radio label은 390px·320px에서 연속 44×44px 이상 도달 가능한 영역을 제공한다. Chromium commissioning helper는 기본 일괄 form을 개별 mode 전환 전에 검사하고, 전환 뒤 개별 form도 별도로 검사하며, 버튼 외 모든 enabled interactive control을 스크롤한 뒤 viewport·overflow clipping과 실제 hit-test occlusion까지 확인한다.
- 조명 등록 `ProgressSteps`는 검색·등록 정보·장비 등록·상태 확인을 전체 session status union의 단일 상태 머신으로 표현한다. `completed`·`cancelled` terminal에는 current가 없고, session-level `failed`는 scan/node 도달 상태로 실패 단계를 정한다. 서버 transport 오류는 원시 API 값을 유지한 채 공통 표시 전용 mapper로 자연스러운 한국어 문구를 제공한다.
- 설정 주 메뉴는 desktop hover/focus와 Escape focus 복원, 자연스러운 Tab/Shift+Tab 순서, admin/viewer별 링크 노출, coarse pointer bottom sheet와 `siteId` 및 hash fragment 보존을 Chromium route fixture로 검증한다. desktop trigger는 query string과 hash를 유지한 `/settings` 개요 링크이고 coarse trigger는 현재 route를 유지하는 `button[type="button"]`이며, 두 변형 모두 stable `aria-controls`와 `aria-expanded`로 popup과 연결된다. 모바일 sheet는 scrim·grabber·제목을 갖고 첫 허용 링크로 focus를 이동하며 Escape는 trigger로 focus를 복원한다. popup은 `nav aria-label="설정 메뉴"` 안의 목록과 일반 링크를 사용하며 focus trap이나 roving tabindex를 주장하지 않는다. desktop parent는 하위 route에서 시각적 active 상태만 유지하고 `aria-current`를 노출하지 않으며, 개요는 exact `/settings`, 도면·보안은 각각 자신의 route에서만 `aria-current="page"`를 갖는다. coarse button은 현재 페이지로 표시하지 않는다.
- dirty 맵 편집 중 coarse 설정 button을 여는 동작은 confirm, route 변경, draft 폐기를 발생시키지 않는다. sheet의 실제 하위 링크는 기존 dirty navigation guard를 그대로 통과하며, 취소하면 editor·sheet·draft와 선택한 submenu focus를 유지하고 확인하면 선택한 하위 route에 동일한 `siteId`와 hash를 보존해 이동하며 draft를 폐기한다. 390px/320px 실제 브라우저 회귀는 real draft 변경, cancel/confirm, 승인 직후와 editor 복귀 뒤 history state의 sentinel 제거, back/forward 왕복 및 추가 clean logout이 폐기 확인 없이 완료되는 계약을 검증한다.
- 설정·맵 편집 화면은 1440×900, 1024×768, 390×844, 320×740에서 overflow와 패널 배치를 고정한다. 1024px 및 390px/320px의 설정 개요·admin 비밀번호 화면과 viewer security guard, 모바일 floor asset·속성 필드·revision action을 실제 route에서 검증한다. 760px 이하의 공통 helper는 root 아래 interactive element 중 disabled/hidden, `.sr-only`/`aria-hidden`, `display`/`visibility`/`opacity`로 숨긴 조상을 제외하고 현재 viewport 및 실제 overflow clip과 교차하는 effective target을 검사한다. usable intersection을 1 CSS px 이하 cell로 나누고 각 cell 중앙 hit sample이 target 또는 그 descendant인 연속 44×44px 후보가 하나 이상일 때만 통과하며, 부분·완전 occlusion은 정상 peer가 있어도 실패한다. checkbox/radio는 모든 associated label과 input fallback 중 이 조건을 만족하는 후보를 사용한다. viewport-fixed target은 transform/filter/perspective 등 fixed containing block을 만드는 조상이 있을 때만 ancestor overflow clip을 적용한다. sheet가 열린 동안은 실제 navigation popup root를 검사하고, 배경 route는 이동 뒤 별도로 검사한다.
- 주 메뉴의 설정 항목은 데스크톱 click으로 query string을 유지한 `/settings` 개요로 이동하고 hover/focus로 역할별 disclosure를 연다. coarse pointer click은 route를 바꾸지 않고 하단 sheet를 열어 `설정 개요`를 포함한 허용 메뉴를 선택하게 한다. 외부 pointer, blur, Escape와 route 변경은 disclosure를 닫는다.
- 설정 본문의 내부 `설정 메뉴` 사이드바를 제거하고 현장 선택기를 수평 context row에 유지했다. 기존 현장 전환 dirty 확인 및 editor store 폐기, 상세 route와 `siteId` query 보존 계약은 그대로 유지한다.
- 설정 메뉴에는 역할별로 승인된 화면만 노출한다. admin은 `설정 개요`, `조명 등록`, `맵 관리`, `비밀번호 변경`을 사용하고 viewer는 `설정 개요`, `맵 관리`만 읽기 전용으로 사용한다. 기존 미구현 placeholder 메뉴와 customer 설정의 operator 노출은 제거했다.
- Scene 24 설정 개요는 현재 dashboard/role/route 데이터만 사용해 `현장 정보`, `층·도면`, `Gateway 상태`, admin 전용 `계정·보안` 카드를 표시한다. 맵 관리와 비밀번호 변경 action은 실제 route 링크이고 현재 `siteId` query와 hash fragment를 보존한다. firmware, session, 마지막 변경 시각처럼 현재 API가 반환하지 않는 값은 표시하지 않는다.
- operator가 만든 pending Site는 assigned admin이 customer route에서 `/settings?siteId=...`로 replace된 최초 설치 UI에서 address, tariff, timeZone, floors로 완성한다. CustomerShell은 installationStatus 확인 전 child route를 fail-closed하고, `POST /setup/initial-site`에는 `{ siteId, address, tariffKwhRate, timeZone?, floors }`만 전송한다. 성공하면 정확한 dashboard key를 갱신하고 dashboard prefix를 invalidate한다. Task 9 격리 실백엔드 E2E는 이 흐름과 password 교체 후 이전 비밀번호 실패/새 비밀번호 로그인을 검증했다. 재설치와 모바일은 범위 밖이고 Raspberry Pi/ESP32-H2 HIL은 미실행이다.
- 설치 완료 뒤 admin은 admin 전용 `/settings/registration`에서 Gateway claim 또는 조명 등록을 수행할 수 있다. 모니터링은 등록 0개 상태에서도 이 mutation UI를 렌더링하지 않는다. viewer는 claim, registration, setup mutation UI를 보지 않고 operator는 전용 shell 때문에 customer 설정에 진입하지 않는다.
- Scene 04~09 설치·Gateway claim·조명 검색·일괄/개별 등록·상태 확인 화면은 공통 `Card`, `Button`, `StatusBadge`, `FeedbackState`, `ProgressSteps`로 정보 위계를 표시한다. 초기 설치는 현장 정보부터 운영 시작까지, 등록은 검색·등록 정보·장비 등록·상태 확인 단계를 실제 session 상태로 표현한다.
- 설치·claim·registration UI는 기존 실제 setup/claim/registration API payload, query key, mutation, active session polling·복구와 cache invalidation을 그대로 사용한다. `reconcile_required` 노드는 기존 명시적 확인·제외·상태 재조회 흐름을 유지하며 viewer와 operator에는 mutation UI를 노출하지 않는다.
- Ethernet, mTLS, 장비 online 같은 prototype 전용 사전 점검은 현재 API가 제공하지 않아 구현하지 않았다. `calm-operations-commissioning.spec.ts`의 browser fixture는 화면·API route 계약 검증일 뿐 Raspberry Pi/ESP32-H2 hardware-in-the-loop 증거가 아니다.
- Scene 26 비밀번호 변경은 현재/새/확인 비밀번호, 기존 최소 8자 검증, 확인 불일치, 정확한 현재 비밀번호 오류, 일반 오류와 중복 제출 차단을 공통 danger/success feedback으로 표시한다. 평문 비밀번호는 React Query mutation/cache에 넣지 않고 component-local state와 요청 본문에만 두며, 성공 또는 화면 이탈 시 제거하고 실패 시 재시도 입력을 유지한다. 성공 시 현재 세션은 유지하고 기존 API가 동일 사용자의 다른 활성 세션만 revoke하는 동작을 변경하지 않았다.
- Scene 25~26 도면 목록과 편집 route의 편집 가능 역할은 assigned admin만이다. admin은 등록/편집 action을 사용하고 viewer는 neutral `읽기 전용` 상태와 저장된 도면만 보며, operator는 customer shell을 mount하지 않는다. 편집기는 도구 rail·canvas·속성·버전 region을 유지하고 lease 상실은 읽기 전용 warning, `409`는 강제 덮어쓰기 없이 `최신 버전 다시 불러오기`만 제공한다.
- 맵 editor의 lease token/fence heartbeat와 fail-closed deadline, atomic save, dirty confirm/cancel 및 browser history sentinel, revision 조회·복구, asset upload 중 save/restore lock은 기존 상태와 callback을 그대로 사용한다.
- `POST /setup/initial-site`는 assigned active customer `admin`만 `{ siteId, address, tariffKwhRate, timeZone?, floors }`로 호출할 수 있다. transaction 안에서 target Site row를 `FOR UPDATE`로 잠그고 assigned admin 및 pending 상태를 재검증한 뒤 기존 Site와 Floors/FloorPlan만 갱신한다.
- 최초 설치는 Organization, Site, SiteMembership을 새로 만들지 않으며 주소·단가·층 중 하나라도 없으면 `pending`, 모두 있으면 `installed`다. 재호출과 Serializable 충돌은 `409`로 반환한다.
- `POST /setup/floors`도 assigned admin의 `commission` capability를 요구한다. 기존 floor 이름·level 중복과 floorPlan 생성 검증은 유지한다.
- `POST /gateways/claim`과 모든 `registration-sessions` route는 `admin` controller role 및 service의 active customer admin + 대상 Site `commission` 검사를 함께 적용한다. registration mutation은 create body 또는 저장된 session의 `siteId`를 권위 데이터로 사용해 transaction 첫 단계에서 Site를 잠그고 권한을 재검증하며, 이후 `Site -> Gateway -> Session -> Node` 순서로 필요한 행만 잠근다. get/identify는 read-only service 권한 검사만 수행한다.
- Gateway firmware version은 사용자 입력이 아니라 heartbeat로 자동 갱신한다.
- 설정 개요에 현장 정보, 층·도면, Gateway 상태, admin 계정·보안을 구분한 실제 데이터 카드와 route action을 제공한다.
- Gateway 이름, 시리얼과 온라인·오프라인 상태를 실제 dashboard 응답으로 표시한다.
- 등록 패널은 층과 Gateway를 명시적으로 선택해 `siteId`, `floorId`, `gatewayId`를 전송하고 BLE Mesh 후보·provisioning 요청을 제공한다. 설치 완료 assigned admin에게만 노출되며 viewer와 operator는 볼 수 없다. Task 9 격리 실백엔드 E2E는 0건 검색, 재검색, 자사 node 2개 일괄 등록을 검증했다. API는 Gateway heartbeat가 정확히 90초 전인 경우까지 fresh로 허용한다.
- provisioning 완료 이벤트로 `MeshNode`와 `Fixture`를 만들고 실패 이벤트의 사유를 저장한다. 새 Fixture는 `offline + provisioning_waiting_state`로 만들며, 첫 실제 fixture-state 전에는 online/fault, 밝기, lastSeenAt을 확정하지 않는다. 다른 현장 UUID 재사용 또는 `MeshNode.deviceUuid` unique 경쟁만 해당 node 실패로 기록하며, 다른 unique/transaction 오류는 재전파한다.
- 제조 장비 원장 기반 `POST /gateways/claim`은 assigned active customer admin만 수행한다. claim은 serial trim 정규화 뒤 serial별 PostgreSQL transaction advisory lock으로 같은 serial 시도를 직렬화하고, 같은 transaction에서 Site 잠금 재검증, 15분 실패 횟수 판정, terminal audit, inventory 잠금과 단회 claim-code 소비를 완료한다. invalid·unavailable·already-consumed·rate-limited·success를 모두 commit한 뒤 기존 정제된 `401/409/429`로 변환하며 claim code와 내부 reason을 응답에 노출하지 않는다. 다른 serial은 전역 잠금을 공유하지 않는다. device-certificate 기반 `POST /gateway-bootstrap`과 manufacturing enrollment 경계는 바꾸지 않았다.
- `POST /gateway-inventories/:inventoryId/disable`은 고객 commissioning이 아닌 제조 보안 동작으로 active service-provider `operator`만 수행하며 customer SiteAccess를 요구하지 않는다. inventory disable 뒤 certificate revocation 동작도 유지한다.
- Claim 성공과 invalid·unavailable·already-consumed·rate-limited terminal 결과를 모두 감사하며, 병렬 invalid 요청도 serial별 선형화 경계에서 최대 5회의 비싼 claim-code 검증만 수행한다.
- Raspberry Pi appliance가 실제 BlueZ scan/provisioning adapter와 영속 Mesh identity를 사용한다.
- 실제 Gateway MQTT scan 이벤트만 후보로 저장하며 런타임 mock 검색 경로는 제거했다.
- 실제 Gateway scan은 shared DFK product identity 계약을 통과한 ESP32-H2 UUID만 등록 후보로 반환한다. UUID 필터는 제품 식별용이며 제조 원장, claim과 Gateway mTLS 인증을 대체하지 않는다.
- 층별 자동 조명 이름 순번과 게이트웨이별 Mesh unicast 주소를 PostgreSQL 소유 행 잠금으로 원자 예약하는 기반을 구현했다. Mesh 주소는 `0x0001~0x7fff` 범위를 벗어나면 등록을 거부한다.
- 일괄·개별 조명 등록 API는 유효한 node만 원자 예약하고 node별 검증 실패를 분리한다. 신규 조명은 지도 공간과 무관하게 미배치로 등록한다. 구버전 placement 입력은 호환 수신하되 좌표로 적용하지 않는다. 불명확한 provisioning 결과는 `reconcile_required`로 격리한다.
- 조명 등록 화면의 검색 node 개별/전체 선택, 일괄·개별 설정 전환과 선택 조명 등록은 설치 완료 assigned admin의 commissioning UI로 노출된다. viewer와 operator에는 mutation UI를 노출하지 않는다. Task 9 software E2E는 production API와 test-support MQTT publisher 경로를 검증했고 shared `parseDfkDeviceUuid`로 invalid/타사 UUID 1개가 scan-found에서 제외됨을 확인했다. 실제 BlueZ/RF Gateway scan과 Raspberry Pi/ESP32-H2 HIL은 미실행이다.
- Konva 에디터의 사각형·삼각형·선·텍스트, 색상, 이동, 크기 변경, 조명 정보·위치 편집과 확대·축소를 유지한다. 기존 파일 배경은 표시하지만 신규 도면 업로드/교체 진입점은 보류 정책에 따라 숨긴다. 기존 자산을 삭제하거나 좌표를 다시 생성하지 않는다.
- 맵 편집기 toolbar와 revision 복구 icon action은 desktop과 760px 이하 layout에서 표시·동작을 검증한다. 760px 이하에서는 선택 fixture의 조명명·정격 전력·X/Y·크기 property input과 revision 복구를 포함해 위 helper 정의에 해당하는 control의 실제 usable intersection이 최소 44×44px를 유지한다. 360px 이하 toolbar는 3열로 wrap해 마지막 action이 가로 clip에 걸리지 않게 한다.
- 설정 에디터와 모니터링 읽기 전용 지도는 `FloorMapObjectNode`의 사각형·삼각형·선·텍스트 geometry를 공유한다. Transformer, drag와 변경 callback은 설정 에디터에서만 활성화한다.
- PDF/JPG/PNG 원본과 렌더링 결과를 S3 호환 저장소에 저장하고 준비 완료된 asset URL만 도면에 연결한다.
- `owner`를 제거하고 `operator/admin/viewer` 3단계 역할과 서비스 운영사/고객사 Organization 유형을 Prisma schema에 적용했다. legacy migration은 현장 유무로 서비스 운영사를 추론하지 않으며 기존 Organization을 모두 customer로, legacy owner/operator와 invitation을 admin으로 유지한다.
- 기존 viewer가 고객사 현장 조회 권한을 유지하도록 `SiteMembership`을 비파괴 migration에서 backfill한다.
- invitation signup은 viewer 초대 전용 호환 API다. `{ token, loginId, email, name, password }`에서 `Invitation.email`은 연락 이메일과만 비교하고 정규화한 `loginId`를 별도 로그인 식별자로 저장한다. 공개 signup UI는 Task 6에서 제거했으며 API 호환만 유지한다. operator/admin invitation signup은 거부하며 viewer는 자기 고객사 Organization에 속한 유효한 `Invitation.siteId`의 membership을 transaction으로 생성한다.
- operator site-admin 관리 API는 `GET/POST /operator/site-admins`, `POST /operator/sites/:siteId/admin`, `PATCH /operator/site-admins/:userId`, `POST /operator/site-admins/:userId/reset-password`, `DELETE /operator/site-admins/:userId`를 제공한다. 생성·교체·수정·비밀번호 재설정·삭제는 active service-provider operator만 호출할 수 있다. 삭제 요청은 body의 `confirmationSiteName`이 현재 현장명과 정확히 일치해야 한다. 서버는 같은 DB transaction에서 GatewayInventory를 비활성화하고 `SiteDeletionCleanup` 작업을 생성한 뒤 Site 소유 데이터 전체를 cascade 삭제한다. 고객사에 남은 현장이 없으면 admin·viewer 세션, 사용자, 초대와 customer Organization도 삭제한다. 삭제할 사용자를 먼저 잠가 동시 로그인 세션 생성을 차단한다. 커밋 뒤 cleanup worker가 Gateway 인증서를 즉시 폐기하고, 기존 presigned upload URL이 만료된 뒤 도면 원본 파일을 삭제한다. 외부 정리 실패는 lease와 지수 backoff로 재시도한다. 다른 Gateway에 claim된 인증서 inventory가 연결된 비정상 데이터는 `409`로 중단해 타 현장 장비를 보호한다. 제조 장비·인증서 원장, 완료된 cleanup 작업과 service-provider 감사 로그 `operator.site_deleted`는 보존한다. 비밀번호와 hash는 응답 및 audit metadata에 포함하지 않는다. Task 7의 operator 전용 웹 목록은 이 여섯 endpoint를 소비한다. create/assign/reset의 평문 비밀번호는 React Query cache, API response 또는 완료 안내에 저장하지 않고, 성공 또는 사용자가 dialog를 닫을 때 component input state에서 제거한다. 실패 뒤 열린 dialog의 입력은 재시도를 위해 유지한다. `ApiError.body.message`가 정확히 `loginId already exists`인 409만 loginId field 오류와 focus로 연결하고, serialization 등 다른 409는 재시도 alert로 표시한다.
- operator 초기/reset 비밀번호 입력은 서버와 같은 최소 8자를 client에서 검사하고 서버의 password-policy `400`도 field alert로 표시한다. 현장 삭제 dialog는 현장명을 정확히 입력하기 전 `영구 삭제` 버튼을 비활성화하고, 성공 뒤 제거된 행 대신 안정적인 `현장 및 관리자 생성` command로 focus를 복원한다. API/Web 단위 테스트와 실제 PostgreSQL 통합 테스트로 고객사·현장·계정·세션 삭제를 검증한다.
- `PUT /floors/:floorId/editor-state`는 `Floor.mapRevision` optimistic update, normalized row 변경, canonical `FloorMapRevision` snapshot/SHA-256과 `floor_editor.saved` 감사를 하나의 Serializable Prisma transaction으로 저장한다. fixture/object의 층 소속, 중복 ID와 준비되지 않은 asset은 optimistic mutation 전에 거부한다.
- `GET /floors/:floorId/editor-revisions`는 현장 `read`, `POST /floors/:floorId/editor-revisions/:revision/restore`는 `manage` 권한을 요구한다. 복구는 `expectedRevision` 충돌을 `409`로 처리하고, 사라진 fixture를 생성하지 않고 `skippedFixtureIds`로 반환하며 새 revision과 `floor_editor.restored` 감사를 같은 transaction에 남긴다.
- atomic save의 `floorPlan: null`만 배경 삭제를 뜻한다. non-null image/pdf는 source type, ready asset을 가리키는 non-empty `imageUrl`/`originalFileUrl`/`renderedImageUrl`, 양수 INT4 width/height를 모두 포함해야 하며 부분 create/default 값 우회는 `400`으로 거부한다.
- legacy `PATCH /floors/:floorId/floor-plan`은 partial request를 기존 row와 merge해 검증한 complete `effective` 전체 상태를 기록한다. 동시 PATCH도 마지막 writer가 검증한 `none` 또는 complete ready image/pdf 상태로 끝나며 row lock이나 별도 transaction에 의존하지 않는다.
- atomic write schema와 persisted snapshot v1 parser를 분리했다. snapshot parser는 기존 `sourceType: none`, nullable floor-plan URL, nullable geometry와 bounded legacy object type을 canonical shape 그대로 읽고 복구하며, 상한 초과 문자열이나 좌표 배열이 아닌 points 같은 위험 데이터는 `400`으로 거부한다.
- shared editor schema는 fixture update 1,000개와 map object mutation 합계 2,000개를 상한으로 두고 ID/이름/URL/text/color/points 크기, INT4 revision/zIndex와 rectangle/triangle/line/text별 dimensions/points 형태를 제한한다. trim, decimal과 object type 의미 정규화는 optimistic update 전에 끝난다.
- object update는 현재 type/width/height/points를 같은 층에서 먼저 조회하고 patch를 merge한 완성 geometry를 type별 schema로 검증한 뒤에만 optimistic revision을 증가시킨다. restore는 floor `manage` SiteAccess의 opaque `404`를 먼저 적용하고, 권한 확인 뒤 service에서 path revision을 positive INT4로 검증해 authorized invalid path만 `400`으로 반환한다.
- revision 목록은 `cursor`와 `limit`(기본 20, 최대 100)을 사용한다. 응답 actor는 같은 고객사 이름 또는 교차 조직의 `서비스 운영자` display name만 포함하며 user/revision 내부 ID와 email을 노출하지 않는다.
- revision snapshot/hash는 ID canonical order를 유지하지만 GET/save/restore editor state의 object 배열은 canvas 계약에 맞게 `zIndex`, `createdAt`, ID 순으로 안정 정렬한다.
- bootstrap은 기존 customer 사용자가 있어도 `auth:bootstrap-operator`로 최초 service-provider operator를 만들 수 있다. `BOOTSTRAP_OPERATOR_LOGIN_ID`는 필수이며 잘못된 기존 email 환경 변수로 fallback하지 않는다. PostgreSQL advisory lock, 기존 service provider/operator 검사, `service_provider` partial Unique index로 둘 이상의 서비스 운영사를 차단하며, 로그인/session 응답은 `loginId`와 Organization 유형을 포함한다.
- `POST /auth/login`은 `{ loginId, password, rememberMe }`만 받고 public/session 응답은 연락 이메일 없이 `loginId`만 계정 식별자로 포함한다. `POST /auth/change-password`는 현재 session cookie를 기준으로 현재 세션을 유지하면서 동일 사용자의 다른 활성 세션을 revoke하고, 공백을 포함한 비밀번호 원문을 trim하지 않는다. login/signup/change-password body는 누락·non-string 값을 controller에서 명시적으로 거부해 500으로 흘리지 않는다. 성공 감사 `auth.password_changed` metadata에는 비밀번호 또는 hash 계열 값을 기록하지 않는다.
- login은 User row를 `FOR UPDATE`로 잠근 transaction 안에서 status, organization과 password hash를 다시 읽고 검증한 뒤 Session을 생성한다. operator reset과 self change는 같은 User lock 순서를 사용하고 이후 활성 세션을 revoke하며, 실제 PostgreSQL barrier 회귀가 old credential session이 reset/change commit 뒤 남지 않음을 검증한다. Web login은 React Query mutation을 사용하지 않고 성공 직전에 이전 principal의 Query/Mutation cache를 비운 뒤 반환된 `auth/me`를 직접 설정한다. 강제 session revoke는 tenant cache를 제거한 뒤 로그인 화면으로 전환하고, 다른 탭의 로그인으로 `auth/me`가 A에서 B로 성공 전환되면 고객 shell 렌더 전에 이전 Query/Mutation cache를 제거한다.
- 일반 admin 영속 write는 외부 SiteAccess precheck를 UX 최적화로만 사용한다. dimming command create, fixture-group create/update/delete/resync와 floor-editor save/restore는 transaction 첫 단계에서 Site row를 잠그고 assigned active customer admin을 다시 확인하며, reassignment/disable race는 실제 PostgreSQL 회귀로 차단한다.
- 수정 전 legacy migration을 적용한 로컬 개발 DB는 checksum 충돌이 발생할 수 있다. 데이터가 불필요한 경우에만 reset을 선택하고, 보존이 필요하면 감사 후 수동 보정 migration을 사용한다. 설정 기능은 자동 reset이나 파괴적 DB 명령을 실행하지 않는다.
- **폐기된 Task 4 시점 기록:** 당시 registration session 생성·조회·identify·register·complete는 operator controller 계약이라 새 SiteAccess 완료 경로로 사용할 수 없었다. 현재 Task 5 API는 assigned admin controller/service 이중 검사와 mutation transaction 내부 재검증까지 완료했고, Task 8에서 설치 완료 admin의 웹 commissioning 진입점을 연결했다.
- `GET /floors/:floorId/assets`는 현장 `read` 권한, upload intent와 complete는 `manage` 권한을 확인해 customer admin의 설치 후 도면 교체를 허용하고 viewer 변경은 차단한다.
- 주 메뉴를 `/monitoring`, `/control`, `/statistics`, `/settings` URL route와 링크 navigation으로 전환했다. 이 고객 shell은 admin/viewer만 mount하며 선택 현장의 `siteId` query는 주 메뉴와 설정 하위 메뉴 이동에도 유지된다.
- operator는 전용 `OperatorShell`만 mount한다. `/settings`와 하위 경로를 포함한 operator 직접 URL/새로고침은 history replace로 `/operator/site-admins`에 수렴하고 `/sites` 또는 dashboard query를 실행하지 않는다. 현재 route는 header, 로그인 아이디, 로그아웃과 현장 관리자 운영 테이블을 제공한다. dialog는 `role="dialog"`, `aria-modal`, Escape/취소, 최초 focus와 trigger focus 복원을 지원한다. assign/delete 성공처럼 기존 trigger가 목록 refetch에서 제거될 수 있는 경우에는 안정적인 `현장 및 관리자 생성` command로 focus를 복원하며, 작은 화면에서는 표를 가로 스크롤한다.
- `/settings/floor-plans`는 admin/viewer가 새로고침과 직접 진입할 수 있는 층별 도면 목록을 제공한다. assigned admin만 서버 SiteAccess에 따라 실제 편집할 수 있다.
- `/settings/floor-plans/:floorId/edit`는 route param으로 `GET /floors/:floorId/editor-state`를 조회한다. viewer의 직접 edit URL은 목록으로 redirect되고 assigned admin은 편집할 수 있다.
- 웹 에디터는 shared `SaveEditorStateInput` 계약으로 baseline과 현재 상태를 O(n) 비교한다. 1,000개 fixture에서도 실제 변경된 fixture와 floor plan, object create/update/delete만 중복 없이 `PUT /floors/:floorId/editor-state` 한 번으로 전송한다. floor plan의 `null`/`none`, 기본 source type과 fallback asset URL은 API 의미 형태로 정규화해 unchanged 저장을 만들지 않으며 draft object ID는 UUID로 생성한다.
- atomic save와 revision 복구는 하나의 동기 ref lock으로 상호 배제한다. 요청 중 도구, 캔버스, 배경 입력과 속성 입력을 disabled/read-only로 유지하고, 이미 시작된 배경 asset upload가 끝날 때까지 save/restore도 막아 요청 이후 로컬 수정이 성공 응답에 덮이지 않게 한다. 성공 응답은 새 baseline과 `mapRevision`으로 채택하고, 같은 현장/층의 모니터링 `floor-map`·`floor-fixtures` 및 dashboard 캐시에 저장된 배경·맵 크기·도형·조명 배치를 즉시 병합한 뒤 scoped query를 invalidate한다. 네트워크 오류는 현재 편집 상태를 유지하며, `409`는 강제 덮어쓰기 없이 최신 버전 다시 불러오기만 제공한다.
- 버전 패널은 cursor pagination으로 수정자 display name, 시각과 숫자 변경 수 및 `floorPlanChanged`를 합산해 표시한다. loading/error/empty 상태를 구분하고 오류에는 announcement와 재시도를 제공한다. 복구와 편집 UI는 assigned admin만 노출한다. 요청은 baseline의 `mapRevision`을 `expectedRevision`으로 전송하고, 현재 존재하지 않아 건너뛴 조명 안내는 같은 floor query refetch 뒤에도 유지한다.
- dirty 상태에서는 앱 내부 링크 이동, 현장 전환, 브라우저 뒤로 가기, 저장하지 않은 취소와 `beforeunload`를 확인한다. dirty 진입 시 현재 URL과 같은 history sentinel을 추가해 첫 back이 editor route를 벗어나기 전에 확인하며, 취소는 sentinel을 복원한다. 저장 또는 승인된 내부 이동·현장 전환·취소는 sentinel entry를 목적지로 replace하고, 같은 editor에서 clean 상태가 되거나 unmount되면 sentinel을 소비해 back stack에 editor가 중복으로 남지 않는다. listener는 unmount에서 정리하고 저장 후 back에는 폐기 확인을 표시하지 않는다.
- `POST /floors/:floorId/editor-lease`는 Redis key `floor-editor:lease:{floorId}`를 캐시·경합 완화에 사용하지만, 실제 편집 권한의 정본은 PostgreSQL `Floor.editorLease*` 컬럼이다. 획득은 같은 transaction에서 만료 여부를 확인하고 monotonic `editorLeaseFence`를 증가시키며, `editorLeaseTokenHash`, `editorLeaseHolderId`, `editorLeaseHolderName`, `editorLeaseAcquiredAt`, `editorLeaseExpiresAt`를 함께 기록한다. 같은 token의 POST는 이 정본을 연장한 뒤 Redis를 best-effort로 갱신하고, `DELETE`와 강제 해제는 fence를 다시 증가시켜 이전 토큰을 무효화한다.
- assigned admin의 강제 해제는 먼저 durable `floor_editor.lease_force_release_requested`/`attempted` audit을 기록한 뒤, PostgreSQL 정본의 token hash와 fence를 기준으로 successor를 덮지 않도록 무효화한다. operator는 현재 고객 Site capability가 없어 이 API를 사용할 수 없으며, 웹의 operator 노출은 후속 정리 대상이다. Redis 삭제는 후속 cache cleanup일 뿐 성공 조건이 아니며 stale predecessor를 되살릴 수 없다.
- `PUT /floors/:floorId/editor-state`와 `POST /floors/:floorId/editor-revisions/:revision/restore`는 `leaseToken`, `leaseFence`, `expectedRevision`을 모두 요구한다. 저장·복구 transaction 안에서 현재 `Floor` row의 token hash, fence, 만료 시각을 다시 검증해 lease가 만료되었거나 강제 해제된 stale client를 `409 floor editor lease is no longer active`로 거부하고, 그 뒤 `mapRevision`을 최종 optimistic guard로 검사한다.
- 맵 편집 route는 진입 시 lease를 얻고 editable token이면 30초마다 single-flight heartbeat로 갱신한다. 클라이언트는 `performance.now()` 기반 80초 local deadline watchdog으로 fail-closed 동작을 유지하고, 서버는 PostgreSQL 만료 시각과 fence를 authoritative source로 사용한다. 충돌, 갱신 실패, token 상실, deadline 만료, lease 획득 실패와 floor 전환 중에는 저장/복구/도구/캔버스/배경/속성 변경을 막는 읽기 전용으로 전환한다. 정상 route 이탈은 아직 보유한 token의 release를 요청하고, 브라우저 종료 같은 비정상 종료의 회수는 서버 만료 시각과 Redis TTL에 맡긴다.
- Task 11 완료 후 legacy `PATCH /floors/:floorId/floor-plan`, `PATCH /fixtures/:fixtureId`, `POST/PATCH/DELETE /floor-map-objects` 경로와 웹 export를 제거했다. 이제 도면 변경은 revision·audit·lease fence가 모두 걸린 atomic save/restore 경로로만 가능하며, stale legacy client가 `mapRevision`을 우회해 normalized row를 덮어쓸 경로는 없다.
- Playwright browser 회귀는 operator의 customer 설정 직접 URL이 `/operator/site-admins`로 수렴하고 `/sites`를 호출하지 않는 것, admin의 설정 도면 이동/atomic save/모니터링 좌표 반영, viewer edit URL의 사전 redirect와 mutation `403`을 검증한다. Task 9 격리 실백엔드 journey도 map save와 모니터링 좌표 반영을 검증했다. 1,000 fixture editor는 navigation 시작부터 marker 색상 표시와 Konva hit selection까지 8초 이내여야 한다. fixture route는 `apps/web/e2e/support`에만 있으며 assigned `site-1` 밖의 `404`는 test-fixture isolation 검증일 뿐 production tenant E2E 증거는 아니다.
- Playwright route fixture는 설정 에디터에서 새 도형을 atomic save한 뒤 모니터링으로 이동하면 저장 응답으로 발급된 도형 ID가 실제 Konva scene에 즉시 표시되는 계약을 검증한다. 이 검증은 브라우저/API fixture 범위이며 Raspberry Pi/ESP32-H2 실장비 연동 완료를 의미하지 않는다.
- operator는 고객 설정 shell을 mount하지 않으며 고객 Site 목록과 capability를 갖지 않는다. assigned admin과 viewer만 허용된 범위의 Site API를 사용한다. Task 8은 pending admin 최초 설치 UI와 설치 완료 admin의 Gateway/registration 역할 노출을 연결했다.
- 현장 선택기는 `GET /sites` 응답의 `customerName`과 `name`을 함께 사용하고 URL의 `siteId`를 갱신하며 일반 설정 route의 pathname, 다른 query parameter와 hash fragment를 유지한다. operator에게 배정 현장을 표시하던 설명은 폐기됐으며 현재 `GET /sites`는 operator에게 고객 Site를 반환하지 않는다. floor 편집 route에서 승인된 현장 전환은 current draft를 baseline으로 되돌려 dirty를 해제하고 이전 floorId를 버린 뒤 새 현장의 `/settings/floor-plans`로 이동한다. 취소 시 draft와 URL을 유지하며, 승인 후 다음 현장 전환에는 폐기 확인을 반복하지 않는다. dashboard, floor fixture, statistics query key는 모두 `siteId`를 포함하며, 선택된 현장은 `/sites/:siteId/dashboard`, `/sites/:siteId/floors/:floorId/fixtures`, `/energy/sites/:siteId/estimate`를 호출해 다른 고객 현장의 캐시를 재사용하지 않는다.
- dirty editor에서 상단 `로그아웃` 버튼을 눌러도 동일한 폐기 확인을 거친다. 취소하면 session과 draft를 유지하고, 승인한 뒤에만 draft를 버리고 `/auth/logout` 후 auth query를 로그인 화면으로 전환한다.
- 설정 navigation은 admin의 `설정 개요`, `조명 등록`, `맵 관리`, `비밀번호 변경`과 viewer의 읽기 전용 `설정 개요`, `맵 관리`만 제공한다. `조명 등록` UI는 설정 개요에서 분리한 admin 전용 `/settings/registration`에서만 제공한다. 등록할 Gateway가 없으면 같은 화면에서 Gateway 등록을 먼저 안내하고, Gateway가 있으면 기존 검색·식별·등록 workflow를 그대로 사용한다. viewer가 이 URL로 직접 접근하면 query string을 유지한 설정 개요로 replace한다. 그 밖의 구현 route는 `/settings`, `/settings/floor-plans`, admin 전용 `/settings/security`이며 허용되지 않은 설정 하위 URL도 설정 개요로 수렴한다.
- 설정 주 메뉴의 펼침 화살표는 메뉴 링크의 오른쪽 8px, 세로 중앙에 고정한다. 메뉴 글자 길이나 가로 여백이 달라져도 화살표가 밀리지 않도록 링크 자체를 기준으로 absolute positioning한다.
- 웹 Dockerfile은 production API 요청을 same-origin `/api`로 빌드한다. nginx official template entrypoint가 `API_UPSTREAM`(기본 `http://api:4000`)을 주입하고 `/api/*`를 reverse proxy하며, SPA fallback으로 `/settings/floor-plans` 같은 deep route 새로고침을 `index.html`로 응답한다. Vite 개발 서버는 `/api`를 기본 `http://localhost:4000` upstream으로 proxy해 로컬 API 개발 동작을 유지한다.

## 확정 구현 설계

### 화면과 라우팅

- 주 메뉴를 `/monitoring`, `/control`, `/statistics`, `/settings` URL로 표현한다.
- 이전 정보 구조에 있던 `/settings/floors`, `/settings/fixtures`, `/settings/gateways`, `/settings/commissioning`은 현재 구현 route가 아니다. 현장·층, 조명·그룹, Gateway, 정책, 알림, 펌웨어, 외부 연동과 장비 상태 상세 workflow는 현재 미구현/후속으로 유지한다.
- 맵 편집기는 `/settings/floor-plans/:floorId/edit` 전체 작업 화면으로 연다.
- `MonitoringView`는 에디터 조회 상태와 `맵 편집` 버튼 없이 읽기 전용 도면만 표시한다. 설정 에디터 route가 실제 state 조회와 저장·취소 navigation을 소유한다.
- 모니터링 empty state는 등록 UI를 직접 렌더링하지 않고 admin에게 `/settings/registration` 이동 경로를 안내한다.

### 맵 편집기 저장과 버전

- 기존 여러 개별 API의 `Promise.all` 저장을 변경 항목 기반 단일 저장 API로 교체한다.
- `PUT /floors/:floorId/editor-state`가 도면, 도형, 조명 배치를 하나의 Prisma transaction으로 저장한다.
- 요청은 `expectedRevision`, 도면 변경, 조명 변경, 객체 생성·수정·삭제 목록을 포함한다.
- 서버는 조직·현장·역할, 모든 대상의 층 소속, asset 준비 상태와 현재 revision을 검증한다.
- 하나라도 실패하면 전체 변경을 rollback하고 부분 저장을 허용하지 않는다.
- `Floor.mapRevision`은 배경뿐 아니라 층 전체 편집 상태의 optimistic concurrency token이다.
- `FloorMapRevision`은 수정자, 버전, 변경 요약, 복구 원본과 전체 복구 스냅숏을 보관한다.
- 과거 버전 복구는 기존 버전을 덮어쓰지 않고 새 버전을 생성한다.
- 복구는 배경, 도형, 기존 조명의 표시 정보만 대상으로 하며 Mesh 주소나 장비 등록 상태를 생성·삭제하지 않는다.
- 실존하지 않는 과거 조명은 건너뛰고 복구 결과에 경고를 포함한다.
- 호환용 개별 변경 API는 최종 fix wave에서 제거했다. 현재 제품 경로에서 도면 관련 변경은 atomic save/restore만 허용한다.

### 편집 충돌과 파일 보안

- Redis에 층별 90초 cache lease를 두고 편집 화면이 30초마다 갱신한다.
- 다른 사용자가 편집 중이면 읽기 전용으로 열고 수정자와 시작 시각을 표시한다.
- `REDIS_URL`은 API 실행에 필수이며 Redis provider는 최초 lease 요청까지 client 생성을 지연한다. API bootstrap은 Nest shutdown hook을 활성화해 SIGTERM/SIGINT에도 생성된 Redis client의 `quit()`을 호출한다. Redis에는 `{ userId, userName, token, acquiredAt, fence }`를 저장하지만 authoritative validation은 PostgreSQL `Floor.editorLease*` 정본이 담당한다.
- assigned admin의 강제 lease 해제는 requested/attempted 감사 기록을 성공적으로 남긴 뒤 PostgreSQL fence를 증가시켜 이전 holder를 무효화하고, Redis delete 결과를 success 또는 stale_token 감사로 별도 기록한다.
- lease와 별도로 revision 불일치 시 `409 Conflict`를 반환하고 강제 덮어쓰기를 허용하지 않는다. save/restore는 lease fence와 `mapRevision`을 모두 통과해야 한다.
- 변경사항이 있으면 화면 이탈을 확인하고 네트워크 오류 시 클라이언트 편집 상태를 유지한다.
- 도면 저장소는 비공개로 전환하고 만료 시간이 짧은 서명 URL로 업로드·조회한다.
- 확장자 대신 실제 MIME을 검사하고 이미지는 재인코딩하며 PDF는 격리된 worker에서 렌더링한다.
- 원본 PDF는 다운로드 전용으로 제공하며 실패하거나 검역되지 않은 파일은 현재 도면에 연결하지 않는다.

### 현장과 층

- 현장명, 주소, 시간대, 통화와 kWh 요금을 수정한다.
- 층 이름, level, 표시 순서와 활성 상태를 관리한다.
- 층은 hard delete 대신 archive하며 조명이나 Gateway 담당 범위가 남아 있으면 archive를 차단한다.
- `Site.timezone`, `Site.currency`, `Floor.status`, `Floor.displayOrder`를 명시적 필드로 추가한다.

### 조명과 그룹

- 1,000개 이상 조명을 서버 페이지네이션하고 층, 상태, 그룹, 통신 품질로 필터링한다.
- assigned admin은 조명 이름, 정격전력, 도면 좌표와 표시 크기를 수정한다. viewer는 저장된 도면과 조명 정보를 읽기 전용으로 본다.
- 제품 serial, Mesh 주소, 펌웨어, 인증 관련 값은 읽기 전용이다.
- 그룹 생성·수정·archive와 구성원의 일괄 추가·제외를 지원한다.
- 장비 교체는 논리 Fixture와 전력 이력을 유지하고 연결된 MeshNode만 교체하는 별도 workflow로 구현한다.

### Gateway와 시운전

- 다중 Gateway 목록에서 이름, serial, heartbeat, 펌웨어, 인증서 만료, Mesh 품질과 담당 범위를 표시한다.
- `GatewayFloorCoverage`로 층별 주·보조 Gateway를 지정한다.
- 설치 완료 assigned admin은 admin 전용 `/settings/registration`에서 Gateway claim 또는 `RegistrationPanel`을 사용할 수 있다. 모니터링은 등록 조명 0개 상태에서도 등록 mutation UI를 제공하지 않는다. 순서형 시운전 보고서와 품질 검사 화면은 현재 미구현/후속이다. Task 9 software E2E는 완료했고 Raspberry Pi/ESP32-H2 HIL은 아직 실행하지 않았다.
- 완료 시 등록 성공·실패, Mesh 주소, 펌웨어, RSSI, hop count, 명령 성공률과 작업자를 보고서로 보존한다.
- claim code, private key와 Mesh key는 UI, DB 원문과 감사 로그에 노출하지 않는다.

### 운영 정책과 알림

- `SiteOperationPolicy`에 Gateway offline, Fixture stale, 명령 ACK·완료 제한 시간, 디밍 범위와 정전 복구 동작을 저장한다.
- API와 MQTT 처리기가 고정 상수 대신 현장 정책을 사용한다.
- `AlertRule`, `NotificationChannel`, `NotificationRecipient`, `NotificationDelivery`로 조건, 수신자와 결과를 분리한다.
- 반복 장애에는 지연과 cooldown을 적용하고 점검 시간에는 지정 알림을 억제한다.

### 사용자, 보안과 감사

- `SiteMembership`은 customer `viewer`의 현장 `read | control` capability에 사용한다. assigned `admin`은 `Site.adminUserId`로 직접 연결되고 operator는 고객 Site capability를 갖지 않는다.
- 이메일 초대, 역할 변경, 비활성화, 세션 강제 종료와 operator/admin MFA를 제공한다.
- 서비스 운영사 Organization과 고객사 Organization을 구분한다. operator는 Task 3 관리 API로 customer Organization, pending Site와 assigned admin 계정을 provision하지만 해당 고객 Site에 접근 권한을 얻지 않는다.
- 최초 서비스 계정은 `auth:bootstrap-operator`로 서비스 운영사 Organization에 생성한다.
- operator의 Task 3 API는 customer Organization, Floor가 없는 pending Site와 assigned admin을 원자 생성하며 operator SiteMembership을 만들지 않는다. assigned admin이 Task 4 API로 주소·단가·시간대·Floor/FloorPlan을 완료한다.
- operator는 Task 3 API로 assigned admin 계정을 직접 생성·교체한다. 공개 operator/admin signup은 거부하고, 현재 invitation signup은 viewer membership 생성에만 사용한다.
- 공통 `AuditLog`에 작업자, 현장, action, 대상, 변경 요약, 결과, IP, User-Agent와 관련 revision을 기록한다.
- 비밀번호, claim code, private key와 인증서 원문은 감사 로그에 저장하지 않는다.

### 펌웨어와 유지보수

- 서명된 OTA package에 대상 제품, hardware revision, firmware version과 SHA-256을 기록한다.
- 시험 장비, 일부 층, 전체 현장 순서의 단계 배포와 유지보수 시간을 지원한다.
- Gateway와 ESP32-H2가 서명과 hash를 검증하며 웹은 바이너리를 장비에 직접 전달하지 않는다.
- 배포 진행률, fixture별 실패, 중단, rollback과 인증서 갱신·폐기 상태를 관리한다.

## API와 데이터 모델 변경 예정

### 주요 API

- `GET/PATCH /sites/:siteId/settings`
- `POST /sites/:siteId/floors`
- `PATCH /floors/:floorId`
- `POST /floors/:floorId/archive`
- `PUT /sites/:siteId/floors/order`
- `GET/PUT /floors/:floorId/editor-state`
- `GET /floors/:floorId/editor-revisions?cursor={revision}&limit={1..100}`
- `POST /floors/:floorId/editor-revisions/:revision/restore`
- `POST/DELETE /floors/:floorId/editor-lease`
- `GET /sites/:siteId/fixtures`
- `PATCH /fixtures/:fixtureId/profile`
- `POST/PATCH /sites/:siteId/groups`
- `PUT /fixture-groups/:groupId/fixtures`
- `GET/PATCH /sites/:siteId/operation-policy`
- `GET /sites/:siteId/audit-logs`

### 주요 신규·확장 모델

- `SiteMembership`
- `Organization.type`: `service_provider`, `customer`
- `FloorMapRevision`
- `GatewayFloorCoverage`
- `SiteOperationPolicy`
- `AlertRule`, `NotificationChannel`, `NotificationRecipient`, `NotificationDelivery`
- `AuditLog`
- OTA package, deployment, target와 result 모델
- `Site.timezone`, `Site.currency`
- `Floor.status`, `Floor.displayOrder`, `Floor.mapRevision`

DB 모델이 실제 변경되는 작업에서는 `docs/database-schema.md`를 같은 커밋에서 갱신한다.

## 구현 순서

1. 현장 접근 범위와 역할 Guard
2. URL 기반 설정 shell과 역할별 navigation
3. 현장·층 CRUD와 archive
4. 맵 편집기를 모니터링에서 설정으로 이동
5. 단일 transaction 저장, revision과 복구
6. Redis 편집 lease와 비공개 asset pipeline
7. 조명 정보와 그룹 관리
8. 다중 Gateway coverage와 시운전 화면 정리
9. 운영 정책과 알림
10. 사용자, MFA, 세션과 공통 감사 로그
11. 서명된 OTA와 유지보수

- 각 단계는 실패 테스트, 최소 구현, 관련 테스트 통과, 메뉴·DB 문서 갱신과 독립 커밋으로 완료한다.
- API를 먼저 배포해 이전 웹과 호환한 뒤 웹을 전환하고, 사용되지 않는 개별 에디터 변경 API를 제거한다.
- 기존 Floor, FloorPlan, Fixture와 FloorMapObject는 삭제하거나 재생성하지 않는 비파괴 migration을 사용한다.
- legacy migration은 기존 Organization을 모두 customer로 유지하고, 현장 유무로 service provider를 추론하지 않는다. service_provider Organization은 배포 권한이 있는 bootstrap CLI로만 명시 생성한다.
- 기존 `owner`/`operator`와 Invitation은 모두 admin으로 변환하고 viewer는 viewer로 유지한다. 기존 customer viewer의 SiteMembership backfill은 유지한다.
- 수정된 legacy migration을 이미 적용한 로컬 개발 DB는 Prisma checksum 충돌이 날 수 있다. 데이터 보존 여부에 따라 reset 또는 감사 기반 수동 보정 migration을 선택하며, 이 기능은 파괴적 DB 명령을 자동 실행하지 않는다.

## 테스트와 완료 기준

- 백엔드 단위 테스트: 역할, 현장 범위, 입력 검증, 층 archive 조건, revision 충돌
- DB 통합 테스트: 원자 저장 rollback, revision 생성·복구, 다른 조직 격리
- 프론트 테스트: 역할별 메뉴, 읽기 전용, 편집 dirty state, API 오류와 충돌 UI
- 웹 E2E: operator의 Task 3 pending Site/admin provision, assigned admin 최초 설치와 후속 맵 편집, 모니터링 반영, viewer 변경 차단
- 동시성 테스트: 동일 층의 두 사용자, lease 만료, 강제 해제와 `409`
- 성능 테스트: 조명 1,000개 로딩·이동·선택·변경분 저장
- 보안 테스트: 다른 조직 IDOR, 직접 API 호출, 악성 파일, private asset URL 만료
- Hardware E2E: Raspberry Pi와 ESP32-H2의 Claim, provisioning, 상태 수신, 제어와 OTA
- 실제 Pi/ESP32-H2 반복 로그와 firmware hash가 없으면 Hardware E2E 또는 양산 검증 완료로 표시하지 않는다.

## 미구현

- Scene 04~09와 24~26의 자동 Web/Chromium 검증은 완료했지만 Raspberry Pi/BlueZ/ESP32-H2 HIL과 실제 모바일 WebView safe-area 검증은 미실행이다.

- 초대 링크 발급·전달 방식의 일반 유저 onboarding UI. admin이 직접 계정과 임시 비밀번호를 발급하는 현장 유저 CRUD는 구현 완료했다.
- 현장 정보 수정과 층 CRUD/archive UI
- 비공개 도면 asset과 보안 처리 pipeline
- 조명 정보·그룹 CRUD 관리 화면
- 다중 Gateway와 층 coverage
- ESP32-H2 factory reset과 장비 교체 workflow
- 시운전 보고서
- 운영 정책과 알림
- MFA·세션 관리 UI
- 공통 설정 감사 로그
- 서명된 OTA package, 단계 배포, 중단과 rollback
- 외부 API·Webhook·BMS 연동 설정
- 스케줄·센서·이벤트·장면 설정은 제어 메뉴의 후속 범위로 유지한다.

## 작업 재개 지점

- **폐기된 이전 계약:** 2026-07-21 Task 1~5는 operator SiteMembership과 operator 설치·시운전을 전제로 검증했다. 현재 Task 1~4 계정 전환의 구현 완료 증거로 사용하지 않는다.
- Gateway claim·조명 registration API controller와 service는 assigned admin commissioning 계약으로 전환됐고, Task 8 웹 UI와 Task 9 격리 실백엔드 E2E까지 완료했다.
- 이전 통합 보안 리뷰의 Floor editor, invitation 원자 소비, legacy migration과 bootstrap 증거는 유지하지만 operator 고객 현장 접근 증거는 폐기됐다.
- Task 6 URL 기반 설정 shell과 현장 선택은 `b5a92bd`, `8b53420`, `7e75f1f`로 완료하고 재리뷰 APPROVED를 받았다.
- Task 8 atomic save/revision API는 `d8d42f1`, `edde0a8`, `8d7aa2e`, `a3aa1b7`, `669be7e`, `d8041f6`, `63cd6fd`, `45336dc`, `f786d3f`에서 단계적으로 보정했다.
- Task 9 웹 변경분 생성, atomic save 전환, 충돌·revision 복구 UI와 dirty navigation guard는 `c43ff85`, `7b1fae0`, `f103f7c`, `d67e27e`, `f0c9e3a`, `3c8bd02`, `1a8bce3`에서 보정했다.
- Task 10/11의 원래 완료 선언 이후 whole-branch final fix wave에서 invitation membership lifecycle, selected-site statistics, viewer read-only control, PostgreSQL authoritative lease fence, legacy mutation 제거, dirty logout guard, Docker shared build 계약, customerName site selector를 추가 보정했다. 승인 여부는 이 문서가 아니라 scoped final re-review가 결정한다.
- 상세 커밋, 테스트 증거와 재개 순서는 `.superpowers/sdd/progress.md`에 유지한다.

## 부족하거나 개선이 필요한 기능

- 맵 편집 우측 패널의 공통 overflow 계약은 Chromium 1440/1024/390/320px route fixture로 검증했으며 실제 모바일 WebView safe-area와 브라우저별 scrollbar 표현은 별도 실측이 필요하다.
- 테스트 데이터 도구는 개발·검증용 대량 데이터 준비 기능으로, 기본 off이며 실제 장비/MQTT 시뮬레이션이나 실장비 검증을 대체하지 않는다. 생성 직후에도 실제 heartbeat가 없으면 freshness 정책으로 offline 전환될 수 있다. DB schema/migration 변경은 없다.
- 비밀번호 변경과 setup/commissioning visibility는 Web 회귀와 기존 격리 실백엔드 E2E로 검증했다. Scene 24~26 레이아웃은 1440×900, 1024×768, 390×844, 320×740 자동 Chromium으로 검증했지만 재설치, 수동 in-app Browser 시각 QA와 Raspberry Pi/ESP32-H2 HIL은 아직 실행하지 않았다.
- 설정 shell은 역할별 navigation, 설치 wizard, 설정 개요, 도면 목록/편집과 admin 비밀번호 변경을 제공한다. 현재 미구현/후속인 현장·층 상세 CRUD, 조명·그룹 상세 관리, Gateway 진단, 정책, 알림, 펌웨어, 외부 연동과 장비 상태 상세 workflow는 route placeholder가 아니라 아직 제공하지 않는 범위다.
- 평탄화된 설정 콘텐츠와 에디터 workbench의 시각 계층만 정리했으며, pending setup/Gateway claim/registration 흐름과 맵 editor lease·dirty guard·atomic save/restore·단축키·map bounds의 기존 제약 및 후속 실장비 검증 범위는 변경하지 않았다.
- coarse pointer용 설정 bottom sheet와 단일 열 설정 본문은 자동화 테스트를 통과했고, desktop disclosure의 Tab/Shift+Tab/Escape focus 이동은 헤드리스 Chromium으로 검증했다. CSS는 `env(safe-area-inset-bottom)` 계약을 적용하지만 현재 Chromium route fixture는 non-zero inset을 실측하지 않는다. 실제 모바일 WebView safe-area와 네이티브 navigation 통합 검증은 후속 작업이다.
- dirty 내부 이동 guard는 링크, 현장 전환과 same-URL sentinel 기반 브라우저 history 이동을 확인한다. Task 10 이후 추가되는 programmatic navigation 경로도 같은 discard/guard 계약에 연결해야 한다.
- Gateway claim과 registration API 및 웹 UI는 assigned admin commissioning으로 전환됐고 Task 9 software E2E를 통과했다. inventory disable은 제조 보안 경계로 active service-provider operator 전용을 유지한다. 실제 장비 검증은 미실행이다.
- 현재 도면 asset은 장기 공개 URL을 응답하므로 민감한 건물 도면에 맞는 private access로 전환해야 한다.
- 다중 Gateway coverage와 층별 radio 품질 진단은 아직 제공하지 않으므로, 사용자가 선택한 Gateway가 해당 층을 실제로 커버하는지는 설치 검증 절차로 확인해야 한다.
- 실제 ESP32-H2 검색·provisioning·model bind, RF 품질과 전체 OTA는 실기 검증 증거가 아직 부족하다.
- 기존 `FixtureGroup` 데이터는 제어 기반에서 사용할 수 있지만 zone 생성·수정 UI/API가 없어 zone 실장비 제어 Gate는 `not_executed`다. 이 미구현 계획은 설정 기능 재개 시 별도 작업으로 유지한다.
- 등록 패널의 물리 provisioning 상태는 1.5초 polling으로 반영하고, 검색·등록·상태 확인의 display-only 진행 단계를 제공한다. `reconcile_required` 장비의 실제 현장 복구 판단과 자동 질의는 아직 제공하지 않는다.
- MinIO 기반 local S3 integration test는 준비됐지만 현재 개발 머신에 Docker CLI가 없어 실제 실행 증거는 아직 없다.
- PDF는 첫 페이지만 도면 배경으로 렌더링한다. 다중 페이지 선택과 원본 PDF 파일 관리 UI는 후속 작업이다.
- 조명 다중 선택·일괄 이동, 도형 개별 삭제, Undo/Redo, 격자 스냅과 조명 키보드 미세 조정을 제공한다. 다중 도형 동시 편집과 전용 회전 도구는 후속 범위다.
- CAD/DWG/DXF import와 AI 도면 해석 기반 editor object 자동 생성은 후속 MVP 범위다.

## 경쟁 서비스 참고 근거

- Emblaze: Planner의 도면·그룹·센서, Autopilot의 시운전, Dashboard의 모니터링·유지보수 분리
  - https://emblaze.co.kr/support/faq/
- Silvair: 웹 planning과 모바일 commissioning, area·zone·scene·schedule·mesh quality·보고서
  - https://silvair.com/support/faq/
- Casambi Pro: PC planning, tablet commissioning, project·layout·group·cloud gateway 관리
  - https://support.casambi.com/support/solutions/articles/12000102096-introduction-to-casambi-pro
- Signify Interact: Expert와 User의 그룹·zone·firmware·schedule 관리 권한 분리
  - https://sme.interact-lighting.com/web/help/interact-pro/2.7/system-guide/access-per-role.html
- Lutron Vive: schedule, occupancy, daylight, load shed와 energy·health 운영 기능
  - https://www.lutron.com/us/en/controls/systems/vive

## 관련 파일

- `apps/web/src/features/settings/users/SiteUsersView.tsx`
- `apps/web/src/features/settings/users/SiteUsersView.test.tsx`
- `apps/web/src/api/site-users.ts`
- `apps/web/e2e/site-user-management.spec.ts`
- `apps/web/e2e/site-user-management-real.spec.ts`
- `apps/api/src/site-users`
- `apps/api/src/access/site-access.service.ts`
- `apps/web/src/components/ui/SidePanel.tsx`
- `apps/web/src/features/transport-copy.ts`
- `apps/web/src/features/transport-copy.test.ts`
- `apps/web/src/App.tsx`
- `apps/web/src/api/queries.ts`
- `apps/web/src/features/settings/SettingsShell.tsx`
- `apps/web/src/features/settings/settings-sections.ts`
- `apps/web/src/features/shells/CustomerShell.tsx`
- `apps/web/src/features/shells/SettingsNavigationItem.tsx`
- `apps/web/src/features/sites/SiteSwitcher.tsx`
- `apps/web/Dockerfile`
- `apps/web/nginx.conf.template`
- `apps/web/src/features/settings/SettingsView.tsx`
- `apps/web/src/features/settings/registration/RegistrationSettingsView.tsx`
- `apps/web/src/features/settings/SettingsShell.test.tsx`
- `apps/web/src/features/settings/floor-plans/FloorPlanSettingsView.tsx`
- `apps/web/src/features/settings/floor-plans/FloorPlanSettingsView.test.tsx`
- `apps/web/src/features/settings/floor-plans/FloorEditorRoute.tsx`
- `apps/web/src/features/settings/security/PasswordSettingsView.tsx`
- `apps/web/src/features/settings/security/PasswordSettingsView.test.tsx`
- `apps/web/src/features/settings/TestDataToolsPanel.tsx`
- `apps/web/src/features/settings/TestDataToolsPanel.test.tsx`
- `apps/web/src/api/test-data.ts`
- `apps/web/src/api/test-data.test.ts`
- `apps/web/vite.config.ts`
- `apps/web/vite.config.test.ts`
- `apps/api/src/test-data`
- `.env.example`
- `apps/web/src/features/monitoring/MonitoringView.tsx`
- `apps/web/src/features/floor-editor`
- `apps/web/src/features/floor-editor/editor-monitoring-cache.ts`
- `apps/web/src/styles.css`
- `apps/web/src/features/floor-map/FloorScene.tsx`
- `apps/web/e2e/settings-floor-editor.spec.ts`
- `apps/web/e2e/floor-editor-layout.spec.ts`
- `apps/web/e2e/layout-assertions.spec.ts`
- `apps/web/e2e/support/layout-assertions.ts`
- `apps/web/e2e/support/settings-api.ts`
- `apps/web/playwright.config.ts`
- `apps/web/src/features/floor-editor/editor-diff.ts`
- `apps/web/src/features/floor-editor/editor-store.ts`
- `apps/web/src/features/setup`
- `apps/web/src/features/registration`
- `apps/web/src/features/setup/SetupWizard.test.tsx`
- `apps/web/src/features/setup/GatewayClaimPanel.test.tsx`
- `apps/web/src/features/registration/RegistrationPanel.test.tsx`
- `apps/web/e2e/calm-operations-commissioning.spec.ts`
- `apps/api/src/floor-editor/floor-editor.controller.ts`
- `apps/api/src/floor-editor/editor-lease.service.ts`
- `apps/api/src/floor-editor/floor-editor.service.ts`
- `apps/api/src/floor-editor/floor-editor-snapshot.ts`
- `apps/api/src/floor-editor/floor-editor.integration.spec.ts`
- `packages/shared/src/schemas.ts`
- `packages/shared/src/product-identity.ts`
- `apps/web/src/api/floor-editor.ts`
- `apps/api/src/floor-editor`
- `apps/api/src/redis`
- `apps/api/src/setup`
- `apps/api/src/setup/setup.integration.spec.ts`
- `apps/api/src/access/site-access.service.ts`
- `apps/api/src/gateway-onboarding`
- `apps/api/src/registration`
- `apps/api/prisma/schema.prisma`
- `packages/shared/src/schemas.ts`
- `docs/database-schema.md`
- `docs/menus/monitoring.md`
- `docs/menus/control.md`

## 갱신 규칙

- 설정 메뉴의 현장, 층, 도면, 조명, 그룹, Gateway, 시운전, 운영 정책, 알림, 사용자, 보안, OTA와 연동 기능을 구현·수정·삭제할 때 이 문서를 같은 작업에서 갱신한다.
- 맵 편집기 또는 등록 진입점이 바뀌면 `docs/menus/monitoring.md`도 같은 작업에서 갱신한다.
- DB schema가 바뀌면 `docs/database-schema.md`를 같은 작업에서 갱신한다.
- 자동 테스트 완료, 코드 완료, Raspberry Pi 검증과 ESP32-H2 Hardware E2E를 별도 상태로 기록한다.
- route-backed action을 추가하거나 제거할 때 role filtering, `siteId` query와 hash fragment 보존, dirty navigation guard 회귀를 함께 갱신한다.
- 테스트 데이터 도구의 활성화 플래그, 설치 완료 assigned admin 노출 조건, marker 기반 생성·삭제 범위가 바뀌면 이 문서와 모니터링 문서를 함께 갱신한다. DB schema/migration 변경이 없는지도 명시한다.
