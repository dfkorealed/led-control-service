# Final Atlas 제품 적용과 API 확장 설계

기준일: 2026-09-25

## 1. 목적과 승인 범위

승인된 Final Atlas 22개 화면의 시각·반응형 구성을 실제 웹 제품에 적용한다. 사용자는 기존 기능을 살리고 각 메뉴 담당 세션이 변경을 수행하며 총괄이 중간 보고·수정 전달·최종 점검하기를 요청했고, 필요한 API 확장도 범위에 포함했다. 아틀라스의 숫자, 장치명, 상태, 시간, 검토용 hash 선택 띠와 비활성 버튼은 제품 데이터나 기능의 정본이 아니다. 성공 기준은 실제 현장·층·사용자 권한·서버 응답과 화면 표시가 일치하면서 기존 등록, 제어, 맵 편집, 보고서 작업이 계속 동작하는 것이다.

이번 설계는 모니터링·설정의 경량 현장/층 요약, 모니터링 운영 활동, 자동화 전역 조회, 통계 사용자 지정 완료 기간과 분석 히트맵의 서버 계약을 정한다. Shell·인증·운영자 화면, 기존 설정/설치/등록/맵 편집과 보고서 생성·다운로드는 현재 API로 이식하며 불필요한 새 API를 만들지 않는다.

사용자와 합의한 운영 로그 기본 정책은 실제 반영된 조명 상태 변화, 수동 상태 확인의 종료 결과, 제어 결과를 기록하고 반복 heartbeat를 제외하며 30일 보관하는 것이다. 이는 내부 인시던트 조치 이력이나 원시 MQTT 수신 이벤트를 고객에게 보여주는 기능이 아니다.

## 2. 접근법과 호환성 원칙

기존 여러 테이블을 브라우저에서 합치는 방식은 당시 밝기·상태가 없는 원시 이벤트를 성공 기록으로 오표시하고, 92일씩 나눈 히트맵 평균을 잘못 합칠 수 있어 채택하지 않는다. 화면마다 새 통합 snapshot API를 만드는 방식은 기존 권한·수집 상태·캐시 경계를 중복한다. 선택한 방식은 **기존 API에는 의미를 바꾸지 않는 필드와 선택적 조회 조건만 추가하고, 의미가 다른 기록과 통계 지표에는 별도 읽기 계약을 만든다**는 것이다.

- 기존 자동화 목록 `total`은 필터 없는 현장 전체 규칙 수로 유지한다. 새 `filteredTotal`이 조건에 맞는 전체 규칙 수다. 기존 cursor와 무필터 호출은 계속 동작한다.
- 기존 비교 `?preset=last_7_days|current_month|current_year`의 요청·응답, 현재월 전망과 기존 비용 설명을 유지한다. 새 사용자 지정 기간은 별도 route와 strict response schema를 사용한다.
- 기존 `/heatmap`의 최대 92일, 에너지 셀의 **합계 kWh** 및 이를 사용하는 보고서 계산은 유지한다. 새 화면용 최대 400일 **관측 평균 kWh**는 별도 route/response schema다. 두 값을 같은 이름·단위 설명으로 혼용하지 않는다.
- API를 먼저 배포해 기존 웹 소비자를 깨지 않게 한다. 새 화면은 대응 API가 준비되지 않았을 때 숫자를 추정하거나 범위를 슬쩍 줄이지 않고 로딩·오류·이용 불가 상태를 보인다. 사이트/주체/층/필터/기간을 Query key와 cursor scope에 포함한다.
- 기존 `claimCode` 소유권 증명, viewer/admin/control/manage 권한, 명령의 blocked/unknown/partial/verification-required 상태, 맵 편집 lease/dirty/CAD 계약, PDF/XLSX 생성·다운로드는 그대로 유지한다. 실제 사용자 DB migration 적용, 운영 배포와 장비 작업은 별도 사용자 승인 대상이다.

## 3. 현장·층 경량 요약

