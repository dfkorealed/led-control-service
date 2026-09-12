# Gateway Release, Rollback, Backup and Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Gateway appliance의 provenance/SBOM bundle, 검증된 원자 배포·rollback, 암호화 상태 backup/restore drill을 구현한다.

**Architecture:** 저장소 정책과 실제 image inventory로 immutable release directory를 만들고 checksum closure로 검증한다. Pi에서는 release manager가 staged bundle과 기존 site/identity 상태를 분리한 채 activation journal과 `current`/`previous` pointer를 관리하며, encrypted state tool은 live swap 전에 disposable staging을 완전히 검증한다.

**Tech Stack:** Bash, Node.js 22 ESM, Docker Buildx/Compose, OpenSSL CMS, SPDX 2.3 JSON, node:test

**Spec:** `docs/superpowers/specs/2026-09-12-gateway-release-backup-recovery-design.md`

## Global Constraints

- 작업 범위는 `/Users/kim-jh/Documents/led-control-service/.worktrees/p0p1-platform-gateway-release`, branch `codex/p0p1-platform-gateway-release`로 제한한다.
- main/다른 worktree, 사용자 DB, 운영 broker, 실제 Raspberry Pi/ESP32-H2, 운영 signing/backup key를 변경하거나 사용하지 않는다.
- 신규 production 동작은 실패 테스트를 먼저 실행하고 예상 원인으로 RED임을 확인한 뒤 구현한다.
- release bundle에는 site `.env.appliance`, certificate private key, plaintext backup이나 secret 내용이 들어가지 않는다.
- identity를 포함한 백업은 OpenSSL CMS recipient encryption 뒤에만 최종 artifact로 남기며 plaintext staging은 성공/실패 모두 제거한다.
- production 기본 platform은 `linux/arm64`; CI host-platform override는 manifest에 test-only로 표시하고 production activation이 거부한다.
- 실제 activation/restore 전에 checksum, schema/policy, path/type, permission, identity generation containment와 Docker/Compose preflight가 모두 통과해야 한다.
- 관련 Gateway/runbook/agent/project-status/lesson 문서를 같은 작업에서 갱신하고 자동 검증과 HIL 한계를 분리한다.

---

### Task 1: Immutable release bundle, provenance, SPDX SBOM and checksum closure

**Files:**
- Create: `apps/gateway/release-policy.json`
- Create: `scripts/gateway-release-bundle.mjs`
- Create: `scripts/gateway-release-bundle.test.mjs`
- Modify: `scripts/gateway-appliance-build.sh`
- Modify: `scripts/gateway-appliance-scripts.test.mjs`
- Modify: `apps/gateway/docker/Dockerfile`
- Modify: `package.json`

**Interfaces:**
- Consumes: clean Git checkout, Gateway package version, `pnpm-lock.yaml`, image archive/config digest, OS/Node inventory.
- Produces: `node scripts/gateway-release-bundle.mjs create|verify ...`, schema `led-control-gateway-release/v1`, immutable release directory consumed by Task 2.

- [x] **Step 1: Write failing behavior tests**

```js
test("create emits a closed checksum set and SPDX packages bound to the full commit", async () => {
  const bundle = await createFixtureBundle();
  assert.equal(bundle.manifest.gitCommit, "a".repeat(40));
  assert.equal(bundle.sbom.spdxVersion, "SPDX-2.3");
  assert.deepEqual(bundle.checksumPaths, bundle.regularFilesWithoutChecksum);
});

test("verify rejects extra files, tampering, unsafe paths, secret material and test-only activation", async () => {
  await assert.rejects(() => verifyMutatedBundle(), /release bundle verification failed/);
});
```

- [x] **Step 2: Run RED** — `node --test scripts/gateway-release-bundle.test.mjs scripts/gateway-appliance-scripts.test.mjs`; missing CLI/policy와 incomplete artifact assertions가 실패해야 한다.
- [x] **Step 3: Implement minimal builder/verifier** — strict JSON, canonical sorted output, SHA-256 closure, SPDX relationships, secret/path/type rejection, OCI version/revision/source/firmware labels를 구현한다.
- [x] **Step 4: Run GREEN** — 위 Node tests와 `pnpm --filter @led-control/gateway test:contracts`를 통과한다.
- [x] **Step 5: Commit** — `git commit -m "feat(gateway): produce verifiable release bundles"`.

### Task 2: Staged activation, health-gated pointer switch and rollback

**Files:**
- Create: `scripts/gateway-appliance-release.sh`
- Create: `scripts/gateway-appliance-release.test.mjs`
- Modify: `scripts/gateway-appliance-deploy.sh`
- Modify: `scripts/gateway-appliance-scripts.test.mjs`
- Modify: `package.json`

**Interfaces:**
- Consumes: Task 1 verified release directory and `release-manifest.json`/`appliance.env`.
- Produces: `gateway-appliance-release.sh verify|activate|rollback`, `releases/<releaseId>`, atomic `current`/`previous`, recoverable activation journal.

- [x] **Step 1: Write failing lifecycle tests with command shims**

