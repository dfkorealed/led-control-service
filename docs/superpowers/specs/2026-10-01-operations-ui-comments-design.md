# 운영 화면 22개 주석 반영 설계

작성일: 2026-10-01

상태: **설계 문서 검토 대기 — 구현 및 구현 계획 실행 승인 아님**

기준: `codex/mvp1-cloud-web`, `36a99b2910a03ca9a3b55237a7b24d85a247b7cf`
격리 브랜치: `codex/operations-ui-comments-20261001`

## 1. 목적과 승인 경계

모니터링·제어·통계의 22개 브라우저 주석을 해결하면서 기존 조회 범위, 데이터 의미, 권한, 장비 제어 안전성과 지도 동작을 보존한다. 기존 React Aria·Tailwind·공통 UI·디자인 토큰을 확장하여 필터·로그·상세 경험을 통일한다. 전면 재작성이나 무관한 리팩터링은 하지 않는다.

사용자가 승인한 것은 설계 방향과 계정별 영속 읽음 방식이다. 이번 산출물은 이 설계 명세 하나이며 제품 코드·토큰·API·DB·메뉴 현황·기존 계획·Figma·서버를 변경하지 않는다. 문서 승인 뒤 총괄이 `writing-plans` 실행 계획을 작성하고 검토·실행 방법 선택을 거쳐 담당자에게 구현을 배정한다. 단계별 명령과 테스트 실행 순서는 그 계획에서 정한다.

실제 작업공간은 `/Users/kim-jh/Documents/led-control-service/.worktrees/operations-ui-comments-20261001`이다. 기본 checkout, 설치·센서 작업공간, 실행 중인 API/Web과 사용자 DB·장비는 유지한다. 실제 장비 배포·초기화, 운영 DB 적용, 원격 push는 이번 요청의 묵시적 승인 범위가 아니다.

## 2. 주석별 추적표

번호는 2026-10-01 원래 브라우저 주석 번호다. 아래 경로는 기준 커밋에 존재하는 관련 파일이며, 각 행은 구현 후 확인할 수용 기준이지 현재 통과 기록이 아니다. 코드 경로의 기준 디렉터리는 저장소 루트다.

