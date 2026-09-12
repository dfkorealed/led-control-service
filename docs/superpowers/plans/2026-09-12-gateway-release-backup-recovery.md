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

- [x] **Step 1: Write failing real OpenSSL/tar behavior tests**

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

- [x] **Step 2: Run RED** — `node --test scripts/gateway-appliance-state.test.mjs`; missing state CLI가 live mutation 전에 실패해야 한다.
- [x] **Step 3: Implement backup/restore** — 상세 manifest를 암호문 내부에 생성하고 모든 archive entry와 extracted type/mode/hash/symlink를 검증한다. Live restore는 네 directory를 모두 rollback 가능하게 교체하고 실패 시 전부 복원한다.
- [x] **Step 4: Run GREEN** — state tests와 Gateway contract suite를 통과한다.
- [x] **Step 5: Commit** — `git commit -m "feat(gateway): encrypt and restore appliance state"`.

### Task 4: Protected CI integration, runbook and final software evidence

**Files:**
- Create: `scripts/gateway-release-ci.mjs`
- Create: `scripts/gateway-release-ci.test.mjs`
- Modify: `package.json`
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

실제 Docker 검증에서 드러난 genuine failure에 한해 parent 승인으로 Task 1–3 경계를 보완했다: Dockerfile의 pnpm build-only self-reference 하나 제거, raw/gzip blob·diff ID·OCI descriptor 검증, config와 descriptor를 구분한 exact 14-key wire 및 legacy 13-key shell rollback, release/state 공통 loaded-image ID/label 판단과 실제 CI load/inspect/run, private-material v2 파일 단위 semantic 검증이다. 각 변경은 아래 보고서의 RED→GREEN 근거와 연결하며 운영 migration·Pi 배포·HIL로 범위를 확대하지 않았다.

- [x] **Step 1: Write failing CI contract**

```js
test("production audit verifies a built release bundle and encrypted restore drill", async () => {
  assertProtectedStep(workflow, "Gateway release artifact and restore drill");
  assert.match(productionAudit, /gateway:release:ci/);
});
```

- [x] **Step 2: Run RED** — `node --test scripts/ci-workflows.test.mjs`; 8 tests 중 기존 7 pass / 새 gate 1 expected fail, skip 0. Protected Gateway step·command 연결 부재를 확인했다.
- [x] **Step 3: Wire CI and docs** — `pnpm gateway:release:ci`, Buildx setup, 단일 non-skippable audit 연결과 운영 문서를 구현했다. 최종 CLI orchestration/실패 전파/cleanup·workflow 28개는 fresh focused 170/170 안에서 GREEN이다. 같은 image digest의 unrelated container 보존·launcher 종료 뒤 descendant drain 2/2, 실제 load/identity 경계 3/3의 RED→GREEN을 포함한다.
- [x] **Step 4: Verify increasing scope**

```bash
pnpm workspace:prepare
node --test --test-concurrency=1 scripts/gateway-release-bundle.test.mjs scripts/gateway-appliance-release.test.mjs scripts/gateway-appliance-state.test.mjs scripts/gateway-appliance-scripts.test.mjs scripts/ci-workflows.test.mjs
pnpm --filter @led-control/gateway test:contracts
pnpm --filter @led-control/gateway typecheck
pnpm --filter @led-control/gateway test
pnpm --filter @led-control/gateway build
pnpm gateway:release:ci
git diff --check
```

Docker가 없으면 image smoke는 성공으로 가장하지 않고 local limitation을 별도로 기록한다.

초기 순차 증거는 `workspace:prepare`, combined 291/291(759.891초), workflow 26/26, Gateway contracts 24/24·typecheck·64 files/608 unit·build(564.6 kB)다. 이는 Docker compatibility 후의 fresh combined 결과라고 표현하지 않는다.

