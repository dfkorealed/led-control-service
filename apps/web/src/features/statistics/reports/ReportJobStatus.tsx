import { CheckCircle2, CircleAlert, Clock3, FileWarning, LoaderCircle, type LucideIcon } from "lucide-react";
import { StatusBadge, Text, cn, type StatusTone } from "../../../components/ui";
import type { ReportJobRenderItem } from "./report-job-view-model";

export function ReportJobStatus({ item, className }: { item: ReportJobRenderItem; className?: string }) {
  const progress = item.view.status.progress;
  return <div className={cn("grid min-w-0 gap-2", className)}>
    <StatusBadge tone={item.view.status.tone} icon={reportStatusIcon(item.view.status.tone)}>{item.view.status.label}</StatusBadge>
    {progress === undefined ? null : <div className="grid min-w-28 gap-1">
      <progress
        aria-label={`${item.view.targetLabel} 보고서 생성 진행률`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={progress}
        className="h-2 w-full"
        max={100}
        value={progress}
      />
      <Text as="span" variant="caption" tone="secondary" className="tabular-nums">{progress}%</Text>
    </div>}
  </div>;
}

function reportStatusIcon(tone: StatusTone): LucideIcon {
  if (tone === "success") return CheckCircle2;
  if (tone === "danger") return CircleAlert;
  if (tone === "warning") return FileWarning;
  if (tone === "info") return LoaderCircle;
  return Clock3;
}
