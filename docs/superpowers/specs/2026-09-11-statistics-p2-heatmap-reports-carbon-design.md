# 통계 P2 히트맵·보고서·탄소 설계

작성일: 2026-09-11

## 1. 범위

P2는 다음 세 기능만 제공한다.

1. 요일×시간대 사용량·평균 밝기 히트맵
2. CSV 즉시 내보내기와 Excel/PDF 비동기 보고서
3. 승인된 전력 배출계수에 근거한 탄소 배출·절감량

최적화 기능은 제외한다. 운영 시간, 비운영 시간 낭비, 월 목표·예산, `/statistics/optimization`, `waste` heatmap metric과 관련 보고서 section을 만들지 않는다. 고객 통계 서브메뉴는 `개요`, `사용 분석`, `보고서` 세 개로 구성한다.

## 2. 해결할 사용자 질문

- 어느 요일과 시간대에 조명이 가장 많이 사용되는가?
- 선택한 층·그룹·조명의 평균 밝기 패턴은 어떻게 다른가?
- 화면에서 확인한 결과를 한글 CSV·Excel·PDF로 공유할 수 있는가?
- 보고서가 언제 어떤 데이터와 산식으로 생성됐는지 다시 확인할 수 있는가?
- 기준 대비 에너지 절감이 몇 kgCO₂e의 배출 감소 또는 추가 배출에 해당하는가?
- 탄소 계산에 사용한 배출계수의 값, 출처, version과 유효기간은 무엇인가?

## 3. 검토한 접근

### 접근 A: 단계적 릴리스 — 권장

기존 시간별 집계로 heatmap과 CSV를 먼저 배포하고, durable report worker와 Excel/PDF를 두 번째로, emission factor와 탄소 기능을 세 번째로 연결한다. 각 단계가 독립적인 사용자 가치를 제공하며 파일 생성이나 factor 설정 문제를 실시간 분석과 분리할 수 있다.

### 접근 B: 통합 snapshot subsystem 우선

모든 화면·파일·탄소 기능이 사용할 snapshot layer를 먼저 완성한 뒤 한 번에 공개한다. 처음부터 일관성은 높지만, report worker·font·private storage 같은 고위험 작업 때문에 heatmap 공개도 함께 늦어진다.

### 접근 C: 브라우저에서 Excel/PDF 생성

서버 worker 없이 빠르게 시작할 수 있지만, tenant 데이터가 브라우저 메모리에 크게 적재되고 사용자 환경에 따라 결과가 달라지며 생성 이력·재현성·보존 정책을 보장하기 어렵다. 채택하지 않는다.

## 4. 정보 구조와 화면

### 4.1 사용 분석 `/statistics/analysis`

기존 순위·상세 아래에 `요일·시간대 사용 패턴`을 추가한다. heatmap의 분석 대상은 기본적으로 전체 현장이며, 사용량 순위에서 조명·층·그룹을 선택하면 같은 analytics identity로 바뀐다.

- 지표: `사용량`, `평균 밝기`
- 기본 기간: 오늘 이전 완료된 최근 28일
- 최대 기간: 양끝 포함 92일
- 행: 월요일~일요일
- 열: 현지 0시~23시
- 결측: 빗금/중립 패턴과 `데이터 없음`
- 0 사용: 정상 색 범위의 최저 단계와 `0 kWh`
- 선택 상세: 값, 수집률, known/unknown 시간, 포함 UTC bucket 수

같은 local hour가 DST 때문에 두 번 생기면 실제 UTC bucket을 같은 cell에 합산한다. 평균 밝기는 `Σ brightnessWeightedSeconds ÷ Σ knownSeconds`로 계산한다.

### 4.2 보고서 `/statistics/reports`

상단에는 `CSV 내보내기`와 `보고서 만들기` action을 둔다. 본문에는 생성 이력과 탄소 요약·근거를 제공한다.

보고서 생성 입력:

- 기간: 최대 92일
- scope: 전체 현장 또는 선택한 fixture/floor/group analytics identity
- 형식: Excel 또는 PDF
- 포함 section: 사용량·비용, 절감률, 동기간 비교, 사용량 순위, 시간대 패턴, 탄소, 데이터 품질, 산정 정보

목록 상태:

- `queued`: 생성 대기
- `processing`: 진행률 표시
- `completed`: 다운로드
- `failed`: 실패 코드와 다시 생성
- `expired`: 파일 만료와 다시 생성

