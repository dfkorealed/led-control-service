import { PublicInnerPage } from "../../components/ui/public-site/PublicInnerPage";
import { FeatureOverview } from "./field-day/FeatureOverview";
import { PublicSiteLayout } from "./PublicSiteLayout";

export function FeaturesPage() {
  return <PublicSiteLayout page="features">{() => <PublicInnerPage>
    <FeatureOverview />
  </PublicInnerPage>}</PublicSiteLayout>;
}
