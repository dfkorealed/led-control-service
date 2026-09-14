# BIO Gateway First-Install Reset Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **2026-09-14 실행 전환:** 사용자가 모든 기존 계정·서비스 데이터를 백업 없이 삭제하는 전체 초기화를 승인해, 이 문서의 admin4 부분 recommission 경로는 실환경에 적용하지 않았다. Task 1은 검토까지 완료됐지만 Task 2 구현은 독립 검토 중 다른 Site의 비활성 `FixtureGroup`이 Gateway cascade로 미리보기 없이 삭제될 수 있는 Important blocker가 확인된 상태에서 중단됐다. Tasks 3~6과 recommission CLI는 실행하지 않는다. 실제 초기 설치는 빈 PostgreSQL schema·Redis·object-storage와 빈 Pi 운영 root에서 다시 시작했으며, 제조 CA/Vault와 source artifact만 유지했다.

**Goal:** admin4의 계정·Site·Floor·제조 device identity만 보존하고 기존 Gateway/Fixture 및 모든 파생 이력을 제거한 뒤, Web claim과 조명 등록을 처음부터 수행해 새 BIO presence runtime을 실장비에서 검증한다.

**Architecture:** API의 durable recommission job이 exact reset 대상과 digest를 고정하고 MQTT certificate 폐기 완료 뒤에만 DB cleanup과 새 claim hash를 확정한다. Raspberry Pi의 별도 reset helper는 exact container/data-root snapshot을 같은 digest에 결속해 old runtime을 격리하고 device identity만 보존하며, 기존 BIO launcher는 검증된 reset evidence가 있을 때만 fresh runtime 시작을 허용한다. Web은 기존 onboarding/registration UI를 그대로 사용하고 성공한 HIL 뒤 old container/data와 평문 claim file을 finalize한다.

**Tech Stack:** TypeScript, NestJS, Prisma/PostgreSQL, Vault/CRL certificate reconciliation, Node `crypto`/filesystem, Bash, Docker/Compose, Jest, Node test runner, Raspberry Pi ARM64.

**Spec:** `docs/superpowers/specs/2026-09-14-bio-first-install-reset-design.md`

## Global Constraints

- 유지 대상은 admin4 User/Organization/Site/Floor/current floor-plan asset와 제조 `device` certificate/private key/CA뿐이다.
- 삭제 대상은 admin4 Site의 단일 기존 Gateway/Fixture 설치 세대와 command, automation, provisioning, monitoring, processed-event, statistics, energy, report 및 floor-map revision history다.
- `GatewayInventory`와 device certificate/revocation ledger는 보존하고 active MQTT certificate만 폐기한다.
- Site에 Gateway가 정확히 하나가 아니거나 Gateway에 속하지 않은 Fixture가 있으면 preview 단계에서 fail closed한다.
- 기존 MQTT certificate의 CA revoke와 CRL publish 완료 전에는 Inventory를 unclaimed로 만들거나 새 claim hash를 저장하지 않는다.
- 평문 claim code는 DB/audit/log/Git에 기록하지 않고 owner-only `0600` 신규 파일에 한 번만 기록한다.
- Pi helper는 exact full container ID, canonical data root, inode/owner/mode와 `hostResetDigest`, 준비된 API job ID/`apiResetDigest`를 요구하며 broad path, glob, recursive environment target을 받지 않는다. DB와 host digest는 서로 다른 snapshot이므로 같다고 비교하지 않고 evidence에서 한 operation으로 결속한다.
- 제조 device identity 삭제, PostgreSQL volume reset, Docker prune, 두 BIO runtime의 동시 USB open은 금지한다.
- Web claim/identify/register는 사용자가 수동 실행한다. 등록 전과 등록 후 presence HIL은 GET/read-only이며 BIO write를 보내지 않는다.
- 기존 poll `600000ms`, operational freshness `1200000ms`, energy known-state window `180000ms`는 변경하지 않는다.
- 예외적·비표준 로직에는 상세한 한국어 주석을 작성한다.