| 번호 | 원래 요청 | 수용 기준 | 실제 관련 파일 |
| --- | --- | --- | --- |
| 1 | 상태 범례가 실제 상태를 반영하는지 확인하고 드래그 안내 자리로 이동 | 실제 상태 파이프라인과 일치하는 정상·장애·오프라인·상태 확인 대기 범례만 사용한다. 현재 지도에 나타나는 상태를 기준으로 표시하고 기존 드래그 안내 위치에 배치한다. 상태 없는 지도를 정상으로 꾸미지 않는다. | `apps/web/src/features/monitoring/FloorMap.tsx`, `apps/web/src/features/monitoring/fixture-status-presentation.ts`, `apps/web/src/features/floor-map/FloorScene.tsx` |
| 2 | ‘지도 표시 N대’ 제거 | 해당 오버레이와 전용 표시용 계산만 제거한다. 실제 조명 수 KPI, 배치 판정, 지도 조회와 빈 상태는 보존한다. | `apps/web/src/features/monitoring/FloorMap.tsx`, `apps/web/src/features/monitoring/MonitoringView.tsx` |
| 3 | 모든 폭에서 지도 높이·시야 개선 | 부모 가용 높이를 flex/grid로 전달한다. 962/1017px 전용 분기는 만들지 않는다. 짧은 높이에서는 지도 최소 높이와 페이지 스크롤로 필수 조작·선택 핀에 접근하며 카메라를 임의 초기화하지 않는다. | `apps/web/src/features/monitoring/MonitoringView.tsx`, `apps/web/src/features/monitoring/FloorMap.tsx`, `apps/web/src/features/floor-map/FloorMapViewport.tsx` |
| 4 | 모든 시각 표현 통일 | 실제 timestamp 표시는 공통 `formatTimestamp(value, { timeZone })`로 `yyyy-MM-dd HH:mm:ss`를 사용한다. 24시간·초·자정 `00`·잘못된 값 `—`, 기존 시간대 의미와 원본 ISO 정밀도를 보존한다. 날짜·기간·반복 시각은 별도 의미를 유지한다. | `apps/web/src/features/monitoring/monitoring-time.ts`, `apps/web/src/features/control/control-time.ts`, `apps/web/src/features/statistics/reports/report-job-view-model.ts`; 전체 소비 목록은 5절 |
| 5 | 확인한 알람을 배지에서 제외 | 실제 보이는 알람만 읽음 PUT 성공 후 확인 처리한다. 계정별로 재로그인·다른 기기에도 유지한다. GET·센터 닫힘·화면 밖 항목은 읽음으로 만들지 않는다. | `apps/web/src/components/ui/session-status/SessionStatusCenter.tsx`, `apps/web/src/features/shells/CustomerShell.tsx`, `apps/api/src/monitoring-incidents/monitoring-incidents.service.ts`, `apps/api/prisma/schema.prisma` |
| 6 | 실제 조명을 원과 테두리 형태로 변경 | 원형 중심·상태 테두리·별도 선택 외곽선과 48px 터치 영역을 제공한다. 색 외 상태 식별과 예정 조명 구분을 유지한다. 장애와 게이트웨이 오프라인이 겹칠 때 서버 상태 색·주 상태명은 일치하고 연결 원인은 상세에 병기한다. | `apps/web/src/features/floor-map/FloorScene.tsx`, `apps/web/src/features/monitoring/fixture-status-presentation.ts`, `apps/web/src/features/monitoring/FixturePinPopover.tsx` |
| 7 | 명칭과 역할을 ‘알람센터’로 변경 | 제목·트리거·닫기 접근성 이름을 일치시킨다. 영속 장애 알람과 ‘현재 화면 상태’를 분리하며 후자는 DB 알람 배지에 합산하지 않는다. 기존 화면 안내·재시도·명령 진행 동작은 유지한다. | `apps/web/src/components/ui/session-status/SessionStatusCenter.tsx`, `apps/web/src/components/ui/session-status/SessionStatusProvider.tsx`, `apps/web/src/features/shells/CustomerShell.tsx`, `apps/api/src/monitoring-incidents/monitoring-incidents.controller.ts` |
| 8 | 로그 페이지 이동·50/100/500/1000·기간 필터 | 모니터링은 선택 층 범위를 유지하고 기본 50건으로 조회한다. 서버 기간·상한 지원 후 옵션을 노출한다. 명령 이력에도 같은 조회 경험을 적용하되 안전 진단은 보존한다. 기간·크기·범위 변경 시 첫 페이지, 실제 커서 기반 이전/다음, 보관 경계 오류를 처리한다. | `apps/web/src/features/monitoring/MonitoringLogDrawer.tsx`, `apps/web/src/features/monitoring/useMonitoringActivity.ts`, `apps/web/src/features/control/CommandHistoryPanel.tsx`, `apps/web/src/components/ui/PaginationBar.tsx`, `apps/api/src/monitoring-activity/monitoring-activity.controller.ts`, `apps/api/src/commands/command-status.service.ts` |
| 9 | 이동/선택/영역 버튼 대신 직관적 직접 조작 | 해당 조작 버튼을 제거하고 7절의 선택 우선 제스처를 사용한다. 수동·스케줄·이벤트, 개별·층·저장 구역 선택 기능과 전환 확인은 유지한다. | `apps/web/src/features/control/target-selection/TargetSelectionToolbar.tsx`, `apps/web/src/features/control/target-selection/SpatialTargetSelector.tsx`, `apps/web/src/features/floor-map/FloorMapViewport.tsx`, `apps/web/src/features/floor-map/map-gestures.ts` |
| 10 | 별도 ‘밝기 수치’ 필드 제거 | 중복 입력란만 제거한다. 큰 밝기 값에 단일 입력을 통합하며 모바일에서도 직접 입력 가능하다. | `apps/web/src/features/control/ControlView.tsx`, `apps/web/src/components/ui/fields/NumberField.tsx` |
| 11 | 굵은 밝기 값 직접 입력 + 슬라이더 | 두 입력은 하나의 0~100 정수 값을 공유한다. 빈 값·잘못된 draft 중 적용은 비활성이고 자동 명령은 없다. 정상 값과 명시 적용만 기존 안전 절차로 실행한다. | `apps/web/src/features/control/ControlView.tsx`, `apps/web/src/components/ui/fields/NumberField.tsx`, `apps/web/src/components/ui/fields/Slider.tsx` |
| 12 | 스케줄 필터 결과 건수만 표시 | 결과 설명은 ‘조건에 맞는 규칙 N건’만 표시한다. ‘번째 묶음·현재 N건’ 설명은 제거하되 실제 이전/다음·조회 수 조작은 유지한다. 실패·미조회 결과를 0건으로 표시하지 않는다. | `apps/web/src/features/control/automation/components/AutomationRuleControls.tsx`, `apps/web/src/features/control/automation/ScheduleControlPanel.tsx` |
| 13 | 스케줄 이름 잘림 개선 | 전체 이름을 줄바꿈하며 긴 한글·공백 없는 영문도 열 밖으로 넘치지 않는다. 좁은 화면은 기존 카드 목록을 유지한다. | `apps/web/src/features/control/automation/ScheduleControlPanel.tsx`, `apps/web/src/features/control/automation/components/AutomationRuleCard.tsx` |
| 14 | 적용 기간 별도 열 | PC 표에서 이름 아래 기간을 제거하고 ‘적용 기간’ 열로 분리한다. 모바일 카드에는 명시적 기간 필드를 유지한다. 반복 시각과 실행 시각 의미는 바꾸지 않는다. | `apps/web/src/features/control/automation/ScheduleControlPanel.tsx` |
| 15 | Gateway 동기화 열 제거 | 표·모바일 카드의 독립 동기화 항목을 제거한다. 적용 대기·실패 경고는 활성 상태 옆에서 식별 가능하며 기존 요약·동기화 필터·실패 이유·폴링·안전 차단을 보존한다. 활성과 장비 적용 완료를 동일하게 표시하지 않는다. | `apps/web/src/features/control/automation/ScheduleControlPanel.tsx`, `apps/web/src/features/control/automation/components/AutomationRuleControls.tsx`, `apps/web/src/features/control/automation/components/AutomationWorkspaceSurface.tsx` |
| 16 | 통계 기간 텍스트에 선택한 기간만 표시 | 기간 줄은 해당 필터/퀵 버튼이 선택한 `시작일 ~ 종료일`만 표시한다. 완료 경계·시간대·비교 기준 문구를 이 줄에 덧붙이지 않는다. 계산·비교 차단 기준은 유지한다. | `apps/web/src/features/statistics/StatisticsOverviewPage.tsx` |
| 17 | ‘핵심 절감 분석’ 제거 | overline과 그 전용 표시 코드를 제거한다. 실제 비교 카드·기간 선택·계산은 유지한다. | `apps/web/src/features/statistics/StatisticsOverviewPage.tsx` |
| 18 | 추정·KPI 수집 공백 배지 및 불필요 코드 제거 | 지정 배지와 미사용 presentation만 제거한다. 누락·부분 수집·실제 0, 추정 의미, 차트 단절·비교 불가·오류 상태를 유지하며 추정을 실측으로 표현하지 않는다. | `apps/web/src/features/statistics/StatisticsOverviewPage.tsx`, `apps/web/src/features/statistics/EnergyComparisonChart.tsx` |
| 19 | 분석 조건 공통 필터 적용 | 공통 필터 배치·필드 슬롯·기간 표현을 사용한다. 분석의 로컬 controlled 상태·응답 일치 검증·순위/차원/기간 의미는 유지한다. 없는 URL·초기화 기능을 새로 만들지 않는다. | `apps/web/src/features/statistics/analysis/StatisticsAnalysisPage.tsx`, `apps/web/src/features/statistics/analysis/EnergyHeatmap.tsx` |
| 20 | 리포트 필터를 다른 메뉴와 공통화 | 공통 필터 틀을 적용하되 URL·history 커서·300ms 검색·90일 검증·칩/기존 초기화·PDF 전용·서명 다운로드를 보존한다. 요청 기간을 보고서 집계 기간으로 바꾸지 않는다. | `apps/web/src/features/statistics/reports/ReportHistoryFilters.tsx`, `apps/web/src/features/statistics/reports/report-history-filters.ts`, `apps/web/src/features/statistics/reports/StatisticsReportsPage.tsx` |
| 21 | PC 확장 상세·모바일 하단 시트 | 명시적 ‘상세 보기’로 PC 비모달 패널 또는 좁은 폭 하단 시트가 열린다. 같은 상세 내용을 제공하고 로그 Drawer로 대체하지 않는다. 포커스·스크롤·카메라 계약은 3절을 따른다. | `apps/web/src/features/monitoring/MonitoringView.tsx`, `apps/web/src/features/monitoring/FixtureDetailPanel.tsx`, `apps/web/src/features/monitoring/FixturePinPopover.tsx`, `apps/web/src/components/ui/overlays/DialogBase.tsx` |
| 22 | 선택하지 않은 조명 상세 금지 | 검색/KPI 진입·데이터 도착 시 선택은 null이다. 첫 항목·첫 장애 자동 선택이나 다른 조명 대체를 하지 않는다. 필터·층·현장·principal 변경 시 선택을 폐기하고 관련 조명 검색 surface도 동일 원칙으로 확인한다. | `apps/web/src/features/monitoring/MonitoringView.tsx`, `apps/web/src/features/monitoring/MonitoringFixtureFinder.tsx`, `apps/web/src/features/monitoring/FixtureDetailPanel.tsx`, `apps/web/src/features/control/target-selection/FixtureSelectionDrawer.tsx` |

