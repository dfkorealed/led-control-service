# Task 1 implementation report — public Web deployment mode

Source frozen after review fixes: `577e7cfa` on `codex/web-deploy-mode-20261011`.
Worktree: `/Users/kim-jh/Documents/led-control-service/.worktrees/web-deploy-mode-20261011`.
The remaining working tree changes belong to the root orchestrator (`docs/project-status.md` and the active plan); owned product paths are committed.

## Commits and scope

- `7f132751`: clean cherry-pick of reviewed static AWS prep `78fab117`.
- `1f78274c`: clean cherry-pick of reviewed static Web prep `1b10cd95`. Git auto-merged the latest Button and Typography changes without conflicts. No old status snapshot was imported.
- `a549fb16`: coupled Web mode build, route/artifact binding, CloudFront/API/release/rollback updates, focused tests, public menu documents, and revised existing AWS runbook.
- Owned changes: `apps/web/**`, `scripts/landing/**`, `infra/landing/**`, the three public menu documents, and `docs/runbooks/kinda-static-landing-aws.md`. No API, shared contracts, DB/schema, Compose, CI, firmware, native app, or credential changes. Prisma Client generation was local test setup only.

The current ATLAS UI and ordinary `main.tsx` entry are preserved. The service entry follows the same AppRoot and mobile bootstrap path but excludes the concept entry. Ordinary dev/build login remains `/login`; legacy standalone landing explicitly selects its disabled/optional HTTPS URL contract.

## Implemented behavior

- `WEB_DEPLOY_MODE=landing|service`, unset defaults to landing; empty/invalid values fail.
- `build:public` always emits a fresh `dist-public`, excludes public/concept/test material, and checks the actual Rollup graph and output. Main/worker assets use the selected mode namespace. Metadata binds mode to all emitted file hashes and sizes.
- landing contains 33 local source modules, no AppRoot/auth/concept modules, and 9 public files plus `deployment.json`. Service contains 324 local source modules including existing auth/AppRoot and no concepts, and 77 public files plus metadata. The initial a549fb16 build audit output list repeated the five brand entries because Vite already adds emitted files to the bundle; these were list duplicates only, not duplicate emitted files. Review fix M1 removes the duplicates; see the fix-wave evidence below. Artifact collection verified the exact 78 service files and bytes. See [artifact audit](logs/final-artifact-audit.txt).
- Service includes the real exact shell routes, including statistics children and `/settings/floor-plans/:floorId/edit`. Unknown/trailing/concept/archive paths receive a self-contained real 404. Login is same-origin with existing session, role, organization, and tenant enforcement.
- CLI `deploy --execute` rebuilds automatically, rejects arbitrary `--dist`, validates API configuration and build metadata before AWS calls, then verifies account/stack/bucket/OAC ownership.
- Files are archived immutably under `releases/<id>`, assets retained under `assets/{mode}`, and HTML/brand under `published/<id>`. One generated CloudFront function selects the exact HTML release and allowed asset namespace. Direct archive/published URLs remain blocked.
- Service API behaviors `/api` and `/api/*` use HTTPS origin, all seven methods, managed CachingDisabled and AllViewerExceptHostHeader. Cookies/query/Authorization are forwarded; origin Host is retained for TLS. Global HTML origin-error rewriting is removed; supported CloudFront error TTLs are explicitly zero, preserving API statuses and bodies.
- Existing target checks, SHA-256 archives, conditional S3 lock, immutable collision checks, old assets, and invalidation wait remain. Stack update and distribution propagation must finish with the requested release/mode. A failed activation keeps the lock; `--recover-lock <exact failed release>` checks the stored release and ETag before removing that exact lock. Recovery requires the operator to establish that the old process stopped and remote resources are stable. Cross-mode rollback validates the archive mode.

## RED and GREEN evidence

Toolchain: Node `22.20.0`, pnpm `9.15.0`, task-owned frozen install; `workspace:prepare` and local Prisma Client generation succeeded. The launcher prints its known newer-pnpm configuration warning, but the effective repository pnpm was 9.15.0.

