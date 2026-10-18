# 클린 코드 정책·검사 기반 실행 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 기존 동작을 바꾸지 않고 정책 정본·전체 점검 원장·점진 품질 gate를 실제 개발 흐름에 연결한다.

**Architecture:** 원장은 builtin Node 도구로 검증하고, 코드 진단은 ESLint API, 포맷은 Prettier API를 사용한다. 자체 AST linter나 범용 품질 프레임워크를 만들지 않는다. 전체 진단과 기존 debt 비교를 분리한다.

**Tech Stack:** Node22·pnpm9.15.0, ESLint/typescript-eslint·React Hooks plugin·Prettier, 기존 TypeScript/CI.

**Spec:** [설계](../specs/2026-10-17-service-clean-code-design.md), [총괄 계획](2026-10-17-service-clean-code.md).

## Global Constraints

총괄의 Global Constraints와 공통 작업 종료 절차를 모두 적용한다. TS/JS는 2칸·세미콜론·큰따옴표·후행 쉼표 없음·LF·목표100자다. 도구 설치는 계획 승인 후 자기 소유 격리 checkout에서만 한다. 기존 컴파일러/React 버전·UI 정책·root 검증은 제거하지 않는다.

## Review Focus

- 신규/이동 파일·경로 탈출·symlink·보호 파일 → F1 inventory 회귀.
- 완료 표시 뒤 소스 변경/원장 자기 해시 순환 → F1 reconcile·verify 회귀.
- tsconfig 밖 파일과 Mobile의 다른 TS/React → F2 실제 파일별 lint 포함 검사.
- 동일 위반 복제·예외 축소/확대·치명 parser 오류 → F3 진단 비교 회귀.
- quality 실패·signal 중 root lock 해제/consumer 실행 → F3 기존 workspace gate 회귀 확장.

## Task F1: 정책 정본과 전수 점검 원장

**Files:** Create `docs/clean-code.md`, `docs/quality/clean-code-review.json`, `scripts/clean-code-inventory.mjs`, `scripts/clean-code-inventory.test.mjs`. Modify `README.md`, `AGENTS.md`, `docs/agent-operations.md`, `package.json`, `docs/project-status.md`의 소유 항목만.

**Interfaces:** `scanInventory(repositoryRoot: string): Promise<InventoryFile[]>`, `reconcileInventory(previous: ReviewLedger, current: InventoryFile[]): ReviewLedger`, `verifyReviewLedger(ledger: ReviewLedger, current: InventoryFile[], options: {complete: boolean}): ReviewIssue[]`. CLI `scan`은 명시 요청 때만 원장을 쓰고, `verify [--complete]`는 무쓰기 검사다.

`ReviewLedger={version:1,baseCommit,entries}`. `InventoryFile={path:string,category:string,owner:string,sourceSha256:string|null,protectedReason?:string}`이며 각 entry는 이에 `reviewStatus/decision/policyIds/reason/evidence/exception/formatStatus`를 더한다. 상태는 `pending|in_progress|reviewed`, 판정은 `null|keep|changed|exception|needs_design`, 형식은 `pending|done|not_applicable`다. evidence는 명령·소스 해시·exitCode·로그 경로와 실제 counts를 기록한다. exception은 담당·근거·재검토 조건을 요구한다. `ReviewIssue={code:string,path:string}`의 코드는 `unreviewed|stale_source|missing_entry|duplicate_entry|orphaned_entry|invalid_path|invalid_exception|needs_design`으로 고정한다.