## 3. 공통 UI와 선택·상세 경계

기존 공통 UI의 단일 작성자가 다음 기반을 먼저 확장한다. 아래 신규 이름은 설계상 책임명이며 아직 구현된 파일이 아니다. 배치 위치는 `apps/web/src/components/ui` 계열로 한정하고 실제 신규 파일명은 실행 계획에서 고정한다.

| 기반 | 소유하는 책임 | 소유하지 않는 책임 |
| --- | --- | --- |
| `FilterPanel` | 공통 간격·반응형 필드 슬롯·기간 슬롯·칩·기존 초기화 작업의 배치·접근성 이름 | 페이지별 query·URL·debounce·권한·기간 제한, 없는 필터/초기화 기능 추가 |
| `PaginationBar` 확장 | 기존 total 기반 사용 보존, unknown-total cursor variant, 소비자별 `pageSizeOptions`, 이전/다음과 조회 중 상태 | 가짜 총건수/끝 페이지, 서버가 지원하지 않는 임의 페이지 점프 |
| `LogView` | 필터·기간·조회 수·이전/다음·로딩·빈 결과·오류의 공통 배치 | API/query·커서 저장·인증·재시도 정책·명령 진단/복구·로그 생성/삭제 |
| `DialogBase` 및 상세 surface | 모달/하단 시트의 기존 React Aria 기반 이름·초기 포커스·Escape·처리 중 닫기 제한·포커스 복귀 | PC 비모달 패널의 focus trap, 모든 대화상자를 같은 높이/형태로 강제 |
| 공통 `formatTimestamp` | 실제 시각의 표시 형식과 잘못된 값 처리 | 저장값·날짜 산술·시간대 정책·기간 경계·스케줄 계산 |

상세는 기본 `tablet` 경계 1024px 이상에서 비모달 측면 패널, 그 미만에서 하단 시트다. 200% 확대 시에는 실제 CSS 가용 폭에 따라 전환한다. 로그는 같은 공통 오버레이 접근성 기반을 쓰되 조명 상세 surface와 혼용하지 않는다. 기존 모달의 `compact` 760px 배치는 일괄 변경하지 않는다.

지도 핀의 간단 정보와 ‘상세 보기’는 유지하되 상세를 열면 동일 조명의 팝오버와 시트를 중복 표시하지 않는다. 지도 선택 ID, 검색 조건, 검색 surface 열림, 상세 확장 여부를 분리한다. 검색창 열림만으로 상세가 생기지 않는다. 명시적 검색 결과 선택은 허용하지만 목록 도착·필터 변경에 의한 선택 대체는 금지한다. 핀 선택 과정의 내부 검색/KPI 조건 초기화는 같은 선택 동작으로 원자적으로 처리하여 사용자가 방금 선택한 ID를 잃지 않게 한다.

사용자의 필터·층·현장·principal 변경은 선택을 폐기한다. 삭제·검색 결과 제외·접근 권한 상실로 선택 대상이 더 이상 유효하지 않으면 상세를 닫고 다른 대상은 대신 선택하지 않는다. 저장된 핀이 먼저 도착하고 runtime 정보가 늦는 경우에는 선택한 ID를 유지하고 ‘정보 확인 전/로딩’으로 표현한다. 로딩을 근거로 첫 runtime 행을 대입하지 않는다.

PC 패널은 Tab으로 지도·페이지와 오갈 수 있고 `aria-modal`/포커스 가두기를 적용하지 않는다. Escape/닫기는 현재 상세만 닫는다. 하단 시트는 모달 포커스 범위·제목·닫기 버튼을 갖고 본문만 스크롤하며 페이지 스크롤 위치를 복구한다. 열기/닫기·폭 전환으로 카메라가 초기화되거나 페이지가 맨 위로 튀면 안 된다. 닫을 때 연결된 원래 트리거로, 트리거가 사라졌으면 해당 지도/검색의 유효한 대체 포커스로 복귀한다. 목록/검색의 선택 패턴 감사는 조명 상세 범위이며 통계 순위의 기존 기본 항목 선택까지 무관하게 제거하지 않는다.

## 4. 지도 높이·상태·토큰

기준 구현은 360px 미만 300px, 그 이상 340px 지도와 1024px 이상 가용 높이 레이아웃을 사용한다. 이번에는 부모 → 작업 영역 → 지도 viewport까지 `min-height: 0`과 flex/grid 가용 공간을 전달해 임의 고정 계산의 빈 공간·잘림을 없앤다. 넓고 충분한 높이에서는 지도에 남은 공간을 우선 배분한다. 공간이 부족하면 지도 최소 240 CSS px와 페이지 세로 스크롤을 제공한다. 전체 보기/짧은 가로 화면에서도 헤더·도구·닫기·선택 핀이 가려지지 않고 스크롤로 접근 가능해야 한다.

범례는 실제 렌더링 상태를 사용한다. 정상·장애·오프라인·상태 확인 대기의 표시 정의를 지도와 공유하고, 현재 지도에 없는 상태 항목은 숨긴다. saved pin의 상태 정보 미수신은 정상으로 추정하지 않고 기존 ‘조명 정보 확인 전’ 표현과 대응하는 구분을 제공한다. 범례는 하단 왼쪽 기존 드래그 안내 자리에 두며 좁은 폭에서는 줄바꿈/예약 공간으로 확대 도구·핀과 충돌하지 않는다. 드래그 안내 문구는 별도 고정 오버레이로 남기지 않지만 지도 접근성 설명의 조작 안내는 유지한다.

