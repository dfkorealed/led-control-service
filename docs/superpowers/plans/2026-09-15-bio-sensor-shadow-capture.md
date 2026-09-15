# BIO Sensor Shadow Capture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Capture and analyze the BIO module's unsolicited sensor packets on the existing Gateway USB connection without sending lighting commands or activating event automation.

**Architecture:** The existing `BioDongleClient` remains the only owner of the USB dongle. Its checksum-validated asynchronous `0x12` notifications are classified as sensor candidate (`0x09`) or alive (`0x0c`) but never converted to `active`. An opt-in, one-run shadow recorder filters one confirmed BIO mapping, writes a redacted append-only JSONL file through the existing Gateway process, and divides a 360-second HIL into one baseline plus ten stimulus/recovery cycles. A separate offline analyzer checks the capture structure and reports packet variants; its output always keeps production activation disabled. The detected/cleared byte mapping and production event adapter are deliberately deferred until this evidence passes review.

**Tech Stack:** TypeScript, Node.js 22, Vitest, esbuild, Docker Compose, direct USB BIO transport

**Spec:** `docs/superpowers/specs/2026-09-15-bio-sensor-event-control-design.md`

## Global Constraints

- Do not send outer command `0x10`, scan commands, brightness commands, mode commands, or GET commands from the shadow feature. It may only observe events already received by the running `BioDongleClient`.
- Do not expose an `active`, `detected`, `cleared`, or production capability value from opcode `0x09` in this plan.
- Treat opcode `0x0c` as liveness evidence only; it must never become an automation input.
- Keep `BioUsbDongleAdapter.vehicleSensorCloudSupported` and `BioSensorCapabilityUnavailablePort.vehicleSensorCloudSupported` equal to `false` throughout this plan.
- Store no raw BIO UUID, site ID, gateway ID, MQTT credential, USB descriptor, or full wire frame. Store only an ephemeral-key HMAC-SHA-256 source fingerprint, non-secret lamp header fields, inner opcode, and inner body hex.
- Require a new capture filename and use exclusive file creation with mode `0600`; never truncate or append to an existing evidence file.
- Keep the existing USB ACK ownership semantics unchanged: asynchronous `0x12` packets must not resolve a pending outer `0x11` request.
- Add detailed Korean comments at every nonstandard safety boundary and label evidence as `[확인됨]`, `[추정]`, or `[미확인]` consistently with the existing BIO code.
- This stage does not change the database schema. Do not edit `docs/database-schema.md` unless implementation unexpectedly introduces a schema change; if that happens, stop and redesign before continuing.
- Preserve unrelated untracked files, especially `.chart-data-*`, `docs/research/`, and `outputs/`.

---

### Task 1: Classify asynchronous BIO sensor/alive packets without assigning state

**Files:**

- Modify: `apps/gateway/src/bio/bio-command-codec.ts`
- Modify: `apps/gateway/src/bio/bio-command-codec.test.ts`
- Verify fixture: `apps/gateway/test/fixtures/bio-protocol-v1.json`

**Interfaces:**

```ts
export type BioSensorStatusCandidate = BioLampObservation & {
  kind: "sensor-status-candidate";
  innerOpcode: 0x09;
  innerBody: Buffer;
};

export type BioAliveStatus = BioLampObservation & {
  kind: "alive-status";
  innerOpcode: 0x0c;
  innerBody: Buffer;
};
```

- [ ] **Step 0: Reconfirm the exact APK evidence input before changing the decoder.**

Run: `shasum -a 256 /Users/kim-jh/Downloads/bio-group-control-v11-slim-aligned-signed.apk`

Expected: `1fb69b7f6241ab757908fb4a6e8d8359d1127be75c84f5cbbf26740e415ef83e`. Stop if it differs; do not silently bind this plan to a different APK.

- [ ] **Step 1: Replace the current opaque sensor/alive test with RED classification tests.**

```ts
it.each([11, 12, 27])("classifies sensor candidate sequence %i without assigning active state", (sequence) => {
  const parsed = decodeBioResponse(response(`lamp-notification-seq-${sequence}`));
  expect(parsed).toMatchObject({
    kind: "sensor-status-candidate",
    innerOpcode: 0x09,
    innerBody: Buffer.from("0101000000000000", "hex")
  });
  expect(parsed).not.toHaveProperty("active");
  expect(parsed).not.toHaveProperty("detected");
});

it.each([6, 35])("classifies alive sequence %i as non-event liveness", (sequence) => {
  const parsed = decodeBioResponse(response(`lamp-notification-seq-${sequence}`));
  expect(parsed).toMatchObject({ kind: "alive-status", innerOpcode: 0x0c });
  expect(parsed).not.toHaveProperty("active");
});
```