---

### Task 1: Durable recommission job과 exact preview

**Files:**
- Modify: `apps/api/prisma/schema.prisma`
- Create: `apps/api/prisma/migrations/20260914170000_gateway_recommission_job/migration.sql`
- Create: `apps/api/src/gateway-onboarding/gateway-recommission.service.ts`
- Create: `apps/api/src/gateway-onboarding/gateway-recommission.service.spec.ts`
- Create: `apps/api/src/gateway-onboarding/gateway-recommission.integration.spec.ts`

**Interfaces:**
- Produces: `GatewayRecommissionService.preview(input): Promise<GatewayRecommissionPreview>`
- Produces: `GatewayRecommissionService.prepare(input): Promise<GatewayRecommissionPrepared>`
- Produces: durable `GatewayRecommissionJob` state and exact `resetDigest`
- Consumes later: Task 2 certificate staging and cleanup, Task 3 CLI

- [x] **Step 1: Write failing preview and schema tests**

Add unit cases for one admin4 Site/one claimed Inventory/Gateway, exact relation counts, redacted certificate counts, stable digest, changed-row digest mismatch, wrong Site/serial, multiple Gateways, unbound Fixture, disabled/unclaimed Inventory and a second active job. Add a disposable PostgreSQL integration test that applies all migrations and verifies the partial active-job uniqueness and status CHECK.

The public preview shape is exact and contains no identifiers from certificate/mapping payloads:

```ts
export type GatewayRecommissionCountKey =
  | "gateway" | "fixture" | "meshNode" | "fixtureGroup"
  | "provisioningSession" | "command" | "automationExecution"
  | "monitoringIncident" | "processedGatewayEvent" | "gatewayEventWatermark"
  | "energyFixtureIdentity" | "energyGroupIdentity" | "energyAggregate"
  | "energyReport" | "floorMapRevision" | "gatewayClaimAudit";

export interface GatewayRecommissionPreview {
  siteId: string;
  inventoryId: string;
  gatewayId: string;
  serialNumber: string;
  resetDigest: string;
  counts: Readonly<Record<GatewayRecommissionCountKey, number>>;
  certificates: { deviceActive: number; mqttActive: number; mqttPending: number };
}
```

- [x] **Step 2: Run tests and verify RED**

```bash
pnpm --filter @led-control/api exec jest src/gateway-onboarding/gateway-recommission.service.spec.ts src/gateway-onboarding/gateway-recommission.integration.spec.ts --runInBand
```

Expected: FAIL because the model, migration and service do not exist.

- [x] **Step 3: Add the durable job schema**

Add a no-FK audit/job model so Gateway deletion cannot erase the reset fence:

```prisma
model GatewayRecommissionJob {
  id             String   @id @default(uuid())
  siteId         String
  inventoryId    String
  gatewayId      String
  serialNumber   String
  resetDigest    String
  targetSnapshot Json
  objectKeys     Json
  status         String
  lastError      String?
  preparedAt     DateTime @default(now())
  revokedAt      DateTime?
  appliedAt      DateTime?
  finalizedAt    DateTime?
  createdAt      DateTime @default(now())
  updatedAt      DateTime @updatedAt

  @@index([inventoryId, createdAt])
  @@index([status, updatedAt])
}
```

The SQL migration adds a named status CHECK for `prepared|mqtt_revocation_pending|mqtt_revoked|applied|finalized|failed` and a partial unique index on `inventoryId` while status is active. Regenerate Prisma and validate the schema.

- [x] **Step 4: Implement preview and prepare**

Lock/read in Site → Inventory/certificates → Gateway order, require exact-one installation topology, count every deletion family, collect report object keys with existing `reportAttemptKeys`, and hash a canonical sorted snapshot with SHA-256. `prepare` recomputes the preview under transaction locks, requires the caller digest, creates one job and stores only redacted counts/IDs/object keys.

Add a Korean comment explaining why a no-FK job must survive deletion and why the digest includes counts plus exact row IDs without certificate material.