- Initial `node --test apps/web/scripts/public-deploy-contract.test.mjs`: 3 expected failures for missing parser/route/artifact functions. After implementation, 3/3 passed.
- Initial `node --test scripts/landing/public-mode.test.mjs`: 3 expected failures for missing mode template and missing service API preflight. After implementation, 3/3 passed.
- [Combined Node contracts](logs/node-contracts.txt): 17/17, including legacy real Rollup forbidden-import rejection, actual HTTP routing, immutable release roundtrip, stale/wrong-mode no remote calls, missing API no remote calls, and held-lock recovery. [Final changed contracts](logs/final-node-contracts.txt): 11/11 after the self-contained 404/template update.
- [Focused Web unit tests](logs/web-focused.txt): 45/45 in six files — public contact/content/URL/login mode, ordinary entry routing, mobile bootstrap. An AppRoot.test.tsx filter named in the command does not exist; it contributed no tests. Auth/session behavior was instead covered by the production browser checks below.
- [Typecheck](logs/typecheck.txt): exit 0. [UI policy](logs/ui-policy.txt): existing 0/new 0. [UI policy tests](logs/ui-policy-tests.txt): 79/79, including the actual ordinary Vite build policy check.
- [Landing build](logs/landing-build.txt): 2,931 transformed modules, actual graph/output gate passed. Main JS 328.05 kB / gzip 100.14 kB.
- [Service build](logs/service-build.txt): 4,696 transformed modules, actual graph/output gate passed. Main JS 914.76 kB / gzip 275.45 kB; Vite's normal >500 kB warning remains. No limit or timeout was raised. The first service build correctly failed when the separately built CAD worker used Vite's unnamespaced default; worker output names were corrected and the real service build passed.
- [Landing production Chromium](logs/landing-browser.txt): 2 passed, 2 intentionally excluded service-only cases. All three public pages, reloads, no API calls, disabled `준비 중`, contact dialog, real 404/private/opposite-mode paths.
- [Service production Chromium](logs/service-browser.txt): 4/4. Public pages make no API calls and link `/login`; nested direct load/reload requires login; 403 shows recovery; mock login POST and HttpOnly cookie survive operator route reload at 390px. Initial run was 3 pass/1 failure because the new test fixture omitted `organizationType: service_provider` and `status: active`, which the existing OperatorShell correctly rejected, and supplied an object instead of the site-admin array. Corrected the fixture to the existing API shape. Product auth was unchanged. This initial failed log was superseded by final PASS; its details are recorded here rather than rerun.
- `git diff --check` and staged check passed before commit.

These are scoped software checks. The full canonical suite, production audit, actual backend/API session, CloudFormation validation, AWS IAM/TLS/DNS/cache behavior, native WebView, and HIL were not executed. No real AWS call was made.

## Exact operational command

After one-time account/stack/bucket/distribution/domain/TLS/permissions and `apiOriginDomain` setup:

```sh
WEB_DEPLOY_MODE=landing node scripts/landing/deploy.mjs deploy --config .local/landing-aws.json --release 20261011-landing-r1 --execute
WEB_DEPLOY_MODE=service node scripts/landing/deploy.mjs deploy --config .local/landing-aws.json --release 20261011-service-r2 --execute
```

The release ID is always a fresh operation identifier. The only feature-selection flag is WEB_DEPLOY_MODE. Changing it requires rebuilding/redeploying; it is not a live browser toggle. The same command updates reviewed artifact and edge/API scope together. Service requires an already operating HTTPS API serving the unchanged `/api` prefix, public CA certificate, and compatible cookies/CSRF/origin configuration. It does not create that API or bypass authentication. Missing target/account input remains a real deployment prerequisite, not a fake public launch.

CloudFront propagation is not globally instantaneous: old/new edge state can coexist temporarily. Immutable HTML keys prevent a new entry from being served under the old function, while API behavior propagation can still create a temporary transition window. After successful service→landing propagation, new service asset/API requests are blocked; downloaded JavaScript or existing sessions are not revoked. Pre-activation failure preserves prior public routing. Activation/propagation failure requires exact recovery/rollback after stack stability; UPDATE_ROLLBACK_FAILED needs operator diagnosis. The runbook includes both exact retry and cross-mode recovery commands.

## Preview

Task-owned service static preview: `http://127.0.0.1:5188`.
Node PID `53455`, exec session `93338`.
It serves actual `dist-public` and intentionally has no API proxy/mock server. Public pages work; `/login` needs a real API for interactive use. Production browser tests inject explicit mock API responses separately. Existing Python PID 21636 on 5187 and all existing root/other-worktree servers were left untouched.

Ready for the independent fixed-diff spec/quality review from baseline `cc6b9a7a` to `577e7cfa` (root planning commits are separate ownership).


