# 검증된 Web 디자인 변경 로컬 병합 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 검증된 Web 디자인 변경을 기존 `codex/mvp1-cloud-web`에 병합하고 다른 작업의 커밋·미커밋 변경을 보존한 채 병합 후 전체 Web·PC/모바일을 새로 검증한다.

**Architecture:** 기존 UI worktree에서 대상 branch의 새 커밋을 먼저 통합해 문서 충돌을 해결한다. 대상 checkout에는 확정된 merge 결과를 fast-forward하고, 겹치는 상태판의 미커밋 변경만 경로 한정으로 임시 보관·즉시 재적용한다. 새 제품 기능·운영 작업은 추가하지 않는다.

**Tech Stack:** Git, pnpm9.15.0, TypeScript/Vitest, Playwright Chromium.

**Spec:** [승인된 디자인 설계](../specs/2026-10-15-web-design-system-unification-design.md), [공통 가이드](../../ui-design-system.md), [완료된 구현 계획](2026-10-16-web-design-system-unification.md). 사용자가 2026-10-18 로컬 병합·다른 작업 보존·병합 후 전체 테스트와 PC/모바일 검증을 명시 승인했다.

상태: [x]원변경 snapshot, [x]분리공간 통합, [x]기존branch 반영·미커밋 복원, [x]새 전체 검증 실행, [x]독립 검토·결과 기록, [ ]전체 브라우저 수용 관문. 로컬 병합과 재검증 실행은 완료됐으나 foundation cleanup timeout1이 남아 **전체 통합 검증 승인은 보류**한다.

후속 실행 승인: 사용자가 남은 I1의 원인 조사·수리, 기존 기능/원 단언/타작업 보존, 새 전체 Web·PC/모바일 검증과 최종 메인 clean을 명시 지시했다. Task2는 [ ]인과 재현/RED, [ ]한정 수리/GREEN, [ ]메인 반영/새 전체 검증, [ ]독립 검토/최종 clean이다. 미커밋 상태판13행은 `제어 페이지 담당자`가 자신의 과거 기록이며 현재 편집 중이 아니라고 확인했다. AGENTS84행은 조회한 두 세션 및 Git 이력에서 작성자를 확인하지 못했다. 원문을 백업·대조하고 각각 `f92158ad`/`b7dafc3e`로 보존했으며 삭제·내용 변경 없이 메인 clean을 확인했다.

## Global Constraints

- 시작 source는 `2a473c424cd3bf48d96ba85925270bf5c20e5a25`, branch `codex/web-design-system-unification-20261016`, checkout `.worktrees/web-design-system-unification-20261016`이다. 새 계획·조율 문서만 추가한 source HEAD는 실행 brief에 확정한다.
- 대상은 `/Users/kim-jh/Documents/led-control-service`, branch `codex/mvp1-cloud-web`, 관측 HEAD `625d8cfbc2f4d449e52f896ee50ca3f2a9fb19d9`다. 공통 base24d2d8e4 이후 대상의6커밋/API·다른문서는 모두 보존한다. 현재 실제대상이 바뀌면 재조사 후 진행하며 덮어쓰지 않는다.
- 대상 dirty는 AGENTS.md84줄 추가, docs/project-status.md13줄 추가다. index는 비어 있어야 한다. AGENTS는 원문 SHA 불변·미커밋 유지, 상태판은 UI소유section 밖 원문 및 타 작업 미커밋 내용 불변·미커밋 유지다. 다른 변경이 추가되면 새 snapshot/근거 없이 진행하지 않는다.
- reset/checkout-discard/clean·전체autostash·다른작업commit·stashpop/drop 금지. 상태판 단일 path stash는 원문/patch/HEAD/index/해시 backup과 정확한 OID를 먼저 남기고 즉시 재적용하는 이번 통합의 제한적 보존 수단이다. stash 복구본은 남긴다.
- UI의 section20/grid18/panel20·16/page26·24/section20/card16/hit≥44px, 기존52pxcontrol, map실content588split/editor최소256/선택·배율·dirty·권한·command·paint fence·원보호단언을 유지한다. token738/anchor e841c57b11321a5ae35d15920031020089f06ee2/빈baseline 및 기본config/lock 변경 금지.
- 전체 테스트는 이전 승인과 같은 canonical 전체 Web 및 전체 안전 design-system Chromium, 관련 공개 정적 mode/default/QA 검증이다. monorepo CI·운영 DB/backend/auth·실장비/native/HIL·AWS·서비스 재시작·push/PR/배포는 실행하지 않는다.
- 기존5173/4000/8883 및 다른worktree는 접속·재사용·중단하지 않는다. 새owned15341/15342/5187/15185만 idle확인 후 strict/reusefalse로 사용한다. SW차단·미등록API/외부write/WS/beacon차단 유지, workers1/retry/timeout/skip 불변이다.
- 이전3939/0/3·전체226actual+3의도FAIL·집중53actual+6modeN/A는 과거 증거다. 병합 후 새 실결과를 기록하고 합산한 가상전체PASS를 만들지 않는다. 기존 경고/미실행 한계도 유지한다.
- Task2 추가 승인만 다음 역사적 제약을 대체한다: 미커밋2파일은 원문 보존 커밋으로 정리할 수 있고, 원인 입증에 필요한 테스트 fixture/lifetime 및 회귀 테스트만 한정 수정할 수 있다. Task1의 원증거와 당시 FAIL 판정은 바꾸지 않는다. Task2 시작 제품 기준은 `54e7977d`, 정리 후 메인/재사용 worktree는 `f92158ad`이며 둘 사이 변경은 기존2문서97행 보존뿐이다. 최종 메인은 index/unmerged/미커밋·새 untracked0을 요구한다. ignored 증거/cache/다른worktree는 삭제하지 않는다.

