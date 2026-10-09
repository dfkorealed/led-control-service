import { useRef, useState, type ReactNode } from "react";
import { Button } from "../../components/ui/Button";
import { LinkButton } from "../../components/ui/LinkButton";
import { NativeDialog } from "../../components/ui/overlays/NativeDialog";
import { SiteFrame } from "../../components/ui/public-site/SiteFrame";
import { useSiteConsultation } from "../../components/ui/public-site/useSiteConsultation";
import { InquiryForm } from "./InquiryForm";
import type { OpenInquiry } from "./PublicSiteLayout";

/** Archived presentation stays exclusively in the general app's concept entry. */
export function ConceptSiteLayout({ children }: { children: (openInquiry: OpenInquiry) => ReactNode }) {
  const contact = useSiteConsultation("현장의 하루 · 킨다 랜딩 시안");
  const [pending, setPending] = useState(false);
  const close = useRef<HTMLButtonElement>(null);
  const submit = useRef<HTMLButtonElement>(null);
  return <SiteFrame raisedHeader={contact.scrolled} brandHref="#top" brandLabel="킨다 시안 맨 위로" logoPresentation="concept"
    className="leading-landing-concept-document [&_:focus-visible]:outline-3 [&_:focus-visible]:outline-solid [&_:focus-visible]:outline-brand-navy [&_:focus-visible]:outline-offset-4 [&_:focus-visible]:shadow-none"
    headerClassName="[&_:focus-visible]:outline-brand-coral!" headerFrameClassName="landing-stack:min-h-[68px]"
    navigationClassName="landing-stack:gap-3.5 landing-stack:landing-narrow:gap-2.5"
    navigation={<><Button ref={contact.headerContact} type="button" variant="landingConceptHeaderContact" data-open-inquiry="" className="header-contact" onClick={contact.open}>도입 상담</Button>
      <LinkButton href="/login" variant="landingConceptHeader" className="button--header">로그인 <span aria-hidden="true">↗</span></LinkButton></>}
    footer={<footer className="footer border-t border-surface-panel/12 bg-surface-inverse p-landing-concept-footer-body-inset text-landing-concept-footer-body text-action-primary-soft"><div className="footer-inner mx-auto flex w-[min(1180px,calc(100%-72px))] justify-between gap-4.5 landing-stack:w-[calc(100%-38px)] landing-stack:flex-col landing-stack:landing-narrow:w-[calc(100%-30px)]"><strong className="text-surface-panel">킨다 · 현장의 하루</strong><span>이 페이지는 디자인 방향을 검토하기 위한 시안입니다.</span></div></footer>}
    consultation={<NativeDialog closeButtonRef={close} submitButtonRef={submit} isOpen={contact.isOpen} isPending={pending} onClose={contact.close} returnFocusElement={contact.opener} title="도입 상담" description="현장에 필요한 관제 구성을 함께 살펴보겠습니다."><InquiryForm submitButtonRef={submit} onSuccess={() => close.current?.focus()} presentation="concept" onPendingChange={setPending} /></NativeDialog>}>
    {children(contact.open)}
  </SiteFrame>;
}
