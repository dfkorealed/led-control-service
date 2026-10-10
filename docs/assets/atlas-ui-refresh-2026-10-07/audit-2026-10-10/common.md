# ATLAS compact 공통 UI/UX 충실도 감사

기준: 격리 checkout `atlas-ui-fidelity-20261010`, base `b1dd36ee`, 승인 명세 `docs/superpowers/specs/2026-10-07-atlas-ui-refresh-design.md`. 읽기 전용 감사이며 구현·테스트·브라우저 조작을 하지 않았다. 아래 경로의 `mock/`는 `docs/assets/atlas-ui-refresh-2026-10-07/mockup/`, `src/`는 `apps/web/src/`를 뜻한다. 제품 계약은 승인 명세가 우선한다.

## 결론과 증거 한계

목업 대비 공통 표현 결함 13건을 확인했다. 주요 원인은 팔레트보다 shell 구성, 각 메뉴의 별도 tab recipe, 파란 보조 버튼/테두리, 계층이 없는 밀도, 통일되지 않은 지도 footer다. 19개 목업 route를 전부 분류했고, 고객 범위 16개와 제외 3개를 아래에 연결했다. 모든 원본 화면의 실행 검증을 완료했다는 뜻은 아니다. 페이지별 상세 결함은 해당 담당 감사와 합쳐야 한다.

화면 근거는 `/tmp/atlas-ui-review-20261010.a879k0/`의 desktop monitoring/manual/statistics/settings 원본·실제 8장 및 실제 monitoring 562px light/dark 2장이다. `mock-monitoring-mobile.jpg`는 파일명과 달리 1304×1229 desktop 이미지다. 목업 모바일 비교 근거로 사용하면 안 된다. 모바일 목업은 CSS source를 기준으로 판단했으며 나머지 drawer/dialog의 실제 화면은 미촬영 상태다.

## 전체 목업 route·하위 상호작용 대응표

`mock/atlas-shell.js:5–7`의 모든 route다. URL 구조를 목업 hash에 맞추는 작업은 필요하지 않다.

