export function MonthlyPrice({ amount }: { amount: string }) {
  return <div className="pricing-card__price flex flex-wrap items-baseline gap-landing-pricing-value-row-gap pb-landing-pricing-value-row-bottom-inset border-b border-border-subtle">
    <strong className="text-landing-price font-bold">{amount}</strong>
    <span className="text-content-secondary text-landing-price-unit">/ 월</span>
  </div>;
}
