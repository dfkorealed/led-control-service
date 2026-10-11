# Task 6 통합 QA — phase 1 + phase 2

## 검증 소스

- workdir: `/Users/kim-jh/Documents/led-control-service/.worktrees/atlas-interactions-comments-20261011`
- ordinary merge 진행 중: HEAD `0ca15683ad36775d576790c00648e1a6a16171b5`, MERGE_HEAD `34d5a3753c23a9ac11ea9faebb487351d68714b2`.
- 후보 staged tree: `c0bc852d232f29ec4f2db1a9958ccc1caf9ea6f2` (root 제공). 종료 시 `git diff --cached <candidate-tree> --stat` 출력0, product working diff 출력0. QA는 index/소스/branch/commit/merge 상태를 변경하지 않았다.
- runtime: `PATH=/tmp/atlas-ui-fidelity-node22.xde1wS/bin:$PATH`. frozen/warm dependencies·workspace prepare 재사용, install 없음.

## 요청된 한정 검증 — 모두 fresh 1회

| command | 실제 결과 / exit | 원 로그(integration-raw/) |
| --- | --- | --- |
| `pnpm --filter @led-control/web exec vitest run src/components/ui/ui-primitives.test.tsx src/components/ui/public-site/PublicLogin.test.tsx src/components/ui/DataGrid.test.tsx src/components/ui/FilterPanel.test.tsx` | 4 files / 87 PASS,0 FAIL / exit0 | ui-intersection.log |
| `node --test scripts/landing/public-mode.test.mjs apps/web/scripts/public-deploy-contract.test.mjs` (root cwd) | 7 PASS,0 FAIL / exit0 | public-contract.log |
| `pnpm --filter @led-control/web test:ui-policy` | 79 PASS,0 FAIL / exit0 | ui-policy.log |
| `pnpm --filter @led-control/web ui:check` | existing0/new0 / exit0 | ui-check.log |
| `pnpm --filter @led-control/web build` | `tsc --noEmit && vite build` 통과 / exit0 | build.log |

총 173 tests(87+7+79) PASS. 별도 typecheck 중복 실행 없음: build가 fresh TypeScript 검사를 포함한다. 명령별 stdout/stderr 원문을 `.superpowers/sdd/2026-10-11-atlas-interactions-comments/integration-raw/`에 보존했다. >500kB chunk 경고는 미수리이며 성공 exit와 분리한다. raw artifact whitespace를 제품 diff 경고나 정책 실패로 해석하지 않는다.

## 경계/인계

Phase1은 병합 후보 tree 검증이며 실제 merge commit SHA의 실행 결과로 확대하지 않는다. 브라우저/server 시작0, 기존6/149 matrix/full Web suite/하드웨어/DB/HIL/원격/사용자5173·4000·63200 변경0. 기존 SettingsShell baseline1 failure는 범위 밖/미실행으로 유지한다.

Phase1에서 QA가 쓴 것은 owned ignored integration-raw 로그와 이 보고서뿐이다. root 소유 staged status/plan 및 merge index를 그대로 보존했다.

## Phase 2 — 실제 ordinary merge SHA

- source `113f6db24cf6f707393b1994810cf55a04e2670e`, tree `c0bc852d232f29ec4f2db1a9958ccc1caf9ea6f2`를 read-only로 확인했다. Phase1 후보 tree와 동일하다.
- root 승인으로 spec의 evidence metadata 1줄만 `process.env.E2E_EVIDENCE_SOURCE ?? "437ebc39"`로 변경하고 env에는 위 실제 merge SHA를 넣었다. 기대값/timeout/retry/skip/fixture setup/제품 변경0. 이후 QA evidence commit은 제품 검증 source와 구분한다.
- `PATH=/tmp/atlas-ui-fidelity-node22.xde1wS/bin:$PATH E2E_WEB_PORT=15187 E2E_EVIDENCE_SOURCE=113f6db24cf6f707393b1994810cf55a04e2670e pnpm --filter @led-control/web exec playwright test e2e/atlas-interactions-comments.spec.ts --list`: exit0, **6 tests in 1 file**.
- 같은 env + `pnpm --filter @led-control/web exec playwright test e2e/atlas-interactions-comments.spec.ts --grep 'interactions (2|4) ' --workers=1 --retries=0 --output=test-results/atlas-interactions-integration --reporter=line`: **2 PASS / 0 FAIL, exit0,16.5s**. 발견6/실행2이며 각각1회, 다른4개/whole6/재시도/추가case 실행0.
- case2: 실제390×600 dark native marker-origin CDP swipe, strict elementFromPoint marker hit, camera(0,0)→(8,8) at zoom1.8, 모든 selection불변, 후속tap false→true, blank held-touch no-area/blank swipe/pinch cancel, raw31 유지. marker x80.265625,y445.703125,48×48. clear x264.09375,y332,width85.90625,h44,bottom376<=실제navtop532, continuous44 확인.
- case4:390·320에서 actual bottom sheet anchored, 날짜한줄/비겹침/keyboardfocus/nestedcalendar Escape→calendar focus→sheetclose→opener focus 유지. 320 sheet y270,h330,bottom600; date group x17,y433,w286,h46; six segment y434 동일(숫자 개별44폭 예외 유지), close y555,h44,bottom599<=viewport600.
- JSON source header 모두 실제 merge SHA. 실제 PNG2대표(marker/320sheet)를 직접 열어 render 확인했다. testInfo.outputPath/path attachment 원 파일 보존.
- lsof15187은 실행전/종료후 모두 출력0,exit1: listener없음. Playwright owned server만 기동/종료; 기존5173/4000/63200 untouched.

원 Phase1/Phase2 로그와 PNG/JSON을 `docs/assets/atlas-interactions-comments-2026-10-11/integration/` 아래에 바이트 그대로 영구화했다. 기존 Task4의 6고유/7runs21exec와 이번 통합2case는 별도 source cohort다. 통합 실제 merge의 전체6 일괄PASS/Native WebView/HIL/DB/원격배포를 주장하지 않는다. 제한된 static173PASS + actual browser2PASS가 통합 인계 근거다. QA-only metadata1줄 + owned integration subtree만 explicit stage/commit, root docs/status/README/ledger 제외.
