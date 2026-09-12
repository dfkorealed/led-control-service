# Task 4 independent review — preserved findings

Base reviewed: `1b9326f06ef3e60de0a602f74f7bb574cc2b5c63`. Scope: the same Gateway release worktree/branch; Task 4 review fixes only. No subagents, Pi/HIL, operational keys, user data, main merge or deployment.

## Important 1 — encrypted private-key artifacts

The v2 scanner excludes encrypted private keys even though the governing specification prohibits them. Reject a complete `ENCRYPTED PRIVATE KEY` PEM block structurally without needing its passphrase. Detect whole-file PKCS#8 EncryptedPrivateKeyInfo DER with a strict bounded DER structure. Add real ephemeral encrypted PEM/DER create and verify RED/GREEN regressions and public/encrypted non-key controls. Align the specification, manifest profile and documentation; never log key contents.

## Important 2 — recovery regressions missing from the protected gate

The canonical gate runs only the happy encrypted backup/verify/drill flow, leaving malicious archive/path/permission/identity/partial-swap/journal rollback regressions outside the protected gate. Include the full state suite serially and fail closed unless its exact pass count has no failures, cancellations or skips. Prove that the named real CMS happy flow appears exactly once in that suite rather than duplicating it. Update CI timing and counts honestly.

## Important 3 — unbounded process-group cleanup

The gate drains child process groups without a deadline and only forwards TERM, so a TERM-ignoring descendant can hang cleanup. Implement bounded TERM grace followed by KILL, a hard wall deadline, and nonzero failure for still-live cleanup. Exercise a real TERM-ignoring detached descendant. Add an explicit protected production-audit workflow `timeout-minutes` contract.

## Important 4 — attestation reference ambiguity

Attestation references currently accept a selected ancestor index as well as the actual runtime manifest, and an empty attestation layer array satisfies `every`. Bind references only to the selected runtime leaf manifest digest and require at least one in-toto layer. Add intermediate-index reference and empty-layer RED cases; keep actual Buildx attestations working.

## Important 5 — unbounded tar entry arrays

Byte and layer limits do not bound zero-sized entry counts. Enforce outer-archive, per-layer and cumulative layer entry caps before pushing entries, using reasonable production constants. Add cap-plus-one duplicate and unique zero-entry tests while preserving byte/layer limits.

## Minor — unchecked pnpm layout removal

Before unlinking the build-only Gateway self-reference, require the exact symlink type and expected target. A pnpm layout mismatch must fail the build closed. Exercise the runtime packaging behavior and actual container build contract.

## Required completion evidence

Focused RED/GREEN, full current behavior, Gateway contracts/static, implementation commit, clean `pnpm gateway:release:ci`, full `pnpm ci:production-audit`, updated Task 4 report/project status/plan/README/spec as needed, final fix report, final commit and clean status. Docker checks are disposable software evidence, not ARM64/Pi/HIL validation.