| 목업 route / source | 화면·상호작용·overlay 전수 범위 | 실제 대응과 분류 |
| --- | --- | --- |
| monitoring / operations.js:83 | 층 선택, 갱신 시각/새로고침, 이름·ID 검색/상태 filter popover, 선택 상세, 별도 조명 목록 popover, pin 선택/강조, pan/zoom/reset/fit, 범례, 최근 활동 ticker/전체 이력 | `/monitoring`; `MonitoringView`, `FloorMap`, `FixtureDetailPanel`, 활동 dialog. 별도 목록 CTA의 위치·노출은 페이지 감사 대상. 실제 snapshot/job 갱신 및 정확한 fixture ID 유지. |
| logs / operations.js:87 | 활동 검색, 날짜/결과/페이지 크기 filter, 시간 정렬, table/mobile cards, 이전/다음 | 별도 route 없음. 모니터링 활동 전체 보기 및 제어 `CommandHistoryPanel`로 대응. 모니터링 API에 검색/결과 filter가 없으므로 UI를 복제하지 않는다. route 부재 자체는 결함 아님. |
| manual / operations.js:101 | 4개 제어 탭, 층+개별/전체/그룹 선택, pan/select/area, 그룹 선택 select, 선택 수·해제·조명 chip, 숫자/range/0·30·70·100 draft, Apply, 진행/최근 결과·조명별 disclosure, 이력 | `/control?mode=manual`; `ControlView`, `SpatialTargetSelector`, `ManualExecutionPanel`, `CommandHistoryPanel`, `CommandRiskReconcileDialog`. 실제 전체 차단·복구·UUID/ACK 보존. scenario/read-only 데모는 제외. |
| schedules / operations.js:110,131 | 검색, 활성/동기화/개수 filter, sort, 활성 switch, 더보기 편집/삭제, 생성·편집 form(이름/날짜/시간/반복/밝기/대상), 삭제 확인 | `/control?mode=schedule`; `automation/ScheduleControlPanel`, `ScheduleDialog`. 실제 시간대·기간·동기화·재시도·page cursor에 맞춘 표현. |
| events / operations.js:110,131 | 검색/filter/sort/switch/더보기, 생성·편집(이름/센서/유지시간/밝기/대상), 삭제 확인 | `/control?mode=event`; `VehicleEventControlPanel`, `VehicleEventDialog`, `BioSensorPreparationPanel`. 조도/움직임 대신 실제 차량 이벤트 fields 유지. |
| zones / operations.js:117,151 | 그룹 table, 만들기/편집(이름/층/대상), 동기화, 삭제 확인 | `/control?mode=group`; `groups/FixtureGroupsPanel`, `FixtureGroupDialog`, 실제 map editor 구역. 임의 mock 동기화 성공 이식 금지. |
| overview / insights.js:80 | 통계 3탭, 보고서 이동, 기간(today/month/year)/층 filter, KPI 4개, 비교·예측·공백 chart, 비용 비교, 운영 인사이트 | `/statistics/overview`; `StatisticsOverviewPage`, `PeriodComparisonPanel`. 현재/완료 기간·오늘/월/년 실제 데이터의 응답을 섞지 않는다. |
| analysis / insights.js:94 | 집계단위(층/그룹/조명), 사용량/비용, 날짜/층 filter, 순위 선택, 상세 카드, 요일·시간 heatmap, 공백 범례 | `/statistics/analysis`; `analysis/StatisticsAnalysisPage`, `EnergyRankingDetailPanel`. API가 지원하는 rank/metric/date/scope만 표현. |
| reports / insights.js:105,179,209 | 검색/상태/날짜/범위 filter, table/mobile sort, 생성 form(이름/기간/범위), queued/completed, PDF preview dialog, regenerate, CSV | `/statistics/reports`; `reports/StatisticsReportsPage`, `ReportCreateDialog`. 실제 polling/download/signed URL/expiry/failure 및 CSV 유지. 샘플 preview/데모 완료는 제외. |
| settings / insights.js:117 | 설정 6탭, 현장/사용자/등록/도면/보안 5개 전체 클릭 카드 | `/settings`; `SettingsView`, `SettingsSubnavigation`. 실제 capability·설치 상태·계정 기능 추가분은 유지하되 구조를 압축. |
| site / insights.js:120,212–214 | 정보 card, 현장 이름·주소 수정 dialog, 층 집계/table, 층 추가·수정 form, 삭제 확인 | `/settings/site`; `site/SiteOperationsView`. 실제 층·전력·보관/복원·요금·BIO 추가 기능은 mock 미대응이며 유지. mock 주소/면적을 새 backend field로 만들지 않음. |
| users / insights.js:123,186,217–219 | 정렬, 사용자 생성·편집(이름/email/role), 삭제 확인, 조회자 데모 toggle | `/settings/users`; `users/SiteUsersView`, `SiteUserFormDialog`, `DeleteSiteUserDialog`, `ResetSiteUserPasswordDialog`. 실제 loginId/read/control/상태/100명·동시성·정확 이름 확인 유지. |
| registration / insights.js:129,220–223 | 3단계 진행(게이트웨이 claim/검색/완료), claim field, 다시 검색, 장치 checkbox, 층 선택, 등록, 배치 이동, 추가 검색 | `/settings/registration`; `RegistrationSettingsView`, 실제 installation/claim/provisioning 구성. 가상 즉시 성공·DEMO-ATLAS·가상 signal/device 제외. |
| maps / insights.js:137,224 | 층별 도면 preview card, 편집, 버전 이력 dialog/복원 | `/settings/floor-plans`; `FloorPlanSettingsView`와 revision 기능. 실제 mapConfigured/CAD 미리보기/lease·revision 보존. 가상 방/핀 그림은 복제 금지. |
| security / insights.js:140,225–228 | 비밀번호 form dialog, MFA 설정 code/해제 확인, 세션 목록/종료 확인, 로그아웃 확인 | `/settings/security`; `AccountSecurityView`, `PasswordSettingsView`, MFA/session 구성 + eager `CustomerAccountPanel`. 실제 인증/사용자 격리 유지. |
| editor / insights.js:145,229–234 | 돌아가기/dirty 확인/저장, select/pan/area, undo/redo, CAD 파일, 선택 조명 이동·배치 해제·미배치 배치, zoom/fit | `/settings/floor-plans/:floorId/edit`; `FloorEditorRoute`, `floor-editor/*`. 기존 전체 편집 도구와 lease/revision/undo/storage/dirty/ACK를 유지. 목업의 파일명만 읽기·조명 고정량 이동은 제외. |
| login / insights.js:148,262 | 로그인·2단계 form, 데모 로그인, setup/operator 이동 | 기존 auth 대응. 승인 명세의 고객 4메뉴 적용 범위 밖. 새 디자인 적용하지 않음. |
| setup / insights.js:151,263 | 현장/층/claim/등록 4단계 form, 뒤로/다음/완료 | 기존 설치 gate/wizard 대응. demo route 자체는 범위 밖이나 고객 설정의 실제 설치 흐름 접근성은 보존. |
| operator / insights.js:156,237–239 | 고객 KPI/table, 고객 관리자 추가·수정 form, 삭제 확인 | 기존 operator 대응. 승인 명세 범위 밖. |

