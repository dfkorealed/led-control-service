# 통계 메뉴 기능 현황

기준일: 2026-09-10

## 구현 완료

- 공통 UI 간격을 4px 배수의 `4/8/12/16/24/32px` 토큰으로 정의하고 통계 메뉴에 1차 적용했다. 화면 섹션은 24px, KPI·패널 사이는 16px로 통일하고, 남는 세로 공간은 행 높이에 분산하지 않고 콘텐츠를 화면 상단부터 배치한다. KPI 상태 badge는 고정 높이·하단 예약 영역을 사용하는 absolute 배치에서 grid 배치로 전환해 불필요한 공백을 제거했다. 760px 이하에서는 KPI 라벨과 badge, 차트 제목과 기간 탭을 각각 세로로 배치해 한 글자 줄바꿈과 말줄임을 방지한다. 차트·비용 패널은 데스크톱 24px, 760px 이하 16px padding을 사용한다.
- 사용량 차트 오른쪽의 비용 비교 영역은 공통 `SidePanel`과 `ui-side-panel-layout`을 사용한다. 긴 비용·기준 문구는 패널 내부에서 줄바꿈하고, 좁은 화면에서는 차트 다음 한 열로 쌓아 가로 잘림을 만들지 않는다.

- 에디터의 배치/미배치 상태는 전력·비용 집계 대상에서 제외하는 조건으로 사용하지 않는다. 배치 해제와 좌표 이동은 전력 이력을 유지하고, 정격 W가 실제로 변경될 때만 기존 에너지 checkpoint를 닫는다. 격리 DB 회귀와 두 층 브라우저 E2E의 배치 해제·제어 후 등록 조명 수/24시간 기준/전력 이력 보존을 통과했다. 실제 소비 전력 측정이나 RF 검증은 아니다.

