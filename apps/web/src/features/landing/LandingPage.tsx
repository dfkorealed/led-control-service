import { ArrowDown, ArrowRight, Building2, ClipboardCheck, Layers, Map, SlidersHorizontal, BarChart3 } from "lucide-react";
import { KindaLogo } from "../../components/brand/KindaLogo";
import { Card } from "../../components/ui/Card";
import { LinkButton } from "../../components/ui/LinkButton";
import { DashboardPreview } from "./DashboardPreview";
import { InquiryForm } from "./InquiryForm";

const capabilities = [
  { icon: Map, title: "위치를 알고", description: "현장과 층, 도면을 기준으로 조명의 위치와 최근 상태를 살펴봅니다." },
  { icon: SlidersHorizontal, title: "필요한 곳을 제어하고", description: "조명을 개별로 선택하거나 그룹으로 묶어 점등과 밝기를 제어합니다." },
  { icon: BarChart3, title: "운영을 돌아봅니다", description: "제어 이력과 기간별 추정 전력 사용량을 확인해 운영 판단에 참고합니다." }
];

const audiences = [
  {
    id: "facility", icon: Building2, label: "시설 운영 담당자", title: "매일의 확인을, 한곳에서.",
    description: "여러 층에 흩어진 조명도 현장의 맥락 안에서 살펴보세요.",
    steps: [
      ["현장 상태 확인", "현장과 층을 선택하고 도면에서 조명 위치와 연결 상태를 확인합니다."],
      ["필요한 대상 제어", "개별 조명이나 그룹을 선택해 필요한 곳의 점등과 밝기를 조정합니다."],
      ["운영 기록 검토", "명령 처리 이력과 기간별 통계로 운영 흐름을 돌아봅니다."]
    ],
    cta: "시설 도입 상담"
  },
  {
    id: "partner", icon: ClipboardCheck, label: "시공·유통 파트너", title: "설치 다음의 운영까지.",
    description: "설치 정보가 고객의 운영과 유지관리로 이어지도록 준비하세요.",
    steps: [
      ["설치 정보 정리", "현장·층·도면에 등록한 조명과 그룹을 연결해 관리 기준을 정리합니다."],
      ["인수인계", "같은 현장과 도면을 기준으로 고객에게 조명 위치와 제어 방법을 안내합니다."],
      ["유지관리", "조명 상태와 제어 이력을 살펴보고 현장 확인이 필요한 대상을 파악합니다."]
    ],
    cta: "파트너 도입 상담"
  }
];