모바일에서는 넓은 table을 그대로 축소하지 않고 report card list로 바꾼다.

### 4.3 탄소 UI

탄소는 별도 고객 서브메뉴를 만들지 않고 보고서 페이지의 요약과 근거 영역으로 제공한다.

- 추정 탄소 배출량
- 기준 탄소 배출량
- 기준 대비 절감 또는 추가 배출
- 상태 기반 데이터 수집률
- factor 값·단위·지역·출처·version·유효기간

factor가 없으면 숫자를 0으로 표시하지 않고 `배출계수 설정이 필요합니다`를 표시한다. customer admin과 viewer는 factor를 수정할 수 없다.

### 4.4 operator 배출계수 관리

`/operator/emission-factors`에서 catalog version 생성과 site assignment를 관리한다. 승인된 catalog row는 수정하지 않고 새 version을 추가한다. assignment 변경은 기존 유효기간을 닫고 새 row를 생성한다.

## 5. API 계약

```http
GET /energy/sites/:siteId/heatmap
  ?from=YYYY-MM-DD
  &to=YYYY-MM-DD
  &metric=energy|brightness
  &scope=site|fixture|floor|group
  &identityId=<required for non-site scope>

GET /energy/sites/:siteId/exports/csv
  ?from=YYYY-MM-DD&to=YYYY-MM-DD&scope=...

POST /energy/sites/:siteId/reports
GET  /energy/sites/:siteId/reports
GET  /energy/sites/:siteId/reports/:reportId
POST /energy/sites/:siteId/reports/:reportId/download

GET  /energy/sites/:siteId/emissions?from=YYYY-MM-DD&to=YYYY-MM-DD

GET  /operator/emission-factors
POST /operator/emission-factors
GET  /operator/sites/:siteId/emission-factor
PUT  /operator/sites/:siteId/emission-factor
```

모든 신규 query/response는 strict shared Zod schema를 사용한다. site read endpoint는 `SiteAccessService.assert(..., "read")`를 query보다 먼저 수행한다. operator endpoint는 operator role만 허용한다.

## 6. 데이터와 계산

### 6.1 Heatmap

`FixtureEnergyHourlyAggregate`의 저장된 `localDate`, `localHour`, `utcOffsetMinutes`, `knownSeconds`, `unknownSeconds`, `brightnessWeightedSeconds`를 사용한다. 서버 timezone으로 UTC bucket을 다시 변환하지 않는다.

각 cell은 다음을 반환한다.

- `estimatedKwh`
- `averageBrightness`
- `knownSeconds`
- `unknownSeconds`
- `coverageRate`
- `utcBucketCount`
- `dataStatus`

### 6.2 Report snapshot

`EnergyReportSnapshotService`가 summary, comparison, ranking, heatmap, emissions를 하나의 `RepeatableRead` transaction과 하나의 `generatedAt`으로 조립한다. CSV, Excel, PDF는 이 snapshot만 소비한다.

### 6.3 Carbon

```text
추정 배출량 = Σ(현지 날짜별 추정 사용량 kWh × 해당 날짜의 factor)
기준 배출량 = Σ(현지 날짜별 기준 사용량 kWh × 해당 날짜의 factor)
절감량      = 기준 배출량 - 추정 배출량
```

기간 중 factor가 바뀌면 날짜별 유효 factor로 계산한다. 하루라도 factor assignment가 없거나 겹치면 전체 기간을 `unavailable`로 반환한다. 기준 사용량은 P0와 같은 `현재 등록 조명·24시간·100% 밝기` 방식이며 화면과 파일에 이 한계를 표시한다.

## 7. 보고서 처리와 저장

Excel/PDF는 `EnergyReportJob` DB row로 관리한다. worker는 `FOR UPDATE SKIP LOCKED`로 한 건을 claim하고 30초 lease를 갱신한다. 최대 3회 실패 후 `failed`로 전환한다.

### 7.1 기술 스택과 선택 이유

