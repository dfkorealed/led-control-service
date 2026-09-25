# Kinda Public Landing Web Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a calm dashboard-led public landing page that introduces Kinda to facility operators and lighting partners and accepts consultation requests.

**Architecture:** A public entry at `/` renders without mounting the authenticated `AppRoot`. A small landing feature owns the narrative sections and form, reusing the existing brand logo and common UI primitives. The operator shell gains a protected inquiry/connection screen that consumes the API plan.

**Tech Stack:** React 18, Vite, Tailwind 4/CSS, React Router 7 for existing authenticated routes, Vitest/Testing Library and Playwright.

**Spec:** `docs/superpowers/specs/2026-09-25-kinda-public-landing-design.md`

## Global Constraints

- Public `/` must render without an `/auth/me` request. Existing login, customer and operator routes must retain current behavior.
- The selected visual direction is a **calm layout led by a dashboard preview**. Use approved Kinda colors and logo; do not copy Figma graphics or copy.
- `제품 화면 예시` must remain visible near the illustrative dashboard. No invented performance, energy saving or customer claims.
- Send to `POST /landing/inquiries` through the existing `/api` proxy. Consent version is `landing-2026-09-v1-90d` and the email destination is fixed server-side.
- A contact error never clears input; retry after an uncertain response reuses the same idempotency key.
- Reusable buttons/cards stay under `apps/web/src/components/ui`; feature-specific layout stays under `apps/web/src/features/landing`.

## Review Focus

1. A visitor can view `/` during API outage; the Task 1 no-auth-fetch test pins it.
2. At 320px no section or decorative element creates horizontal scroll; Task 2 Playwright pins it.
3. A timeout after sending does not create a second inquiry on retry; Task 3 idempotency-key test pins it.
4. Form errors preserve every field and focus an actionable message; Task 3 UI tests pin it.
5. A customer or viewer cannot see operator inquiries; Task 4 route/auth tests pin it.

## File Structure

- `apps/web/src/features/landing/LandingPage.tsx`: public page sections, anchors, metadata and footer.
- `apps/web/src/features/landing/DashboardPreview.tsx`: semantic illustrative product panel.
- `apps/web/src/features/landing/InquiryForm.tsx`: consent, validation, submission and outcome UI.
- `apps/web/src/features/landing/landing.css`: isolated page styles and responsive rules.
- `apps/web/src/api/landing-inquiries.ts`: typed request/response and safe error classification.
- `apps/web/src/features/operator/LandingInquiriesView.tsx`: operator-only mail status and inquiry list.
- `apps/web/src/main.tsx`, `apps/web/src/features/operator/OperatorShell.tsx`: route integration.
- Focused Vitest files beside features, `apps/web/e2e/landing.spec.ts`: behavior and browser checks.

### Task 1: Public route boundary and document metadata

**Files:** `apps/web/src/main.tsx`, `apps/web/src/features/landing/LandingPage.tsx`, `apps/web/src/features/landing/LandingPage.test.tsx`, `apps/web/index.html`.

**Interfaces:** `LandingPage` is a standalone React component; `/` maps to it before `AppRoot` is mounted; `/login` still mounts the existing authenticated app.

- [ ] **Step 1: Write failing public-route tests.** Render the entry with path `/` and assert the main heading, inquiry anchor and zero `/api/auth/me` calls; render `/login` and assert existing auth behavior. Preserve existing App recovery tests.

```tsx
expect(screen.getByRole("heading", { name: /조명 운영을 간단하게/ })).toBeInTheDocument();
expect(fetchMock.mock.calls.some(([url]) => String(url).includes("/auth/me"))).toBe(false);
```

- [ ] **Step 2: Run the focused Vitest and verify RED due to missing public entry.** Run `pnpm --filter @led-control/web exec vitest run src/features/landing/LandingPage.test.tsx`.
- [ ] **Step 3: Route `/` to `LandingPage` and all other paths to `AppRoot`.** Use normal anchors for public-to-auth navigation so pathname changes cause a full, predictable entry switch. Do not nest a second BrowserRouter. Add Korean title/description and social metadata in `index.html` without claiming an unverified benefit.
- [ ] **Step 4: Run focused tests and existing `App.recovery.test.tsx`; commit Task 1.**

### Task 2: Dashboard-led landing narrative

**Files:** `apps/web/src/features/landing/LandingPage.tsx`, `DashboardPreview.tsx`, `landing.css`, focused tests, `apps/web/e2e/landing.spec.ts`.

**Interfaces:** Sections have stable `id="product"`, `id="benefits"`, `id="contact"` anchors. `DashboardPreview` has an accessible `제품 화면 예시` description.

- [ ] **Step 1: Write failing content/semantic tests.** Assert Kinda logo, visible example label, operator and partner value headings, valid anchor targets, unique h1, meaningful CTA and absence of fabricated savings/availability numbers.

