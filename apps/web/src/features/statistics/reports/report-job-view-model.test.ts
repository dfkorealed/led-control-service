import type { EnergyReportJob } from "@led-control/shared/energy-p2-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { reportJobViewModel } from "./report-job-view-model";

describe("reportJobViewModel", () => {
  afterEach(() => vi.unstubAllEnvs());
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
    expect(view.requestedAt.label).toBe("2026-09-09 17:00:00");
    expect(view.expiresAt?.iso).toBe("2026-09-17T00:00:04.000Z");
    expect(view.expiresAt?.label).toBe("2026-09-16 17:00:04");
  });

  it("shows site midnight with seconds while retaining the original precision", () => {
    const job = { ...reportJob("completed"), requestedAt: "2026-10-01T15:00:00.987654Z" };
    const view = reportJobViewModel(job, "Asia/Seoul");
    expect(view.requestedAt).toEqual({ iso: job.requestedAt, label: "2026-10-02 00:00:00" });
    expect(view.rangeLabel).toBe("2026-09-01 ~ 2026-09-10");
  });

  it("keeps invalid instant or timezone display unavailable rather than inventing a time", () => {
    expect(reportJobViewModel({ ...reportJob("completed"), requestedAt: "2026-02-30T00:00:00Z" }, "UTC").requestedAt.label).toBe("—");
    expect(reportJobViewModel(reportJob("completed"), "invalid/zone").requestedAt.label).toBe("—");
  });

  it("retains the device timezone branch and the site's DST transition", () => {
    vi.stubEnv("TZ", "America/Los_Angeles");
    expect(reportJobViewModel(reportJob("completed")).requestedAt.label).toBe("2026-09-09 17:00:00");
    const before = { ...reportJob("completed"), requestedAt: "2026-03-08T06:59:59Z" };
    const after = { ...before, requestedAt: "2026-03-08T07:00:00Z" };
    expect(reportJobViewModel(before, "America/New_York").requestedAt.label).toBe("2026-03-08 01:59:59");
    expect(reportJobViewModel(after, "America/New_York").requestedAt.label).toBe("2026-03-08 03:00:00");
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
