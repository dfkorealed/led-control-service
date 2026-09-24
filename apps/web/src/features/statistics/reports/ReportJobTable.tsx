import type { ReactNode } from "react";
import { DataTableShell, Text } from "../../../components/ui";
import type { ReportJobRenderItem } from "./report-job-view-model";
import { ReportJobStatus } from "./ReportJobStatus";

export function ReportJobTable({
  items,
  isBusy,
  renderAction,
  renderFailure
}: {
  items: ReportJobRenderItem[];
  isBusy: boolean;
  renderAction: (item: ReportJobRenderItem) => ReactNode;
  renderFailure: (item: ReportJobRenderItem, surface: "table" | "card") => ReactNode;
}) {
  return (
    <div className="hidden min-w-0 tablet:block desktop:block">
      <DataTableShell caption="보고서 생성 이력" isBusy={isBusy}>
        <thead className="bg-surface-inset text-left text-content-secondary">
          <tr>
            {['대상', '기간', '형식', '상태', '요청 시각', '파일 만료 시각', '작업'].map((label) => (
              <th key={label} scope="col" className="px-3 py-2 font-bold">{label}</th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-border-default">
          {items.map((item) => (
            <tr key={item.view.id}>
              <td className="px-3 py-2 align-top"><Text weight="bold" className="wrap-anywhere">{item.view.targetLabel}</Text></td>
              <td className="px-3 py-2 align-top tabular-nums">{item.view.rangeLabel}</td>
              <td className="px-3 py-2 align-top">{item.view.formatLabel}</td>
              <td className="px-3 py-2 align-top">
                <div className="grid gap-2">
                  <ReportJobStatus item={item} />
                  {renderFailure(item, "table")}
                </div>
              </td>
              <td className="px-3 py-2 align-top"><ReportTime instant={item.view.requestedAt} /></td>
              <td className="px-3 py-2 align-top">{item.view.expiresAt ? <ReportTime instant={item.view.expiresAt} /> : "—"}</td>
              <td className="px-3 py-2 align-top">{renderAction(item)}</td>
            </tr>
          ))}
        </tbody>
      </DataTableShell>
    </div>
  );
}

function ReportTime({ instant }: { instant: ReportJobRenderItem["view"]["requestedAt"] }) {
  return <time dateTime={instant.iso} title={instant.iso} className="whitespace-nowrap tabular-nums">{instant.label}</time>;
}
