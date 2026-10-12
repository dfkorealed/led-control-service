import { ArrowUpRight, Mail } from "lucide-react";
import { Card } from "../Card";
import { LinkButton } from "../LinkButton";
import { publicContact } from "./public-contact";

export function ContactEmailCard() {
  return <Card className="relative isolate overflow-hidden border-0 bg-brand-navy p-5 text-surface-panel compact:p-7" aria-label="이메일 도입 상담">
    <div className="pointer-events-none absolute -right-12 -top-12 -z-1 size-48 rounded-landing-ellipse border border-surface-panel/10" aria-hidden="true" />
    <div className="mb-6 flex items-center gap-3"><span className="grid size-11 place-items-center rounded-panel bg-surface-panel/10 text-brand-coral"><Mail className="size-5" aria-hidden="true" /></span><span className="text-overline font-bold text-brand-coral">LET’S TALK</span></div>
    <h3 className="m-0 text-section-title font-bold">우리 현장의 시작,<br />이메일로 함께 준비해요.</h3>
    <p className="mb-4 mt-3 text-body-sm text-action-primary-soft">현장 규모와 설치 환경, 필요한 운영 기능을 알려주세요.</p>
    <a className="mb-6 inline-flex min-h-11 items-center text-body-sm font-bold text-surface-panel underline decoration-surface-panel/30 underline-offset-4 wrap-anywhere hover:text-brand-coral" href={publicContact.emailHref}>{publicContact.email}</a>
    <LinkButton href={publicContact.emailHref} variant="landingCta" className="w-full justify-between">이메일로 상담하기 <ArrowUpRight className="size-4" aria-hidden="true" /></LinkButton>
    <p className="mb-0 mt-3 text-center text-body-sm text-action-primary-soft">사용 중인 이메일 앱으로 연결됩니다.</p>
  </Card>;
}
