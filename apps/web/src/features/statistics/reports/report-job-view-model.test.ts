import type { EnergyReportJob } from "@led-control/shared/energy-p2-contracts";
import { describe, expect, it } from "vitest";
import { reportJobViewModel } from "./report-job-view-model";

describe("reportJobViewModel", () => {
  it("maps a completed report into compact display labels and a download action", () => {
    const view = reportJobViewModel(reportJob("completed"));

    expect(view).toMatchObject({
      id: "30000000-0000-4000-8000-000000000043",
      targetLabel: "서울 물류센터",
      scopeLabel: "현장",
      rangeLabel: "2026-09-01 ~ 2026-09-10",
      status: { label: "완료", tone: "success" },
      action: "download"
    });
    expect(view.requestedAt.iso).toBe("2026-09-10T00:00:00.000Z");
    expect(view.expiresAt?.iso).toBe("2026-09-17T00:00:04.000Z");
    expect(view.failure).toBeUndefined();
  });

  it("formats request and expiry instants in the selected site's timezone", () => {
    const view = reportJobViewModel(reportJob("completed"), "America/Los_Angeles");

    expect(view.requestedAt.iso).toBe("2026-09-10T00:00:00.000Z");
    expect(view.requestedAt.label).toContain("2026. 9. 9.");
    expect(view.expiresAt?.iso).toBe("2026-09-17T00:00:04.000Z");
    expect(view.expiresAt?.label).toContain("2026. 9. 16.");
  });

  it("exposes only the public failure message and recovery action", () => {
    const view = reportJobViewModel(reportJob("failed"));

    expect(view.status).toEqual({ label: "생성 실패", tone: "danger" });
    expect(view.action).toBe("regenerate");
    expect(view.failure).toEqual({
      message: "보고서를 생성하지 못했습니다.",
      action: "잠시 후 다시 생성해 주세요."
    });
    expect(view.expiresAt).toBeUndefined();
    expect(JSON.stringify(view)).not.toContain("REPORT_GENERATION_FAILED");
  });
});

function reportJob(status: "completed" | "failed") {
  const completed = status === "completed";
  return {
    reportId: "30000000-0000-4000-8000-000000000043",
    siteId: "30000000-0000-4000-8000-000000000001",
    request: {
      from: "2026-09-01",
      to: "2026-09-10",
      scope: "site" as const,
      identityId: "30000000-0000-4000-8000-000000000001",
      format: "pdf" as const
    },
    status,
    progressPercent: completed ? 100 : 0,
    createdAt: "2026-09-10T00:00:00.000Z",
    startedAt: "2026-09-10T00:00:02.000Z",
    completedAt: completed ? "2026-09-10T00:00:04.000Z" : null,
    expiresAt: completed ? "2026-09-17T00:00:04.000Z" : null,
    failureCode: completed ? null : "REPORT_GENERATION_FAILED",
    target: { scope: "site" as const, identityId: "30000000-0000-4000-8000-000000000001", label: "서울 물류센터" },
    requestedAt: "2026-09-10T00:00:00.000Z",
    failure: completed ? null : {
      code: "generation_failed" as const,
      message: "보고서를 생성하지 못했습니다.",
      action: "잠시 후 다시 생성해 주세요."
    }
  } as EnergyReportJob;
}
