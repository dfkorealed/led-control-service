# 통계 메뉴 기능 현황

기준일: 2026-09-12

## 구현 완료

- 이벤트 원장이 정리된 이후에도 fixture별 최신 sequence·payload hash를 보존하여 동일 상태를 재적산하지 않고 변경된 payload 재전송을 거부한다. watermark·원장·일별/시간별 적산·cursor·snapshot은 하나의 transaction이며 임시 PostgreSQL에서 중복, 동시 수신과 전체 rollback을 확인했다.

- 공통 고객 셸 상단은 현재 메뉴 제목과 실제 현장명 배지만 표시한다. 기존 층명 기반 `B2 주차장` 표기와 동작 없는 Gateway 정상·오프라인·미등록 상태 배지는 제거하되 설정의 `Gateway 상태` 상세 카드는 유지한다. 로그아웃 위치와 인증·dirty editor 확인 로직은 유지하고, 고객·운영자 셸의 로그아웃은 공통 `IconTooltipButton`으로 아이콘만 표시한다. `로그아웃` 도움말은 hover와 키보드 focus에서 열리고 도움말 위로 포인터를 옮겨도 유지되며 `Escape`로 닫힌다. 모바일 버튼은 52px 실제 터치 영역을 사용한다.

- P2 표준 보고서는 저장된 일별 전력량·비용을 요약/일별 표/조명·층·그룹 순위에 포함하고, 직전 동일 일수의 저장 합계와 차이·변화율을 함께 제공한다. 이전 값이 0이거나 없는 변화율은 `데이터 없음`이며 비용 0과 비용 없음은 구분한다. 과거 적용 단가·원천 산출식은 일별 집계와 연결된 증거가 없으므로 `데이터 없음`으로 명시하고, 현재 단가를 소급 적용하지 않는다. 두 형식은 같은 집계 출처·합산식·반올림 설명까지 포함한다.
- 현장 보고서 총계는 분석 이력 수집 전과 조명 종료 날짜의 저장된 일별 사실을 보존한다. 하루 전체의 소속/이름 이력이 확정되지 않는 값은 순위와 층·그룹 일별 표에 임의 배분하지 않는다. 실제 이전 schema에 일별 1.25 kWh/187.5원과 비교 기간 값을 넣은 뒤 전체 migration을 진행하는 회귀에서 합계·차이·변화율과 양 형식 manifest를 확인했다.
- 히트맵은 `bucketStartUtc`와 전체 유효 시작/종료 시각을 보존해 한 UTC 시간 전체가 같은 소속인 경우만 층·그룹에 포함한 뒤 요일/현지 시간으로 합친다. 정오 이동 전 09시와 이동 후 15시는 다른 층·그룹으로 귀속되고, 한 시간 안에서 소속이 바뀐 버킷은 비례 배분하지 않는다. 보고서 스냅샷도 같은 정밀도를 유지하며 DST 반복 시간은 동일 셀에 합산한다.
- `GET /energy/sites/:siteId/report-targets`는 read 권한 확인 뒤 현장 IANA timezone, 마지막 완료 현지 날짜, 운영 ID와 구분되는 분석용 조명/그룹 identity 및 보존된 과거 대상을 반환한다. 보고서 화면은 summary 대시보드 대신 이 전용 query를 사용한다. 날짜 기본값은 완료 전일까지 30일이며 종료일 max도 완료 전일이다. 로딩·오류·빈 대상 상태에서는 CSV/보고서 요청을 막고, 서버도 현재 현지 날짜와 다른 현장의 대상/운영 ID를 작업 수락 전에 거절한다. KST 자정과 뉴욕 DST 전환 경계를 실제 DB service/API 회귀로 확인했다.
- PDF는 고정된 OFL Noto Sans KR와 Noto Emoji 보조 글꼴을 포함해 `조명 💡`, NFC 한글·라틴/그리스/키릴·일본 문자와 지원되는 결합 악센트를 원문 그대로 출력한다. 실제 글꼴별 페이지 텍스트에서 추출한 값이 XLSX와 같음을 검증한다. code point뿐 아니라 실제 PDF 열 폭·크기·줄바꿈 및 보조 글꼴 구간으로 나눈 각 출력 줄의 shaping 결과도 확인한다. NFD 한글의 자동 조합처럼 원문 추출이 바뀌는 경우만 두 형식/CSV를 같은 `400`으로 거절하며, 원문을 보존하는 짧은 영문/NFD 혼합 문자열까지 일괄 거절하거나 PDF에서만 바꾸지 않는다.
- 문자 검사는 선택 범위·기간·저장 사실로 구성한 최종 문서에만 적용한다. 관련 없는 퇴역 조명의 과거 NBSP 이름은 현재 조명 보고서를 막지 않는다. 대상 API는 반환 label을 보존할 수 없는 항목만 결정적으로 제외하고 다른 유효한 대상은 계속 반환한다. 실제 DB 회귀에서 과거 문제 이름을 유지한 채 현재 보고서 1 kWh/150원과 XLSX/PDF 동일 manifest를 확인했다.
- 보고서 정리는 완료 파일의 7일 만료와 생성 후 90일 메타데이터 보관을 적용한다. 최종 `objectKey`와 무관하게 허용된 1·2·3회 키를 비공개 회수 원장에 예약하고, 60초마다 최대 50개를 `SKIP LOCKED`·30초 소유권 임대로 처리한다. S3 DELETE는 DB 잠금 밖에서 실행하며 짧은 후속 transaction이 소유자·임대를 재검사한다. 부분 실패나 정리 worker의 임대 상실 시 메타데이터·참조를 유지한다. 키만 저장하는 원장은 메타데이터 삭제/cascade/이전 정리 성공 뒤에도 영구 반복 회수하여 구버전 worker를 포함한 늦은 PUT을 제거한다. 삭제 barrier가 없는 활성 작업과 유효한 완료 파일은 대상이 아니다.
- 현장 삭제는 모든 보고서 시도 키를 `SiteDeletionCleanup`과 독립 `EnergyReportObjectCleanup`에 먼저 보존하고 신규 생성·worker claim을 차단한다. 생성/claim은 Site 잠금 뒤 새로운 DB 조회로 barrier를 재확인한다. 처리 중 작업은 `409`로 보류하며 worker 복구·종료 후 재시도한다. 기존 barrier 아래 남은 processing도 임대 만료 후 종료 상태로 회수해 영구 대기를 막는다. DB 잠금을 해제한 뒤 파일을 삭제하고, 저장소 오류 시 `503`으로 현장·보고서 행을 보존한다. 파일 삭제 성공 뒤에만 현장을 cascade 삭제한다. 기존 도면·인증서 정리가 완료되어도 별도 보고서 원장은 반복 회수한다. cascade 전 중단된 단계는 운영자의 현장 삭제 재시도로 이어간다.
- DB DELETE 트리거는 migration 완료 뒤 구버전 인스턴스가 runtime 원장 기록 없이 직접 삭제·90일 purge·Site cascade를 수행해도 고정된 3개 시도 키를 같은 transaction에 보존한다. 기존 reaper 임대는 유지하고 이후 늦게 올라온 파일도 비공개 반복 회수 대상에 남긴다.
- Chromium 21개 통계 시나리오로 히트맵 168셀의 0/데이터 없음·키보드 선택·밝기 전환, 분석 identity 대상 선택/완료 날짜 상한, 보고서 두 형식의 생성/진행/완료/다운로드와 실패·만료 재생성을 검증했다. 1440/1024/390/320px에서 문서 가로 넘침 부재와 조작 영역을 확인했다. 숨김 텍스트의 위치를 셀 안에 고정하고 둥근 버튼을 48px로 넓혀 실제로 닿는 44×44px 영역을 확보했다. 보고서 폼·닫기 버튼도 같은 터치 검사를 통과한다.
- 브라우저 다운로드 fixture는 실제 서버 렌더러가 만든 XLSX/PDF 바이트를 제공하고, 두 파일에서 다시 추출한 순서 있는 manifest가 동일 문서의 모든 scalar와 일치함을 검증한다. 다운로드한 파일도 그 바이트와 동일하다. 보고서 출력에 예상·추정·coverage·known/unknown·forecast·baseline·탄소/배출 내용이 없음을 검사했다. UI 작업 상태와 파일 서버는 결정적인 fixture이고 실제 API/DB worker 통합·MinIO 검증과 구분한다.
- 활성 보고서의 정확한 3초 polling과 완료·실패·만료 뒤 중단은 가상 시간 회귀로 확인했다. CSV 클릭 예외에서도 임시 anchor와 blob URL을 `finally`에서 해제한다.
- 보고서 생성 API는 고유 인덱스 충돌 직후 선행 작업이 종료되어 활성 조회에서 사라져도 최대 3회의 INSERT 시도로 새 작업을 생성한다. 계속 경합하면 재요청 가능한 `409`를 반환하며 원시 DB 오류를 노출하지 않는다. worker 종료 중 대기하던 DB claim이 반환되어도 새 스냅샷 조회나 heartbeat를 시작하지 않고, 이미 확보된 작업은 기존 임대 만료 후 복구할 수 있게 둔다.
- P2 보고서 서버 렌더러는 고정된 `EnergyReportDocument`의 제목·메타데이터·섹션·원시값·표시값·행 순서·fingerprint를 같은 순회로 XLSX/PDF에 기록한다. XLSX 숫자 셀을 유지하고 PDF에는 저장소의 OFL Noto Sans KR 폰트를 포함한다. 파일을 다시 읽은 셀/페이지 글리프 manifest를 문서와 대조하며, 긴 한글 이름과 A4 페이지 분할을 검증한다. CRLF 원문을 두 형식에서 보존하고, PDF는 실제 페이지·텍스트 좌표·연속 조각 순서로 행을 검증하여 페이지나 행 교환을 감지한다.
- `/statistics/reports`는 기간과 현장·조명·층·그룹 범위를 선택해 XLSX 또는 PDF의 동일한 표준 보고서를 요청한다. 비현장 범위의 대상 정보가 로딩 중이거나 비어 있으면 대상 상태를 알리고 보고서·CSV 요청을 막아 현장 ID를 다른 범위 identity로 대체하지 않는다. 목록은 대기·생성 중·완료·실패·만료 상태를 표시하며, 활성 작업만 3초마다 갱신한다. 완료 파일의 서명 URL은 다운로드 클릭 때만 받아 캐시에 보관하지 않고, 실패·만료 작업은 재생성 중복을 막고 실패 피드백을 제공한다. 같은 기간·범위는 CSV 내보내기에도 사용하며 응답 첨부 파일을 즉시 다운로드한다.
- `POST /energy/sites/:siteId/reports`는 strict 공통 요청을 받아 `202` 작업을 반환하고 현장·요청자·동일 요청의 활성 작업을 중복 생성하지 않는다. 목록(최신 50개), 상세, 다운로드 API는 데이터 조회 전에 현장 read 권한을 검사하고 다른 현장의 보고서 ID는 `404`로 숨긴다. worker가 첫 시도에서 완료된 날짜의 문서를 저장하고 이후 재시도는 이 저장 문서만 렌더링한다. PostgreSQL `SKIP LOCKED`, 30초 임대·10초 갱신, 최대 3회 시도와 살아 있는 소유자/시도 번호 검증을 적용한다.
- 보고서는 공개 도면과 분리된 비공개 버킷의 시도별 키에 업로드한다. 25 MB 상한과 HEAD 크기·MIME·SHA-256 검증 후 7일 만료 시각을 저장하며, 완료·미만료 파일만 안전한 파일명의 300초 서명 URL로 제공한다. 보고서 API와 파일은 no-store이고, `GET /energy/sites/:siteId/exports/csv`는 공통 문서의 메타데이터·표·표시값을 UTF-8 BOM, CSV 인용, 수식 접두어 방어를 적용해 행 단위 스트림으로 내보낸다.
- 로컬 MinIO 초기화는 전체 셸 절차를 `sh -c`의 단일 인자로 전달해 공개 도면용 `floor-assets`와 비공개 보고서용 `energy-reports` 버킷을 빠짐없이 만든다. Compose가 명령을 여러 인자로 분리해 초기화 컨테이너가 종료 코드 2로 실패하던 회귀를 실제 `docker compose config` 결과로 고정했다. 수정 후 초기화 컨테이너 종료 코드 0, 두 버킷 존재, 보고서 버킷의 private 정책을 확인했고, 이전과 동일한 현장 XLSX 요청을 새 작업으로 생성해 첫 시도 완료와 68,757바이트 파일 다운로드를 검증했다. 기존 실패 작업은 장애 이력으로 보존한다.
- 사용량 분석은 선택한 조명·층·그룹 순위 항목을 scope로 하는 P2 시간대 히트맵을 제공한다. 현장 timezone을 받은 뒤에만 최근 완료 28일을 조회하며, 에너지/밝기 전환, 7×24 시간대 버튼, 실제 0과 수집 데이터 없음의 구분, 선택 상세·재시도·빈 상태를 제공한다. 시간대 버튼과 지표 전환은 최소 44px 조작 영역이며, 좁은 화면의 24열 표는 카드 내부에서만 가로 스크롤한다.
- 통계 상단 메뉴의 밑줄형 시각·반응형 계약을 공통 `UnderlineNavigation`으로 분리해 제어 메뉴와 공유한다. 통계의 `NavLink`, query/hash 보존과 무아이콘 표현은 그대로 유지하며, 공통 label은 필요한 소비자만 장식 아이콘을 넣을 수 있다. Chromium computed style 비교와 공통 내부 focus ring 검증으로 제어 탭과 같은 시각 계약을 확인했다.
- 통계 route를 `StatisticsShell` 아래의 서브메뉴 구조로 분리했다. `개요`, P1 `사용 분석`, P2 `보고서`만 노출하며 `/statistics`와 알 수 없는 하위 route는 query/hash를 보존해 `/statistics/overview`로 replace 이동한다. 주 메뉴의 통계 active 상태는 모든 통계 하위 route에서 유지된다.
- `/statistics/analysis`에서 조명·층·그룹 단위를 전환하고 사용량, 예상 비용, 현장 기여도, 조명당 평균 기준으로 최대 400일을 높은 순/낮은 순 정렬한다. 순위 목록은 수집률과 포함 조명 수를 표시하고 선택 항목의 사용량·비용·기여도, 이전 동일 기간 변화, 일별 추이와 조명별 구성을 상세 패널에 제공한다.
- `GET /energy/sites/:siteId/rankings`는 strict shared query/response 계약을 사용하고 `read` 권한을 데이터 조회 전에 확인한다. 수집률 80% 미만 또는 구조 이력을 신뢰할 수 없는 항목은 별도 `unranked`로 반환하며, 그룹 중복 소속 합계가 현장 총계와 같지 않을 수 있음을 응답과 화면에서 알린다.
- 운영 `Fixture`/`FixtureGroup`과 분석 identity를 분리하고 이름·층·정격 W 및 그룹 membership의 유효기간 이력을 저장한다. 신규 조명 확정, 도면의 이름·정격 W 변경, 그룹 생성·수정·retire가 운영 변경과 같은 transaction에서 이력을 갱신한다. migration 이전 일별 합계는 현장 총계에는 포함하지만 당시 차원을 복원하지 않고 순위에서 제외한다.
- 상태 ingest는 기존 일별 집계와 신규 UTC 시간별 집계를 이벤트 원장·checkpoint·최신 조명 상태와 같은 transaction에 dual-write한다. 시간별 row에는 현지 날짜·시간과 UTC offset을 함께 저장해 DST 반복 시간을 구분하고 known/unknown 초, 밝기 가중 초를 보존한다.
- 시간별 집계는 UTC 기준 24개월이 지난 row를 한 번에 최대 10,000개씩 제거하는 worker를 제공한다. 일별 집계와 dimension/membership 이력은 이 retention 대상이 아니다.
- `GET /energy/sites/:siteId/comparisons?preset=last_7_days|current_month|current_year`를 추가했다. 최근 7일은 완료된 7개 현장 날짜, 이번 달은 월초부터 완료된 전일까지의 실적과 월말 예상, 올해는 월별 실적을 반환한다. 기간 계산은 현장 IANA timezone과 윤년·월말을 반영한다.
- 비교 응답은 24시간·100% 운전 기준 사용량, 실제 또는 예상 사용량, 절감 kWh·비용·절감률과 `saving`, `overuse`, `unavailable` 결과를 strict shared 계약으로 제공한다. 초과 사용은 음수 절감값을 0으로 보정하지 않으며, 비교 불가는 절감값을 `null`로 유지한다.
- `개요` 상단에 `최근 7일`, `이번 달`, `올해` preset과 절감률·예상 사용량·절감 전력·절감 비용 KPI를 추가했다. 비교 불가 시 기준 KPI와 산정 조건 설명만 유지하고 0 절감으로 표시하지 않는다.
- 기준 사용량은 막대, 완료된 실제 사용량은 실선, 이번 달 예상 사용량은 점선으로 표시한다. 사용량 미산정 point는 `null`을 유지해 선을 연결하지 않고 기준 막대만 남긴다. tooltip과 스크린리더 목록은 기간별 기준·실제/예상·차이 kWh·차이율·수집률을 함께 제공하고 `현재 등록 조명 기준`을 명시한다.
- 직전 동기간과 전년 동기간의 사용량 변화 및 양쪽 수집률을 별도 패널로 제공한다. 비교 자료가 없으면 해당 행만 `비교 불가` 상태로 두며, 과거 조명 구성이 보정되지 않았음을 `조명 구성 변화 미보정` 문구로 상시 알린다.
- comparison 로딩·오류·미산정 상태를 기존 summary와 series에서 분리했다. 비교 API가 실패해도 오늘·이번 달·올해 KPI와 기존 추이·비용 영역은 유지되고, 비교 영역만 다시 시도할 수 있다.
- comparison 런타임 Zod 계약은 `@led-control/shared/energy-contracts` ESM/CommonJS 서브패스로 배포한다. packed package 소비 테스트로 브라우저 ESM과 서버 CommonJS 양쪽에서 schema를 직접 불러올 수 있음을 검증한다.
- P0 Chromium 회귀는 saving·overuse·insufficient-state·summary/series/comparison 독립 재시도와 redirect query 보존을 검증한다. 1440×900, 1024×768, 390×844, 320×740에서 비교 chart/panel 스택, 44×44px 조작 영역, document 및 비교 chart의 가로 overflow 부재를 확인하고, 2400px 높이에서 shell이 남은 공간을 행 사이에 분산하지 않고 상단부터 채우는지 확인한다.
- 현장 `read` 또는 `control` capability가 있는 일반 유저는 통계 메뉴를 볼 수 있고, 시스템 role이 `viewer`이므로 admin 전용 설정 기능은 노출되지 않는다. mock Chromium 권한 여정은 read/control의 통계 메뉴 노출과 역할별 주 메뉴 exact 범위만 검증한다. 현장 에너지 API의 `read` capability 요구는 `energy.service.spec.ts`와 `site-access.service.spec.ts` 단위 테스트가 담당하며, 이 유저 관리 E2E가 통계 계산·API 응답·실장비 수집을 검증한다고 확대하지 않는다.
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
- 전기요금 단가/요금제 설정 연동
- 피크/경부하/중간부하 시간대 요금제
- P2-C 탄소·배출 계수, 배출량 계산과 관련 route/schema/UI
- 운영 시간·비운영 시간 낭비 분석 및 월 목표/예산을 포함한 최적화 기능(P1에서 제외)

