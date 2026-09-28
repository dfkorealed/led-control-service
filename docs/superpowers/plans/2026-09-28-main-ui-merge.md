# 기존 UI의 실제 메인 브랜치 통합 실행 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. 총괄은 결과 취합·검토·최종 반영을 맡고 하나의 통합 담당자가 결합된 충돌을 순차 해결한다.

**Goal:** 기존 Atlas·랜딩 UI를 실제 `codex/mvp1-cloud-web`에 병합하면서 최신 PDF 보고서 기능을 보존한다.

**Architecture:** 메인 `f907a580d32069d489396565caca63c3cfa07746`에서 만든 격리 작업공간에서 UI 기준 `e64620aa94a964126e2c09d5285ec55045571d84`을 merge한다. 공통 조상은 `b429f85652f0fbab1910eb0265e99fd0a5cd74fa`다. 검토와 새 통합 회귀가 통과한 뒤 clean 메인 checkout을 fast-forward하고 두 입력의 조상 포함을 확인한다.

**Tech Stack:** Git, Node 22.20.0, pnpm 9.15.0, React, NestJS, Prisma, Vitest/Jest, Playwright.

**Spec:** 이번 사용자의 “기존에 작업했던 UI 변경 작업을 메인 작업 브랜치에 머지” 요청과 아래 보존 조건. 새 제품 기능이나 운영 적용은 요청하지 않았다.

## Global Constraints

- 실제 대상은 `codex/mvp1-cloud-web`이며 clean-base 반영만으로 완료라고 하지 않는다.
- Atlas 메뉴·공통 Shell·인증·로그/명령 이력·DB 시각의 최근 3개월 계약, 기본 OFF 운영 안전 장치를 보존한다.
- 메인의 PDF-only 생성·재생성·다운로드·필터 URL 정규화·의미 기반 PDF/주석 수정·결측 판정·cleanup 원장을 보존한다. XLSX/ExcelJS를 다시 추가하지 않는다.
- 검토된 랜딩 단일 CSS 진입점·공통 컴포넌트·375 의미 토큰 및 기존 콘셉트 URL을 유지한다. 폐기된 CSS/JS/HTML을 충돌 때문에 되살리지 않는다. PDF-only 문구/레이블 변경은 기존 메인 요구이며 새 디자인 변경이 아니다.
- 기존 migration 이름/내용을 변경하거나 DB migration·초기화·운영 서비스·실장비·push를 실행하지 않는다. Prisma Client generate/validate는 코드 검증에 한해 가능하다.
- 기본 checkout의 5173 미리보기와 랜딩 담당자 5178 서버, 미커밋 변경·다른 worktree·맵 WIP를 유지한다.
- 정책 검사·테스트 skip·timeout·baseline·접근성 기준을 완화하지 않는다. 실제 미실행/실패와 환경 제외를 별도로 보고한다.

## Review Focus

- PDF-only API와 Atlas 보고서 UI가 결합해 구 `format` URL·검색·pagination·다운로드를 망가뜨리지 않는가.
- 랜딩 ReportDemo/React 콘셉트에 Excel 선택·표시가 되살아나거나 PDF 다운로드/재생 동작이 사라지지 않는가.
- 삭제/수정 충돌을 해결하며 legacy CSS 중복 진입점·하드코딩 정책 부채를 되살리지 않는가.
- 자동 병합된 Prisma/energy module/API가 retention 계약 또는 기존 PDF worker·cleanup 기능을 잃지 않는가.
- 상태·메뉴·DB 문서가 양쪽 구현/과거 실패를 보존하며 실제 메인 미반영을 완료로 표시하지 않는가.

## Task 1: 격리 통합과 회귀 검증

**Files:**
- Resolve: `apps/web/e2e/statistics-flow.spec.ts`, `apps/web/src/features/landing/field-day/ReportDemo.tsx`, `apps/web/src/features/statistics/reports/{ReportHistoryFilters.tsx,ReportHistoryFilters.test.tsx,StatisticsReportsPage.test.tsx}`.
- Resolve delete/modify: `apps/web/public/concepts/field-day.{css,html,js}`, `apps/web/src/features/landing/field-day.css` (기능을 React/토큰 경로에 보존한 후 삭제 유지).
- Resolve: `docs/database-schema.md`, `docs/menus/{landing,statistics}.md`, `docs/project-status.md`.
- Inspect auto-merge: API energy/Prisma, Web energy API·ReportCreateDialog·StatisticsReportsPage·FeatureOverview·관련 E2E, package/lock 및 운영 문서.

