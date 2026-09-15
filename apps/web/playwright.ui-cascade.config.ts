import { defineConfig } from "@playwright/test";
import shared from "./playwright.config";

// This suite serves a production build from memory; a dev server or backend
// would add unrelated dependencies and could mask the production CSS cascade.
export default defineConfig({
  ...shared,
  testMatch: "ui-cascade.spec.ts",
  workers: 1,
  webServer: undefined
});
