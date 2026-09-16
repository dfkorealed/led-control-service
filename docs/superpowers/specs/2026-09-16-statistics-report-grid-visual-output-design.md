# 통계 보고서 목록·시각화 결과물 개선 설계

## 배경과 목표

현재 보고서 페이지는 보고서 한 건마다 큰 카드를 사용하고 API가 최신 50건만 반환한다. 사용자는 한 화면에서 더 많은 생성 현황을 확인하고, 10·20·50·100건 단위 페이지네이션으로 보관 이력을 탐색할 수 있어야 한다.

현재 PDF/XLSX는 저장된 집계값을 표와 텍스트로 정확하게 보존하지만 통계 개요의 정보 계층과 실제 차트를 제공하지 않는다. 개선 결과물은 선택한 보고서 기간을 기준으로 통계 개요와 같은 핵심 KPI·추이·비교 구조를 제공하고, PDF와 XLSX 모두에서 실제 차트를 표시해야 한다.

이 설계의 목표는 다음과 같다.

1. 보고서 생성 현황을 compact responsive data grid로 표시한다.
2. 전체 보관 이력을 서버 페이지네이션으로 조회한다.
3. 선택 기간의 저장된 실제값과 생성 당시 설정 기준값을 명확히 구분한다.
4. PDF와 XLSX가 동일한 immutable document와 동일한 차트 이미지를 사용한다.
5. 기존 tenant 권한, 보고서 fingerprint, scalar manifest, 재시도·만료·정리 계약을 유지한다.

## 범위

포함 범위:

- 보고서 이력 API의 keyset cursor 페이지네이션
- 페이지 크기 10·20·50·100, 기본값 20
- compact 데스크톱 data grid와 모바일 카드 표현
- 선택 기간 핵심 KPI, 일별 추이, 기준 비교, 동기간 비교, 순위, 히트맵
- PDF/XLSX 공통 chart visual model과 이미지 렌더링
- 기존 v1 보고서 snapshot의 하위 호환
- 접근성, 반응형, API·renderer·browser 회귀 테스트
- 통계 메뉴 문서와 DB index 문서 갱신

제외 범위:

- 목록 검색·정렬·상태 필터
- 탄소 배출, 목표·예산, 자동 최적화 제안
- 실시간 게이트웨이 연결 상태를 보고서에 포함하는 기능
- 보고서 생성 이후 값이 바뀌는 live dashboard

## 선택한 접근과 대안

### 목록 페이지네이션

선택: `createdAt desc, id desc`를 기준으로 하는 서버 keyset cursor 페이지네이션.

- 요청: `GET /energy/sites/:siteId/reports?limit=20&cursor=<opaque>`
- `limit`은 10·20·50·100만 허용한다.
- 응답: `{ reports, nextCursor, totalCount }`
- cursor는 version, createdAt, id만 포함하는 길이 제한 base64url 값이다.
- API는 `limit + 1`건을 조회해 `nextCursor`를 판단한다.
- `totalCount`와 페이지 행은 같은 repeatable-read transaction에서 조회한다.
- 이전 페이지 이동은 Web 세션의 cursor stack으로 제공한다.

클라이언트 페이지네이션은 최신 50건 cap 밖의 이력을 볼 수 없으므로 제외한다. Offset pagination은 활성 작업 polling 중 신규 작업이 선두에 추가될 때 중복·누락이 생길 수 있어 제외한다. 페이지 번호 직접 점프는 keyset과 맞지 않고 현재 보관량에서 필수 요구가 아니므로 이번 범위에서 제외한다.

### 보고서 차트 렌더링

선택: immutable visual specification을 공통 PNG로 렌더링하고 같은 bytes를 PDF와 XLSX에 삽입한다.

- 서버의 report document v2가 차트 종류와 기존 표 셀 reference를 보존한다.
- visual model은 별도 수치 배열을 재계산하지 않고 document의 표·요약 값을 참조한다.
- deterministic SVG를 만든 뒤 고정 크기 PNG로 변환한다.
- SVG→PNG 변환은 API production dependency인 `sharp`를 사용하고 Apple Silicon 개발 환경과 Linux production image에서 install/build smoke를 수행한다.
- PDF는 `pdf-lib`로 PNG를 삽입하고, XLSX는 `ExcelJS` image로 같은 PNG를 삽입한다.
- 원본 표와 모든 display value를 차트 아래 또는 대응 sheet에 계속 제공한다.

