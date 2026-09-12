#!/usr/bin/env bash
set -euo pipefail

command -v docker >/dev/null 2>&1 || { echo "docker is required for production audit" >&2; exit 1; }
docker version >/dev/null
docker info >/dev/null
docker compose version >/dev/null
docker compose -f docker-compose.yml -f docker-compose.production.yml config --quiet

cleanup() {
  docker image rm -f led-control-web:test >/dev/null 2>&1 || true
}
trap cleanup EXIT

pnpm workspace:prepare
node --test tests/mqtt-production-config.node.mjs
pnpm --filter @led-control/gateway test:contracts
MQTT_INTEGRATION_REQUIRED=1 pnpm mqtt:integration
pnpm gateway:release:ci
pnpm --filter @led-control/web test:bundle-audit
node --test apps/web/container-contract.node.mjs
pnpm audit:production
