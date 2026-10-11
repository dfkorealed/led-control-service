# Scoped re-review — a549fb16..577e7cfa

**Spec compliant: Yes.**

**Task quality: Approved.**

**Complete branch ready to integrate: Yes.** This is a source-integration verdict for the complete task using the prior full review plus this fix review. It is not approval/evidence of an actual production AWS deployment or full canonical CI execution.

## Finding disposition

- **I1 — ADDRESSED.** `scripts/landing/template.mjs:7` defines the correct AWS CachingDisabled ID, `4135ea2d-6df8-44a3-9df3-4b5a84be39ad`; both default HTML (`:87`) and service API (`:94`) consume it. `scripts/landing/public-mode.test.mjs:22` and `:48` retain independently documented literal oracles rather than importing the production constant. The [RED evidence](logs/review-i1-red.txt) fails both affected assertions against the previous typo; the [GREEN evidence](logs/review-i1-green.txt) passes 12/12 contracts, including mode transition, recovery, preflight, and both default behaviors. The ID matches the [official AWS source independently checked in the first review](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/using-managed-cache-policies.html#managed-cache-policy-caching-disabled). Forwarding, TLS, and error response semantics are unchanged by the fix.
- **I2 — ADDRESSED.** `apps/web/e2e/landing-field-day.spec.ts:16` and `apps/web/e2e/landing.spec.ts:29` again expect ordinary `/login`. The existing signed-out test now clicks the header link and asserts its destination (`landing.spec.ts:175`). `apps/web/playwright.config.ts:12` explicitly excludes both production-only spec files from default discovery. [Focused ordinary Chromium evidence](logs/review-i2-browser.txt) passes both selected tests, including the 390px login journey. [Default discovery](logs/review-i2-default-discovery.txt) contains 1,044 tests in 55 files, both ordinary landing files, and neither production-only file. [Landing discovery](logs/review-i2-landing-discovery.txt) retains its intended 5 tests and [public discovery](logs/review-i2-public-discovery.txt) retains its intended 4 tests. No broad suite result is inferred from listing.
- **M1 — ADDRESSED.** `apps/web/vite.public.config.ts:27` deduplicates the audit list with a Set before serializing. The [fresh service build](logs/review-m1-service-build.txt) completes, and [artifact comparison evidence](logs/review-m1-audit.txt) confirms exactly 77 unique public files, zero duplicates, and unchanged published hashes/sizes. The expression is shared by both modes; published browser code is unchanged, so the earlier dedicated landing/service browser results remain applicable.
- **M2 — OPEN, nonblocking baseline limitation.** The ordinary dev child process still emits its known pnpm configuration warning ([log line 1](logs/review-i2-browser.txt)); the service build still reports the 914.76 kB main JS chunk warning ([build log](logs/review-m1-service-build.txt)). The fix uses the pinned launcher and removes conflicting color variables without increasing a chunk threshold or timeout. Preserve these limitations in the completion evidence; do not describe the validation as warning-free.

## New findings

- Critical: **0**.
- Important: **0**.
- Minor introduced by this fix: **0**.
- Remaining findings from the original review: **M2 only**, a visible, nonblocking baseline warning limitation.

## Whole-branch assessment

The prior full fixed-diff review judged the named graph/output, exact routes, authentication/tenant preservation, API forwarding/error contract, immutable release ordering, recovery/rollback, retained asset gating, no-write preflight, and ordinary/mobile entry risks. Its two integration blockers are now resolved by the six-file fix above. No other product behavior is changed in this wave. The branch is ready for source integration with M2 recorded.

The original operational boundaries remain: actual CloudFormation/provider IAM evaluation, API ingress/CSRF/TLS/cookie behavior, production DNS, full exact-commit canonical CI, and hardware execution were not proven by local/fake tests. The existing runbook retains those prelaunch prerequisites. Code-readiness does not imply that the service is publicly deployed.

## Review method

Read the complete `review-a549fb16..577e7cfa.diff` once, the updated fix report, and the named RED/GREEN/browser/discovery/build/audit evidence. Checked the patch only for closure of I1/I2/M1 and new breakage, retaining the original full-review context. No tests rerun, broad code crawl, AWS calls, new reviewer, product/index/Git mutation, or additional source changes. This requested report is the sole authored file in the re-review.
