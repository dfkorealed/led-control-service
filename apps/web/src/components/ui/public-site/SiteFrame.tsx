import type { ReactNode } from "react";
import { KindaLogo, type KindaLogoProps } from "../../brand/KindaLogo";

interface SiteFrameProps {
  children: ReactNode;
  navigation: ReactNode;
  footer: ReactNode;
  consultation: ReactNode;
  raisedHeader: boolean;
  brandHref: string;
  brandLabel: string;
  logoPresentation: KindaLogoProps["presentation"];
  className?: string;
  headerClassName?: string;
  headerFrameClassName: string;
  navigationClassName: string;
}

/** Shared document structure; each entry owns its navigation, copy and presentation. */
export function SiteFrame({ children, navigation, footer, consultation, raisedHeader, brandHref, brandLabel,
  logoPresentation, className = "", headerClassName = "", headerFrameClassName, navigationClassName }: SiteFrameProps) {
  return <div className={`${className} field-day landing-page [&_*]:motion-reduce:[animation-duration:.01ms]! [&_*]:motion-reduce:[animation-iteration-count:1]! [&_*]:motion-reduce:duration-[.01ms]! [&_*::before]:motion-reduce:[animation-duration:.01ms]! [&_*::before]:motion-reduce:[animation-iteration-count:1]! [&_*::before]:motion-reduce:duration-[.01ms]! [&_*::after]:motion-reduce:[animation-duration:.01ms]! [&_*::after]:motion-reduce:[animation-iteration-count:1]! [&_*::after]:motion-reduce:duration-[.01ms]! min-w-[320px] bg-brand-paper font-landing text-brand-navy break-keep antialiased`}>
    <a className="skip-link fixed top-landing-skip-link-top left-4 z-100 rounded-landing-skip-link bg-surface-panel px-4 py-3 text-brand-navy focus:top-4" href="#main">본문으로 이동</a>
    <header className={`site-header ${headerClassName} fixed inset-x-0 top-0 z-20 text-surface-panel transition-[background,box-shadow] duration-250 ease-[ease] ${raisedHeader ? "is-scrolled bg-brand-navy/97 shadow-landing-header-raised" : ""}`}>
      <div className={`header-inner mx-auto w-[min(1180px,calc(100%-72px))] flex min-h-[82px] items-center justify-between gap-6 border-b border-surface-panel/18 landing-wide:landing-stack:w-[calc(100%-38px)] landing-wide:landing-stack:landing-narrow:w-[calc(100%-30px)] ${headerFrameClassName}`}>
        <a className="brand inline-flex items-center gap-2.5 text-landing-brand font-[850] landing-wide:landing-stack:landing-narrow:text-landing-brand-narrow" href={brandHref} aria-label={brandLabel}><KindaLogo presentation={logoPresentation} /></a>
        <nav className={`header-nav flex items-center gap-landing-navigation-gap text-landing-navigation font-[750] ${navigationClassName}`} aria-label="주요 메뉴">{navigation}</nav>
      </div>
    </header>
    {children}
    {footer}
    {consultation}
  </div>;
}
