const companyBase = "https://dfkorealed.com";

const links = [
  { label: "회사 소개", href: `${companyBase}/about` },
  { label: "제품 소개", href: `${companyBase}/products` },
  { label: "인증 현황", href: `${companyBase}/certificates` },
  { label: "회사 소식", href: `${companyBase}/blog` }
] as const;

const container = "mx-auto w-[min(1180px,calc(100%-72px))] phone-wide:max-w-[360px] compact:max-w-[760px] tablet:max-w-[1024px] landing-wide:landing-stack:w-[calc(100%-38px)] landing-wide:landing-stack:landing-narrow:w-[calc(100%-30px)]";
const linkClass = "text-action-primary-soft no-underline hover:text-brand-coral hover:underline hover:underline-offset-4";
const headingClass = "m-landing-footer-heading-margin text-landing-footer-heading font-[850] text-surface-panel";

export function CompanyFooter() {
  return <footer className="footer border-t border-surface-panel/12 bg-surface-inverse py-landing-footer-body-block-inset text-landing-footer-body text-action-primary-soft">
    <div className={`${container} footer-main grid grid-cols-[1.4fr_1.3fr_.7fr] gap-landing-footer-main-gap pb-landing-footer-main-bottom-inset landing-wide:grid-cols-2 landing-wide:landing-stack:grid-cols-1 landing-wide:landing-stack:gap-landing-footer-main-stacked-gap`}>
      <div className="footer-company"><strong className="block text-landing-footer-company text-surface-panel">(주)디에프코리아</strong><p className="m-landing-footer-description-margin leading-landing-footer-description">조명 제품과 현장 운영을 연결합니다.</p><a className={`${linkClass} font-extrabold`} href={companyBase}>회사 홈페이지 <span aria-hidden="true">↗</span></a></div>
      <div className="footer-contact"><h2 className={headingClass}>문의 및 위치</h2><dl className="m-0 grid gap-landing-footer-contacts-gap">
        <div className="grid grid-cols-[54px_minmax(0,1fr)] gap-2.5 leading-landing-footer-contact-row"><dt className="font-[750] text-surface-panel">전화</dt><dd className="m-0 wrap-anywhere"><a className={linkClass} href="tel:0325282953">032-528-2953</a></dd></div>
        <div className="grid grid-cols-[54px_minmax(0,1fr)] gap-2.5 leading-landing-footer-contact-row"><dt className="font-[750] text-surface-panel">팩스</dt><dd className="m-0 wrap-anywhere">032-551-2954</dd></div>
        <div className="grid grid-cols-[54px_minmax(0,1fr)] gap-2.5 leading-landing-footer-contact-row"><dt className="font-[750] text-surface-panel">이메일</dt><dd className="m-0 wrap-anywhere"><a className={linkClass} href="mailto:kjukym@dfkorealed.com">kjukym@dfkorealed.com</a></dd></div>
        <div className="grid grid-cols-[54px_minmax(0,1fr)] gap-2.5 leading-landing-footer-contact-row"><dt className="font-[750] text-surface-panel">주소</dt><dd className="m-0 wrap-anywhere">인천광역시 부평구 평천로 199번길 53 A동 2층</dd></div>
      </dl></div>
      <nav className="footer-links flex flex-col items-start gap-3.5 landing-wide:col-span-full landing-wide:flex-row landing-wide:flex-wrap landing-wide:gap-x-6 landing-wide:landing-stack:col-auto" aria-label="회사 페이지"><h2 className={`${headingClass} mb-2 landing-wide:w-full`}>디에프코리아</h2>{links.map(link => <a className={linkClass} key={link.href} href={link.href}>{link.label}</a>)}</nav>
    </div>
    <div className={`${container} footer-bottom flex justify-between gap-4.5 border-t border-surface-panel/15 pt-landing-footer-legal-top-inset text-landing-footer-legal landing-wide:landing-stack:flex-col`}><span>© {new Date().getFullYear()} DF KOREA. All rights reserved.</span><span>이 페이지의 조명과 수치는 기능 설명을 위한 예시입니다.</span></div>
  </footer>;
}
