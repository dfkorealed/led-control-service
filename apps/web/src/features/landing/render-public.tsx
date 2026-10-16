// The browser server renderer supports renderToString without Node builtins.
// It is bundled only for the build step and never published as a browser asset.
import { renderToString } from "react-dom/server.browser";
import { PublicLandingEntry } from "./PublicLandingEntry";
import { publicPageSeo, publicSiteOrigin } from "./public-seo";

export function renderPublicPages() {
  return {
    origin: publicSiteOrigin,
    pages: Object.values(publicPageSeo).map(seo => ({
      ...seo,
      body: renderToString(<PublicLandingEntry pathname={seo.pathname} />)
    }))
  };
}
