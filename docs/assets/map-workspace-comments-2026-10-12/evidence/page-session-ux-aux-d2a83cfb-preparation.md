# UI/UX binding preparation — d2a83cfb / NO ACTUAL EXECUTION

## 판정 / 범위

Root가 인계한 source `d2a83cfb2a852654b01cc2ea44bac19a5f3b2bf8`의 binding-only 준비다. **브라우저/server/case 실행0, PASS 추가0, STOP/WAIT.** 같은 worktree/branch이며 준비 시작 HEAD=d2a83cfb/clean을 확인했다. 종료 전 read-only 확인에서 HEAD가 `2e11844e2a181ffb5f578d4d67f6a19b890e315f`/clean으로 변경됐다. Root가2e 인계를 전달한 직후 TS2353을 확인해 최종 source 확정을 다시 보류했다. 아직2e로 binding을 바꾸지 않았고 현재 binding은d2a다. 새 typeGREEN fullSHA/별도 실행 승인까지 HEAD 불일치 관문을 우회하지 않는다.

Root 전달 결과: owner c9b65514 compact repair/direct79 exit0/UI0/type0, d2a policy79/build0. Root integration111PASS5FAIL은 옛 App.test dialog lookup에 따른 실패였고, owner2e test-only 수정 뒤 App69PASS/exit0/10.91s가 보고됐다. 그러나 root2e tsc는 Testing Library RoleOptions에 없는 exact 옵션으로 **TS2353/exit1**이며 원 monitoring owner의 test-only 재수리가 진행 중이다. 이는 root/owner 결과이지 이 세션의 실행 결과가 아니다. 실패 증거를 제거하거나 UX PASS 수에 합산하지 않는다. 이전4093 actual은1PASS5FAIL/exit1/34.307626s 그대로다.

## Source-honest binding / checked steps

- [x] Read current auxiliary provider/panel/portaled content, selection/execution/toolbar components, map camera render, consumer wiring and OperationMapPanel.
- [x] Compare4093→d2a product diff. Camera opt-in compact frame becomes52px; manual compact button frame is44px-high/at-least48px-wide/square. No runtime44 hit PASS inferred from source classes.
- [x] Opaque panel `[data-manual-auxiliary-panel]`, real scroll owner `[data-manual-auxiliary-body]`, direct-parent map-bottom anchor `[data-operation-map-panel] div:has(> [data-manual-auxiliary-panel])` unchanged.
- [x] Real selection wrapper `[data-manual-auxiliary-body] div:has(> ul[aria-label="선택 조명"])` and More wrapper `[data-manual-auxiliary-body] div:has(> [role="group"][aria-label="빠른 밝기 값"])` unchanged. Shared panel aria-controls ownership unchanged; former hidden inline slots are not substituted.
- [x] Mobile camera opaque/touch group `[data-operation-map-panel] [role="group"][aria-label="지도 확대 축소"]` unchanged. `compactAuxiliary` still selects overlay; PC remains footer. New camera dimensions are dynamically measured/subtracted by the existing collector when a future run is authorized; no threshold/baseline hardcoding.
- [x] Only binding source literal changed4093→d2a. Spec retains solely the previously approved `배치됨`→`미배치` literal correction. Support/config unchanged,6 declarations retained, criteria/collector/timeouts/retries/workers unchanged.
- [x] Browser-free standalone strict TypeScript/noEmit using installed pnpm realpaths: exit0/diagnostics0. AST case declarations6, not Playwright discovery.
- [x] Frozen preliteral four-file archives and current4093 raw log/results hashes match. No old run/PNG/log/result modification.
- [x] Port15188 read-only lsof exit1/output0. No listener started/stopped; protected services/equipment/remote untouched.
- [ ] Final test-only source handoff/root gate and distinct actual execution grant. **Not received.** Candidate next scope is existing failed cases1–5 only, subject to root's final review; no config/case-selection edit or execution now.

## Prepared SHA256 / frozen execution

| File | Prepared SHA256 |
| --- | --- |
| aux spec | `c765331b7556ed182ae016d40e2c2fa6b8f7faf35cc681de6a973398f56af861` |
| aux support | `83ab0d32e18d099788dd5ed232c32c824d4d877dd7102d78a101415533e584f5` |
| aux config | `fa4963f453a269baa78c7e57dc950008d02d43a74d9c51a80525a1c037cbef08` |
| aux binding (d2a) | `24e0e53086f9fdbc731d06cb597c4702e8bef38327d15496d4b9c1438c5db5eb` |