공통 동작 inventory: sidebar collapse/expand·rail tooltip, 네 주메뉴 및 하단 메뉴, site select, theme persistence, 알림 popover의 읽음/지우기, 계정 이동, 모든 filter open/close/outside/Escape, modal submit/error/cancel/Escape/outside/focus return, table column sort 및 mobile sort direction, 5초 ticker pause/cleanup, toast. 목업 scenario selector·reset·예시 흐름은 제품 대응 없음. 실제 알림은 `SessionStatusCenter`의 읽음/삭제·장애 해결 구분과 query/command status를 따른다. 공통 구현 source: `atlas-ui.js:40–94,107–186`, `atlas-shell.js:14–39`.

## 공통 표현 결함 13건

1. **S1 Desktop header 정보 배치가 반대다.** 목업은 site left / 작은 수직 수치 네 묶음 center / alarms·theme·account right (`mock/atlas-shell.js:19,27`, `atlas-components.css:1`). 실제는 제목 left / site right / 집계 전체 별도 두 번째 행 (`src/features/shells/CustomerShell.tsx:317–345`). 제목을 desktop content의 올바른 위치로 옮기고 헤더를 한 행으로 복구. 모바일은 승인된 logo/site/actions 첫 행·집계 둘째 행 유지. 탭 전환마다 Shell/Provider를 재마운트하지 않는다.
2. **S2 집계의 계층과 색이 사라졌다.** 목업 수치 위·caption 아래 및 정상/주의 색과 달리 실제 `CustomerHeaderSummarySlot.tsx:11–16`는 제목+라벨·값을 한 수평 문장으로 출력한다. 4개 dl cell에서 수치가 먼저 보이게 한다. '온라인'을 '정상'으로 바꾸는 것은 데이터 의미 변경이므로 하지 않는다. null/error/loading·scope 정합성 유지.
3. **S3 sidebar의 inset·active outline·수직 시작점이 다르다.** 목업 18px 좌우 inset, 48px item, logo 이후 28px 간격 및 soft active fill (`atlas-components.css:1,31,33`); 실제 8px inset/44px item/16px 간격과 파란 active border (`CustomerShell.tsx:306–311`, `SettingsNavigationItem.tsx:13–17`). customer recipe에서 고친다. sidebar 220px/rail80px·760–1023 rail은 승인된 제품 계약을 우선한다. icon library의 그림 모양 차이는 결함으로 계산하지 않는다.
4. **S4 primary subtab이 mock의 soft filled pill이 아니라 밑줄이다.** 목업 최종 override `atlas-components.css:12` 및 `operations.js:63`, `insights.js:58–60`; 실제 `ControlModeTabs.tsx:14–16`, `StatisticsSubnavigation.tsx:16`, `SettingsSubnavigation.tsx:37`. 공통 `UnderlineNavigation.tsx:5–25`를 확장하고 3소비자 별도 active recipe를 통일한다. 활성/비활성의 접근성·키보드·URL은 유지한다. control 탭의 추가 icon과 긴 라벨도 목업 compact 표현과 정렬한다.
5. **S5 거의 모든 보조 버튼이 파란색·굵은 테두리형으로 보여 중요도 구분이 약하다.** 목업 secondary는 본문 잉크, ghost는 투명 (`atlas-components.css:1`); 실제 `Button.tsx:19,39–40`는 둘 다 파란 글자와 border/panel. customer appearance만 secondary neutral, ghost transparent, selected/pressed soft accent로 조정한다. primary와 danger 및 public/operator는 보존한다. 모달 close/행 동작/ticker 링크도 함께 개선된다. 모든 click area ≥44px, 더 큰 기존 hit 유지.
6. **S6 page/card/section typography와 spacing 역할이 목업 계층에 맞지 않는다.** 목업 page26, section20, small section16, metric30, body14 (`atlas-components.css:1`); 실제 page28/section24/card20/metric28 (`theme.css:320–339`)와 `PageHeader.tsx:11`의 강제 section-title 때문에 페이지별 크기·중복 제목이 다르다. 기존 token 값을 전역 수정하지 말고 고객 역할 필요 여부를 먼저 결정한다. 정확한 숫자 role이 필요하면 additive token→policy anchor 승인 순서. 색은 승인 palette를 유지한다. 목업 26/28px content inset·18/20px vertical rhythm을 공유 recipe에 적용하되 불필요한 demo-strip 높이는 재현하지 않는다.
7. **S7 지도 header의 정보 순서·여백이 다르다.** mock tools/title left + status right (`operations.js:73–75`, `operations.css:8–13`); 실제 `OperationMapPanel.tsx:15–16`는 title/status/tools 순서와 8px padding. manual의 summary left / tools right를 뒤집고 12px block/16px inline padding, 모바일 wrap 시 tools 행 우선으로 통일. state 소유권은 변경하지 않는다.
8. **S8 지도 footer가 하나의 bar로 결합되지 않았다.** 실제 `FloorMapViewport.tsx:739`의 controls는 footer 모드에서 position:static이며 `m-2 self-end`의 독립 inset box다. `FloorMap.tsx:198`와 `SpatialTargetSelector.tsx:156` 범례는 그 아래 별도 strip. 화면에서 떠 보이나 absolute overlay가 아니다. mock `atlas-components.css:1`의 map-footer처럼 한 panel footer에 legend left / camera right를 묶는다. `FloorMapViewport` optional footerStart slot이 안전한 최소 변경. 실제 full-view와 fit은 서로 다른 동작이므로 아이콘/label을 혼동하지 않는다. CAD surface 자체의 색/scale/aspect는 변경 대상 아님.
9. **S9 지도 인라인 집계의 dot과 중립 수치 계층이 다르다.** mock `operations.js:68–72`, `operations.css:9–12`는 작은 상태 dot·보조 label·진한16px 수치, actual `InlineStatusSummary.tsx:10–13`는 dot 없음/수치 직접 status color. 기존 tone으로 dot 추가, 수치를 본문색으로 통일. 숫자0/unknown— 및 실제 fault 의미 보존. 범례를 서로 다른 상태에서 억지로 같은 3항목으로 만들지 않는다.
10. **S10 ticker의 visible title·padding·action이 없다.** mock desktop '최근 활동'/'제어 이력' + 시간·본문·badge + arrow 전체보기 (`atlas-ui.js:45`, `atlas-components.css:32,34`); actual `RecentActivityTicker.tsx:37–46`는 label prop도 없고 44px boxed 전체보기. title prop 추가, desktop visible/mobile sr-only, panel radius 및 8px block inset, ghost arrow action. 기존 API adapter·5초·pause·scope reset 유지. 원본에 status가 없으면 만들어내지 않는다.
11. **S11 filter trigger가 '필터' 대신 slider icon+0만 보여준다.** actual `FilterPanel.tsx:42–45`; mock `atlas-ui.js:94`. 공통 triggerLabel 기본 '필터', active count는 0일 때 생략 또는 별도 작은 badge. aria-label의 조건 수와 pending/dismiss 잠금은 유지한다. summary를 중복하는 아래 chip/날짜는 메뉴 담당이 목업의 한 toolbar 구조로 결합.
12. **S12 responsive DataGrid mobile row 구성이 다르다.** mock 2열 label/value의 분리된 카드+간격 (`atlas-components.css:4`, `atlas-ui.js:40–44`); actual `DataGrid.tsx:105–109`는 하나의 Card 안에 divider와 각 field의 수직 stack. customer/compact mobile presentation에서 label left/value right, 긴 값 wrap, row gap/border를 공통 소유한다. width/minWidth 기반 responsive와 실제 정렬 지원 범위는 그대로. 모든 column의 무조건 sorting 추가는 금지. desktop 상단 '현재 목록 안에서 정렬' 안내(`DataGrid.tsx:78–80`)는 필요한 범위 의미이므로 숨길 경우 접근성 caption에 유지.
13. **S13 설정 공통 계정 block이 거대한 선행 카드라 메뉴 구조를 밀어낸다.** actual `CustomerShell.tsx:368`, `CustomerAccountPanel.tsx:9–15`; 목업에는 header 계정 접근과 security 페이지 logout만 있다. 이 기능을 삭제할 수는 없다. eager region·logout lock/focus/실패 및 gate fallback을 유지하면서 compact inline account strip/요약으로 축소하고 desktop header 계정 link를 settings/security로 연결한다. settings 카드/tabs/head 배치는 별도 페이지 감사와 조정. 설치 continuation 및 dev TestDataTools는 실제 제품 기능이고 mock 없는 추가분이므로 삭제 금지.

