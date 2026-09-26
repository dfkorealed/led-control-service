import { useEffect, type RefObject } from "react";

interface LandingMotionProps {
  rootRef: RefObject<HTMLElement>;
  sectionRefs: Readonly<Record<string, RefObject<HTMLElement>>>;
}

/** Optional effects for the single public landing root; content never depends on them. */
export function LandingMotion({ rootRef, sectionRefs }: LandingMotionProps) {
  useEffect(() => {
    const root = rootRef.current;
    if (!root || typeof window.matchMedia !== "function") return;
    const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
    if (preference.matches) return;

    const sections = Object.values(sectionRefs).flatMap((ref) => ref.current ? [ref.current] : []);
    const seen = new Set<Element>();
    let observer: IntersectionObserver | undefined;
    let entrancesStopped = false;
    root.dataset.landingMotion = "ready";

    function stopEntrances() {
      entrancesStopped = true;
      observer?.disconnect();
      root!.removeAttribute("data-landing-hero-ready");
      sections.forEach((section) => section.removeAttribute("data-landing-revealed"));
    }

    function skipFocusedSection(event: FocusEvent) {
      root!.removeAttribute("data-landing-hero-ready");
      // Focused controls must remain still, including any nested reveal ancestors.
      sections.filter((section) => event.target instanceof Node && section.contains(event.target)).forEach((section) => {
        seen.add(section);
        observer?.unobserve(section);
        section.removeAttribute("data-landing-revealed");
      });
    }

    function stopForPreference() {
      if (!preference.matches) return;
      stopEntrances();
      root!.removeAttribute("data-landing-motion");
    }

    // Direct anchors skip entrances entirely so native scroll positioning stays stable.
    if (!window.location.hash) {
      root.dataset.landingHeroReady = "true";
      if (typeof IntersectionObserver === "function") {
        observer = new IntersectionObserver((entries) => {
          for (const entry of entries) {
            if (entrancesStopped || !entry.isIntersecting || seen.has(entry.target)) continue;
            seen.add(entry.target);
            observer?.unobserve(entry.target);
            if (!entry.target.contains(document.activeElement)) {
              (entry.target as HTMLElement).dataset.landingRevealed = "true";
            }
          }
        }, { threshold: 0.08 });
        sections.forEach((section) => observer!.observe(section));
      }
    }

    root.addEventListener("focusin", skipFocusedSection);
    window.addEventListener("hashchange", stopEntrances);
    preference.addEventListener?.("change", stopForPreference);
    return () => {
      stopEntrances();
      root.removeAttribute("data-landing-motion");
      root.removeEventListener("focusin", skipFocusedSection);
      window.removeEventListener("hashchange", stopEntrances);
      preference.removeEventListener?.("change", stopForPreference);
    };
  }, [rootRef, sectionRefs]);
  return null;
}