PDF만 vector chart를 그리고 XLSX는 표만 제공하는 대안은 두 형식의 동일 내용 요구를 충족하지 못한다. HTML/Chromium 기반 PDF는 기존 manifest·font·worker 메모리 계약과 XLSX 공통화를 크게 변경하므로 제외한다.

## 보고서 목록 UX

### 데스크톱 data grid

헤더와 행은 실제 `table`, `caption`, `thead`, `th scope="col"`, `tbody` semantics를 사용한다.

| 열 | 내용 |
| --- | --- |
| 대상 | 접수 당시 대상명과 scope 보조 문구 |
| 기간 | 시작일~종료일 |
| 형식 | PDF 또는 XLSX badge |
| 상태 | 대기·생성 진행률·완료·실패·만료 |
| 요청 시각 | locale 표시와 원 ISO `dateTime` |
| 파일 만료 | 완료·만료 상태만 표시 |
| 작업 | 다운로드 또는 다시 생성 |

정상 행은 52~56px, 헤더는 44px를 기준으로 한다. 실패 사유는 모든 행의 높이를 키우지 않고 상태 셀의 disclosure로 열어 colspan 상세 행에 정제된 message와 action을 표시한다. Processing 상태는 텍스트와 접근 가능한 progress를 함께 제공한다.

상단 toolbar는 `총 N건 · A–B 표시`와 공통 `SelectBox` 기반 페이지 크기 선택을 제공한다. 하단 `PaginationBar`는 이전·현재 페이지·다음을 제공한다. 이동 중 기존 행을 유지하고 grid에 `aria-busy`를 적용하며 완료 시 표시 범위를 polite live region으로 알린다.

새 보고서를 생성하면 cursor stack을 비우고 첫 페이지로 이동한 뒤 보고서 query prefix를 invalidate한다. 현재 보이는 페이지에 queued 또는 processing 보고서가 있을 때만 3초 polling을 유지한다.

### 모바일

768px 미만은 동일 view model을 `ul/li`와 카드 내부 `dl`로 표현한다. 첫 줄에 대상과 상태, 둘째 줄에 기간, 아래에 형식·범위·요청·만료 metadata, 마지막에 전체 폭 작업 버튼을 배치한다. 320px에서는 metadata를 한 열로 표시한다.

테이블 DOM을 CSS만으로 카드처럼 바꾸지 않는다. 데스크톱 table과 모바일 list markup을 분리하되 formatting, status, action view model을 공유한다. 모든 pagination·select·action target은 최소 44×44px를 유지한다.

## 보고서 내용과 의미

보고서는 선택한 완료 기간을 기준으로 생성된다. 통계 개요의 정보 계층은 유지하지만 모든 값에는 출처와 기준을 표시한다.

### 저장된 실제값

- 선택 기간 사용 전력량
- 선택 기간 저장 비용
- 직전 동일 일수 사용 전력량과 저장 비용
- 일별 전력량·저장 비용
- 조명·층·그룹 순위
- 요일×시간 에너지·밝기 집계

저장 비용은 각 일별 aggregate에 저장된 당시 적용 비용의 합계다. 현재 요금 단가를 과거 실제 비용으로 소급하지 않는다.

### 생성 당시 설정 기준값

- 선택 기간 24시간 100% 기준 전력량
- 기준 대비 전력 차이와 변화율
- 생성 당시 현재 단가로 환산한 기준 비용
- 생성 당시 현재 단가로 환산한 예상 절감 비용
- 데이터 수집률

기준값은 report snapshot에 계산 입력·계산 결과·단가·기준 시각을 함께 고정한다. UI와 문서에는 `생성 당시 설정 기준`을 표시한다. 실제 저장 비용과 현재 단가 추정 비용을 한 값으로 합치지 않는다. 기준보다 실제 사용량이 높으면 `절감` 대신 `기준 초과`로 표시하고 음수 절감액을 숨기지 않는다.

선택 기간 기준 전력량은 대상 scope에 속한 각 조명의 dimension history `ratedWatt`와 해당 scope에 유효하게 속한 완료 날짜의 전체 초를 곱해 합산한 뒤 kWh로 환산한다. 기준 비용은 이 전력량에 snapshot의 `Site.tariffKwhRate`를 곱한다. 예상 절감 전력은 기준 전력량에서 저장된 실제 전력량을 뺀 값이고, 예상 절감 비용은 그 차이에 같은 snapshot 단가를 곱한다. 데이터 수집률은 선택 기간·scope의 기대 수집 초 대비 일별 aggregate의 known duration 합계이며 100%를 초과하지 않는다. 단가 또는 기준 계산에 필요한 이력이 없으면 값을 임의 보정하지 않고 `데이터 없음`과 사유를 표시한다.