- [ ] **격리/기준선:** 실행 시 `using-git-worktrees` 절차로 별도 checkout을 만들고 승인 기준 HEAD·dirty·보호 파일 해시를 기록한다. 실제 env를 복사/source하지 않고 운영 연결 변수·토큰을 상속하지 않는 환경을 사용한다. Node22/pnpm9.15.0 확인→해당 checkout의 `pnpm install --frozen-lockfile`→`pnpm --filter @led-control/api prisma:generate`를 수행한다. PG16 도구를 확인한 뒤 기존 root lint→typecheck→test→build를 순차 실행해 원 실패·skip·경고를 보존한다. 전역 OS 도구/다른 checkout을 수정하지 않으며 환경 미준비는 실행 불가로 남긴다.
- [ ] **RED:** 임시 자기 소유 Git fixture에 신규 TS/TSX·CSS·HTML·Prisma·SQL·YAML·C/H·SH·설정·문서와 보호/생성 파일을 만든다. `verifyReviewLedger(reconcileInventory(empty, files), files, {complete:true})`에 `unreviewed`가 있고, `reviewed` 뒤 내용 변경에는 `stale_source`가 있으며, 누락/중복/탈출 경로는 거부한다. symlink와 실제 env/key는 본문을 읽지 않는지 spy로 확인한다.
- [ ] **RED 실행:** `node --test scripts/clean-code-inventory.test.mjs` → 함수/모듈 부재 또는 위 단언 실패. 기존 성공을 RED로 오기하지 않는다.
- [ ] **구현:** Git의 tracked+비ignored 신규 파일을 수집해 설계3절의 전 범위를 분류한다. 파일 이름으로만 검토 완료를 만들지 않는다. 같은 hash의 기존 검토만 보존하고 변경·신규는 pending으로 돌린다. 삭제된 entry는 자동 소거하지 않고 orphaned로 검출해 실제 삭제·동적 소비 검토 후 소스/원장의 같은 diff와 커밋 근거로 제거한다. 원장/진단 JSON은 생성 메타데이터로 자기 해시 대상에서 제외하며 스키마/검사기 회귀로 검토한다. 보호 파일은 hash 대신 null과 제외 이유를 기록한다.
- [ ] **정책 연결:** CC-01~10과 정상/예외 예시를 `docs/clean-code.md`에 옮기고 README/AGENTS/운영 기준은 링크만 둔다. `quality:inventory`, `quality:coverage`, `quality:complete`를 각각 scan, verify, verify --complete에 연결한다. `needs_design`, 미검토, stale·누락은 complete 실패다.
- [ ] **GREEN/기록:** 위 Node 회귀, `pnpm quality:inventory`, `pnpm quality:coverage` → exit0; 초기 `pnpm quality:complete` → 미검토 수를 출력하고 exit1이 정상이다. 제품·테스트·설정·문서·보호 분모를 별도로 기록한다. 공통 작업 종료 절차로 `feat(tooling): track clean-code review coverage` 커밋.

## Task F2: ESLint·포맷 설정과 실제 적용 범위

**Files:** Create `eslint.config.mjs`, `.prettierrc.json`, `.prettierignore`, `scripts/clean-code-config.test.mjs`, 각 `apps/{api,web,mobile,gateway}/tsconfig.eslint.json`, `packages/{shared,automation-engine}/tsconfig.eslint.json`. Modify `package.json`, `pnpm-lock.yaml`, `docs/clean-code.md`.

**Interfaces:** root flat config는 package별 typed TS/TSX, Node JS/MJS/CJS, Web/Mobile Hooks를 분리한다. 각 lint tsconfig는 해당 기존 tsconfig를 extends하고 `noEmit:true`, `include:["**/*.ts","**/*.tsx"]`, `exclude:["node_modules","dist","build","generated"]`로 기존 테스트 제외를 재정의한다. package별 명시 parser project로 선택해 테스트·e2e·gateway scripts도 포함한다. 해당 project 밖 TS는 정상으로 건너뛰지 않고 적용 누락을 실패시킨다. 런타임/build tsconfig는 바꾸지 않는다.

- [ ] **RED:** Node 회귀에서 실제 ESLint `calculateConfigForFile`/`lintFiles`로 각 package src/test, Web e2e, Gateway scripts, root script 표본의 적용을 확인한다. 명시 any·미사용 선언·놓친 Promise·Hooks 위반은 검출, 정상/이유 있는 empty catch는 허용, 생성물은 명시 제외, fatal parser 오류는 예외로 숨길 수 없어야 한다. Prettier 결과는 2칸·`;`·큰따옴표·후행 쉼표 없음·LF·목표100자와 재포맷 idempotence를 단언한다.
- [ ] **도구 선택:** Node22 및 현재 Web/API/Shared의 TS와 Mobile의 TS6/React19까지 engines·peer 호환을 공식 metadata로 확인한다. `eslint`, `@eslint/js`, `typescript-eslint`, `eslint-plugin-react-hooks`, `prettier`의 선택 exact 버전/근거를 정책 도구 표에 기록한 뒤 그 `name@exact` 다섯 값만 root devDependency로 설치한다. unrelated runtime dependency/compiler 업그레이드는 금지한다.
- [ ] **RED 실행:** `node --test scripts/clean-code-config.test.mjs` → 설정 부재/누락/잘못된 옵션으로 실패 확인. 호환되지 않는 parser를 전체 ignore로 통과시키지 않는다.
- [ ] **최소 설정:** 핵심 규칙은 `@typescript-eslint/no-unused-vars`, `no-explicit-any`, `no-non-null-assertion`, typed `no-floating-promises`·`no-misused-promises`, `no-unreachable`, `no-dupe-else-if`, `no-empty`, `react-hooks/rules-of-hooks`·`exhaustive-deps`다. JSX/Node globals는 실제 환경별로 지정하고 포맷 규칙은 ESLint에 중복 구현하지 않는다. 의도적 방치는 국소 주석/예외로 구분하며 Hooks 자동 수정은 하지 않는다.
- [ ] **GREEN/범위:** 같은 회귀 → PASS, 모든 TS/JS inventory 파일에 적용된 config 또는 이유 있는 보호 분류가 있는지 대조한다. Mobile 자체 typecheck는 기존 TS6로 별도 확인하며 루트 TS로 대체하지 않는다. Prettier는 C/shell/기존 SQL migration·바이너리·private 자료에 적용하지 않는다. 공통 종료 절차로 `chore(tooling): define clean-code lint and format rules` 커밋. 이 단계에서 기존 제품 전면 fix/포맷은 하지 않는다.

