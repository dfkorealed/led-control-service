import { useQueryClient } from "@tanstack/react-query";
import { BrowserRouter } from "react-router-dom";
import { useCurrentUser } from "./api/auth";
import { AuthView } from "./features/auth/AuthView";
import { OperatorShell } from "./features/operator/OperatorShell";
import { CustomerShell } from "./features/shells/CustomerShell";
import "./styles.css";

export function App() {
  return (
    <BrowserRouter>
      <AppContent />
    </BrowserRouter>
  );
}

function AppContent() {
  const queryClient = useQueryClient();
  const { data: auth, isLoading: isAuthLoading, error: authError } = useCurrentUser();

  if (isAuthLoading) {
    return <main className="auth-shell"><section className="auth-panel">인증 상태를 확인하는 중</section></main>;
  }

  if (authError || !auth?.user) {
    return <AuthView onAuthenticated={() => queryClient.invalidateQueries({ queryKey: ["auth", "me"] })} />;
  }

  return auth.user.role === "operator"
    ? <OperatorShell user={auth.user} />
    : <CustomerShell user={auth.user} />;
}
