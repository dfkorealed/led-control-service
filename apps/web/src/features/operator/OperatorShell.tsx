import { lazy, Suspense, useState } from "react";
import { CircleAlert, LogOut } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { Navigate, NavLink, Route, Routes, useLocation } from "react-router-dom";
import { logout, type AuthUser } from "../../api/auth";
import { authMeQueryKey, clearTenantCache } from "../../api/principal-cache";
import { KindaLogo } from "../../components/brand/KindaLogo";
import { RouteLoadingState } from "../../components/ui/RouteLoadingState";
import { FeedbackState } from "../../components/ui/FeedbackState";
import { IconTooltipButton } from "../../components/ui/IconTooltipButton";
import { UnderlineNavigation, UnderlineNavigationLabel } from "../../components/ui/UnderlineNavigation";

const SiteAdminManagementView = lazy(() => import("./site-admins/SiteAdminManagementView").then((module) => ({ default: module.SiteAdminManagementView })));
const AccountSecurityView = lazy(() => import("../settings/security/AccountSecurityView").then((module) => ({ default: module.AccountSecurityView })));

export function OperatorShell({ user }: { user: AuthUser }) {
  const location = useLocation();
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
        <KindaLogo className="operator-brand" context="서비스 운영" />
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
        <UnderlineNavigation className="operator-navigation" aria-label="운영자 메뉴">
          <NavLink
            to={{ pathname: "/operator/site-admins", search: location.search, hash: location.hash }}
            className={({ isActive }) => isActive ? "ui-underline-navigation-item active" : "ui-underline-navigation-item"}
          >
            <UnderlineNavigationLabel>현장 관리자</UnderlineNavigationLabel>
          </NavLink>
          <NavLink
            to={{ pathname: "/operator/security", search: location.search, hash: location.hash }}
            className={({ isActive }) => isActive ? "ui-underline-navigation-item active" : "ui-underline-navigation-item"}
          >
            <UnderlineNavigationLabel>계정 보안</UnderlineNavigationLabel>
          </NavLink>
        </UnderlineNavigation>
        <Suspense fallback={<RouteLoadingState />}>
          <Routes>
            <Route path="/operator/site-admins" element={<SiteAdminManagementView />} />
            <Route path="/operator/security" element={<AccountSecurityView user={user} />} />
            <Route path="*" element={<Navigate to="/operator/site-admins" replace />} />
          </Routes>
        </Suspense>
      </main>
    </div>
  );
}
