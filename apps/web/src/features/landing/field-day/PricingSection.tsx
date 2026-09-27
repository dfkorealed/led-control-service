import type { MouseEvent } from "react";
import { Button } from "../../../components/ui/Button";
import { Card } from "../../../components/ui/Card";

const plans = [
  { name: "Basic", price: "99,000원", summary: "조명 운영의 기본을 한곳에서 시작하세요.", items: ["모든 기본 기능", "로그 3개월 보존", "보고서 월 10회 생성"], featured: false },
  { name: "Plus", price: "199,000원", summary: "더 긴 기록과 넉넉한 보고서가 필요하다면.", items: ["모든 기본 기능", "로그 1년 보존", "보고서 무제한 생성", "AI 기능 · 도입 상담 시 안내"], featured: true }
] as const;

export type LandingPlan = "Basic" | "Plus";

export function PricingSection({ onInquiry }: { onInquiry: (event: MouseEvent<HTMLButtonElement>, plan: LandingPlan) => void }) {
  return <section className="pricing-section" id="pricing" aria-labelledby="pricing-title">
    <div className="container">
      <div className="section-intro"><p className="eyebrow">KINDA / PLANS</p><h1 id="pricing-title">현장에 맞는<br />운영 방식을 선택하세요.</h1><p>필요한 기록 범위와 보고서 사용량에 따라 두 가지 구성을 살펴보세요.</p></div>
      <div className="pricing-grid">{plans.map(plan => <Card key={plan.name} role="article" aria-label={plan.name} className={`pricing-card ${plan.featured ? "pricing-card--featured" : ""}`}>
        <div className="pricing-card__head"><span>{plan.name}</span>{plan.featured && <small>더 넓은 운영 범위</small>}</div>
        <p className="pricing-card__summary">{plan.summary}</p>
        <div className="pricing-card__price"><strong>{plan.price}</strong><span>/ 월</span></div>
        <ul>{plan.items.map(item => <li key={item}><span aria-hidden="true">✓</span>{item}</li>)}</ul>
        <Button type="button" variant={plan.featured ? "primary" : "secondary"} className="button pricing-card__button" onClick={event => onInquiry(event, plan.name)} aria-label={`${plan.name} 도입 상담`}>{plan.name} 도입 상담 <span aria-hidden="true">↗</span></Button>
      </Card>)}</div>
      <p className="pricing-section__note">표시 가격은 월 기준 안내입니다. 상품별 적용 범위와 제공 일정은 상담에서 확인해 주세요. 부가세와 계약 조건도 상담 시 안내합니다.</p>
    </div>
  </section>;
}