### 페이지 구성 예시

1. 표지·핵심 요약
   - 현장, 대상, 기간, timezone, 생성·기준 시각
   - 실제 사용량, 24시간 기준량, 절감률 또는 기준 초과율, 절감 전력, 예상 절감 비용, 수집률
   - 일별 chart compact preview
2. 사용량 추이
   - 실제 line과 24시간 기준 bar
   - null 구간은 0으로 연결하지 않고 공백/점선으로 표시
   - 날짜·전력량·저장 비용 원본 표
3. 동기간 비교
   - 현재 기간과 직전 동일 일수의 전력량·저장 비용 bar chart
   - 현재·직전·차이·변화율 표
4. 조명 순위
   - 상위 10개 horizontal bar와 전체 표
5. 층·그룹 순위
   - 각 상위 10개 horizontal bar와 전체 표
6. 요일×시간 에너지
   - 실제 7×24 color heatmap과 168개 값 표
7. 요일×시간 밝기
   - 실제 7×24 color heatmap과 168개 값 표
8. 계산 정보·fingerprint
   - 저장 집계, 기준 계산, 단가, 반올림, DST, 그룹 중복, 데이터 공백 규칙

긴 표는 다음 페이지로 이어지고 header를 반복한다. 실제 페이지 수는 일수와 대상 수에 따라 증가한다. XLSX는 같은 순서로 `표지·요약 / 일별 / 비교 / 조명 / 층 / 그룹 / 에너지 히트맵 / 밝기 히트맵 / 계산 정보` sheet를 제공한다.

## 데이터 모델

### 목록 계약

shared package에 strict query·response schema를 둔다.

```ts
type EnergyReportListQuery = {
  limit: 10 | 20 | 50 | 100;
  cursor?: string;
};

type EnergyReportListResponse = {
  reports: EnergyReportJob[];
  nextCursor: string | null;
  totalCount: number;
};
```

cursor 내부 payload는 `{ version: 1, createdAt: string, id: UUID }`다. API path의 siteId와 현재 사용자 권한이 범위를 결정하므로 cursor에 tenant 정보를 신뢰하지 않는다. 잘못된 limit, cursor 길이, base64url, JSON, timestamp, UUID는 400으로 정제한다.

DB에는 `EnergyReportJob(siteId, createdAt, id)` 복합 index를 추가한다. schema 변경과 함께 `docs/database-schema.md`를 갱신한다.

### 문서 v2

기존 v1 document snapshot은 90일 보관 기간 동안 계속 렌더링되어야 한다. shared contract는 v1과 v2 discriminated union을 허용한다. v2는 다음을 추가한다.

- `calculationBasis`: 실제값·기준값의 기준 시각, 단가, expected/known seconds, fixture count
- summary row의 `source`: `persisted_actual` 또는 `captured_current_configuration`
- table section의 optional `visualization`
- chart가 참조할 row/column ID와 표시 한도
- heatmap color scale와 `noData` 표현 규칙

지원 visualization:

- `daily_actual_vs_baseline`
- `period_comparison`
- `horizontal_ranking`
- `heatmap`

visualization은 기존 document cell을 reference하며 독립된 수치 사본을 보유하지 않는다. fingerprint 입력에는 calculation basis와 visualization specification을 모두 포함한다.

## 데이터 흐름

1. 사용자가 기간·scope·대상·형식을 선택한다.
2. API가 tenant read 권한과 완료 날짜 상한을 확인한다.
3. snapshot service가 저장된 일별·시간별 사실, 직전 동일 기간, 현재 fixture 기준 입력, 현재 단가를 한 snapshot에 고정한다.
4. document builder가 KPI·표·visualization reference·계산 설명을 만든다.
5. worker가 document fingerprint를 검증한다.
6. visual renderer가 document cell reference로 deterministic PNG를 만든다.
7. PDF와 XLSX renderer가 같은 PNG와 같은 scalar document를 삽입한다.
8. serialized 결과에서 scalar manifest와 chart image hash를 다시 추출해 source와 비교한다.
9. 검증된 파일만 object storage에 저장하고 job을 completed로 전환한다.