The eight-byte literal above is the exact inner body after opcode `0x09` in fixture sequences 11, 12, and 27. Do not rewrite the fixture to make a decoder test pass.

- [ ] **Step 2: Add malformed/unknown-opcode RED tests.**

```ts
it("copies candidate body bytes instead of retaining a mutable frame view", () => {
  const payload = Buffer.from("d30011223344558396123401fe0000090101000000000000", "hex");
  const parsed = decodeBioResponse({ protocol: "crc16", command: 0x12, payload });
  if (parsed.kind !== "sensor-status-candidate") throw new Error("expected sensor candidate");
  payload.fill(0, 16);
  expect(parsed.innerBody.toString("hex")).toBe("0101000000000000");
});

it("keeps an unapproved inner opcode opaque and body-free", () => {
  const parsed = decodeBioResponse({
    protocol: "crc16",
    command: 0x12,
    payload: Buffer.from("d30011223344558396123401fe000008deadbeef", "hex")
  });
  expect(parsed).toEqual({ kind: "unsupported-notification", outerCommand: 0x12, payloadBytes: 20 });
  expect(parsed).not.toHaveProperty("innerBody");
});
```

- [ ] **Step 3: Run the focused test and confirm RED.**

Run: `pnpm --filter @led-control/gateway test -- src/bio/bio-command-codec.test.ts`

Expected: failures because `0x09` and `0x0c` still return `unsupported-notification`.

- [ ] **Step 4: Implement header-first classification for only opcodes `0x09` and `0x0c`.**

Move common `BioLampObservation` parsing before the approved-opcode switch, then return copied inner bytes:

```ts
const header = decodeLampObservation(p);
if (opcode === 0x09) {
  return {
    kind: "sensor-status-candidate",
    ...header,
    innerOpcode: 0x09,
    innerBody: Buffer.from(p.subarray(16))
  };
}
if (opcode === 0x0c) {
  return {
    kind: "alive-status",
    ...header,
    innerOpcode: 0x0c,
    innerBody: Buffer.from(p.subarray(16))
  };
}
```

Add a detailed comment explaining that the APK proves opcode names but not body semantics, so these types carry bytes for shadow evidence only and intentionally contain no boolean state.

- [ ] **Step 5: Run codec and client regression tests.**

Run:

```bash
pnpm --filter @led-control/gateway test -- src/bio/bio-command-codec.test.ts src/bio/bio-dongle-client.test.ts src/bio/bio-usb-transport.test.ts
```

Expected: all selected tests pass; existing request/read-back tests remain unchanged.

- [ ] **Step 6: Commit Task 1.**

```bash
git add apps/gateway/src/bio/bio-command-codec.ts apps/gateway/src/bio/bio-command-codec.test.ts
git commit -m "feat(gateway): classify bio sensor shadow packets"
```

---

### Task 2: Build a secure append-only shadow evidence recorder

**Files:**

- Create: `apps/gateway/src/bio/bio-sensor-shadow-capture.ts`
- Create: `apps/gateway/src/bio/bio-sensor-shadow-capture.test.ts`

**Interfaces:**

```ts
export const BIO_SENSOR_SHADOW_SCHEMA_VERSION = 1 as const;
export const BIO_SENSOR_SHADOW_APK_SHA256 =
  "1fb69b7f6241ab757908fb4a6e8d8359d1127be75c84f5cbbf26740e415ef83e";

export type BioSensorShadowPhase =
  | { kind: "baseline"; cycle: 0 }
  | { kind: "stimulus" | "recovery"; cycle: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 };

export interface BioSensorShadowSource {
  nativeUuid: string;
  logicalAddress: number;
  firmware: string;
  protocol: string;
}

export interface BioSensorShadowScheduler {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export class BioSensorShadowCapture {
  static create(options: {
    evidenceRoot: string;
    captureName: string;
    source: BioSensorShadowSource;
    now?: () => Date;
    randomBytes?: (size: number) => Buffer;
    scheduler?: BioSensorShadowScheduler;
    onPhase?: (phase: BioSensorShadowPhase) => void;
    onComplete?: () => void;
    onFailure?: (error: unknown) => void;
  }): Promise<BioSensorShadowCapture>;
  record(event: BioClientEvent): void;
  close(): Promise<void>;
}
```