## 결함과 구분할 승인/필수 차이

- 화면 data 수·날짜·실제 CAD 형태·저장 선색·카메라 기억·offline 빈 상태와 mock의 주차장/36개 핀은 비교 대상에서 제외한다. 실제 dark 화면에서 검정 CAD 선이 어두운 것은 CAD 고유색 보존 계약과 연관되므로 임의 반전하지 않는다.
- 현재 light/dark palette는 승인 명세의 정확한 역할값이다. 원본 CSS의 다른 hex를 덮어써서 '충실도'를 높이지 않는다. exact root aliases, focus utility, token policy/anchor를 보존한다.
- 실제 온라인/장애는 mock 정상/점검 필요와 같은 값이라고 가정할 수 없다. 실제 상태 설명·badge·아이콘은 유지한다.
- 실제 full-view, selection fit, 저장 그룹 안전차단, command recovery/risk reconcile, 설치 pending, 권한/세션, real report 실패·만료·CSV, BIO 준비, power/archive/tariff는 목업에 없는 기능이다. 시각 계층을 정리하되 기능을 제거하지 않는다.
- mock 로그 필터·가짜 표본 수/최근 수집 시각/최대 절감 기여층·가짜 성공/순위/preview는 제품으로 이전하지 않는다. statistics 다른 period/no_data의 차이를 디자인 결함으로 세지 않는다.
- 실제 overlay의 React Aria focus trap·dismiss locking·nested portal·safe-area와 desktop drawer/mobile sheet는 적절한 제품 적응이다. mock의 모든 것을 600px native dialog로 치환할 필요 없음. `DialogBase.tsx:13–23,95–104`의 현재 modal 24px inset/52px close는 목업22px/44px과 작은 차이가 있지만 실제 overlay 화면 증거가 없어 별도 결함으로 단정하지 않는다. 공통 버튼/typography 수정 후 남은 밀도만 관찰한다.
- 모바일 실제 로고와 128px(<360)/144px(≥360) site width, 모든 조작44px 및 기존52px hit, breakpoint760 미만은 목업보다 나중 승인된 요구다. mock680/700/760 조건을 그대로 이식하지 않는다.