## Review fix wave 1 — source freeze `577e7cfa`

Commit: `577e7cfa fix(web): correct CloudFront policy and isolate public deployment tests` (six owned files, based on `a549fb16`). No controller status/plan/spec edits. Ready for one scoped re-review of `a549fb16..577e7cfa` and the original combined findings.

### I1: managed cache policy ID

Independently opened the official [AWS managed cache policies documentation](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/using-managed-cache-policies.html#managed-cache-policy-caching-disabled) during this fix. It specifies CachingDisabled as `4135ea2d-6df8-44a3-9df3-4b5a84be39ad` with minimum/default/maximum TTL zero. Replaced the invalid ID in default HTML and service API behaviors with one named production constant. Origin request forwarding and error response settings did not change.

The test oracle remains an independently documented literal, not an import of the production constant. Before changing production code, `node --test scripts/landing/public-mode.test.mjs` produced the expected **2 failures / 2 passes**: API and default HTML behaviors exposed the old invalid value. [Meaningful RED log](logs/review-i1-red.txt). After the correction, `node --test scripts/landing/*.test.mjs apps/web/scripts/public-deploy-contract.test.mjs` passed **12/12**, including both deployment modes and the new independently sourced default-policy assertion. [GREEN log](logs/review-i1-green.txt). The shell call subsequently used `lsof` to check an unused port (exit 1 means no listener); the Node test itself completed successfully.

### I2: ordinary login and production test discovery

Restored `/login` link expectations in the original `landing-field-day.spec.ts` and `landing.spec.ts`. The existing 390px signed-out login test now clicks the actual header link, verifies `/login`, and checks the login form/style and reload. Default `playwright.config.ts` excludes `static-landing.spec.ts` and `public-deploy.spec.ts`; their dedicated configs continue selecting those files.

Focused ordinary command (pinned pnpm 9.15.0 launcher, Node 22.20.0, unset conflicting color variables):

```sh
E2E_WEB_PORT=5189 pnpm --filter @led-control/web exec playwright test --config playwright.config.ts landing.spec.ts landing-field-day.spec.ts --grep 'public landing follows the approved five scenes without auth|public styles keep the real signed-out login unchanged at 390px' --workers 1
```

**2/2 passed**, 14.1 seconds. [Ordinary browser log](logs/review-i2-browser.txt). The temporary ordinary server used free 5189 and Playwright stopped it afterward; preview 5188 and every pre-existing server were preserved.

`playwright test --config <config> --list` plus explicit output assertions verified:

- [Default discovery](logs/review-i2-default-discovery.txt): 1,044 tests in 55 files; both original landing files present, both production-only files absent.
- [Standalone landing discovery](logs/review-i2-landing-discovery.txt): 5 tests in its single intended file.
- [Public deployment discovery](logs/review-i2-public-discovery.txt): 4 tests in its single intended file.

The full ordinary suite was only listed, not rerun. Previous dedicated production browser evidence remains valid because this wave changes their discovery isolation, not the browser code or published bytes.

### M1: accurate build audit

Changed the shared public-config audit output list to a Set. Ran **only the service build** using the pinned pnpm launcher: [fresh build log](logs/review-m1-service-build.txt). The actual generated audit now lists **77 unique public files**, exactly equal to the deployment manifest's file keys; duplicate count is zero. All manifest file hashes/sizes equal the prior artifact, proving that every published byte remains unchanged. [Audit assertion log](logs/review-m1-audit.txt). The corrected expression is shared by both modes; no redundant landing build was run.

Preview `http://127.0.0.1:5188`, PID **53455**, session **93338** remains service mode and serves the rebuilt artifact. Its public bytes match the earlier browser-tested artifact exactly; only the nonpublished audit list changed.

### M2: visible limitations retained

Used the directly pinned pnpm launcher and removed inherited NO_COLOR/FORCE_COLOR during new commands. The ordinary dev command internally invokes the existing pnpm launcher and still prints its known configuration warning. The service build still prints the existing **914.76 kB / gzip 275.45 kB** main-chunk size warning. This is successful validation with known warning noise, not a pristine warning-free run. No entry splitting, chunk limit, timeout, canonical CI, or unrelated source changes were made.

`git diff --check` and staged diff check passed before commit. This wave made no AWS account/resource calls; the only external request was read-only official AWS documentation. Actual CloudFormation/IAM/TLS/cookie validation remains a prelaunch prerequisite.