| 영역 | 기술 | 적용 방식과 선택 이유 |
|---|---|---|
| 요청·권한 | NestJS controller/service + shared Zod | 웹과 API가 같은 기간·scope·section 계약을 사용하고, tenant 권한 확인을 데이터 조회보다 먼저 수행한다. |
| 스냅샷 | Prisma 6 + PostgreSQL `RepeatableRead` | 여러 통계 query가 서로 다른 시점의 값을 섞지 않도록 한 transaction에서 읽고 `dataSnapshot` JSON으로 고정한다. |
| 작업 큐 | PostgreSQL job table + `FOR UPDATE SKIP LOCKED` | P2에서는 BullMQ 같은 새 운영 인프라를 추가하지 않고, 이미 쓰는 DB lease worker 패턴으로 재시도·다중 인스턴스 claim을 보장한다. |
| CSV | Node.js `Readable` stream + 자체 cell encoder | 작은 전용 규칙으로 UTF-8 BOM, RFC 4180 quoting, spreadsheet formula injection 방어를 적용하며 전체 CSV 문자열을 메모리에 만들지 않는다. |
| Excel | ExcelJS | 다중 sheet, 숫자 cell type, freeze pane, 인쇄 영역, 열 너비와 cell style을 직접 제어한다. |
| PDF | pdf-lib + `@pdf-lib/fontkit` + Noto Sans KR | headless Chromium 없이 서버에서 A4 vector 문서를 만들고 repository 포함 한글 글꼴로 실행 환경별 폰트 차이를 없앤다. |
| 파일 저장 | AWS SDK v3 S3 client + presigner | S3/MinIO 호환 private object를 사용하고 API 권한 재검사 후 5분짜리 GetObject URL만 발급한다. |
| 무결성 | Node.js `crypto` SHA-256 + S3 HEAD | 생성 파일 checksum·size를 DB와 object metadata에 함께 기록하고 완료 전 업로드 결과를 검증한다. |
| 웹 상태 | React 18 + TanStack Query | 생성 mutation 뒤 job list를 갱신하고 active job만 polling하며 terminal state에서 자동 중단한다. |
| 검증 | Jest, Playwright, Poppler | service/state transition, 실제 XLSX 구조, PDF text/page render, 생성·다운로드 UI 흐름을 계층별로 확인한다. |

MVP worker는 기존 NestJS worker와 같은 `OnModuleInit` poller로 API 프로세스 안에서 시작한다. 여러 API instance가 동시에 떠도 DB lease 때문에 하나의 instance만 job을 소유한다. 보고서 부하가 커지면 같은 worker provider를 별도 process entrypoint로 분리할 수 있지만 API 계약과 DB schema는 바꾸지 않는다.

### 7.2 생성 요청부터 다운로드까지

1. 웹의 `보고서 만들기` dialog가 기간, scope, 형식, section을 shared schema로 검증한다.
2. `POST /energy/sites/:siteId/reports`가 site read 권한을 확인하고 request를 canonical JSON으로 정렬한 뒤 SHA-256 `requestHash`를 만든다.
3. 같은 site/requester/hash의 active job이 있으면 새 job을 만들지 않고 기존 job을 반환하고, 아니면 `queued` row를 만들며 `202 Accepted`를 반환한다.
4. worker가 job을 claim해 `processing`으로 바꾸고, 첫 시도라면 하나의 `RepeatableRead` transaction에서 공통 snapshot을 만든 뒤 `dataSnapshot`에 저장한다. 재시도는 DB에 고정된 snapshot만 사용한다.
5. format adapter가 snapshot을 ExcelJS workbook 또는 pdf-lib document로 변환한다. 원시 telemetry는 파일 생성 단계에서 다시 조회하지 않는다.
6. worker가 bytes의 SHA-256과 크기를 계산하고 attempt 전용 private key로 업로드한 뒤 HEAD 결과를 확인한다.
7. 살아 있는 lease를 가진 worker만 `completed`, `objectKey`, checksum, size, expiry를 원자적으로 저장한다. lease를 잃은 worker의 object는 orphan cleanup 대상이 된다.
8. 웹은 active job이 있을 때 3초 간격으로 목록을 갱신하고 terminal state가 되면 polling을 멈춘다.
9. 사용자가 `다운로드`를 누르면 API가 site 권한, job 상태, 만료를 다시 확인하고 5분짜리 signed URL과 안전한 filename을 반환한다. URL과 storage credential은 DB와 log에 저장하지 않는다.

`EnergyReportSnapshot`에는 요청 metadata, site timezone, `generatedAt`, summary/comparison, 최대 92개 daily row, ranking, 168개 heatmap cell, emissions 또는 unavailable reason, data-quality/source 설명만 넣는다. 원시 상태 event는 넣지 않아 DB JSON과 생성 메모리 사용량을 제한한다. 한 worker는 한 번에 한 job만 렌더링하며 생성 파일은 25 MB 상한을 두고 초과 시 `report_too_large`로 실패시킨다.