- [x] **Step 5: Verify GREEN**

```bash
pnpm --filter @led-control/api prisma:generate
GATEWAY_RECOMMISSION_DISPOSABLE_POSTGRES=1 pnpm --filter @led-control/api exec jest src/gateway-onboarding/gateway-recommission.service.spec.ts src/gateway-onboarding/gateway-recommission.integration.spec.ts --runInBand
pnpm --filter @led-control/api typecheck
```

- [x] **Step 6: Commit**

```bash
git add apps/api/prisma/schema.prisma apps/api/prisma/migrations/20260914170000_gateway_recommission_job apps/api/src/gateway-onboarding/gateway-recommission.service.ts apps/api/src/gateway-onboarding/gateway-recommission.service.spec.ts apps/api/src/gateway-onboarding/gateway-recommission.integration.spec.ts
git commit -m "feat(api): prepare gateway recommission reset"
```

---

### Task 2: MQTT-only revocation, report cleanup and atomic DB reset

**Files:**
- Modify: `apps/api/src/pki/certificate-revocation-reconciliation.service.ts`
- Modify: `apps/api/src/pki/certificate-revocation-reconciliation.service.spec.ts`
- Modify: `apps/api/src/pki/certificate-lifecycle.service.ts`
- Modify: `apps/api/src/pki/certificate-lifecycle.service.spec.ts`
- Modify: `apps/api/src/gateway-onboarding/gateway-recommission.service.ts`
- Modify: `apps/api/src/gateway-onboarding/gateway-recommission.service.spec.ts`
- Modify: `apps/api/src/gateway-onboarding/gateway-recommission.integration.spec.ts`
- Modify: `apps/api/src/gateway-onboarding/gateway-onboarding.module.ts`
- Modify: `apps/api/src/storage/object-storage.service.ts`
- Modify: `apps/api/src/storage/object-storage.service.spec.ts`

**Interfaces:**
- Produces: `CertificateLifecycleService.revokeMqttCertificatesForRecommission(inventoryId, jobId)`
- Produces: `GatewayRecommissionService.apply(jobId, resetDigest, claimCodeHash)`
- Preserves: active device certificate and `GatewayInventory.certificateFingerprint`
- Consumes: Task 1 durable job/digest/object keys

- [ ] **Step 1: Write failing certificate and cleanup tests**

Add tests proving MQTT-only staging ignores active/pending/replaced device certificates, revokes every non-revoked MQTT certificate, publishes only the MQTT CRL and is idempotent after completion. CA/CRL failure must leave the job non-applied and Inventory claimed. Add storage batch deletion tests that accept only recorded `reports/` keys and never log provider details.

- [ ] **Step 2: Write failing atomic reset tests**

In disposable PostgreSQL seed all deletion families named in the spec, including energy identity/dimensions/memberships/hourly/daily/cursor, command/dispatch/result, schedules/rules/overrides/executions, provisioning, incidents, event/watermark, claim audit, energy reports and floor revisions. Assert apply:

```ts
expect(inventory).toMatchObject({ claimedGatewayId: null, claimedAt: null, disabledAt: null, claimCodeHash });
expect(deviceCertificate).toMatchObject({ purpose: "device", status: "active", revokedAt: null });
expect(await prisma.gateway.findUnique({ where: { id: gatewayId } })).toBeNull();
const remaining = await installationHistoryCounts(prisma, siteId);
expect(Object.values(remaining)).toEqual(Array(Object.keys(remaining).length).fill(0));
expect(await prisma.site.findUnique({ where: { id: siteId } })).not.toBeNull();
expect(await prisma.floor.findUnique({ where: { id: floorId } })).toMatchObject({ nextFixtureSequence: 0, mapRevision: 0 });
```

Add failure injection after the last large delete and prove the entire DB cleanup/hash update rolls back. A changed digest, incomplete MQTT reconciliation, processing report or wrong job status must fail before destructive SQL.

- [ ] **Step 3: Implement purpose-scoped revocation**