## 공통 인터페이스·소유 순서

1. **공통 기반 담당 단독 소유:** `components/ui/{Button,IconButton,UnderlineNavigation,PageHeader,FilterPanel,DataGrid,Typography,Card}.tsx`, `operations/{InlineStatusSummary,RecentActivityTicker}.tsx`, `features/shells/*`. 새 스타일은 customer context 또는 명시적 customer appearance로 한정한다. 색은 기존 semantic token. 기존 numeric token을 재사용하고 불가피한 고객 typography/geometry만 별도 additive token 작업으로 먼저 승인/정책 anchor 처리한다.
2. `UnderlineNavigationProps.variant: 'default' | 'customer'`; export `navigationItemClass({active, variant})` 같은 한 recipe를 버튼 tab과 NavLink가 공유. component가 routing/state를 소유하지 않음. 모든 기존 props/ARIA 유지.
3. `PageHeaderProps`에 `titleVariant?: 'page-title'|'section-title'`만 추가하면 충분하다. Shell desktop의 visible menu title을 제거하고 네 메뉴 본문이 `PageHeader headingLevel={1} titleVariant="page-title"`의 단일 visible h1을 소유한다. monitoring은 '모니터링'+우측 timestamp/refresh actions, control은 '조명 제어'+하단 mode tabs, settings root는 '설정'+하단 settings tabs, statistics는 기존 tabs 다음 현재 하위 페이지 제목을 h1로 출력한다. 하위 route는 기존 실제 제목을 h1로 승격/정리하여 shell·부모 제목과 중복하지 않는다. 기존 모바일 전용 제목은 이 공통 PageHeader로 대체하고 화면 크기별 별도 heading을 더 만들지 않는다. shell의 `shell-current-menu` hook이 필요하면 h1이 아닌 sr-only span으로 유지. 새로운 cross-page title context는 만들지 않는다. 통계 eyebrow는 승인 범위 내 기존 필요성이 확인될 때만 PageHeader optional slot으로 추가한다.
4. `RecentActivityTickerProps.title?: string` (backward compatible default '최근 이력'), monitoring '최근 활동', control '제어 이력'. DOM row 내용과 triggerRef/onOpen 계약 유지.
5. `FilterPanelProps.triggerLabel?: string` default '필터'; 활성 count·aria-label·open state는 그대로. 별도 페이지 filter component를 만들지 않음.
6. 카드 전체 link는 공통 `NavigationCard`를 `components/ui`에 둘 수 있음: `{to, icon, title, description, ariaLabel?}` 및 router Link 또는 render slot 한 방식. 버튼 안 버튼 금지; capability는 소비자 소유. 설정 담당이 공통 파일을 동시에 수정하지 않도록 기반 담당이 먼저 공급.
7. **공유 지도 담당 순차 소유:** `FloorMapViewport`, `FloorMap`, `SpatialTargetSelector`, `OperationMapPanel`, 필요시 `MapCameraControls`. `FloorMapViewportProps.footerStart?: ReactNode`와 `controlsPlacement='footer'`에서 full-width footer row를 생성. 기존 controlAfterZoom/showFitControl/zoom/focus/camera lifetime 유지; footerStart 미지정 소비자는 기존 레이아웃 보존. `OperationMapPanel`에서 tools/title을 왼쪽 묶음, status를 오른쪽 묶음으로 처리. 선택·summary·gesture는 호출자가 계속 소유.
8. **메뉴 담당 후속 소비:** monitoring/control/statistics/settings가 자신의 feature 폴더와 메뉴 문서만 수정. 공통 파일 부족은 총괄로 요청. statistics overview/KPI/plot, settings 카드/상세 forms, manual inspector 모두 공통 계약 이후 순차 통합한다. 총괄이 plan/status 체크리스트를 갱신한다.