### 7.3 작업 상태와 재시도

상태 전이는 `queued → processing → completed|failed`로 제한하고 파일 보존기간이 지나면 `completed → expired`로 바꾼다. worker는 30초 lease를 작업 경계마다 갱신하며 최대 3회까지 지수 backoff로 재시도한다. validation 오류처럼 다시 시도해도 달라지지 않는 오류는 즉시 `failed`, S3 timeout 같은 일시 오류만 재시도한다.

업로드 key는 `reports/{siteId}/{reportId}/attempt-{attemptCount}.{xlsx|pdf}`처럼 attempt별로 분리한다. 이 방식은 lease가 만료된 이전 worker가 뒤늦게 upload를 끝내도 새 worker가 만든 파일을 덮어쓰지 않게 한다. 완료 row가 가리키는 object만 사용자에게 제공하고, cleanup은 `1..attemptCount` key를 계산해 참조되지 않은 object까지 제거한다.

처리 순서:

1. request canonical JSON과 SHA-256 hash 저장
2. RepeatableRead snapshot 생성·고정
3. ExcelJS 또는 pdf-lib로 bytes 생성
4. SHA-256 checksum과 함께 attempt 전용 private S3 object 업로드
5. live lease owner만 `completed`로 전환

완료 파일은 7일, metadata는 90일 보존한다. download API는 요청 권한을 다시 확인한 후 5분 GetObject signed URL을 반환한다.

CSV는 같은 snapshot을 즉시 stream한다. UTF-8 BOM을 포함하고 formula prefix를 escape하며 `Cache-Control: private, no-store`를 사용한다.

## 8. 파일 형식

### Excel

sheet 순서는 `요약`, `일별 사용량`, `사용량 순위`, `시간대 패턴`, `탄소`, `산정 정보`다. 숫자는 numeric cell이며 formula를 만들지 않는다. timezone, generatedAt, source와 factor version을 산정 정보에 기록한다.

### PDF

pdf-lib과 @pdf-lib/fontkit으로 repository에 포함한 Noto Sans KR을 embed한다. 요약은 A4 portrait, heatmap과 넓은 ranking 표는 A4 landscape를 사용한다. 각 page footer에 `상태 기반 추정`, timezone, generatedAt, page number를 표시한다.

## 9. 오류와 복구

- heatmap 실패는 기존 ranking을 숨기지 않는다.
- factor 없음은 탄소만 unavailable이며 사용량/보고서의 비탄소 section은 유지한다.
- report worker crash는 lease expiry 뒤 다른 worker가 재개한다.
- upload 후 DB commit 실패는 다음 attempt key에 같은 `dataSnapshot`을 다시 생성하고, 이전 attempt object는 cleanup한다.
- file expiry 후 download는 URL 대신 `report_expired`와 재생성 request를 반환한다.
- cleanup의 S3 삭제 실패는 metadata/objectKey를 보존하고 다음 sweep에서 재시도한다.
- site 삭제는 신규 report claim을 막고 관련 object 삭제가 끝난 뒤 DB row를 제거한다.

## 10. 보안과 개인정보

- signed URL, session, storage credential은 log와 audit metadata에 기록하지 않는다.
- report request는 site/user/request hash 기준 active 중복을 차단한다.
- 사용자 영구 삭제 후에도 report audit 의미를 유지하도록 actor ID/login ID snapshot을 보존하고 User FK만 `SET NULL`로 전환한다.
- report object는 public URL을 만들지 않는다.
- tenant가 다른 identity, job, assignment, object 요청은 `404`다.

## 11. 완료 기준

- heatmap이 168 cell, 0/결측 구분, DST 합산, 최대 92일을 검증한다.
- ranking selection과 heatmap scope가 연결되고 네 viewport에서 document overflow가 없다.
- CSV BOM, 한글, quote/newline과 formula injection 방어를 검증한다.
- report lease expiry/retry/fencing에서 한 job이 중복 완료되지 않는다.
- Excel numeric type/sheet/metadata와 PDF 한글/page break/heatmap clipping을 검증한다.
- report object 7일, metadata 90일, signed URL 5분 만료를 검증한다.
- factor 없음/overlap/version 경계와 음수 절감을 검증한다.
- 최적화 route·계약·보고서 section이 생성되지 않았음을 회귀 테스트로 고정한다.
- 실제 전력계·Raspberry Pi·ESP32-H2 HIL을 실행하지 않았다면 software 완료와 구분해 기록한다.
