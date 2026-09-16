# Task 19.5 Fix Round 2 구현 보고서

## 범위

`task-19.5-rereview-1.md`의 P1/P2를 TDD로 교정했다. 신규 PDF import, AI I/O, CAD 후보의 자동 `Fixture`/`MeshNode` 등록은 추가하지 않았다. LibreDWG는 개발 분석 및 opt-in HIL에서만 사용하며 제품 package/image 의존성에는 포함하지 않는다.

## 구현 결과

- 제품 parser는 chunk→line→pair→entity body만 보유하고 bounds를 expanded 배열 없이 iterator로 계산한다. deterministic retained-model 상한은 192 MiB다.
- 제품 renderer는 도달 가능한 block을 SVG `symbol`, INSERT를 `use`로 보존한다. 한글은 외부 resource 없는 escaped `<text>`이며 raw SVG와 gzip 결과를 파일 stream으로 생성한다.
- `ObjectStorageService`는 gzip 파일 stream을 PUT하고 HEAD에서 8 MiB, SHA-256, MIME, viewport, `Content-Encoding: gzip`을 검증한다.
- worker는 동시 CAD job 1개만 허용한다. production은 Node heap 512 MiB와 cgroup 768 MiB다.
- detector는 기본 `generic-lighting-v1`과 샘플용 `site-drawing-20260803-v1`을 분리했다. 요청/job이 profile ID를 고정하고 실제 detector의 version/digest를 job/candidate에 영속화한다.
- canonical digest는 confidence, candidate/expanded 상한, positive/deny/attribute/nearby token, distance, duration, yield를 포함한다.
- 후보 persistence는 기존 순차 upsert 대신 기존 job 후보 삭제 후 250건 단위 `createMany`를 같은 30초 bounded transaction에서 수행한다. API/Web bounded bulk 최대치는 2,000개다.
- analyzer는 BLOCK base point를 nested affine transform에 반영하고 expanded occurrence, world coordinate, depth, CPU/wall 상한을 적용한다. `--help`에 모든 조정 가능 default/hard cap과 고정 cap을 숫자로 표시한다.

## 샘플 증거

| 항목 | 결과 |
| --- | --- |
| DWG SHA-256 | `01f25d539c20f93663c9183bbf70d83e578ae9990c2eb6dabb543bf39d71854d` |
| converter | LibreDWG `dwgread 0.14` (개발/HIL 전용) |
| 변환 DXF | 105,432,404 bytes |
| model / paper entity | 26,887 / 4,150 |
| 제품 지원 entity / block | 26,389 / 11,243 |
| 직접 / nested 포함 INSERT occurrence | 8,954 / 23,734 |
| analyzer / 제품 후보 | 1,302 / 1,308 |
| profile | `site-drawing-20260803-v1`, `site-drawing-20260803/1` |
| profile digest | `d6dbdda9bd28a4eca8e54db48f0ff88129001bc72409f92f3f2196b4cc7de962` |
| raw / stored SVG | 17,351,304 / 3,783,909 bytes |
| standalone peak RSS | 509,411,328 bytes (`--max-old-space-size=512`) |

제품 HIL은 `ArgvCadConverter → parseAsciiDxfStream → RuleBasedLightingSymbolDetector → renderCadDocumentSvgFile → ObjectStorageService PUT/HEAD`를 통과했다. 직접 model-space INSERT name+finite-origin rate는 100%지만 이는 제한된 추출률이다. 지원 entity 예상 coverage는 98.1478%이며 시각 정답률이 아니다. 사람 ground truth가 없어 precision/recall/F1은 미확정이고 실제 BLE identity mapping은 0%다.

## 검증

- analyzer Node test: model/paper corpus, BLOCK non-zero base point, branching bomb, F1 네 경계, help/argv/temp cleanup 14/14 통과
- API focused Jest: parser, renderer, detector, worker, service, storage 6 suites 126/126 통과
- 상시 synthetic: 반복 block/한글 SVG 2,000건, worker candidate bulk 2,000건, Object Storage PUT/HEAD 통과
- 실제 PostgreSQL: candidate 2,000건 create/list와 1,302건 apply 통과
- Shared 244/244, Web 2,000건 hydrate/single-shape batch/spatial review/semantic control/apply 33/33 통과
- 제공 DWG product HIL 통과. 동일 document 두 번의 gzip SVG metadata/SHA-256이 일치했다.
- standalone RSS 측정은 509,411,328 bytes로 통과했다.
- Shared/API/Web typecheck와 Shared/API/Web production build 통과
- `git diff --check` 통과

## 품질 한계

escaped SVG text는 외부 font resource를 사용하지 않아 브라우저/OS의 `Arial`, `Noto Sans KR`, sans-serif fallback에 의존한다. 한글 문자열 보존과 XML 안전성은 검증했지만 모든 배포 OS의 glyph metric 동일성은 주장하지 않는다. PDF 신규 import는 제외하고 기존 PDF 읽기 호환만 유지한다. AI adapter는 disabled이며 I/O 호출은 0회다.