## 부족하거나 개선이 필요한 기능

- 이벤트 watermark와 보존용 index만 추가했으며 원장 자동 삭제 worker는 후속 작업이다. 원장이 없는 임의 과거 event ID까지 영구 기억하지 않으며 legacy hash 누락 원장은 보존해야 한다. 사용자 DB 적용과 실장비 재전송 검증은 미실행이다.

- 보고서 파일의 7일 만료는 조회·다운로드에서 즉시 적용하며 물리 삭제는 60초 정리 주기와 backlog·저장소 상태에 따라 늦을 수 있다. 원장별 최대 3회 DELETE는 각 4초 제한이며 DB transaction 밖에서 수행한다. PUT 10초·HEAD 4초 제한은 네트워크 보호일 뿐 정지한 프로세스의 미래 PUT을 막는 증거로 쓰지 않는다. 회수 원장은 자동 삭제하지 않으므로 크기와 반복 DELETE 비용이 보고서 수에 따라 증가한다. 요청/문서 데이터는 원장에 포함하지 않는다. 매우 많은 보고서가 있는 현장의 삭제는 전체 시도 키 목록과 순차 저장소 삭제에 시간이 걸릴 수 있다.
- `OBJECT_STORAGE_REPORT_BUCKET`은 공개 도면 버킷과 달라야 하며 운영 저장소에서도 익명 읽기가 없는 버킷을 별도로 준비해야 한다. 로컬 compose는 기본 `energy-reports` 버킷에 익명 접근 금지를 적용한다. 보고서 스냅샷과 생성 파일은 서버 메모리에 존재하며 CSV 출력 문자열만 스트리밍한다. 작업 수락 전 Site 잠금 밖의 read-only 사전 조회로 실제 문서를 만들어 날짜·대상·출력 문자 지원 여부를 확인하고 폐기한다. 따라서 접수에도 집계 조회 비용이 추가되며 worker는 첫 시도에서 별도의 한 transaction으로 불변 스냅샷을 저장하고 재검사한다. 수락 이후 데이터 변경이나 저장소 오류로 생성이 실패할 수 있다.
- 글꼴 지원은 Unicode 전체가 아니다. 최종 출력에 있는 NBSP(U+00A0), VS16(U+FE0F), ZWJ(U+200D), NFD 한글의 자동 조합 등 원문 왕복이 불가능한 문자/문자열은 `400 Unsupported report …`로 거절한다. NFC 한글과 지원되는 결합 악센트·emoji는 허용하며 무관한 이력 이름을 이유로 거절하지 않는다. 이미 저장된 보고서 문서는 불변 원본을 유지하며 새 비용/정밀 이력 규칙의 문서는 같은 기간으로 새로 요청한다.
- 24시간·100% 기준선은 조회 시점의 현재 등록 조명과 정격 W를 사용한다. 조회 기간 중 등록·삭제·정격 변경이 있었다면 당시 조명 구성으로 소급 보정하지 않으므로 장기 비교의 절대값 해석에 주의해야 한다.
- 직전·전년 동기간 비교는 현재 누적 이력의 구조를 그대로 사용하고 과거 조명 구성 변경을 복원하지 않는다. 현재 응답의 history quality는 `legacy_structure_unknown`이며, 이력 snapshot을 도입하기 전까지 구성 효과와 실제 운영 절감 효과를 분리할 수 없다.
- P0/P1은 상태 이벤트와 정격 전력 기반의 소프트웨어 추정 기능이다. 실제 전력계·Raspberry Pi·ESP32-H2·BLE Mesh 상태 publication을 장기간 함께 사용한 절감률·순위 HIL은 이번 작업에서 실행하지 않았다.
- 운영시간·낭비·목표/예산과 `/statistics/optimization`은 사용자 요청에 따라 이번 범위에서 제외했다.
- migration 이전에 이미 쌓인 일별 사용량은 당시 층·그룹 구조를 알 수 없으므로 현장 총계에만 포함한다. 시간별 집계는 migration 이후 상태 이벤트부터 쌓이며 일별 데이터를 시간별로 가짜 변환하지 않는다.
- 공통 간격 토큰과 배치 규칙은 통계 메뉴에만 1차 적용했다. 모니터링·제어·설정의 기존 임의 간격은 각 메뉴 개선 시 동일한 규칙으로 전환해야 한다.
- 공통 우측 패널의 반응형·overflow 계약은 Chromium 1440/1024/390/320px route fixture로 검증했으며 실제 모바일 WebView safe-area와 브라우저별 scrollbar 표현은 별도 실측이 필요하다.
- summary/series의 `generatedAt`은 요청별로 한 번 고정되지만 여러 DB read가 하나의 repeatable-read snapshot으로 묶여 있지는 않다. 상태 ingest가 조회 중간에 commit되면 응답 내부 누적·forecast가 서로 다른 순간을 볼 수 있으므로 양산 정산 정확도가 필요해질 때 read-only repeatable-read transaction으로 묶어야 한다.
- 과거 누적 비용은 각 상태 적산 당시 단가를 사용하고 forecast와 24시간 baseline은 현재 단가를 사용한다. 현재 UI는 이 차이를 별도 설명하지 않으므로 단가 변경 이력이 있는 현장에서는 비용 비교 기준을 명시해야 한다.
- 근거 없는 절감 지표, 피크 시간, 추천 정책 고정 문구는 제거했다.
- 브라우저 자동 검증은 route fixture와 test-only MQTT publisher를 사용한 실백엔드 E2E까지 완료했지만 실제 Raspberry Pi, ESP32-H2, BLE Mesh 상태 publication을 포함한 HIL 결과는 아니다.
- 예상 전기료는 단일 단가 기반이며 복합 요금제를 반영하지 않는다.
- 층·그룹·조명 순위는 분석 이력이 있는 기간만 차원별로 제공한다. 한 현지 날짜 중간에 차원이 바뀐 경우 일별 aggregate의 날짜 단위 귀속 한계가 있으므로 정산 수준의 시간 비례 배분은 후속 검토가 필요하다.
- 실제 전력계 측정값이 아니라 BLE Mesh 상태 수신 이력과 정격 전력을 이용한 추정치다. 180초를 넘는 통신 공백은 사용량을 추정하지 않고 `partial`로 노출한다.

