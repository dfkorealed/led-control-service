# Release hardening: dependencies, shared build, CI 실행 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to execute this plan task-by-task. 모든 구현은 재현/RED → 최소 수정 → GREEN → 검토 → 커밋 순서를 따른다.

**Goal:** Production dependency 위험을 지원 가능한 최소 버전으로 줄이고, `packages/shared/dist` build/consumer 경쟁을 제거하며, software CI와 명시적 HIL gate를 추가한다.

**Architecture:** 지원 upstream 업그레이드와 제한 override/patch policy, repository-wide workspace gate, leaf consumer script 정리, 순차 GitHub Actions gate를 사용한다.

**Global constraints:** 지정 worktree와 `codex/p0p1-platform-security-ops`만 수정한다. 기존 PKI 커밋을 보존한다. 사용자 DB·운영 서비스·실장비를 변경하지 않고 main에 merge하지 않는다. 임의 timeout/retry로 경쟁을 숨기지 않는다. advisory 예외를 로그에서 숨기지 않는다.

---

## Task 1: production dependency audit와 최소 안전 갱신

**Files:**
- Modify: root/app `package.json`, `pnpm-lock.yaml`
- Create/Modify: production audit policy script와 test
- Modify: `docs/agent-operations.md`, `docs/project-status.md`

- [x] Fresh JSON audit를 package, severity, direct/transitive path, runtime 도달성, patched floor로 정규화하는 실패 테스트를 작성한다.
- [x] React Router, Nest suite, MQTT와 호환 patch dependency를 upstream release로 먼저 갱신한다.
- [x] upstream이 안전 floor를 제공하지 않는 전이에만 package-selector override 또는 repository patch를 적용하고 이유·제거 조건을 기록한다.
- [x] `image-size`처럼 safe release가 없는 항목은 취약 입력을 차단하는 exact regression/patch 없이는 예외 처리하지 않는다.
- [x] `pnpm audit --prod --audit-level=moderate`, package별 scoped test/typecheck/build, Prisma validate를 실행한다.
- [x] 예상하지 못한 production High 0과 남은 명시적 예외를 기록하고 커밋한다.

## Task 2: shared/dist reader-writer 경쟁 제거

**Files:**
- Modify: `package.json`, app/package manifests
- Modify/Create: workspace gate script와 Node regression
- Modify: `packages/shared` build/export regressions
- Modify: `docs/lesson_leared.md`, `docs/agent-operations.md`, `docs/project-status.md`

- [ ] Baseline export를 만든 뒤 writer publish 중 reader가 export를 읽을 때 `ENOENT`/TS2307이 발생하는 deterministic RED를 추가한다.
- [ ] Root gate가 repository owner lock을 잡고 shared → automation 한 번 build 뒤 leaf consumer를 실행하도록 구현한다.
- [ ] Leaf lint/typecheck/test/build의 nested dependency build를 제거하고 outer graph에서 writer가 다시 생기지 않는 contract test를 추가한다.
- [ ] 기존 shared writer/writer, path/symlink, stale owner/ABA 방어를 그대로 통과시킨다.
- [ ] Root lint와 test 동시 실행을 반복해 둘 다 성공하고 exported file absence가 0회임을 확인한다.
- [ ] Shared/API/Web/Gateway/automation scoped 검증과 문서를 갱신하고 커밋한다.

## Task 3: deterministic software CI와 fail-closed HIL workflow

**Files:**
- Create: `.github/workflows/ci.yml`
- Create: `.github/workflows/hil.yml`
- Create/Modify: CI contract test와 root CI scripts
- Modify: `docs/agent-operations.md`, `docs/project-status.md`

- [ ] Workflow contract RED를 작성해 frozen install, lint/typecheck, unit, PostgreSQL/Redis integration, real-backend Playwright, build, production audit 순서와 `mqtt-production-config` 포함을 고정한다.
- [ ] PostgreSQL 16/Redis 7 service healthcheck, full Prisma migration과 env-gated integration 명령을 명시한다.
- [ ] Chromium real-backend journey의 PostgreSQL/Redis/Mosquitto/lsof/OpenSSL prerequisite와 single-worker 실행을 명시한다.
- [ ] HIL은 manual dispatch, exact confirmation, protected environment와 self-hosted `led-hil` runner가 없으면 flash/deploy 전에 실패하게 한다.
- [ ] Workflow contract, YAML/Compose 검증과 가능한 로컬 CI command를 실행한다.
- [ ] 문서를 갱신하고 커밋한다.

## Task 4: 전체 검증과 최종 리뷰

- [ ] Fresh production audit 전후 수치와 advisory별 최종 상태를 문서에 동기화한다.
- [ ] Root `lint`, `typecheck`, `test`, `build`를 fresh 실행하고 concurrent root gate를 반복 검증한다.
- [ ] Disposable PostgreSQL/Redis integration과 deterministic real-backend Chromium 핵심 journey를 실행한다.
- [ ] API/Web/Gateway/Mobile/Shared/automation scoped 결과, Prisma validate와 `git diff --check`를 확인한다.
- [ ] Task별 review와 전체 branch review의 Critical/Important를 모두 해소한다.
- [ ] 테스트용 container/process를 정리하고 clean worktree, 최종 SHA, 남은 예외/운영 설정을 보고한다. Main에는 merge하지 않는다.
