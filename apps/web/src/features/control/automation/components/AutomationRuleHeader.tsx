import type { ReactNode } from "react";
import { Button } from "../../../../components/ui";

export function AutomationRuleHeader({ view, onViewChange, addAction }: {
  view?: "list" | "calendar";
  onViewChange?: (view: "list" | "calendar") => void;
  addAction: ReactNode;
}) {
  return <div role="group" aria-label="자동화 작업" className="flex min-w-0 shrink-0 flex-wrap items-center justify-between gap-2">
    <div className="flex min-w-0 items-center gap-2">
      {view && onViewChange ? <div role="group" aria-label="스케줄 보기" className="flex gap-2">
        <Button type="button" variant={view === "list" ? "secondary" : "ghost"} aria-pressed={view === "list"} onClick={() => onViewChange("list")}>목록</Button>
        <Button type="button" variant={view === "calendar" ? "secondary" : "ghost"} aria-pressed={view === "calendar"} onClick={() => onViewChange("calendar")}>달력</Button>
      </div> : null}
    </div>
    <div className="ml-auto flex shrink-0 items-center gap-2" data-automation-add-action="">{addAction}</div>
  </div>;
}