실제 조명의 중심은 원형, 상태는 중심 밖 테두리, 선택은 그보다 바깥의 별도 외곽선으로 표현한다. 밝기는 기존 밝기 의미를 유지하고 미수신을 0%로 만들지 않는다. 장애/대기/오프라인은 아이콘 또는 테두리 패턴과 텍스트/접근성 이름으로도 구별한다. 복합 상태에서 서버 `status=fault`와 게이트웨이 오프라인 사유가 함께 있으면 주 색·주 상태명은 장애로 맞추고 연결 원인을 상세에 병기한다. 이 표시 정렬 때문에 서버 장애 판정/우선순위 계약을 바꾸지 않는다.

터치 히트 영역은 48×48 CSS px이고 작은 시각 점과 분리한다. 경계 핀도 히트 영역을 확보한다. 선택 외곽선과 키보드 포커스는 동시에 식별 가능해야 한다. 도면 요소·좌표·실시간 카메라·휠 포인터 기준 줌·pan/pinch·resize 카메라 보존은 유지한다. 원형 마커 변경은 실제 조명 표현 범위이며 CAD 도형이나 편집기 도형을 원형으로 바꾸는 작업이 아니다.

기존 `apps/web/src/styles/theme.css`의 `surface`/`content`/`border`/`status`/`fixture` 색, 밝기 색, `radius-panel`/`radius-control`/`radius-pill`, spacing과 focus 토큰을 재사용한다. `phone-wide=360`, `compact=760`, `tablet=1024`를 유지한다. 962/1017px만을 위한 분기, 페이지별 새 색·임의 z-index·중복 UI 기본 요소는 추가하지 않는다.

설치 예정 마커는 아직 별도 설치 브랜치의 기능이다. 향후 검토된 통합 시에는 예정 마커가 실제 조명·실제 KPI·제어 대상과 구별되는 기존 계약을 보존한다. 이번 기준 커밋에 없는 설치 파일이나 미커밋 수정은 가져오지 않는다.

## 5. 시각 표시와 소비 담당

공통 formatter는 `formatToParts`로 연·월·일·시·분·초를 조합한다. `yyyy-MM-dd HH:mm:ss`, Gregorian/숫자 형식, `hourCycle: h23`를 명시하여 자정은 `00:00:00`이다. 원 요청의 `hh`는 승인된 24시간 의미로 `HH`를 사용한다. 잘못된 timestamp는 `—`이며 유효하지 않은 입력을 다른 시각으로 보정하지 않는다. 현장 시간대가 있으면 그대로 전달하고 기존 기기 시간대 사용처는 기기 의미를 유지한다. 계정 시간대가 제공되는 기존 경로도 임의로 현장 시간대로 바꾸지 않는다.

ISO 저장값·`<time dateTime>`·API 정밀도·cursor 정렬 키는 그대로다. timestamp 표시를 초 단위로 줄여도 저장/정렬 정밀도는 줄이지 않는다. `YYYY-MM-DD` 날짜, 집계 날짜 범위, `HH:mm` 반복 시각, 경과 시간·차트 축은 timestamp가 아니므로 일괄 치환하지 않는다. PDF 표시를 다시 바꾸거나 기존 PDF의 시각 제거 결정을 되돌리지 않는다.

| 소비 범위/담당 | 실제 파일 | 전달·보존 범위 |
| --- | --- | --- |
| 모니터링 담당 | `apps/web/src/features/monitoring/monitoring-time.ts`, `apps/web/src/features/monitoring/MonitoringView.tsx`, `apps/web/src/features/monitoring/FixtureDetailPanel.tsx`, `apps/web/src/features/monitoring/FixturePinPopover.tsx`, `apps/web/src/features/monitoring/monitoring-activity-presentation.ts`, `apps/web/src/features/monitoring/MonitoringLogDrawer.tsx`, `apps/web/src/features/monitoring/MonitoringLogTicker.tsx` | 현장 시간대. 마지막 갱신의 raw ISO 표시도 공통 형식으로 변경하되 미래/잘못된 snapshot 경고와 판정은 보존한다. |
| 신설 제어 UI 담당 | `apps/web/src/features/control/control-time.ts`, `apps/web/src/features/control/CommandHistoryPanel.tsx`, `apps/web/src/features/control/CommandRiskReconcileDialog.tsx`, `apps/web/src/features/control/CommandVerificationCases.tsx`, `apps/web/src/features/control/automation/ScheduleControlPanel.tsx`, `apps/web/src/features/control/automation/VehicleEventControlPanel.tsx` | 현장 시간대. 축약된 최근 명령 시각·마지막 갱신·다음/최근 실행·감지 시각도 통일한다. 적용 기간 날짜와 반복 `HH:mm`은 보존한다. |
| 통계 담당 | `apps/web/src/features/statistics/StatisticsOverviewPage.tsx`, `apps/web/src/features/statistics/reports/report-job-view-model.ts`, `apps/web/src/features/statistics/reports/ReportJobTable.tsx`, `apps/web/src/features/statistics/reports/ReportJobCards.tsx`, `apps/web/src/features/statistics/reports/ReportJobList.tsx` | 실제 집계/조회/요청/만료 timestamp만 변경한다. 리포트는 기존 현장/기기 시간대 분기를 유지하고 집계 기간·오늘 진행 구간은 별도 의미를 유지한다. |
| 영향받는 설정/운영 담당 | `apps/web/src/features/settings/security/AccountSecurityView.tsx`, `apps/web/src/features/settings/users/SiteUsersView.tsx`, `apps/web/src/features/operator/site-admins/SiteAdminManagementView.tsx`, `apps/web/src/features/operator/LandingInquiriesView.tsx`, `apps/web/src/features/floor-editor/FloorEditorView.tsx` | 현재 기기 시간대의 로그인/만료·사용자/관리자/문의·revision 시각 표현을 공통 함수로 연결한다. 계정 정책, floor editor 기능·성능은 변경하지 않는다. |

`apps/web/src/features/control/automation/schedule-form.ts`, `apps/web/src/features/statistics/statistics-periods.ts`, 분석의 날짜 산술, `apps/web/src/features/setup/SetupWizard.tsx`의 시간대 검증은 표시 formatter 교체 대상이 아니다. 전역 검색/치환 대신 이 목록을 담당자에게 순차 전달하고 실제 timestamp 소비 누락을 검수한다.

