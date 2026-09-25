# Kinda Landing Inquiry API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Receive public B2B consultations durably and email them to `kymkjh2002@dfkorealed.com` through a separate NAVER WORKS connection.

**Architecture:** A new Nest `landing-inquiries` module owns the public intake, the operator-only connection/status API, a bounded background delivery worker and 90-day pruning. Prisma stores an inquiry and encrypted OAuth credential; Redis limits anonymous intake. The module never reads customer tenant data.

**Tech Stack:** NestJS, Prisma/PostgreSQL, Redis, Node `crypto` and `fetch`, Jest.

**Spec:** `docs/superpowers/specs/2026-09-25-kinda-public-landing-design.md`

## Global Constraints

- Public recipient is fixed to `kymkjh2002@dfkorealed.com`; request input cannot change recipient or sender.
- Retain inquiry originals 90 days; consent version is `landing-2026-09-v1-90d`.
- `202 Accepted` means only provider acceptance. Unknown acceptance is terminal for automatic delivery.
- Do not copy secrets or OAuth tokens from `dfkorea-homepage`; use independent configuration and encrypted storage.
- No real email is sent in automated tests.
- Update `docs/database-schema.md` for every schema or migration change.

## Review Focus

1. Repeated POST after a lost response returns the same reference; the Task 1 idempotency test pins this behavior.
2. Same idempotency key with changed payload is rejected; the Task 1 conflict test pins this behavior.
3. Redis outage rejects anonymous intake without storing PII; the Task 1 rate-limit test pins this behavior.
4. Provider timeout after sending the body never causes automatic resend; the Task 3 uncertain test pins this behavior.
5. A stale OAuth callback cannot replace a fresh connection; the Task 2 single-use state test pins this behavior.

## File Structure

- `apps/api/src/landing-inquiries/landing-inquiry.dto.ts`: shared request schema and normalized hash input.
- `apps/api/src/landing-inquiries/landing-inquiries.controller.ts`: public submission and operator-only read/connection routes.
- `apps/api/src/landing-inquiries/landing-inquiries.service.ts`: intake, idempotency, fixed recipient and read model.
- `apps/api/src/landing-inquiries/landing-inquiry-rate-limit.service.ts`: Redis IP bucket.
- `apps/api/src/landing-inquiries/landing-mail-oauth.service.ts`: state, token exchange/refresh, encryption.
- `apps/api/src/landing-inquiries/landing-mail.transport.ts`: NAVER WORKS request and result classification.
- `apps/api/src/landing-inquiries/landing-mail.worker.ts`: bounded delivery and 90-day prune.
- `apps/api/src/landing-inquiries/landing-inquiries.module.ts`: providers and imports.
- `apps/api/prisma/schema.prisma`, a new migration, `apps/api/src/app.module.ts`, `docs/database-schema.md`: registration and persistence.

### Task 1: Public submission and durable inquiry

**Files:** `apps/api/prisma/schema.prisma`, new `apps/api/prisma/migrations/20260925*_landing_inquiry/migration.sql`, `apps/api/src/landing-inquiries/landing-inquiry.dto.ts`, `apps/api/src/landing-inquiries/landing-inquiries.service.ts`, `apps/api/src/landing-inquiries/landing-inquiry-rate-limit.service.ts`, `apps/api/src/landing-inquiries/landing-inquiries.controller.ts`, `apps/api/src/landing-inquiries/landing-inquiries.module.ts`, `apps/api/src/app.module.ts`, tests beside each unit, `docs/database-schema.md`.

**Interfaces:** `submit(input: LandingInquiryInput, ip: string): Promise<{reference: string; status: "received"}>`; `POST /landing/inquiries`; `getConnectionStatus(): Promise<{connected: boolean}>` from Task 2 gates new submissions. Define the latter behind an injected interface that Task 1 tests can fake.

- [x] **Step 1: Write failing intake tests.** Use valid payload below; assert 201/reference, same key same result, changed payload 409, malformed/oversize/consent/honeypot 400 or 422, IP limit 429, Redis outage 503, unconnected mail 503. Assert no query/mutation occurs on rejection.

