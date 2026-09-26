import {
  ArrowDown,
  ArrowRight,
  BarChart3,
  Building2,
  CalendarDays,
  Check,
  ClipboardCheck,
  History,
  Layers,
  MapPin,
  Search,
  SlidersHorizontal
} from "lucide-react";
import { createRef, useMemo, useRef } from "react";
import { KindaLogo } from "../../components/brand/KindaLogo";
import { Card } from "../../components/ui/Card";
import { LinkButton } from "../../components/ui/LinkButton";
import { DashboardPreview } from "./DashboardPreview";
import { InquiryForm } from "./InquiryForm";
import { LandingMotion } from "./LandingMotion";

const audiences = [
  {
    id: "facility",
    icon: Building2,
    label: "시설 운영 담당자",
    title: "흩어진 조명을, 현장 기준으로 살펴보세요.",
    description: "점검부터 제어, 운영 검토까지 같은 현장 정보를 따라 움직입니다.",
    steps: [
      { title: "어디서 시작할지 찾기", detail: "현장과 층을 고르고 조명을 검색해 도면의 위치, 연결 상태, 최근 확인 상태를 살핍니다." },
      { title: "필요한 곳만 조정하기", detail: "개별 조명이나 그룹의 점등과 밝기를 바꾸고, 반복 운영은 일정으로 관리합니다." },
      { title: "처리 결과로 다음 일 정하기", detail: "명령 처리 이력을 확인하고 기간별 상태 기반 추정 전력을 운영 판단에 참고합니다." }
    ],
    cta: "시설 도입 상담"
  },
  {
    id: "partner",
    icon: ClipboardCheck,
    label: "시공·유통 파트너",
    title: "설치 정보를, 운영 가능한 기준으로 이어주세요.",
    description: "등록과 배치에서 인수인계, 이후 상태 확인까지 한 흐름으로 설명합니다.",
    steps: [
      { title: "현장 기준 만들기", detail: "현장과 층, Gateway, 조명을 등록해 운영 화면에서 사용할 대상을 정리합니다." },
      { title: "위치와 제어 방식 인계하기", detail: "CAD 도면의 조명 후보를 검토한 뒤 배치에 적용하고, 그룹과 일정의 운영 기준을 안내합니다." },
      { title: "인계 후 확인 이어가기", detail: "조명의 연결 상태와 명령 처리 이력을 함께 보며 현장 확인이 필요한 대상을 좁힙니다." }
    ],
    cta: "파트너 도입 상담"
  }
];

function LocationIllustration() {
  return <div aria-hidden="true" className="overflow-hidden rounded-panel border border-border-default bg-surface-panel shadow-panel">
    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border-subtle px-5 py-4">
      <span className="text-body font-bold">현장 / 층 / 도면</span>
      <span className="rounded-pill bg-action-primary-soft px-3 py-1 text-label font-bold text-action-primary">위치 확인</span>
    </div>
    <div className="grid gap-4 p-4 compact:grid-cols-[minmax(0,1fr)_10rem] compact:p-6">
      <div className="relative min-h-48 overflow-hidden rounded-control border border-border-default bg-surface-inset p-5">
        <div className="absolute inset-x-5 top-1/3 border-t border-dashed border-border-strong" />
        <div className="absolute inset-x-5 top-2/3 border-t border-dashed border-border-strong" />
        <div className="absolute inset-y-5 left-1/3 border-l border-dashed border-border-strong" />
        <div className="absolute inset-y-5 left-2/3 border-l border-dashed border-border-strong" />
        <span className="relative z-10 rounded-control bg-surface-panel px-2 py-1 text-label font-bold text-brand-navy">지하 1층</span>
        <span className="absolute bottom-10 left-1/4 size-3 rounded-pill bg-action-primary ring-4 ring-surface-panel" />
        <span className="absolute right-1/4 top-1/3 size-3 rounded-pill bg-action-primary ring-4 ring-surface-panel" />
        <span className="absolute bottom-1/4 right-1/3 size-3 rounded-pill bg-brand-coral ring-4 ring-surface-panel" />
      </div>
      <div className="grid content-start gap-3 text-label">
        <div className="rounded-control border border-border-subtle p-3"><Search size={16} className="mb-2 text-action-primary" /><strong className="block text-body">조명 검색</strong><span className="text-brand-navy/70">대상 좁히기</span></div>
        <div className="rounded-control border border-border-subtle p-3"><MapPin size={16} className="mb-2 text-action-primary" /><strong className="block text-body">선택한 조명</strong><span className="text-brand-navy/70">연결 · 최근 상태</span></div>
      </div>
    </div>
  </div>;
}

