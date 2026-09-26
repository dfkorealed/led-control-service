import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LandingMotion } from "./LandingMotion";

let intersect: (element: Element) => void;
let preference: EventTarget & { matches: boolean };

function renderLanding() {
  return render(<main className="landing-page" data-testid="landing">
    <LandingMotion />
    <h1 className="landing-hero-heading">위치부터 결과까지</h1>
    <section data-landing-reveal id="contact" aria-label="상담">
      <button type="button">상담 시작</button>
    </section>
  </main>);
}

beforeEach(() => {
  intersect = () => undefined;
  preference = Object.assign(new EventTarget(), { matches: false });
  vi.stubGlobal("matchMedia", () => preference);
  // jsdom has no viewport observer; deliver browser events to the real component.
  vi.stubGlobal("IntersectionObserver", class {
    constructor(callback: IntersectionObserverCallback) {
      intersect = (target) => callback([{ target, isIntersecting: true } as IntersectionObserverEntry], this as unknown as IntersectionObserver);
    }
    observe() {}
    unobserve() {}
    disconnect() {}
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState({}, "", "/");
});

describe("LandingMotion", () => {
  it("keeps content visible before entry and reveals a section only once", () => {
    renderLanding();
    const section = screen.getByRole("region", { name: "상담" });
    expect(section).toBeVisible();
    expect(section).not.toHaveAttribute("data-landing-revealed");
    act(() => intersect(section));
    expect(section).toHaveAttribute("data-landing-revealed", "true");
    // A queued second observer event must not restart a completed animation.
    section.removeAttribute("data-landing-revealed");
    act(() => intersect(section));
    expect(section).not.toHaveAttribute("data-landing-revealed");
  });

  it("skips entrance motion for keyboard focus and ignores a later observer event", () => {
    renderLanding();
    expect(screen.getByTestId("landing")).toHaveAttribute("data-landing-hero-ready");
    const section = screen.getByRole("region", { name: "상담" });
    act(() => screen.getByRole("button").focus());
    act(() => intersect(section));
    expect(section).toBeVisible();
    expect(section).not.toHaveAttribute("data-landing-revealed");
    expect(screen.getByTestId("landing")).not.toHaveAttribute("data-landing-hero-ready");
  });

  it("cancels entrances on anchor navigation without affecting the destination", () => {
    renderLanding();
    expect(screen.getByTestId("landing")).toHaveAttribute("data-landing-hero-ready");
    const section = screen.getByRole("region", { name: "상담" });
    act(() => intersect(section));
    window.history.replaceState({}, "", "/#contact");
    fireEvent(window, new HashChangeEvent("hashchange"));
    expect(section).toBeVisible();
    expect(section).not.toHaveAttribute("data-landing-revealed");
    expect(screen.getByTestId("landing")).not.toHaveAttribute("data-landing-hero-ready");
  });

  it("does not animate content when opened directly at an anchor", () => {
    window.history.replaceState({}, "", "/#contact");
    renderLanding();
    expect(screen.getByRole("region", { name: "상담" })).toBeVisible();
    expect(screen.getByTestId("landing")).not.toHaveAttribute("data-landing-hero-ready");
  });

  it("leaves all content available when IntersectionObserver is missing", () => {
    vi.stubGlobal("IntersectionObserver", undefined);
    renderLanding();
    expect(screen.getByRole("region", { name: "상담" })).toBeVisible();
  });

  it("does not enable motion when reduced motion is preferred", () => {
    preference.matches = true;
    renderLanding();
    expect(screen.getByTestId("landing")).not.toHaveAttribute("data-landing-motion");
    expect(screen.getByRole("region", { name: "상담" })).toBeVisible();
  });

  it("removes active effects when reduced motion is enabled during the visit", () => {
    renderLanding();
    expect(screen.getByTestId("landing")).toHaveAttribute("data-landing-motion");
    const section = screen.getByRole("region", { name: "상담" });
    act(() => intersect(section));
    preference.matches = true;
    act(() => preference.dispatchEvent(new Event("change")));
    expect(screen.getByTestId("landing")).not.toHaveAttribute("data-landing-motion");
    expect(section).not.toHaveAttribute("data-landing-revealed");
  });
});
