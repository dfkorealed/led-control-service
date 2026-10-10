import { describe, expect, it } from "vitest";
import { cn } from "./cn";

it("composes approved customer typography with foreground and replaces only the same breakpoint size", () => {
  expect(cn("text-body text-customer-page-title", "text-content-primary")).toBe("text-customer-page-title text-content-primary");
  expect(cn("text-customer-metric max-compact:text-metric max-compact:text-content-secondary", "max-compact:text-customer-page-title"))
    .toBe("text-customer-metric max-compact:text-content-secondary max-compact:text-customer-page-title");
});

it("replaces default width with approved customer geometry without losing responsive widths", () => {
  expect(cn("w-full", "w-customer-site-small phone-wide:w-customer-site compact:w-64")).toBe("w-customer-site-small phone-wide:w-customer-site compact:w-64");
  expect(cn("w-customer-sidebar", "w-customer-rail")).toBe("w-customer-rail");
  expect(cn("w-customer-site", "w-full")).toBe("w-full");
});

describe("approved landing typography composition", () => {
  it("keeps semantic size and foreground color together", () => {
    expect(cn("text-body text-landing-button", "text-brand-navy")).toBe("text-landing-button text-brand-navy");
    expect(cn("text-landing-navigation", "text-content-inverse")).toBe("text-landing-navigation text-content-inverse");
  });
  it("replaces only the size at the same responsive breakpoint", () => {
    expect(cn("text-landing-hero-fluid landing-stack:text-landing-hero-fluid-stacked landing-stack:text-brand-coral", "landing-stack:text-landing-hero-fluid-narrow")).toBe("text-landing-hero-fluid landing-stack:text-brand-coral landing-stack:text-landing-hero-fluid-narrow");
  });
});

it("merges approved surface corners and full or partial landing insets", () => {
  expect(cn("rounded-panel", "rounded-landing-glass-panel")).toBe("rounded-landing-glass-panel");
  expect(cn("px-5 py-3", "p-landing-button-inset")).toBe("p-landing-button-inset");
  expect(cn("p-landing-button-inset", "px-3")).toBe("p-landing-button-inset px-3");
  expect(cn("p-landing-button-inset", "p-4")).toBe("p-4");
});