`GET /sites/:siteId/dashboard`의 기존 필드와 `includeFixtures=false`의 경량 목적을 유지하며 응답에 다음을 추가한다. 이 조회는 기존 site read 권한과 active floor 범위를 그대로 따른다.

| 위치 | 신규 필드 | 의미 |
| --- | --- | --- |
| `summary` | `offlineFixtures` | 현장 전체 `totalFixtures - onlineFixtures - faultFixtures`; 동일한 `generatedAt`·현장 모니터링 정책에서 분류 |
| `floors[]` | `summary: {totalFixtures, onlineFixtures, faultFixtures, offlineFixtures}` | 해당 층의 **전체 등록 조명** 수; fixture cursor의 현재 로드 수나 지도 배치 수가 아님 |
| `floors[]` | `mapRevision`, `mapConfigured` | 현재 리비전과 실제 표시 가능한 맵 콘텐츠 유무; 설정 목록의 조명 수는 같은 층의 `summary.totalFixtures`를 재사용 |

같은 fixture를 한 번만 분류해 현장 합계와 층 합계가 일치하게 하고, 상태 기준은 기존 `monitoringFixtureState`다. `mapConfigured`는 활성 공통 MapDocument의 표시 요소, 실제 legacy floor plan(`sourceType != none`), CAD 장면 또는 표시 가능한 legacy object가 있을 때만 참이다. 리비전만 증가한 초기 빈 맵이나 reset 뒤 빈 맵은 거짓이다. 전체 맵 blob이나 1,000개 조명 상세를 경량 dashboard에 싣지 않고 집계/존재 조회로 계산한다. 지도에 배치된 핀 수는 별도 map snapshot의 배치 수로 표시해 등록 수와 섞지 않는다. 이 확장 자체에는 DB migration이 필요하지 않다.

## 4. 고객용 모니터링 운영 활동

새 `MonitoringActivity` projection을 원시 `ProcessedGatewayEvent`, 내부 `MonitoringIncident`, IP/user-agent를 담는 `AuditLog`와 분리한다. site/floor scope, 서버 기록 시각, allowlist kind, 안전한 event-time 표시 이름/결과 필드, producer의 안정적인 source key만 보관한다. `(sourceType, sourceKey, floorId)` 고유 제약으로 재전달과 worker 재시도를 멱등 처리하고 `(siteId, floorId, recordedAt DESC, id DESC)` 인덱스로 최신순 조회한다. fixture 삭제나 이름 변경 이후에도 당시 고객 문구를 안전하게 표시할 수 있도록 필요한 이름 snapshot만 보존한다. 30일 경과 데이터는 bounded retention sweep로 지우며, 배포 전 원시 원장에는 당시 상태 payload가 없어 과거 기록을 추측해 backfill하지 않는다.

Producer는 기존 상태 적용 transaction에서 실제로 반영된 조명의 상태·밝기·Health 변화, 수동 refresh의 terminal `completed|partial|failed|expired`, 명령의 terminal 및 상태 확인 후 결과 변화만 기록한다. 활동 기록과 원본 전이는 원자적으로 commit하고, 기록 실패 시 원본 전이를 rollback해 기존 멱등 재처리 경로로 복구한다. 매 heartbeat, 중복·역순·미래시각 거부 이벤트, 상태가 같아진 read-back, 명령의 단순 queued/published 단계는 제외한다. gateway/fixture freshness에서 고객에게 보이는 오프라인 전이가 필요하면 실제 전이를 확정하는 transaction에서만 기록하며 원시 수신 시각만으로 성공·복구를 주장하지 않는다. 하나의 명령이 여러 층을 대상으로 하면 영향받은 층마다 한 요약 기록을 만들고 명령당 조명 수만큼 반복하지 않는다. `unknown`과 `partial`은 그대로 표시하며 성공으로 정규화하지 않는다.