## 라이트·다크·모바일 완료 범위와 간결한 검증 제안

- 본 감사에서는 tests/browser를 실행하지 않았다. 기존 실패를 숨기거나 기능 전체 회귀가 확인됐다고 주장하지 않는다.
- 합쳐진 변경 뒤 한 번의 web typecheck와 ui policy/check 및 필요한 build를 실행. 변경이 순수 표현인 경우 새 단위 테스트를 무조건 만들지 않는다. 유지된 existing targeted tests를 shell/navigation/map/ticker에서 한 번 선택 실행하고 실패/추가 변경이 생긴 범위만 재실행한다.
- 한 개 브라우저 세션에서 1304×1229 light의 네 root 화면·주요 하위 route를 순회하고 모바일390/562 및 short desktop1024×600 manual만 추가. 320은 header width/overflow, 759.5/760/760.5는 compact/rail boundary만 측정. 실제 mock mobile 이미지가 필요하면 정상 viewport에서 새로 찍는다.
- desktop shell 1행·summary4cell·page title/tab/card hierarchy·footer1bar·ticker label을 캡처 비교. drawer/modal은 검색/filter, rule form, report create, settings edit를 대표하여 각각 하나씩 열고 keyboard close/focus/overflow를 확인. 주요 menu별 별도 form field 누락은 feature 담당 checklist로 확인한다.
- dark는 동일 대표 화면과 열린 portal 한 개, 지도/차트·focus·텍스트 대비를 확인. 기존 exact 색을 바꾸지 않으면 대규모 새 theme matrix를 반복하지 않는다. 공개/login/operator route는 customer scope cleanup과 보조 button appearance 미침범을 짧게 확인.
- 실제 장비 명령 발송 없이 지도 선택/도구·밝기 draft·resize/theme/tab/filter/전체보기의 추가 dimming POST 0을 관찰. fixture로 기존 긴 복구 결과가 있는 manual 상태에서 외부 scroll/내부 scroll·viewport240·복구 CTA 접근 한 번 확인. software 확인을 HIL로 표기하지 않는다.