```js
test("activate changes current only after bounded healthy and preserves previous", async () => {
  const result = await runRelease("activate", healthyDocker);
  assert.equal(await currentRelease(result.root), "release-b");
  assert.equal(await previousRelease(result.root), "release-a");
});

test("unhealthy activation restores env, pointer and previous container", async () => {
  const result = await runRelease("activate", unhealthyCandidate);
  assert.equal(result.status, 1);
  assert.equal(await currentRelease(result.root), "release-a");
});
```

- [x] **Step 2: Run RED** — `node --test scripts/gateway-appliance-release.test.mjs scripts/gateway-appliance-scripts.test.mjs`; missing manager와 non-atomic deploy behavior가 실패해야 한다.
- [x] **Step 3: Implement lifecycle** — `flock`, same-filesystem staging, temp+fsync+rename env writes, temp symlink+rename pointers와 exact release IDs를 사용하고 오류 시 journal로 이전 verified release를 복원한다.
- [x] **Step 4: Run GREEN** — release/bundle/appliance script tests를 함께 통과한다.
- [x] **Step 5: Commit** — `git commit -m "feat(gateway): activate and roll back verified releases"`.

### Task 3: Encrypted state backup, transactional restore and disposable drill

**Files:**
- Create: `scripts/gateway-appliance-state.sh`
- Create: `scripts/gateway-appliance-state.test.mjs`
- Modify: `apps/gateway/docker/compose-contract.test.mjs`
- Modify: `package.json`

**Interfaces:**
- Consumes: `GATEWAY_DATA_DIR/{gateway,mesh,identity,factory-trust}`, current release ID, OpenSSL CMS recipient certificate/private key.
- Produces: encrypted backup plus outer manifest, `verify`, rollback-safe `restore`, non-mutating `drill`.

- [ ] **Step 1: Write failing real OpenSSL/tar behavior tests**

```js
test("backup leaves only ciphertext and restores generations, modes and outbox pairs in drill", async () => {
  const result = await backupFixtureWithEphemeralRecipient();
  assert.equal(result.plaintextArchives.length, 0);
  await runState("drill", result.backup, result.recipient);
});

test("restore rejects traversal, external symlink, tampering and rolls back a partial swap", async () => {
  await assert.rejects(() => restoreMaliciousFixture(), /state backup verification failed/);
  assert.deepEqual(await snapshotLiveData(), originalSnapshot);
});
```

- [ ] **Step 2: Run RED** — `node --test scripts/gateway-appliance-state.test.mjs`; missing state CLI가 live mutation 전에 실패해야 한다.
- [ ] **Step 3: Implement backup/restore** — 상세 manifest를 암호문 내부에 생성하고 모든 archive entry와 extracted type/mode/hash/symlink를 검증한다. Live restore는 네 directory를 모두 rollback 가능하게 교체하고 실패 시 전부 복원한다.
- [ ] **Step 4: Run GREEN** — state tests와 Gateway contract suite를 통과한다.
- [ ] **Step 5: Commit** — `git commit -m "feat(gateway): encrypt and restore appliance state"`.

### Task 4: Protected CI integration, runbook and final software evidence

**Files:**
- Modify: `scripts/ci-production-audit.sh`
- Modify: `scripts/ci-workflows.test.mjs`
- Modify: `.github/workflows/ci.yml`
- Modify: `apps/gateway/README.md`
- Modify: `docs/runbooks/raspberry-pi-gateway-appliance.md`
- Modify: `docs/agent-operations.md`
- Modify: `docs/project-status.md`
- Modify: `docs/lesson_leared.md`
- Modify: `docs/superpowers/plans/2026-09-12-gateway-release-backup-recovery.md`

**Interfaces:**
- Consumes: Tasks 1–3 commands and their deterministic disposable fixtures.
- Produces: non-skippable CI release gate, operator procedure, final evidence and explicit operational/HIL limits.

- [ ] **Step 1: Write failing CI contract**

```js
test("production audit verifies a built release bundle and encrypted restore drill", async () => {
  assertProtectedStep(workflow, "Gateway release artifact and restore drill");
  assert.match(productionAudit, /gateway:release:ci/);
});
```

- [ ] **Step 2: Run RED** — `node --test scripts/ci-workflows.test.mjs`; release artifact/restore gate 부재로 실패해야 한다.
- [ ] **Step 3: Wire CI and docs** — contract tests, host-platform test-only image/bundle smoke, verify, encrypted drill을 한 command로 연결하고 build→approve→backup→activate→health→rollback/restore 절차와 한계를 기록한다.
- [ ] **Step 4: Verify increasing scope**

```bash
pnpm workspace:prepare
node --test scripts/gateway-release-bundle.test.mjs scripts/gateway-appliance-release.test.mjs scripts/gateway-appliance-state.test.mjs scripts/gateway-appliance-scripts.test.mjs scripts/ci-workflows.test.mjs
pnpm --filter @led-control/gateway test:contracts
pnpm --filter @led-control/gateway typecheck
pnpm --filter @led-control/gateway test
pnpm --filter @led-control/gateway build
pnpm gateway:release:ci
git diff --check
```

Docker가 없으면 image smoke는 성공으로 가장하지 않고 local limitation을 별도로 기록한다.

- [ ] **Step 5: Commit** — `git commit -m "docs(gateway): gate release and recovery operations"`.
