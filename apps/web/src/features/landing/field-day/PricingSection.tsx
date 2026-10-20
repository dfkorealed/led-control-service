import type { MouseEvent } from "react";
import { Button } from "../../../components/ui/Button";
import { Card } from "../../../components/ui/Card";
import { MonthlyPrice } from "../../../components/ui/public-site/MonthlyPrice";

const container = "mx-auto w-[min(1180px,calc(100%-72px))] phone-wide:max-w-[360px] compact:max-w-[760px] tablet:max-w-[1024px] landing-wide:landing-stack:w-[calc(100%-38px)] landing-wide:landing-stack:landing-narrow:w-[calc(100%-30px)]";
const basicPlan = {
  name: "Basic",
  items: ["조명 1,000개 포함", "모든 기본 기능", "로그 3개월 보존", "보고서 월 10회 생성"]
} as const;

export type LandingPlan = typeof basicPlan.name;

export function PricingSection({ onInquiry }: { onInquiry: (event: MouseEvent<HTMLButtonElement>, plan: LandingPlan) => void }) {
  return <section className="pricing-section flex items-center min-h-svh py-landing-section-frame-block-inset bg-surface-inset scroll-mt-landing-anchor-anchor-offset" id="pricing" aria-labelledby="pricing-title">
    <div className={container}>
      <div className="section-intro max-w-[670px] mb-landing-pricing-intro-bottom-space">
        <p className="m-0 text-brand-blue text-landing-eyebrow font-[850] uppercase">KINDA / PLANS</p>
        <h1 id="pricing-title" className="scroll-mt-landing-anchor-anchor-offset mt-4 mb-4.5 text-landing-section-heading landing-wide:landing-stack:landing-narrow:text-landing-section-heading-narrow">현장에 맞는<br />운영 방식을 선택하세요.</h1>
      </div>
      <div className="pricing-grid grid grid-cols-2 gap-5 items-start landing-wide:landing-stack:grid-cols-1">
        <Card role="article" aria-label={basicPlan.name} variant="landingPlan" className="pricing-card">
          <div className="pricing-card__head flex justify-between items-center gap-3 text-brand-blue">
            <h2 className="m-0 text-landing-plan-name font-[850]">기본 구독</h2>
            <span className="text-landing-plan-badge font-extrabold">{basicPlan.name}</span>
          </div>
          <p className="pricing-card__summary mt-4.5 mb-2 text-content-secondary text-landing-plan-summary">현장 1곳당</p>
          <MonthlyPrice amount="99,000원" />
          <ul className="grid gap-4.5 m-landing-pricing-features-margin p-0 list-none">
            {basicPlan.items.map(item => <li key={item} className="flex gap-3 items-start text-landing-plan-feature"><span className="grid place-items-center flex-none size-[21px] rounded-landing-ellipse bg-action-primary-soft text-brand-blue text-landing-plan-feature-marker font-black" aria-hidden="true">✓</span>{item}</li>)}
          </ul>
          <Button type="button" variant="landingPlanSecondary" className="pricing-card__button w-full mt-auto" onClick={event => onInquiry(event, basicPlan.name)} aria-label="Basic 도입 상담">Basic 도입 상담 <span aria-hidden="true">↗</span></Button>
        </Card>
        <Card role="region" aria-label="옵션 상품" variant="landingPlan" className="pricing-options">
          <h2 className="m-0 text-brand-blue text-landing-plan-name font-[850]">옵션 상품</h2>
          <dl className="m-0 mt-6">
            <div>
              <dt className="text-landing-plan-name font-bold text-brand-navy">추가 조명</dt>
              <dd className="m-0 mt-3">
                <MonthlyPrice amount="100원" />
                <p className="m-0 mt-6 text-content-secondary text-landing-plan-feature">필요한 만큼 조명을 추가하여 대규모 운영을 간편하게 관리하세요</p>
              </dd>
            </div>
          </dl>
        </Card>
      </div>
      <p className="pricing-section__note max-w-[920px] m-landing-pricing-note-margin text-status-neutral-foreground text-landing-pricing-note">부가세는 별도입니다.</p>
    </div>
  </section>;
}
