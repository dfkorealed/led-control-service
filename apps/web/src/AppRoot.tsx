import { QueryClient, QueryClientContext, QueryClientProvider } from "@tanstack/react-query";
import { useContext, useRef, useState } from "react";
import { App } from "./App";
import { logoutAfterRecovery, type AuthUser } from "./api/auth";
import { isTransientApiError } from "./api/client";
import { authMeQueryKey, clearTenantCache, principalKey } from "./api/principal-cache";
import { AppErrorBoundary, RouteLoadingState } from "./components/ui";
import { AuthView } from "./features/auth/AuthView";
import { clearAllActiveCommands } from "./features/control/active-command-store";

type Auth = { user: AuthUser };
type RootState = {
  client: QueryClient;
  generation: number;
  principal: string | null;
  handledError: Error | null;
  mode: "app" | "signing_out" | "signed_out";
};

export function AppRoot({ initialQueryClient }: { initialQueryClient?: QueryClient }) {
  const inheritedClient = useContext(QueryClientContext);
  const [state, setState] = useState<RootState>(() => {
    const client = initialQueryClient ?? inheritedClient ?? new QueryClient();
    const auth = client.getQueryData<Auth | null>(authMeQueryKey);
    return { client, generation: 0, principal: auth?.user ? principalKey(auth.user) : null, handledError: null, mode: "app" };
  });
  const current = useRef(state);
  const signingOut = useRef(false);

  function publish(next: RootState) {
    current.current = next;
    setState(next);
  }

  function rotateClient(next: Omit<RootState, "client" | "generation">, auth?: Auth, discardSession = false) {
    const previous = current.current.client;
    const client = new QueryClient({ defaultOptions: previous.getDefaultOptions() });
    if (auth) client.setQueryData(authMeQueryKey, auth);
    else if (next.handledError) {
      // 인증 실패만 전달하고 tenant data와 실행 중 mutation은 절대 새 client로 복사하지 않는다.
      const query = client.getQueryCache().build(client, { queryKey: authMeQueryKey });
      query.setState({ error: next.handledError, status: "error", fetchStatus: "idle" });
    } else client.setQueryData(authMeQueryKey, null);

    // clear() 뒤에도 mutation option callback은 살아 있다. 먼저 새 client를 게시하여
    // 이전 callback이 capture한 client로 다시 쓰더라도 현재 세션에서는 읽을 수 없게 한다.
    publish({ ...next, client, generation: current.current.generation + 1 });
    void previous.cancelQueries();
    clearTenantCache(previous);
    // Layout 전환 직후 old observer의 passive setOptions가 실행될 수 있다.
    // auth query 객체까지 제거하면 observer가 새 query로 오인해 401/403을 다시 요청하므로
    // 해당 객체는 null로 비우고 나머지만 제거한다. old client 자체는 더 이상 소비하지 않는다.
    previous.removeQueries({ predicate: (query) => query.queryKey.length !== 2 || query.queryKey[0] !== "auth" || query.queryKey[1] !== "me" });
    previous.setQueryData(authMeQueryKey, null);
    if (discardSession) clearAllActiveCommands();
  }

  function handleRejected(error: Error) {
    if (state.client !== current.current.client || current.current.handledError === error) return;
    rotateClient({ ...current.current, handledError: error, mode: "app" }, undefined, !isTransientApiError(error));
  }

  async function handleAuthenticated(auth: Auth) {
    if (state.client !== current.current.client || signingOut.current) return;
    rotateClient({ principal: principalKey(auth.user), handledError: null, mode: "app" }, auth, true);
  }

  function handlePrincipalChanged(auth: Auth) {
    if (state.client !== current.current.client || signingOut.current) return;
    const principal = principalKey(auth.user);
    // 최초 정상 부팅은 기존 사용자의 세션 내 제어 복구 기록을 보존한다.
    if (current.current.generation === 0 && current.current.principal === null) {
      publish({ ...current.current, principal });
      return;
    }
    rotateClient({ principal, handledError: null, mode: "app" }, auth, principal !== current.current.principal);
  }

  async function handleRelogin() {
    // React commit 전 같은 event batch의 중복 클릭도 동기적으로 차단한다.
    if (signingOut.current || state.client !== current.current.client) return;
    signingOut.current = true;
    rotateClient({ principal: null, handledError: null, mode: "signing_out" }, undefined, true);
    await logoutAfterRecovery();
    signingOut.current = false;
    publish({ ...current.current, mode: "signed_out" });
  }

  return <QueryClientProvider client={state.client}>
    <AppErrorBoundary resetKey={state.generation} onRelogin={() => { void handleRelogin(); }} isPending={state.mode === "signing_out"}>
      {state.mode === "signing_out" ? <RouteLoadingState variant="page" /> : state.mode === "signed_out"
        ? <AuthView onAuthenticated={handleAuthenticated} />
        : <App key={state.generation} acceptedPrincipal={state.principal} onAuthenticated={handleAuthenticated}
          onRelogin={() => { void handleRelogin(); }} onAuthRejected={handleRejected} onPrincipalChanged={handlePrincipalChanged} />}
    </AppErrorBoundary>
  </QueryClientProvider>;
}
