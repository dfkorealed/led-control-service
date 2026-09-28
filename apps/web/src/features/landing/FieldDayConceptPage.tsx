import { useLayoutEffect } from "react";
import { LandingStory } from "./LandingPage";
import { PublicSiteLayout } from "./PublicSiteLayout";

export function FieldDayConceptPage(): JSX.Element {
  useLayoutEffect(() => {
    // Fragment navigation belongs to the document scroller in the original
    // native concept; the site variant keeps its own per-anchor margin.
    const classes = ["scheme-light", "scroll-smooth", "motion-reduce:scroll-auto", "scroll-pt-landing-html-scroll-padding", "landing-stack:scroll-pt-landing-html-stacked-scroll-padding"];
    document.documentElement.classList.add(...classes);
    return () => document.documentElement.classList.remove(...classes);
  }, []);
  return <PublicSiteLayout page="concept">{onInquiry => <LandingStory onInquiry={onInquiry} visualVariant="concept" />}</PublicSiteLayout>;
}