```ts
const valid = { idempotencyKey: crypto.randomUUID(), companyName: "테스트 시설", contactName: "홍길동", email: "owner@example.com", phone: "", audience: "facility", message: "B2 주차장 도입 상담", consent: true, consentVersion: "landing-2026-09-v1-90d", website: "" };
expect(await service.submit(valid, "127.0.0.1")).toEqual({ reference: expect.stringMatching(/^K-\d{8}-/), status: "received" });
```

- [x] **Step 2: Run the focused Jest tests and verify they fail because the service/route is missing.** Run `pnpm --filter @led-control/api exec jest src/landing-inquiries --runInBand`.
- [x] **Step 3: Add `LandingInquiry` schema and forward migration.** Include unique `idempotencyKey`, payload hash, reference, contact fields, consent, `createdAt`, `expiresAt`, `deliveryStatus`, attempt/lease fields and timestamps. Generate Prisma Client; document each field and 90-day retention in `docs/database-schema.md`. Do not change existing migration files.
- [x] **Step 4: Implement schema validation, Redis IP bucket and transactional intake.** Canonicalize trimmed fields before hashing; hash JSON in fixed key order; check idempotency before rate-limit consumption for exact retries. If a matching key exists, compare payload hash. For a new key, check mail readiness, consume the rate bucket and insert once. Return a random reference. The recipient is absent from request and DB input.
- [x] **Step 5: Run focused tests, Prisma validate/generate, API typecheck; commit Task 1.** Run `pnpm --filter @led-control/api exec prisma validate`, `pnpm --filter @led-control/api prisma:generate`, `pnpm --filter @led-control/api typecheck`, focused Jest, `git diff --check`.

### Task 2: Independent NAVER WORKS OAuth connection

**Files:** `apps/api/prisma/schema.prisma`, new follow-up migration if Task 1 was committed, `apps/api/src/landing-inquiries/landing-mail-oauth.service.ts`, `apps/api/src/landing-inquiries/landing-mail-token-cipher.ts`, operator/status/callback routes in controller, tests, `docs/database-schema.md`.

**Interfaces:** `getConnectionStatus(): Promise<{connected: boolean}>`, `beginAuthorization(operatorId: string): Promise<{authorizationUrl: string}>`, `completeAuthorization(code: string, state: string): Promise<void>`, `getAccessToken(forceRefresh?: boolean): Promise<string>`.

- [x] **Step 1: Write failing tests.** Operator auth is required for begin/status/list; only an exact fresh single-use state may finish callback; token records are AES-256-GCM encrypted; expired access token refreshes; a second callback cannot overwrite it; absent/malformed secret config is disconnected rather than a process-wide crash.

```ts
const first = await oauth.beginAuthorization("operator-1");
await oauth.completeAuthorization("code-1", new URL(first.authorizationUrl).searchParams.get("state")!);
await expect(oauth.completeAuthorization("code-2", new URL(first.authorizationUrl).searchParams.get("state")!)).rejects.toMatchObject({ status: 400 });
```

- [x] **Step 2: Run focused Jest and confirm expected RED.** Run `pnpm --filter @led-control/api exec jest src/landing-inquiries --runInBand`.
- [x] **Step 3: Add OAuth credential/state persistence and token cipher.** Store only ciphertext, IV/tag, expiry and state hash. State expires after 10 minutes and is consumed transactionally. Require HTTPS official NAVER WORKS hosts, `mail` scope and exact configured redirect URI. Implement authorization-code and refresh-token exchanges with short timeouts and no token/body logging.
- [x] **Step 4: Add guarded operator routes and public callback.** Use `SessionAuthGuard`, `RolesGuard`, `@Roles("operator")` for operator routes. The callback accepts only valid state/code, stores encrypted tokens and redirects to `/operator/landing-inquiries?mail=connected`; reject invalid state without redirecting secrets.
- [x] **Step 5: Run focused tests, Prisma validate/generate and API typecheck; commit Task 2.** Never place real credentials in tests or source.

