import { useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { CircleAlert, CircleCheck, Clock3, KeyRound, Pencil, Plus, Search, Trash2, UserCheck, UserX } from "lucide-react";
import { siteUsersQueryKey, updateSiteUser, useSiteUsers, type SiteUserAccessLevel, type SiteUserStatus, type SiteUserSummary, type SiteUsersResponse } from "../../../api/site-users";
import { Button, Card, FeedbackState, PageHeader, StatusBadge } from "../../../components/ui";
import { DeleteSiteUserDialog } from "./DeleteSiteUserDialog";
import { ResetSiteUserPasswordDialog } from "./ResetSiteUserPasswordDialog";
import { SiteUserFormDialog } from "./SiteUserFormDialog";
import { siteUserErrorCode, siteUserErrorMessage } from "./site-user-form";
import "./SiteUsersView.css";

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
    try {
      const nextStatus = user.status === "active" ? "disabled" : "active";
      await updateSiteUser(siteId, user.id, {
        name: user.name,
        loginId: user.loginId,
        accessLevel: user.accessLevel,
        status: nextStatus,
        expectedUpdatedAt: user.updatedAt
      });
      refreshWithNotice(nextStatus === "active" ? "사용자를 활성화했습니다." : "사용자를 비활성화하고 기존 세션을 종료했습니다.");
    } catch (error) {
      const message = await recoverMutationError(error);
      if (message) setActionError(message);
    } finally {
      busyActionRef.current = false;
      setBusyUserId(null);
    }
  }

  if (!siteId) return <FeedbackState tone="neutral" icon={CircleAlert} title="유저를 관리할 현장을 선택하세요." />;

  return <section className="settings-screen site-users-screen" aria-label="유저 관리">
    <PageHeader
      title="유저 관리"
      description="현장을 조회하거나 조명을 제어할 사용자를 관리합니다."
      actions={<Button ref={addButtonRef} type="button" variant="primary" disabled={atLimit} onClick={(event) => openDialog({ type: "create" }, event.currentTarget)}><Plus size={16} aria-hidden="true" /> 사용자 추가</Button>}
    />

    {notice ? <FeedbackState tone="success" icon={CircleCheck} title={notice} /> : null}
    {actionError ? <FeedbackState tone="danger" icon={CircleAlert} title={actionError} /> : null}
    {refreshError ? <FeedbackState tone="danger" icon={CircleAlert} title={refreshError} action={<Button type="button" onClick={() => { setRefreshError(""); void usersQuery.refetch(); }}>목록 다시 시도</Button>} /> : null}
    {atLimit ? <FeedbackState tone="warning" icon={CircleAlert} title="현장 사용자는 최대 100명까지 등록할 수 있습니다." /> : null}

    {usersQuery.isLoading && !data ? <FeedbackState tone="neutral" icon={Clock3} title="사용자 목록을 불러오는 중입니다." /> : null}
    {usersQuery.error && !data ? <FeedbackState tone="danger" icon={CircleAlert} title="사용자 목록을 불러오지 못했습니다." action={<Button type="button" onClick={() => void usersQuery.refetch()}>목록 다시 시도</Button>} /> : null}
    {usersQuery.error && data ? <FeedbackState tone="danger" icon={CircleAlert} title="최신 사용자 목록을 불러오지 못했습니다. 기존 목록을 표시합니다." action={<Button type="button" onClick={() => void usersQuery.refetch()}>목록 다시 시도</Button>} /> : null}

    {data ? <>
      <div className="site-users-toolbar">
        <label className="site-users-search"><Search size={16} aria-hidden="true" /><span className="sr-only">사용자 검색</span><input aria-label="사용자 검색" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="이름 또는 로그인 아이디 검색" /></label>
        <label><span className="sr-only">권한 필터</span><select aria-label="권한 필터" value={accessFilter} onChange={(event) => setAccessFilter(event.target.value as AccessFilter)}><option value="all">모든 권한</option><option value="read">조회</option><option value="control">제어</option></select></label>
        <label><span className="sr-only">상태 필터</span><select aria-label="상태 필터" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as StatusFilter)}><option value="all">모든 상태</option><option value="active">활성</option><option value="disabled">비활성</option></select></label>
        <strong className="site-users-count">{data.count} / {data.limit}명</strong>
      </div>

      {data.users.length === 0 ? <FeedbackState tone="neutral" icon={UserCheck} title="등록된 사용자가 없습니다." description="사용자 추가 버튼으로 현장 사용자를 등록하세요." /> : filteredUsers.length === 0 ? <FeedbackState tone="neutral" icon={Search} title="검색 조건에 맞는 사용자가 없습니다." /> : (
        <Card className="site-users-table-wrap" tabIndex={0} aria-label="현장 사용자 목록 표">
          <table className="site-users-table" aria-label="현장 사용자 목록">
            <thead><tr><th scope="col">이름</th><th scope="col">로그인 아이디</th><th scope="col">권한</th><th scope="col">상태</th><th scope="col">최근 로그인</th><th scope="col">관리</th></tr></thead>
            <tbody>{filteredUsers.map((user) => <tr key={user.id}>
              <td>{user.name}</td><td>{user.loginId}</td>
              <td><StatusBadge tone={user.accessLevel === "control" ? "info" : "neutral"} icon={user.accessLevel === "control" ? CircleCheck : UserCheck}>{user.accessLevel === "control" ? "제어" : "조회"}</StatusBadge></td>
              <td><StatusBadge tone={user.status === "active" ? "success" : "danger"} icon={user.status === "active" ? CircleCheck : CircleAlert}>{user.status === "active" ? "활성" : "비활성"}</StatusBadge></td>
              <td>{formatLastLogin(user.lastLoginAt)}</td>
              <td><div className="site-users-actions">
                <IconAction label={`${user.name} 수정`} title="사용자 수정" icon={Pencil} onClick={(event) => openDialog({ type: "edit", user }, event.currentTarget)} />
                <IconAction label={`${user.name} 비밀번호 초기화`} title="비밀번호 초기화" icon={KeyRound} onClick={(event) => openDialog({ type: "reset", user }, event.currentTarget)} />
                <IconAction label={`${user.name} ${user.status === "active" ? "비활성화" : "활성화"}`} title={user.status === "active" ? "비활성화" : "활성화"} icon={user.status === "active" ? UserX : UserCheck} disabled={busyUserId !== null} onClick={() => void toggleStatus(user)} />
                <IconAction label={`${user.name} 영구 삭제`} title="영구 삭제" icon={Trash2} danger onClick={(event) => openDialog({ type: "delete", user }, event.currentTarget)} />
              </div></td>
            </tr>)}</tbody>
          </table>
        </Card>
      )}
      <p className="site-users-note">비활성 사용자도 100명 제한에 포함됩니다. 삭제된 사용자는 인원에서 제외됩니다.</p>
    </> : null}

    {dialog?.type === "create" ? <SiteUserFormDialog siteId={siteId} returnFocusElement={returnFocusElement ?? addButtonRef.current} fallbackFocusElement={addButtonRef.current} onClose={() => setDialog(null)} onCompleted={refreshWithNotice} onLimitReached={() => setServerLimitReached(true)} onMutationError={recoverMutationError} /> : null}
    {dialog?.type === "edit" ? <SiteUserFormDialog siteId={siteId} user={dialog.user} returnFocusElement={returnFocusElement ?? addButtonRef.current} fallbackFocusElement={addButtonRef.current} onClose={() => setDialog(null)} onCompleted={refreshWithNotice} onMutationError={recoverMutationError} /> : null}
    {dialog?.type === "reset" ? <ResetSiteUserPasswordDialog siteId={siteId} user={dialog.user} returnFocusElement={returnFocusElement ?? addButtonRef.current} fallbackFocusElement={addButtonRef.current} onClose={() => setDialog(null)} onCompleted={refreshWithNotice} onMutationError={recoverMutationError} /> : null}
    {dialog?.type === "delete" ? <DeleteSiteUserDialog siteId={siteId} user={dialog.user} returnFocusElement={returnFocusElement ?? addButtonRef.current} fallbackFocusElement={addButtonRef.current} onClose={() => setDialog(null)} onCompleted={(message) => completeDeletion(dialog.user.id, message)} onMutationError={recoverMutationError} /> : null}
  </section>;
}

function IconAction({ label, title, icon: Icon, danger = false, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { label: string; title: string; icon: typeof Pencil; danger?: boolean }) {
  return <Button type="button" variant={danger ? "danger" : "ghost"} className="site-users-icon-action" aria-label={label} title={title} {...props}><Icon size={16} aria-hidden="true" /></Button>;
}

function formatLastLogin(value: string | null) {
  if (!value) return "로그인 기록 없음";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return new Intl.DateTimeFormat("ko-KR", { dateStyle: "medium", timeStyle: "short" }).format(date);
}
