# Task 19.4 Fix Round 2 구현 보고서

- 작업일: 2026-09-17
- 기준: `task-19.4-rereview-1.md`의 OPEN P1/P2 및 신규 P2
- 구현 커밋:
  - `5dc54075` `fix(cad-import): reconcile durable active jobs`
  - `85e6f328` `fix(web): converge CAD review state accurately`

## 결정

- 비정상 `applying` 회수 기준은 사용자 ruling에 따라 **DB 시각 2분**으로 고정했다.
- 정상 apply transaction timeout은 15초이며 `review_required -> applying -> completed`가 한 transaction 안에서 완료된다. 따라서 정상 `applying`은 외부에 노출되지 않고, 2분 기준은 정상 transaction보다 충분히 길면서 비정상 committed row의 partial unique 점유를 bounded하게 회수한다.
- 회수 판정과 `failedAt`/`updatedAt` 기록은 모두 PostgreSQL `clock_timestamp()`를 사용한다.

## 구현 내용

1. Active job 권한 및 lifecycle
   - `getActive()`의 floor 조회, Site row lock 기반 manage 재권한, stale reconciliation, active 조회를 하나의 transaction으로 묶었다.
   - 외부에서 복구 가능한 active 상태는 `queued`, `processing`, `review_required`만 허용한다.
   - DB 시각으로 2분 이상 된 committed `applying`만 `CAD_IMPORT_STALE_APPLYING` 실패 상태로 전환한다.
   - 실제 PostgreSQL에서 concurrent admin 재지정 후 기존 관리자의 조회가 거부되는지 검증했다.
   - 실제 PostgreSQL transaction 중간의 `applying`은 다른 connection에서 보이지 않고, commit 전에는 기존 `review_required`, commit 후에는 terminal만 보이는 불변식을 검증했다.

2. Apply reconciliation 및 terminal 정리
   - apply의 409, network, timeout 등 모든 실패에서 job GET을 먼저 수행한다.
   - GET이 `completed`이면 stale review를 즉시 닫고 authoritative editor state를 다시 읽는다.
   - GET이 여전히 `review_required`인 409만 기존 editor conflict/reload UX로 연결한다.
   - `failed`, `cancelled`, 비정상 `applying`은 local job/review를 제거해 신규 import form으로 복귀한다.
   - terminal job id를 즉시 suppress해 controlled prop 갱신 전에도 stale review를 반복 전송하지 않는다.

3. 정확한 후보 hit-test와 pointer 비용
   - 64개 임의 제한을 제거하고 spatial bucket 안의 후보 전체를 squared-distance로 비교해 최대 1,000개에서도 실제 최근접 후보를 선택한다.
   - draw/hit path는 기존 viewport culling과 단일 Konva Layer/Shape batch rendering을 유지한다.
   - mouse move는 animation frame당 한 번만 lookup하도록 병합한다.
   - dense bucket의 마지막 1,000번째 후보 정확성, 100 ms 측정 상한, RAF 병합, pan/zoom stage pointer의 CAD world 좌표 변환을 테스트했다.

4. CAD viewport 맵 맞춤
   - store `fit()`에 명시적 bounds 계약을 추가했다.
   - CAD review 중 `맵 맞춤`은 기존 1200x800 floor plan이 아니라 검증된 640x360 `renderedViewport`를 사용한다.
   - 800x600 viewport에서 기대 zoom `1.175`를 store와 UI 양쪽에서 검증했다.

후보는 계속 review 전용 데이터이며 Fixture, MeshNode, FloorMapObject를 생성하거나 변경하지 않는다. 기존 map과 PDF floor plan 표시, semantic candidate control, canonical CAD MIME 보정도 유지했다.

## 변경 파일

