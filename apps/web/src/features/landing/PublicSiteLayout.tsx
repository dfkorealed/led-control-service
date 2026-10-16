import type { MouseEvent, ReactNode } from "react";
import { Button } from "../../components/ui/Button";
import { PublicLogin } from "../../components/ui/public-site/PublicLogin";
import { PublicContactDialog } from "../../components/ui/public-site/PublicContactDialog";
import { SiteFrame } from "../../components/ui/public-site/SiteFrame";
import { useSiteConsultation } from "../../components/ui/public-site/useSiteConsultation";
import { CompanyFooter } from "./field-day/CompanyFooter";
import type { LandingPlan } from "./field-day/PricingSection";

export type OpenInquiry = (event: MouseEvent<HTMLButtonElement>, plan?: LandingPlan | null) => void;
type PublicPage = "home" | "features" | "pricing";
const pageTitles: Record<PublicPage, string> = { home: "킨다 | 스마트 조명 운영", features: "주요 기능 | 킨다", pricing: "요금제 | 킨다" };

export function PublicSiteLayout({ page, children }: { page: PublicPage; children: (openInquiry: OpenInquiry) => ReactNode }) {
  const contact = useSiteConsultation(pageTitles[page]);
  return <SiteFrame raisedHeader={contact.scrolled || page !== "home"} brandHref="/" brandLabel="킨다 홈" logoPresentation="landing"
    headerFrameClassName="phone-wide:max-w-[360px] compact:max-w-[760px] tablet:max-w-[1024px] landing-wide:landing-stack:min-h-[96px] landing-wide:landing-stack:flex-wrap landing-wide:landing-stack:gap-landing-header-frame-stacked-gap landing-wide:landing-stack:py-2.5"
    navigationClassName="landing-wide:landing-stack:w-full landing-wide:landing-stack:justify-between landing-wide:landing-stack:gap-2.5 landing-wide:landing-stack:text-landing-navigation-stacked landing-wide:landing-stack:landing-narrow:gap-1.5 landing-wide:landing-stack:landing-narrow:text-landing-navigation-narrow"
    navigation={<><a className="text-surface-panel no-underline hover:text-brand-coral" href="/features" aria-current={page === "features" ? "page" : undefined}>주요 기능</a>
      <a className="text-surface-panel no-underline hover:text-brand-coral" href="/pricing" aria-current={page === "pricing" ? "page" : undefined}>요금제</a>
      <Button ref={contact.headerContact} type="button" variant="landingHeaderContact" className="header-contact min-w-11" onClick={contact.open}>도입 상담</Button>
      <PublicLogin /></>}
    footer={<CompanyFooter />}
    consultation={contact.isOpen && <PublicContactDialog key={contact.selectedPlan ?? "general"} opener={contact.opener} plan={contact.selectedPlan} onClose={contact.close} />}>
    {children(contact.open)}
  </SiteFrame>;
}