## 관련 파일

- `apps/api/src/retention/gateway-event-watermark.ts`, `apps/api/src/retention/gateway-event-watermark.integration.spec.ts`

- `apps/api/src/energy/reports/energy-report-targets.service.ts`
- `apps/api/src/energy/reports/energy-report-upgrade.integration.spec.ts`
- `apps/api/src/energy/reports/report-text.ts`
- `apps/api/src/energy/reports/report-pdf-layout.ts`
- `apps/api/src/energy/reports/energy-csv-export.service.ts`
- `apps/api/src/energy/reports/energy-report-jobs.service.ts`
- `apps/api/src/energy/reports/energy-report-worker.service.ts`
- `apps/api/src/energy/reports/energy-report-cleanup.service.ts`
- `apps/api/src/energy/reports/energy-report-cleanup.service.spec.ts`
- `apps/api/src/operator-site-admins/site-deletion-cleanup.service.ts`
- `apps/api/test/support/render-report-browser-fixtures.ts`
- `apps/api/src/energy/reports/energy-report-api.spec.ts`
- `apps/api/src/storage/object-storage.service.ts`
- `apps/api/src/storage/storage.module.ts`
- `.env.example`
- `docker-compose.yml`
- `scripts/dev-runtime.test.mjs`
- `apps/api/src/energy/reports/report-renderer.ts`
- `apps/api/src/energy/reports/excel-energy-report.renderer.ts`
- `apps/api/src/energy/reports/pdf-energy-report.renderer.ts`
- `apps/api/src/energy/reports/pdf-report-manifest.ts`
- `apps/api/src/energy/reports/pdf-report-order.ts`
- `apps/api/src/energy/reports/excel-report-xml.ts`
- `apps/api/src/assets/fonts/README.md`
- `apps/web/e2e/site-user-management.spec.ts`
- `apps/api/src/access/site-access.service.ts`
- `docs/ui-spacing.md`
- `docs/assets/statistics-analytics/statistics-overview-ui.png`
- `apps/web/src/components/ui/UnderlineNavigation.tsx`
- `apps/web/src/components/ui/SidePanel.tsx`
- `apps/web/src/features/statistics/StatisticsShell.tsx`
- `apps/web/src/features/statistics/StatisticsSubnavigation.tsx`
- `apps/web/src/features/statistics/StatisticsOverviewPage.tsx`
- `apps/web/src/features/statistics/StatisticsOverviewPage.test.tsx`
- `apps/web/src/features/statistics/analysis/StatisticsAnalysisPage.tsx`
- `apps/web/src/features/statistics/analysis/StatisticsAnalysisPage.test.tsx`
- `apps/web/src/features/statistics/reports/StatisticsReportsPage.tsx`
- `apps/web/src/features/statistics/reports/StatisticsReportsPage.test.tsx`
- `apps/web/src/features/statistics/reports/ReportCreateDialog.tsx`
- `apps/web/src/features/statistics/reports/ReportJobList.tsx`
- `apps/web/src/features/statistics/analysis/EnergyHeatmap.tsx`
- `apps/web/src/features/statistics/analysis/EnergyHeatmap.test.tsx`
- `apps/web/src/features/statistics/analysis/EnergyRankingList.tsx`
- `apps/web/src/features/statistics/analysis/EnergyRankingDetailPanel.tsx`
- `apps/web/src/features/statistics/EnergyComparisonChart.tsx`
- `apps/web/src/features/statistics/PeriodComparisonPanel.tsx`
- `apps/web/src/features/statistics/statistics-comparison.ts`
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
- `apps/api/src/energy/energy-analytics-query.service.ts`
- `apps/api/src/energy/energy-comparison-query.ts`
- `apps/api/src/energy/energy-rankings.service.ts`
- `apps/api/src/energy/energy-dimension-history.service.ts`
- `apps/api/src/energy/energy-hourly-aggregation.ts`
- `apps/api/src/energy/energy-retention.service.ts`
- `apps/api/src/energy/energy-periods.ts`
- `apps/api/src/energy/energy.integration.spec.ts`
- `apps/api/src/energy/fixture-state-ingestion.service.ts`
- `apps/api/prisma/schema.prisma`
- `packages/shared/src/energy-contracts.ts`
- `packages/shared/src/energy-analytics-contracts.ts`
- `docs/assets/statistics-analytics/statistics-analysis-ui.png`

## 갱신 규칙

통계 메뉴의 집계 기준, 차트, 요금 계산, 내보내기 기능이 바뀌면 이 문서를 같은 작업 안에서 갱신한다.
