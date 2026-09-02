import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CircleAlert, CircleCheck, Clock3, KeyRound, Pencil, Plus, UserPlus, UserRoundX, UsersRound } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import {
  assignSiteAdmin,
  createSiteAdmin,
  disableSiteAdmin,
  listSiteAdmins,
  operatorSiteAdminsQueryKey,
  resetSiteAdminPassword,
  updateSiteAdmin,
  type SiteAdminSummary
} from "../../../api/operator-site-admins";
import { Button } from "../../../components/ui/Button";
import { Card } from "../../../components/ui/Card";
import { FeedbackState } from "../../../components/ui/FeedbackState";
import { MetricCard } from "../../../components/ui/MetricCard";
import { PageHeader } from "../../../components/ui/PageHeader";
import { StatusBadge } from "../../../components/ui/StatusBadge";
import { DisableSiteAdminDialog } from "./DisableSiteAdminDialog";
import { ResetAdminPasswordDialog } from "./ResetAdminPasswordDialog";
import { SiteAdminFormDialog } from "./SiteAdminFormDialog";

type DialogState =
  | { type: "create" }
  | { type: "assign"; site: SiteAdminSummary }
  | { type: "edit"; admin: NonNullable<SiteAdminSummary["admin"]> }
  | { type: "reset"; admin: NonNullable<SiteAdminSummary["admin"]> }
  | { type: "disable"; admin: NonNullable<SiteAdminSummary["admin"]> };

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

  return (
    <section className="operator-admin-management" aria-label="현장 관리자 계정">
      <PageHeader
        title="현장 관리자 계정"
        headingLevel={1}
        description="서비스 운영 · 현장별 설치 상태와 관리자 계정을 관리합니다."
        actions={<Button ref={createCommandRef} type="button" variant="primary" onClick={(event) => openDialog({ type: "create" }, event.currentTarget)}>
          <Plus size={16} aria-hidden="true" /> 현장 및 관리자 생성
        </Button>}
      />

      {notice ? <FeedbackState tone="success" icon={CircleCheck} title={notice} /> : null}

      <div className="operator-summary-grid">
        {summaries.map(({ label, value, tone, icon }) => <MetricCard key={label} label={label} value={value} tone={tone} icon={icon} />)}
      </div>

      {siteAdmins.isLoading ? <FeedbackState tone="neutral" icon={Clock3} title="현장 관리자 목록을 불러오는 중입니다." /> : null}
      {siteAdmins.error ? (
        <FeedbackState tone="danger" icon={CircleAlert} title="현장 관리자 목록을 불러오지 못했습니다." action={<Button type="button" onClick={() => void siteAdmins.refetch()}>다시 시도</Button>} />
      ) : null}
      {!siteAdmins.isLoading && !siteAdmins.error ? (
        <Card className="operator-table-wrap" tabIndex={0} aria-label="현장 관리자 계정 표">
          <table className="operator-admin-table">
            <thead>
              <tr>
                {['고객사', '현장', '설치 상태', '관리자 이름', '로그인 아이디', '계정 상태', '최종 변경', '작업'].map((column) => <th key={column} scope="col">{column}</th>)}
              </tr>
            </thead>
            <tbody>
              {siteAdmins.data?.map((site) => <SiteAdminRow key={site.siteId} site={site} onOpen={openDialog} />)}
              {siteAdmins.data?.length === 0 ? <tr><td colSpan={8} className="operator-table-empty">관리할 현장이 없습니다.</td></tr> : null}
            </tbody>
          </table>
        </Card>
      ) : null}

      {dialog?.type === "create" ? <SiteAdminFormDialog mode="create" returnFocusElement={returnFocusElement} fallbackFocusElement={createCommandRef.current} onCreate={createSiteAdmin} onAssign={assignSiteAdmin} onUpdate={updateSiteAdmin} onSuccess={complete} onClose={closeDialog} /> : null}
      {dialog?.type === "assign" ? <SiteAdminFormDialog mode="assign" site={dialog.site} returnFocusElement={returnFocusElement} fallbackFocusElement={createCommandRef.current} onCreate={createSiteAdmin} onAssign={assignSiteAdmin} onUpdate={updateSiteAdmin} onSuccess={complete} onClose={closeDialog} /> : null}
      {dialog?.type === "edit" ? <SiteAdminFormDialog mode="edit" admin={dialog.admin} returnFocusElement={returnFocusElement} fallbackFocusElement={createCommandRef.current} onCreate={createSiteAdmin} onAssign={assignSiteAdmin} onUpdate={updateSiteAdmin} onSuccess={complete} onClose={closeDialog} /> : null}
      {dialog?.type === "reset" ? <ResetAdminPasswordDialog admin={dialog.admin} returnFocusElement={returnFocusElement} fallbackFocusElement={createCommandRef.current} onReset={resetSiteAdminPassword} onSuccess={() => complete("관리자 비밀번호를 재설정했습니다.")} onClose={closeDialog} /> : null}
      {dialog?.type === "disable" ? <DisableSiteAdminDialog admin={dialog.admin} returnFocusElement={returnFocusElement} fallbackFocusElement={createCommandRef.current} onDisable={disableSiteAdmin} onSuccess={() => complete("관리자 계정을 비활성화했습니다.")} onClose={closeDialog} /> : null}
    </section>
  );
}

function SiteAdminRow({ site, onOpen }: { site: SiteAdminSummary; onOpen: (dialog: DialogState, trigger: HTMLElement) => void }) {
  const admin = site.admin;
  return (
    <tr>
      <td>{site.customerName}</td>
      <td>{site.siteName}</td>
      <td><StatusBadge tone={site.installationStatus === "installed" ? "success" : "warning"} icon={site.installationStatus === "installed" ? CircleCheck : Clock3}>{site.installationStatus === "installed" ? "설치 완료" : "설치 대기"}</StatusBadge></td>
      <td>{admin?.name ?? "관리자 미지정"}</td>
      <td>{admin?.loginId ?? "-"}</td>
      <td>{admin ? <StatusBadge tone={admin.status === "active" ? "success" : "danger"} icon={admin.status === "active" ? CircleCheck : CircleAlert}>{admin.status === "active" ? "활성" : "비활성"}</StatusBadge> : "-"}</td>
      <td>{admin ? formatUpdatedAt(admin.updatedAt) : "-"}</td>
      <td>
        {admin ? (
          <div className="operator-row-actions">
            <Button type="button" aria-label={`${admin.name} 수정`} onClick={(event) => onOpen({ type: "edit", admin }, event.currentTarget)}><Pencil size={15} aria-hidden="true" /> 수정</Button>
            <Button type="button" aria-label={`${admin.name} 비밀번호 재설정`} onClick={(event) => onOpen({ type: "reset", admin }, event.currentTarget)}><KeyRound size={15} aria-hidden="true" /> 비밀번호 재설정</Button>
            <Button variant="danger" type="button" aria-label={`${admin.name} 비활성화`} onClick={(event) => onOpen({ type: "disable", admin }, event.currentTarget)}><UserRoundX size={15} aria-hidden="true" /> 비활성화</Button>
          </div>
        ) : <Button type="button" onClick={(event) => onOpen({ type: "assign", site }, event.currentTarget)} aria-label={`${site.siteName} 관리자 지정`}><UserPlus size={15} aria-hidden="true" /> 관리자 지정</Button>}
      </td>
    </tr>
  );
}

function formatUpdatedAt(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return new Intl.DateTimeFormat("ko-KR", { dateStyle: "medium", timeStyle: "short" }).format(date);
}
