# Task 9 최종 구현 및 통합 검증 보고서

기준일: 2026-09-18

## 결론

- 후보 0개와 상한 2,000개 CAD 적용은 실제 PostgreSQL transaction에서 성공했고, revision `changeSummary`와 audit metadata의 교체 수량이 정확히 일치했다.
- 제공 DWG는 실제 `dwgread -> 제품 child core -> worker -> PostgreSQL -> MinIO -> API` 경로에서 `review_required / 100%`에 도달했다. 저장한 gzip SVG를 signed URL로 다시 받아 Sharp로 SVG 디코딩했다.
- 브라우저 사용자 여정은 mock API를 사용하되 저장 요청의 fixture/slot assignment를 그대로 반영하고, reload 영속성과 revision 3 snapshot의 CAD 배경·slot 좌표 우선순위를 실제 Chromium에서 확인했다.
- Task 7 최대 부하인 조명 1,000개, 슬롯 2,000개, 도형 2,000개는 기존 성능 예산을 통과했다.
- 제공 DWG에는 조명 ground truth가 없으므로 후보 1,308개를 정확도 퍼센트로 표현하지 않는다.
- child 결과는 최대 8 MiB stdout JSON transport로만 받으며 parent가 JSON 역직렬화 전에 byte 수를 제한한다. unsupported type은 이름당 64 UTF-8 bytes, 최대 64종으로 제한하고 parser retained/output 예산과 child/parent manifest 검증에 포함한다.

## 실행 환경

| 항목 | 값 |
| --- | --- |
| OS | macOS 26.5.1, arm64 |
| CPU | Apple M2 Pro |
| Node.js / pnpm | v24.19.0 / 9.15.0 |
| DWG 변환기 | `/opt/homebrew/bin/dwgread`, LibreDWG 0.14 |
| PostgreSQL | `postgres:16-alpine`, disposable test database |
| Object storage | `minio/minio:RELEASE.2025-04-22T22-12-26Z`, `floor-assets` bucket |
| Browser | Chromium 149.0.7827.55, 1440x900 |

## 구현 및 TDD

1. `0 candidate apply`와 `2,000 candidate apply`를 실제 DB 통합 회귀로 추가했다.
2. 최초 RED에서 audit metadata에 `changeSummary`가 없음을 확인했다. 적용 서비스가 revision과 동일한 exact summary를 audit metadata에도 기록하도록 수정했다.
3. 실제 SVG matrix를 6자리로 직렬화할 때 넓은 도면에서 최대 약 7.241px 좌표 편차가 발생하는 RED를 확인했다. matrix 정밀도를 12자리로 높이고 제품 child manifest가 후보 전체의 0.01px 이내 일치를 증명하도록 했다.
4. 일치 증거의 후보 수, 일치 수, 비율, 허용 오차, 최대 편차가 서로 모순되면 child manifest를 거부하는 회귀를 추가했다.
5. 기존 맵 교체부터 모니터링 반영까지 한 번에 검증하는 Chromium E2E를 추가했다.
6. 수정 라운드 1 RED에서 65-byte/65종 unsupported marker, metadata output budget, 65종 manifest, 8 MiB 초과 child 응답이 거부되지 않음을 확인했다. parser와 child manifest를 같은 상한으로 묶고 bounded stdout transport로 parent가 JSON parse 전에 차단하도록 수정했다.
7. 부분 sample 환경변수가 suite 전체를 skip하는 기존 동작을 RED로 확인했다. 전용 실행기는 ignored `dist`를 먼저 삭제하고 현재 API source를 build한 뒤 sample test를 실행하며, 일부 환경변수만 주어지면 명시적으로 실패한다.

## 실제 DWG 파이프라인

실행 명령:

```bash
CAD_SAMPLE_DWG_PATH="/Users/kim-jh/Downloads/2단지지하주차장전등설비합본평면도20260803.dwg" \
CAD_SAMPLE_CONVERTER_PATH=/opt/homebrew/bin/dwgread \
CAD_SAMPLE_CONVERTER_ARGV_JSON='["-O","DXF","-o","{output}","{input}"]' \
RUN_OBJECT_STORAGE_INTEGRATION=true \
pnpm test:cad-sample
```

| 항목 | 실제 결과 |
| --- | ---: |
| 원본 크기 / SHA-256 | 17,887,748 bytes / `01f25d539c20f93663c9183bbf70d83e578ae9990c2eb6dabb543bf39d71854d` |
| job 상태 / 진행률 | `review_required` / 100% |
| 제품 parser model entity / block | 26,849 / 11,243 |
| 제품 detector 후보 | 1,308개 |
| 후보 transform 일치 | 1,308 / 1,308, 허용 0.01px |
| 최대 transform 편차 | 0.0000010852373880879596px |
| viewport | 1312 x 1600 |
| primary viewport 제외 occurrence | 0 |
| 미지원 occurrence | ATTDEF 480, ELLIPSE 29,692, RAY 2, REGION 2, SOLID 826, SPLINE 1,482, TRACE 4, 합계 32,488 |
| 렌더 occurrence | 474,834 |
| raw / gzip SVG | 21,029,182 / 5,046,998 bytes |
| gzip SVG SHA-256 | `1b2637998204726154b1d3725b9fd8832d5dee9faba520c1278aba5bda8cfe92` |
| signed GET / SVG decode | HTTP 200, `svg`, 1312 x 1600 |
| detector profile | `site-drawing-20260803/1` |

