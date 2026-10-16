import { ModalDialog } from "../ModalDialog";
import { publicContact } from "./public-contact";

export function PublicContactDialog({ opener, onClose, plan }: { opener: HTMLElement | null; onClose: () => void; plan: string | null }) {
  return <ModalDialog isOpen title="도입 상담" description="전화 또는 이메일로 편하게 문의해 주세요. 필요한 관제 구성을 함께 살펴보겠습니다."
    closeLabel="상담 팝업 닫기" onClose={onClose} returnFocusElement={opener}
    className="w-[min(650px,100%)]! max-h-[calc(100dvh-32px)]! rounded-panel!"
    bodyClassName="field-day-inquiry-body">
    {plan && <p className="inquiry-selected-plan m-0 mb-4.5 rounded-landing-compact-summary-surface bg-action-primary-soft p-landing-inquiry-plan-inset text-landing-inquiry-plan text-brand-navy">선택한 요금제: <strong className="text-brand-blue">{plan}</strong></p>}
    <dl className="m-0 grid gap-6 text-body">
      <div><dt className="mb-2 font-bold text-content-primary">전화 상담</dt><dd className="m-0"><a className="inline-flex min-h-11 items-center text-brand-blue underline underline-offset-4" href={publicContact.phoneHref}>{publicContact.phone}</a></dd></div>
      <div><dt className="mb-2 font-bold text-content-primary">이메일 문의</dt><dd className="m-0 wrap-anywhere"><a className="inline-flex min-h-11 items-center text-brand-blue underline underline-offset-4 wrap-anywhere" href={publicContact.emailHref}>{publicContact.email}</a></dd></div>
    </dl>
  </ModalDialog>;
}