## 6. 알람센터와 계정별 읽음 계약

### 6.1 원본과 최소 DB 확장

기존 `MonitoringIncident`의 `gateway_offline`/`fixture_stale`/`fixture_fault`/`command_failed` 4유형, 판정·회복·재발 시 새 ID 정책, operational `acknowledge`/`resolve`는 유지한다. 개인 열람은 장애 처리 업무 상태와 별개다. 이번 새 웹 센터에 기존 운영 acknowledge/assign/resolve UI를 추가하는 범위는 아니다.

신규 `MonitoringIncidentReadReceipt`는 `incidentId`, `userId` 복합 기본 키와 DB 기본값인 `readAt`을 갖는다. 원본 incident 및 User 두 FK는 삭제 cascade이며 사용자별 조회 인덱스를 둔다. 중복 읽음은 최초 `readAt`을 유지한다. 기존 incident에는 로그의 3개월 purge 정책이 없으므로 receipt 독립 TTL이나 새로운 알람 보존 정책을 도입하지 않는다. 원본 삭제 시 cascade만 적용한다. 알람 열람이 장비 데이터·DB 로그 보관/삭제 정책을 변경해서는 안 된다.

### 6.2 읽기와 읽음 API

- 기존 `GET /sites/:siteId/monitoring-incidents`의 실제 `incidents[]` 각 항목에 `isRead`/`readAt`을 추가한다. 기존 배열 이름·운영 상태·정렬·커서·`activeCount`를 보존한다.
- 현장 전체 `unreadCount`를 같은 GET에 추가한다. **원본이 보관된 현장 incident 중 현재 계정의 receipt가 없는 모든 항목**을 센다. 해결된 미읽음도 포함하며 상태/유형 필터·현재 페이지와 독립이다. `activeCount`는 기존 open+acknowledged 미해결 수다.
- 센터가 닫혀 있을 때 배지 조회는 기존 GET의 `limit=1`을 재사용할 수 있다. 별도 count API는 추가하지 않으며 이 조회로 읽음을 쓰지 않는다.
- `PUT /sites/:siteId/monitoring-incidents/:incidentId/read`는 멱등이다. 로그인 user ID는 서버가 결정하고 클라이언트가 임의 actor를 지정하지 못한다. viewer도 read 권한으로 자신의 receipt를 기록할 수 있다.
- 트랜잭션 안에서 접근 권한·활성 계정/멤버십과 incident 현장 소속을 재확인한다. 기존 접근 서비스의 잠금/경쟁 보호와 같은 경계를 사용하여 권한 회수·계정 삭제·원본 삭제와의 경쟁을 보호한다. 다른 현장/계정 기록을 쓰거나 노출하지 않는다.
- 최초 receipt가 있는 중복 PUT는 최초 `readAt`을 반환하고 덮어쓰지 않는다. 읽음은 incident revision을 변경하지 않아 `409` revision 계약을 새로 요구하지 않는다. 기존 오류 의미는 `401` 미인증/세션 만료, `403` 필수 비밀번호 변경 등 기존 권한 거부, `404` 접근 불가 현장·타 현장 incident·없는 incident, `400` 잘못된 입력이다. viewer의 자신의 읽음 기록에는 read 권한을 사용하며 manage 권한을 요구하지 않는다.
- backend 단일 작성자가 DTO·응답 검증·Prisma migration과 `docs/database-schema.md`를 함께 담당한다. 기존 소비자가 추가 필드 때문에 실패하지 않도록 additive 호환성과 strict parser 영향까지 먼저 검증한다.

### 6.3 화면의 읽음 시점과 상태 구분

센터의 제목과 트리거/닫기 접근성 이름은 ‘알람센터’다. 영속 장애 목록과 ‘현재 화면 상태’를 별도 구역으로 표시한다. 기존 `SessionStatusProvider`의 transient 조회 오류·연결 안내·명령 진행·toast·retry/actions는 유지하되 DB 알람 배지에 더하지 않는다.

센터가 열리고 활성 문서에서 해당 항목이 실제 화면에 보인 뒤에만 그 ID의 읽음 PUT를 요청한다. 펼치지 않은/화면 밖/다음 페이지 항목, 센터 닫힌 상태 GET는 읽음 처리하지 않는다. 스크롤로 보이는 항목도 동일하게 처리한다. 성공한 ID만 읽음으로 반영하며 요청 중·실패한 ID를 낙관적으로 읽음 또는 배지 0으로 만들지 않는다. 반복 관찰은 in-flight dedupe와 멱등 API로 보호한다.

읽음 성공 후 목록/배지를 정본 GET로 재검증한다. 로컬 숫자를 임의 차감해 두 기기 경쟁에서 음수·중복 차감이 발생하지 않게 한다. 다른 기기의 읽음은 기존 조회 갱신/복귀 시 서버 정본으로 동기화하며 별도 push 인프라는 도입하지 않는다. route·site·principal 전환 뒤 이전 응답이 새 화면에 반영되지 않게 scope를 격리한다.

`lastObservedAt`의 단순 polling 갱신은 읽음을 초기화하지 않는다. 같은 incident의 갱신은 계속 읽음이고 회복 후 새 incident ID만 새 미읽음이다. 읽은 미해결 장애는 목록에서 사라지지 않는다. 조회 실패는 ‘확인 불가/갱신 실패’를 보여주며 마지막 성공 수치가 있으면 stale로 구분한다. 성공한 실제 0 외에는 0 배지를 만들지 않는다.

주요 실제 경계는 `apps/api/src/monitoring-incidents/monitoring-incidents.dto.ts`, `apps/api/src/monitoring-incidents/monitoring-incidents.controller.ts`, `apps/api/src/monitoring-incidents/monitoring-incidents.service.ts`, `apps/api/src/monitoring-incidents/monitoring-incident-reconciler.service.ts`, `apps/api/src/access/site-access.service.ts`, `apps/api/prisma/schema.prisma`와 공통 session-status/CustomerShell이다. 기준 웹에는 incident 전용 API 소비 파일이 없으므로 검증된 producer 이후 담당자가 기존 `apps/web/src/api` 패턴에 맞춰 추가한다.

## 7. 제어 지도 제스처와 밝기

승인안은 선택 우선 A안이다. 선택 상태는 `SpatialTargetSelector`, pointer/keyboard 제스처는 `FloorMapViewport`가 각각 단일 소유한다. 제어용 정책은 명시적으로 전달하고 모니터링 기본 pan·휠 포인터 기준 확대 동작은 변경하지 않는다.

