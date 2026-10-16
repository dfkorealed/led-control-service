import React from "react";
import ReactDOM from "react-dom/client";
import { LandingPage } from "./features/landing/LandingPage";
import { FeaturesPage } from "./features/landing/FeaturesPage";
import { PricingPage } from "./features/landing/PricingPage";
import { LinkButton } from "./components/ui/LinkButton";
import { Heading, Text } from "./components/ui/Typography";
import { panelPaddingClass } from "./components/ui/FunctionalLayout";

export function PublicLandingEntry({ pathname = window.location.pathname }: { pathname?: string }) {
  switch (pathname) {
    case "/": return <LandingPage />;
    case "/features": return <FeaturesPage />;
    case "/pricing": return <PricingPage />;
    default: return <main className={`flex min-h-dvh flex-col items-center justify-center gap-5 bg-surface-canvas ${panelPaddingClass("regular")} text-center text-content-primary`}>
      <Heading as="h1" variant="customer-page-title">페이지를 찾을 수 없습니다.</Heading>
      <Text>주소를 확인하거나 킨다 홈으로 이동해 주세요.</Text>
      <LinkButton href="/">킨다 홈으로</LinkButton>
    </main>;
  }
}

ReactDOM.createRoot(document.getElementById("root")!).render(<React.StrictMode><PublicLandingEntry /></React.StrictMode>);