**Interfaces:** 입력은 위 두 고정 SHA이며 결과는 두 SHA를 모두 조상으로 포함하는 검증된 통합 커밋이다. 운영 자원은 사용하지 않는다.

- [x] 담당자는 관련 AGENTS·운영/교훈·메뉴 문서와 양쪽 PDF/랜딩 계획을 읽고, 변경 전 검증 절차 및 기존 메인 정책 부채를 기록한다.
- [x] `git merge --no-ff --no-commit e64620aa94a964126e2c09d5285ec55045571d84` 후 충돌을 의미 단위로 해결했다. `--ours/--theirs`로 전체 파일을 일괄 선택하지 않았다.
- [x] PDF-only 필터/이력 unit·랜딩 PDF replay·API PDF 회귀로 양쪽 계약을 검증했고 replay/날짜 helper의 RED→GREEN을 기록했다. 집중 Web123·API172개 통과, 환경 제외는 별도다.
- [x] Node22.20.0/pnpm9.15.0 frozen install·Prisma generate/validate·root `pnpm test`, `pnpm lint`, `pnpm typecheck`, `pnpm build` 모두 exit0. `.local/main-ui-merge-*.log`에 실패와 성공을 함께 보존했다.
- [x] 관련 mock Chromium97/97을 격리15228 Vite/closed15229 proxy에서 통과했다. 기존 서버/DB는 사용·재시작하지 않았다. 첫96pass/1fail과 proxy/color 경고는 보존한다.
- [x] 통합 커밋 `30fe76fd`, 양쪽 조상 포함·clean·migration 원본 불변을 확인했다. 실제 메인 참조는 아직 변경하지 않았다.
- [ ] 총괄이 검토 패키지를 만들어 독립 요구사항·품질 검토와 최종 통합 검토를 받고 필요한 수정 후 재검토한다.

## Task 2: 총괄의 실제 메인 반영

- [ ] 메인 담당자와 진행 중 작업 여부를 확인하고 실제 target checkout의 clean/HEAD·참조 이동 여부를 재확인한다.
- [ ] 검증된 통합 결과를 메인에 `--ff-only` 반영한다. target이 이동했거나 dirty면 덮어쓰지 않는다.
- [ ] 실제 메인의 양쪽 SHA 포함·통합 tree 일치·clean 상태·fresh 관련 검증을 확인한다. 새 기능 없음 및 원격/운영 미적용 경계를 기록한다.
- [ ] 상태판과 체크리스트를 완료 증거에 맞춰 동시에 갱신하고 정확한 대상 브랜치·커밋을 사용자에게 보고한다.

## 현재 상태

2026-09-28: 격리 작업공간을 만들었다. Native worktree 도구는 앱에 연결된 경로가 Git 저장소가 아니어서 실패했고, 검증된 실제 저장소의 ignored `.worktrees`에 Git fallback으로 생성했다. 실제 메인은 아직 변경하지 않았다. 진행 상태와 과거 실패는 결과 보고 후 갱신한다.

통합 구현과 작업 단위 독립 검토는 완료했다(요구사항·품질 승인, Critical0/Important0). 최종 전체 통합 검토와 실제 target FF는 남아 있다. GET/sites mock 누락·기존 중복 rule-key/색 환경/Nest 실패 주입 로그·876.86kB chunk 경고는 Minor 후속으로 보존하며 최종 검토에서 분류한다. Root143pass/4skip, Shared411, Automation28, Mobile6, Web2583pass/3skip, API2934pass/827skip, Gateway1408, 정책65/65·UI0/0이다. 제외834개를 성공으로 계산하지 않는다. production audit 기존 High2 불일치·운영 적용/HIL은 완료 범위가 아니다.
