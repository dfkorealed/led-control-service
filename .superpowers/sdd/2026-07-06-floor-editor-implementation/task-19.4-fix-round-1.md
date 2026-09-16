# Task 19.4 Fix Round 1 구현 보고서

- 작업일: 2026-09-17
- 기준: `task-19.4-review.md`의 P1 2건, P2 5건
- 구현 커밋:
  - `867d3ba1` `fix(cad-import): recover active jobs with viewport`
  - `e84e3dad` `fix(web): harden CAD import review recovery`

## 구현 내용

1. 층별 active CAD job 조회
   - `GET /floors/:floorId/import-jobs/active`를 추가했다.
   - floor에서 site를 확인한 뒤 `manage` 권한을 검증하고 `queued`, `processing`, `review_required`, `applying`만 반환한다.
   - 화면 mount/floor 변경 및 create 409에서 durable job을 hydrate한다.
   - polling은 `queued`, `processing`에서만 수행하고 `review_required`, `applying`, terminal 상태에서는 중단한다.

2. 검증된 CAD viewport
   - Shared에 strict `floorImportRenderedViewportSchema`를 추가했다.
   - review/applying/completed job 응답은 rendered asset ledger와 object storage HEAD를 재검증한 `renderedViewport`를 포함한다.
   - CAD preview 동안 배경 bounds와 후보 좌표계에 동일한 viewport를 사용한다.

3. 편집 draft 및 apply 수렴
   - dirty draft가 있으면 CAD 시작과 apply를 비활성화하고 저장 또는 취소 안내를 표시한다.
   - apply 성공 또는 GET reconciliation으로 completed가 확인되면 authoritative editor-state를 다시 읽어 Zustand baseline과 query cache를 갱신한다.
   - authoritative reload가 일시 실패해도 completed review는 닫아 중복 apply를 막고 재조회 UI를 제공한다.

4. 충돌 및 결과 불명 처리
   - apply 409는 기존 editor conflict 배너와 최신 버전 reload 동작으로 연결했다.
   - network/timeout 계열의 결과 불명은 job GET 이후 completed/review_required/applying/terminal 상태로 수렴한다.
   - review_required로 확인되면 기존 후보 선택을 보존한다.

5. 후보 성능과 접근성
   - 후보는 계속 단일 Konva Layer/Shape로 batch 렌더한다.
   - 고정 셀 spatial index와 world viewport culling을 적용하고 pointer 후보 검사를 최대 64개로 제한했다.
   - 이전/다음 버튼과 단일 semantic Checkbox로 현재 후보의 layer, block, confidence, 선택 상태를 노출했다.
   - 1,000개 후보에서도 DOM 후보 row는 하나만 렌더한다.

6. 빈 CAD MIME 보정
   - 빈 `File.type`은 확장자에 따라 DWG `application/dwg`, DXF `application/dxf`로 보정해 intent와 PUT에 동일하게 사용한다.
   - 알려진 non-empty MIME과 확장자가 불일치하면 기존처럼 거부한다.

후보는 review 전용 데이터로 유지되며 Fixture 또는 MeshNode를 생성하지 않는다.

## 변경 파일

- `packages/shared/src/cad-import-contracts.ts`
- `packages/shared/src/cad-import-contracts.test.ts`
- `apps/api/src/floor-import/floor-import.controller.ts`
- `apps/api/src/floor-import/floor-import.service.ts`
- `apps/api/src/floor-import/floor-import.service.spec.ts`
- `apps/web/src/api/floor-editor.ts`
- `apps/web/src/api/floor-editor.test.ts`
- `apps/web/src/features/floor-editor/editor-types.ts`
- `apps/web/src/features/floor-editor/CadImportPanel.tsx`
- `apps/web/src/features/floor-editor/CadImportPanel.test.tsx`
- `apps/web/src/features/floor-editor/CadCandidateLayer.tsx`
- `apps/web/src/features/floor-editor/CadCandidateLayer.test.tsx`
- `apps/web/src/features/floor-editor/FloorEditorCanvas.tsx`
- `apps/web/src/features/floor-editor/FloorEditorView.tsx`
- `apps/web/src/features/floor-editor/FloorEditorView.test.tsx`

## TDD 증거

### RED

- Shared focused test: viewport schema가 없어 `Cannot read properties of undefined (reading 'parse')`, 1 failed / 5 passed.
- API focused test: `FloorImportService.getActive` 미구현으로 TS2339, suite compile 실패.
- Web focused test: active endpoint, spatial index, empty MIME, dirty 차단, conflict/reconciliation, viewport bounds가 없어 12 failed / 58 passed.
- Self-review 보강 test: completed GET 뒤 authoritative refresh 실패 시 review가 닫히지 않아 1 failed / 19 skipped.

### GREEN

- Shared focused: 6/6 통과.
- API `floor-import.service.spec.ts`: 15/15 통과.
- Web focused: API, panel, candidate layer, editor view 72/72 통과(보강 전); 최종 전체 관련 suite에 포함해 재검증했다.
- completed reconciliation 보강 focused test: 1/1 통과.

## 최종 검증

| 검증 | 결과 |
| --- | --- |
| `pnpm --filter @led-control/shared test -- src/cad-import-contracts.test.ts` | 6/6 통과 |
| `pnpm --filter @led-control/api test -- src/floor-import --runInBand` | 10 suites, 100 tests 통과; 환경 의존 integration 1 suite/7 tests skip |
| `pnpm --filter @led-control/web test -- src/api/floor-editor.test.ts src/features/floor-editor` | 13 files, 148/148 통과 |
| `pnpm typecheck` | workspace 통과 |
| `pnpm build` | workspace 통과 |
| `pnpm --filter @led-control/web test:ui-policy` | 53/53 통과 |
| `pnpm --filter @led-control/web ui:check` | 기존 0건, 신규/증가 0건 |
| `git diff --check` | 통과 |

## 남은 한계

- 실제 PostgreSQL을 띄우는 `floor-import.integration.spec.ts`는 `FLOOR_IMPORT_INTEGRATION=1`이 없어 이번 검증에서 7개 테스트가 skip됐다. service 권한/상태/viewport 계약과 나머지 floor-import 100개 테스트는 통과했다.
- 실제 DWG/DXF 파일과 object storage를 연결한 브라우저 E2E는 이번 범위에 포함되지 않았다.
- Web production build는 성공했지만 기존 500 kB 초과 chunk 경고는 유지된다.