`page-session-ux-source-4093ff53/*.source.txt` exact archives remain spec `be1cbcef37f95f68e2ec3f211bf63559ce899e0342679892a2194befea8e71b9`, support `83ab0d32e18d099788dd5ed232c32c824d4d877dd7102d78a101415533e584f5`, config `fa4963f453a269baa78c7e57dc950008d02d43a74d9c51a80525a1c037cbef08`, binding `d3c89a971a5cdc5acab012490c17c323ba0076b0e4e0bc6af8e1eb5e88e17b7b`. Current4093 raw log `d751f9209fc1ea2df74d199e0c3c484219fbf09b1e5790e2fd7984e981999e12` /results JSON `769f366afcf43fe002fc5dab28d7dbdd3bc91c575ae382c00fddded62b47a493` unchanged. Archives have `.txt` suffix and cannot register cases.

## PC6 carry evidence — source comparison only, root decision pending

CustomerShell's unchanged media query is `(width < 760px)`; PC1194 therefore has `singleColumnLayout=false`. The unchanged ControlView passes false to provider `enabled`, selection/execution `compact` and SpatialTargetSelector `compactWorkspace`. SpatialTargetSelector derives `compactManual=false`/`compactAuxiliary=false`; camera compactChrome=false/footer, default inline portals are retained. Raw4093→d2a diff0 verified for App.tsx, CustomerShell, ControlView, SpatialTargetSelector, CommandHistoryPanel, FloorScene, shared UI and API directories, settings API fixtures, shared package, web package/lock. Independent OperatorShell/security title change is not the customer route.

Six relevant functions were compared read-only via TypeScript AST. For the four changed functions below, projection selects `compact`/`compactChrome` conditional **false** branches, normalizes equivalent JSX class literal/expression syntax, drops `className={undefined}`, omits the new unused compact-camera class constant, and strips comments with the TypeScript printer. This is bounded source equivalence, not a browser, application evaluation, or whole-file hash claim.

| Function | Equal4093/d2a false-path SHA256 |
| --- | --- |
| ManualExecutionPanel | `c37a303bbb80a8e06fffac96d648809b0ae6c1c3f41ee616d3943dd742d3aa67` |
| ManualSelectionPanel | `683f8a862f5bdd330788e8bb8c556b1b66add5ac78ef34133c8531f11ff545a9` |
| TargetSelectionToolbar | `c044a8a3a34054eba54c81bab173d800903641d894516b9fe5838312c641d5fc` |
| FloorMapViewport | `84eab6b8f076df2cefed187c16e20e9ac00aba086252d887f2d7cddfc0cc5c79` |

ManualAuxiliaryProvider raw function-text SHA256 unchanged `84ba0e268ac9bac70cd3cf6465d9d65c560400aee8af2dd034ed160eac24af55`; ManualAuxiliaryContent unchanged `e73f8f234c0d080fef31325b1ce181a5d8a0323b1859cbd928f578d9e31b8e54`. PC6 outer test callback body (including braces, trimmed) remains `36eb60090c40f2268ffc983da7679554c8a49bcfa36b8076be8ea375776407c3` in frozen/prepared specs. Full spec diff contains only monitoring literal correction outside Case6.

First AST projection reported a ManualExecutionPanel text mismatch because old `className="..."` versus false-selected `className={"..."}` has different syntax; the second projection explicitly normalizes this equivalent JSX form and reports all four equal. This first comparison is not suppressed or represented as product/runtime failure.

Limitation: ManualAuxiliaryPanel's always-mounted but PC-hidden close-button class changed. Its entire component/whole page DOM hash is **not** unchanged. No new PC geometry/UI screenshot or fresh PC PASS is claimed. A scoped carry candidate may use the source-equivalent visible Case6 path and unchanged provider/content/body proof above; root must decide whether that suffices. Prior PC6 PASS stays tied to4093 and is reported separately from any future five-case run. Observed d2a→2e diff has only App.test.tsx; an exact exclusion check confirms all other apps/web/shared/package/lock paths diff0. The first exclusion glob missed root-level App.test.tsx and returned its test diff/exit1; the corrected explicit exclusion returns exit0/output0, not a product failure. Root2e typeRED still requires a new typeGREEN source handoff before changing binding.

**STOP/WAIT.** No automated run, `--list`, suite/build execution, product/test/root metadata edit, new agents, equipment/HIL, or remote mutation by this preparation.