최종 완료는 19개 route inventory 중 범위16의 대응이 설명되고, 13개 common defect의 처리/예외가 각각 기록되고, 메뉴 담당 findings가 합쳐졌을 때다. 사진에서 데이터가 다르다는 이유로 나머지를 완료 처리하거나, 단지 typecheck 성공을 시각 일치 증거로 쓰지 않는다.

## 실행 계획용 최종 계약 보완

이 절이 앞선 S6 및 PageHeader의 잠정 API를 대체한다. 아직 제품 구현은 하지 않았으며 총괄의 검토 가능한 계획에 넣을 확정 제안이다.

**고객 typography API:** `TypographyVariant`에 `customer-page-title`, `customer-section-title`, `customer-card-title`, `customer-metric` 네 표현 역할을 추가한다. 기존 variant/기존 token 값은 수정하지 않는다. `PageHeader.variant`는 `'default' | 'customer'`, `headingLevel`은 기존 API 유지. `variant="customer" headingLevel={1}`은 `customer-page-title`을 선택하고 default는 현재 section-title 동작을 유지한다. 다른 섹션은 Heading/Text의 명시적 customer variant를 쓴다. customer provider 유무로 모든 일반 Heading의 의미를 자동 변경하지 않는다.

| 고객 표현 | 확정 recipe | 근거/신규 여부 |
| --- | --- | --- |
| page title | `text-customer-page-title font-bold max-compact:text-section-title` | desktop 26px/1.35, mobile 기존 24px/32px(목업23px의 가장 가까운 기존 크기). 신규 size/line-height 두 선언. |
| section title | `text-card-title font-bold` | 기존20px/28px 재사용. 기존24px section-title을 customer section에 쓰지 않는다. |
| card/small panel title | `text-body-lg font-bold` | 기존16px/24px 재사용. 크기가 같은 기존 semantic scale에 의미는 customer variant가 부여한다. |
| metric | `text-customer-metric font-bold tabular-nums max-compact:text-metric` | desktop30px/1.3, mobile 기존28px/34px(목업27px의 가장 가까운 기존 크기). 신규 size/line-height 두 선언. |

추가 token은 정확히 `--text-customer-page-title: 1.625rem`, `--text-customer-page-title--line-height: 1.35`, `--text-customer-metric: 1.875rem`, `--text-customer-metric--line-height: 1.3` 네 선언이다. 색·font-family·weight·tracking·기존 page/section/card/metric token은 보존한다. body14, secondary13, caption12 및 inline summary14/16은 기존 scale을 쓴다. 모바일 1px 차이를 위해 별도23/27 token을 추가하지 않으며 이 근사값을 의도적으로 기록한다.

**spacing API:** 새로운 spacing token은 필요 없다. 고객 main body는 desktop `px-7 py-6`, mobile `px-3.5 py-4.5`(목업 desktop 세로26px은 허용24px으로 근사). 페이지 직계 section gap=`gap-5`20px, 카드 grid gap=`gap-4.5`18px, panel inset=`p-5 max-compact:p-4`20/16px, header 이후 간격=`gap-5 max-compact:gap-3`20/12px, tab track=`gap-2 pb-2`, 지도 chrome=`px-4 py-3 max-compact:px-3`, footer=`px-3.5 py-2.5`, ticker=`px-3.5 py-2`. 기존 `Card`에 선택적 `padding?: 'none' | 'customer'`를 추가하면 panel inset을 소비자마다 반복하지 않을 수 있다(default none으로 기존 동작 유지). 정확한 viewport 높이를 맡는 monitoring/manual/editor는 고유 flex/min-height/overflow 계약을 유지하되 이 inset/gap을 소비한다. 사용성44px·기존 더 큰 hit·760px 경계는 불변이다. 기존 문서의 기본24px section 규칙에 대한 고객 compact 예외(20px)는 `docs/ui-spacing.md`에 명시한다.

