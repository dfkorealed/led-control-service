import React from "react";
import ReactDOM from "react-dom/client";
import { LandingPage } from "./features/landing/LandingPage";
import { FeaturesPage } from "./features/landing/FeaturesPage";
import { PricingPage } from "./features/landing/PricingPage";
import { LinkButton } from "./components/ui/LinkButton";

export function PublicLandingEntry({ pathname = window.location.pathname }: { pathname?: string }) {
  switch (pathname) {
    case "/": return <LandingPage />;
    case "/features": return <FeaturesPage />;
    case "/pricing": return <PricingPage />;
    default: return <main className="flex min-h-dvh flex-col items-center justify-center gap-6 bg-brand-paper p-6 text-center text-brand-navy">
      <h1 className="text-page-title font-bold">페이지를 찾을 수 없습니다.</h1>
      <p className="text-body">주소를 확인하거나 킨다 홈으로 이동해 주세요.</p>
      <LinkButton href="/">킨다 홈으로</LinkButton>
    </main>;
  }
}

ReactDOM.createRoot(document.getElementById("root")!).render(<React.StrictMode><PublicLandingEntry /></React.StrictMode>);