### Task 3: Mail transport, bounded worker and 90-day deletion

**Files:** `apps/api/src/landing-inquiries/landing-mail.transport.ts`, `apps/api/src/landing-inquiries/landing-mail.worker.ts`, `apps/api/src/landing-inquiries/landing-mail-renderer.ts`, operator list route in controller, tests, `docs/database-schema.md`.

**Interfaces:** `send(message: {subject: string; html: string; text: string}): Promise<"provider_accepted">`; `deliverDue(now?: Date): Promise<number>`; `pruneExpired(now?: Date): Promise<number>`; `GET /operator/landing-inquiries` returns recent references, contact details and delivery status with bounded pagination.

- [ ] **Step 1: Write failing renderer/transport/worker tests.** Escape untrusted company/name/message in HTML and strip CR/LF from subject. Simulate 202, 401 then refresh, 429, 4xx, 5xx, network timeout; assert only 202 is accepted, only confirmed pre-send failures retry, and unknown acceptance is terminal. Assert two workers cannot claim the same row and 90-day prune deletes expired inquiries but leaves unexpired ones.

```ts
await worker.deliverDue(new Date("2026-09-25T00:00:00Z"));
expect(await prisma.landingInquiry.findUnique({ where: { id: inquiry.id } })).toMatchObject({ deliveryStatus: "provider_accepted" });
```

- [ ] **Step 2: Run focused Jest and confirm expected RED.** Run `pnpm --filter @led-control/api exec jest src/landing-inquiries --runInBand`.
- [ ] **Step 3: Implement safe mail rendering and fixed recipient transport.** Follow the local `dfkorea-homepage/dfkorea-backend/src/tenders/mail/naver-works-mail.transport.ts` outcome rules, adapting them into this repository rather than importing across projects. Use only server-side sender configuration. Do not include client supplied HTML in a template without escaping.
- [ ] **Step 4: Implement worker claims, outcome persistence, and prune.** A bounded `FOR UPDATE SKIP LOCKED` claim or equivalent atomic transaction prevents multi-instance duplicates. Pre-send OAuth/429 failures get a finite backoff; unknown acceptance is terminal. Timers are disabled in `NODE_ENV=test`, unref'd in production and drained on module destroy. Prune deletes at most a bounded batch per run and logs counts only, never PII.
- [ ] **Step 5: Add operator-only bounded list/status API and test authorization.** Return no secrets and no unlimited full-table scans. Include delivery errors by safe code, not provider response bodies.
- [ ] **Step 6: Run API focused and full tests, typecheck/build and migration rehearsal; commit Task 3.** Run `pnpm --filter @led-control/api test`, `pnpm --filter @led-control/api typecheck`, `pnpm --filter @led-control/api build`, `git diff --check`. Use a disposable PostgreSQL for migration verification; do not migrate a user or production DB.

### Task 4: Operational documentation and status

**Files:** `docs/menus/landing.md`, `docs/menus/operator.md`, `docs/project-status.md`, `docs/database-schema.md`, `docs/runbooks/landing-mail-setup.md`, `AGENTS.md`.

**Interfaces:** The Web plan consumes the exact Task 1 public contract and Task 2/3 operator routes.

- [ ] **Step 1: Document required NAVER WORKS `mail` scope, sender user ID, client ID/secret, callback URL and encryption key without values.** Explain initial operator connection, status, 202 meaning, failure/uncertain triage and 90-day deletion. Do not copy the other project's actual secrets.
- [ ] **Step 2: Maintain the required menu headings: `구현 완료`, `미구현`, `부족하거나 개선이 필요한 기능`, `관련 파일`, `갱신 규칙`.** Add landing/operator menu document paths to the list in `AGENTS.md`. Record that live OAuth/email receipt is unverified without production credentials.
- [ ] **Step 3: Align `docs/project-status.md` with the implementation checklist and commit documentation.**
