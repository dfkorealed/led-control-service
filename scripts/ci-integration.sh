#!/usr/bin/env bash
set -euo pipefail

require_environment() {
  local name="$1"
  if [ -z "${!name:-}" ]; then
    echo "$name is required for disposable integration CI" >&2
    exit 1
  fi
}

for name in DATABASE_URL PKI_CONCURRENCY_TEST_DATABASE_URL REDIS_URL FIXTURE_IDENTIFY_TEST_REDIS_URL; do
  require_environment "$name"
done

if [ "${RUN_REDIS_INTEGRATION:-}" != "true" ]; then
  echo "RUN_REDIS_INTEGRATION must equal true" >&2
  exit 1
fi

node -e '
const [main, pki, redis, identifyRedis] = process.argv.slice(1).map((value) => new URL(value));
if (main.protocol !== "postgresql:" || main.pathname !== "/led_control") throw new Error("DATABASE_URL must target disposable led_control");
if (pki.protocol !== "postgresql:" || pki.pathname !== "/pki_concurrency") throw new Error("PKI_CONCURRENCY_TEST_DATABASE_URL must target dedicated pki_concurrency");
if (main.origin === pki.origin && main.pathname === pki.pathname) throw new Error("PKI concurrency database must be isolated");
if (redis.protocol !== "redis:" || identifyRedis.protocol !== "redis:" || redis.href === identifyRedis.href) throw new Error("Redis integration databases must be explicit and distinct");
' "$DATABASE_URL" "$PKI_CONCURRENCY_TEST_DATABASE_URL" "$REDIS_URL" "$FIXTURE_IDENTIFY_TEST_REDIS_URL"

export AUTH_TEST_DATABASE_URL="$DATABASE_URL"
export SITE_ACCESS_TEST_DATABASE_URL="$DATABASE_URL"
export SITE_USERS_TEST_DATABASE_URL="$DATABASE_URL"
export SITE_USER_ACCESS_MIGRATION_TEST_DATABASE_URL="$DATABASE_URL"
export FLOOR_EDITOR_TEST_DATABASE_URL="$DATABASE_URL"
export FIXTURE_IDENTIFY_TEST_DATABASE_URL="$DATABASE_URL"
export GATEWAY_ONBOARDING_REGISTRATION_TEST_DATABASE_URL="$DATABASE_URL"
export PKI_E2E_DATABASE_URL="$DATABASE_URL"
export AUTOMATION_SCHEDULES_TEST_DATABASE_URL="$DATABASE_URL"
export AUTOMATION_VEHICLE_EVENT_RULES_TEST_DATABASE_URL="$DATABASE_URL"

pnpm workspace:prepare
pnpm --filter @led-control/api prisma:generate
DATABASE_URL="$DATABASE_URL" pnpm --filter @led-control/api exec prisma migrate deploy
DATABASE_URL="$PKI_CONCURRENCY_TEST_DATABASE_URL" pnpm --filter @led-control/api exec prisma migrate deploy

pnpm --filter @led-control/api exec jest \
  src/auth/auth.integration.spec.ts \
  src/access/site-access.integration.spec.ts \
  src/site-users/site-users.integration.spec.ts \
  src/prisma/site-user-access-migration.integration.spec.ts \
  src/floor-editor/editor-lease.redis.integration.spec.ts \
  src/floor-editor/editor-lease.integration.spec.ts \
  src/floor-editor/floor-editor.integration.spec.ts \
  src/fixture-identify/fixture-identify.integration.spec.ts \
  src/gateway-onboarding/gateway-onboarding-registration.integration.spec.ts \
  src/pki/certificate-concurrency.integration.spec.ts \
  test/gateway-pki.e2e-spec.ts \
  test/automation-schedules.e2e-spec.ts \
  test/vehicle-event-rules.e2e-spec.ts \
  --runInBand
