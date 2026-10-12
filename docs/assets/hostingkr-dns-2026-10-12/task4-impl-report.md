# Task 4 implementation report — HostingKR external DNS

- Worktree: `/Users/kim-jh/Documents/led-control-service/.worktrees/hostingkr-dns-20261012`
- Branch: `codex/hostingkr-dns-20261012`; starting HEAD `949fc946` (product baseline `f31e56fa`)
- Scope: `scripts/landing/deploy.mjs`, `scripts/landing/template.mjs`, `scripts/landing/contracts.test.mjs`, `docs/runbooks/kinda-static-landing-aws.md`. `infra/landing/config.example.json` already includes explicit empty `hostedZoneId`, so no change was necessary. Controller owns plan/status; its concurrent plan heading edit is excluded from this implementation commit.

## Behavior

- `domainName` plus an ACM certificate ARN in the target account and `us-east-1` is required for a custom domain. An explicit empty `hostedZoneId` selects manual external DNS; a valid `Z...` ID preserves Route 53 A/AAAA alias management. A missing or malformed zone ID with a custom domain fails before AWS calls. Certificate/zone without domain fails.
- CloudFormation `CustomDomain` controls the CloudFront alias/certificate; `ManagedDns` controls only Route 53 records. External mode performs no Route 53 API calls or active Route 53 record creation.
- Provision validates an existing ISSUED certificate covering the exact domain before template validation or stack creation, and queries zone/record collisions only in Route 53 mode. Existing-stack check, deploy, and rollback revalidate issuance/SAN and reject stack DNS parameter changes before any S3 or CloudFormation writes. In particular, a managed stack cannot silently drop its Route 53 records when config switches to external DNS; adding a custom domain to a default-domain stack also requires a separately reviewed migration.
- After stack creation, check/deploy/rollback return the actual `DistributionDomain` cross-checked between CloudFormation Output and CloudFront API. External guidance gives exact domain, CNAME type, and target. Managed/default guidance also reports the actual target. Provision and offline plans return `target: null` and state that the destination is unresolved; a `StackId` is never presented as a DNS destination.
- Existing lock, owner checks, private S3/OAC, SHA-256 archive, rollback, mode selection, and managed cache IDs remain intact.

## TDD and verification

1. Added behavioral/fake-AWS tests before implementation. Initial command `node --test scripts/landing/contracts.test.mjs scripts/landing/public-mode.test.mjs`: **16 tests, 10 passed, 6 failed** for absent external DNS support/guidance and DNS condition. Raw output: `logs/task4-red.log`.
2. Implemented minimal contract and expanded regression coverage for existing-stack certificate rejection, managed ownership guard on actual deploy, default-to-custom guard, both modes' external deploy/rollback, and managed/default compatibility.
3. Final command `node --test scripts/landing/*.test.mjs apps/web/scripts/public-deploy-contract.test.mjs`: **22 tests, 22 passed, 0 failed**; `logs/task4-node-final.log`.
4. `git diff --check`: exit 0. `node --version`: v24.19.0; `pnpm --version`: 9.15.0. The repository's prescribed Node 22 was unavailable locally, so Node 22 and canonical full CI remain the operator's predeployment gate. No app builds were run for this infrastructure-only change.
5. Verified documented source paths/commands in the checkout and checked official HostingKR CNAME/DNS help plus AWS ACM DNS validation and CloudFront alternate-domain documentation.

## Operational boundary

No AWS CLI, DNS provider, certificate issue, credential, network installation, deployment, or production smoke command was executed. The Korean runbook gives the manual ACM validation CNAME (`_token.kinda` relative name), later `kinda` CNAME to the **actual** CloudFront domain, CLI wait/Outputs/check/deploy/smoke/update/rollback sequence, and same-commit canonical CI gate. Validation CNAME remains for ACM renewal. Live CloudFormation/IAM/ACM/HostingKR/TLS behavior is unverified until the user performs the runbook.

## Review round 1 fix — scoped ACM read permission

The independent reviewer found Important I1: `verifyTarget()` now calls `acm:DescribeCertificate` during custom-domain check/deploy/rollback, but the documented OIDC deployment policy had no ACM Allow. The original fake AWS tests did not model IAM, so a role built from the example would receive AccessDenied before any release write.

- Test first: added a policy-artifact regression requiring exactly `acm:DescribeCertificate` on `arn:aws:acm:us-east-1:ACCOUNT_ID:certificate/EXACT_CERTIFICATE_ID`; it also rejects a wildcard Action. `node --test --test-name-pattern='documented deploy role can only describe' scripts/landing/contracts.test.mjs` was **RED: 0 pass, 1 fail** because the ACM statement was absent. Raw log: `logs/task4-fix-red.log`.
- Minimal fix: added only that read Action and one exact certificate placeholder ARN to `infra/landing/oidc-policy.example.json`. No ACM issue, delete, export, wildcard resource/action, DNS, or other write permission was added. The runbook now says both external/managed custom domains need this read permission for check/deploy/rollback, default-domain-only roles do not, and provision requires separately approved creation rights. AWS's ACM API permission table confirms resource-level scope for DescribeCertificate.
- Focused GREEN: 1/1 (`logs/task4-fix-green.log`). Complete changed Node deployment contracts: `node --test scripts/landing/*.test.mjs apps/web/scripts/public-deploy-contract.test.mjs` **23/23, 0 failures** (`logs/task4-fix-node-final.log`). `git diff --check` remained clean.
- This is a policy example and documentation correction. No actual IAM role, AWS account, certificate, DNS, or deployment was changed. Node 22 and same-commit canonical CI remain the user's predeployment gate; local tests used Node 24.19.0.