Factor `stagePurposeRevocation(tx, inventoryId, purpose, source)` in the reconciliation service. Existing inventory disable continues passing both purposes and clearing the device pointer; recommission passes only `mqtt` and never clears `GatewayInventory.certificateFingerprint` or `Gateway.certificateFingerprint` before Gateway deletion. Add `gateway_recommission` to the internal source union and keep certificate ledger rows.

- [ ] **Step 4: Implement external cleanup then atomic reset**

`apply` performs these gates in order:

```ts
await certificates.revokeMqttCertificatesForRecommission(job.inventoryId, job.id);
await storage.deleteRecordedReportObjects(job.objectKeys);
await prisma.$transaction(tx => resetInstallation(tx, job, resetDigest, claimCodeHash));
```

The transaction relocks the job, Site, Inventory/certificates and Gateway, recomputes the target digest, verifies MQTT reconciliation completion, deletes explicit nullable-history roots before Gateway cascade, clears claim linkage, stores only the provided scrypt hash, resets Floor counters/revisions and marks the job `applied`. Repeated apply with the same job/hash returns the existing result; a different hash conflicts.

Add Korean comments explaining the irreversible boundary: after MQTT CRL completion, the old runtime is never restarted even if DB cleanup needs an operator retry.

- [ ] **Step 5: Verify GREEN and retained device trust**

```bash
pnpm --filter @led-control/api exec jest src/pki/certificate-revocation-reconciliation.service.spec.ts src/pki/certificate-lifecycle.service.spec.ts src/storage/object-storage.service.spec.ts src/gateway-onboarding/gateway-recommission.service.spec.ts --runInBand
GATEWAY_RECOMMISSION_DISPOSABLE_POSTGRES=1 pnpm --filter @led-control/api exec jest src/gateway-onboarding/gateway-recommission.integration.spec.ts --runInBand
pnpm --filter @led-control/api typecheck
pnpm --filter @led-control/api build
```

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/pki/certificate-revocation-reconciliation.service.ts apps/api/src/pki/certificate-revocation-reconciliation.service.spec.ts apps/api/src/pki/certificate-lifecycle.service.ts apps/api/src/pki/certificate-lifecycle.service.spec.ts apps/api/src/storage/object-storage.service.ts apps/api/src/storage/object-storage.service.spec.ts apps/api/src/gateway-onboarding/gateway-recommission.service.ts apps/api/src/gateway-onboarding/gateway-recommission.service.spec.ts apps/api/src/gateway-onboarding/gateway-recommission.integration.spec.ts apps/api/src/gateway-onboarding/gateway-onboarding.module.ts
git commit -m "feat(api): reset gateway installation safely"
```

---

### Task 3: Trusted CLI와 one-time claim-code handoff

**Files:**
- Create: `apps/api/src/gateway-onboarding/gateway-recommission-cli.ts`
- Create: `apps/api/src/gateway-onboarding/gateway-recommission-cli.spec.ts`
- Create: `apps/api/src/gateway-onboarding/gateway-recommission-cli.module.ts`
- Create: `apps/api/src/gateway-onboarding/gateway-claim-code.ts`
- Create: `apps/api/src/gateway-onboarding/gateway-claim-code.spec.ts`
- Create: `apps/api/prisma/recommission-gateway.ts`
- Modify: `apps/api/package.json`
- Modify: `apps/api/src/gateway-onboarding/gateway-onboarding.service.ts`
- Modify: `apps/api/src/gateway-onboarding/gateway-onboarding.service.spec.ts`
- Modify: `apps/api/src/gateway-onboarding/gateway-onboarding.module.ts`

**Interfaces:**
- Produces commands: `preview --site-id <uuid> --serial-number <serial>`, `prepare --site-id <uuid> --serial-number <serial> --reset-digest <sha256>`, `apply --job-id <uuid> --reset-digest <sha256> --claim-code-file <absolute-path>`, `status --job-id <uuid>`, `finalize --job-id <uuid> --reset-digest <sha256> --evidence-file <absolute-path>`
- Produces: sanitized JSON stdout and owner-only claim-code file
- Consumes: Task 1/2 service

- [ ] **Step 1: Write failing parser and secret-file tests**

Test exact commands and required flags. Reject unknown flags, relative paths, existing/symlink claim files, non-UUID IDs, blank serial/digest and production execution without `GATEWAY_RECOMMISSION_OPERATOR_ACK=<resetDigest>`. Capture stdout/stderr and assert claim code, DB URLs, native errors, certificate/mapping data never appear.

- [ ] **Step 2: Run tests and verify RED**

```bash
pnpm --filter @led-control/api exec jest src/gateway-onboarding/gateway-recommission-cli.spec.ts --runInBand
```

- [ ] **Step 3: Implement application-context CLI**

Extract the existing scrypt format into `generateGatewayClaimCode()` and `verifyGatewayClaimCode()` so Web onboarding and the CLI use one implementation. Use a narrow `GatewayRecommissionCliModule` importing `PrismaModule`, `PkiModule`, `StorageModule` and the recommission provider, rather than booting the HTTP server and unrelated workers. `apply` creates a 24-byte random base64url code, hashes it with the shared helper, creates the absent file with `open(path, "wx", 0o600)` before calling the service, and removes the file only after a status read proves the job is still pre-apply. An applied or uncertain job preserves the file so a committed hash cannot become unusable. Successful stdout contains only `{status, jobId, siteId, gatewayId, claimCodeFile}`.

`finalize` refuses until the operator passes redacted evidence booleans for new claim, three heartbeats, registration, read-only presence ACK and unchanged output/energy state. It marks the job finalized but never deletes Pi state itself.

- [ ] **Step 4: Verify CLI lifecycle**

```bash
pnpm --filter @led-control/api exec jest src/gateway-onboarding/gateway-recommission-cli.spec.ts src/gateway-onboarding/gateway-recommission.service.spec.ts --runInBand
pnpm --filter @led-control/api typecheck
```

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/gateway-onboarding/gateway-recommission-cli* apps/api/src/gateway-onboarding/gateway-claim-code* apps/api/src/gateway-onboarding/gateway-onboarding.service.ts apps/api/src/gateway-onboarding/gateway-onboarding.service.spec.ts apps/api/prisma/recommission-gateway.ts apps/api/package.json apps/api/src/gateway-onboarding/gateway-onboarding.module.ts
git commit -m "feat(api): add trusted gateway recommission CLI"
```

