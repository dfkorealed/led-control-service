import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { FeaturesPage } from "./FeaturesPage";

afterEach(cleanup);

describe("public features page", () => {
  it("explains each capability with a three-step flow, an outcome, and a visual example", () => {
    render(<FeaturesPage />);
    for (const [id, headline, result] of [
      ["monitoring", /현장을 열면 조명 위치부터/, /대상을 찾는 수고/],
      ["control", /필요한 조명만, 필요한 만큼/, /운영 기준/],
      ["statistics", /그래프에서 흐름을 읽고 보고서로/, /공유할 자료/],
      ["map-editor", /도면과 조명을 현장에 맞춰/, /배치를 검토/]
    ] as const) {
      const section = document.getElementById(`feature-${id}`);
      expect(section).not.toBeNull();
      if (!section) continue;
      const detail = within(section);
      expect(detail.getByRole("heading", { name: headline })).toBeVisible();
      expect(detail.getAllByRole("listitem")).toHaveLength(3);
      expect(detail.getByText(result)).toBeVisible();
      expect(section.querySelector(".feature-detail__preview")).not.toBeNull();
    }
    const statistics = within(document.getElementById("feature-statistics")!);
    expect(statistics.getByText(/상태 기반 추정 전력/)).toBeVisible();
    expect(statistics.getByText(/PDF 보고서/)).toBeVisible();
    expect(statistics.queryByText(/XLSX|Excel/)).not.toBeInTheDocument();
    expect(screen.getByText(/실제 현장 데이터나 조명 제어 결과가 아닙니다/)).toBeVisible();
  });
});
