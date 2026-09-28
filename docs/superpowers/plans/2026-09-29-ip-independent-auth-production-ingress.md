# IP-Independent Authentication and Production Ingress Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make local and production login independent of changing client/host IP addresses while preserving TLS, rate-limit, audit, device mTLS, and tenant security boundaries.

**Architecture:** Add one explicit local-app mode that rewrites only internal development connections to loopback and derives TLS identities from existing Lab DNS values. In production, keep same-origin browser traffic behind nginx, generalize the existing authenticated ingress secret for trusted client-IP forwarding, remove IP equality from login MFA ownership, and require stable DNS identities without adding redundant deployment settings.

**Tech Stack:** Node.js 22, pnpm 9.15, NestJS 11, React/Vite 5, nginx 1.27, MQTT.js 5, Redis, PostgreSQL/Prisma, Jest, Vitest, Node test, Playwright, Docker Compose

**Spec:** `docs/superpowers/specs/2026-09-29-ip-independent-auth-production-ingress-design.md`

## Global Constraints

- The only new user-managed environment variable is `DEV_LOCAL_APP_ONLY`; TLS server names and canonical hosts must be derived from existing values.
- Never disable TLS certificate verification or use `secure: false` as a recovery path.
- Keep default Lab/HIL network ownership checks fail-closed; only explicit local-app mode may tolerate stale public Lab addresses.
- Do not bind login MFA or an established session to an exact client IP or User-Agent.
- Preserve IP-based and account-based rate limits, audit records, one-time Redis challenges, TOTP replay protection, and session revocation.
- Do not enable global Express `trust proxy`; raw device TLS and browser HTTP continue to share the API process.
- Do not reset the database, regenerate device identity, revoke certificates, or mark an unreachable Gateway online.
- Update affected menu/runbook/status/lesson documentation in the same implementation.

## Review Focus

- A truthy-looking value such as `DEV_LOCAL_APP_ONLY=false` or `yes` must not silently enable the relaxed mode; the Task 1 parser test requires the exact value `1`.
- Loopback internal URLs with userinfo, paths, query strings, fragments, wrong schemes, or wrong ports must fail before services start; Task 1 table tests cover each class.
- A correctly formatted but wrong Web ingress secret, a duplicate client-IP header, or an invalid IPv4/IPv6 value must never become the authentication IP; Task 3 resolver tests cover these cases.
- An MFA challenge created on network A and completed on network B must use B for the session/audit/rate-limit completion while still rejecting replay and user-row changes; Task 4 service/integration tests cover this.
- Public production endpoints using localhost, container service names, private/literal IPs, or non-canonical Host values must fail closed without redirecting an authentication POST; Task 5 contract/container tests cover this.

---

### Task 1: Explicit local-app network contract

**Files:**
- Modify: `scripts/dev-runtime.test.mjs`
- Modify: `scripts/dev-runtime.mjs`
- Modify: `scripts/dev-network-preflight.mjs`
- Modify: `scripts/dev.mjs`
- Modify: `.env.example`

**Interfaces:**
- Consumes: existing `PKI_ENV`, `LAB_API_DNS`, `LAB_API_IP`, `LAB_MQTT_DNS`, `LAB_MQTT_IP`, `API_PORT`, `VITE_API_PROXY_TARGET`, `MQTT_URL`, and `MQTT_PUBLIC_URL`.
- Produces: `resolveDevEnvironment(root, source)` output where exact `DEV_LOCAL_APP_ONLY=1` derives loopback `VITE_API_PROXY_TARGET` and `MQTT_URL`, plus an exported local-app predicate/validation path reused by the launcher.

- [ ] **Step 1: Write failing local-app resolver and preflight tests**

  Add table-driven tests proving stale public Lab IPs pass only with exact `DEV_LOCAL_APP_ONLY=1`, internal targets are rewritten to `https://127.0.0.1:<API_PORT>` and `mqtts://127.0.0.1:8883`, existing Lab DNS values remain available for TLS identity, malformed loopback URLs fail, and default Lab mode retains every existing stale-address rejection.

- [ ] **Step 2: Run the focused tests and verify RED**

  Run: `node --test scripts/dev-runtime.test.mjs`

  Expected: new local-app tests fail because the mode and derived loopback contract do not exist; existing tests remain green.

- [ ] **Step 3: Implement the minimal resolver and launcher behavior**

  Parse only exact `1`, derive internal loopback targets after reading the existing `.env`, skip public-address ownership checks only in this mode, validate loopback scheme/host/port without mutating public endpoint values, and log that Gateway/HIL connectivity is not asserted. Keep the normal Lab branch unchanged.