---

### Task 4: Raspberry Pi first-install reset helper와 launcher handoff

**Files:**
- Create: `scripts/gateway-bio-first-install-reset.sh`
- Create: `scripts/gateway-bio-first-install-reset.test.mjs`
- Modify: `scripts/gateway-bio-runtime.sh`
- Modify: `scripts/gateway-bio-runtime.test.mjs`
- Modify: `package.json`

**Interfaces:**
- Produces: `gateway-bio-first-install-reset.sh preview|apply|status|finalize`
- Produces: protected reset evidence directory with distinct `hostResetDigest`, API job ID and `apiResetDigest`
- Extends: `gateway-bio-runtime.sh start` with exact reset-evidence handoff while retaining first-transition behavior

- [ ] **Step 1: Write failing shell-contract tests**

Using the existing fake Docker/sudo/stat harness, cover exact running candidate, full ID, canonical allowlisted data root, deployment UID, device identity tree, absent locks and exact-one USB. Reject `~`, `/`, `/opt/led-control/gateway`, symlinks, wrong owner/mode/inode, partial ID, multiple candidates, stopped/drifting candidate and any reset/deploy lock.

Add failure tests for stop, rename, quarantine move, fresh directory creation and interrupted cleanup. Before API commit evidence, failures restore the directories and exact old container name/start. After `mqttRevoked=true`, every path must leave the old container stopped.

- [ ] **Step 2: Run tests and verify RED**

```bash
node --test scripts/gateway-bio-first-install-reset.test.mjs scripts/gateway-bio-runtime.test.mjs
```