## Review Focus

1. 다른 작업의 dirty2파일이 commit되거나 손실되지 않는가: 원문·의미patch·상태판비소유section 비교와 index 검사를 인계 전후 단언한다.
2. 대상 새6커밋/API와 검증된 Web이 모두 남는가: merge양쪽ancestor 및 API/기타비UI tree=대상, Web tree=승인source를 대조한다.
3. 같은 끝에 추가된 교훈이 사라지는가: lesson충돌은 두 parent의 신규내용을 모두 보존한다. 사전merge-tree는 이 파일만 충돌했다.
4. 원래 동작·모바일/PC가 병합 후 바뀌는가: 전체229 등록/실행·Control/CAD·38소비자inventory·대표320/390/1024/1440 및light/dark PNG를 새로 확인한다.
5. 문서 stage에 타 작업의 dirty가 섞이는가: 상태판은 UI소유patch만 `git apply --cached`로 stage하고 AGENTS는 stage하지 않는다. 최종 unstaged foreign 내용은 snapshot과 비교한다.

## Task 1: 로컬 통합·보존·병합 후 검증

**Files:**
- Merge-only: 승인 source 전체 변경 및 대상6커밋. 예상 conflict `docs/lesson_leared.md`; 자동합성 `docs/menus/{control,settings}.md`, `docs/project-status.md`는 양쪽을 보존한다.
- Modify: `docs/assets/web-design-system-2026-10-16/coverage.md`, `docs/ui-design-system.md` 검증 문단, 실제 최신값 변경이 필요한 영향 메뉴 문서만. 제품/API/DB/장비/정책 코드를 새로 수정하지 않는다.
- Controller: 본계획·기존spec의승인현황 및 상태판 UI소유section. 타 section은 편집·stage하지 않는다.
- Evidence: 이 계획의 ignored SDD workspace, 병합후 실제main의 `.local/web-design-system-integration-20261018` 고유 하위디렉터리. 기존 QA증거/캐시를 삭제하지 않는다.

**Interfaces:** approved source와 target HEAD를 소비해 두 parent를 보존한 merge commit 및 대상branch의 새 HEAD를 만든다. 제품 계약은 새로 만들지 않는다. 전체 Web/안전browser의 원 reporter·manifest·보존 증거를 독립 reviewer에게 전달한다.

