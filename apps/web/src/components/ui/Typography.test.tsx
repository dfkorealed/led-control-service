import { createRef } from "react";
import { readFileSync } from "node:fs";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, expectTypeOf, it } from "vitest";
import { Heading, Text, IconButton, cn, themeColor, themeColorTokens } from ".";
import type { ButtonProps, ThemeColorToken, TypographyVariant } from ".";

afterEach(cleanup);

describe("typed typography and token adapters", () => {
  it("forwards the semantic heading ref without margins and merges caller colors", () => {
    const ref = createRef<HTMLHeadingElement>();
    render(<Heading ref={ref} as="h2" variant="section-title" className="text-content-secondary">제목</Heading>);
    expect(ref.current).toBe(screen.getByRole("heading", { name: "제목", level: 2 }));
    expect(ref.current).toHaveClass("m-0", "text-section-title", "text-content-secondary");
    expect(ref.current).not.toHaveClass("text-content-primary");
  });

  it.each(["display", "page-title", "section-title", "card-title", "body-lg", "body", "body-sm", "label", "caption", "overline", "metric"] as const)("keeps %s typography distinct from its color", (variant) => {
    render(<Text variant={variant} tone="muted">내용</Text>);
    expect(screen.getByText("내용")).toHaveClass("m-0", `text-${variant}`, "text-content-muted");
    if (variant === "metric") expect(screen.getByText("내용")).toHaveClass("tabular-nums");
  });

  it.each([
    ["primary", "text-content-primary"], ["secondary", "text-content-secondary"],
    ["muted", "text-content-muted"], ["inverse", "text-content-inverse"],
    ["danger", "text-status-danger-foreground"], ["success", "text-status-success-foreground"],
    ["warning", "text-status-warning-foreground"]
  ] as const)("maps %s to the semantic foreground", (tone, expected) => {
    render(<Text tone={tone}>내용</Text>);
    expect(screen.getByText("내용")).toHaveClass(expected);
  });

  it("forwards polymorphic label attributes, ref and supported font weight", () => {
    const ref = createRef<HTMLLabelElement>();
    render(<Text as="label" ref={ref} htmlFor="light-name" weight="semibold">조명명</Text>);
    expect(ref.current).toBe(screen.getByText("조명명"));
    expect(ref.current?.tagName).toBe("LABEL");
    expect(ref.current).toHaveAttribute("for", "light-name");
    expect(ref.current).toHaveClass("font-semibold");
  });

  it("keeps outside margins at zero even when a caller requests one", () => {
    render(<Text className="mt-4 mx-2">내용</Text>);
    expect(screen.getByText("내용")).toHaveClass("m-0");
    expect(screen.getByText("내용")).not.toHaveClass("mt-4", "mx-2");
  });

  it("keeps variants and color names closed at the public type boundary", () => {
    expectTypeOf<ButtonProps["variant"]>().toEqualTypeOf<"primary" | "secondary" | "ghost" | "danger" | "link" | "landingCta" | "landingHeaderContact" | "landingHeroContact" | "landingPlanPrimary" | "landingPlanSecondary" | undefined>();
    expectTypeOf<ButtonProps["size"]>().toEqualTypeOf<"sm" | "md" | "lg" | undefined>();
    expectTypeOf<string>().not.toExtend<ThemeColorToken>();
    expectTypeOf<string>().not.toExtend<TypographyVariant>();
  });

  it("merges caller spacing and custom typography utilities without dropping color", () => {
    expect(cn("p-4 text-body text-content-primary", false, null, undefined, "p-6 text-caption text-content-secondary"))
      .toBe("p-6 text-caption text-content-secondary");
  });

  it("covers every canonical color and reads current computed values without caching", () => {
    const declared = [...readFileSync("src/styles/theme.css", "utf8").matchAll(/--color-([\w-]+):/g)].map((match) => match[1]);
    expect([...themeColorTokens].sort()).toEqual(declared.sort());
    document.documentElement.style.setProperty("--color-chart-usage", "  rgb(37, 111, 161)  ");
    expect(themeColor("chart-usage")).toBe("rgb(37, 111, 161)");
    document.documentElement.style.setProperty("--color-chart-usage", "rgb(1, 2, 3)");
    expect(themeColor("chart-usage")).toBe("rgb(1, 2, 3)");
    document.documentElement.style.removeProperty("--color-chart-usage");
  });
});

// Compile-time misuse checks are deliberately never rendered or executed.
function rejectedPublicContracts() {
  // @ts-expect-error A typo must never become an arbitrary CSS variable lookup.
  themeColor("chart-usgae");
  // @ts-expect-error Typography variants are a closed semantic scale.
  <Text variant="giant">내용</Text>;
  // @ts-expect-error A paragraph must not accept label-only attributes.
  <Text as="p" htmlFor="name">내용</Text>;
  // @ts-expect-error The ref must match the chosen intrinsic element.
  <Text as="label" ref={createRef<HTMLButtonElement>()}>내용</Text>;
  // @ts-expect-error Icon-only actions must have an accessible name.
  <IconButton>+</IconButton>;
}
void rejectedPublicContracts;
