import { PublicInnerPage } from "../../components/ui/public-site/PublicInnerPage";
import { PricingSection } from "./field-day/PricingSection";
import { PublicSiteLayout } from "./PublicSiteLayout";

export function PricingPage() {
  return <PublicSiteLayout page="pricing">{openInquiry => <PublicInnerPage>
    <PricingSection onInquiry={openInquiry} />
  </PublicInnerPage>}</PublicSiteLayout>;
}
