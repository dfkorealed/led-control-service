import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { KindaLogo } from "../../components/brand/KindaLogo";
import { Button } from "../../components/ui/Button";
import { LinkButton } from "../../components/ui/LinkButton";
import { ModalDialog } from "../../components/ui/ModalDialog";
import { CompanyFooter } from "./field-day/CompanyFooter";
import type { LandingPlan } from "./field-day/PricingSection";
import { InquiryForm } from "./InquiryForm";
import "./field-day.css";

export type OpenInquiry = (event: MouseEvent<HTMLButtonElement>, plan?: LandingPlan | null) => void;
type PublicPage = "home" | "features" | "pricing";
const pageTitles: Record<PublicPage, string> = { home: "킨다 | 스마트 조명 운영", features: "주요 기능 | 킨다", pricing: "요금제 | 킨다" };

function ConsultationDialog({ opener, onClose, plan }: { opener: HTMLElement | null; onClose: () => void; plan: LandingPlan | null }) {
  const [pending, setPending] = useState(false);
  // Preserve the rendered ModalDialog corner: the old unmerged 18px override
  // lost to rounded-panel in the baseline cascade, which displayed 14px.
  return <ModalDialog isOpen title="도입 상담" description="현장에 필요한 관제 구성을 함께 살펴보겠습니다."
    closeLabel="상담 팝업 닫기" onClose={onClose} isPending={pending} returnFocusElement={opener}
    className="w-[min(650px,100%)]! max-h-[calc(100dvh-32px)]! rounded-panel! p-5! compact:p-8!"
    bodyClassName="field-day-inquiry-body">
    {plan && <p className="inquiry-selected-plan m-0 mb-4.5 rounded-landing-compact-summary-surface bg-action-primary-soft p-landing-inquiry-plan-inset text-landing-inquiry-plan text-brand-navy">선택한 요금제: <strong className="text-brand-blue">{plan}</strong></p>}
    <InquiryForm presentation="dialog" selectedPlan={plan} initialMessage={plan ? `${plan} 요금제 도입 상담을 받고 싶습니다.` : ""} onPendingChange={setPending} />
  </ModalDialog>;
}

export function PublicSiteLayout({ page, children }: { page: PublicPage; children: (openInquiry: OpenInquiry) => ReactNode }) {
  const [inquiryOpen, setInquiryOpen] = useState(false);
  const [opener, setOpener] = useState<HTMLElement | null>(null);
  const [selectedPlan, setSelectedPlan] = useState<LandingPlan | null>(null);
  const [scrolled, setScrolled] = useState(false);
  const headerInquiry = useRef<HTMLButtonElement>(null);

  useEffect(() => { document.title = pageTitles[page]; }, [page]);
  useEffect(() => {
    const update = () => setScrolled(window.scrollY > 24);
    window.addEventListener("scroll", update, { passive: true });
    update();
    return () => window.removeEventListener("scroll", update);
  }, []);
  useEffect(() => {
    // Old contact bookmarks open the shared modal, including after a plan inquiry on this page.
    const handleHash = () => {
      if (window.location.hash !== "#contact") return;
      setOpener(headerInquiry.current);
      setSelectedPlan(null);
      setInquiryOpen(true);
      window.history.replaceState(window.history.state, "", window.location.pathname + window.location.search);
    };
    handleHash();
    window.addEventListener("hashchange", handleHash);
    return () => window.removeEventListener("hashchange", handleHash);
  }, []);
  useEffect(() => {
    // Public SPA targets mount after the browser's initial fragment scroll.
    const id = decodeURIComponent(window.location.hash.slice(1));
    if (!id || id === "contact") return;
    const frame = window.requestAnimationFrame(() => document.getElementById(id)?.scrollIntoView());
    return () => window.cancelAnimationFrame(frame);
  }, []);

  const openInquiry: OpenInquiry = (event, plan = null) => {
    setOpener(event.currentTarget);
    setSelectedPlan(plan);
    setInquiryOpen(true);
  };
  return <div className="field-day landing-page min-w-[320px] bg-brand-paper font-landing text-brand-navy break-keep antialiased">
    <a className="skip-link fixed top-landing-skip-link-top left-4 z-100 rounded-landing-skip-link bg-surface-panel px-4 py-3 text-brand-navy focus:top-4" href="#main">본문으로 이동</a>
    <header className={`site-header fixed inset-x-0 top-0 z-20 text-surface-panel transition-[background,box-shadow] duration-250 ease-[ease] ${scrolled || page !== "home" ? "is-scrolled bg-brand-navy/97 shadow-landing-header-raised" : ""}`}>
      <div className="header-inner mx-auto w-[min(1180px,calc(100%-72px))] phone-wide:max-w-[360px] compact:max-w-[760px] tablet:max-w-[1024px] flex min-h-[82px] items-center justify-between gap-6 border-b border-surface-panel/18 landing-wide:landing-stack:w-[calc(100%-38px)] landing-wide:landing-stack:min-h-[96px] landing-wide:landing-stack:flex-wrap landing-wide:landing-stack:gap-landing-header-frame-stacked-gap landing-wide:landing-stack:py-2.5 landing-wide:landing-stack:landing-narrow:w-[calc(100%-30px)]">
        <a className="brand inline-flex items-center gap-2.5 text-landing-brand font-[850] landing-wide:landing-stack:landing-narrow:text-landing-brand-narrow" href="/" aria-label="킨다 홈"><KindaLogo presentation="landing" /></a>
        <nav className="header-nav flex items-center gap-landing-navigation-gap text-landing-navigation font-[750] landing-wide:landing-stack:w-full landing-wide:landing-stack:justify-between landing-wide:landing-stack:gap-2.5 landing-wide:landing-stack:text-landing-navigation-stacked landing-wide:landing-stack:landing-narrow:gap-1.5 landing-wide:landing-stack:landing-narrow:text-landing-navigation-narrow" aria-label="주요 메뉴">
          <a className="text-surface-panel no-underline hover:text-brand-coral" href="/features" aria-current={page === "features" ? "page" : undefined}>주요 기능</a>
          <a className="text-surface-panel no-underline hover:text-brand-coral" href="/pricing" aria-current={page === "pricing" ? "page" : undefined}>요금제</a>
          <Button ref={headerInquiry} type="button" variant="landingHeaderContact" className="header-contact" onClick={openInquiry}>도입 상담</Button>
          <LinkButton href="/login" variant="landingHeader" className="button--header">로그인 <span aria-hidden="true">↗</span></LinkButton>
        </nav>
      </div>
    </header>
    {children(openInquiry)}
    <CompanyFooter />
    {inquiryOpen && <ConsultationDialog key={selectedPlan ?? "general"} opener={opener} plan={selectedPlan} onClose={() => setInquiryOpen(false)} />}
  </div>;
}
