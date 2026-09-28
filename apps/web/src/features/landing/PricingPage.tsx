import { PricingSection } from "./field-day/PricingSection";
import { PublicSiteLayout } from "./PublicSiteLayout";

export function PricingPage() {
  return <PublicSiteLayout page="pricing">{openInquiry => <main className="scroll-mt-landing-anchor-anchor-offset" id="main" tabIndex={-1}>
    <PricingSection onInquiry={openInquiry} />
  </main>}</PublicSiteLayout>;
}