- [x] **Step 1: 보존 snapshot.** branch/HEAD/index/dirty/unmerged·merge진행상태와 소유 heavy/port를 확인한다. dirty2파일 원문·binarydiff·SHA/mtime·상태판 비소유region을 백업한다. 실제 다른변경 추가/target HEAD 변경은 overwrite하지 않고 재판정한다.
- [x] **Step 2: 분리공간 통합.** 기존 UI worktree에서 확정target HEAD를 `merge.autoStash=false`, `--no-ff --no-commit`으로 병합한다. lesson 충돌은 두 신규 블록을 모두 유지하고 staged tree에서Web=승인source/API·타작업=target을 증명한 뒤 merge commit한다. 예상밖 기능 충돌은 추측수리하지 않고 총괄에 보고한다.
- [x] **Step 3: 대상 반영.** snapshot·대상HEAD·index를 재확인한다. 상태판 path만 stash push하고 OID/경로를 보존한다. 확정merge SHA로 target을 ff-only한 즉시 exact stash OID를 apply한다. AGENTS불변, foreign상태판원문·dirtyhunk불변, indexempty, 두parentancestor를 확인한다. 충돌/외부변경은 원본을 버리거나 덮지 않는다.
- [x] **Step 4: 실제 대상에서 검증.** workspace:prepare 후 source/검증runner manifest를 고정하고 typecheck·확장E2Etype5root·build·UI정책·ui:check·landing/public계약을 실행한다. 전체 `pnpm --filter @led-control/web exec playwright test --config=playwright.design-system.config.ts`는 grep없이229전체를 실행해 actualPASS와3안전차단의도FAIL을 분리한다. 정적landing/public의default15185/5187와QA15342·landing/service mode도 새owned서버에서 실행한다. 대표mobile/PC PNG를 직접 확인하고 actualfocus/hit/overflow/paint/API보호 결과를 저장한다.
- [x] **Step 5: 마지막 단독 전체Web.** 모든ownedheavy/listener 종료와 source동결을 확인하고 actual target에서 `pnpm --filter @led-control/web test`를 마지막 단독1회 실행한다. 전후source manifest/targetHEAD/dirty2보존을 확인한다. 새 실패는 원인·원출력을 남기고 skip/기대값/설정 완화나 untilgreen 반복을 하지 않는다.
- [x] **Step 6: 문서·소유commit·독립검토.** coverage/guide와필요메뉴만 새결과로 맞추고 소유문서만commit한다. 총괄은 본계획과상태판UI부분을맞추되 status전체gitadd로 foreign13줄을 섞지 않는다. 원문hunk를따로stage하거나 HEAD에서UI부분만합성한indexpatch를사용하고 cached diff를확인한다. 최종dirty2의원변경/AGENTS/미승인stage0과source동일성을확인한다. reviewer는 통합의spec/quality·보존·새QA를독립평가한다.

## 실행 결과와 미해결 수용 관문

- 로컬 merge는 `d87a190119d61d8b78192c654c5d1a0096573c2f`, 새 QA 문서 기록은 `08c5a8f2aedc9510bbe03e95930ce1441a6f7e6e`다. 양 parent·승인 Web tree·대상 API/기타 변경, 원 AGENTS84행·상태판 foreign13행은 독립 대조로 보존을 확인했다. 상태판은 HEAD에 UI소유 section만 합성해 index에 넣고 외부 section은 stage하지 않는다. 최종 마감도 문서만 변경한다.
- 실제 main에서 새 canonical Web은 **3,939PASS/0FAIL/기존3SKIP**(266파일·47.05초), 전체 Chromium은 **229실행/225actualPASS/의도된차단FAIL3/예상밖cleanup timeout1**, skip/flaky0이다. 타입/E2E5root·build·정책79/ui위반0·landing6/public3계약 및 정적기본/QA6회차38actualPASS+기존modeSKIP6은 별도 결과다. 대표 PC/mobile PNG를 직접 확인했고907source·runner 전후 동일, ownedheavy0/QA4포트idle이다.
- 독립 리뷰는 **Spec PARTIAL / Quality WITH FIXES / readiness NO, C0/I1/M0**이다. I1(`design-system-fixture.ts:166`)은 화면 단언·page.close·unroute 뒤 메모리 서버 정리를 기다리다 timeout한 실패이며 정확한 연결 소유 원인은 미확정이다. 한 번의 계측 진단은 bare-title 선택 오류로 실행0이었고 통과·원인 증거가 아니다. 원 전체 RED·trace·진단 오류를 보존했다. 별도 frozen continuation으로 독립 나머지 gate와 마지막 Web1회만 실행했고 원 runner/timeout/retry/skip/단언/제품 소스는 변경하지 않았다.
- **수용 관문: [ ] I1 원인 입증·한정 수리와 새 전체 브라우저 검증.** 이 계획의 merge·재검증 실행 체크는 이 관문의 성공·결함 면제·전체 GREEN을 뜻하지 않는다. 이번 인계는 실패를 명시한 실행 결과이며 추측 수리/자동 rollback/push/배포는 하지 않는다. 후속 수리는 원 실패와 기존 단언·안전 경계를 유지하는 별도 범위로 다룬다.
- 상세 최신 결과와 한계는 [coverage](../../assets/web-design-system-2026-10-16/coverage.md)의 ‘기존 브랜치 통합 후 새 검증’을 따른다. 원증거는 actualmain `.local/web-design-system-integration-20261018/qa-3zqOCJ/`, 통합 보고서·독립 리뷰·최종 보존 기록은 source worktree의 `.superpowers/sdd/2026-10-18-web-design-system-integration/`에 남긴다. monorepo/backend/native/실장비/HIL 검증은 아니다.

