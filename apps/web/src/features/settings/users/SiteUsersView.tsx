import { useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { CircleAlert, CircleCheck, Clock3, KeyRound, Pencil, Plus, Search, Trash2, UserCheck, UserX } from "lucide-react";
import { ApiError } from "../../../api/client";
import { siteUsersQueryKey, updateSiteUser, useSiteUsers, type SiteUserAccessLevel, type SiteUserStatus, type SiteUserSummary, type SiteUsersResponse } from "../../../api/site-users";
import { Button, Card, FeedbackState, PageHeader, SearchField, SelectBox, StatusBadge, StatusDetailButton } from "../../../components/ui";
import { DeleteSiteUserDialog } from "./DeleteSiteUserDialog";
import { ResetSiteUserPasswordDialog } from "./ResetSiteUserPasswordDialog";
import { SiteUserFormDialog } from "./SiteUserFormDialog";
import { siteUserErrorCode, siteUserErrorMessage } from "./site-user-form";

type DialogState = { type: "create" } | { type: "edit" | "reset" | "delete"; user: SiteUserSummary };
type AccessFilter = "all" | SiteUserAccessLevel;
type StatusFilter = "all" | SiteUserStatus;

export function SiteUsersView({ siteId }: { siteId?: string }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const usersQuery = useSiteUsers(siteId);
  const addButtonRef = useRef<HTMLButtonElement>(null);
  const busyActionRef = useRef(false);
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [returnFocusElement, setReturnFocusElement] = useState<HTMLElement | null>(null);
  const [search, setSearch] = useState("");
  const [accessFilter, setAccessFilter] = useState<AccessFilter>("all");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [notice, setNotice] = useState("");
  const [actionError, setActionError] = useState("");
  const [refreshError, setRefreshError] = useState("");
  const [busyUserId, setBusyUserId] = useState<string | null>(null);
  const [serverLimitReached, setServerLimitReached] = useState(false);

  const data = usersQuery.data;
  const atLimit = serverLimitReached || Boolean(data && data.count >= data.limit);

  useEffect(() => {
    if (data && data.count < data.limit) setServerLimitReached(false);
  }, [data]);
  const filteredUsers = useMemo(() => {
    const needle = search.trim().toLocaleLowerCase("ko-KR");
    return (data?.users ?? []).filter((user) => {
      const matchesSearch = !needle || user.name.toLocaleLowerCase("ko-KR").includes(needle) || user.loginId.toLocaleLowerCase("ko-KR").includes(needle);
      return matchesSearch
        && (accessFilter === "all" || user.accessLevel === accessFilter)
        && (statusFilter === "all" || user.status === statusFilter);
    });
  }, [accessFilter, data?.users, search, statusFilter]);

  function openDialog(next: DialogState, trigger: HTMLElement) {
    setNotice("");
    setActionError("");
    setReturnFocusElement(trigger);
    setDialog(next);
  }

  function refreshWithNotice(message: string) {
    setNotice(message);
    setActionError("");
    setRefreshError("");
    void queryClient.invalidateQueries({ queryKey: siteUsersQueryKey(siteId!) }).catch(() => {
      setRefreshError("최신 사용자 목록을 불러오지 못했습니다. 기존 목록을 표시합니다.");
    });
  }

  async function recoverMutationError(error: unknown): Promise<string | null> {
    const code = siteUserErrorCode(error);
    const message = siteUserErrorMessage(error);
    if (code === "SITE_CAPABILITY_DENIED") {
      setDialog(null);
      navigate(`/settings?siteId=${encodeURIComponent(siteId!)}`, { replace: true });
      return null;
    }
    if (code === "SITE_USER_CHANGED" || code === "SITE_USER_NOT_FOUND") {
      setRefreshError("");
      try {
        const result = await usersQuery.refetch();
        if (result.data && result.data.count < result.data.limit) setServerLimitReached(false);
        if (result.error) throw result.error;
      } catch {
        setRefreshError("최신 사용자 목록을 불러오지 못했습니다. 기존 목록을 표시합니다.");
      }
      setDialog(null);
      setActionError(message);
      return null;
    }
    return message;
  }

  function removeDeletedUserFromCache(userId: string) {
    queryClient.setQueryData<SiteUsersResponse>(siteUsersQueryKey(siteId!), (current) => {
      if (!current) return current;
      const users = current.users.filter((user) => user.id !== userId);
      if (users.length === current.users.length) return current;
      return { ...current, users, count: Math.max(0, current.count - 1) };
    });
    setServerLimitReached(false);
  }

  function completeDeletion(userId: string, message: string) {
    removeDeletedUserFromCache(userId);
    refreshWithNotice(message);
  }

  async function toggleStatus(user: SiteUserSummary) {
    if (!siteId || busyActionRef.current) return;
    busyActionRef.current = true;
    setNotice("");
    setActionError("");
    setBusyUserId(user.id);
    const nextStatus = user.status === "active" ? "disabled" : "active";
    try {
      await updateStatus(user, nextStatus);
      refreshWithNotice(nextStatus === "active" ? "사용자를 활성화했습니다." : "사용자를 비활성화하고 기존 세션을 종료했습니다.");
    } catch (error) {
      if (siteUserErrorCode(error) === "SITE_USER_CHANGED") {
        try {
          const refreshed = await usersQuery.refetch();
          if (refreshed.error) throw refreshed.error;
          const latest = refreshed.data?.users.find((candidate) => candidate.id === user.id);
          if (!latest) throw new ApiError("site user not found", 404, { code: "SITE_USER_NOT_FOUND" });
          await updateStatus(latest, nextStatus);
          refreshWithNotice(nextStatus === "active" ? "사용자를 활성화했습니다." : "사용자를 비활성화하고 기존 세션을 종료했습니다.");
          return;
        } catch (retryError) {
          const message = await recoverMutationError(retryError);
          if (message) setActionError(message);
          return;
        }
      }
      const message = await recoverMutationError(error);
      if (message) setActionError(message);
    } finally {
      busyActionRef.current = false;
      setBusyUserId(null);
    }
  }

  function updateStatus(user: SiteUserSummary, status: SiteUserStatus) {
    return updateSiteUser(siteId!, user.id, {
      name: user.name,
      loginId: user.loginId,
      accessLevel: user.accessLevel,
      status,
      expectedUpdatedAt: user.updatedAt
    });
  }

  if (!siteId) return <FeedbackState tone="neutral" icon={CircleAlert} title="유저를 관리할 현장을 선택하세요." />;

  return <section className="grid min-w-0 content-start gap-4" aria-label="유저 관리">
    <PageHeader
      title="유저 관리"
      description="현장을 조회하거나 조명을 제어할 사용자를 관리합니다."
      actions={<div className="flex flex-wrap items-center gap-2">
        {atLimit ? <StatusDetailButton label="사용자 등록 한도" description="현장 사용자는 최대 100명까지 등록할 수 있습니다." /> : null}
        {refreshError && data ? <StatusDetailButton label="사용자 목록 갱신 실패" description={refreshError}
          action={{ label: "목록 다시 시도", onClick: () => { setRefreshError(""); void usersQuery.refetch(); } }} /> : null}
        {usersQuery.error && data ? <StatusDetailButton label="사용자 목록 재조회 실패"
          description="최신 사용자 목록을 불러오지 못했습니다. 기존 목록을 표시합니다."
          action={{ label: "목록 다시 시도", onClick: () => { void usersQuery.refetch(); } }} /> : null}
        <Button ref={addButtonRef} type="button" variant="primary" disabled={atLimit} onClick={(event) => openDialog({ type: "create" }, event.currentTarget)}><Plus size={16} aria-hidden="true" /> 사용자 추가</Button>
      </div>}
    />

    {notice ? <FeedbackState tone="success" icon={CircleCheck} title={notice} /> : null}
    {actionError ? <FeedbackState tone="danger" icon={CircleAlert} title={actionError} /> : null}
    {refreshError && !data ? <FeedbackState tone="danger" icon={CircleAlert} title={refreshError} action={<Button type="button" onClick={() => { setRefreshError(""); void usersQuery.refetch(); }}>목록 다시 시도</Button>} /> : null}

    {usersQuery.isLoading && !data ? <FeedbackState tone="neutral" icon={Clock3} title="사용자 목록을 불러오는 중입니다." /> : null}
    {usersQuery.error && !data ? <FeedbackState tone="danger" icon={CircleAlert} title="사용자 목록을 불러오지 못했습니다." action={<Button type="button" onClick={() => void usersQuery.refetch()}>목록 다시 시도</Button>} /> : null}

    {data ? <>
      <div className="grid items-end gap-3 compact:grid-cols-2 tablet:grid-cols-[minmax(220px,1fr)_150px_150px_auto]">
        <SearchField aria-label="사용자 검색" value={search} onChange={setSearch} placeholder="이름 또는 로그인 아이디 검색" className="compact:col-span-2 tablet:col-span-1" />
        <SelectBox aria-label="권한 필터" items={[{ id: "all", label: "모든 권한" }, { id: "read", label: "조회" }, { id: "control", label: "제어" }]} selectedKey={accessFilter} onSelectionChange={(key) => { if (key) setAccessFilter(key as AccessFilter); }} />
        <SelectBox aria-label="상태 필터" items={[{ id: "all", label: "모든 상태" }, { id: "active", label: "활성" }, { id: "disabled", label: "비활성" }]} selectedKey={statusFilter} onSelectionChange={(key) => { if (key) setStatusFilter(key as StatusFilter); }} />
        <strong className="whitespace-nowrap text-body text-action-primary tablet:justify-self-end">{data.count} / {data.limit}명</strong>
      </div>

      {data.users.length === 0 ? <FeedbackState tone="neutral" icon={UserCheck} title="등록된 사용자가 없습니다." description="사용자 추가 버튼으로 현장 사용자를 등록하세요." /> : filteredUsers.length === 0 ? <FeedbackState tone="neutral" icon={Search} title="검색 조건에 맞는 사용자가 없습니다." /> : (
        <Card className="overflow-x-auto p-0" tabIndex={0} aria-label="현장 사용자 목록 표">
          <table className="w-full border-collapse text-caption" aria-label="현장 사용자 목록">
            <thead><tr className="bg-surface-inset text-content-secondary [&>th]:whitespace-nowrap [&>th]:border-b [&>th]:border-border-default [&>th]:px-4 [&>th]:py-3 [&>th]:text-left"><th scope="col">이름</th><th scope="col">로그인 아이디</th><th scope="col">권한</th><th scope="col">상태</th><th scope="col">최근 로그인</th><th scope="col">관리</th></tr></thead>
            <tbody>{filteredUsers.map((user) => <tr key={user.id}>
              <td className="whitespace-nowrap border-b border-border-default px-4 py-3 font-bold">{user.name}</td><td className="whitespace-nowrap border-b border-border-default px-4 py-3 font-bold">{user.loginId}</td>
              <td className="whitespace-nowrap border-b border-border-default px-4 py-3"><StatusBadge tone={user.accessLevel === "control" ? "info" : "neutral"} icon={user.accessLevel === "control" ? CircleCheck : UserCheck}>{user.accessLevel === "control" ? "제어" : "조회"}</StatusBadge></td>
              <td className="whitespace-nowrap border-b border-border-default px-4 py-3"><StatusBadge tone={user.status === "active" ? "success" : "danger"} icon={user.status === "active" ? CircleCheck : CircleAlert}>{user.status === "active" ? "활성" : "비활성"}</StatusBadge></td>
              <td className="whitespace-nowrap border-b border-border-default px-4 py-3">{formatLastLogin(user.lastLoginAt)}</td>
              <td className="whitespace-nowrap border-b border-border-default px-4 py-3"><div className="flex gap-1">
                <IconAction label={`${user.name} 수정`} title="사용자 수정" icon={Pencil} onClick={(event) => openDialog({ type: "edit", user }, event.currentTarget)} />
                <IconAction label={`${user.name} 비밀번호 초기화`} title="비밀번호 초기화" icon={KeyRound} onClick={(event) => openDialog({ type: "reset", user }, event.currentTarget)} />
                <IconAction label={`${user.name} ${user.status === "active" ? "비활성화" : "활성화"}`} title={user.status === "active" ? "비활성화" : "활성화"} icon={user.status === "active" ? UserX : UserCheck} disabled={busyUserId !== null} onClick={() => void toggleStatus(user)} />
                <IconAction label={`${user.name} 영구 삭제`} title="영구 삭제" icon={Trash2} danger onClick={(event) => openDialog({ type: "delete", user }, event.currentTarget)} />
              </div></td>
            </tr>)}</tbody>
          </table>
        </Card>
      )}
      <p className="m-0 text-caption text-content-secondary">비활성 사용자도 100명 제한에 포함됩니다. 삭제된 사용자는 인원에서 제외됩니다.</p>
    </> : null}

    {dialog?.type === "create" ? <SiteUserFormDialog siteId={siteId} returnFocusElement={returnFocusElement ?? addButtonRef.current} fallbackFocusElement={addButtonRef.current} onClose={() => setDialog(null)} onCompleted={refreshWithNotice} onLimitReached={() => setServerLimitReached(true)} onMutationError={recoverMutationError} /> : null}
    {dialog?.type === "edit" ? <SiteUserFormDialog siteId={siteId} user={dialog.user} returnFocusElement={returnFocusElement ?? addButtonRef.current} fallbackFocusElement={addButtonRef.current} onClose={() => setDialog(null)} onCompleted={refreshWithNotice} onMutationError={recoverMutationError} /> : null}
    {dialog?.type === "reset" ? <ResetSiteUserPasswordDialog siteId={siteId} user={dialog.user} returnFocusElement={returnFocusElement ?? addButtonRef.current} fallbackFocusElement={addButtonRef.current} onClose={() => setDialog(null)} onCompleted={refreshWithNotice} onMutationError={recoverMutationError} /> : null}
    {dialog?.type === "delete" ? <DeleteSiteUserDialog siteId={siteId} user={dialog.user} returnFocusElement={returnFocusElement ?? addButtonRef.current} fallbackFocusElement={addButtonRef.current} onClose={() => setDialog(null)} onCompleted={(message) => completeDeletion(dialog.user.id, message)} onMutationError={recoverMutationError} /> : null}
  </section>;
}

function IconAction({ label, title, icon: Icon, danger = false, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { label: string; title: string; icon: typeof Pencil; danger?: boolean }) {
  return <Button type="button" variant={danger ? "danger" : "ghost"} className="h-11 min-h-11 w-11 min-w-11 p-0" aria-label={label} title={title} {...props}><Icon size={16} aria-hidden="true" /></Button>;
}

function formatLastLogin(value: string | null) {
  if (!value) return "로그인 기록 없음";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return new Intl.DateTimeFormat("ko-KR", { dateStyle: "medium", timeStyle: "short" }).format(date);
}