읽기 API는 `GET /sites/:siteId/floors/:floorId/monitoring-activity?limit=5&cursor=...`다. limit은 기본 5, 최대 50이고 응답은 `{ generatedAt, items, nextCursor }`다. 각 항목은 `{ id, kind, recordedAt, observedAt?, fixtureId?, displayName?, status?, brightnessPercent?, commandOutcome?, refreshStatus? }`의 allowlist만 반환한다. 장치 시계의 `observedAt`은 보조 정보이고 정렬·pagination은 서버 `recordedAt,id`를 사용한다. cursor는 site/floor와 정렬 anchor를 묶고 다른 범위·비정규형을 400으로 거부한다. site read 권한과 floor-site 일치를 먼저 확인하고 타 현장은 기존 정책대로 404로 숨긴다. 원시 MQTT payload, hash, 시리얼, 인증 정보, IP, 내부 fault code, 인시던트 ack/assign workflow는 응답하지 않는다.

화면의 최근 한 줄과 최대 440px drawer는 같은 API 데이터를 현장 시간대로 표시한다. ticker의 3초 회전은 이미 받은 항목 안에서만 수행하며 서버 polling 간격이 아니다. 데이터가 없으면 빈 상태, 처음 조회 실패면 오류/재시도, 재조회 실패면 같은 site/floor의 마지막 성공 데이터에 갱신 실패를 표시한다. `전체 보기`는 항상 우측 끝, 범례와 로그 사이에는 여백을 두고, 5건 단위 cursor 이전/다음은 경계·초점 이동을 검증한다. 수동 refresh가 terminal이 되면 해당 층 활동 조회를 무효화한다. 조회나 drawer 열기는 장치 명령을 보내지 않는다.

## 5. 제어 자동화와 명령 이력

기존 스케줄·차량 이벤트 목록 GET에 선택적 `query`(규칙 이름의 trim된 literal substring, 최대 100자), `status=enabled|disabled`, `syncStatus=PENDING|APPLIED|REJECTED`, `limit=1..100`, `cursor`를 지원한다. 이름의 한글·대소문자·특수문자는 검색식이 아닌 문자 그대로 취급한다. 응답의 기존 `items,total,nextCursor`는 유지하고 `filteredTotal`과 `siteSummary:{ruleCount,syncRuleCounts:{APPLIED,PENDING,REJECTED}}`를 추가한다. `siteSummary`는 필터 없는 현장 전체 규칙 기준이고 세 상태 합은 `ruleCount`와 일치한다. 목록, filteredTotal, siteSummary는 같은 RepeatableRead snapshot에서 계산한다.

`syncStatus`는 독립적인 조명 실행 성공률이 아니라 현재 GatewayAutomationConfiguration에서 유도된 **해당 규칙의 Gateway 구성 동기화 상태**다. 설정이 없으면 기존 응답처럼 PENDING으로 취급하고, 화면도 ‘Gateway 동기화’로 명시한다. 같은 gateway의 여러 규칙이 같은 상태에 각각 집계될 수 있으므로 이 수를 Gateway 대수로 표현하지 않는다. 기존 무필터 v1 cursor는 계속 받고, 새 필터/limit 요청의 v2 cursor는 site·자원 종류·정규화된 필터 서명을 포함해 다른 조건에서 재사용하면 400으로 거부한다. 이전/다음은 웹의 cursor stack을 사용하며 동시 생성·삭제 중 고정된 전체 페이지 수나 임의 페이지 점프를 약속하지 않는다. 조건 또는 현장 변경 시 첫 페이지로 돌아간다.

`GET /commands`는 이미 현장 범위 검색, stage 필터, limit/cursor를 제공한다. 최근 한 줄은 무필터 limit=1, drawer는 limit=4와 기존 cursor로 조회하므로 이번 범위에서 total이나 offset API를 추가하지 않는다. 페이지 표시는 확정 총 페이지 수 대신 현재 묶음/다음 존재 여부를 나타낸다. drawer 행 클릭은 기존 상세·상태 확인 경로만 열고 명령을 재전송하지 않는다. 자동화 쓰기는 기존 manage, 수동 제어는 control, 읽기는 read 권한을 유지한다. 차단 조명 하나가 포함되면 batch 전체를 차단하고, 불확실한 결과의 자동 재송신은 하지 않는다.