export function LandingPage() {
  return <div className="min-h-screen break-keep bg-brand-paper text-brand-navy">
    <a href="#main-content" className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-control focus:bg-surface-panel focus:p-4 focus:text-action-primary">본문으로 이동</a>
    <header className="border-b border-border-subtle bg-surface-panel">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-x-4 px-4 py-3 compact:px-8">
        <a href="/" aria-label="킨다 홈" className="inline-flex min-h-12 items-center"><KindaLogo /></a>
        <a href="/login" className="inline-flex min-h-12 items-center gap-2 px-3 text-body font-bold text-action-primary compact:order-3">로그인 <ArrowRight size={16} aria-hidden="true" /></a>
        <nav aria-label="주요 메뉴" className="flex w-full items-center justify-between gap-2 border-t border-border-subtle compact:w-auto compact:gap-6 compact:border-0">
          <a href="#product" className="inline-flex min-h-12 items-center px-2 text-body font-medium hover:text-action-primary">제품 소개</a>
          <a href="#benefits" className="inline-flex min-h-12 items-center px-2 text-body font-medium hover:text-action-primary">활용 안내</a>
          <a href="#contact" className="inline-flex min-h-12 items-center px-2 text-body font-bold text-action-primary">상담 문의</a>
        </nav>
      </div>
    </header>
    <main id="main-content" tabIndex={-1}>
      <section aria-labelledby="hero-heading" className="mx-auto max-w-6xl px-4 pb-12 pt-12 compact:px-8 compact:pb-16 compact:pt-16">
        <div className="mx-auto mb-10 max-w-4xl text-center compact:mb-12">
          <p className="mb-4 flex flex-wrap items-center justify-center gap-2 text-body-sm font-medium text-action-primary"><span className="h-px w-6 bg-brand-coral" aria-hidden="true" />주차장·시설용 스마트 조명 운영 솔루션</p>
          <h1 id="hero-heading" className="text-balance text-display font-bold tablet:text-landing-hero">조명 운영을 간단하게.</h1>
          <p className="mx-auto mt-6 max-w-2xl text-pretty text-body-lg text-brand-navy/80">설치 정보부터 상태 확인, 제어와 운영 기록까지.<br className="hidden compact:block" /> 킨다로 현장의 조명을 한곳에서 살펴보세요.</p>
          <div className="mt-8 flex flex-wrap justify-center gap-3">
            <LinkButton href="#contact">도입 상담하기 <ArrowRight size={17} aria-hidden="true" /></LinkButton>
            <LinkButton href="#product" variant="secondary">제품 살펴보기 <ArrowDown size={17} aria-hidden="true" /></LinkButton>
          </div>
        </div>
        <DashboardPreview />
      </section>
      <section id="product" aria-labelledby="product-heading" tabIndex={-1} className="scroll-mt-6 border-y border-border-subtle bg-surface-panel">
        <div className="mx-auto max-w-6xl px-4 py-12 compact:px-8 compact:py-16">
          <div className="grid gap-6 compact:grid-cols-2 compact:items-end">
            <div><p className="mb-3 text-body-sm font-bold text-action-primary">하나로 이어지는 조명 운영</p><h2 id="product-heading" className="text-display font-bold">현장을 이해하는 화면.<br />일에 맞게 이어지는 기능.</h2></div>
            <p className="max-w-md text-body-lg text-brand-navy/80">도면 위의 조명에서 운영 기록까지.<br />위치와 상태를 기준으로 다음 작업을 찾습니다.</p>
          </div>
          <div className="mt-10 grid gap-6 compact:grid-cols-3 compact:gap-8">
            {capabilities.map(({ icon: Icon, title, description }, index) => <div key={title} className="border-t border-border-strong pt-6">
              <div className="mb-6 flex items-center justify-between"><Icon size={26} className="text-action-primary" aria-hidden="true" /><span className="text-label text-brand-navy/80" aria-hidden="true">0{index + 1}</span></div>
              <h3 className="text-card-title font-bold">{title}</h3><p className="mt-3 text-body-lg text-brand-navy/80">{description}</p>
            </div>)}
          </div>
        </div>
      </section>
      <section id="benefits" aria-labelledby="benefits-heading" tabIndex={-1} className="mx-auto max-w-6xl scroll-mt-6 px-4 py-12 compact:px-8 compact:py-16">
        <div className="mb-10 text-center"><p className="mb-3 text-body-sm font-bold text-action-primary">함께 쓰는 킨다</p><h2 id="benefits-heading" className="text-display font-bold">운영하는 사람도,<br className="compact:hidden" /> 설치하는 사람도.</h2><p className="mt-4 text-body-lg text-brand-navy/80">서로 다른 업무를 같은 현장 정보로 연결합니다.</p></div>
        <div className="grid gap-6 compact:grid-cols-2">
          {audiences.map(({ id, icon: Icon, label, title, description, steps, cta }) => <Card key={id} aria-labelledby={`${id}-heading`} className="flex flex-col p-6 tablet:p-8">
            <div className="mb-6 flex items-center gap-3"><span className="flex size-11 items-center justify-center rounded-control bg-action-primary-soft text-action-primary"><Icon size={22} aria-hidden="true" /></span><h3 id={`${id}-heading`} className="text-body-lg font-bold">{label}</h3></div>
            <p className="text-section-title font-bold">{title}</p><p className="mt-3 text-body-lg text-brand-navy/80">{description}</p>
            <ol className="my-8 grid gap-6">
              {steps.map(([step, detail], index) => <li key={step} className="flex gap-3"><span aria-hidden="true" className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-pill bg-brand-paper text-label font-bold text-action-primary">{index + 1}</span><div><h4 className="text-body-lg font-bold">{step}</h4><p className="mt-1 text-body text-brand-navy/80">{detail}</p></div></li>)}
            </ol>
            <LinkButton href="#contact" variant="secondary" className="mt-auto justify-between">{cta}<ArrowRight size={17} aria-hidden="true" /></LinkButton>
          </Card>)}
        </div>
      </section>
      <section id="contact" aria-labelledby="contact-heading" tabIndex={-1} className="scroll-mt-6 bg-brand-navy text-content-inverse">
        <div className="mx-auto grid max-w-6xl gap-8 px-4 py-12 compact:grid-cols-2 compact:items-center compact:px-8 compact:py-16">
          <div><p className="mb-4 text-body-sm font-medium">킨다 도입 상담</p><h2 id="contact-heading" className="text-display font-bold">우리 현장에 맞는 시작,<br />함께 살펴보겠습니다.</h2></div>
          <InquiryForm />
        </div>
      </section>
    </main>
    <footer className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 px-4 py-8 compact:px-8">
      <div className="flex items-center gap-3"><Layers size={18} aria-hidden="true" className="text-action-primary" /><p className="text-body font-bold">킨다 <span className="ml-2 font-normal text-brand-navy/80">조명 운영을 간단하게.</span></p></div>
      <a href="/login" className="inline-flex min-h-11 items-center gap-2 text-body text-action-primary">관제 서비스 로그인 <ArrowRight size={15} aria-hidden="true" /></a>
    </footer>
  </div>;
}