The fixed phase contract is:

```ts
const BIO_SENSOR_SHADOW_CYCLES = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as const;

export const BIO_SENSOR_SHADOW_PHASES = [
  { kind: "baseline", cycle: 0, durationMs: 60_000 },
  ...BIO_SENSOR_SHADOW_CYCLES.flatMap((cycle) => [
    { kind: "stimulus" as const, cycle, durationMs: 8_000 },
    { kind: "recovery" as const, cycle, durationMs: 22_000 }
  ])
] as const;
```

- [ ] **Step 1: Write RED tests for secure file creation and redaction.**

Use `mkdtemp`, `lstat`, and `readFile` from `node:fs/promises`. Assert all of the following:

- the evidence root is a real directory owned by the current effective UID with mode `0700`;
- the capture file is created with `wx` semantics and mode `0600`;
- an existing filename and a symlink filename are rejected without modification;
- capture names must match `^bio-sensor-shadow-[0-9]{8}T[0-9]{6}Z\.jsonl$`;
- serialized records never contain the raw `nativeUuid`, the `bio:` prefix joined to that UUID, site/gateway IDs, or a full wire frame beginning with the `55aa` preamble;
- the source fingerprint is an HMAC-SHA-256 of the native UUID using a fresh 32-byte in-memory key that is never serialized;
- the same capture has a stable fingerprint, while two captures of the same device have different fingerprints when their ephemeral keys differ;
- only a matching `deviceUuid` plus `logicalAddress` is recorded;
- `alive-status` is tagged `liveness`, while `sensor-status-candidate` is tagged `candidate`, with no `active` field.

- [ ] **Step 2: Write RED tests for the deterministic phase state machine.**

Provide a fake scheduler and fixed clock. Assert the exact record order:

```text
capture-start
phase baseline/0
phase stimulus/1
phase recovery/1
phase stimulus/2
phase recovery/2
phase stimulus/3
phase recovery/3
phase stimulus/4
phase recovery/4
phase stimulus/5
phase recovery/5
phase stimulus/6
phase recovery/6
phase stimulus/7
phase recovery/7
phase stimulus/8
phase recovery/8
phase stimulus/9
phase recovery/9
phase stimulus/10
phase recovery/10
capture-complete
```

Also assert that `record()` after `capture-complete` or `close()` writes nothing and that repeated `close()` is idempotent.

- [ ] **Step 3: Write RED tests for serialized asynchronous writes and failure behavior.**

Inject multiple notifications synchronously, then close. Assert JSONL order equals call order. Inject an append failure and assert:

- `onFailure` is invoked once with no raw record printed by the capture class;
- subsequent records are discarded;
- `close()` rejects with the retained write failure;
- an incomplete file has no `capture-complete`, so the analyzer can reject it later.

- [ ] **Step 4: Run the new test and confirm RED.**

Run: `pnpm --filter @led-control/gateway test -- src/bio/bio-sensor-shadow-capture.test.ts`

Expected: module-not-found failure.

- [ ] **Step 5: Implement the recorder with an internal promise queue.**

Use a single `FileHandle` opened as follows:

```ts
const handle = await open(join(evidenceRoot, captureName), "wx", 0o600);
await handle.chmod(0o600);
```

Every record must be a schema-validated plain object written as one JSON line. `record()` must enqueue, never await inside `BioDongleClient.onEvent`, and must copy `innerBody.toString("hex")` immediately. Use `handle.datasync()` for `capture-start`, phase changes, `capture-complete`, and `close()` so a power loss cannot make a later phase appear without its boundary.

Add comments explaining:

- why the ephemeral HMAC is stable only inside one capture and is not a cross-capture device identifier;
- why the raw inner body is permitted but the full frame/UUID is prohibited;
- why matching both UUID and current logical address is safe for observation but not yet sufficient for production event identity;
- why a write failure disables evidence capture but does not send or alter any lighting command.

- [ ] **Step 6: Run focused tests and typecheck.**

Run:

```bash
pnpm --filter @led-control/gateway test -- src/bio/bio-sensor-shadow-capture.test.ts src/bio/bio-command-codec.test.ts
pnpm --filter @led-control/gateway typecheck
```