```tsx
expect(screen.getByRole("img", { name: "킨다" })).toBeInTheDocument();
expect(screen.getByText("제품 화면 예시")).toBeVisible();
expect(screen.getByRole("heading", { name: /시설 운영/ })).toBeInTheDocument();
expect(screen.getByRole("heading", { name: /시공·유통/ })).toBeInTheDocument();
```

- [ ] **Step 2: Run focused Vitest and verify expected RED.**
- [ ] **Step 3: Implement the visual hierarchy.** Put the dashboard preview in the hero, with site/floor/map/status/feature relationships but no invented operational metrics. Use existing `KindaLogo` and common UI primitives; keep decorative blocks hidden from assistive technology. Use brand Navy/Paper as broad surfaces, Blue for CTAs, Coral for limited accent, responsive spacing and `prefers-reduced-motion`.
- [ ] **Step 4: Add Playwright checks for 1440/1024/390/320px.** Assert navigation and CTA reach their anchors, no horizontal overflow, visible hero/dashboard, and usable touch targets. Run the focused Chromium scenario; commit Task 2.

### Task 3: Consultation form and API handling

**Files:** `apps/web/src/api/landing-inquiries.ts`, `apps/web/src/features/landing/InquiryForm.tsx`, `InquiryForm.test.tsx`, `landing.css`, `apps/web/e2e/landing.spec.ts`.

**Interfaces:** `submitLandingInquiry(input: LandingInquiryInput, signal?: AbortSignal): Promise<{reference: string; status: "received"}>` sends the backend plan's exact request body. `InquiryForm` owns its generated UUID until payload change or confirmed success.

- [ ] **Step 1: Write failing form tests.** Required fields and consent block submit; valid submit sends normalized values and stable UUID; timeout/transport/5xx keeps inputs and key; edit after failure creates a new key; 429 and 503 show distinct Korean messages; 503 offers `mailto:kymkjh2002@dfkorealed.com`; success displays the server reference and leaves no misleading claim about email delivery.

```tsx
await user.click(screen.getByRole("button", { name: "상담 문의 보내기" }));
expect(posted.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/i);
expect(posted.consentVersion).toBe("landing-2026-09-v1-90d");
```

- [ ] **Step 2: Run focused Vitest and verify RED.** Run `pnpm --filter @led-control/web exec vitest run src/features/landing/InquiryForm.test.tsx`.
- [ ] **Step 3: Implement form, inline 90-day disclosure and outcome states.** Fields: company, contact, email, optional phone, facility/partner, message, consent; include visually hidden `website` honeypot. Use existing field/Button/FeedbackState components where contracts fit. Keep validation readable and focus the error heading or first invalid field. Never put recipient in submitted JSON.
- [ ] **Step 4: Run focused Vitest and Playwright submission scenarios.** Mock API accepted, 429, 503, timeout and delayed response; assert stable key and preserved inputs. Commit Task 3.

### Task 4: Protected operator inquiry and mail connection screen

**Files:** `apps/web/src/features/operator/LandingInquiriesView.tsx`, focused test, `apps/web/src/features/operator/OperatorShell.tsx`, `apps/web/src/api/landing-inquiries.ts`, `apps/web/e2e/landing.spec.ts`.

**Interfaces:** Reads `GET /operator/landing-inquiries` and `GET /operator/landing-mail/status`; starts OAuth with `POST /operator/landing-mail/authorize`. The operator route is `/operator/landing-inquiries`.

- [ ] **Step 1: Write failing route tests.** Operator can navigate to inquiry/status screen; customer/viewer cannot mount the route; mail connect button navigates only to a server-returned official NAVER WORKS authorization URL; list shows safe status labels and recent references without tokens.
- [ ] **Step 2: Run focused Vitest and verify RED.** Run `pnpm --filter @led-control/web exec vitest run src/features/operator/LandingInquiriesView.test.tsx`.
- [ ] **Step 3: Add route and minimal operator nav link.** Keep existing default operator route and auth guards; show connection state, bounded recent inquiry list, safe failure guidance, and no automatic resend control. Use common Button/Card rather than new copies.
- [ ] **Step 4: Run focused Vitest, authenticated route Playwright and Web typecheck; commit Task 4.**

### Task 5: Final integration and documentation

**Files:** `docs/menus/landing.md`, `docs/menus/operator.md`, `docs/project-status.md`, plan checkboxes.

- [ ] **Step 1: Update menu documents with the required five headings.** Distinguish software/mock/browser checks from real NAVER WORKS OAuth/send confirmation. Record the public route, form, operator status and remaining mail setup.
- [ ] **Step 2: Run `pnpm --filter @led-control/web typecheck`, `pnpm --filter @led-control/web test`, `pnpm --filter @led-control/web build`, UI policy and focused Playwright; inspect the page at 1440 and 390px.** Correct issues before claiming completion.
- [ ] **Step 3: Update `docs/project-status.md` and both plan checklists from actual evidence, run `git diff --check`, then commit.**
