import { useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound, Pencil, Plus, Trash2, UserPlus } from "lucide-react";
import { useRef, useState } from "react";
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
    <section className="operator-admin-management" aria-labelledby="operator-site-admins-heading">
      <div className="operator-admin-toolbar">
        <div>
          <span className="eyebrow">서비스 운영</span>
          <h1 id="operator-site-admins-heading">현장 관리자 계정</h1>
        </div>
        <button ref={createCommandRef} className="primary-button" type="button" onClick={(event) => openDialog({ type: "create" }, event.currentTarget)}>
          <Plus size={16} aria-hidden="true" /> 현장 및 관리자 생성
        </button>
      </div>

      {notice ? <p className="success-text operator-announcement" role="status">{notice}</p> : null}

      {siteAdmins.isLoading ? <p className="muted-text" role="status">현장 관리자 목록을 불러오는 중입니다.</p> : null}
      {siteAdmins.error ? (
        <div className="operator-fetch-error">
          <p className="danger-text" role="alert">현장 관리자 목록을 불러오지 못했습니다.</p>
          <button type="button" onClick={() => void siteAdmins.refetch()}>다시 시도</button>
        </div>
      ) : null}
      {!siteAdmins.isLoading && !siteAdmins.error ? (
        <div className="operator-table-wrap" tabIndex={0} aria-label="현장 관리자 계정 표">
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
        </div>
      ) : null}

      {dialog?.type === "create" ? <SiteAdminFormDialog mode="create" returnFocusElement={returnFocusElement} fallbackFocusElement={createCommandRef.current} onCreate={createSiteAdmin} onAssign={assignSiteAdmin} onUpdate={updateSiteAdmin} onSuccess={complete} onClose={closeDialog} /> : null}
      {dialog?.type === "assign" ? <SiteAdminFormDialog mode="assign" site={dialog.site} returnFocusElement={returnFocusElement} fallbackFocusElement={createCommandRef.current} onCreate={createSiteAdmin} onAssign={assignSiteAdmin} onUpdate={updateSiteAdmin} onSuccess={complete} onClose={closeDialog} /> : null}
      {dialog?.type === "edit" ? <SiteAdminFormDialog mode="edit" admin={dialog.admin} returnFocusElement={returnFocusElement} fallbackFocusElement={createCommandRef.current} onCreate={createSiteAdmin} onAssign={assignSiteAdmin} onUpdate={updateSiteAdmin} onSuccess={complete} onClose={closeDialog} /> : null}
      {dialog?.type === "reset" ? <ResetAdminPasswordDialog admin={dialog.admin} returnFocusElement={returnFocusElement} fallbackFocusElement={createCommandRef.current} onReset={resetSiteAdminPassword} onSuccess={() => complete("관리자 비밀번호를 재설정했습니다.")} onClose={closeDialog} /> : null}
      {dialog?.type === "disable" ? <DisableSiteAdminDialog admin={dialog.admin} returnFocusElement={returnFocusElement} fallbackFocusElement={createCommandRef.current} onDisable={disableSiteAdmin} onSuccess={() => complete("관리자 계정을 삭제했습니다.")} onClose={closeDialog} /> : null}
    </section>
  );
}

function SiteAdminRow({ site, onOpen }: { site: SiteAdminSummary; onOpen: (dialog: DialogState, trigger: HTMLElement) => void }) {
  const admin = site.admin;
  return (
    <tr>
      <td>{site.customerName}</td>
      <td>{site.siteName}</td>
      <td><span className={`status-pill ${site.installationStatus === "installed" ? "success" : "offline"}`}>{site.installationStatus === "installed" ? "설치 완료" : "설치 대기"}</span></td>
      <td>{admin?.name ?? "관리자 미지정"}</td>
      <td>{admin?.loginId ?? "-"}</td>
      <td>{admin ? <span className={`status-pill ${admin.status === "active" ? "success" : "danger"}`}>{admin.status === "active" ? "활성" : "비활성"}</span> : "-"}</td>
      <td>{admin ? formatUpdatedAt(admin.updatedAt) : "-"}</td>
      <td>
        {admin ? (
          <div className="operator-row-actions">
            <button type="button" aria-label={`${admin.name} 수정`} onClick={(event) => onOpen({ type: "edit", admin }, event.currentTarget)}><Pencil size={15} aria-hidden="true" /> 수정</button>
            <button type="button" aria-label={`${admin.name} 비밀번호 재설정`} onClick={(event) => onOpen({ type: "reset", admin }, event.currentTarget)}><KeyRound size={15} aria-hidden="true" /> 비밀번호 재설정</button>
            <button className="danger-action" type="button" aria-label={`${admin.name} 삭제`} onClick={(event) => onOpen({ type: "disable", admin }, event.currentTarget)}><Trash2 size={15} aria-hidden="true" /> 삭제</button>
          </div>
        ) : <button type="button" onClick={(event) => onOpen({ type: "assign", site }, event.currentTarget)} aria-label={`${site.siteName} 관리자 지정`}><UserPlus size={15} aria-hidden="true" /> 관리자 지정</button>}
      </td>
    </tr>
  );
}

function formatUpdatedAt(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return new Intl.DateTimeFormat("ko-KR", { dateStyle: "medium", timeStyle: "short" }).format(date);
}
