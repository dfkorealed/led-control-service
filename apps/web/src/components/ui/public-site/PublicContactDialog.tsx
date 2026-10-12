import { ModalDialog } from "../ModalDialog";
import { ContactEmailCard } from "./ContactEmailCard";

export function PublicContactDialog({ opener, onClose, plan }: { opener: HTMLElement | null; onClose: () => void; plan: string | null }) {
  return <ModalDialog isOpen title="도입 상담" description="현장에 맞는 조명 관제, 함께 준비해요."
    closeLabel="상담 팝업 닫기" onClose={onClose} returnFocusElement={opener}
    className="w-[min(650px,100%)]! max-h-[calc(100dvh-32px)]! rounded-panel! p-5! compact:p-8!"
    bodyClassName="field-day-inquiry-body">
    {plan && <p className="inquiry-selected-plan m-0 mb-4.5 rounded-landing-compact-summary-surface bg-action-primary-soft p-landing-inquiry-plan-inset text-landing-inquiry-plan text-brand-navy">선택한 요금제: <strong className="text-brand-blue">{plan}</strong></p>}
    <ContactEmailCard />
  </ModalDialog>;
}
