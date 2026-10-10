# Task 1 token-only 결과

상태: steps 1–6 완료. 독립 APPROVED exact token commit으로 anchor를 회전하고 정책과 spacing 문서를 갱신했다. 아래 token-only 중간 기록은 해당 단계 이력이다.

## Steps 5–6 정책 마무리

- 정책/doc commit: `ef9b52c96b684bda373563d77a3a475030557830` (명시5파일만 포함, root 문서 변경 미포함).
- 독립 designer APPROVED: `e841c57b11321a5ae35d15920031020089f06ee2`, 근거 `token-approval.md`. 승인4선언만 반영된 exact commit을 policy sourceRef로 사용했다.
- 추가 파일 `apps/web/scripts/ui-policy-baseline.json`은 scanner의 fail-closed exact sourceRef 검사 때문에 같은 승인 SHA 메타데이터만 회전했다. `files: {}`는 그대로이며 debt 추가0/삭제0, 소비자 style 예외 확장0이다.
- 신규 정책 utility 계약의 첫 focused RED는 exit1/1FAIL/0PASS/0SKIP: 신규 두 `text-customer-*`가 색상 classifier에서 `unapproved-color`로 판정됐다. Anchor 교체 후 첫 전체 정책도 같은 case1FAIL/78PASS/0SKIP(exit1)이었고 stale-anchor 성공으로 기록하지 않았다.
- 원인은 customer prefix를 무조건 색상으로 분류하는 기존 lexical scan이다. 승인 `--text-*`가 존재하는 `text-` utility만 분류에서 제외했다. unknown 고객명과 `bg-customer-page-title`은 계속 거부하며 새 typography 두 이름의 line-height modifier도 기존 거부 정책에 연결했다. 기존 selector/literal/native/debt 경계는 불변이다.
- 수정 후 `pnpm --filter @led-control/web test:ui-policy`: exit0/79PASS/0FAIL/0SKIP, 21.69초. Full log: `task-1-policy-green.log`, 전체 failure/warning 출력 없음. `pnpm --filter @led-control/web ui:check`: exit0/기존0·신규/증가0. `pnpm --filter @led-control/web exec vitest run src/components/ui/customer-typography-tokens.test.ts`: exit0/6PASS/0FAIL/0SKIP, 1.66초.
- `docs/ui-spacing.md`에 desktop26/30·mobile24/28의 의도, 기존 mobile23/27 근사, 고객 section gap20px·grid18px·inset20/16px 및 기존 default 보존 예외를 명시했다. 과거 결과는 현재 PASS로 합산하지 않았다.
- 기존 새 토큰 계약 테스트를 이번 policy/doc commit에 포함한다. 전체 Web/type/build/E2E 검증은 실행하지 않았으며 후속 Task11의 한 번 검증으로 남는다.

## 변경 및 불변 증거

- token-only commit: `e841c57b11321a5ae35d15920031020089f06ee2` (`feat(web): add reviewed customer typography tokens`).
- 커밋 파일은 `apps/web/src/styles/theme.css` 하나이며 정확히 4삽입/0삭제다.
- 추가값: `--text-customer-page-title: 1.625rem`, `--text-customer-page-title--line-height: 1.35`, `--text-customer-metric: 1.875rem`, `--text-customer-metric--line-height: 1.3`.
- Vite가 사용하는 실제 PostCSS parser의 `walkDecls`로 재산출했다. 승인 ref `fac0d214653c03cc277993887c0e0c40e440b20d` AST 734선언, 수정 전 현재 AST 734선언, 수정 후 AST 738선언/738고유 이름. 기존 734개 이름·값의 순서 포함 전수 일치, 신규 이름은 승인된 네 개뿐이며 palette 선언 수가 동일하다.
- protected base/root alias, 기존 customer shadow 두 선언, `cn`, `ui-policy.mjs`, `pnpm-lock.yaml` diff 없음. 고객 shadow alias의 실제 정책 검사와 root 밖 override/참조 3개 거부도 계약 테스트에서 확인했다.
- 새 `apps/web/src/components/ui/customer-typography-tokens.test.ts`는 다음 policy commit에 포함하도록 untracked/unstaged로 보존했다. 원 승인 token ref를 독립 고정하여 live policy anchor 회전 뒤에도 기존 선언 보존을 검증한다.
- 소비자/페이지 기능은 이번 범위에서 바꾸지 않아 메뉴 문서 변경이 없다. API/DB/실장비/기존 서버/다른 worktree 출력 변경 없음. root 계획·project-status·ledger 변경 없음.

