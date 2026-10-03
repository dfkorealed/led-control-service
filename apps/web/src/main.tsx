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
import { Button } from "./components/ui/Button";

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

function MobilePreparation({ failed = false }: { failed?: boolean }) {
  return <main className="flex min-h-dvh flex-col items-center justify-center gap-4 bg-surface-canvas p-6 text-body text-content-primary" role={failed ? "alert" : "status"}>
    <p>{failed ? "앱 연결을 준비하지 못했습니다. 다시 시도해 주세요." : "앱 연결을 준비하고 있습니다."}</p>
    {failed && <Button onClick={() => location.reload()}>다시 연결</Button>}
  </main>;
}
