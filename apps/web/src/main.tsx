import type { QueryClient } from "@tanstack/react-query";
import React from "react";
import ReactDOM from "react-dom/client";
import { AppRoot } from "./AppRoot";
import { FieldDayConceptPage } from "./features/landing/FieldDayConceptPage";
import { LandingPage } from "./features/landing/LandingPage";
import { FeaturesPage } from "./features/landing/FeaturesPage";
import { PricingPage } from "./features/landing/PricingPage";
import { startMobileWebEntry } from "./features/mobile/mobile-bootstrap";
import { requiresNativeBootstrap } from "./features/mobile/mobile-environment";
import { MobilePreparation } from "./components/ui/MobilePreparation";

function WebEntry({ queryClient }: { queryClient?: QueryClient }) {
  switch (window.location.pathname) {
    case "/concepts/field-day.html": return <FieldDayConceptPage />;
    case "/": return <LandingPage />;
    case "/features": return <FeaturesPage />;
    case "/pricing": return <PricingPage />;
    default: return <AppRoot initialQueryClient={queryClient} />;
  }
}

const root = ReactDOM.createRoot(document.getElementById("root")!);
if (requiresNativeBootstrap()) root.render(<MobilePreparation />);
let dispose: (() => void) | undefined;
void startMobileWebEntry((queryClient) => root.render(<React.StrictMode><WebEntry queryClient={queryClient} /></React.StrictMode>))
  .then((cleanup) => { dispose = cleanup; })
  .catch(() => root.render(<MobilePreparation failed />));
import.meta.hot?.dispose(() => { dispose?.(); root.unmount(); });
