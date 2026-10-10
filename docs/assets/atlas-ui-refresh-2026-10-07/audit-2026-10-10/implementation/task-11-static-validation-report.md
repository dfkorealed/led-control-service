# Task 11 LEAN 최종 정적 검증 — 최초 원본 실패

상태: 지정 네 명령 각1회 실행 완료, 모두 실패. 제품·정책·baseline·HEAD·index를 수정하지 않았고 총괄의 수정 조율 전 멈춘다. PASS나 브라우저/HIL 승인 상태가 아니다.

## source/runtime 경계

- cwd: `/Users/kim-jh/Documents/led-control-service/.worktrees/atlas-ui-fidelity-20261010`.
- branch: `codex/atlas-ui-fidelity-20261010`.
- 시작/완료 HEAD: `5f3e3c20be92a4cddfcd3a920dfc0627d87d273b`, 동일.
- 시작 및 완료 `git status --short`/`git status --porcelain=v1`: 출력 없음(clean). `git diff --check`, `git diff --cached --check` 모두 exit0. stage/commit/제품 편집 없음.
- 명령 PATH: `/tmp/atlas-ui-fidelity-node22.xde1wS/bin:$PATH`; 실제 `node --version` v22.20.0 / `pnpm --version`9.15.0, exit0. install/prepare 반복 없음, 사용자 Node24/global pnpm 설정 불변.
- verification-before-completion skill을 읽고 실제 출력·exit·원인 파일을 대조했다. 승인 네 명령은 각각1회, 병렬 실행했으며 추가 unit/전체 Web/583/canonical/Lab/E2E 검증은 하지 않았다.

## 원본 명령 결과

| 실제 명령 | exit | 실제 결과 | 원본 log |
| --- | --- | --- | --- |
| `pnpm --filter @led-control/web typecheck` | 2 | `tsc --noEmit` TS 오류3개(2파일) | `task-11-static-typecheck.log` |
| `pnpm --filter @led-control/web test:ui-policy` | 1 | 79tests:78PASS/1FAIL/0SKIP/0cancelled/0todo;27.743초 | `task-11-static-policy.log` |
| `pnpm --filter @led-control/web ui:check` | 1 | 원문 `3 existing violations; 3 new/increased violations` | `task-11-static-ui-check.log` |
| `pnpm --filter @led-control/web build` | 2 | `tsc --noEmit && vite build`가 동일TS3에서 중단, 이 build 명령의 Vite 미실행 | `task-11-static-build.log` |

각 로그는 이 report와 동일 canonical scratch 폴더에 보존했다. 출력에서 별도 warning은 없지만 오류·실패는 위와 같이 있다. typecheck/ui:check/build는 실행 시간이 원 출력에 없어 임의 duration을 만들지 않는다. pnpm ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL/Exit status는 위 하위 명령 실패의 전달이지 새로운 독립 원인은 아니다.

## 정확한 타입 오류 및 원인

1. `apps/web/src/features/monitoring/FloorMap.test.tsx:352:34` TS2345. `const footer = legend.closest("[data-floor-map-footer]")`가 Element|null인데 `expect(map).toContainElement(footer)` 인자는 HTMLElement|SVGElement|null을 요구한다. Task4에서 담당자가 작성한 테스트의 정적 타입 불일치이며 원본 unit PASS가 typecheck PASS를 의미하지 않았다.
2. `apps/web/src/features/settings/floor-plans/FloorPlanSettingsView.test.tsx:27:23` TS2352. `{target,isIntersecting:true}[] as IntersectionObserverEntry[]` 테스트 entry는 boundingClientRect/intersectionRatio/intersectionRect/rootBounds/time이 없다.
3. 같은 파일`:31:23` TS2352. `{target,isIntersecting:false}[]`의 같은 partial entry cast 문제다.

별도 build의 tsc도 동일 세 오류를 출력한다. 타입 오류6개로 중복 합산하지 않는다. 제품 동작을 고치거나 assertion/fixture cast를 임의 완화하지 않았다.

## 정확한 UI 위반 및 실패 case

