import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CircleAlert, CircleCheck, Clock3, KeyRound, Pencil, Plus, Trash2, UserPlus, UsersRound } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import {
  assignSiteAdmin,
  createSiteAdmin,
  deleteSiteAdmin,
  listSiteAdmins,
  operatorSiteAdminsQueryKey,
  resetSiteAdminPassword,
  updateSiteAdmin,
  type SiteAdminSummary
} from "../../../api/operator-site-admins";
import { Button } from "../../../components/ui/Button";
import { DataGrid, type DataGridColumn } from "../../../components/ui/DataGrid";
import { FeedbackState } from "../../../components/ui/FeedbackState";
import { MetricCard } from "../../../components/ui/MetricCard";
import { PageHeader } from "../../../components/ui/PageHeader";
import { StatusBadge } from "../../../components/ui/StatusBadge";
import { LoadingState, formatTimestamp  } from "../../../components/ui";
import { DeleteSiteDialog } from "./DeleteSiteDialog";
import { ResetAdminPasswordDialog } from "./ResetAdminPasswordDialog";
import { SiteAdminFormDialog } from "./SiteAdminFormDialog";

type DialogState =
  | { type: "create" }
  | { type: "assign"; site: SiteAdminSummary }
  | { type: "edit"; admin: NonNullable<SiteAdminSummary["admin"]> }
  | { type: "reset"; admin: NonNullable<SiteAdminSummary["admin"]> }
  | { type: "delete"; site: SiteAdminSummary };