Expected: all pass.

- [ ] **Step 7: Commit Task 2.**

```bash
git add apps/gateway/src/bio/bio-sensor-shadow-capture.ts apps/gateway/src/bio/bio-sensor-shadow-capture.test.ts
git commit -m "feat(gateway): add bio sensor shadow recorder"
```

---

### Task 3: Wire shadow capture into the existing Gateway USB owner

**Files:**

- Modify: `apps/gateway/src/adapters/adapter-factory.ts`
- Modify: `apps/gateway/src/adapters/adapter-factory.test.ts`
- Modify: `apps/gateway/compose.bio-runtime.yml`
- Modify: `apps/gateway/docker/bio-runtime-compose.test.mjs`
- Modify: `scripts/gateway-bio-runtime.sh`
- Modify: `apps/gateway/docker/Dockerfile`

**Configuration contract:**

```text
GATEWAY_BIO_SENSOR_SHADOW_CAPTURE_NAME=
  absent or empty: disabled
  a filename matching bio-sensor-shadow-YYYYMMDDTHHMMSSZ.jsonl: one 360-second capture
```

The evidence root is fixed in code to `/var/lib/led-control/evidence`; no environment variable may redirect it.

- [ ] **Step 1: Add RED factory tests for disabled-by-default behavior.**

Assert that a BIO factory created without `GATEWAY_BIO_SENSOR_SHADOW_CAPTURE_NAME` does not create a recorder, does not add an event listener, and still returns `vehicleSensorCloudSupported: false`.

- [ ] **Step 2: Add RED factory tests for the opt-in path.**

Extend `AdapterFactoryDependencies` with an injected recorder factory and use fake client/mapping objects. Assert:

- `probe()` and `mappings.validate()` happen before recorder creation;
- capture requires exactly one confirmed mapping;
- the source passed to the recorder contains the mapping native UUID, logical address, firmware, and protocol;
- `client.onEvent` forwards events only to `recorder.record`;
- phase output logs only fixed forms such as `BIO_SENSOR_SHADOW_PHASE phase=baseline cycle=0`, `BIO_SENSOR_SHADOW_PHASE phase=stimulus cycle=1`, and `BIO_SENSOR_SHADOW_PHASE phase=recovery cycle=1`;
- completion logs only `BIO_SENSOR_SHADOW_COMPLETE`;
- capture failure logs only `BIO_SENSOR_SHADOW_CAPTURE_FAILED` and no error object/payload;
- `stop()` unsubscribes, awaits recorder close, and then closes the USB client;
- recorder startup failure closes the USB client and fails Gateway startup;
- recorder runtime failure does not flip capability support or invoke any client write method.

- [ ] **Step 3: Add RED Compose contract tests.**

Assert the rendered `gateway-bio` service contains:

```yaml
GATEWAY_BIO_SENSOR_SHADOW_CAPTURE_NAME: "${GATEWAY_BIO_SENSOR_SHADOW_CAPTURE_NAME:-}"
```

Also assert no additional device, capability, D-Bus mount, network, port, or volume is added.

- [ ] **Step 4: Add RED launcher validation tests.**

In the existing shell contract tests, cover:

- empty value accepted and passed as empty;
- exact UTC filename accepted;
- slash, `..`, whitespace, shell metacharacters, wrong prefix, wrong suffix, and overlong names rejected before Docker is called;
- the clean-environment Compose invocation passes only the validated capture name;
- normal BIO startup behavior remains identical when the variable is empty.

- [ ] **Step 5: Run factory/Compose tests and confirm RED.**

Run:

```bash
pnpm --filter @led-control/gateway test -- src/adapters/adapter-factory.test.ts
pnpm --filter @led-control/gateway test:contracts
```

Expected: failures for the missing recorder wiring and Compose environment.

- [ ] **Step 6: Implement optional recorder wiring in `createBioUsbAdapters`.**

Use this ordering:

```ts
await client.probe();
await mappings.validate();

const capture = await createOptionalBioSensorShadowCapture(env, mappings, dependencies);
const unsubscribe = capture ? client.onEvent((event) => capture.record(event)) : undefined;

return {
  // existing adapters and false capability stay unchanged
  stop: async () => {
    unsubscribe?.();
    let captureFailure: unknown;
    try { await capture?.close(); } catch (error) { captureFailure = error; }
    await client.close();
    if (captureFailure !== undefined) throw captureFailure;
  }
};
```

