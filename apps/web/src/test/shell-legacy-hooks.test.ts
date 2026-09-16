import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const sourceHooks: Record<string, readonly string[]> = {
  "components/brand/KindaLogo.tsx": ["kinda-logo", "kinda-logo-mark", "kinda-logo-copy"],
  "features/auth/AuthView.tsx": [
    "auth-shell",
    "auth-brand-panel",
    "auth-brand",
    "auth-panel",
    "auth-heading",
    "auth-helper",
    "auth-form",
    "auth-submit",
    "check-field"
  ],
  "features/operator/OperatorShell.tsx": [
    "operator-shell",
    "operator-header",
    "operator-brand",
    "operator-header-actions",
    "operator-login-id",
    "operator-content",
    "operator-navigation",
    "logout-button"
  ],
  "features/operator/site-admins/ResetAdminPasswordDialog.tsx": ["operator-form"],
  "features/operator/site-admins/SiteAdminFormDialog.tsx": ["operator-form", "operator-form-grid"],
  "features/operator/site-admins/SiteAdminManagementView.tsx": [
    "operator-admin-management",
    "operator-summary-grid",
    "operator-table-wrap",
    "operator-admin-table",
    "operator-table-empty",
    "operator-row-actions"
  ],
  "features/shells/CustomerShell.tsx": [
    "app-shell",
    "bottom-nav",
    "nav-list",
    "sidebar",
    "content",
    "topbar",
    "topbar-actions",
    "site-pill",
    "logout-button"
  ],
  "features/shells/SettingsNavigationItem.tsx": ["nav-item"]
};

describe("shell, auth, and operator production styles", () => {
  for (const [relativePath, legacyHooks] of Object.entries(sourceHooks)) {
    it(`${relativePath} does not depend on legacy stylesheet hooks`, () => {
      const source = readFileSync(resolve(process.cwd(), "src", relativePath), "utf8");

      for (const hook of legacyHooks) {
        expect(source, `${relativePath} still contains ${hook}`).not.toMatch(
          new RegExp(`(?:^|[\\s\"'])${hook}(?=$|[\\s\"'])`, "m")
        );
      }
    });
  }
});