function ControlIllustration() {
  return <div aria-hidden="true" className="rounded-panel border border-content-inverse/20 bg-surface-panel p-5 text-brand-navy shadow-popover compact:p-7">
    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border-subtle pb-4">
      <div><span className="text-label font-bold text-action-primary">제어 대상</span><strong className="mt-1 block text-card-title">출입구 구역</strong></div>
      <span className="rounded-pill bg-action-primary-soft px-3 py-1 text-label font-bold text-action-primary">운영 설정</span>
    </div>
    <div className="grid gap-3 py-5">
      <div className="flex items-center gap-4 rounded-control bg-surface-inset p-4"><SlidersHorizontal size={21} className="shrink-0 text-action-primary" /><div><strong className="block text-body">개별 · 그룹</strong><span className="text-label text-brand-navy/70">점등과 밝기 제어</span></div></div>
      <div className="flex items-center gap-4 rounded-control bg-surface-inset p-4"><CalendarDays size={21} className="shrink-0 text-action-primary" /><div><strong className="block text-body">일정</strong><span className="text-label text-brand-navy/70">반복 운영 기준</span></div></div>
    </div>
    <div className="flex items-center gap-2 border-t border-border-subtle pt-4 text-body font-bold text-action-primary"><Check size={18} />명령 처리 결과 확인</div>
  </div>;
}

function VerificationIllustration() {
  return <div aria-hidden="true" className="grid gap-4 compact:grid-cols-[minmax(0,1fr)_minmax(0,0.75fr)]">
    <div className="rounded-panel border border-border-default bg-surface-panel p-5 shadow-panel compact:p-6">
      <div className="flex items-center gap-3 border-b border-border-subtle pb-4"><History size={21} className="text-action-primary" /><strong className="text-body-lg">명령 처리 이력</strong></div>
      <div className="grid gap-4 pt-5 text-body">
        <div className="flex items-start gap-3"><span className="mt-1 size-2 shrink-0 rounded-pill bg-action-primary" /><div><strong>대상과 명령</strong><p className="text-brand-navy/70">어떤 조명을 제어했는지</p></div></div>
        <div className="flex items-start gap-3"><span className="mt-1 size-2 shrink-0 rounded-pill bg-brand-coral" /><div><strong>처리 결과</strong><p className="text-brand-navy/70">명령이 어떻게 처리됐는지</p></div></div>
      </div>
    </div>
    <div className="flex flex-col justify-between rounded-panel bg-action-primary-soft p-5 compact:p-6">
      <BarChart3 size={25} className="text-action-primary" />
      <div className="mt-8"><strong className="block text-body-lg">기간별 추정 전력</strong><p className="mt-2 text-body text-brand-navy/80">조명 상태를 바탕으로 계산한 추정치</p></div>
    </div>
  </div>;
}