최종 기능 코드 `05c8451409571575185462453e08cad6cf3aa278`에서 최신 component를 직렬 재검증했다: bundle/CI focused **170/170**, canonical artifact/activation **209/209**, 전체 state **85/85**(480.138초), Gateway contracts **25/25**, fresh typecheck·**64 files/608 unit**(34.92초)·build **564.6 kB**, Node/Bash syntax와 diff check PASS다. Clean `pnpm gateway:release:ci`는 실제 Docker 29 test-only `linux/amd64` image·정확한 config/descriptor/OCI labels·container `.Image`·Node **22.23.2**·OS **120**/Node **263** inventory, default production 거부, real ephemeral CMS exact flow **1/1**과 owned cleanup을 통과했다.

첫 전체 audit는 183/183 뒤 Docker 29 compressed layer를 raw diff ID로 비교해 중단됐고 Web/dependency는 미실행이었다. 관련 RED→GREEN 수정 뒤 **전체 `pnpm ci:production-audit`를 처음부터 재실행**해 MQTT 설정 **2/2**, Gateway **25/25**, 실제 persistence/ACL **2/2**, in-band Gateway **209/209**·actual image/CMS **1/1**, Web main **314.83 kB**/gzip **97.58 kB**·container **5/5**, dependency **820**(Critical 0/High 2/Moderate 1/Low 0, 승인 예외 3·unexpected 0)까지 exit 0으로 통과했다. 두 성공 image run은 같은 config SHA `5a4cf3a358189081a529e2ca96715acb2f2e23dedd4fd427f63c445db1cce1a4`와 inventory SHA `dab4d3d146b2a2c3c856426df50186cfa3ab66641c91c2cd59f50d5f841dd8cb`를 보였고 각자의 descriptor/daemon/container ID를 결속했다. Warm build cache 결과이며 uncached byte-identical 재현성이나 실제 ARM64/Pi/HIL 증거는 아니다.

전체 RED/GREEN, 실제 실패·진단 경로, exact artifact identity/7-file closure와 cleanup 근거는 `.superpowers/sdd/2026-09-12-gateway-release-backup-recovery/task-4-report.md`에 기록했다. 메뉴/DB schema·migration·사용자 DB·운영·실장비·main은 변경하지 않았다. Production signing/recipient custody, baseline migration, Pi filesystem/power-loss·HCI/RF/HIL, GitHub 운영 보호 설정과 독립 final review는 별도 경계로 유지한다.

- [x] **Step 5: Commit** — 구현/실제 Docker 수정은 `5d955d7` → `27a08bf` → `ba7916d` → `78d00a4` → `05c8451`로 커밋했다. 후속 문서·보고서 commit은 `docs(gateway): record verified release recovery gate`이며 merge/push 없이 clean branch로 인계한다.

### Task 4 independent-review fix wave (base `1b9326f`)

Review findings are preserved in `.superpowers/sdd/2026-09-12-gateway-release-backup-recovery/task-4-review.md`. The preceding counts are historical pre-review evidence, not evidence for the fixes below. Execute inline without subagents and keep validation serial.

- [x] Encrypted PEM/PKCS#8 DER artifact behavior RED → bounded structural detection GREEN and precise v3 profile/spec documentation.
- [x] Full state-suite/no-skip/named CMS flow contract RED → protected canonical gate GREEN without duplicate happy flow.
- [x] TERM-ignoring descendant/deadline and workflow timeout RED → bounded cleanup escalation GREEN.
- [x] Attestation intermediate-index/empty-layer RED → runtime-leaf-only/nonempty GREEN.
- [x] Outer/per-layer/cumulative tar entry cap-plus-one RED → pre-push bounds GREEN.
- [x] pnpm wrong-type/wrong-target unlink RED → exact expected symlink checks GREEN; actual Docker build의 동일 check 실행도 PASS.
- [x] Full current behavior and Gateway contracts/static, implementation commit, clean canonical Docker gate and complete production audit.
- [x] Reconcile exact counts/artifact identity/limits in docs and fix report; evidence-only commit으로 인계하며 branch/worktree를 유지하고 merge/push하지 않는다.

Fresh verification at functional fix `3ba80f8fa09939ab12687e824acdfb6cfe1d7fe0`: bundle focused 56/56, CI/workflow/process/container 55/55, full combined behavior **343/343** (817.323초, skip 0), Gateway contracts **30/30**, typecheck·**64 files/608 unit** (34.76초)·build **564.6 kB**, syntax/diff PASS.

