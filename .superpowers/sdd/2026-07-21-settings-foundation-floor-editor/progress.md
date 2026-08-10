# SDD ledger — plan: docs/superpowers/plans/2026-07-21-settings-foundation-floor-editor.md

- Task 1~5: complete (through `6cfabe9`, integrated security review approved)
- Task 6: complete (`b5a92bd`..`bb1c71e`, task review approved)
- Task 7: complete (`295c4e9`, `f3fff58`; spec and quality review APPROVED, findings 0)
- Task 8: complete (`d8d42f1`..`9cec664`; fix round 4 review APPROVED, findings 0)
- Task 9: complete (`c43ff85`..`566bd6b`; fix round 3 review APPROVED, findings 0)
- Task 10: complete (`4182f45`..`8876664`; fix round 3 review APPROVED, findings 0)
- Task 11: complete (`4862796`..`681d818`; fix round 3 review APPROVED, findings 0)
- Task 11 decision: preserve the approved viewer contract — floor-plan list is read-only, direct editor URL is blocked/redirected, and viewer mutation requests remain `403`.
- Whole-branch review: `final-review.md` returned NOT READY (Critical 1, Important 6, Minor 2).
- Final fix round: local implementation complete in `219dfe3` and `cc72fa7`; scoped final re-review is still pending orchestrator execution.
- Final fix wave evidence:
  - scoped invitation membership creation and viewer organization invariant regressions added and passed
  - selected-site statistics, viewer control read-only, dirty logout, and duplicate customer-name site switcher regressions added and passed
  - PostgreSQL migration `20260810104000_add_floor_editor_lease_authority` applied on disposable PostgreSQL
  - real PostgreSQL + Redis integration passed for atomic save/restore, stale predecessor fencing, expiry, successor acquire, and force release
  - focused Playwright passed for operator/admin/viewer routes, 1,000 fixture rendering, tenant isolation, and dirty logout confirm/cancel
  - Docker contract plus real web image smoke build passed
- Resume rule: do not repeat Tasks 1~11 or their task reviews. Resume only the scoped final re-review after inspecting this fix wave.