- `apps/web/src/features/floor-editor/FloorEditorView.tsx:147`: `query-selector`, `historyEntry.current.querySelector<HTMLElement>('[aria-label="맵 버전"]')`. panel history intent에서 DOM query로 region을 찾아 focus/scroll하는 경로가 기존 생산 DOM-query 금지 정책에 걸린다.
- `apps/web/src/features/settings/floor-plans/FloorPlanSettingsView.tsx:36`: `query-selector`, `gallery.current.querySelectorAll("[data-floor-id]")`. preview IntersectionObserver 대상 수집을 DOM query로 수행한다.
- `apps/web/src/features/settings/site/SiteOperationsView.tsx:133`: `unapproved-color`, `text-customer-section-title`. h2 raw class에 customer 표현 역할 이름을 utility처럼 사용했다. 승인 customer-section-title은 Typography variant recipe이고 독립 size token은 아니므로 유효 색 utility로도 승인되지 않는다.

`test:ui-policy`의 유일한 실패는 `production UI has no legacy policy violations` (subtest14; `apps/web/scripts/ui-policy.test.mjs:549`, assertion551)이다. expected[] vs actual 위3 findings이며 ui:check와 같은 위반을 다시 검출한 것이다. 두 명령 결과를 위반6개로 합산하지 않는다. token anchor/baseline 등 나머지78개는 PASS이고 정책 예외를 늘리거나 full suite PASS로 표현하지 않았다.

정책 suite 자체의 subtest77 `real Vite build emits semantic and reviewed responsive CSS without fixture pollution`는 PASS(15.877초)다. 이는 기존 suite 내부 fixture/compiler 검증이며 위 별도 build 명령에서 Vite가 실행되었다는 뜻이나 제품 build 성공이 아니다.

## 보고·미실행

- ui:check 최초 실패3개와 이후 typecheck/build/정책79 결과를 총괄에 즉시 전달했다. 담당 product/index 변경 없이 검증 evidence만 ignored scratch에 기록했다.
- source 수리·추가 테스트·재시도·full Web/type 반복·UI/build 반복·브라우저/화면 비교·실서버/장비/API/DB 변경·HIL 미실행. 수정 후 재검증은 총괄의 새 source/범위 조율 전에는 실행하지 않는다.
- 이 최초 결과를 후속 GREEN으로 덮어쓰지 않는다. 향후 수정 source 검증은 exact HEAD·별도 log·실패 해소 범위를 구분해야 한다.

## 수리 통합 뒤 최종 재확인 — 0bba6fe1

위 최초 `5f3e3c20`의 실패·명령·로그는 당시 원본 증거로 모두 보존한다. 총괄이 후속 수리를 통합한 뒤 최초 실패한 네 정적 관문의 각1회 재확인을 명시 승인했다. 현재 최종 상태는 아래와 같으며 초기 실패 문장을 현재 상태로 해석하지 않는다.

### 수리 source / 소유 경계

- 공통 test-only 수리: `1c4943a600422f52dba1d99d1627b2c2260b3e77` — FloorMap.test.tsx의 공개 closest<HTMLElement> generic, 기존 단언 유지.
- 설정 담당 수리: `da9edfee1c25f45b25c1a9aa99f46ff570d7ff30` — 정책-safe refs, 공통 Heading 소비, 완전한 IntersectionObserver fixture 및 PasswordDialog pending request lifetime. 담당자의155PASS는 별도 보고 증거이며 이번 정적 명령의 test count에 합산하지 않는다.
- 최종 시작/완료 exact HEAD: `0bba6fe16c89b5681c4d96050513ba7145bddcdd`; branch/cwd/runtime는 위와 동일하다. 시작/완료 git status 출력 없음(clean), unstaged/staged diff-check0.
- validation 담당은 이 재확인에서 source/index/HEAD/root docs/정책/default/baseline을 변경하지 않았다. 보고서·로그는 ignored canonical scratch에만 추가했다.

### 실제 최종 명령 / exit / count