## 런타임 및 준비

- 기본 확인값은 Node `v24.19.0`. `/opt/homebrew/bin/pnpm`의 pnpm11 launcher는 `pnpm.overrides` 설정 위치 경고를 출력한 뒤 실제 `9.15.0`을 보고했다. 이 launcher는 작업 명령에 사용하지 않았다.
- task-owned runtime: `/tmp/atlas-ui-fidelity-node22.xde1wS/bin/node`, 실제 `v22.20.0`.
- binary는 기존 read-only 경로 `/Users/kim-jh/Library/pnpm/store/v11/links/@/node/22.20.0/82453ed07479973197b891352eef64f0eb8619fe774b5ae0bb95fda2858afcd3/node_modules/node/bin/node`에서 task-owned tmp에 복사했다. 기존 binary/사용자 전역 설정은 수정하지 않았다.
- `/tmp/atlas-ui-fidelity-node22.xde1wS/bin/pnpm`은 `/Users/kim-jh/Library/pnpm/.tools/pnpm/9.15.0/node_modules/pnpm/bin/pnpm.cjs`를 read-only symlink로 참조한다. 실제 `9.15.0`, 해당 경로로는 launcher 설정 경고가 없었다.
- 작업 명령 공통 prefix: `PATH="/tmp/atlas-ui-fidelity-node22.xde1wS/bin:$PATH"`.
- cwd: `/Users/kim-jh/Documents/led-control-service/.worktrees/atlas-ui-fidelity-20261010`.
- `pnpm install --frozen-lockfile`: exit 0, lockfile up to date/resolution skipped, 1156 packages reused/0 downloaded, worktree 전용 node_modules 준비, 8.4초. lockfile 변경 없음.
- `pnpm workspace:prepare`: exit 0. 해당 worktree의 Shared build와 automation-engine `tsc` 준비 완료. 다른 checkout 출력은 사용·수정하지 않았다.

## 실행 증거

아래 pnpm 명령은 모두 위 공통 runtime prefix와 task worktree cwd를 사용했다.

| 단계 | 명령 | 결과 |
| --- | --- | --- |
| 기존 baseline 1회 | `pnpm --filter @led-control/web exec vitest run src/components/ui/Typography.test.tsx` | exit 0, 1 file/24 PASS/0 FAIL/0 SKIP, 2.14초 |
| 신규 계약 RED | `pnpm --filter @led-control/web exec vitest run src/components/ui/customer-typography-tokens.test.ts` | exit 1, 1 file/5 FAIL/1 PASS/0 SKIP, 1.50초 |
| 신규 계약 GREEN | 동일 신규 계약 명령 | exit 0, 1 file/6 PASS/0 FAIL/0 SKIP, 1.55초 |
| diff 검증 | `git diff --check` | exit 0, 경고 없음 |
| 커밋 범위 | `git diff-tree --no-commit-id --numstat -r HEAD` | exit 0, `4 0 apps/web/src/styles/theme.css`만 출력 |

RED의 네 exact-value case는 신규 선언 부재(`[]`)로 실패했다. 기존 전수 보존 assertion은 통과했고 같은 case의 전체 선언 수 assertion만 738 기대/734 실제로 실패했다. shadow alias 경계 case는 통과했다. runner 오류/잘못된 fixture 때문에 실패한 것이 아니다. GREEN에서 6개가 모두 통과했고 테스트 경고는 없었다.

## Steps 1–4 당시 중간 대기 및 한계 (현재 상태 아님)

- 현재 policy anchor는 기존 `fac0d214…`를 유지한다. 새 네 이름의 anchor 승인은 아직이므로 `ui:check` 및 `test:ui-policy`를 실행하거나 최종 정책 PASS로 기록하지 않았다. Steps 5–6에서 designer 승인 후 위 exact token commit으로 순차 회전해야 한다.
- 사용자의 LEAN 지시에 따라 전체 Web/583/Lab/canonical/E2E/build/불필요 per-task review는 실행하지 않았다. baseline 24개 결과는 변경 전 결과이며 이번 신규 변경의 GREEN 증거는 신규 계약 6개다.
- tmp runtime은 후속 담당이 재사용할 수 있도록 유지했다. 후속 사용 전에 정확 경로의 `node --version`/`pnpm --version`을 확인한다.
- 소프트웨어 토큰/정책 경계 검사만 수행했으며 브라우저 시각 일치·전체 정책 승인·HIL 완료를 뜻하지 않는다.