- `apps/api/src/floor-import/floor-import.service.ts`
- `apps/api/src/floor-import/floor-import.service.spec.ts`
- `apps/api/src/floor-import/floor-import.integration.spec.ts`
- `apps/web/src/features/floor-editor/CadImportPanel.tsx`
- `apps/web/src/features/floor-editor/CadImportPanel.test.tsx`
- `apps/web/src/features/floor-editor/CadCandidateLayer.tsx`
- `apps/web/src/features/floor-editor/CadCandidateLayer.test.tsx`
- `apps/web/src/features/floor-editor/editor-store.ts`
- `apps/web/src/features/floor-editor/editor-store.test.ts`
- `apps/web/src/features/floor-editor/FloorEditorView.tsx`
- `apps/web/src/features/floor-editor/FloorEditorView.test.tsx`
- `.superpowers/sdd/2026-07-06-floor-editor-implementation/task-19.4-fix-round-2.md`

## TDD 증거

### RED

- API focused: transaction client/reauthorization/reconciliation이 없어 신규 3건 실패, 기존 13건 통과.
- Web focused: 총 13건 실패, 75건 통과.
  - dense 1,000개 반례에서 기대 후보 `999`, 실제 후보 `63`.
  - pan/zoom world transform helper 부재.
  - apply 409에서 GET 호출 0회.
  - completed/failed/cancelled reconciliation 뒤 신규 파일 form 미표시.
  - 기존 map 1200x800을 사용한 fit zoom `0.626666...`, CAD viewport 기대값 `1.175`.

### GREEN

- API service focused: 16/16 통과.
- 실제 PostgreSQL lifecycle: 8/8 통과.
  - concurrent manage 권한 회수 차단.
  - transaction-local `applying` 비가시성.
  - DB 시각 121초 stale row 실패 회수 및 fresh row 보존.
- Web focused 최종: 4 files, 89/89 통과.
- Web 관련 floor-editor 전체: 13 files, 154/154 통과.
- Shared CAD contract: 6/6 통과.

## 최종 검증

| 검증 | 결과 |
| --- | --- |
| `pnpm --filter @led-control/shared test -- src/cad-import-contracts.test.ts` | 6/6 통과 |
| `pnpm --filter @led-control/api test -- src/floor-import/floor-import.service.spec.ts --runInBand` | 16/16 통과 |
| `FLOOR_IMPORT_INTEGRATION=1 pnpm --filter @led-control/api test -- src/floor-import/floor-import.integration.spec.ts --runInBand` | 실제 PostgreSQL 8/8 통과 |
| `pnpm --filter @led-control/web test -- src/api/floor-editor.test.ts src/features/floor-editor` | 13 files, 154/154 통과 |
| `pnpm --filter @led-control/web typecheck` | 통과 |
| `pnpm --filter @led-control/api typecheck` | 구현 직후 통과. 이후 concurrent parser test 변경으로 workspace 재실행 차단 |
| `pnpm --filter @led-control/web test:ui-policy` | 53/53 통과 |
| `pnpm --filter @led-control/web ui:check` | 기존 0건, 신규/증가 0건 |
| `pnpm typecheck` | **범위 밖 concurrent 변경으로 실패**: `dxf-document-parser.spec.ts`가 아직 없는 `parseAsciiDxfStream`을 import |
| `pnpm build` | Web production build 완료, API는 위 concurrent parser compile 오류로 실패 |
| Task 19.4 커밋 대상 `git diff --check` | 통과 |
| 최종 workspace `git diff --check` 재실행 | **범위 밖 concurrent 변경으로 실패**: `dxf-document-parser.ts:207` EOF blank line |

## 남은 한계

- 다른 에이전트가 작업 중인 `dxf-document-parser.ts/.spec.ts`, analyzer script/fixtures 때문에 API floor-import 전체, workspace typecheck/build 및 최종 workspace `git diff --check`의 GREEN을 만들 수 없었다. 이 변경은 수정하거나 stage하지 않았다.
- 실제 object storage와 DWG/DXF 바이너리를 연결한 브라우저 E2E는 이번 수정 범위에 포함되지 않았다.
- Web production build의 기존 500 kB 초과 chunk 경고는 유지된다.
