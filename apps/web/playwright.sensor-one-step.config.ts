import { defineConfig } from "@playwright/test";
import base from "./playwright.bio-control-operations.config";

export default defineConfig({ ...base, testMatch: "sensor-one-step.spec.ts",
  outputDir: "../../.superpowers/sdd/sensor-one-step-setup-20261015/browser-results" });
