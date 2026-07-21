# Task 1~5 Migration and Bootstrap Hardening Report

기준일: 2026-07-21

## Status

DONE

## Commit

- `b32568a fix(auth): harden legacy migration and bootstrap`

## Changed Files

- `apps/api/prisma/migrations/20260721120000_simplify_roles_and_floor_revisions/migration.sql`
- `apps/api/src/auth/bootstrap-operator.ts`
- `apps/api/src/auth/bootstrap-operator.spec.ts`
- `apps/api/test/domain-schema.test.ts`
- `docs/database-schema.md`
- `docs/menus/settings.md`
- `docs/superpowers/plans/2026-07-21-settings-foundation-floor-editor.md`
- `.superpowers/sdd/tasks-1-5-migration-hardening-report.md`

## Implemented Security Contract

- Legacy migration keeps every existing Organization as `customer`; it never infers `service_provider` from Site presence.
- Legacy user and invitation `owner`/`operator` roles convert to `admin`; no migration path grants `operator`.
- PostgreSQL partial Unique index permits exactly one `Organization.type = service_provider`.
- `auth:bootstrap-operator` uses a transaction-scoped PostgreSQL advisory lock, rejects an existing service provider Organization or operator, and still permits bootstrap when customer users exist.

## RED Evidence

Command, run before the implementation change:

```bash
cd apps/api
pnpm --filter @led-control/api exec jest test/domain-schema.test.ts src/auth/bootstrap-operator.spec.ts --runInBand
```

Result: FAIL, 2 suites / 6 tests failed / 10 tests passed.

- The migration still updated Organization type from Site existence, promoted a legacy owner to `operator`, and lacked the singleton index.
- Bootstrap did not acquire an advisory lock, rejected a database containing customer users, and allowed existing service provider/operator fixtures to continue.

## GREEN Evidence

Focused contracts:

```bash
cd apps/api
pnpm --filter @led-control/api exec jest test/domain-schema.test.ts src/auth/bootstrap-operator.spec.ts --runInBand
```

Result: PASS, 2 suites / 16 tests.

Prisma and API checks:

```bash
cd apps/api
set -a
source ../../.env
set +a
pnpm --filter @led-control/api exec prisma validate
pnpm --filter @led-control/api exec prisma generate
pnpm --filter @led-control/api typecheck
git diff --check
```

Result: `prisma validate`, `prisma generate`, API typecheck, and `git diff --check` completed successfully. The command uses the existing local environment only to load `DATABASE_URL`; it does not apply a migration there.

## Disposable PostgreSQL Verification

Used the repository's PostgreSQL 16 Docker image on `127.0.0.1:55432`, separate from the configured local `led_control` database.

1. Applied the first 16 migrations in a temporary Prisma directory, inserted a legacy no-site Organization with an `owner` user, then applied `20260721120000_simplify_roles_and_floor_revisions` from the working tree.
2. Query result for the legacy records: `customer|admin`.
3. Ran `auth:bootstrap-operator` concurrently with two different emails against that disposable database.
4. Results: first CLI exit `0`; second CLI exit `1` with `BOOTSTRAP_REFUSED: a service provider organization or operator already exists`.
5. Singleton queries returned `service_provider|1` and `operator|1`.

## Local Database Notice

This task intentionally changes an existing migration because the project is not in production. A local development database that applied the earlier migration will have a Prisma checksum mismatch. Do not run reset automatically or use destructive DB commands from this task. Choose a reset only when its data is disposable; when data must be retained, audit the incorrectly inferred service provider/operator rows and apply a manual corrective migration before accepting the revised migration history.

## Re-review Fix Evidence

### RED

Added a regression contract in `apps/api/test/domain-schema.test.ts` for both legacy `User.role` and `Invitation.role` conversions. Before the migration change:

```bash
pnpm --filter @led-control/api exec jest test/domain-schema.test.ts --runInBand
```

Result: FAIL, 1 suite / 13 tests, with the new `preserves legacy admin roles for users and invitations during conversion` test failing because both CASE expressions omitted `admin`.

### GREEN

Updated only the two migration CASE lists in `apps/api/prisma/migrations/20260721120000_simplify_roles_and_floor_revisions/migration.sql` so `owner`, `operator`, and `admin` map to `admin`, while the existing `ELSE 'viewer'` path preserves `viewer`.

Fix commit: `215859a fix(migration): preserve legacy admin roles`

Focused and static checks after the fix:

```bash
pnpm --filter @led-control/api exec jest test/domain-schema.test.ts src/auth/bootstrap-operator.spec.ts --runInBand
set -a; source ../../.env; set +a
pnpm --filter @led-control/api exec prisma validate
pnpm --filter @led-control/api typecheck
git diff --check
```

Result: 2 suites / 17 tests passed; Prisma schema valid; API typecheck passed; `git diff --check` passed.

### Disposable PostgreSQL Role Matrix

Applied the complete migration chain through the working-tree migration to a temporary PostgreSQL 16 container after inserting `owner`, `admin`, `operator`, and `viewer` rows in both `User` and `Invitation`.

Result:

```text
User:       admin->admin, operator->admin, owner->admin, viewer->viewer
Invitation: admin->admin, operator->admin, owner->admin, viewer->viewer
```

The disposable container was removed after verification.
