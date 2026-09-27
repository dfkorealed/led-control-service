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
  return <ModalDialog isOpen title="도입 상담" description="현장에 필요한 관제 구성을 함께 살펴보겠습니다."
    closeLabel="상담 팝업 닫기" onClose={onClose} isPending={pending} returnFocusElement={opener}
    className="w-[min(650px,100%)]! max-h-[calc(100dvh-32px)]! rounded-[18px]! p-5! compact:p-8!"
    bodyClassName="field-day-inquiry-body">
    {plan && <p className="inquiry-selected-plan">선택한 요금제: <strong>{plan}</strong></p>}
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
  return <div className="field-day landing-page">
    <a className="skip-link" href="#main">본문으로 이동</a>
    <header className={`site-header ${scrolled || page !== "home" ? "is-scrolled" : ""}`}>
      <div className="container header-inner">
        <a className="brand" href="/" aria-label="킨다 홈"><KindaLogo /></a>
        <nav className="header-nav" aria-label="주요 메뉴">
          <a href="/features" aria-current={page === "features" ? "page" : undefined}>주요 기능</a>
          <a href="/pricing" aria-current={page === "pricing" ? "page" : undefined}>요금제</a>
          <Button ref={headerInquiry} type="button" variant="link" className="header-contact" onClick={openInquiry}>도입 상담</Button>
          <LinkButton href="/login" variant="secondary" className="button button--header">로그인 <span aria-hidden="true">↗</span></LinkButton>
        </nav>
      </div>
    </header>
    {children(openInquiry)}
    <CompanyFooter />
    {inquiryOpen && <ConsultationDialog key={selectedPlan ?? "general"} opener={opener} plan={selectedPlan} onClose={() => setInquiryOpen(false)} />}
  </div>;
}
