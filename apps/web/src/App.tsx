import { useQueryClient } from "@tanstack/react-query";
import { useLayoutEffect, useState } from "react";
import { BrowserRouter } from "react-router-dom";
import { useCurrentUser } from "./api/auth";
import { clearTenantCache, replacePrincipalCache } from "./api/principal-cache";
import { AuthView } from "./features/auth/AuthView";
import { OperatorShell } from "./features/operator/OperatorShell";
import { CustomerShell } from "./features/shells/CustomerShell";
import "./styles.css";

export function App() {
  const queryClient = useQueryClient();
  const [principalGeneration, setPrincipalGeneration] = useState(0);

  async function handleAuthenticated(auth: Parameters<typeof replacePrincipalCache>[1]) {
    await replacePrincipalCache(queryClient, auth);
    setPrincipalGeneration((generation) => generation + 1);
  }

  return (
    <BrowserRouter>
      <AppContent key={principalGeneration} onAuthenticated={handleAuthenticated} />
    </BrowserRouter>
  );
}

function AppContent({ onAuthenticated }: { onAuthenticated: Parameters<typeof AuthView>[0]["onAuthenticated"] }) {
  const queryClient = useQueryClient();
  const { data: auth, isLoading: isAuthLoading, error: authError } = useCurrentUser();
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

  if (authError || !auth?.user) {
    return <AuthView onAuthenticated={onAuthenticated} />;
  }

  if (acceptedPrincipalKey !== undefined && acceptedPrincipalKey !== principalKey) {
    return <main className="auth-shell"><section className="auth-panel">인증 계정을 전환하는 중</section></main>;
  }

  return auth.user.role === "operator"
    ? <OperatorShell user={auth.user} />
    : <CustomerShell user={auth.user} />;
}
