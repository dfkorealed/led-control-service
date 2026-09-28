import { onlineManager } from "@tanstack/react-query";
import React from "react";
import ReactDOM from "react-dom/client";
import { AppRoot } from "./AppRoot";
import { FieldDayConceptPage } from "./features/landing/FieldDayConceptPage";
import { LandingPage } from "./features/landing/LandingPage";
import { FeaturesPage } from "./features/landing/FeaturesPage";
import { PricingPage } from "./features/landing/PricingPage";

function WebEntry() {
  switch (window.location.pathname) {
    case "/concepts/field-day.html": return <FieldDayConceptPage />;
    case "/": return <LandingPage />;
    case "/features": return <FeaturesPage />;
    case "/pricing": return <PricingPage />;
    default: return <AppRoot />;
  }
}

// React Query는 online/offline 이벤트 전에는 online을 기본값으로 사용하므로 부팅 상태도 전달한다.
onlineManager.setOnline(navigator.onLine);

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <WebEntry />
  </React.StrictMode>
);
