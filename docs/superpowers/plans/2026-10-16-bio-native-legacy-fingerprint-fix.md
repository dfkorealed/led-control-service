# BIO legacy registration native-control fix

> Execute inline with superpowers:executing-plans; user requires solo work and minimal directly relevant tests.

**Goal:** Apply the user's existing L006 100%/5s self-control rule without re-registering or modifying identity/default brightness/authentication.
**Spec:** ../specs/2026-10-15-bio-self-sensing-control-design.md
**Architecture:** Resolve current independently qualified source authority first. Strictly parse its sensor fingerprint and compare firmware/physical mapping; optional persisted legacy fingerprint is an additional constraint, not the sole source of truth. Keep all readback/durable ownership/USB/lease guards.

## Evidence and scope

- Actual desired43/applied42 REJECTED `bio_self_firmware_unsupported`; legacy L006 mapping lacks fingerprint; no native journal exists, so native SET never started.
- New registrations have fingerprint. Current commissioning authority already binds an independently observed fingerprint to exact native UUID/address/network, current health and server-acknowledged capability.
- Work on `codex/fix-native-legacy-fingerprint-20261016`; preserve main dirty AGENTS/status notes.
- User approved new encrypted backup, bounded Gateway interruption/deployment and exact current rule application. No waterproof testing, broker/API restart, DB migration or identity rewrite.

## Review focus

- Missing legacy fingerprint must not become inferred support from firmware text alone.
- Explicit mapping mismatch/unknown hardware must fail before native SET.
- Restoring a previously qualified legacy owner must retain independent release identity checks.
- Connection/mapping/lease changes after resolve must still revoke writes.
- Partial native journals remain protected; no blind retries or old backup restoration.

## Task 1 — production resolver compatibility

- [x] Add failing legacy mapping activation/restore regression to `apps/gateway/src/bio/bio-self-sensor-port.test.ts`; assert independent authority missing/invalid/conflicting firmware/hardware never permits settings.
- [x] Run focused file and observe legacy-specific RED (1 failed/9 passed, exact firmware error).
- [x] Update `bio-self-sensor-port.ts`: derive strict supported fingerprint from qualified binding, compare optional mapping fingerprint and existing firmware string, retain beforeWrite fencing.
- [x] Run directly related resolver/source/runtime tests (52/52) and production lifecycle/path tests (37/37), Gateway typecheck/build exit0; solo whole-diff review found no new C/I. No independent agent used per user instruction; no full suite repetition.
- [x] Update control menu/lesson/status and commit `c0e39904`; merge main preserving user changes and re-run resolver10/10.

### Follow-up: first ready ACK/configuration handoff

- Actual deployment was verified with unchanged24protected identity/mapping entries, same launch/USB/security and new encrypted backup67,435,326bytes. Startup outage made existing source evidence expire; server automatically disabled to revision44 APPLIED. HTTP logs show no user PATCH during this change; current predicate was `link_unverified`.
- Approved UI activation ran normal preparation and created45, but preflight rejected `bio_pulse_control_unavailable` before native journal/SET. Server ready2184 committed01:58:37.658, its ACK published01:58:38.504, config rejection01:58:38.534: configuration overtook durable local ACK handling.
- [x] Reproduce with actual monitor/delivery/provider/source/AutomationRuntime and delayed ACK, correct snapshot hash: RED rejected before ACK.
- [x] Wait at most2000ms for an exact staged live commission's accepted durable ACK, using existing change notifications. No probing/SET/retransmission, no presumed readiness. Revalidate original generation and complete source identity/double-read fences afterward. Already-qualified calls keep their original fences.
- [x] Accepted ACK/timeout/reconnect tests plus source revision fences and native ownership regressions:5files105PASS; Gateway typecheck/build0. Solo review, no other chats or agents.
- [x] Commit/merge follow-up `c7a062a5` and deploy immutable candidate with a fresh backup; verify approved unchanged100%/5s rule actually active/APPLIED47.

## Task 2 — approved deployment and exact rule verification

- [x] Build/verify immutable ARM64 bundles for exact committed sources c0e39904 and c7a062a5; retained prior canonical release-infrastructure evidence (infrastructure unchanged, not claimed as a fresh whole-suite run).
- [x] Fresh exact runtime/USB/journal/rule preflight; each encrypted three-root backup and off-device verification before replacing current container.
- [x] Deploy with unchanged environment/security/mounts/auth/IDs; keep both old containers stopped and retained. Latest sourcec7a062a5/image98d107f0/USBowner1/24protectedentriesunchanged; CMS67,384,074bytes verified. No API/Web/broker restart, DB migration, authentication or host-alias changes.
- [x] Actual native full GET and server/Gateway APPLIED47/hash61b29a0e… match. Rule100%/5s remainsenabled/self-only. Original/desired/applied high100/standby10/hold5/standby5/phase0/sensor; intentnull. No movement or waterproof test. Registration/configured-brightness digests unchanged; regular B1 lamps4online, waterproof2offline are not claimed verified.
- [x] Record actual result and limitations; final docs-only integration preserves user AGENTS/status notes and leaves real product UI ready.

## Completion evidence / operational exceptions

- Main focused resolver/production commissioning28/28 after c7a062a5; branch105/105·type/build0. Author solo self-review per user instruction, no independent review or other-chat messages. Existing bundle-size warning unchanged; no whole-suite/HIL success claim.
- Existing automatic RF0 configuration re-query converged45 toAPPLIED once durable ACK was available. Before second deployment, UI disable46 initially failed fresh identity preflight (`bio_self_identity_changed`), then existing re-query completed original full readback and removed the native owner. Deployment guard refused changes until46APPLIED/native rowsempty. No unknown native intent was replayed, no journal deletion or backup restoration.
- Latest container `5c959c4b0ac2a0ec3a37a1ceabce7bbb801e819dfc5ab683d3e87d6d31ec36ca`; previous `ba1432e2…` and `69018393…` retained. Private `fix2-*` receipts, encrypted backups and final UI screenshot stay in the existing evidence folder; never delete it as scratch.
