# 메인 개발 브랜치·기본 폴더 정렬 실행 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 기존 기능과 최근 인증 보완을 보존하며 기본 폴더에서 `codex/mvp1-cloud-web`을 사용한다.

**Architecture:** 기존 격리 통합 checkout에서 두 입력을 병합·검증한 뒤 승인된 후보로 메인을 fast-forward한다. 이전 메인 checkout은 삭제하지 않고 입력 HEAD의 detached 상태로 보존하고, 기본 폴더를 메인으로 전환한다. 기능 설계·새 API·DB 변경은 없다.

**Tech Stack:** Git worktree, Node.js 22, pnpm 9.15.0, NestJS, Vite.

**Spec:** 사용자 요청 ‘올바르게 바꿔줘’와 기존 기능 보존 요구. 별도 제품 설계는 추가하지 않는다.

## Global Constraints

- 기본 폴더: `/Users/kim-jh/Documents/led-control-service`.
- 메인 입력: `5555d8b1fa1f465f8fa1945b11e593e853a06a6f`; 기본 폴더 인증 입력: `6bf0c66442dac48da0d045a2150a7d379a5a47c5`.
- 제품 코드의 수동 수정 없이 두 입력을 보존한다. 예상 충돌 `docs/lesson_leared.md`는 양쪽 기록을 합친다. 예상 밖 코드 충돌은 총괄에게 보고한다.
- 기존 tracked/untracked/ignored 작업, 이전 브랜치와 worktree를 삭제하지 않는다. `reset --hard`, 강제 checkout, 강제 push 금지.
- DB 초기화·migration 실행·보존 정리·자격증명 변경·장비 조작·외부 push 금지.
- 로컬 실행은 기존 `.env`와 `DEV_LOCAL_APP_ONLY=1`의 인증 가용성 경계를 유지한다. TLS 검증·인증 guard를 우회하지 않는다. 루트 `dev:local`의 DB migration 부작용은 피한다.

## Review Focus

- 두 입력의 ancestry와 제품 파일 보존: UI/PDF 기능과 인증/IP 변경이 모두 남아야 한다.
- schema/migration: 파일만 보존하고 실제 DB에는 적용하지 않는다.
- checkout: clean 여부와 소유 프로세스를 확인한 뒤 전환한다.
- runtime: Web 5173/API 4000은 기본 폴더에서 실행되어야 한다.
- 로그인 smoke: `auth/me` 401과 잘못된 자격증명 401을 확인하며 실제 계정 로그인 성공·하드웨어 준비 완료로 확대하지 않는다.

### Task 1: 보존 통합 후보 및 검증

**Files:** `docs/lesson_leared.md`, 이 체크리스트, `docs/project-status.md`; 그 밖의 변경은 두 입력의 자동 병합 결과만 허용한다.

**Interfaces:** pinned 두 입력 → 독립 검토 가능한 clean 후보 커밋과 검증 로그.

- [x] 기존 격리 폴더 `.worktrees/atlas-main-ui-merge-20260928`에서 메인 입력 기반 새 후보 브랜치 `codex/main-workspace-alignment-20260929`를 만든다. 기본 폴더와 메인 ref는 아직 바꾸지 않는다.
- [x] 인증 입력을 merge하고 교훈 문서의 양쪽 항목을 보존한다. 제품 파일 자동 병합 결과와 두 입력 대비 변경 범위를 확인한다.
- [x] Node 22/pnpm 9.15.0 frozen install, Prisma generate(클라이언트 생성만), root typecheck와 Web/API build, UI 정책 검사를 실행한다. 개발 resolver·TLS/ingress/MFA 및 PDF 관련 기존 집중 테스트를 실행하고 명령·출력·제외·경고를 보고한다. DB/HIL 테스트는 실행하지 않는다.
- [x] ancestry, migration blob union, 두 입력의 제품 변경 집합이 서로 겹치지 않거나 올바르게 병합됨을 검증한다. 문서 diff check 후 후보 commit과 `.local/main-workspace-alignment-report.md`로 보고한다. 새 기능이 없으므로 새 RED→GREEN 제품 수정은 하지 않는다.
- [x] 독립 읽기 전용 리뷰에서 보존·범위·검증 근거를 확인한다.

### Task 2: 기본 폴더 전환 및 로컬 확인

**Interfaces:** 검토된 후보와 clean 소유 상태 → 기본 폴더 메인 checkout·로컬 URL.

- [ ] 총괄 승인 이후에만 메인을 후보로 fast-forward한다. `bio-codec-comments`는 기존 `5555d8b1`에서 detached로 남기고 기본 폴더를 `codex/mvp1-cloud-web`로 switch한다. 이전 clean-base ref `6bf0c664`는 보존한다.
- [ ] 기본 폴더 의존성/클라이언트/빌드 산출물을 현재 후보에 맞추되 DB schema/migration/reset/purge 유지보수는 하지 않는다. 정상 앱 실행의 감사 기록을 비활성화하지 않으며 다른 담당자의 서버를 임의 종료하지 않는다.
- [ ] 기본 폴더의 기존 env resolver를 사용하는 API/Web 4000/5173만 실행한다. 서버 시작 때문에 필요한 migration·PKI 복구가 있으면 실행하지 않고 보고한다.
- [ ] 실제 listener PID/cwd, Web HTTP 200, Web proxy `auth/me` 401·잘못된 로그인 401, TLS 검증 유지와 Git clean/main/입력 ancestry를 확인한다. 실제 비밀번호·계정 초기화는 하지 않는다.
- [ ] 이 계획과 상태판을 실제 결과로 최신화하고 commit한다. 로컬 URL과 보존된 이전 checkout 경로를 보고한다.

## 진행 기록

- 2026-09-29: 읽기 전용 사전 확인에서 기본 폴더·두 기존 checkout은 clean이었다. 5173/4000 listener는 없었다. `merge-tree`는 `docs/lesson_leared.md` 1개 충돌만 보고했다. 인증·통계 담당자에게 변경 보류와 소유 확인을 요청했다.
- 2026-09-29 Task1: `0efbd883`에서 제품 1,935경로와 migration 125파일(잠금 파일 포함, SQL124개)의 원문 불일치 0을 확인했다. 타입 검사·Web/API build exit0, Node119/Web137/API373/Gateway20·UI정책65개 통과, UI위반0/0. API104개 opt-in 제외와 기존 chunk 경고를 유지한다. 전체 suite/Chromium/실DB/HIL 새 검증으로 확대하지 않는다.
- 2026-09-29 독립 리뷰: `/root/main_workspace_preservation_review`가 두 입력/부모/원문 union·Vite TLS proxy·PDF/CSV 인증 경계를 읽기 전용으로 확인해 Critical/Important/Minor 모두0, 로컬 정렬 후보 승인. 실제 체크아웃 전환·서버·계정 로그인·DB/S3/운영DNS/HIL은 별도 확인 범위다.
