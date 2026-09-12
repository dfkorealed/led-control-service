import { lazy, Suspense, useState } from "react";
import { CircleAlert, LogOut } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { Navigate, Route, Routes } from "react-router-dom";
import { logout, type AuthUser } from "../../api/auth";
import { authMeQueryKey, clearTenantCache } from "../../api/principal-cache";
import { RouteLoadingState } from "../../components/ui/RouteLoadingState";
import { FeedbackState } from "../../components/ui/FeedbackState";
import { IconTooltipButton } from "../../components/ui/IconTooltipButton";

const SiteAdminManagementView = lazy(() => import("./site-admins/SiteAdminManagementView").then((module) => ({ default: module.SiteAdminManagementView })));

export function OperatorShell({ user }: { user: AuthUser }) {
  const queryClient = useQueryClient();
  const [isLoggingOut, setIsLoggingOut] = useState(false);
  const [logoutError, setLogoutError] = useState("");

  async function handleLogout() {
    if (isLoggingOut) return;
    setLogoutError("");
    setIsLoggingOut(true);
    try {
      await logout();
      clearTenantCache(queryClient);
      queryClient.setQueryData(authMeQueryKey, null);
    } catch {
      setIsLoggingOut(false);
      setLogoutError("로그아웃에 실패했습니다. 연결을 확인한 뒤 다시 시도하세요.");
    }
  }

  return (
    <div className="operator-shell">
      <header className="operator-header">
        <div className="brand operator-brand">
          <span className="brand-mark">LC</span>
          <div>
            <strong>LED Control</strong>
            <span>서비스 운영</span>
          </div>
        </div>
        <div className="operator-header-actions">
          <span className="operator-login-id">{user.loginId}</span>
          <IconTooltipButton
            className="logout-button"
            icon={LogOut}
            label="로그아웃"
            loadingLabel="로그아웃 중"
            isLoading={isLoggingOut}
            onClick={handleLogout}
          />
        </div>
      </header>
      <main className="operator-content">
        {logoutError ? <FeedbackState tone="danger" icon={CircleAlert} title={logoutError} /> : null}
        <Suspense fallback={<RouteLoadingState />}>
          <Routes>
            <Route path="/operator/site-admins" element={<SiteAdminManagementView />} />
            <Route path="*" element={<Navigate to="/operator/site-admins" replace />} />
          </Routes>
        </Suspense>
      </main>
    </div>
  );
}
