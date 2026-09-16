# Task 19.4 Fix Round 3 구현 보고서

- 작업일: 2026-09-17
- 기준: `task-19.4-rereview-2.md`의 신규 P2-7
- 커밋: `fix(web): retain completed map refresh recovery` 단일 커밋

## 구현 내용

- completed job 확인과 authoritative map refresh 완료를 서로 다른 상태로 분리했다.
- completed 확인 시 candidate review는 suppress해 apply 재전송을 차단하지만, map refresh가 성공하기 전에는 parent review를 완전히 제거하지 않는다.
- 최초 authoritative refresh가 실패하면 completed job을 `refreshRecoveryJob`으로 보존한다.
- recovery 동안 신규 CAD import form을 숨기고 `최신 맵 다시 불러오기` 버튼과 오류 상태를 유지한다.
- 재조회 버튼은 `onApplied(null)`만 호출한다. apply API와 job GET은 다시 호출하지 않는다.
- refresh 성공 시에만 parent review, recovery job, 오류 상태를 함께 정리하고 신규 import form으로 돌아간다.
- `failed`/`cancelled` terminal의 기존 신규 import 복귀 흐름은 변경하지 않았다.

## 변경 파일

- `apps/web/src/features/floor-editor/CadImportPanel.tsx`
- `apps/web/src/features/floor-editor/CadImportPanel.test.tsx`
- `.superpowers/sdd/2026-07-06-floor-editor-implementation/task-19.4-fix-round-3.md`

## TDD 증거

### RED 1

`pnpm --filter @led-control/web test -- src/features/floor-editor/CadImportPanel.test.tsx`

- 1 failed / 22 passed.
- completed 확인 뒤 map refresh 실패 시 `최신 맵 다시 불러오기` 버튼을 찾지 못했다.
- 신규 import form이 노출되어 recovery 상태가 유지되지 않는 기존 결함을 재현했다.

### RED 2

`pnpm --filter @led-control/web test -- src/features/floor-editor/CadImportPanel.test.tsx -t "keeps a map-refresh recovery action"`

- recovery 재조회 성공 후 이전 오류 문구가 남아 완전히 닫히지 않는 상태를 재현했다.

### GREEN

- `CadImportPanel.test.tsx`: 23/23 통과.
- 재조회 전에는 review close callback이 호출되지 않는다.
- 재조회 성공 후에만 review/recovery/error가 정리된다.
- 전체 흐름에서 `applyFloorImportJob`과 `getFloorImportJob`은 각각 최초 1회만 호출된다.

## 최종 검증

| 검증 | 결과 |
| --- | --- |
| `pnpm --filter @led-control/web test -- src/api/floor-editor.test.ts src/features/floor-editor` | 13 files, 154/154 통과 |
| `pnpm --filter @led-control/web typecheck` | 통과 |
| `pnpm --filter @led-control/web build` | 통과 |
| `pnpm --filter @led-control/web test:ui-policy` | 53/53 통과 |
| `pnpm --filter @led-control/web ui:check` | 기존 0건, 신규/증가 0건 |
| `git diff --check` | 통과 |

## 남은 한계

- Web production build의 기존 500 kB 초과 chunk 경고는 유지된다.
- concurrent parser/shared/API/docs/script 변경은 수정하거나 stage하지 않았다.