- [ ] **Step 3: Implement preview/apply evidence**

The helper uses `set -euo pipefail`, `umask 077`, `env -i` Docker calls and a fixed host lock. Preview writes no file and returns `hostResetDigest`. Apply requires that digest plus the API job ID/`apiResetDigest`, then creates a `0700` evidence directory containing `0600` data-only records for exact IDs, both digests and phase; it never `source`s them. It stops and renames the old candidate, atomically moves operational directories to a same-filesystem quarantine, prepares UID/GID999 fresh directories, and preserves only the validated device identity subtree.

Do not use `rm -rf` on caller-provided paths. Finalize resolves the helper-owned quarantine with `realpath`, validates recorded device/inode and removes only that one directory plus the exact stopped old container. Any mismatch retains lock/evidence and exits nonzero.

- [ ] **Step 4: Add reset-aware fresh runtime start**

`gateway-bio-runtime.sh start` keeps its current default contract. Reset mode requires `GATEWAY_BIO_RESET_EVIDENCE` as an absolute `0600` file owned by the deployment UID, verifies exact fields without sourcing, requires old candidate stopped/renamed and the fixed candidate name absent, then skips only the legacy stop step. Image, device identity, USB, UID/capability, no-new-privileges and candidate ownership gates remain unchanged.

- [ ] **Step 5: Verify every recovery boundary**

```bash
node --test scripts/gateway-bio-first-install-reset.test.mjs scripts/gateway-bio-runtime.test.mjs
bash -n scripts/gateway-bio-first-install-reset.sh scripts/gateway-bio-runtime.sh
pnpm --filter @led-control/gateway build
```

- [ ] **Step 6: Commit**

```bash
git add scripts/gateway-bio-first-install-reset.sh scripts/gateway-bio-first-install-reset.test.mjs scripts/gateway-bio-runtime.sh scripts/gateway-bio-runtime.test.mjs package.json
git commit -m "feat(gateway): support BIO first-install reset"
```

---

### Task 5: 운영 문서와 전체 자동 검증

**Files:**
- Modify: `docs/database-schema.md`
- Modify: `docs/menus/settings.md`
- Modify: `docs/menus/monitoring.md`
- Modify: `docs/menus/control.md`
- Modify: `docs/menus/statistics.md`
- Modify: `docs/runbooks/device-lab-first-install.md`
- Modify: `docs/runbooks/raspberry-pi-gateway-appliance.md`
- Modify: `apps/gateway/README.md`

**Interfaces:**
- Documents: reset preview/apply/finalize, retained factory identity, deleted history, manual Web checkpoints, irreversible MQTT-revoked boundary
- Verifies: clean build ready for ARM64 deployment

- [ ] **Step 1: Update documentation**

Document exact commands without real IDs, credentials or claim codes. Preserve every required menu section (`구현 완료`, `미구현`, `부족하거나 개선이 필요한 기능`, `관련 파일`, `갱신 규칙`). Database docs record the durable job and that certificate/recommission ledgers survive operational deletion.

- [ ] **Step 2: Run focused reset gates**

```bash
git diff --check
pnpm --filter @led-control/api exec jest src/gateway-onboarding/gateway-recommission-cli.spec.ts src/gateway-onboarding/gateway-recommission.service.spec.ts src/pki/certificate-lifecycle.service.spec.ts src/pki/certificate-revocation-reconciliation.service.spec.ts --runInBand
GATEWAY_RECOMMISSION_DISPOSABLE_POSTGRES=1 pnpm --filter @led-control/api exec jest src/gateway-onboarding/gateway-recommission.integration.spec.ts --runInBand
node --test scripts/gateway-bio-first-install-reset.test.mjs scripts/gateway-bio-runtime.test.mjs
```

- [ ] **Step 3: Run full repository gates**

```bash
pnpm test
pnpm typecheck
pnpm build
```

Expected: exit 0. Record environment-dependent skips separately and run the new disposable DB test without skips.

- [ ] **Step 4: Build and verify the deployment artifact**

