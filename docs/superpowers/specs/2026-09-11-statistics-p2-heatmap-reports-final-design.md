# 통계 P2 히트맵·동일내용 보고서 최종 설계

## 범위

P2는 요일×시간대 히트맵과 CSV/XLSX/PDF 보고서만 구현한다. 탄소 배출량·배출계수 관리(P2-C), 최적화, 운영시간, 낭비, 목표·예산은 구현하지 않는다.

고객 통계 메뉴는 `개요 / 사용 분석 / 보고서`로 구성한다.

## 정확성 원칙

보고서 파일에는 완료된 현지 날짜의 영속 `FixtureEnergyDailyAggregate`와 `FixtureEnergyHourlyAggregate`만 사용한다. 열린 상태 구간 투영, 현재 일자, 월 예상, 24시간·100% 가상 기준선, 데이터 수집률, known/unknown 시간, `상태 기반 추정`, `예상`, `추정` 문구와 그에 종속된 수치는 제외한다.

보고서에 포함되는 값은 다음으로 제한한다.

- 보고서 ID, 현장, 범위, 기간, 현장 timezone, 생성일시
- 완료된 날짜별 에너지 사용량과 저장된 비용
- 이전 동일 길이 완료 기간과의 사용량·비용 차이 및 비교값이 0이 아닐 때의 변화율
- 조명·층·그룹별 사용량과 비용 순위
- 요일×시간대 에너지 사용량 및 평균 밝기
- 적용 단가와 산식, 집계 기준

부분 집계 row는 숫자를 보정하거나 확대하지 않고 저장된 합계 그대로 포함한다. 데이터가 없는 항목은 0을 만들지 않고 `데이터 없음`으로 출력한다.

## 히트맵

`GET /energy/sites/:siteId/heatmap`은 `energy|brightness`, site/fixture/floor/group scope, 양끝 포함 최대 92일을 지원한다. 기본 UI 기간은 완료된 최근 28일이다. 7×24 cell을 항상 반환하고 실제 0과 결측을 구분한다. DST 반복 시간은 같은 local weekday/hour cell에 합산한다.

## 공통 보고서 문서 모델

`EnergyReportDocumentBuilder`가 한 번만 계산해 ordered document를 생성한다. XLSX와 PDF renderer는 이 구조를 변경하지 않고 표현만 달리한다.

```ts
interface EnergyReportDocument {
  schemaVersion: 1;
  reportId: string;
  title: string;
  metadata: ReportMetadataRow[];
  sections: Array<
    | { kind: "summary"; title: string; rows: ReportValueRow[] }
    | { kind: "table"; id: string; title: string; columns: ReportColumn[]; rows: ReportCell[][] }
    | { kind: "heatmap"; id: string; title: string; metric: "energy" | "brightness"; cells: ReportHeatmapCell[] }
    | { kind: "notes"; title: string; rows: string[] }
  >;
  contentFingerprint: string;
}
```

`contentFingerprint`는 canonical document JSON의 SHA-256이다. renderer는 section을 추가·삭제하거나 값을 다시 계산할 수 없다. 두 형식 모두 표지/metadata, 요약, 일별 사용량, 비교, 순위, 히트맵, 산정 정보를 같은 순서·라벨·값·반올림으로 표시하고 fingerprint를 포함한다.

XLSX는 각 section을 sheet로 분리할 수 있고 PDF는 page로 나눌 수 있지만, 사용자에게 보이는 정보 집합은 동일해야 한다. 형식별 전용 설명이나 별도 숫자는 허용하지 않는다.

## 생성 구조

- API: NestJS controller/service, shared strict Zod contract
- DB: Prisma/PostgreSQL `EnergyReportJob`
- Worker: NestJS `OnModuleInit` poller, `FOR UPDATE SKIP LOCKED`, 30초 lease, 최대 3회
- XLSX: ExcelJS
- PDF: pdf-lib + @pdf-lib/fontkit + repository Noto Sans KR
- Storage: AWS SDK v3 S3/MinIO private object, SHA-256/HEAD 검증, 5분 signed download URL
- UI: React + TanStack Query, active job만 3초 polling

POST는 `202 Accepted` job을 반환한다. worker는 최초 시도에 완료된 aggregate를 하나의 `RepeatableRead` transaction에서 읽어 `dataSnapshot`과 공통 `documentSnapshot`을 저장한다. 재시도와 두 renderer는 저장된 `documentSnapshot`만 사용한다.

각 attempt는 `reports/{siteId}/{reportId}/attempt-{attemptCount}.{ext}`에 업로드한다. 살아 있는 lease를 가진 worker만 completed transition을 수행한다. 파일은 7일, metadata는 90일 보존한다.

## 보고서 UI

`/statistics/reports`는 기간, scope, format을 선택하는 생성 dialog와 생성 이력 목록을 제공한다. 포함 section 선택은 두지 않는다. 항상 동일한 표준 보고서 내용을 만들기 때문이다.

상태는 queued, processing, completed, failed, expired다. 완료 행은 파일 형식과 무관하게 동일한 보고서 제목과 기간을 표시한다. 다운로드는 API가 권한과 만료를 다시 확인한 뒤 signed URL을 반환한다.

## 완료 기준

- P2-C 관련 schema/API/route/UI가 없다.
- 보고서 파일/화면에 `상태 기반 추정`, `예상`, `추정`, coverage, known/unknown, forecast, 가상 baseline이 없다.
- XLSX와 PDF에서 추출한 section ID, label, raw value, display value, row order, fingerprint가 동일하다.
- renderer가 공통 문서 모델 밖의 내용을 추가하면 contract test가 실패한다.
- heatmap은 168 cell, DST, 0/결측, 최대 92일, tenant scope를 검증한다.
- job lease/retry/fencing, private download, expiry/cleanup을 검증한다.
- `docs/menus/statistics.md`, `docs/database-schema.md`, `docs/project-status.md`를 갱신한다.
