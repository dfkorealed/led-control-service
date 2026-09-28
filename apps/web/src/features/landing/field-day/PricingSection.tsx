import type { MouseEvent } from "react";
import { Button } from "../../../components/ui/Button";
import { Card } from "../../../components/ui/Card";

const container = "mx-auto w-[min(1180px,calc(100%-72px))] phone-wide:max-w-[360px] compact:max-w-[760px] tablet:max-w-[1024px] landing-wide:landing-stack:w-[calc(100%-38px)] landing-wide:landing-stack:landing-narrow:w-[calc(100%-30px)]";

// CSS clamps both the original999px badge radius and the shared9999px pill
// radius to half its height, preserving the same circular end caps.
const plans = [
  { name: "Basic", price: "99,000원", summary: "조명 운영의 기본을 한곳에서 시작하세요.", items: ["모든 기본 기능", "로그 3개월 보존", "보고서 월 10회 생성"], featured: false },
  { name: "Plus", price: "199,000원", summary: "더 긴 기록과 넉넉한 보고서가 필요하다면.", items: ["모든 기본 기능", "로그 1년 보존", "보고서 무제한 생성", "AI 기능 · 도입 상담 시 안내"], featured: true }
] as const;

export type LandingPlan = "Basic" | "Plus";

export function PricingSection({ onInquiry }: { onInquiry: (event: MouseEvent<HTMLButtonElement>, plan: LandingPlan) => void }) {
  return <section className="pricing-section flex items-center min-h-svh py-landing-section-frame-block-inset bg-surface-inset scroll-mt-landing-anchor-anchor-offset" id="pricing" aria-labelledby="pricing-title">
    <div className={container}>
      <div className="section-intro max-w-[670px] mb-landing-pricing-intro-bottom-space"><p className="m-0 text-brand-blue text-landing-eyebrow font-[850] uppercase">KINDA / PLANS</p><h1 id="pricing-title" className="scroll-mt-landing-anchor-anchor-offset mt-4 mb-4.5 text-landing-section-heading landing-wide:landing-stack:landing-narrow:text-landing-section-heading-narrow">현장에 맞는<br />운영 방식을 선택하세요.</h1><p className="m-0 text-status-neutral-foreground text-landing-section-description landing-wide:landing-stack:landing-narrow:text-landing-narrative-copy-narrow">필요한 기록 범위와 보고서 사용량에 따라 두 가지 구성을 살펴보세요.</p></div>
      <div className="pricing-grid grid grid-cols-2 gap-5 items-stretch landing-wide:landing-stack:grid-cols-1">{plans.map(plan => <Card key={plan.name} role="article" aria-label={plan.name} variant={plan.featured ? "landingPlanFeatured" : "landingPlan"} className={`pricing-card ${plan.featured ? "pricing-card--featured" : ""}`}>
        <div className="pricing-card__head flex justify-between items-center gap-3 text-brand-blue text-landing-plan-name font-[850]"><span>{plan.name}</span>{plan.featured && <small className="py-2 px-2.5 rounded-pill bg-action-primary-soft text-landing-plan-badge font-extrabold">더 넓은 운영 범위</small>}</div>
        <p className="pricing-card__summary min-h-[55px] mt-4.5 mb-2 text-content-secondary text-landing-plan-summary landing-wide:landing-stack:min-h-0">{plan.summary}</p>
        <div className="pricing-card__price flex items-baseline gap-landing-pricing-value-row-gap pb-landing-pricing-value-row-bottom-inset border-b border-border-subtle"><strong className="text-landing-price font-bold">{plan.price}</strong><span className="text-content-secondary text-landing-price-unit">/ 월</span></div>
        <ul className="grid gap-4.5 m-landing-pricing-features-margin p-0 list-none">{plan.items.map(item => <li key={item} className="flex gap-3 items-start text-landing-plan-feature"><span className="grid place-items-center flex-none size-[21px] rounded-landing-ellipse bg-action-primary-soft text-brand-blue text-landing-plan-feature-marker font-black" aria-hidden="true">✓</span>{item}</li>)}</ul>
        <Button type="button" variant={plan.featured ? "landingPlanPrimary" : "landingPlanSecondary"} className="pricing-card__button w-full mt-auto" onClick={event => onInquiry(event, plan.name)} aria-label={`${plan.name} 도입 상담`}>{plan.name} 도입 상담 <span aria-hidden="true">↗</span></Button>
      </Card>)}</div>
      <p className="pricing-section__note max-w-[920px] m-landing-pricing-note-margin text-status-neutral-foreground text-landing-pricing-note">표시 가격은 월 기준 안내입니다. 상품별 적용 범위와 제공 일정은 상담에서 확인해 주세요. 부가세와 계약 조건도 상담 시 안내합니다.</p>
    </div>
  </section>;
}
