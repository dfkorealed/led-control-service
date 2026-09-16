import type { ReactNode } from "react";
import { CheckCircle2, CircleAlert, Clock3, FileWarning, LoaderCircle, type LucideIcon } from "lucide-react";
import { Card, Heading, StatusBadge, type StatusTone } from "../../../components/ui";
import type { ReportJobRenderItem } from "./report-job-view-model";

export function ReportJobCards({
  items,
  renderAction,
  renderFailure
}: {
  items: ReportJobRenderItem[];
  renderAction: (item: ReportJobRenderItem) => ReactNode;
  renderFailure: (item: ReportJobRenderItem, surface: "table" | "card") => ReactNode;
}) {
  return (
    <ul aria-label="모바일 보고서 생성 이력" className="m-0 grid min-w-0 list-none gap-2 p-0 tablet:hidden desktop:hidden">
      {items.map((item) => (
        <li key={item.view.id} aria-label={`${item.view.targetLabel} 보고서`}>
          <Card className="grid min-w-0 gap-3 p-3">
            <div className="flex min-w-0 items-start justify-between gap-2">
              <Heading as="h3" variant="body" weight="bold" className="min-w-0 wrap-anywhere">{item.view.targetLabel}</Heading>
              <StatusBadge tone={item.view.status.tone} icon={reportStatusIcon(item.view.status.tone)}>{item.view.status.label}</StatusBadge>
            </div>
            <dl className="m-0 grid min-w-0 grid-cols-2 gap-x-3 gap-y-2 text-caption" role="group" aria-label="보고서 메타데이터">
              <Metadata label="기간" value={item.view.rangeLabel} />
              <Metadata label="범위" value={item.view.scopeLabel} />
              <Metadata label="형식" value={item.view.formatLabel} />
              <Metadata label="요청 시각" value={<ReportTime instant={item.view.requestedAt} />} />
              {item.view.expiresAt ? <Metadata label="파일 만료 시각" value={<ReportTime instant={item.view.expiresAt} />} /> : null}
            </dl>
            {renderFailure(item, "card")}
            {item.view.action !== "none" ? <div className="flex min-w-0" role="group" aria-label="보고서 작업">{renderAction(item)}</div> : null}
          </Card>
        </li>
      ))}
    </ul>
  );
}

export function reportStatusIcon(tone: StatusTone): LucideIcon {
  if (tone === "success") return CheckCircle2;
  if (tone === "danger") return CircleAlert;
  if (tone === "warning") return FileWarning;
  if (tone === "info") return LoaderCircle;
  return Clock3;
}

function Metadata({ label, value }: { label: string; value: ReactNode }) {
  return <div className="min-w-0"><dt className="font-bold text-content-muted">{label}</dt><dd className="m-0 wrap-anywhere text-content-primary">{value}</dd></div>;
}

function ReportTime({ instant }: { instant: ReportJobRenderItem["view"]["requestedAt"] }) {
  return <time dateTime={instant.iso} title={instant.iso} className="tabular-nums">{instant.label}</time>;
}