| 입력/범위 | 확정 동작 |
| --- | --- |
| PC 직접 조명 선택 | 핀 클릭은 선택 토글, 빈 공간 왼쪽 드래그는 영역 내 적격 조명 선택 추가. 기존 선택을 교체하지 않는다. |
| PC 지도 이동 | 빈 공간 Space+왼쪽 드래그 또는 중간 버튼 드래그는 pan. 중간 버튼의 브라우저 자동 스크롤과 영역 선택을 중복 실행하지 않는다. |
| 층 전체/저장된 구역 선택 | 빈 공간 드래그는 pan. 잠긴 구성원 선택을 직접 변경하지 않는다. 대상 방식 전환의 기존 확인을 유지한다. |
| 터치 | 핀 tap 선택 토글, 빈 공간 한 손가락 pan, 두 손가락 pinch. 빈 공간 long-press 후 드래그만 영역 추가. 핀 long-press는 영역 시작으로 사용하지 않는다. |
| 키보드 | 핀은 Tab·Enter·Space로 접근/토글, viewport 포커스에서는 기존 확대/이동 컨트롤과 목록 대체 경로를 사용한다. Space pan modifier는 빈 공간 drag에만 적용한다. |

초기 조작 임계값은 drag 8 CSS px, 빈 공간 long-press 400ms와 누르는 동안 이동 8px 미만이다. 이동 거리는 pointer 시작점에서 현재점까지의 CSS px 직선 거리다. 이 숫자는 단일 제스처 모듈에서 관리하고 테스트한다. 터치 hold 완료 전에 8px 이상 이동하면 pan으로 확정하고 영역을 시작하지 않는다. 지도 밖의 페이지 스크롤을 막지 않는다. drag 임계값 미만은 영역 선택으로 확정하지 않으며 선택 비우기는 기존 명시적 작업을 사용한다.

drag/pinch/long-press 영역 뒤 생성되는 click/tap은 억제한다. 두 번째 pointer가 들어오면 long-press timer·진행 중 영역을 취소한 뒤 pinch로 전환한다. `pointercancel`, capture 상실, 창 blur, Escape는 미확정 영역/선택 변경을 취소하고 timer·pointer 상태를 정리한다. 취소 뒤 남은 손가락을 새 영역 제스처로 자동 재시작하지 않는다. 이미 완료된 선택과 기존 pinch 카메라 취소/settle 정책은 보존한다.

입력·선택·텍스트 편집·contenteditable 포커스의 Space/Enter/화살표를 지도 단축키가 가로채지 않는다. 지도 영역에 포커스가 없는 전역 key 이벤트로 pan/선택이 시작되지 않는다. 터치 조명 팝오버와 제어 선택을 한 번의 입력에서 중복 실행하지 않는다. 기존 같은 Gateway 제한·오프라인/미매핑 차단·1,000개 선택 상한·제어 권한·실행 lock을 영역/목록/클릭 경로 모두에서 유지한다. 일부 영역 대상이 제외되면 기존 사유 안내에 접근할 수 있어야 한다.

밝기는 큰 굵은 `NumberField` 하나와 `%` 단위, 기존 `Slider`만으로 편집한다. 표시용 강한 숫자와 별도 ‘밝기 수치’ 필드를 중복하지 않는다. valid 값과 입력 draft는 분리하되 slider/명령에는 하나의 정상 정수 값만 사용한다. 입력 범위는 0~100이며 소수·범위 밖·빈 draft는 오류 상태다.

잘못된 draft 중 적용은 비활성이다. blur 시 마지막 정상 값으로 복귀하고 복귀 사실을 안내한다. 잘못된 입력이 남은 채 마지막 정상 값을 조용히 전송하지 않는다. 잘못된 draft의 blur를 일으킨 같은 클릭에서 복귀한 값을 즉시 적용하지 않으며, 복귀 안내 후 별도의 명시적 적용이 필요하다. Enter는 편집 확정만 수행하며 form submit/명령을 발생시키지 않는다. slider 또는 정상 입력·프리셋 변경만으로는 명령이 0건이어야 하고 명시적 적용만 기존 실행 절차를 사용한다. 현재 적용 잠금·진행 표시·취소·불확실 결과/복구 안전은 유지한다.

## 8. 로그·기간·페이지 계약

모니터링 전체 로그의 ‘전체’는 현재 선택 층의 보관 로그 전체이지 현장 전체 조회가 아니다. 명령 이력은 기존 현장 범위를 유지한다. 기본 50건, 옵션 50/100/500/1000을 두 로그에 적용하되 최근 명령/활동 요약의 별도 소량 조회는 유지한다. 기준 API 상한은 모니터링 50, 명령 100이므로 backend의 1,000 상한·기간 계약을 먼저 검증해야 한다.

기간 기본은 현재 보관 범위인 최근 3 calendar months다. 현장 시간대의 날짜 시작/종료 입력을 UTC `[start, end)`로 변환하며 화면 종료일은 포함하고 UTC end는 그 다음 현지 날짜 시작이다. 90일 고정 초 계산이나 기기 시간대 파싱으로 대체하지 않는다. DB `transaction_timestamp` 기반 보관 시작과 요청 기간의 교집합을 조회한다. 오늘은 DB 기준 현재 시각까지만 조회하며 경계일의 일부 보관도 실제 기준을 따른다.

두 로그의 원본 3 calendar months 삭제 기준을 변경하지 않는다. 기존 명령 보존 rollout 상태와 DB 시각 진단은 유지하고 UI로 강제 전환하지 않는다. 알람 incident 보관과 로그 보관은 다른 계약이다. 새로운 1년 요금제/보존 정책은 포함하지 않는다.

정렬은 실제 timestamp desc + id desc의 안정된 tie-break를 유지한다. 새 기간·scope·검색/단계 조건·조회 크기는 cursor scope에 결합하고 변경 시 첫 페이지로 초기화한다. timestamp 표시 초 단위 변환을 cursor에 쓰지 않는다. 늦은 이전 조건 응답은 현재 페이지로 반영하지 않는다. 기존 모니터링 `410` 만료와 명령 이력의 현재 만료 오류·인증 오류 처리를 유지한다. 잘못된 cursor를 빈 결과로 감추지 않는다.