- [ ] **Step 4: Verify focused GREEN and preflight behavior**

  Run: `node --test scripts/dev-runtime.test.mjs`

  Run: `DEV_LOCAL_APP_ONLY=1 pnpm dev:network-preflight`

  Expected: tests pass and the current stale `192.168.45.69` public Lab configuration no longer blocks the explicit local-app preflight.

- [ ] **Step 5: Commit Task 1**

  ```bash
  git add .env.example scripts/dev-runtime.mjs scripts/dev-runtime.test.mjs scripts/dev-network-preflight.mjs scripts/dev.mjs
  git commit -m "fix(dev): decouple local app startup from LAN IP"
  ```

### Task 2: Verified loopback TLS consumers

**Files:**
- Create: `apps/web/vite-api-proxy.ts`
- Create: `apps/web/vite-api-proxy.test.ts`
- Modify: `apps/web/vite.config.ts`
- Modify: `apps/api/src/mqtt/mqtt.service.spec.ts`
- Modify: `apps/api/src/mqtt/mqtt.service.ts`
- Modify: `apps/api/src/mqtt/command-set-mqtt.service.spec.ts`
- Modify: `apps/api/src/mqtt/command-set-mqtt.service.ts`
- Modify: `scripts/dev.mjs`

**Interfaces:**
- Consumes: Task 1's exact local-app mode and existing `LAB_API_DNS`/`LAB_MQTT_DNS` values.
- Produces: `createViteApiProxyOptions(env)` and MQTT connection options that set a TLS `servername` only for explicit local-app loopback connections while retaining `rejectUnauthorized: true`.

- [ ] **Step 1: Write failing proxy and MQTT TLS identity tests**

  Name the break: connecting to `127.0.0.1` verifies the IP instead of the certificate DNS identity, or disables verification. Assert that local-app options use `LAB_API_DNS`/`LAB_MQTT_DNS`, production/non-local options retain their current host identity, missing or invalid Lab DNS fails, and `rejectUnauthorized` stays true.

- [ ] **Step 2: Run focused tests and verify RED**

  Run: `pnpm --filter @led-control/web exec vitest run vite-api-proxy.test.ts`

  Run: `pnpm --filter @led-control/api exec jest src/mqtt/mqtt.service.spec.ts src/mqtt/command-set-mqtt.service.spec.ts --runInBand`

  Expected: new server-name assertions fail against current proxy/MQTT options.

- [ ] **Step 3: Implement shared behavior at each existing connection boundary**

  Use an HTTPS agent in Vite with CA verification and the derived API DNS server name, add the derived MQTT server name to both API MQTT clients, and pass the same identity to `waitForMqttTls`. Do not introduce a server-name environment variable.

- [ ] **Step 4: Verify focused GREEN and type checks**

  Run the focused commands from Step 2, then:

  Run: `pnpm --filter @led-control/api typecheck && pnpm --filter @led-control/web typecheck`

- [ ] **Step 5: Commit Task 2**

  ```bash
  git add apps/web/vite-api-proxy.ts apps/web/vite-api-proxy.test.ts apps/web/vite.config.ts apps/api/src/mqtt scripts/dev.mjs
  git commit -m "fix(tls): verify loopback services by Lab DNS identity"
  ```

### Task 3: Authenticated Web client-address boundary

**Files:**
- Create: `apps/api/src/http/web-ingress-client-ip.ts`
- Create: `apps/api/src/http/web-ingress-client-ip.spec.ts`
- Modify: `apps/api/src/landing-inquiries/landing-inquiry-client-ip.ts`
- Modify: `apps/api/src/landing-inquiries/landing-inquiries.controller.spec.ts`
- Modify: `apps/api/src/landing-inquiries/landing-ingress.integration.spec.ts`
- Modify: `apps/api/src/auth/auth.controller.ts`
- Modify: `apps/api/src/auth/auth.controller.spec.ts`
- Modify: `apps/web/nginx.conf.template`
- Modify: `apps/web/Dockerfile`
- Modify: `docker-compose.production.yml`

**Interfaces:**
- Consumes: existing `LANDING_INGRESS_SECRET`, request socket IP, request headers, and nginx `$remote_addr`.
- Produces: `trustedWebClientIp(request): string | null`; landing intake requires a non-null value in production, while auth uses `trustedWebClientIp(request) ?? request.ip ?? "unknown"`.

- [ ] **Step 1: Write failing resolver, controller, and real-nginx tests**

  Prove valid `X-Web-Ingress-Secret` + a single valid `X-Web-Client-IP` is trusted, missing/wrong/duplicate/invalid headers return null, auth falls back to socket IP, landing remains 503 fail-closed, and nginx overwrites attacker-supplied Web/forwarded headers.

