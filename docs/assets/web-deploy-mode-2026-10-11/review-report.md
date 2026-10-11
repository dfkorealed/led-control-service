# Independent review — cc6b9a7a..a549fb16

## Spec compliance

**Spec compliant: No.** The single selector, build isolation, exact routes, same-origin login, release integrity, and recovery design are present, but the generated CloudFront template references an invalid managed cache policy ID, so the required same-command deployment cannot complete (I1). Browser regression coverage also contradicts the preserved ordinary entry contract (I2).

**Task quality: Needs fixes.**

**Complete branch ready to integrate: No.** Resolve I1 and I2 before integration. No critical findings; 2 important and 2 minor findings below.

## Strengths

- `apps/web/scripts/public-deploy-contract.mjs:5`, `apps/web/vite.public.config.ts:10`, `scripts/landing/deploy.mjs:168`: one strict mode parser, default only when unset, and validation before the real deployment path.
- `apps/web/vite.public.config.ts:12`, `apps/web/vite.public.config.ts:24`, `apps/web/scripts/static-landing-contract.mjs:10`: actual Rollup module inspection plus restricted public output, with separate service entry and disabled public-directory copying. The existing evidence includes a real tree-shaken forbidden import failure.
- `scripts/landing/deploy.mjs:172`, `scripts/landing/deploy.mjs:197`, `scripts/landing/deploy.mjs:208`: local mode/hash validation before AWS calls, immutable archive restoration, and byte checks before publication. `scripts/landing/contracts.test.mjs:116` covers stale and wrong local artifacts without remote calls.
- `scripts/landing/deploy.mjs:212`, `scripts/landing/template.mjs:55`: assets precede activation; HTML points to immutable release keys; the selected mode gates retained asset namespaces and blocks direct archive/published URLs.
- `apps/web/src/components/ui/public-site/PublicLogin.tsx:6`, `apps/web/src/service-main.tsx:12`: service and ordinary Web retain `/login`, current AppRoot, and mobile bootstrap. Public contact UI uses shared components and does not submit to the API.
- `docs/runbooks/kinda-static-landing-aws.md:87`: cross-mode rollback, retained locks after activation failure, exact lock recovery, CloudFront propagation limitations, and one-time API/TLS/cookie prerequisites are documented without claiming a real AWS launch.

## Critical

None.

## Important

### I1 — Use the actual managed CachingDisabled policy ID

`scripts/landing/template.mjs:84`, `scripts/landing/template.mjs:91`, `scripts/landing/public-mode.test.mjs:22`

Both the default behavior and service API behaviors reference `413f160e-6fd1-4d3a-9df3-4b5a84be39ad`. AWS documents CachingDisabled as `4135ea2d-6df8-44a3-9df3-4b5a84be39ad`. The current value is not that managed policy, so a normal target account cannot create/update the distribution from this template. This affects landing provisioning as well as both-mode activation, after archive/publication writes during deploy. The fake tests copy the same incorrect literal, so their success cannot detect it.