unknown-total 페이지는 실제 현재 페이지 위치/조회 수와 이전·다음만 제공하고 total/끝 페이지/임의 점프를 표시하지 않는다. 현재 페이지 번호는 방문한 cursor stack에 근거한다. 필터 결과 건수가 있는 스케줄/보고서 등의 기존 total variant는 보존한다. 공통 페이지 옵션을 전역 1,000건으로 강제하지 않는다. 1,000건 조회에서도 전체 페이지가 길어지거나 footer가 사라지지 않게 로그 본문을 독립 스크롤하고 반복 행 렌더 비용을 검증한다.

현재 페이지 실패는 성공한 0건과 다르다. 최초 로딩·조건 적용·성공 empty·최초 실패·캐시 갱신 실패·만료를 구분한다. 명령 history stage/search·안전 시계 거부·결과 상세·복구·권한 안내는 기능 소유이며 공통 로그 틀 때문에 삭제하지 않는다.

producer 실제 경계는 `apps/api/src/monitoring-activity/monitoring-activity.controller.ts`, `apps/api/src/monitoring-activity/monitoring-activity.service.ts`, `apps/api/src/commands/command-status.service.ts`, `apps/api/src/commands/commands.controller.ts`, `packages/shared/src/monitoring-activity-contracts.ts`, `apps/api/src/retention/calendar-month-window.ts`, `apps/api/src/retention/command-detail-retention.service.ts`다. 소비 경계는 모니터링 activity hook과 `apps/web/src/api/commands.ts`, `CommandHistoryPanel`이며 API parsing/query key도 새 조건을 포함한다.

## 9. 스케줄·통계에서 보존할 의미

스케줄 이름은 생략하지 않고 기간을 PC 별도 열로 분리한다. 의도된 표 내부 가로 스크롤은 허용하지만 페이지 전체 overflow는 금지한다. 모바일 카드는 이름·활성·기간·다음 실행·반복 시각·밝기·대상·최근 결과와 관리 작업을 유지한다. 동기화 열/카드 독립 필드 제거 뒤에도 활성 옆 적용 대기/실패 경고, 상단 요약·필터·실패 이유·polling·실행 차단을 보존한다. ‘활성’은 authoring 상태이고 ‘적용됨’은 장비 동기화 상태다.

통계 overview의 기간 줄은 선택한 날짜 범위만 표시한다. 비교 기간과 추이 기간은 각각 자신이 실제 조회한 범위를 표시하고 서로 같다고 가정하지 않는다. 불필요 overline과 지정 배지의 미사용 import/표시 분기는 정리하되 데이터 상태 판정·계산·query·모델 필드는 제거하지 않는다.

실제 기록된 0은 0, 누락/계산 불가는 `—`/기존 안내다. 차트는 누락 구간을 연결하지 않고 `connectNulls=false`, 기존 누락 tooltip·불완전 자료 안내를 유지한다. 완료일 경계·동일 일수 비교·산정 불가·응답 불일치·권한·오류·retry를 유지한다. 기존 제목/설명에서 상태 기반 추정임을 알 수 있어야 하며 실측·청구액·검증된 절감액으로 이름을 바꾸지 않는다. 배지를 제거했다고 새 반복 경고 배지를 다른 곳에 만들지 않는다.

분석의 로컬 controlled 조건과 리포트의 URL·browser history cursor·검색 debounce·요청 기간 90일 검증은 각 페이지가 소유한다. 리포트 요청 날짜, 생성 문서 집계 날짜, API cursor timestamp는 서로 다르다. 공통 `FilterPanel`은 기존 chips/reset 슬롯을 받지만 분석에 없던 reset/URL 기능을 만들지 않는다. PDF 생성·재생성·만료·서명 다운로드와 별도 원본 CSV의 기존 동작은 그대로다.

## 10. 소유권과 통합 순서

같은 공유 파일/API/Prisma 경계에는 한 작성자만 둔다. 아래는 승인된 전달 순서이며 세부 작업·명령·커밋 체크리스트는 다음 실행 계획에서 작성한다.

| 순서 | 담당 | 소유·전달 조건 |
| --- | --- | --- |
| 1 | 기존 ‘Shell·인증·운영 담당자’ — backend 역할 | 공유 DTO/응답 계약·Prisma/receipt·incident 읽음 API·두 로그 기간/상한을 선행한다. migration 및 DB 문서도 같은 작업 단위다. producer 호환·권한·경쟁·기간 검증 커밋을 먼저 검토한다. |
| 2 | 같은 ‘Shell·인증·운영 담당자’ — 공통 UI 역할 | 1의 검증 커밋 이후 formatter/FilterPanel/PaginationBar/DialogBase/LogView와 알람센터·CustomerShell을 순차 변경한다. 동시에 두 역할로 같은 경계를 쓰지 않는다. |
| 3 | 기존 모니터링 담당 | 검증된 producer와 공통 UI를 소비하여 지도·마커·선택/상세·로그·시각을 변경한다. `FloorMapViewport`/`FloorScene` 공유 파일 작성 권한은 총괄이 해당 단계의 단일 소유자에게 전달한다. |
| 4 | 신설 제어 UI 개선 담당자 | 모니터링 단계 뒤 제스처·밝기·스케줄·명령 로그·시각을 소비한다. 세션 `01a0f776-b930-7eb2-a121-e05bef4d1581`, 모델 GPT-6.1 Sol/high를 사용한다. 기존 센서 제어 세션에는 UI 업무를 지시하지 않는다. |
| 5 | 기존 통계 담당 | 제어 단계 뒤 overview·분석·리포트 필터와 시각을 적용한다. 공통 UI 수정이 필요하면 직접 병렬 수정하지 않고 공통 작성자에게 반환한다. |
| 6 | 영향받는 설정/운영 담당 | 통계 단계 뒤 5절 timestamp 소비만 순차 적용한다. 센서·설치·floor editor 제품 기능은 확장하지 않는다. |
| 7 | designer 독립 UI/UX 검토 → 독립 코드 검토 → 총괄 | 증거와 아래 수용 기준을 대조하고 본 22개 주석/변경/영향 범위의 독립 검토 지적 P0/P1/P2 잔여 0을 확인한다. 총괄이 전체 실행 계획/상태판·검증·사용자 승인·기본 브랜치 통합을 관리한다. |