## Task 2: 테스트 서버 종료 수명 수리·새 검증·최종 clean

**Files:**
- Modify: `apps/web/e2e/support/design-system-fixture.ts`, `apps/web/src/test/design-memory-lifetime.ts`, `apps/web/src/test/design-memory-lifetime.test.ts`의 test-only 소유 HTTP 서버 종료. 실제 UI/domain/API/공유패키지/기본config/lock/정책/토큰은 수정하지 않는다.
- Modify: `docs/lesson_leared.md`, `docs/assets/web-design-system-2026-10-16/coverage.md`, `docs/ui-design-system.md`, 기존 검증 경고가 있는8메뉴의 검증 문단만 실제 새 결과로 갱신한다. 기능은 바뀌지 않는다.
- Controller: 본계획/spec/상태판 UI부분·기존2파일 보존/최종 Git audit. 담당 구현자는 임의로 AGENTS/상태판/계획을 stage하거나 수정하지 않는다.
- Evidence: 이 계획 workspace의 `task-2-report.md`와 실제 main `.local/web-test-server-cleanup-20261018/` 고유 하위경로. Task1/다른계획/이전 QA 원본은 읽기 전용이다.

**Interfaces:** `runFoundationLifetime`의 기존3/4인자 호출·setup/body/page→server·원 Error identity/AggregateError 순서를 유지한다. 같은 test lifetime module의 `closeOwnedHttpServer(server: Pick<import("node:http").Server, "close" | "closeAllConnections">): Promise<void>`를 actual fixture와 실제 TCP 회귀가 함께 소비한다. 소유 서버만 대상으로 하며 다른 context/server는 닫지 않는다.

