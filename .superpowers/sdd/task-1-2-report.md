# Task 1-2 Implementation Report

## Scope

Implemented the first production settings unit on `codex/mvp1-cloud-web`: tenant role simplification, non-destructive Prisma migration, membership/revision/audit schema foundations, and operator bootstrap/authentication conversion.

## Changed Files

- `apps/api/prisma/schema.prisma`: `UserRole` is now `operator | admin | viewer`; adds `OrganizationType`, `Organization.type`, `SiteMembership`, `Floor.mapRevision`, `FloorMapRevision`, and `AuditLog`.
- `apps/api/prisma/migrations/20260721120000_simplify_roles_and_floor_revisions/migration.sql`: preserves rows while classifying organizations, converting both role columns, backfilling viewer site memberships, and creating the new structures.
- `apps/api/test/domain-schema.test.ts`: schema and migration preservation contract coverage.
- `apps/api/src/auth/auth.types.ts`, `auth.service.ts`, and `auth.service.spec.ts`: typed public roles and organization types, organization-aware login/session reads, and invitation role validation.
- `apps/api/src/auth/bootstrap-operator.ts`, `bootstrap-operator.spec.ts`, and `apps/api/prisma/bootstrap-operator.ts`: renamed operator bootstrap implementation and CLI entry point.
- `apps/api/package.json`, `apps/web/src/api/auth.ts`, `apps/web/e2e/auth-real.spec.ts`, `README.md`, `docs/database-schema.md`, `docs/menus/settings.md`, and `docs/lesson_leared.md`: renamed bootstrap documentation and recorded the changed data/auth contracts.
- `apps/api/src/gateway-onboarding/gateway-onboarding.service.ts` and controller test: migrated legacy owner-only gateway administration to customer `admin`, preserving the previous customer-owner capability after role conversion.

## Migration and Backfill Behavior

1. Adds `OrganizationType` and classifies organizations with at least one site as `customer`; organizations without sites become `service_provider`.
2. Renames the PostgreSQL enum, creates the three-role enum, and converts users without deletion: customer `owner` and legacy `operator` become `admin`; service-provider `owner` becomes `operator`; viewers remain viewers.
3. Converts legacy `Invitation.owner` and `Invitation.operator` to `admin`, as required.
4. Backfills every existing viewer into every site of its customer organization through `SiteMembership`, preserving its former inherited read access.
5. Adds `Floor.mapRevision` with default `0`, plus revision and audit tables. Existing floors, maps, fixtures, and hardware records are neither deleted nor recreated.

## TDD Evidence

Before implementation, the focused contract command failed as expected:

```text
FAIL test/domain-schema.test.ts: UserRole still contained owner
FAIL src/auth/bootstrap-operator.spec.ts: Cannot find module './bootstrap-operator'
FAIL src/auth/auth.service.spec.ts: organizationType and invitation-role behavior missing
```

The final focused suite passed after the implementation.

## Verification Commands and Outputs

```text
DATABASE_URL='postgresql://led:led@localhost:5432/led_control?schema=public' pnpm --filter @led-control/api exec prisma validate
The schema at prisma/schema.prisma is valid

DATABASE_URL='postgresql://led:led@localhost:5432/led_control?schema=public' pnpm --filter @led-control/api exec prisma generate
Generated Prisma Client (v6.19.3)

pnpm --filter @led-control/api exec jest test/domain-schema.test.ts --runInBand
PASS: 11 tests

pnpm --filter @led-control/api exec jest src/auth --runInBand
PASS: 2 suites, 8 tests

pnpm --filter @led-control/api typecheck
PASS: tsc --noEmit

pnpm --filter @led-control/web exec vitest run src/features/auth src/App.test.tsx
PASS: 1 file, 18 tests

pnpm --filter @led-control/web typecheck
PASS: tsc --noEmit

git diff --check
PASS: no whitespace errors
```

## Commits

- `cd7d430fd4cd4160d91024df7e012481239053c3` `feat(auth): simplify roles and add site memberships`
- The second commit contains the operator bootstrap/authentication conversion and this report; its final hash is supplied in the task completion response because a Git commit cannot contain its own final content hash.

## Self-Review

- Confirmed runtime source, current docs, scripts, web API types, and tests contain no `bootstrap-owner`, `BOOTSTRAP_OWNER`, `bootstrapFirstOwner`, or runtime `owner` role references. The legacy value remains only in the migration conversion and historical migrations/plans where it is required.
- Confirmed login, signup, and session lookup select the organization type before forming the typed public user. Signup explicitly supplies the already-validated invitation organization to avoid assuming Prisma create results include relations.
- Confirmed the migration uses no destructive table or row deletion and the membership backfill has a unique index after inserts.
- Confirmed gateway inventory actions retain the former customer owner/admin authorization by allowing the post-migration customer `admin` role.

## Concerns

- The migration was contract-tested and Prisma-validated but deliberately was not applied to the existing local `led_control` database during this task, to avoid mutating shared developer data. Apply it first to a disposable PostgreSQL copy before production rollout.