On a clean committed tree, build the approved ARM64 Gateway artifact, verify its full commit/image config digest and confirm it contains `gateway.mjs`, `bootstrap-only.mjs`, `bio-runtime-preflight.mjs` and the process-check helper. Do not deploy a dirty or test-only image.

- [ ] **Step 5: Commit docs**

```bash
git add docs/database-schema.md docs/menus/settings.md docs/menus/monitoring.md docs/menus/control.md docs/menus/statistics.md docs/runbooks/device-lab-first-install.md docs/runbooks/raspberry-pi-gateway-appliance.md apps/gateway/README.md
git commit -m "docs: add BIO recommission runbook"
```

---

### Task 6: Live reset, Web onboarding, HIL and irreversible finalize

**Files:**
- Modify: `docs/superpowers/plans/2026-09-14-bio-first-install-reset.md` (redacted execution evidence/checklist only)

**Interfaces:**
- Consumes: Tasks 1–5 clean artifact, API CLI and Pi helper
- Produces: new admin4 Gateway/Fixture registration and complete presence HIL evidence

- [ ] **Step 1: Capture both read-only previews**

Run the API `preview`, Pi `preview`, current heartbeat and certificate status without printing protected values. Verify exact-one Gateway topology, expected deletion counts, healthy current container/restart0 and exact-one USB. Record the distinct `apiResetDigest` and `hostResetDigest`; do not compare them for equality. If either snapshot changes before apply, stop before mutation.

- [ ] **Step 2: Quiesce Pi and prepare durable API job**

Prepare the API job with `apiResetDigest`, then run Pi `apply` only through the tested helper using that job ID, `apiResetDigest` and `hostResetDigest`. Confirm old candidate is stopped/renamed, operational state is quarantined, device identity remains valid and no BIO command was sent.

- [ ] **Step 3: Revoke old MQTT identity and apply DB reset**

Run CLI `apply` with exact job/digest and a new absolute claim-code file. Verify CRL completion, old MQTT CONNECT rejection, Inventory unclaimed, Gateway/Fixture/history counts zero, Site/Floor/admin4 preserved and the claim file mode exactly `0600`.

- [ ] **Step 4: Pause for the user's Web Gateway claim**

Provide the one-time claim code to the user without placing it in Git/log. Wait for the user to complete admin4 Web claim. Read back the new Gateway scope and confirm the code is consumed once; then delete the local claim-code file.

- [ ] **Step 5: Bootstrap and start the new runtime**

Run the verified bootstrap-only image against fresh assignment/MQTT roots, then start BIO runtime using the reset evidence handoff. Confirm process UID/GID999, all capabilities0, NoNewPrivs1, exact USB mount, restart0 and three increasing DB heartbeat sequences.

- [ ] **Step 6: Pause for the user's Web Fixture registration**

Ask the user to start scan, perform identify if desired, select the BIO module and complete Fixture details. Registration writes are allowed only inside this user-driven interval. Verify the confirmed UUID/native UUID/logical-address mapping belongs to the new Fixture and no old IDs reappear.

- [ ] **Step 7: Run read-only presence HIL**

Capture redacted trace for scan → high-brightness GET → control-mode GET → fixture-presence publish → state-ingested ACK. Assert no address/brightness/mode SET, identify or sensor restore between poll start/completion. Compare API before/after: `lastSeenAt` and BIO metadata advance; brightness, powerOn, state checkpoint and energy aggregates do not change.

- [ ] **Step 8: Finalize and verify deletion**

Mark the API job finalized with all evidence booleans, then run Pi finalize. Verify old container, quarantine and claim file are absent while device identity and new runtime remain healthy. Run one final heartbeat/presence cycle.

- [ ] **Step 9: Record redacted evidence and commit**

Update this checklist with counts, pass/fail and redacted timestamps only; never store claim code, cert, UUID/address, IP or container/image IDs.

```bash
git add docs/superpowers/plans/2026-09-14-bio-first-install-reset.md
git commit -m "docs: record BIO first-install verification"
```