## 오류 처리

- 페이지네이션 입력 오류는 원시 parser 오류 없이 400을 반환한다.
- 페이지 이동 실패 시 현재 행을 유지하고 목록 상단에 재시도 가능한 오류를 표시한다.
- cursor 결과가 보관 정리와 겹쳐 빈 페이지가 되면 첫 페이지로 자동 이동하지 않고 이전 버튼을 제공해 사용자의 위치를 보존한다.
- chart reference가 없는 cell을 가리키거나 값 type이 맞지 않으면 snapshot invalid로 실패한다.
- SVG/PNG 변환, PDF 삽입, XLSX 삽입, manifest/image hash 검증 실패는 rendering failed로 정제한다.
- 생성 실패·저장소 실패·만료·다시 생성의 기존 공개 failure message/action 계약을 유지한다.
- chart는 장식적 중복 표현이다. 이미지 생성에 성공해도 원본 표·scalar manifest가 없으면 보고서를 완료하지 않는다.

## 컴포넌트 경계

공통 Web UI:

- `DataTableShell`: caption, table overflow, header surface, loading semantics
- `PaginationBar`: 이전·현재 page·다음, 표시 범위, live announcement

보고서 feature:

- `ReportJobTable`: 보고서 전용 열, 상태, failure disclosure, actions
- `ReportJobCards`: 모바일 표현
- `report-job-view-model`: 공통 formatting과 action 상태

API/report:

- `report-list-cursor`: cursor encode/decode와 validation
- `report-visual-model`: document reference를 renderer-neutral chart descriptor로 변환
- `report-chart-image.renderer`: deterministic SVG·PNG 출력
- 기존 PDF/XLSX renderer: layout과 동일 image 삽입

통계 개요 React 컴포넌트를 서버 renderer에 import하지 않는다. 개요와 보고서는 의미와 formatting 규칙을 공유하되 runtime/UI dependency를 공유하지 않는다.

## 테스트와 완료 조건

### Shared/API

- limit 10·20·50·100과 기본 20만 허용
- malformed·oversized cursor 400
- 동일 createdAt의 id tie-break, 페이지 중복·누락 없음
- `limit + 1`, nextCursor, 마지막 페이지, totalCount 검증
- tenant authorization 선행과 타 현장 정보 미노출
- expired 상태 변환과 활성 job 중복 방지 유지
- 100건 응답과 복합 index migration 검증

### Web

- 페이지 크기 변경 시 첫 페이지와 cursor stack reset
- next fetch와 previous stack 복귀
- site 변경과 새 보고서 생성 시 첫 페이지 reset
- 현재 페이지의 active job만 3초 polling
- 모든 job 상태, download, regenerate, 정제 오류 유지
- 데스크톱 table semantics와 모바일 list/dl semantics
- disclosure, progress, focus, live announcement 검증
- 1440×900, 1024×768, 390×844, 320×740에서 overflow와 44px hit area 검증

### 보고서

- 저장 실제값과 생성 당시 기준값의 source label 검증
- actual/baseline/savings/over-baseline 수식과 null·0 구분
- chart descriptor가 document cell만 참조함을 검증
- v1 stored document와 v2 document 모두 렌더링
- PDF/XLSX scalar manifest 동일
- PDF/XLSX chart PNG hash 동일
- 실제 7×24 heatmap, line, bar, ranking chart 존재
- 긴 일별·순위 표의 page/sheet continuation
- 한글 font와 추출 text round-trip
- 25MB 제한, worker retry, fingerprint, 만료·cleanup 유지

완료 조건은 101건 이상의 보고서 fixture로 페이지 크기 10·20·50·100과 next/previous를 실제 브라우저에서 확인하고, 같은 fixture에서 생성한 PDF와 XLSX가 동일 scalar manifest·chart image hash를 통과하며 실제 파일을 열었을 때 차트와 원본 표가 모두 보이는 것이다.

## 문서 갱신

- `docs/menus/statistics.md`: 보고서 목록, 페이지네이션, 실제 차트, 제한과 검증 결과
- `docs/database-schema.md`: `EnergyReportJob(siteId, createdAt, id)` index
- 새 운영 dependency를 추가할 경우 production image와 Apple Silicon/Linux CI 설치 계약

메뉴 문서의 `구현 완료`, `미구현`, `부족하거나 개선이 필요한 기능`, `관련 파일`, `갱신 규칙` 구조를 유지한다.