- 2026-09-02 무장비 회귀 점검에서 shared 응답 계약이 일별 point는 `YYYY-MM-DD`, 월별 point는 `YYYY-MM`만 허용하도록 granularity와 period를 함께 검증한다. Web/Playwright fixture도 실제 API 월 형식으로 통일했다.
- 월 forecast, 24시간·100% baseline, 양수·음수 절감량의 정확한 수치 회귀 테스트를 추가해 단순 존재 여부가 아니라 현재 계산식과 반올림 결과를 고정했다.
- Scene 22~23은 `에너지 리포트` 아래 3개 KPI, `상태 기반 추정 사용량` 차트, `비용 비교` 보조 영역 순서로 구성한다. 차트·비용은 1120px 초과에서 `minmax(0, 1fr) 330px`으로 나란히 보이고, 그 이하는 한 열로 쌓인다.
- 1440×900, 1024×768, 390×844, 320×740 Chromium route fixture에서 KPI 3/3/2/1열, 차트·비용 패널 분리/스택, 읽을 수 있는 축·기간 선택, document-level horizontal overflow 부재를 검증한다. 390px/320px의 공통 helper는 root 아래 interactive element 중 disabled/hidden, `.sr-only`/`aria-hidden`, `display`/`visibility`/`opacity`로 숨긴 조상을 제외하고 현재 viewport 및 실제 overflow clip과 교차하는 effective target을 검사한다. usable intersection을 1 CSS px 이하 cell로 나누고 각 cell 중앙 hit sample이 target 또는 그 descendant인 연속 44×44px 후보가 하나 이상일 때만 통과하며, 부분·완전 occlusion은 정상 peer가 있어도 실패한다. checkbox/radio는 모든 associated label과 input fallback 중 이 조건을 만족하는 후보를 사용한다. viewport-fixed target은 transform/filter/perspective 등 fixed containing block을 만드는 조상이 있을 때만 ancestor overflow clip을 적용한다. 차트 control을 viewport 중앙에 둔 상태에서 이 계약으로 기간 선택뿐 아니라 주 메뉴·현장 선택·로그아웃도 검증한다.
- Web은 선택 현장의 `GET /energy/sites/:siteId/summary`와 일별·월별 `series` wrapper를 React Query로 조회한다. URL에 `siteId`가 없으면 대시보드가 반환한 실제 현장 ID를 사용하며 legacy default estimate API로 우회하지 않는다.
- 오늘, 이번 달 누적, 올해 누적의 상태 기반 추정 사용량과 비용을 표시한다.
- 페이지 제목과 집계 시각은 공통 `PageHeader`, 추정 출처는 공통 `StatusBadge`로 표시한다. KPI는 공통 `MetricCard`에 공백으로 구분한 값·kWh, 비용과 `available`, `partial`, `no_data` `StatusBadge`를 하나의 접근 가능한 group 안에 제공한다.
- `Recharts` 반응형 꺾은선 차트와 일별·월별 segmented 탭을 제공한다. 데이터가 없는 point는 `null`로 유지해 선을 연결하거나 0으로 표시하지 않는다.
- 문서 읽기 순서는 KPI 다음 사용량 차트, 이번 달 비용 비교 순으로 유지한다. 760px 이하에서는 KPI를 2열, 360px 이하에서는 1열로 배치하며 차트·비용 패널은 한 열로 쌓는다. 일별·월별 버튼은 모바일에서 최소 44px 높이를 유지하고 중첩 grid의 최소 폭을 제한해 320px에서도 가로 overflow를 방지한다.
- 이번 달 예상 사용량·비용, 24시간·100% 밝기 기준 사용량·비용, 예상 절감 kWh·비용을 함께 표시하며 음수 절감값도 숨기지 않는다.
- `available`, `partial`, `no_data`를 색상뿐 아니라 `수집 완료`, `수집 공백 있음`, `수집 데이터 없음` 문구로 표시한다.
- known 시간이 전혀 없는 현장은 0 kWh 카드나 0선 대신 상태 수집 대기 화면을 표시한다. partial 현장은 누적값을 유지하고 수집 공백 경고와 기간별 공백 시간을 제공한다.
- summary에는 과거 known 사용량이 있지만 선택한 일별 또는 월별 series의 모든 point가 `null`이면 KPI와 비용 비교는 유지하고 `상태 기반 추정 사용량` 차트 영역만 데이터 없음 상태로 표시한다. summary가 실패하면 전체 리포트만 재시도하고, series가 실패하면 KPI·비용 비교는 유지한 채 차트 영역에서만 재시도한다.
- 차트 hover tooltip에는 기간, kWh, 비용, 수집 상태와 공백 시간을 표시한다. 같은 내용을 스크린 리더용 목록에도 제공해 hover 없이 확인할 수 있다.
- summary 실패와 series 실패를 분리한다. series 실패 시 KPI와 비용 정보는 유지하고 차트 영역만 다시 시도할 수 있다.
- 로딩, 전체 오류, 데이터 없음, 차트 오류는 공통 `FeedbackState`를 사용하며 summary와 series의 독립 재시도 범위는 유지한다.
- 현장 timezone을 기준으로 현재 월의 첫날·마지막 날과 현재 연도의 월별 조회 범위를 계산한다.
- `GET /energy/sites/:siteId/estimate`는 SiteAccess `read` 권한으로 현장을 검증하고, 다른 고객사 또는 미배정 현장은 `404`로 숨긴다.
- legacy `GET /energy/default/estimate`는 전환 호환성을 위해 API에 남아 있지만 현재 Web은 호출하지 않는다.
- Desktop Chromium과 390x844 mobile viewport의 route fixture 기반 Playwright에서 KPI, 일·월 탭, partial tooltip, no-data, 독립 오류 재시도, 가로 overflow를 검증한다.
- 격리 실백엔드 Chromium 설치 journey는 실제 MQTT 상태 publication을 API 적산 transaction과 application ACK 경로로 반영한 뒤 통계 화면의 오늘 사용량 카드와 2개 조명 기준선 설명이 표시되는지 확인한다. `partial`/`available`, 차트와 예상 비용의 세부 표현은 별도 deterministic route fixture에서 검증하며, 실백엔드 journey가 이 세부 assertion까지 수행한다고 확대 해석하지 않는다.
- MQTT v2 조명 상태 이벤트를 현장 IANA timezone의 날짜 경계로 분할해 `FixtureEnergyDailyAggregate`에 적산한다. 이벤트 원장, 최신 조명 상태, `FixtureEnergyStateCursor`, 일별 집계는 하나의 DB transaction으로 반영하며 중복·역순·stale checkpoint는 재적산하지 않는다.
- 도면 에디터에서 정격 전력을 변경하면 변경 직전까지 기존 정격 전력으로 checkpoint를 닫은 뒤 새 값을 저장한다.
- `GET /energy/sites/:siteId/summary`가 현장 timezone 기준 오늘, 이번 달 누적, 올해 누적 사용량과 비용을 상태 이벤트 기반 추정치로 반환한다.
- `GET /energy/sites/:siteId/series`가 `day` 또는 `month` 단위의 양끝 포함 시계열을 `{ siteId, timeZone, source, generatedAt, granularity, from, to, points }` wrapper로 반환한다. 데이터가 없는 point의 사용량과 비용은 `null`이다.
- 조회 시각을 한 번 고정하고 영속 일별 집계에 조명별 열린 상태 구간을 투영한다. 최신 상태는 최대 180초만 known으로 계산하며 이후 공백은 unknown으로 표시한다.
- 월 예상치는 모든 조명이 각각 월 known 3,600초 이상이고 현장 전체 coverage가 80% 이상일 때만 제공한다. 미달 시 `insufficient_state`, 등록 조명이 없으면 `no_registered_fixture`로 fail-closed 한다.
- 24시간·밝기 100% 기준선은 현재 등록 조명의 정격 전력, 현장 timezone의 실제 월 UTC 길이(DST 포함), 현재 단가로 계산한다. 예상 절감량과 절감 비용은 기준선에서 월 예상치를 빼며 음수도 숨기지 않는다.
- 일별·월별 시계열은 요청 범위의 양끝을 모두 포함하고, 일별 최대 400개·월별 최대 120개 point로 제한한다.
- summary와 series는 SiteAccess `read` 권한을 먼저 검사하므로 다른 tenant의 현장은 `404`로 숨긴다.
- 기존 `/energy/default/estimate`, `/energy/sites/:siteId/estimate`는 Web 전환 기간 동안 유지하며 응답에 `Deprecation: true` 헤더를 제공한다.