- [ ] **Step 2: Run focused tests and verify RED**

  Run: `pnpm --filter @led-control/api exec jest src/http/web-ingress-client-ip.spec.ts src/auth/auth.controller.spec.ts src/landing-inquiries/landing-inquiries.controller.spec.ts src/landing-inquiries/landing-ingress.integration.spec.ts --runInBand`

  Expected: new generalized headers/resolver behavior is absent.

- [ ] **Step 3: Implement one shared ingress secret and resolver**

  Generalize the existing secret/header contract without adding a new environment variable. Use timing-safe comparison, accept one syntactically valid IP only, overwrite headers in nginx, and leave global `API_TRUST_PROXY` disabled.

- [ ] **Step 4: Verify focused GREEN and production nginx build contract**

  Run the focused Jest command, then:

  Run: `node --test apps/web/container-contract.node.mjs scripts/production-deploy-contract.test.mjs`

- [ ] **Step 5: Commit Task 3**

  ```bash
  git add apps/api/src/http apps/api/src/auth/auth.controller.ts apps/api/src/auth/auth.controller.spec.ts apps/api/src/landing-inquiries apps/web/nginx.conf.template apps/web/Dockerfile docker-compose.production.yml
  git commit -m "fix(auth): trust client IP only through authenticated Web ingress"
  ```

### Task 4: IP-independent login MFA completion

**Files:**
- Modify: `apps/api/src/auth/mfa.service.spec.ts`
- Modify: `apps/api/src/auth/mfa.service.ts`
- Modify: `apps/api/src/auth/auth-security.integration.spec.ts`
- Modify: `apps/web/e2e/auth-real.spec.ts`

**Interfaces:**
- Consumes: existing `LoginMfaChallenge`, one-time encrypted Redis challenge, current verified request IP/User-Agent, TOTP/recovery verification, and user row version.
- Produces: successful `completeLogin(input, completionIp, completionUserAgent)` that records completion observations in the new session/audit while challenge origin observations no longer authorize or deny the login.

- [ ] **Step 1: Replace the stale same-IP expectation with failing mobility tests**

  Assert origin IP/User-Agent may differ, completion IP/User-Agent reaches MFA rate limiting, session creation and success audit, while replay, expiry, wrong factor, recovery-code reuse and `userUpdatedAt` mismatch remain failures. Add real Redis/PostgreSQL coverage and a browser journey that changes only the trusted ingress client-IP between password and MFA requests.

- [ ] **Step 2: Run focused tests and verify RED**

  Run: `pnpm --filter @led-control/api exec jest src/auth/mfa.service.spec.ts src/auth/auth-security.integration.spec.ts --runInBand`

  Expected: mobility success fails at the current exact IP/User-Agent comparison.

- [ ] **Step 3: Implement minimal authorization change**

  Remove only the login challenge origin equality check. Keep origin snapshots for audit context, use completion observations for the created session and success/reset paths, and leave MFA enrollment's current-session binding unchanged.

- [ ] **Step 4: Verify focused GREEN and real browser auth**

  Run the focused Jest command, then:

  Run: `E2E_REAL_BACKEND_LAB=1 pnpm --filter @led-control/web exec playwright test e2e/auth-real.spec.ts --project=chromium --workers=1`

- [ ] **Step 5: Commit Task 4**

  ```bash
  git add apps/api/src/auth/mfa.service.ts apps/api/src/auth/mfa.service.spec.ts apps/api/src/auth/auth-security.integration.spec.ts apps/web/e2e/auth-real.spec.ts
  git commit -m "fix(auth): allow MFA completion across client IP changes"
  ```

### Task 5: Canonical production DNS and host contracts

**Files:**
- Modify: `scripts/production-deploy-contract.test.mjs`
- Modify: `scripts/production-compose-config.mjs`
- Modify: `apps/web/nginx.conf.template`
- Create: `apps/web/docker/05-canonical-host.envsh`
- Modify: `apps/web/Dockerfile`
- Modify: `scripts/gateway-bio-runtime.test.mjs`
- Modify: `scripts/gateway-bio-runtime.sh`
- Modify: `apps/gateway/src/bootstrap-only.test.ts`
- Modify: `apps/gateway/src/bootstrap-only.ts`

**Interfaces:**
- Consumes: existing `WEB_HTTPS_ORIGIN`, `WEB_PUBLIC_URL`, `MQTT_PUBLIC_URL`, and Gateway `GATEWAY_BOOTSTRAP_URL`.
- Produces: derived nginx canonical host, production URL validators that reject loopback/private/container/IP identities, and Gateway bootstrap preflight that accepts a stable DNS HTTPS endpoint without introducing a duplicate server environment variable.

