import type { EnergyReportJob, EnergyReportRequest } from "@led-control/shared/energy-p2-contracts";
import { FileText } from "lucide-react";
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { createEnergyReport, downloadEnergyCsv, downloadEnergyReport, energyReportRequestErrorMessage, useEnergyReports, useEnergyReportTargets } from "../../../api/energy";
import { Button, PageHeader, Text } from "../../../components/ui";
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
    } catch (error) {
      setDownloadError(energyReportRequestErrorMessage(error, "download"));
    }
  }
  async function regenerate(job: EnergyReportJob) {
    if (retryingReportId || !siteId) return;
    setRetryError("");
    setRetryingReportId(job.reportId);
    try {
      await create(job.request);
    } catch (error) {
      setRetryError(energyReportRequestErrorMessage(error, "regenerate"));
    } finally {
      setRetryingReportId(undefined);
    }
  }

  return <section className="grid min-w-0 gap-6" aria-label="에너지 보고서">
    <PageHeader title="보고서" description="현장 에너지 사용량을 기간과 범위에 맞춰 내보냅니다." status={undefined}
      actions={<Button variant="primary" onClick={() => setIsDialogOpen(true)}><FileText size={16} />보고서 만들기</Button>} />
    <Text variant="body-sm" tone="muted">보고서와 CSV 비용은 당시 적용 단가의 저장 비용입니다.</Text>
    <ReportJobList reports={reports.data?.reports} isLoading={reports.isLoading || !siteId} isError={reports.isError}
      retryingReportId={retryingReportId} onRetry={() => void reports.refetch()} onRegenerate={(job) => void regenerate(job)} onDownload={(job) => void download(job)} />
    {downloadError ? <Text tone="danger" role="alert">{downloadError}</Text> : null}
    {retryError ? <Text tone="danger" role="alert">{retryError}</Text> : null}
    {isDialogOpen && siteId ? <ReportCreateDialog key={siteId} siteId={siteId} targetData={targets.data} onClose={() => setIsDialogOpen(false)}
      isTargetsLoading={targets.isLoading} isTargetsError={targets.isError} onCreate={create} onExportCsv={(request) => downloadEnergyCsv(siteId, request)} /> : null}
  </section>;
}