Do not add the recorder to the automation controller, `VehicleSensorClient`, MQTT telemetry, health truth, or fixture state.

- [ ] **Step 7: Pass the validated optional variable through Compose and the clean launcher.**

Validate before any Docker call:

```bash
capture_name=${GATEWAY_BIO_SENSOR_SHADOW_CAPTURE_NAME:-}
[[ -z $capture_name || $capture_name =~ ^bio-sensor-shadow-[0-9]{8}T[0-9]{6}Z\.jsonl$ ]] || fail_input
```

Pass the variable explicitly in the existing `env -i` Compose wrapper. Do not print its host path or evidence content.

- [ ] **Step 8: Add the evidence directory to both image and bind-mounted host contracts.**

In the Dockerfile's existing directory creation layer, create `/var/lib/led-control/evidence`, assign `gateway:gateway`, and set mode `0700`. Because the production bind mount hides that image directory, also make the launcher create `$GATEWAY_BIO_DATA_ROOT/gateway/evidence` only when absent and then validate it with `realpath -e`, `stat`, owner/group `999:999`, mode `0700`, and non-symlink directory checks before Compose runs. Do not chmod, chown, replace, or follow an existing invalid path. Do not add a separate volume; the directory remains under the existing `/var/lib/led-control` bind mount.

- [ ] **Step 9: Run focused tests, shell syntax validation, and build.**

Run:

```bash
pnpm --filter @led-control/gateway test -- src/adapters/adapter-factory.test.ts src/bio/bio-sensor-shadow-capture.test.ts
pnpm --filter @led-control/gateway test:contracts
bash -n scripts/gateway-bio-runtime.sh
pnpm --filter @led-control/gateway typecheck
pnpm --filter @led-control/gateway build
```

Expected: all pass and `apps/gateway/dist/gateway.mjs` builds with the recorder included.

- [ ] **Step 10: Commit Task 3.**

```bash
git add apps/gateway/src/adapters/adapter-factory.ts apps/gateway/src/adapters/adapter-factory.test.ts apps/gateway/compose.bio-runtime.yml apps/gateway/docker/bio-runtime-compose.test.mjs scripts/gateway-bio-runtime.sh apps/gateway/docker/Dockerfile
git commit -m "feat(gateway): wire opt-in bio sensor shadow capture"
```

---

### Task 4: Add a fail-closed offline evidence analyzer

**Files:**

- Create: `apps/gateway/scripts/bio-sensor-shadow-analyze.ts`
- Create: `apps/gateway/scripts/bio-sensor-shadow-analyze.test.ts`
- Modify: `apps/gateway/package.json`

**Interfaces:**

```ts
export interface BioSensorShadowAnalysis {
  schemaVersion: 1;
  apkSha256: "1fb69b7f6241ab757908fb4a6e8d8359d1127be75c84f5cbbf26740e415ef83e";
  firmware: string;
  protocol: string;
  captureComplete: boolean;
  phaseSequenceValid: boolean;
  cyclesObserved: number;
  sourceFingerprints: string[];
  networkIds: number[];
  sequence: {
    observed: number;
    duplicates: number;
    wraps: number;
  };
  sensorVariants: Array<{
    bodyHex: string;
    baselineCount: number;
    stimulusCycles: number[];
    recoveryCycles: number[];
  }>;
  alivePackets: number;
  readyForProtocolReview: boolean;
  productionActivationAllowed: false;
  reasons: string[];
}

export function analyzeBioSensorShadowJsonl(input: string): BioSensorShadowAnalysis;
```

CLI contract:

```bash
pnpm --filter @led-control/gateway bio:sensor-shadow:analyze -- \
  --input /tmp/bio-sensor-shadow-20260915T000000Z.jsonl \
  --output /tmp/bio-sensor-shadow-20260915T000000Z-analysis.json
```

- [ ] **Step 1: Write RED parser-safety tests.**

Reject before analysis:

- input larger than 8 MiB;
- more than 20,000 lines;
- an individual line larger than 4 KiB;
- invalid JSON, arrays, unknown schema version, unknown record type, invalid hex, invalid SHA-256, non-ISO timestamp, or unknown fields;
- an APK hash other than `1fb69b7f6241ab757908fb4a6e8d8359d1127be75c84f5cbbf26740e415ef83e`;
- multiple `capture-start`/`capture-complete`, notification before start, record after complete, or non-monotonic timestamps;
- mixed source fingerprints;
- output path that exists, is a symlink, or is not absolute.