Replace both uses with the correct documented ID, preferably one named constant, and update the test oracle to the independently verified value. Keep origin forwarding and error semantics unchanged. Source checked during this review: [AWS managed cache policies](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/using-managed-cache-policies.html#managed-cache-policy-caching-disabled).

### I2 — Separate production-only E2E cases and preserve ordinary login expectations

`apps/web/e2e/landing-field-day.spec.ts:16`, `apps/web/e2e/landing.spec.ts:29`, `apps/web/e2e/public-deploy.spec.ts:12`, `apps/web/e2e/static-landing.spec.ts:13`

The existing ordinary-app suites now expect a disabled `준비 중` button, while `PublicLogin.tsx:6` deliberately renders `/login` when `VITE_PUBLIC_DEPLOY_MODE` is unset. The unchanged `apps/web/playwright.config.ts:10` runs the ordinary Vite dev server without that flag (`:21`) and has no `testMatch`/`testIgnore` isolation. It also discovers the two new production-only spec files, whose real-404 assertions cannot hold against ordinary Vite SPA fallback (and whose default-mode login assertions conflict as well). Thus the documented normal `playwright test` route acquires deterministic failures even though the dedicated public config's narrow tests pass.

Restore ordinary `/login` expectations in the two original suites. Exclude/move production-only specs from default discovery and keep them selected by their dedicated production configs. Validate one focused ordinary login case and default discovery, plus the existing dedicated-mode evidence as needed; a broad suite rerun is unnecessary to prove this correction.

## Minor

### M1 — Build audit output counts duplicate emitted brand files

`apps/web/vite.public.config.ts:27`

The audit appends `brandAssets` after those same files have already entered `bundle` through `emitFile`. The saved evidence reports 14 landing / 82 service public files, while the actual outputs are 9 / 77 (plus metadata). The report acknowledges this, and the artifact collector still verifies exact bytes, so this is diagnostic accuracy rather than an artifact-integrity defect. Deduplicate with a Set, as the legacy config already does, so this evidence can be used directly.

### M2 — Validation output contains known warning noise

`.superpowers/sdd/2026-10-11-web-deploy-mode/logs/service-build.txt:89`, `.superpowers/sdd/2026-10-11-web-deploy-mode/logs/landing-browser.txt:1`, `.superpowers/sdd/2026-10-11-web-deploy-mode/logs/landing-browser.txt:2`

The service entry emits the >500 kB chunk warning (914.76 kB main JS), and launcher/color-variable warnings recur across the validation logs. These are visible limitations, not pristine validation output. The large ordinary bundle and launcher warning are already identified as existing baseline/toolchain limitations; no chunk limit was raised. Preserve that distinction in completion evidence. Avoid conflicting color variables/use the pinned launcher directly where practical; track entry-size work separately rather than weakening a threshold.

## Named cross-cutting checks and evidence

- **Actual graph/artifact mode and bytes:** inspected the complete build/collector diff and existing `logs/final-artifact-audit.txt:1` evidence: landing 33 local modules with no AppRoot/auth/concept; service 324 local modules including AppRoot/auth and no concepts; exact service 78 files including metadata with hashes verified. The duplicate audit listing is M1. Build logs show both real builds complete. No build was repeated by this reviewer.
- **Real shell routes versus unknown 404:** one focused unchanged-source check of `CustomerShell.tsx:365` and `OperatorShell.tsx:90` found the exact statistics/settings/operator leaves covered by `public-deploy-contract.mjs:12`, including floor editor IDs. Wildcard redirect behavior is intentionally not made an edge catch-all. Production browser evidence covers nested direct reload plus unknown/trailing/concept/archive paths (`logs/landing-browser.txt:12`, `logs/service-browser.txt:12`).
- **Same-origin API/auth/cookies/TLS/cache/error contract:** one focused unchanged-source check of `apps/web/src/api/client.ts:1` and `:71` confirms `/api` plus `credentials: include`; `apps/api/src/auth/auth.controller.ts:181` keeps host-only HttpOnly/Secure-production/SameSite=Lax cookies, and `apps/api/src/main.ts:63` exposes the existing public-origin configuration. Template API behavior forwards all methods, cookies, query and viewer headers except Host, uses HTTPS/TLS1.2, and avoids the HTML error remap. The origin-request-policy ID agrees with [AWS AllViewerExceptHostHeader documentation](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/using-managed-origin-request-policies.html#managed-origin-request-policy-all-viewer-except-host-header); cache policy is broken by I1. Actual deployed CSRF/ingress/certificate/cookie behavior remains a stated operational prerequisite; it was not simulated as proven by browser mocks.
- **Switch ordering / partial failure / retry / rollback:** `deploy.mjs:212` publishes immutable content before `:221` activation. `:230` retains the lock after activation errors; `:179` recovery compares stored release and ETag after stable-target verification. `contracts.test.mjs:92` covers landing→service→landing and cross-mode rollback, `:127` covers activation failure and exact recovery. Fake AWS models ordering, not distributed propagation; the runbook states that limitation at `:81`.
- **Retained service assets when landing:** generated viewer function allows only `assets/<selected mode>/...`; direct published/releases URLs are denied (`template.mjs:64`). `public-mode.test.mjs:37` tests the opposite namespace. Existing immutable assets remain in storage as required.
- **Missing API/wrong artifact no-write preflight:** `deploy.mjs:169` config validation and `:172` collection precede target verification/lock writes. `public-mode.test.mjs:7` and `contracts.test.mjs:116` prove the corresponding no-call failures. Rollback requires reads and a coordination lock to validate the remote archive, and never publishes wrong-mode content.
- **Generated template and IAM:** inspected `infra/landing/oidc-policy.example.json:25` against the explicit deploy/check/update/invalidation/S3/function operations. The role intentionally excludes initial provisioning, as documented. I1 independently blocks the template. Real CloudFormation provider permission requirements, IAM evaluation, and TLS/DNS cannot be certified from these fake calls; the controller must retain those as prelaunch checks, not call this production-validated.
- **Ordinary main/mobile/ATLAS preservation:** one focused unchanged-source check of `apps/web/src/main.tsx:13` confirms the service entry retains its public routes, AppRoot, and mobile bootstrap while omitting the concept import. The fixed diff leaves current customer UI/style and ordinary entry code untouched; common Button adds a variant without replacing current variants. The ordinary test harness integration nevertheless regresses as I2.
- **Canonical gates:** the fixed diff contains no CI workflow or root canonical-script changes. The runbook still requires the exact-commit canonical CI chain (`:110`). Existing evidence is scoped: Node contracts 17/17 plus final changed 11/11; focused Web 45/45; typecheck and UI 0/0; policy 79/79; production landing 2 passed/2 mode skips and service 4 passed. It is not full canonical CI proof.

## Review method and boundaries

Read the task brief, implementer report, spec, repo instructions, and task-reviewer prompt. Reviewed the fixed diff by bounded sections; truncation was recovered from the affected diff sections, not by rereading changed product files. Unchanged-source reads were restricted to the named route, main/bootstrap, default test-harness, and API cookie/client risks above. Read existing logs instead of rerunning suites. Only external requests were read-only public AWS documentation searches; no AWS account/resource calls, DB/device actions, subagents, product edits, index changes, or Git mutations. This requested report is the sole authored file.

**Assessment:** Needs fixes; integration blocked by I1 and I2. The architecture meets most of the intended contract, but successful fake deployment and dedicated browser evidence currently conceal a real CloudFront configuration failure and a normal E2E harness regression.
