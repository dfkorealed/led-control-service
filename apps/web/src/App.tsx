import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { lazy, Suspense, useLayoutEffect } from "react";
import { BrowserRouter, useNavigate } from "react-router-dom";
import { useCurrentUser, type AuthUser } from "./api/auth";
import { isApiStatus, isTransientApiError } from "./api/client";
import { clearTenantCache, principalKey } from "./api/principal-cache";
import { AuthView } from "./features/auth/AuthView";
import { RequiredPasswordChangeView } from "./features/auth/RequiredPasswordChangeView";
import { AppRecoveryState, RouteLoadingState } from "./components/ui";
import "./styles.css";

const CustomerShell = lazy(async () => ({
  default: (await import("./features/shells/CustomerShell")).CustomerShell
}));
const OperatorShell = lazy(async () => ({
  default: (await import("./features/operator/OperatorShell")).OperatorShell
}));

interface AppProps {
  acceptedPrincipal: string | null;
  onAuthenticated: (auth: { user: AuthUser }) => Promise<void>;
  onRelogin: () => void;
  onAuthRejected: (error: Error) => void;
  onPrincipalChanged: (auth: { user: AuthUser }) => void;
}

export function App(props: AppProps) {
  const queryClient = useQueryClient();
  return <BrowserRouter><AppRuntime {...props} queryClient={queryClient} /></BrowserRouter>;
}

function AppRuntime(props: AppProps & { queryClient: QueryClient }) {
  const { queryClient } = props;
  // 비밀번호 변경의 cache 교체 후 navigate가 인증 observer도 다시 연결하도록 Router 안에 함께 둔다.
  const navigate = useNavigate();
  const query = useCurrentUser();
  const key = query.data?.user ? principalKey(query.data.user) : null;

  useLayoutEffect(() => {
    if (query.error) props.onAuthRejected(query.error);
    else if (query.data?.user && key !== props.acceptedPrincipal) props.onPrincipalChanged(query.data);
  }, [key, props, query.data, query.error]);

  let content;
  if (query.isPaused) {
    content = <AppRecoveryState variant="service_unavailable" onRetry={() => { void query.refetch(); }} onRelogin={props.onRelogin} />;
  } else if (query.isLoading) {
    content = <RouteLoadingState variant="page" aria-label="인증 상태를 확인하는 중" />;
  } else if (query.error && !isApiStatus(query.error, 401)) {
    content = <AppRecoveryState
      variant={isTransientApiError(query.error) ? "service_unavailable" : "forbidden"}
      onRetry={() => { clearTenantCache(queryClient); void query.refetch(); }}
      onRelogin={props.onRelogin}
      isPending={query.isFetching}
    />;
  } else if (query.error || !query.data?.user) {
    content = <AuthView onAuthenticated={props.onAuthenticated} />;
  } else if (key !== props.acceptedPrincipal) {
    content = <RouteLoadingState variant="page" />;
  } else {
    content = query.data.user.mustChangePassword
      ? <RequiredPasswordChangeView user={query.data.user} onCompleted={() => {
        navigate("/monitoring", { replace: true });
      }} />
      : <Suspense fallback={<RouteLoadingState variant="page" />}>
        {query.data.user.role === "operator" ? <OperatorShell user={query.data.user} /> : <CustomerShell user={query.data.user} />}
      </Suspense>;
  }
  return content;
}
