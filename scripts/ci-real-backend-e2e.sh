#!/usr/bin/env bash
set -euo pipefail

if [ "${E2E_REAL_BACKEND_LAB:-}" != "1" ]; then
  echo "E2E_REAL_BACKEND_LAB must equal 1" >&2
  exit 1
fi

for command in initdb postgres createdb psql redis-server redis-cli mosquitto openssl lsof ps; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "$command is required for real-backend CI" >&2
    exit 1
  fi
done

pnpm --filter @led-control/web exec playwright test \
  e2e/installation-customer-journey.spec.ts \
  --project=chromium \
  --workers=1