모든 명령은 `PATH="/tmp/atlas-ui-fidelity-node22.xde1wS/bin:$PATH"`로 실행했다. 승인 네 명령은 최종 HEAD에서 각각 한 번씩, 병렬로 실행했다.

| 실제 명령 | exit | 최종 실제 결과 | 새 원본 log |
| --- | --- | --- | --- |
| `pnpm --filter @led-control/web typecheck` | 0 | `tsc --noEmit`, 오류 없음 | `task-11-static-final-typecheck.log` |
| `pnpm --filter @led-control/web test:ui-policy` | 0 | 79tests/79PASS/0FAIL/0SKIP/0cancelled/0todo;27.826초 | `task-11-static-final-policy.log` |
| `pnpm --filter @led-control/web ui:check` | 0 | `0 existing violations; 0 new/increased violations` | `task-11-static-final-ui-check.log` |
| `pnpm --filter @led-control/web build` | 0 | `tsc --noEmit && vite build` 정상 완료, Vite4696modules·8.74초 | `task-11-static-final-build.log` |

- 최초 타입3 및 UI3 위반이 최종 해당 전체 정적 관문에서 더 이상 검출되지 않았다. 최초78PASS와 이번79PASS를 합산하지 않는다. 정책 suite의 내부 fixture Vite case77도 PASS이며 수동으로 별도 build나 typecheck를 더 실행하지 않았다.
- typecheck/정책/UI 로그의 별도 warning0. 제품 build에는 Vite의 기존 일반 chunk-size 경고1블록(`Some chunks are larger than 500 kB after minification`)이 출력됐다. 해당 경고를 숨기거나 warning0/새 최적화 완료로 기록하지 않는다.
- main `dist/assets/main-D_4v_I6-.js`930.29kB/gzip280.26kB, CSS201.60kB/gzip30.68kB. code splitting/manualChunks/threshold 설정은 수정하지 않았으며 별도 bundle budget audit를 실행했다고 주장하지 않는다. typecheck의 전체 wall time은 로그에 없고 build8.74초는 Vite 단계 값이며 tsc+전체 command 시간과 동일하다고 주장하지 않는다.

### 실제 AST / debt / anchor

- read-only PostCSS 실제 theme AST 선언738개, unique 이름738개. `approvedSourceRef`와 baseline.sourceRef는 모두 `e841c57b11321a5ae35d15920031020089f06ee2`, baseline.files는 `{}`이며 UI scan debt0/0이다. 이 validation에서 anchor 회전·debt allowance·token 변경은0이다.
- 승인 추가4선언 값: `--text-customer-page-title:1.625rem`, `--text-customer-page-title--line-height:1.35`, `--text-customer-metric:1.875rem`, `--text-customer-metric--line-height:1.3`. 과거 count734+4 추정이 아니라 현재 AST를 읽어 산출했다. 최종 정책의 anchor/inventory 계약도 PASS다.
- 보조 inventory 첫 시도는 apps/web eval에서 postcss를 직접 import하여 transitive dependency 해석이 안 되어 `ERR_MODULE_NOT_FOUND`/exit1이었다. 원본 `task-11-static-final-inventory.log`를 보존했다. 제품/설치/의존성 수리 없이 기존 policy와 token test가 사용하는 `createRequire(require.resolve("vite"))("postcss")` 경로를 적용한 read-only 진단이 exit0이며 `task-11-static-final-inventory-resolved.log`에 위 AST·anchor·baseline·값을 기록했다. 이 진단의 첫 호출 오류는 네 최종 관문 실패가 아니며 감추지 않는다.

### 최종 한계 / 종료

- install/prepare/unit/whole Web/583/Lab/canonical/E2E/browser/실장비/HIL 추가 실행 없음. 실제 geometry·focus·dark 대비·추가POST0/최종 독립 리뷰·병합 완료 증거가 아니다.
- 로그 전체를 읽고 exit/count/warning을 대조했다. 최초 실패 원본은 보존했고 이번 결과는 수리된 exact HEAD의 정적 PASS만 의미한다. 완료 후 HEAD/clean/diff-check를 확인하고 멈춘다.