Use exclusive `0600` creation for the analysis output.

- [ ] **Step 2: Write RED evidence-gate tests.**

Build table-driven JSONL fixtures and assert:

- a complete baseline plus exactly ten ordered stimulus/recovery cycles is required;
- one stable source fingerprint and one stable network ID are required;
- at least one sensor body variant must appear in all ten stimulus windows;
- a different sensor body variant must appear in all ten recovery windows;
- a stimulus-only variant must not appear in baseline;
- a recovery variant may appear in baseline; when baseline contains sensor candidates, every baseline variant must also be a recovery variant;
- identical `(sequence, opcode, bodyHex)` repeats increment `duplicates` without adding cycle coverage;
- `255 → 0` increments `wraps`; other backwards jumps add a reason and fail review readiness;
- alive packets are counted but never contribute to discriminating sensor variants;
- every result has `productionActivationAllowed: false`, including a review-ready result.

- [ ] **Step 3: Run the analyzer test and confirm RED.**

Run: `pnpm --filter @led-control/gateway test -- scripts/bio-sensor-shadow-analyze.test.ts`

Expected: module-not-found failure.

- [ ] **Step 4: Implement strict JSONL parsing and deterministic aggregation.**

Use explicit key allowlists per record type. Do not pass unknown JSON fields through to the report. Sort `sourceFingerprints`, `networkIds`, body variants, and cycle arrays before serialization so the same capture produces byte-identical analysis.

Set readiness only with this expression:

```ts
const readyForProtocolReview =
  captureComplete
  && phaseSequenceValid
  && cyclesObserved === 10
  && sourceFingerprints.length === 1
  && networkIds.length === 1
  && stimulusVariants.length >= 1
  && recoveryVariants.length >= 1
  && baselineVariants.every((value) => recoveryVariants.includes(value))
  && stimulusVariants.some((value) => !recoveryVariants.includes(value));
```

This is readiness for a human protocol decision, not proof of detected/cleared semantics. Keep `productionActivationAllowed` hard-coded to `false`.

- [ ] **Step 5: Add the package script and CLI argument validation.**

```json
"bio:sensor-shadow:analyze": "tsx scripts/bio-sensor-shadow-analyze.ts"
```

The CLI accepts exactly one absolute input path after `--input` and one absolute, not-yet-existing output path after `--output`, in either flag order, and rejects duplicate/extra arguments.

- [ ] **Step 6: Run analyzer, codec, and type tests.**

Run:

```bash
pnpm --filter @led-control/gateway test -- scripts/bio-sensor-shadow-analyze.test.ts src/bio/bio-sensor-shadow-capture.test.ts src/bio/bio-command-codec.test.ts
pnpm --filter @led-control/gateway typecheck
pnpm --filter @led-control/gateway build
```

Expected: all pass.

- [ ] **Step 7: Commit Task 4.**

```bash
git add apps/gateway/scripts/bio-sensor-shadow-analyze.ts apps/gateway/scripts/bio-sensor-shadow-analyze.test.ts apps/gateway/package.json
git commit -m "feat(gateway): analyze bio sensor shadow evidence"
```

---

### Task 5: Document the operator flow and current product limitation

**Files:**

- Modify: `docs/runbooks/raspberry-pi-gateway-appliance.md`
- Modify: `docs/menus/control.md`
- Modify: `docs/project-status.md`

- [ ] **Step 1: Add a runbook section titled `BIO 센서 shadow 캡처`.**

Document these exact facts:

1. Shadow capture reuses the running Gateway's USB owner and therefore never starts a second USB process.
2. Enabling it requires a freshly built, verified Gateway image and one new UTC capture filename.
3. The operator watches only fixed phase logs and performs this sequence: baseline—do nothing; stimulus—place the BIO sensor stimulus; recovery—remove it; repeat for cycles 1 through 10.
4. The Gateway may continue normal communication, but no manual, schedule, group, or event control should be issued during the 360-second evidence window because output commands may change the module's own sensor reporting.
5. The file is incomplete unless it ends with `capture-complete`.
6. Copy the evidence file through the existing authenticated maintenance channel; never paste JSONL into chat or commit it.
7. Analyze it offline with the Task 4 command and retain both files outside Git.
8. `readyForProtocolReview=true` does not authorize production activation.
9. Remove `GATEWAY_BIO_SENSOR_SHADOW_CAPTURE_NAME` on the next normal deployment so every restart does not attempt the same exclusive filename.

