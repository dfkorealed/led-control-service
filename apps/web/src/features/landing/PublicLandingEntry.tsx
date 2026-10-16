import { LandingPage } from "./LandingPage";
import { FeaturesPage } from "./FeaturesPage";
import { PricingPage } from "./PricingPage";
import { LinkButton } from "../../components/ui/LinkButton";

/** Explicit pathname keeps the same page tree usable in Node and the browser. */
export function PublicLandingEntry({ pathname }: { pathname: string }) {
  switch (pathname) {
    case "/": return <LandingPage />;
    case "/features": return <FeaturesPage />;
    case "/pricing": return <PricingPage />;
    default: return <main className="flex min-h-dvh flex-col items-center justify-center gap-6 bg-brand-paper p-6 text-center text-brand-navy">
      <h1 className="text-page-title font-bold">페이지를 찾을 수 없습니다.</h1>
      <p className="text-body">주소를 확인하거나 킨다 홈으로 이동해 주세요.</p>
      <LinkButton href="/">킨다 홈으로</LinkButton>
    </main>;
  }
}