**token 적용 순서:** 현재 승인 anchor와 비교하여 모든 기존 canonical 이름→값을 보존한 token-only commit → 네 추가 선언/의도 독립 검토 → 해당 exact commit으로 정책 anchor 회전·`docs/ui-spacing.md` 갱신 → full policy 확인 → 공통 소비자 구현. stale-anchor 중간 실패를 전체 정책 통과로 보고하지 않는다. 선언 수는 현재 AST에서 다시 산출하며 과거734에 단순4를 더해 전체 수를 주장하지 않는다. baseline allowance, literal, selector, native form 예외를 늘리지 않는다.

**제목 위치:** Shell의 desktop visible menu title 제거, 페이지 본문의 단일 PageHeader가 title/actions를 소유. monitoring은 모바일에서도 title 다음 timestamp/refresh 행을 **지도 위에** 배치한다. 모바일에서 갱신을 map/ticker 아래로 내리는 현 구성은 보존 조건이 아니다. control/settings 및 statistics 하위 제목은 앞 절의 단일 h1 원칙을 그대로 따른다. public/login/operator는 이 customer variant를 사용하지 않는다.

**모니터링 별도 조명 목록 CTA:** toolbar에 `조명 검색·상세`와 별도 `조명 목록`을 둔다. 후자는 기존 finder/list 데이터를 여는 두 번째 entry다. query/선택/필터/페이지네이션 state를 새로 복제하지 않는다. 같은 overlay가 초기 view를 지원해야 하면 `initialView?: 'search' | 'list'` 같은 표현 선택만 추가하고, 열 때 실제 initiating trigger ref를 저장해 dismiss/focus return이 각각의 버튼으로 돌아오게 한다. 별도 wrapper overlay/query를 중첩 생성하지 않는다. mock status filter를 actual API 밖으로 확장하지 않는다.

**그룹·구역 목록:** `groups/FixtureGroupsPanel`의 실제 owner/data/actions를 보존한 채 공통 `DataGrid` rows/columns adapter로 전환한다. 이름·층·대상 수·실제 제공 동기화 상태·작업 column을 사용하고 비제공 값은 생성하지 않는다. 만들기/편집/삭제·selection·pending/복구 잠금은 현재 owner의 handlers를 그대로 소비한다. 별도 그룹 저장소, fake synced 상태, 신규 CRUD 계약은 만들지 않는다. 기존 inline 목록 레이아웃 유지 자체는 요구사항이 아니다.

**설정 제목 소유 최종 확정:** 제안한 SettingsShell 소유 방식은 원본 `settingsHead`의 제목→tabs 순서와 단일 h1에 맞으므로 채택한다. `settings-sections.ts`의 기존 여섯 항목에 `pageTitle: string`만 추가하고 `/settings`→설정, `/settings/site`→현장 관리, `/settings/users`→사용자 관리, `/settings/registration`→조명 등록, `/settings/floor-plans`→도면 관리, `/settings/security`→계정 및 보안으로 명시한다. `SettingsShell`은 trailing slash만 정규화한 pathname을 capability-filtered 기존 목록에 **정확히 일치**시켜 해당 route에서만 `<PageHeader variant="customer" headingLevel={1} title={section.pageTitle} />`를 tabs 앞에 렌더한다. 여섯 child는 중복 제목만 제거하고 기존 description/actions를 단 한 번의 본문 toolbar로 계속 소유하며 fields·handlers·query·refs를 Shell로 복제하거나 옮기지 않는다. 모바일에는 동일 h1→하위 화면의 기존 돌아가기→본문 순서이고 tabs는 기존 계약대로 숨긴다. `/settings/floor-plans/:floorId/edit` 같은 상세 경로에는 Shell header를 렌더하지 않고 editor/child가 h1을 소유한다. 현재 CustomerShell route에는 별도 password 경로가 없으므로 새 경로를 추가하지 않으며, 독립 `PasswordSettingsView`를 실제 소비하는 경로가 있다면 그 제목은 해당 child 소유로 둔다. eager account region 및 gate fallback·로그아웃 수명은 유지하고 새 title context/outlet title handoff는 만들지 않는다. 이 결정을 앞선 설정 child-h1 소유 문구보다 우선한다.