export function LandingPage() {
  const rootRef = useRef<HTMLDivElement>(null);
  const sectionRefs = useMemo(() => ({
    introduction: createRef<HTMLDivElement>(),
    location: createRef<HTMLElement>(),
    control: createRef<HTMLElement>(),
    verification: createRef<HTMLElement>(),
    consultation: createRef<HTMLDivElement>(),
    benefits: createRef<HTMLElement>(),
    preparation: createRef<HTMLElement>(),
    contact: createRef<HTMLElement>()
  }), []);
  return <div ref={rootRef} className="landing-page min-h-screen break-keep bg-brand-paper text-brand-navy">
    <LandingMotion rootRef={rootRef} sectionRefs={sectionRefs} />
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
      <section aria-labelledby="hero-heading" className="mx-auto max-w-6xl px-4 pb-16 pt-16 compact:px-8">
        <div className="mx-auto mb-12 max-w-5xl text-center compact:mb-16">
          <p className="landing-hero-kicker mb-5 flex flex-wrap items-center justify-center gap-2 text-body-sm font-bold text-action-primary"><span className="h-px w-7 bg-brand-coral" aria-hidden="true" />주차장·시설 조명 운영 플랫폼<span className="h-px w-7 bg-brand-coral" aria-hidden="true" /></p>
          <h1 id="hero-heading" className="landing-hero-heading mx-auto max-w-4xl text-balance text-display font-bold tablet:text-landing-hero">조명 위치를 찾고, 제어하고,<br className="hidden compact:block" /> 결과를 확인하세요.</h1>
          <p className="landing-hero-description mx-auto mt-6 max-w-2xl text-pretty text-body-lg text-brand-navy/80">도면에서 대상을 찾는 순간부터 필요한 조명을 바꾸고 처리 이력을 살펴보는 순간까지. 킨다는 현장 운영의 흐름을 한곳에 모읍니다.</p>
          <div className="landing-hero-actions mt-8 flex flex-wrap justify-center gap-3">
            <LinkButton href="#contact">도입 상담하기 <ArrowRight size={17} aria-hidden="true" /></LinkButton>
            <LinkButton href="#product" variant="secondary">제품 살펴보기 <ArrowDown size={17} aria-hidden="true" /></LinkButton>
          </div>
        </div>
        <div className="landing-hero-preview"><DashboardPreview /></div>
      </section>

      <section id="product" aria-labelledby="product-heading" tabIndex={-1} className="scroll-mt-6 bg-surface-panel">
        <div ref={sectionRefs.introduction} className="mx-auto max-w-6xl px-4 pb-10 pt-16 compact:px-8 compact:pb-16" data-landing-reveal>
          <p className="mb-4 text-body-sm font-bold text-action-primary">현장에서 이어지는 세 가지 질문</p>
          <div className="grid gap-6 compact:grid-cols-[minmax(0,1.15fr)_minmax(0,0.85fr)] compact:items-end">
            <h2 id="product-heading" className="max-w-2xl text-display font-bold">찾아야 할 때, 바꿔야 할 때, 확인해야 할 때.</h2>
            <p className="max-w-md text-body-lg text-brand-navy/80">기능 이름만 늘어놓기보다 실제 업무가 어떻게 이어지는지 보여드립니다.</p>
          </div>
        </div>

        <article ref={sectionRefs.location} data-landing-story="location" data-landing-reveal aria-labelledby="location-heading" className="border-t border-border-subtle">
          <div className="mx-auto grid max-w-6xl gap-10 px-4 py-16 compact:px-8 tablet:grid-cols-2 tablet:items-center tablet:gap-16">
            <div>
              <p className="mb-4 text-body-sm font-bold text-action-primary">01 / 위치와 상태</p>
              <h3 id="location-heading" className="text-display font-bold">그 조명은<br />어디에 있나요?</h3>
              <p className="mt-6 text-body-lg text-brand-navy/80">점검 대상을 찾을 때 층 이름과 조명 목록만으로는 현장을 떠올리기 어렵습니다. 킨다에서는 현장과 층을 고르고 도면에서 조명 위치를 확인합니다. 검색으로 대상을 좁힌 뒤 연결 상태와 최근 확인 상태를 함께 볼 수 있습니다.</p>
              <p className="mt-5 border-l-2 border-brand-coral pl-4 text-body font-bold">어느 위치부터 살펴볼지, 현장 맥락을 보며 정할 수 있습니다.</p>
            </div>
            <LocationIllustration />
          </div>
        </article>

        <article ref={sectionRefs.control} data-landing-story="control" data-landing-reveal aria-labelledby="control-story-heading" className="bg-brand-navy text-content-inverse">
          <div className="mx-auto grid max-w-6xl gap-10 px-4 py-16 compact:px-8 tablet:grid-cols-2 tablet:items-center tablet:gap-16">
            <div className="tablet:order-2">
              <p className="mb-4 text-body-sm font-bold text-brand-coral">02 / 제어와 일정</p>
              <h3 id="control-story-heading" className="text-display font-bold">무엇을<br />바꿀까요?</h3>
              <p className="mt-6 text-body-lg text-content-inverse/80">하나의 조명만 조정할지, 같은 구역을 함께 운영할지 선택해야 합니다. 개별·그룹 대상에 점등과 밝기 명령을 보내고, 반복되는 운영은 일정으로 관리합니다.</p>
              <p className="mt-5 border-l-2 border-brand-coral pl-4 text-body font-bold">필요한 범위와 시간을 구분해 조명 운영 기준을 세울 수 있습니다.</p>
            </div>
            <div className="tablet:order-1"><ControlIllustration /></div>
          </div>
        </article>

        <article ref={sectionRefs.verification} data-landing-story="verification" data-landing-reveal aria-labelledby="verification-heading" className="border-b border-border-subtle bg-brand-paper">
          <div className="mx-auto grid max-w-6xl gap-10 px-4 py-16 compact:px-8 tablet:grid-cols-2 tablet:items-center tablet:gap-16">
            <div>
              <p className="mb-4 text-body-sm font-bold text-action-primary">03 / 기록과 판단</p>
              <h3 id="verification-heading" className="text-display font-bold">바뀐 결과를<br />어떻게 확인하나요?</h3>
              <p className="mt-6 text-body-lg text-brand-navy/80">명령을 보낸 뒤에는 대상과 처리 결과를 이력에서 확인합니다. 기간별 전력은 조명 상태를 바탕으로 계산한 상태 기반 추정 전력으로 살펴볼 수 있습니다.</p>
              <p className="mt-5 border-l-2 border-brand-coral pl-4 text-body font-bold">조치 내역과 추정치를 함께 검토해 다음 운영 판단의 근거로 삼을 수 있습니다.</p>
            </div>
            <VerificationIllustration />
          </div>
        </article>
      </section>

      <div ref={sectionRefs.consultation} className="bg-action-primary-soft" data-landing-reveal>
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-5 px-4 py-8 compact:px-8">
          <p className="max-w-2xl text-body-lg font-bold">우리 현장의 조명 배치와 운영 방식에 맞춰, 어떤 흐름이 필요한지 함께 살펴보세요.</p>
          <LinkButton href="#contact" variant="secondary">우리 현장 상담하기 <ArrowRight size={17} aria-hidden="true" /></LinkButton>
        </div>
      </div>

      <section ref={sectionRefs.benefits} id="benefits" aria-labelledby="benefits-heading" tabIndex={-1} className="mx-auto max-w-6xl scroll-mt-6 px-4 py-16 compact:px-8" data-landing-reveal>
        <div className="mb-10 grid gap-5 compact:grid-cols-2 compact:items-end">
          <div><p className="mb-4 text-body-sm font-bold text-action-primary">같은 현장, 다른 업무</p><h2 id="benefits-heading" className="text-display font-bold">운영하는 사람도,<br /> 설치하는 사람도.</h2></div>
          <p className="max-w-md text-body-lg text-brand-navy/80">업무의 시작점은 달라도, 위치와 상태를 함께 보는 기준은 이어집니다.</p>
        </div>
        <div className="grid gap-6 compact:grid-cols-2">
          {audiences.map(({ id, icon: Icon, label, title, description, steps, cta }) => <Card key={id} aria-labelledby={`${id}-heading`} className="flex flex-col border-t-4 border-t-action-primary p-6 tablet:p-8">
            <div className="mb-7 flex items-center gap-3"><span className="flex size-11 items-center justify-center rounded-control bg-action-primary-soft text-action-primary"><Icon size={22} aria-hidden="true" /></span><h3 id={`${id}-heading`} className="text-body-lg font-bold">{label}</h3></div>
            <p className="text-section-title font-bold">{title}</p><p className="mt-3 text-body text-brand-navy/80">{description}</p>
            <ol className="my-8 grid gap-6 border-t border-border-subtle pt-7">
              {steps.map(({ title: step, detail }, index) => <li key={step} className="flex gap-3"><span aria-hidden="true" className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-pill bg-action-primary-soft text-label font-bold text-action-primary">{index + 1}</span><div><h4 className="text-body font-bold">{step}</h4><p className="mt-1 text-body text-brand-navy/80">{detail}</p></div></li>)}
            </ol>
            <LinkButton href="#contact" variant="secondary" className="mt-auto justify-between">{cta}<ArrowRight size={17} aria-hidden="true" /></LinkButton>
          </Card>)}
        </div>
      </section>

      <section ref={sectionRefs.preparation} aria-labelledby="prepare-eyebrow prepare-heading" className="border-y border-border-subtle bg-surface-panel" data-landing-reveal>
        <div className="mx-auto grid max-w-6xl gap-8 px-4 py-12 compact:px-8 compact:py-16 tablet:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)] tablet:gap-12">
          <div><p id="prepare-eyebrow" className="mb-4 text-body-sm font-bold text-action-primary">상담 전 확인할 것</p><h2 id="prepare-heading" className="text-display font-bold">현장 이야기를<br />조금만 들려주세요.</h2><p className="mt-5 text-body-lg text-brand-navy/80">정확한 구성은 상담에서 함께 확인합니다. 아래 항목을 알고 계신 범위에서 알려주시면 됩니다.</p></div>
          <div>
            <ol className="grid gap-0 divide-y divide-border-subtle border-y border-border-subtle">
              <li className="flex gap-4 py-4"><span className="text-body-sm font-bold text-action-primary">01</span><span className="text-body-lg font-medium">현장과 층의 대략적인 규모</span></li>
              <li className="flex gap-4 py-4"><span className="text-body-sm font-bold text-action-primary">02</span><span className="text-body-lg font-medium">도면 보유 여부와 도면 형태</span></li>
              <li className="flex gap-4 py-4"><span className="text-body-sm font-bold text-action-primary">03</span><span className="text-body-lg font-medium">설치와 운영을 맡는 역할</span></li>
            </ol>
            <LinkButton href="#contact" className="mt-6">상담 내용 남기기 <ArrowRight size={17} aria-hidden="true" /></LinkButton>
          </div>
        </div>
      </section>

      <section ref={sectionRefs.contact} id="contact" aria-labelledby="contact-heading" tabIndex={-1} className="scroll-mt-6 bg-brand-navy text-content-inverse" data-landing-reveal>
        <div className="mx-auto grid max-w-6xl gap-8 px-4 py-16 compact:grid-cols-2 compact:items-start compact:px-8">
          <div><p className="mb-4 text-body-sm font-bold text-brand-coral">킨다 도입 상담</p><h2 id="contact-heading" className="text-display font-bold">우리 현장에 맞는 시작,<br />함께 살펴보겠습니다.</h2><p className="mt-5 max-w-md text-body-lg text-content-inverse/80">현장 규모와 운영 방식, 설치 상황을 알려주세요. 필요한 등록·배치·운영 흐름을 함께 확인하겠습니다.</p></div>
          <InquiryForm />
        </div>
      </section>
    </main>
    <footer className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 px-4 py-8 compact:px-8">
      <div className="flex items-center gap-3"><Layers size={18} aria-hidden="true" className="text-action-primary" /><p className="text-body font-bold">킨다 <span className="ml-2 font-normal text-brand-navy/80">찾고, 제어하고, 확인합니다.</span></p></div>
      <a href="/login" className="inline-flex min-h-11 items-center gap-2 text-body text-action-primary">관제 서비스 로그인 <ArrowRight size={15} aria-hidden="true" /></a>
    </footer>
  </div>;
}