export function SiteAdminManagementView() {
  const queryClient = useQueryClient();
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [returnFocusElement, setReturnFocusElement] = useState<HTMLElement | null>(null);
  const createCommandRef = useRef<HTMLButtonElement>(null);
  const [notice, setNotice] = useState("");
  const siteAdmins = useQuery({ queryKey: operatorSiteAdminsQueryKey, queryFn: listSiteAdmins });
  const summaries = useMemo(() => [
    { label: "운영 현장", value: siteAdmins.data?.length ?? 0, tone: "primary" as const, icon: UsersRound },
    { label: "설치 완료", value: siteAdmins.data?.filter((site) => site.installationStatus === "installed").length ?? 0, tone: "success" as const, icon: CircleCheck },
    { label: "관리자 계정", value: siteAdmins.data?.filter((site) => site.admin).length ?? 0, tone: "neutral" as const, icon: UserPlus },
    { label: "확인 필요", value: siteAdmins.data?.filter((site) => site.installationStatus !== "installed" || !site.admin || site.admin.status !== "active").length ?? 0, tone: "warning" as const, icon: CircleAlert }
  ], [siteAdmins.data]);

  function openDialog(next: DialogState, trigger: HTMLElement) {
    setNotice("");
    setReturnFocusElement(trigger);
    setDialog(next);
  }

  function closeDialog() {
    setDialog(null);
  }

  async function complete(message: string) {
    setNotice(message);
    await queryClient.invalidateQueries({ queryKey: operatorSiteAdminsQueryKey });
  }

  const columns: readonly DataGridColumn<SiteAdminSummary>[] = [
    { id: "customer", header: "고객사", minWidth: 140, sortValue: site => site.customerName, renderCell: site => site.customerName },
    { id: "site", header: "현장", minWidth: 160, sortValue: site => site.siteName, renderCell: site => site.siteName },
    { id: "installation", header: "설치 상태", minWidth: 110, align: "center", sortValue: site => site.installationStatus === "installed" ? "설치 완료" : "설치 대기", renderCell: site => <StatusBadge tone={site.installationStatus === "installed" ? "success" : "warning"} icon={site.installationStatus === "installed" ? CircleCheck : Clock3}>{site.installationStatus === "installed" ? "설치 완료" : "설치 대기"}</StatusBadge> },
    { id: "name", header: "관리자 이름", minWidth: 130, sortValue: site => site.admin?.name, renderCell: site => site.admin?.name ?? "관리자 미지정" },
    { id: "login", header: "로그인 아이디", minWidth: 150, sortValue: site => site.admin?.loginId, renderCell: site => site.admin?.loginId ?? "-" },
    { id: "status", header: "계정 상태", minWidth: 110, align: "center", sortValue: site => site.admin ? site.admin.status === "active" ? "활성" : "비활성" : null, renderCell: site => site.admin ? <StatusBadge tone={site.admin.status === "active" ? "success" : "danger"} icon={site.admin.status === "active" ? CircleCheck : CircleAlert}>{site.admin.status === "active" ? "활성" : "비활성"}</StatusBadge> : "-" },
    { id: "updated", header: "최종 변경", minWidth: 180, sortValue: site => site.admin ? new Date(site.admin.updatedAt) : null, renderCell: site => site.admin ? formatTimestamp(site.admin.updatedAt) : "-" },
    { id: "actions", header: "작업", minWidth: 250, align: "center", renderCell: site => <SiteAdminActions site={site} onOpen={openDialog} /> }
  ];

  return (
    <section className="grid gap-5" aria-label="현장 관리자 계정">
      <PageHeader
        data-operator-admin-header
        title="현장 관리자 계정"
        headingLevel={1}
        description="서비스 운영 · 현장별 설치 상태와 관리자 계정을 관리합니다."
        actions={<Button ref={createCommandRef} type="button" variant="primary" onClick={(event) => openDialog({ type: "create" }, event.currentTarget)}>
          <Plus size={16} aria-hidden="true" /> 현장 및 관리자 생성
        </Button>}
      />

      {notice ? <FeedbackState tone="success" icon={CircleCheck} title={notice} /> : null}

      <div data-testid="operator-summary-strip" className="grid grid-cols-2 gap-3 compact:grid-cols-4">
        {summaries.map(({ label, value, tone, icon }) => <MetricCard key={label} label={label} value={value} tone={tone} icon={icon} />)}
      </div>

      {siteAdmins.isLoading ? <LoadingState tone="neutral" title="현장 관리자 목록을 불러오는 중입니다." /> : null}
      {siteAdmins.error ? (
        <FeedbackState tone="danger" icon={CircleAlert} title="현장 관리자 목록을 불러오지 못했습니다." action={<Button type="button" onClick={() => void siteAdmins.refetch()}>다시 시도</Button>} />
      ) : null}
      {!siteAdmins.isLoading && !siteAdmins.error ? <DataGrid caption="현장 관리자 계정 표" rows={siteAdmins.data ?? []} columns={columns}
        getRowKey={site => site.siteId} emptyState="관리할 현장이 없습니다." /> : null}

      {dialog?.type === "create" ? <SiteAdminFormDialog mode="create" returnFocusElement={returnFocusElement} fallbackFocusElement={createCommandRef.current} onCreate={createSiteAdmin} onAssign={assignSiteAdmin} onUpdate={updateSiteAdmin} onSuccess={complete} onClose={closeDialog} /> : null}
      {dialog?.type === "assign" ? <SiteAdminFormDialog mode="assign" site={dialog.site} returnFocusElement={returnFocusElement} fallbackFocusElement={createCommandRef.current} onCreate={createSiteAdmin} onAssign={assignSiteAdmin} onUpdate={updateSiteAdmin} onSuccess={complete} onClose={closeDialog} /> : null}
      {dialog?.type === "edit" ? <SiteAdminFormDialog mode="edit" admin={dialog.admin} returnFocusElement={returnFocusElement} fallbackFocusElement={createCommandRef.current} onCreate={createSiteAdmin} onAssign={assignSiteAdmin} onUpdate={updateSiteAdmin} onSuccess={complete} onClose={closeDialog} /> : null}
      {dialog?.type === "reset" ? <ResetAdminPasswordDialog admin={dialog.admin} returnFocusElement={returnFocusElement} fallbackFocusElement={createCommandRef.current} onReset={resetSiteAdminPassword} onSuccess={() => complete("관리자 비밀번호를 재설정했습니다.")} onClose={closeDialog} /> : null}
      {dialog?.type === "delete" ? <DeleteSiteDialog site={dialog.site} returnFocusElement={returnFocusElement} fallbackFocusElement={createCommandRef.current} onDelete={deleteSiteAdmin} onSuccess={() => complete("현장과 관련 데이터를 영구 삭제했습니다.")} onClose={closeDialog} /> : null}
    </section>
  );
}

function SiteAdminActions({ site, onOpen }: {
  site: SiteAdminSummary;
  onOpen: (dialog: DialogState, trigger: HTMLElement) => void;
}) {
  const admin = site.admin;
  if (!admin) {
    return <Button className="max-compact:min-h-12" size="sm" type="button" onClick={(event) => onOpen({ type: "assign", site }, event.currentTarget)} aria-label={`${site.siteName} 관리자 지정`}><UserPlus size={15} aria-hidden="true" /> 관리자 지정</Button>;
  }
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Button className="max-compact:min-h-12" size="sm" type="button" aria-label={`${admin.name} 수정`} onClick={(event) => onOpen({ type: "edit", admin }, event.currentTarget)}><Pencil size={15} aria-hidden="true" /> 수정</Button>
      <Button className="max-compact:min-h-12" size="sm" type="button" aria-label={`${admin.name} 비밀번호 재설정`} onClick={(event) => onOpen({ type: "reset", admin }, event.currentTarget)}><KeyRound size={15} aria-hidden="true" /> 비밀번호 재설정</Button>
      <Button className="max-compact:min-h-12" size="sm" variant="danger" type="button" aria-label={`${site.siteName} 현장 전체 삭제`} onClick={(event) => onOpen({ type: "delete", site }, event.currentTarget)}><Trash2 size={15} aria-hidden="true" /> 현장 전체 삭제</Button>
    </div>
  );
}