Clean `pnpm gateway:release:ci`: **223/223** (320659.720042 ms) + **전체 state 85/85** (535763.793625 ms, named CMS happy flow 1개 포함·skip/cancel/fail 0), 실제 image/v3 scan/Buildx leaf attestation/default production 거부/load-inspect-run·Node **22.23.2**·OS **120**/Node **263** inventory와 owned cleanup PASS; wall **14m37.149s**. Full `pnpm ci:production-audit`도 처음부터 dependency까지 exit 0, wall **14m26.227s**: MQTT 설정 **2/2**, Gateway **30/30**, 실제 MQTT **2/2**, in-band **223/223 + 85/85**, actual image/cleanup, Web main **314.83 kB**/gzip **97.58 kB**·container **5/5**, dependency **820** (C0/H2/M1/L0·기존 예외 3·unexpected 0).

두 actual build는 config SHA `fb20a7a61382a633560b3d4b1ea7438a38ca2f174f8ac5f0ca62100608ffccc6`, runtime leaf `f3c2e6ebbea3b5f0484e461f4c32053e4fd7049aba8f9e936b08d9f06fddd0c5`, inventory SHA `dab4d3d146b2a2c3c856426df50186cfa3ab66641c91c2cd59f50d5f841dd8cb`가 같았으며, 각자의 새 attestation/index descriptor를 검증해 container `.Image`와 결속했다. 전체 state stage의 약 8–9분 비용을 의도적으로 포함하며 child 30분/gate 45분/cleanup 2분(+5초)/workflow 60분 deadline을 둔다. Warm-cache amd64 emulation이지 production ARM64/Pi/HIL 또는 uncached 재현성 검증이 아니다.

정확한 RED/GREEN, artifact 7-file closure·digest·소유 cleanup, 기존 첫 audit 중단점과 외부 승인 경계는 `task-4-fix-report.md` 및 historical `task-4-report.md`에 있다. 후속 `docs(gateway): record final review gate evidence` commit은 문서·보고서 전용이다. No menus/database schema/migration/사용자 DB/운영 key/실장비/main 변경; whole-branch review와 운영 signing/recipient custody/Pi·power-loss/HCI/RF/HIL은 별도다.

### Whole-branch final review: bounded state decoding (base `344bd6b`)

소프트웨어 수정·검증과 independent re-review를 완료했다. Parent가 승인한 bounded Task 3 수정을 subagent 없이 직렬 실행했다. `scripts/gateway-appliance-state.sh`의 producer/parser에 4,096 nonzero headers(manifest 포함), 파일별 256 MiB, 일반 파일 합계 512 MiB(manifest 포함), manifest 16 MiB, 별도 USTAR framing 예산을 적용했다. 기존 automation state/outbox/reserve 각각 64 MiB와 state-event outbox 100 MiB, identity generation 누적 여유를 보존한다. 상한 초과는 자동 삭제·부분 백업 없이 fail-closed한다.