## 6. 통계 완료 기간과 히트맵

### 6.1 사용자 지정 비교

`GET /energy/sites/:siteId/comparisons/range?from=YYYY-MM-DD&to=YYYY-MM-DD`와 별도 strict `EnergyRangeComparisonResponse`를 추가한다. 현장 IANA 시간대에서 **어제까지의 완료일**, 역전 없는 inclusive 1~400일만 허용한다. 잘못된 실제 날짜, 오늘/미래, 401일 이상은 400이다. 기존 세 preset endpoint/response는 바꾸지 않는다. 새 응답은 site/timeZone/source/generatedAt, `selection:{kind:"custom",from,to}`, 완료 범위, 기존 comparison과 같은 summary/coverage/일별 points, prior comparisons를 담되 forecast는 `not_applicable`이다.

직전 비교는 선택 길이와 같은 일수의 바로 앞 기간이다. 전년 비교는 종료일을 전년 같은 달·일(2/29는 2/28)로 옮기고 같은 일수만큼 역산해 길이를 맞춘다. 비교 구간의 자료·수집률이 부족하면 변화율은 `null`이며 0으로 채우지 않는다. 관측 0은 실제 0으로 보존한다. 24시간·100% baseline은 기존 제품과 같이 **현재 등록 조명 구성·현재 단가를 과거 기간에 가정한 추정치**로 표시한다. 과거 저장 비용을 새 단가로 재계산하거나 이 baseline을 당시 실제 구성이라고 부르지 않는다. 오늘 진행 중 카드와 현재월 전망은 사용자 지정 완료일 비교에 섞지 않는다.

### 6.2 분석의 단일 기간과 평균 패턴

분석 조건의 `from/to` 하나를 요약·순위·선택 항목 일별 상세·새 히트맵에 전달한다. 기본 기간도 브라우저 날짜가 아니라 현장 시간대의 마지막 완료일 기준으로 정한다. 순위의 기존 최대 400일과 coverage/그룹 이력/당시 저장 비용 의미는 유지한다. 새 `GET /energy/sites/:siteId/heatmap/observed-mean?scope=...&identityId=...&metric=energy|brightness&from=...&to=...`는 같은 1~400 완료일을 받아 168개 요일×시간 셀을 반환한다. 기존 `/heatmap`의 합계·92일 계약과 보고서 PDF/XLSX helper는 건드리지 않는다.

새 에너지 셀은 해당 현지 요일·시각의 각 완료일에 속한 kWh를 먼저 합산한 뒤 **활성 조명이 있고 그 시각이 실제 존재한 현지 날짜 수(`eligibleLocalDays`)**로 나눈 평균 kWh다. 같은 현지 날짜·시각이 DST로 두 번 생기면 두 UTC 구간을 그 날짜의 한 표본으로 합하고, 건너뛴 시각은 표본 수에 넣지 않는다. 밝기는 기존 의미처럼 알려진 초로 가중한 평균 밝기다. 응답 셀에는 `value`, `knownSeconds`, `expectedSeconds`, `observedLocalDays`, `eligibleLocalDays`, `coverageRate`를 넣는다. `eligibleLocalDays`는 그 현지 시각이 실제 존재하고 선택 scope에 활성 fixture가 하나 이상 있는 날짜 수, `observedLocalDays`는 그 날짜의 모든 기대 fixture-초가 수집된 날짜 수다. `expectedSeconds`는 실제 hourly 행이 있는 시간만 세지 않고 fixture identity의 활성 기간·층/그룹 소속 이력·현장 시간대로 도출해, 통째로 누락된 시간도 수집 공백으로 계산한다. 선택 범위에 해당 요일·시각이 없거나 기대 초에 비해 수집 공백이 있으면 `value=null`이다. **완전히 관측한 0 kWh는 0**, 결측·부분 수집은 null로 구별한다. 층/그룹 이력은 UTC bucket 전체 소속 조건과 중복 membership 한 번 계산을 유지한다.

