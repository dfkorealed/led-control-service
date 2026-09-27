import { FeatureOverview } from "./field-day/FeatureOverview";
import { PublicSiteLayout } from "./PublicSiteLayout";

export function FeaturesPage() {
  return <PublicSiteLayout page="features">{() => <main id="main" tabIndex={-1}>
    <FeatureOverview />
  </main>}</PublicSiteLayout>;
}