## 미구현

- 실제 전력계 기반 사용량 수집
- 일/월/년 기간 선택
- 사용자 지정 기간 조회
- 층별 전력 사용량 차트
- 그룹별 전력 사용량 차트
- 조명별 전력 사용량 상세
- 전기요금 단가/요금제 설정 연동
- 피크/경부하/중간부하 시간대 요금제
- 절감률 표시
- CSV/Excel/PDF 내보내기
- 통계 drill-down
- 전월 대비, 전년 대비 비교

## 부족하거나 개선이 필요한 기능

- 공통 간격 토큰과 배치 규칙은 통계 메뉴에만 1차 적용했다. 모니터링·제어·설정의 기존 임의 간격은 각 메뉴 개선 시 동일한 규칙으로 전환해야 한다.
- 공통 우측 패널의 반응형·overflow 계약은 Chromium 1440/1024/390/320px route fixture로 검증했으며 실제 모바일 WebView safe-area와 브라우저별 scrollbar 표현은 별도 실측이 필요하다.
- summary/series의 `generatedAt`은 요청별로 한 번 고정되지만 여러 DB read가 하나의 repeatable-read snapshot으로 묶여 있지는 않다. 상태 ingest가 조회 중간에 commit되면 응답 내부 누적·forecast가 서로 다른 순간을 볼 수 있으므로 양산 정산 정확도가 필요해질 때 read-only repeatable-read transaction으로 묶어야 한다.
- 과거 누적 비용은 각 상태 적산 당시 단가를 사용하고 forecast와 24시간 baseline은 현재 단가를 사용한다. 현재 UI는 이 차이를 별도 설명하지 않으므로 단가 변경 이력이 있는 현장에서는 비용 비교 기준을 명시해야 한다.
- 근거 없는 절감 지표, 피크 시간, 추천 정책 고정 문구는 제거했다.
- 브라우저 자동 검증은 route fixture와 test-only MQTT publisher를 사용한 실백엔드 E2E까지 완료했지만 실제 Raspberry Pi, ESP32-H2, BLE Mesh 상태 publication을 포함한 HIL 결과는 아니다.
- 예상 전기료는 단일 단가 기반이며 복합 요금제를 반영하지 않는다.
- 현재 추정치는 선택된 현장 단위로만 제공하므로 층별·그룹별 drill-down은 후속 구현이 필요하다.
- 실제 전력계 측정값이 아니라 BLE Mesh 상태 수신 이력과 정격 전력을 이용한 추정치다. 180초를 넘는 통신 공백은 사용량을 추정하지 않고 `partial`로 노출한다.

## 관련 파일

- `docs/ui-spacing.md`
- `apps/web/src/components/ui/SidePanel.tsx`
- `apps/web/src/features/statistics/StatisticsView.tsx`
- `apps/web/src/features/statistics/StatisticsView.test.tsx`
- `apps/web/src/features/statistics/statistics-periods.ts`
- `apps/web/src/styles.css`
- `apps/web/src/components/ui/MetricCard.tsx`
- `apps/web/src/components/ui/Card.tsx`
- `apps/web/src/components/ui/PageHeader.tsx`
- `apps/web/src/components/ui/StatusBadge.tsx`
- `apps/web/src/components/ui/FeedbackState.tsx`
- `apps/web/src/api/energy.ts`
- `apps/web/src/api/energy.test.tsx`
- `apps/web/e2e/statistics-flow.spec.ts`
- `apps/web/e2e/layout-assertions.spec.ts`
- `apps/web/e2e/support/layout-assertions.ts`
- `apps/web/playwright.config.ts`
- `apps/api/src/energy/energy.controller.ts`
- `apps/api/src/energy/energy.service.ts`
- `apps/api/src/energy/energy-periods.ts`
- `apps/api/src/energy/energy.integration.spec.ts`
- `apps/api/src/energy/fixture-state-ingestion.service.ts`
- `apps/api/prisma/schema.prisma`

## 갱신 규칙

통계 메뉴의 집계 기준, 차트, 요금 계산, 내보내기 기능이 바뀌면 이 문서를 같은 작업 안에서 갱신한다.