- [ ] **Step 1: Write failing production and Gateway endpoint tests**

  Cover canonical valid DNS, literal IPv4/IPv6, localhost, Compose service names, RFC1918 targets, credentials/path/query/fragment, mismatched Web origins, and HTTPS login POST with a non-canonical Host returning a non-redirect error.

- [ ] **Step 2: Run focused tests and verify RED**

  Run: `node --test scripts/production-deploy-contract.test.mjs scripts/gateway-bio-runtime.test.mjs`

  Run: `pnpm --filter @led-control/gateway exec vitest run src/bootstrap-only.test.ts`

- [ ] **Step 3: Implement derived canonical-host and stable-DNS validation**

  Derive the host from `WEB_HTTPS_ORIGIN` in the nginx entrypoint fragment, validate it against `WEB_PUBLIC_URL`, reject non-canonical HTTPS requests without redirecting credentials, and strengthen existing public MQTT/Gateway URL checks. Add no new user-managed environment variable.

- [ ] **Step 4: Verify focused GREEN and production contracts**

  Run the focused commands, then:

  Run: `pnpm production:contract`

- [ ] **Step 5: Commit Task 5**

  ```bash
  git add scripts/production-deploy-contract.test.mjs scripts/production-compose-config.mjs scripts/gateway-bio-runtime.sh scripts/gateway-bio-runtime.test.mjs apps/web/nginx.conf.template apps/web/docker/05-canonical-host.envsh apps/web/Dockerfile apps/gateway/src/bootstrap-only.ts apps/gateway/src/bootstrap-only.test.ts
  git commit -m "fix(deploy): require canonical DNS service identities"
  ```

### Task 6: Documentation, current local recovery, and complete verification

**Files:**
- Modify: `docs/runbooks/device-lab-first-install.md`
- Modify: `docs/runbooks/production-api-web-deployment.md`
- Modify: `docs/runbooks/landing-mail-setup.md`
- Modify: `docs/menus/settings.md`
- Modify: `docs/lesson_leared.md`
- Modify: `docs/project-status.md`
- Local only, not committed: `.env`

**Interfaces:**
- Consumes: Tasks 1–5 and the user's current stale Lab configuration.
- Produces: repeatable local-app startup instructions, production DNS/secret/certificate rotation gates, updated feature status, and a running local API/Web where login returns an authentication result instead of proxy 500.

- [ ] **Step 1: Update documentation and the active checklist/status together**

  Document that only `DEV_LOCAL_APP_ONLY` is new, distinguish local app verification from HIL, record the generalized ingress secret/header names, specify production DNS/TLS staging tests, and supersede exact-IP login MFA wording.

- [ ] **Step 2: Apply the explicit local setting without touching secrets or identity**

  Add `DEV_LOCAL_APP_ONLY=1` to the ignored local `.env`; do not rewrite public Lab IPs, certificates, database data, Gateway IDs or private keys.

- [ ] **Step 3: Stop only the confirmed stale Web process and start the supported runtime**

  Resolve exact listener PIDs for 5173/4000, terminate only the stale repository-owned Vite process, start `pnpm dev` under a captured local log/session, and wait for API/Web health. Do not stop Docker data services or reset volumes.

- [ ] **Step 4: Verify the live login boundary**

  Check `GET /api/auth/me` returns 401 rather than proxy 500, an invalid login returns 401 rather than transport/500, `Set-Cookie` is issued only on valid credentials, and browser recovery UI clears when API is reachable. Do not reset an unknown user password merely to manufacture a successful login.

- [ ] **Step 5: Run fresh package and root verification**

  Run:

  ```bash
  pnpm --filter @led-control/api typecheck
  pnpm --filter @led-control/api test
  pnpm --filter @led-control/api build
  pnpm --filter @led-control/web typecheck
  pnpm --filter @led-control/web test
  pnpm --filter @led-control/web build
  pnpm --filter @led-control/gateway typecheck
  pnpm --filter @led-control/gateway test
  pnpm production:contract
  pnpm lint
  pnpm typecheck
  pnpm test
  pnpm build
  git diff --check
  ```

  Report every failure by command and test name; do not hide existing failures. Hardware online state, public DNS/TLS and cross-network staging remain explicitly unverified until those environments exist.

- [ ] **Step 6: Commit documentation/status and request whole-branch review**

  ```bash
  git add docs/runbooks/device-lab-first-install.md docs/runbooks/production-api-web-deployment.md docs/runbooks/landing-mail-setup.md docs/menus/settings.md docs/lesson_leared.md docs/project-status.md docs/superpowers/plans/2026-09-29-ip-independent-auth-production-ingress.md
  git commit -m "docs: record IP-independent authentication operations"
  ```

