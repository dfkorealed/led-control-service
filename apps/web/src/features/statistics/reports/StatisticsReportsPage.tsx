import type { EnergyReportJob, EnergyReportRequest } from "@led-control/shared/energy-p2-contracts";
import { FileText } from "lucide-react";
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { createEnergyReport, downloadEnergyCsv, downloadEnergyReport, useEnergyReports, useEnergyReportTargets } from "../../../api/energy";
import { Button, PageHeader } from "../../../components/ui";
import { useOutletContext } from "react-router-dom";
import type { StatisticsOutletContext } from "../StatisticsShell";
import { ReportCreateDialog } from "./ReportCreateDialog";
import { ReportJobList } from "./ReportJobList";

export function StatisticsReportsPage() {
  const { siteId } = useOutletContext<StatisticsOutletContext>();
  const targets = useEnergyReportTargets(siteId);
  const reports = useEnergyReports(siteId);
  const queryClient = useQueryClient();
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [downloadError, setDownloadError] = useState("");
  const [retryError, setRetryError] = useState("");
  const [retryingReportId, setRetryingReportId] = useState<string>();

  async function create(request: EnergyReportRequest) {
    if (!siteId) return;
    const job = await createEnergyReport(siteId, request);
    queryClient.setQueryData(["energy-reports", siteId], (current: { reports?: EnergyReportJob[] } | undefined) => ({
      reports: [job, ...(current?.reports ?? [])].slice(0, 50)
    }));
    await reports.refetch();
  }
  async function download(job: EnergyReportJob) {
    if (!siteId) return;
    setDownloadError("");
    try {
      const response = await downloadEnergyReport(siteId, job.reportId);
      const anchor = document.createElement("a");
      anchor.href = response.downloadUrl;
      anchor.download = "";
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
    } catch {
      setDownloadError("다운로드를 시작하지 못했습니다. 연결을 확인한 뒤 다시 시도하세요.");
    }
  }
  async function regenerate(job: EnergyReportJob) {
    if (retryingReportId || !siteId) return;
    setRetryError("");
    setRetryingReportId(job.reportId);
    try {
      await create(job.request);
    } catch {
      setRetryError("다시 생성을 요청하지 못했습니다. 연결을 확인한 뒤 다시 시도하세요.");
    } finally {
      setRetryingReportId(undefined);
    }
  }

  return <section className="statistics-screen statistics-reports-screen">
    <PageHeader title="보고서" description="현장 에너지 사용량을 기간과 범위에 맞춰 내보냅니다." status={undefined}
      actions={<Button variant="primary" onClick={() => setIsDialogOpen(true)}><FileText size={16} />보고서 만들기</Button>} />
    <ReportJobList reports={reports.data?.reports} isLoading={reports.isLoading || !siteId} isError={reports.isError}
      retryingReportId={retryingReportId} onRetry={() => void reports.refetch()} onRegenerate={(job) => void regenerate(job)} onDownload={(job) => void download(job)} />
    {downloadError ? <p className="danger-text" role="alert">{downloadError}</p> : null}
    {retryError ? <p className="danger-text" role="alert">{retryError}</p> : null}
    {isDialogOpen && siteId ? <ReportCreateDialog key={siteId} siteId={siteId} targetData={targets.data} onClose={() => setIsDialogOpen(false)}
      isTargetsLoading={targets.isLoading} isTargetsError={targets.isError} onCreate={create} onExportCsv={(request) => downloadEnergyCsv(siteId, request)} /> : null}
  </section>;
}