- [ ] **Step 1: 인과 probe와 선택 확인.** `cleanup-diagnosis.md`의 관측·가설을 읽고 새 raw 위치/runtime/소유 idle을 고정한다. 기존 functional case를 `--list --reporter=json`으로 정확1개/file/title/project까지 확인한 동일 selector로만 단일 계측 실행한다. 무데이터 연결인지 request/response가 진행 중인지 socket별 accept/request수/bytes/close와 server.close 시작·완료를 실제로 기록한다. body/header/cookie/auth/실제서비스 기록은 금지한다. 재현되지 않아도 원 실패를 없애거나 until-green 반복하지 않는다.
- [ ] **Step 2: 실제 소유 TCP RED.** 실제 loopback node:http 서버에 node:net으로 연결하고 HTTP bytes를 보내지 않은 채 기존 종료 경로가 완료되지 않음을 먼저 확인한다. 회귀는 production-fixture의 실제 helper를 호출해 소유 socket 종료·server.listening=false·getConnections0을 단언하며, 별도 서버 연결은 유지되어야 한다. ordinary keepalive도 포함하고 실패/정리 finally는 자기 자원만 종료한다. 기존5개 lifetime test와 원 foundation/coverage/CAD/control expect는 전부 보존한다. RED의 정확 원인과 원출력을 저장한 뒤 구현한다.
- [ ] **Step 3: 최소 수리·집중 GREEN.** 위 helper는 증명된 소유권 결함만 수리한다. close callback을 등록해 accept를 멈춘 뒤 소유 연결 종료를 요청하고 callback 완료를 기다린다. 다른 서버/context 종료·전역 monkeypatch·지연sleep·timeout/retry/skip/안전경계/단언 완화는 수리가 아니다. 기존 오류 보존과 양 cleanup 시도·sentinel 검사를 유지하고 예외 이유는 주석으로 명시한다. 실제 TCP 회귀·기존 lifetime5·같은 foundation case/전체foundation을 실행해 단언 동등성과 종료 완료를 확인하고 소유 파일만 커밋한다.
- [ ] **Step 4: 메인 반영과 새 전체 검증.** 메인 expected HEAD/clean/index/타작업 보존을 확인한 뒤 확정 source를 ff-only한다. 그 실제 메인에서 workspace:prepare 후 source/runner를 freeze하고 Web/E2E5root type·build·정책79/ui0·공개계약6+3, 전체 safe design-system Chromium을 grep없이 실행한다. 기존229에 새 browser test를 만들지 않는 경우 actual226PASS+의도된차단FAIL3·unexpected/skip/flaky0을 기대한다. 정적랜딩/public의 default15185/5187 및QA15342·landing/service 모드도 새로 실행하고 PC/mobile4폭·지원theme의 원동작과 대표PNG를 직접 확인한다. 소유heavy/4포트 종료 뒤 마지막 단독 canonical `pnpm --filter @led-control/web test`를 한 번 실행하고 source/runner 전후 동일성을 확인한다. 예상밖 실패는 원문 유지·원인 조사하며 설정을 완화하지 않는다.
- [ ] **Step 5: 근거·독립 검토·clean.** 원본 실패와 새 회차를 분리해 위 소유 검증 문서만 커밋한다. 원 AGENTS bytes/hash, 타작업13행/상태판UI외 원문, 보존 커밋과 기존 target/API/Gateway/Mobile/packages trees, 새 source diff의 test-only 범위를 대조한다. fresh 독립 reviewer가 원 I1·원 단언·TCP RED/GREEN·새 whole raw·소유권/side-effect/문서를 검토한 뒤 총괄이 정확 승인 결과만 기록한다. 메인 `git status --porcelain=v1 --untracked-files=all`/cached/unmerged0을 최종 확인하며, 새 외부 변경은 버리거나 임의 stage하지 않는다. push/PR/운영/장비 작업은 없다.

Task2 자체 검토: Step1→2는 관측과 단일 가설을 실제 TCP 계약 회귀로 연결하고, Step2→3은 동일 helper의 RED→GREEN, Step3→4는 fix commit/같은 단언을 실제main freeze로 연결한다. Step4→5는 새 raw/manifest·clean 메인/원문 backup을 독립 검토와 최종 audit가 소비한다. Task1의 실패 기록은 역사로 남기며 새 통과 전에는 I1이나 전체 수용 체크를 닫지 않는다. 단일 수리·정리·새 검증을 한 인계 단위로 묶어 하나의 fresh 최종 reviewer가 spec/quality/I1/whole 후속 gate를 함께 검토한다.

## 계획 자체 검토

| 연결 | 생산 → 소비 | 판정 |
| --- | --- | --- |
| Step1→2/3 | target·dirtysnapshot → merge/ff/restore | 실제HEAD·hash 재확인 없이는 진행하지 않음 |
| Step2→3 | 두parent 보존 candidateSHA → ff-only | main의dirty를 건드리기 전에 문서충돌 해결 |
| Step3→4/5 | 실제target merge상태 → 새QA | 이전source결과로 대체하지 않음 |
| Step4→5 | 동일manifest·ownedidle → 단독full | test이전 source고정/전후검사 |
| Step5→6 | 새raw결과·foreignhunk → 문서stage | 상태판 전체stage 금지, foreign미커밋 유지 |
| Task1 자체 | 순차로컬merge+QA, 실제장비0 | 새기능이없어 신규TDD대신 기존전체회귀·보존단언. 한fresh최종reviewer가 단일integration의spec+quality+whole-integration gate를 함께 평가 |

진행 승인과 실행 방식은 사용자 요청·기존 subagent 역할 규칙으로 확정되어 추가선택질문 없이 실행한다. 원 구현계획을 재실행하거나 새리브랜딩·배포로 확대하지 않는다.
