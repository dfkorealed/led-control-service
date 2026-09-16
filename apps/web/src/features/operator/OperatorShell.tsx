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
import { Text } from "../../components/ui/Typography";
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
    <div className="min-h-screen bg-surface-canvas">
      <header className="flex min-h-16 items-center justify-between gap-4 border-b border-border-default bg-surface-panel px-6 py-4 max-compact:flex-col max-compact:items-start max-compact:px-3.5">
        <KindaLogo context="서비스 운영" />
        <div className="flex items-center gap-3 max-compact:w-full max-compact:justify-between">
          <Text as="span" variant="body-sm" tone="secondary" weight="bold">{user.loginId}</Text>
          <IconTooltipButton
            className="size-13"
            icon={LogOut}
            label="로그아웃"
            loadingLabel="로그아웃 중"
            isLoading={isLoggingOut}
            onClick={handleLogout}
          />
        </div>
      </header>
      <main className="mx-auto grid w-full max-w-6xl content-start gap-5 px-6 py-10 max-compact:px-3.5 max-compact:py-6">
        {logoutError ? <FeedbackState tone="danger" icon={CircleAlert} title={logoutError} /> : null}
        <UnderlineNavigation aria-label="운영자 메뉴">
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