400일×다수 fixture의 시간별 행을 Prisma nested relation으로 모두 JS 메모리에 올리는 구현은 허용하지 않는다. site/scope를 먼저 좁히고 시간별 aggregate와 이력의 분자·분모를 DB 측 bounded 집계 또는 bounded streaming으로 계산한다. 92/93/400/401일 경계와 1,000개 fixture 규모를 대상으로 응답 시간·메모리·실행 계획을 검증한다. 현재 인덱스로 충분하지 않다는 측정 증거가 있을 때만 신규 인덱스 migration을 추가한다. 서버가 범위를 처리하지 못하면 이전 28/92일을 몰래 보여주지 않고 명시적인 이용 불가 상태로 닫는다.

`coverageRate`는 `expectedSeconds > 0`일 때 `knownSeconds / expectedSeconds`, 기대 초가 0이면 null이다. 완전 관측 판정은 표시 반올림 전의 정수 초로 수행한다.

## 7. 실패·보안·적용 순서

모든 신규 읽기는 기존 `SiteAccessService`의 read 경계를 통과하고 scope identity가 다른 현장에 속하면 404로 숨긴다. 날짜·cursor·필터의 malformed 입력은 정제된 400을 반환한다. 캐시와 cursor가 다른 site, floor, principal, 필터, 기간을 가로지르지 않는다. UI는 초기 로딩·빈 데이터·첫 오류·동일 범위 stale 오류를 구분하고 새 범위의 요청 실패에 이전 범위 수치를 남기지 않는다. 명령/자동화/등록의 기존 mutation과 실패 복구를 시각 변경 때문에 비활성 mock으로 바꾸지 않는다.

순서는 (1) shared 계약 승인 및 서버의 dashboard·활동 projection/migration·자동화 조회·통계 route, (2) 공통 웹 shell/토큰/drawer, (3) 메뉴별 웹 소비자와 `docs/menus/{monitoring,control,statistics,settings}.md`, (4) 독립 QA와 총괄 통합 검증이다. Backend가 Prisma/shared 단독 소유자가 되어 공유 파일을 먼저 변경하고, 서로 다른 웹 feature 담당은 그 계약 이후 각자 소유 경로만 수정한다. DB 스키마가 바뀌면 같은 작업에서 `docs/database-schema.md`를 갱신한다. 로컬/테스트용 disposable DB migration 검증과 실제 사용자 DB 적용은 분리한다.

## 8. 검증 기준

- API/shared: dashboard 현장·층 수량 보존, 경량 조회, 초기/리셋/공통 문서 맵 설정 판정; 활동 producer의 실제 적용·중복·역순·미래시각·30일 보존·층 이동/삭제·권한·cursor; 자동화 무필터 구버전/필터·총수·Gateway 설정 없음·v1/v2 cursor; 통계 preset 구버전, 현장 시간대·DST·윤일·92/93/400/401일, 당시 비용·현재 baseline, 결측과 관측 0, 그룹 중복·이력을 검증한다.
- 웹: Atlas의 22개 화면과 실제 접근 가능한 dialog 경로, ready/loading/empty/error/readonly, 1440×900·1378×1237·390×844·320×720의 overflow·44px 목표·키보드·Escape·바깥 클릭·opener 초점 복귀를 검증한다. 모니터링 범례/로그 간격과 우측 끝 버튼, 현재 메뉴에 맞는 상단 제목, 통계 단일 기간, 제어 기존 safety/동기화 설명을 포함한다.
- 통합: 실제 API와 disposable DB의 site/role 경계, 명령 unknown/partial, 자동화 필터 전체 범위, 보고서 PDF/XLSX 기존 합계, 신규 평균 히트맵의 동일 기간, 등록 claimCode·맵 편집 lease/dirty/CAD를 회귀 검증한다. Typecheck, unit, build, UI policy, Chromium 및 `git diff --check`를 새 HEAD에서 실행한다. 이 증거를 Raspberry Pi/ESP32-H2 HIL, 운영 배포, 사용자 DB 적용으로 확대 기록하지 않는다.