독립 analyzer는 직접 model-space 규칙 후보 1,302개를 보고하고, 제품 detector는 nested INSERT를 포함한 제품 기준 후보 1,308개를 저장한다. 두 수치는 집계 범위가 다르며 어느 쪽도 precision, recall 또는 조명 배치 정확도가 아니다.

## 적용 회귀

`FLOOR_IMPORT_INTEGRATION=1` PostgreSQL 통합 테스트 14개가 통과했다.

- 후보 0개: 기존 도형, 슬롯, 배치 상태를 교체하고 슬롯 0개로 완료한다.
- 후보 2,000개: 상한 전체를 accepted slot으로 생성한다.
- 두 경로 모두 응답, revision `changeSummary`, audit metadata의 `deletedObjectCount`, `unplacedFixtureCount`, `deletedSlotCount`, `createdSlotCount`가 정확히 일치한다.
- 중간 chunk 실패와 slot trigger 실패는 map, fixture, slot, revision, audit, job을 함께 rollback한다.

## 브라우저 사용자 여정

`apps/web/e2e/cad-import-journey.spec.ts`에서 다음 순서를 실제 Chromium 이벤트로 통과했다.

1. 기존 맵, 수동 도형 1개, 배치 조명 2개, 기존 슬롯 1개 확인
2. DWG 파일 선택과 업로드, 진행률 0%에서 100% 확인
3. 후보 2개 검토 후 맵 초기화 팝업 취소, apply 미호출 확인
4. 다시 팝업을 열어 적용, 기존 도형 삭제·조명 미배치·신규 슬롯 2개 확인
5. 새로고침 후 미배치 목록과 1200 x 800 CAD 맵 확인
6. 두 조명을 각각 슬롯에 drag/drop하고 저장, PUT의 fixture update 2건과 `slotAssignments`의 slot/fixture ID 2건을 literal로 확인
7. 저장 후 편집 화면을 reload해 두 assignment가 유지됨을 확인
8. 모니터링 runtime에는 의도적으로 `(900,700)/(950,700), unplaced`를 주고 revision 3 snapshot에는 `(200,180)/(400,180), placed`를 제공해 snapshot 좌표가 우선함을 실제 marker pixel 중심으로 확인
9. CAD rendered asset 이미지가 `1200 x 800`으로 decode되고 monitoring에 표시됨을 확인

이 브라우저 테스트의 API는 deterministic route fixture다. 실행 당시 real backend lab Web(`127.0.0.1:15173`)이 없고 API health(`127.0.0.1:4000/health/live`)도 정상 응답하지 않아 `floor-placement-real.spec.ts`는 실행하지 않았다. 대신 위 실제 DWG 통합 테스트가 converter, worker, PostgreSQL, MinIO, API 경계를 별도로 검증한다.

## 최대 부하 성능

조건: mock API, warm local Vite/OS cache, Chromium, 1440x900. 운영 cold start 수치가 아니다.

| 지표 | 결과 | 예산 |
| --- | ---: | ---: |
| painted canvas-ready 20회 nearest-rank p95 | 866.3ms | 3,000ms 이하 |
| Stage layer 수 / 이미지 decode | 4 / URL당 1회 | 5 이하 / 1회 |
| pan/zoom frame p95 | 9.2ms | 33ms 이하 |
| 최대 frame | 25.5ms | 250ms 이하 |
| pointer-up -> store/Konva/paint 반영 p95 | 37.3ms | 100ms 이하 |
| mock 저장 | 349ms | 3,000ms 이하 |

## 전체 검증

- Shared: 15 files, 249 tests 통과; typecheck/build 통과
- API: 166 suites, 1,997 tests 통과, 환경 의존 503 tests skip; typecheck/build 통과
- Web: 100 files, 1,437 tests 직렬 실행 통과; typecheck/production build 통과
- CAD 집중: parser/core bounded manifest 56 tests, PostgreSQL lifecycle 14 tests, 실제 sample clean-build 1 test 통과
- Chromium: CAD 전체 여정 1 test, 최대 부하 2 tests 통과
- 첫 Web 병렬 전체 실행은 통계 화면 이동 테스트 1건이 5초 안에 문구를 찾지 못했지만 같은 테스트 단독 실행과 전체 직렬 실행에서는 통과했다. 제품/테스트 코드는 변경하지 않았다.

## 남은 제약과 우려

- ground truth annotation이 없어 조명 검출 precision/recall/F1과 실제 위치 정확도는 산출하지 않았다.
- 32,488개의 미지원 occurrence는 렌더에서 생략된다. 특히 ELLIPSE/SPLINE이 실제 도면 의미에 필요한지는 사람의 CAD 시각 검수가 필요하다.
- real browser + real API를 한 프로세스로 연결한 CAD 여정은 lab 미실행으로 생략했다. 실 API 경계와 브라우저 UX 경계는 각각 검증했지만 하나의 네트워크 세션 증거는 아니다.
- 실제 Raspberry Pi, ESP32-H2, BLE Mesh와는 무관한 맵 가져오기 검증이며 장비 HIL을 의미하지 않는다.