- [x] 실제 ephemeral CMS/USTAR의 cap+1 unique/duplicate/zero-size entries, per-file·aggregate·trailer/cipher 경계와 정상 운영 예산 테스트를 먼저 작성하고 RED를 확인한다. Production-boundary RED **13 tests = 4 pass/9 fail**, 534195.910042 ms: 4,097 entries·256 MiB+1 header·실제 512 MiB+1·10,241 trailer·544 MiB+1 cipher 및 pre-quiesce 3건을 재현했다. `mkdir`/`dd`는 실제 호출을 관찰했다.
- [x] Header counter를 field 처리 전에, byte counter를 payload `dd`/directory `mkdir` 전에 검사한다. `(( entries <= 4096 && size <= 268435456 && total <= 536870912 - size ))`와 별도 header/padding/end-block 계수를 사용하고 trailer drain도 제한한다. Backup은 hash/stop 전에 정확한 manifest 포함 metadata-only 예산 검사, snapshot 때 같은 검사를 반복한다. Focused GREEN **13/13**, 73427.746 ms. Parent 승인으로 permanent 회귀는 exact production literals를 확인한 disposable script-copy에만 64 entries/256 KiB/512 KiB 등 작은 상수를 치환한다. Production override/timeout 변경은 없고 64+64+100 MiB actual CMS verify/drill은 production 원본을 유지한다.
- [x] `gateway-appliance-state.test.mjs` 전체가 protected `gateway-release-ci.mjs`에서 no-filter/no-skip으로 실행되고 새 회귀 수가 exact count에 반영되는 실제 CLI 계약을 RED→GREEN한다. Exact **98 tests/98 pass**와 named CMS 1개·skip/fail/cancel/todo 0, old 85개/short/new-budget-failure 거부를 요구한다. Focused CLI RED **1 pass/2 fail**(5508.407042 ms) → GREEN **3/3**(5392.91925 ms).
- [x] Focused state → current combined behavior → Gateway contracts/static/diff를 직렬 실행하고 기능 수정·운영 예산 문서를 커밋했다: **state 98/98**(610622.678583 ms), **combined 358/358**(945225.855458 ms), **Gateway contracts 30/30**(371.336709 ms), Bash/Node syntax·diff PASS. 기능 commit **`0f12135fe2503d71156b006d3e1d658fca490634`**에서 clean을 확인했다.
- [x] 같은 clean SHA에서 `pnpm gateway:release:ci` → 전체 `pnpm ci:production-audit`를 파일 변경 없이 직렬 재실행했다. Canonical은 **223/223 + 98/98**, 실제 image/identity/v3/cleanup PASS, **16m21.113s**. Full audit은 MQTT 설정 **2/2**·Gateway **30/30**·실제 MQTT **2/2**·in-band **223/223 + 98/98**·Web main **314.83 kB**/gzip **97.58 kB**·container **5/5**·dependency **820**(C0/H2/M1/L0, 기존 예외 3·unexpected 0)까지 exit 0, **16m41.939s**. Full state는 각각 641489.651375/642983.220208 ms, named CMS 1개·fail/cancel/skip/todo 0이다. 완료 후에도 clean SHA와 exact owned staging/image/container 부재를 확인했다. 최종 문서/보고서 evidence-only commit은 `docs(gateway): record bounded state gate evidence`이며 기능 코드는 변경하지 않는다.
- [x] 독립 whole-branch 재리뷰에서 기존 Important 해소, 신규 Critical/Important/Minor 0과 merge readiness를 확인했다. 최종 문서 SHA `cf3051bd1938570c5ad1f6cb87a56673f707170c`에서 parent가 combined **358/358**, Prisma generate 후 workspace typecheck, 전체 workspace test·build, `pnpm ci:production-audit`를 다시 실행해 모두 exit 0을 확인했다. 이 종료 정리는 문서 전용이며 기능 코드는 `0f12135` 이후 변경되지 않았다.

검증 command는 기존 canonical gate와 timeout을 유지한다. 실제 Pi/HIL/운영 key/사용자 DB/main은 사용하지 않는다. Historical 343/343·state 85/85와 Docker 증거는 이 수정의 fresh 결과로 재사용하지 않는다.

두 fresh actual build의 config SHA는 `bacc25d55b2926446b26d08376a956b39a7c097f693fa809cf89a88472a0ed06`, selected runtime leaf는 `3df08d0d0fc5782e252028ea7810a3ede44093fe296d39c5ba0e1186a7229e99`, inventory SHA는 `dab4d3d146b2a2c3c856426df50186cfa3ab66641c91c2cd59f50d5f841dd8cb`다. Standalone descriptor `e50ee87ab6c1001e94be68524e51794aba791ba52bfd67c6c5760bd90e326a77`, in-band descriptor `6a9e63642f933287da52da04f39b5194a506723978200b5ee3fad03a88ee87be`를 각각 daemon/container ID와 결속했다. Actual Node 22.23.2·OS 120/Node 263 inventory, default production test-mode 거부와 7-file release closure가 유지됐다. Warm-cache amd64 software 증거이며 production ARM64/Pi/HIL·전원 차단·recipient custody/signing·운영 보호 설정과 별개다. 상세 증거와 추가 범위 후보는 `.superpowers/sdd/2026-09-12-gateway-release-backup-recovery/final-review-fix-report.md`에 기록했다.
