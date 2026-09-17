# Task 19.5 Fix Round 3 구현 보고서

## 범위

`task-19.5-rereview-2.md`의 P1/P2를 TDD로 교정했다. 신규 PDF import, AI I/O, CAD 후보의 자동 `Fixture`/`MeshNode` 등록은 추가하지 않았다. LibreDWG `dwgread`는 개발 분석 및 HIL에서만 사용하며 제품 package/image/runtime 의존성에는 포함하지 않는다.

## RED 증거

- Web/API create가 client의 `generic-lighting-v1`을 그대로 신뢰해 제공 샘플 후보가 0개였고, sample profile을 임의 site에 지정할 수 있었다.
- core가 API process 안에서 실행돼 child OOM/timeout 격리가 없었고 production contract는 exact heap/cgroup/concurrency를 검사하지 않았다.
- parser는 off/frozen layer, group 60, 현재 entity body retained budget을 반영하지 않았으며 작은 span 후보 좌표에 별도 ceil scale을 적용했다. 추가 ATTRIB visibility 반례도 RED에서 확인했다.
- PostgreSQL worker mock이 file PUT/registry 계약보다 오래돼 timeout났고 실제 중간 chunk rollback/retry 증거가 없었다.
- rendered asset ledger와 review/apply/redirect는 `Content-Encoding: gzip` 유실을 거부하지 않았다.
- sample HIL이 실제 worker, PostgreSQL, MinIO와 API service를 관통하지 않았다.

## 구현 결과

- Web과 public create 계약에서 profile 선택을 제거했다. 서버 registry가 transaction에서 잠근 source asset SHA-256을 기준으로 제공 샘플만 `site-drawing-20260803-v1`, 그 외는 `generic-lighting-v1`로 해석한다. job/profile 불일치는 fail-close한다.
- migration은 queued/processing job의 profile ID/version/digest를 `NULL`로 staging한다. worker는 lease 아래 source digest로 profile을 해석하므로 기존 active job에 새 detector 의미를 조용히 backfill하지 않는다.
- parse/detect/render를 자격 증명을 상속하지 않는 child process로 격리했다. child heap 384 MiB, wall 60초, stderr 64 KiB, 후보 2,000건, rendered gzip 8 MiB와 bounded IPC manifest를 강제한다. OOM/timeout은 parent rejection과 job retry/failure로 수렴한다.
- production은 API heap 256 MiB, child heap 384 MiB, CAD concurrency 1, Linux cgroup 768 MiB를 시작 시 exact 검사한다. macOS에서 cgroup 필수 설정은 fail-close한다.
- parser는 `TABLES/LAYER`의 off/frozen flags와 entity/ATTRIB group 60을 제외하고 현재 entity body도 retained budget에 charge한다. 후보와 renderer는 하나의 translation/y-flip viewport transform을 공유한다.
- worker 후보는 최대 2,000건을 250건씩 한 transaction에 `createMany`한다. 중간 chunk 실패는 delete와 앞선 chunk까지 rollback되며 retry/cleanup이 같은 attempt identity로 수렴한다.
- `FloorAsset.contentEncoding` 원장을 추가했다. rendered SVG는 DB invariant, PUT/HEAD, job read/review/apply, content redirect와 signed GET 전 단계에서 `gzip`이 필수다.
- 제공 DWG HIL은 실제 MinIO source PUT → API service create/서버 profile resolve → worker/converter → child parser/detector/renderer → PostgreSQL 후보 bulk → MinIO rendered PUT/HEAD → API 조회 → signed GET 경로를 사용한다.

## 샘플 증거

| 항목 | 결과 |
| --- | --- |
| DWG SHA-256 | `01f25d539c20f93663c9183bbf70d83e578ae9990c2eb6dabb543bf39d71854d` |
| converter | LibreDWG `dwgread 0.14` (개발/HIL 전용) |
| 변환 DXF | 105,432,404 bytes |
| analyzer model / paper entity | 26,887 / 4,150 |
| 제품 visible model entity / block | 26,387 / 11,243 |
| 직접 / nested 포함 INSERT occurrence | 8,954 / 23,734 |
| analyzer / 제품 review 후보 | 1,302 / 1,308 |
| profile | `site-drawing-20260803-v1`, version `site-drawing-20260803/1` |
| profile digest | `d6dbdda9bd28a4eca8e54db48f0ff88129001bc72409f92f3f2196b4cc7de962` |
| raw / gzip SVG | 17,046,497 / 3,731,451 bytes |
| gzip SVG SHA-256 | `bc71ccb314e7a687144a54dba8d74f23f20ab5364fcb47fa0fbd99f204cb2185` |
| macOS standalone parent / child peak RSS | 53,346,304 / 489,635,840 bytes |
| Linux 768 MiB cgroup parent baseline / peak | 139,603,968 / 142,684,160 bytes |
| Linux 768 MiB cgroup child peak | 376,909,824 bytes |

analyzer JSON을 두 번 생성한 SHA-256은 모두 `3a215512eee5e98771f6faf4923176b69b7634ae1a38f4b8ce6c2dcad0e02782`였다. direct model-space INSERT name+finite-origin rate 100%와 지원 entity 예상 coverage 98.1478%는 제한된 추출 지표이며 시각·검출 정확도 100%가 아니다. WIPEOUT 397개와 SPLINE 84개는 미지원이다. 사람 ground truth가 없어 precision/recall/F1은 미확정이고 실제 BLE identity mapping은 0%다.

## 검증

- analyzer + production deploy Node test: 25/25 통과(각 14/14, 11/11)
- API focused Jest: 10 suites 140/140 통과, Object Storage opt-in suite는 별도 실제 MinIO 실행
- Web CAD focused: 28/28 통과, Shared 전체: 244/244 통과
- 실제 PostgreSQL floor import + migration: 33/33 통과. 4번째 chunk 실패 전체 rollback, retry 2,000건, cleanup, 2,000건 조회와 1,302건 apply 포함
- 실제 MinIO ObjectStorageService: 2/2 통과. gzip PUT/HEAD/signed GET 포함
- 실제 Chrome signed GET: `Content-Encoding: gzip`, SVG natural size 37x23 확인
- 제공 DWG actual worker/storage/DB/API HIL: 1/1 통과, 후보 1,308건과 gzip 3,731,451 bytes 보존
- 최신 production image를 768 MiB Linux cgroup에서 정상 샘플과 malformed 입력으로 실행했다. 정상 결과는 위 RSS와 일치하고 적대 입력 뒤 parent가 생존했다.
- Shared/API/Web typecheck와 production build 통과, `git diff --check` 통과

## 남은 한계

escaped SVG text는 외부 font resource 없이 브라우저/OS font fallback에 의존한다. 한글 문자열과 실제 Chrome decode는 검증했지만 모든 배포 OS의 glyph metric 동일성은 주장하지 않는다. WIPEOUT occlusion과 SPLINE 곡선은 렌더하지 않는다. production image에는 GPL converter를 넣지 않으므로 운영자는 승인된 별도 converter command와 resource-limited 실행 환경을 구성해야 하며 미구성 시 worker는 fail-close한다. AI adapter는 disabled이고 I/O 호출은 0회다. 신규 PDF import는 제외하고 기존 PDF 읽기 호환만 유지한다.