- [ ] **Step 2: Add exact operational verification commands.**

The runbook must include:

```bash
docker inspect led-control-gateway-bio --format '{{.State.Status}} {{.State.Health.Status}} {{.RestartCount}}'
docker logs --since 10m led-control-gateway-bio 2>&1 | grep '^BIO_SENSOR_SHADOW_PHASE'
docker exec led-control-gateway-bio stat -c '%F %a %u:%g %s %n' /var/lib/led-control/evidence/bio-sensor-shadow-20260915T000000Z.jsonl
```

The container path is invariant even when the host data-root name differs. The runbook must explain that the filename itself remains exact and is never reused. Do not include credentials, IP addresses, raw UUIDs, or packet bodies in log commands.

- [ ] **Step 3: Update the control menu status.**

Under the document's existing sections, record:

- implemented: opt-in shadow evidence capture and offline analysis;
- not implemented: BIO sensor boolean mapping, source capability `supported`, and production event execution;
- improvement required: complete the 10-cycle HIL and then write a second production integration plan;
- related files: codec, recorder, analyzer, factory, Compose, and runbook.

Do not describe shadow capture as completed event control.

- [ ] **Step 4: Update project status with the same evidence boundary.**

Add one concise entry dated `2026-09-15` that distinguishes software-complete shadow capture from not-yet-run physical HIL and not-yet-enabled production event control.

- [ ] **Step 5: Check documentation structure and forbidden claims.**

Run:

```bash
rg -n "BIO 센서 shadow|productionActivationAllowed|readyForProtocolReview" docs/runbooks/raspberry-pi-gateway-appliance.md docs/menus/control.md docs/project-status.md
rg -n "BIO.*(완료|지원).*이벤트" docs/menus/control.md docs/project-status.md
```

Expected: the first command finds the new sections; every match from the second command is qualified as shadow/software-only or explicitly not production-enabled.

- [ ] **Step 6: Commit Task 5.**

```bash
git add docs/runbooks/raspberry-pi-gateway-appliance.md docs/menus/control.md docs/project-status.md
git commit -m "docs: add bio sensor shadow capture runbook"
```

---

### Task 6: Perform software verification and prepare the physical evidence gate

**Files:**

- Verify: all files changed in Tasks 1–5
- Runtime evidence outside Git: `led-control-gateway-bio:/var/lib/led-control/evidence/bio-sensor-shadow-20260915T000000Z.jsonl`
- Local analysis outside Git: `/tmp/bio-sensor-shadow-20260915T000000Z-analysis.json`

- [ ] **Step 1: Run the full Gateway automated suite.**

Run:

```bash
pnpm --filter @led-control/shared build
pnpm --filter @led-control/automation-engine build
pnpm --filter @led-control/gateway test
pnpm --filter @led-control/gateway test:contracts
pnpm --filter @led-control/gateway typecheck
pnpm --filter @led-control/gateway build
```

Expected: all tests, contracts, typecheck, and build pass.

- [ ] **Step 2: Prove the production event capability remains disabled.**

Run:

```bash
rg -n "vehicleSensorCloudSupported = false|vehicleSensorCloudSupported: false" apps/gateway/src/adapters/bio-usb-dongle-adapter.ts apps/gateway/src/adapters/bio-sensor-capability-unavailable-port.ts apps/gateway/src/adapters/adapter-factory.ts
pnpm --filter @led-control/gateway test -- src/adapters/bio-sensor-capability-unavailable-port.test.ts src/adapters/adapter-factory.test.ts
```

Expected: all three BIO boundaries remain false and the tests pass.

- [ ] **Step 3: Review the final diff for data leakage and accidental command coupling.**

Run:

```bash
git diff --check
git diff --stat HEAD~5..HEAD
rg -n "active|detected|cleared|encodeBioCommand|setBrightness|setControlMode|recordVehicleSensorInput" apps/gateway/src/bio/bio-sensor-shadow-capture.ts apps/gateway/scripts/bio-sensor-shadow-analyze.ts
```