기능 변경 시 담당자가 영향받는 `docs/menus/monitoring.md`, `docs/menus/control.md`, `docs/menus/statistics.md`, `docs/menus/settings.md`, `docs/menus/operator.md`를 해당 코드와 같은 커밋에서 갱신한다. 문서는 기존 ‘구현 완료/미구현/부족하거나 개선이 필요한 기능/관련 파일/갱신 규칙’ 구조와 mock/HIL 한계를 유지한다. 이번 문서 작성 단계에서는 이 파일들을 갱신하지 않는다.

다른 worktree의 미커밋 Prisma/schema·문서·설치/센서 코드는 가져오지 않는다. 설치 브랜치의 `MonitoringView`/`FloorMap` 변경 및 향후 예정 마커는 승인·검증된 커밋 단위로만 총괄이 통합하고 본 설계의 실제 조명/선택 계약과 재검수한다. 공통 지도 파일이 겹치는 시점에는 파일 소유권을 반환받은 뒤 순차 조정한다. 기존 서버 재시작이나 브랜치 이동으로 검수 환경을 바꾸지 않고 별도 격리 환경을 사용한다.

## 11. 구현 후 검수와 완료 차단선

### 11.1 독립 화면 검수

| 조건 | 반드시 확인할 결과 |
| --- | --- |
| 폭 320/390px | 필터 세로 배치·긴 이름 줄바꿈·하단 시트·48px 히트·safe-area. 지도 핀/확대/닫기/주요 작업이 하단 내비나 시트에 가려지지 않는다. |
| 폭 768/962/1017px | 중간 폭에서도 지도 높이/도구/범례가 겹치지 않고 필터·상세가 중복되지 않는다. |
| 폭 1023/1024/1025px | 경계 양옆 상세 surface·지도 레이아웃 전환, 열린 상태 포커스/스크롤/카메라 유지. |
| 폭 1440px | PC 확장 상세와 충분한 지도 시야, 스케줄 기간 열과 전체 이름, 작업 접근. |
| 짧은 높이·landscape | 대표 390×320/768×390 및 desktop 1024×480에서 페이지 스크롤로 필수 조작에 접근하고 지도가 붕괴하지 않는다. |
| 브라우저 200% 확대·긴 한영 | 실제 재배치 결과를 확인한다. 긴 공백 없는 이름·날짜·상태·오류가 필드/버튼을 밀어내지 않고 상세 내용에 접근 가능하다. |
| 상태·접근성 | 정상/장애/오프라인/확인 대기와 fault+gateway offline 복합 상태, 미수신 pin, 선택 0개·빈/로딩/오류. 색 외 식별·키보드·Escape·포커스 복귀·스크롤 보존. |

페이지 전체 가로 overflow, 잘림, 겹침, 가려진 선택 핀은 0건이어야 한다. 표 내부의 의도된 가로 스크롤만 예외이며 이 예외로 주요 작업 접근을 숨기지 않는다. 이미지 증거뿐 아니라 실제 bounds·포커스·scroll·pointer 결과를 함께 확인한다.

### 11.2 데이터·권한·안전 회귀

- 로그 1,000건, 전체 선택 기간과 첫/마지막 부분 보관일, 같은 시각 id tie, cursor 조건 변경/만료/뒤로 가기, 다른 층·현장·계정 scope, 인증 실패와 오래된 응답 폐기를 확인한다. ‘전체 기간’은 보관 범위 전체이며 모니터링 선택 층 scope를 확대하지 않는다.
- 두 계정·두 기기의 동시 읽음, 최초 readAt 멱등 유지, 재로그인·route/site/principal 전환, 해결된 미읽음, 같은 incident polling, 회복 후 새 incident, 화면 밖/다음 페이지/닫힌 센터 비읽음, PUT 실패, 원본·계정 삭제 cascade와 권한 회수 경쟁을 확인한다.
- 클릭/탭 토글·영역 추가·Space/중간 버튼 pan·long-press·두 pointer 전환·pinch·Escape/blur/pointercancel·입력 key 충돌·지도 밖 스크롤을 확인한다. drag 임계값 미만 입력은 영역 선택이나 명령으로 실행되지 않는다.
- slider/입력/Enter/프리셋 편집만으로 명령 0건, 잘못된 draft 적용 불가·blur 안내, 정상 명시 적용, 같은 Gateway/오프라인/권한/상한·진행 lock·취소·불확실 결과 복구를 확인한다.
- 통계 실제 0/누락/부분 수집·차트 단절·완료 경계·비교 불가·응답 일치, 분석 로컬 조건, 보고서 URL/history·300ms·90일·서명 다운로드·PDF 전용을 확인한다.
- unit/API와 disposable DB에서 migration 전후·기존 소비 호환을 확인하고 실제 격리 백엔드 브라우저 여정을 검증한다. 실제 사용자 DB 적용이나 장비 명령을 테스트 편의상 사용하지 않는다.

최종 구현 판단은 fresh canonical root lint/typecheck/test/build, UI 정책 위반 0, 관련 API/DB·격리 브라우저 회귀, 독립 코드 및 designer 검토, 본 22개 주석/변경/영향 범위의 미해결 P0/P1/P2 0을 요구한다. 이는 전체 서비스 무결점 또는 운영 배포 가능 판정이 아니다. mock 자동 검증·실제 격리 소프트웨어·실기기 HIL 증거는 별도로 표기한다.

기존 설정 편집기 1,000개 8초 준비 성능 실패와 production dependency audit의 알려진 외부 High 2건 후속은 유지한다. 이번 UI 작업으로 해결했다고 표현하거나 한도/정책 예외를 넓혀 통과시키지 않는다. 기존 실패와 이번 범위의 fresh 결과를 분리해 총괄이 최종 통합 차단 여부를 보고한다. 새로 재현된 변경 영향 회귀는 원인/기준 비교 없이 ‘기존 부채’로 자동 면제하지 않는다.

## 12. 현재 산출 상태와 다음 관문

이 문서는 1~22번 행동·경계·수용 기준을 기록한 설계 산출물이다. 구현 완료, migration 완료, 테스트 통과 또는 화면 검수 통과를 뜻하지 않는다. 다음 관문은 사용자/총괄의 문서 검토이며 문서 승인 전에는 실행 계획 작성이나 제품 구현으로 진행하지 않는다.

designer의 이번 소유 범위는 본 파일 한 개다. 자기 검토는 번호 누락·모호성·내부 모순·placeholder·불필요 범위·기존 경로 존재를 대상으로 한다. 상태판·실행 체크리스트와 커밋은 총괄이 담당하고 designer는 stage/commit을 하지 않는다.
