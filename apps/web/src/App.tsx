import { useQueryClient } from "@tanstack/react-query";
import { lazy, Suspense, useLayoutEffect, useState } from "react";
import { BrowserRouter, useNavigate } from "react-router-dom";
import { reloginAfterRecovery, useCurrentUser } from "./api/auth";
import { isApiStatus, isTransientApiError } from "./api/client";
import { clearTenantCache, replacePrincipalCache } from "./api/principal-cache";
import { AuthView } from "./features/auth/AuthView";
import { RequiredPasswordChangeView } from "./features/auth/RequiredPasswordChangeView";
import { AppErrorBoundary, AppRecoveryState, RouteLoadingState } from "./components/ui";
import "./styles.css";

const CustomerShell = lazy(async () => ({
  default: (await import("./features/shells/CustomerShell")).CustomerShell
}));
const OperatorShell = lazy(async () => ({
  default: (await import("./features/operator/OperatorShell")).OperatorShell
}));

export function App() {
  const queryClient = useQueryClient();
  const [principalGeneration, setPrincipalGeneration] = useState(0);
  const [signedOut, setSignedOut] = useState(false);
  const [isSigningOut, setIsSigningOut] = useState(false);

  async function handleAuthenticated(auth: Parameters<typeof replacePrincipalCache>[1]) {
    await replacePrincipalCache(queryClient, auth);
    setSignedOut(false);
    setPrincipalGeneration((generation) => generation + 1);
  }

  async function handleRelogin() {
    if (isSigningOut) return;
    setIsSigningOut(true);
    await reloginAfterRecovery(queryClient);
    setSignedOut(true);
    setIsSigningOut(false);
    setPrincipalGeneration((generation) => generation + 1);
  }

  return (
    <AppErrorBoundary resetKey={principalGeneration} onRelogin={() => { void handleRelogin(); }} isPending={isSigningOut}>
      <BrowserRouter>
        {isSigningOut ? <RouteLoadingState variant="page" /> : signedOut
          ? <AuthView onAuthenticated={handleAuthenticated} />
          : <AppContent key={principalGeneration} onAuthenticated={handleAuthenticated} onRelogin={() => { void handleRelogin(); }} />}
      </BrowserRouter>
    </AppErrorBoundary>
  );
}

function AppContent({ onAuthenticated, onRelogin }: { onAuthenticated: Parameters<typeof AuthView>[0]["onAuthenticated"]; onRelogin: () => void }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { data: auth, isLoading: isAuthLoading, error: authError, refetch, isFetching } = useCurrentUser();
  const principalKey = auth?.user ? `${auth.user.id}:${auth.user.organizationId}` : null;
  const [acceptedPrincipalKey, setAcceptedPrincipalKey] = useState<string | null>();

  useLayoutEffect(() => {
    if (isAuthLoading) return;
    if (authError || !auth?.user) {
      clearTenantCache(queryClient);
      setAcceptedPrincipalKey(null);
      return;
    }
    if (acceptedPrincipalKey === undefined) {
      setAcceptedPrincipalKey(principalKey);
      return;
    }
    if (acceptedPrincipalKey !== principalKey) {
      clearTenantCache(queryClient);
      setAcceptedPrincipalKey(principalKey);
    }
  }, [acceptedPrincipalKey, auth?.user, authError, isAuthLoading, principalKey, queryClient]);

  if (isAuthLoading) {
    return <main className="auth-shell"><section className="auth-panel">인증 상태를 확인하는 중</section></main>;
  }

  if (authError && !isApiStatus(authError, 401)) {
    return <AppRecoveryState
      variant={isTransientApiError(authError) ? "service_unavailable" : "forbidden"}
      onRetry={() => { clearTenantCache(queryClient); void refetch(); }}
      onRelogin={onRelogin}
      isPending={isFetching}
    />;
  }

  if (authError || !auth?.user) {
    return <AuthView onAuthenticated={onAuthenticated} />;
  }

  if (auth.user.mustChangePassword) {
    return <RequiredPasswordChangeView user={auth.user} onCompleted={() => {
      navigate("/monitoring", { replace: true });
    }} />;
  }

  if (acceptedPrincipalKey !== undefined && acceptedPrincipalKey !== principalKey) {
    return <main className="auth-shell"><section className="auth-panel">인증 계정을 전환하는 중</section></main>;
  }

  return (
    <Suspense fallback={<RouteLoadingState variant="page" />}>
      {auth.user.role === "operator"
        ? <OperatorShell user={auth.user} />
        : <CustomerShell user={auth.user} />}
    </Suspense>
  );
}
