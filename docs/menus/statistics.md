# 통계 메뉴 기능 현황

기준일: 2026-08-26

## 구현 완료

- `useEnergyEstimate`가 선택된 `siteId`를 query key와 API path에 함께 반영해 전력 추정 API 데이터를 조회한다.
- 일, 월, 년 사용량 kWh를 표시한다.
- 일, 월, 년 예상 전기료를 표시한다.
- 기간별 사용량을 막대 차트 형태로 표시한다.
- `GET /energy/sites/:siteId/estimate`는 SiteAccess `read` 권한으로 현장을 검증하고, 다른 고객사 또는 미배정 현장은 `404`로 숨긴다.
- `siteId`가 없을 때만 명시적 fallback으로 `GET /energy/default/estimate`를 사용하며, 기본 현장 선택은 접근 가능한 현장 ID의 안정 정렬 순서를 따른다.
- 차트 높이를 반환된 일/월/년 예상 사용량의 상대 비율로 계산한다.
- 추정 집계 상태를 UI에 표시한다.
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

- 근거 없는 절감 지표, 피크 시간, 추천 정책 고정 문구는 제거했다.
- 통계 API는 상태 이벤트 기반 summary·series·월 예상·절감량을 제공하지만, Web 화면은 아직 legacy snapshot estimate를 사용한다. 신규 API 기반 카드와 꺾은선 차트 연결은 Task 10 후속 작업이다.
- 예상 전기료는 단일 단가 기반이며 복합 요금제를 반영하지 않는다.
- 신규 API는 기준 현장, timezone, 기준 기간, 생성 시각, 마지막 집계 시각을 반환하지만 Web 표시는 아직 미구현이다.
- 현재 추정치는 선택된 현장 단위로만 제공하므로 층별·그룹별 drill-down은 후속 구현이 필요하다.
- 실제 전력계 측정값이 아니라 BLE Mesh 상태 수신 이력과 정격 전력을 이용한 추정치다. 180초를 넘는 통신 공백은 사용량을 추정하지 않고 `partial`로 노출한다.

## 관련 파일

- `apps/web/src/features/statistics/StatisticsView.tsx`
- `apps/web/src/api/energy.ts`
- `apps/api/src/energy/energy.controller.ts`
- `apps/api/src/energy/energy.service.ts`
- `apps/api/src/energy/energy-periods.ts`
- `apps/api/src/energy/energy.integration.spec.ts`
- `apps/api/src/energy/fixture-state-ingestion.service.ts`
- `apps/api/prisma/schema.prisma`

## 갱신 규칙

통계 메뉴의 집계 기준, 차트, 요금 계산, 내보내기 기능이 바뀌면 이 문서를 같은 작업 안에서 갱신한다.