## Task F3: 기존 debt와 새 위반 구분·CI 통합

**Files:** Create `scripts/clean-code-quality.mjs`, `scripts/clean-code-quality.test.mjs`, `docs/quality/clean-code-baseline.json`. Modify `package.json`, `scripts/workspace-gate.mjs`, `scripts/workspace-gate.test.mjs`, `.github/workflows/ci.yml`, `scripts/ci-workflows.test.mjs`, `docs/clean-code.md`.

**Interfaces:** `compareDiagnostics(current: Diagnostic[], baseline: DiagnosticBaseline): QualityIssue[]`, `checkFormatting(root: string, ledger: ReviewLedger): Promise<FormatIssue[]>`. `Diagnostic={path,ruleId,severity,messageId,contextHash}`이며 baseline은 `version:1/baseCommit/toolVersions/configDigest/entries`와 동일 fingerprint의 **개수**·근거/담당/재검토 조건을 보관한다. contextHash는 진단 구간과 앞뒤 한 줄의 hash이며 정규화는 CRLF→LF·경로 구분자만 허용한다. 문자열·숫자·공백 본문을 축약하지 않는다. 비교 key는 다섯 필드 전부다. `QualityIssue={code:string,diagnostic?:Diagnostic}`, `FormatIssue={path:string,reason:string}`이며 normal check에는 baseline 쓰기 옵션이 없다.

- [ ] **RED:** 실제 정적 진단 fixture에서 기존1개는 허용해도 같은 위반2개는 새 위반1개로 거부하고, 다른 path/rule/context는 거부한다. fatal parser/config 오류는 baseline 불가다. 해결돼 남은 stale 항목·이유 없는 예외도 검출한다. check 전후 원장 byte 동일, reviewed/새 파일 형식 위반 거부, 미전환 파일은 pending에 남음을 단언한다.
- [ ] **RED 실행:** `node --test scripts/clean-code-quality.test.mjs scripts/workspace-gate.test.mjs scripts/ci-workflows.test.mjs` → 새 gate/비교/CI contract 부재로 실패 확인.
- [ ] **구현/초기 진단:** ESLint/Prettier API 결과를 소비하고 새 AST 검사기를 만들지 않는다. `quality:scan`은 전체 원 진단/수치를 출력하며 위반 시 nonzero다. 최초 baseline은 고정 소스의 원 진단을 검토한 한 번의 명시 기록으로만 생성·커밋하고 broad ignore로 대체하지 않는다. `quality:check`는 전체 lint 진단을 baseline과 비교, `format:check`는 reviewed-format 목록과 신규 파일을 검사한다. initial debt와 영구 승인 예외를 구분한다.
- [ ] **gate 연결:** `scripts/workspace-gate.mjs`는 lint일 때만 기존 prepare→`pnpm quality:check`→기존 consumer lint 순서로 추가한다. 동일 lock/signal/drain을 사용하고 quality 실패 시 consumer0·소유 lock 정리를 기존 회귀로 검증한다. `test:unit`에 새 Node 회귀를 각각1회 추가하고 CI quality에 `pnpm format:check`·`pnpm quality:coverage`를 연결한다. 기존 root lint/typecheck/test/build와 후속 jobs는 유지한다.
- [ ] **GREEN/통합:** 위 회귀 PASS, `pnpm lint`, `pnpm format:check`, `pnpm quality:coverage` → 새 실패0. 실제 raw debt가 남은 `quality:scan`은 nonzero와 건수를 보존한다. 새 violation fixture 추가 시 gate가 실패하는 통합 회귀를 확인한다. 공통 종료 절차로 `feat(ci): prevent new clean-code violations` 커밋 후 기반 독립 검토를 받는다.