Expected: no whitespace errors; matches for state words occur only in explicit prohibitions/tests/report field names, and neither shadow file imports or calls a command encoder, setter, or automation input.

- [ ] **Step 4: Build and deploy through the existing verified Raspberry Pi image workflow.**

Follow `docs/runbooks/raspberry-pi-gateway-appliance.md` exactly. Set:

```bash
export GATEWAY_BIO_SENSOR_SHADOW_CAPTURE_NAME='bio-sensor-shadow-20260915T000000Z.jsonl'
```

Use the release's verified immutable ARM64 image digest and existing deployment identity values. Do not replace those values with sample credentials from documentation. The launcher must fail if the filename already exists.

- [ ] **Step 5: Execute the 360-second physical capture.**

Watch:

```bash
docker logs -f led-control-gateway-bio 2>&1 | grep --line-buffered '^BIO_SENSOR_SHADOW_'
```

Perform no action during baseline. On every line whose phase is `stimulus`, expose the module's sensor. On every line whose phase is `recovery`, remove the stimulus and leave it removed until the next stimulus line. Complete cycles 1 through 10. Do not send any lighting control during the capture.

Expected final fixed log: `BIO_SENSOR_SHADOW_COMPLETE`.

- [ ] **Step 6: Verify and transfer the redacted artifact.**

On the Pi:

```bash
docker exec led-control-gateway-bio stat -c '%F %a %u:%g %s %n' /var/lib/led-control/evidence/bio-sensor-shadow-20260915T000000Z.jsonl
docker cp led-control-gateway-bio:/var/lib/led-control/evidence/bio-sensor-shadow-20260915T000000Z.jsonl /tmp/bio-sensor-shadow-20260915T000000Z.jsonl
```

Expected: `regular file 600 999:999`, non-zero size. Transfer it through the authenticated maintenance channel to `/tmp/bio-sensor-shadow-20260915T000000Z.jsonl`; do not add it to the repository.

- [ ] **Step 7: Analyze the capture offline.**

Run:

```bash
pnpm --filter @led-control/gateway bio:sensor-shadow:analyze -- \
  --input /tmp/bio-sensor-shadow-20260915T000000Z.jsonl \
  --output /tmp/bio-sensor-shadow-20260915T000000Z-analysis.json
node -e 'const fs=require("node:fs");const p="/tmp/bio-sensor-shadow-20260915T000000Z-analysis.json";const r=JSON.parse(fs.readFileSync(p,"utf8"));console.log(JSON.stringify({captureComplete:r.captureComplete,cyclesObserved:r.cyclesObserved,readyForProtocolReview:r.readyForProtocolReview,productionActivationAllowed:r.productionActivationAllowed,reasons:r.reasons},null,2))'
```

The evidence-gate pass shape is:

```json
{
  "captureComplete": true,
  "cyclesObserved": 10,
  "readyForProtocolReview": true,
  "productionActivationAllowed": false,
  "reasons": []
}
```

- [ ] **Step 8: Stop at the evidence gate and write Plan 2.**

Inspect the analysis plus the redacted packet variants. Only if the detected and cleared candidate bodies are distinguishable across all ten cycles and the network ID is stable may the next plan define the production integration and its remaining physical gates:

- exact body-length and byte-value decoder rules;
- durable source identity including network ID;
- capability V2 publication;
- `VehicleSensorMeshPort`/`ScheduleRuntime.recordVehicleSensorInput` integration;
- prior brightness and prior BIO mode restoration;
- polling-based reconciliation at 10 minutes;
- source/target overlap rejection;
- production HIL and rollback.

That second plan must still test duplicate delivery, sequence wrap, Gateway/module power cycle, USB reconnect, output-only false events, and source/target separation before changing capability support to `true`.

If the evidence is insufficient, repeat this capture with a new UTC filename. Do not weaken the analyzer gate or infer state from LED brightness.

- [ ] **Step 9: Commit only source and documentation changes, never HIL evidence.**

Run:

```bash
git status --short
test ! -e apps/gateway/bio-sensor-shadow-20260915T000000Z.jsonl
test ! -e apps/gateway/bio-sensor-shadow-20260915T000000Z-analysis.json
```

Expected: `/tmp` evidence is outside the repository and no evidence JSONL/analysis file is staged. If Task 6 required a source/doc correction, commit only those exact tracked files with `fix(gateway): harden bio sensor shadow evidence`.
