import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LandingPage } from "./LandingPage";
import { FeaturesPage } from "./FeaturesPage";
import { PricingPage } from "./PricingPage";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("public contact without backend", () => {
  it.each([LandingPage, FeaturesPage, PricingPage])("every consultation action offers contact links without a form (%#)", async Page => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    const { container } = render(<Page />);
    const triggers = screen.getAllByRole("button", { name: /도입 상담/ });
    for (const trigger of triggers) {
      fireEvent.click(trigger);
      const surface = await screen.findByRole("dialog", { name: "도입 상담" });
      const dialog = within(surface);
      const card = dialog.getByLabelText("이메일 도입 상담");
      expect(surface.querySelector("[data-dialog-header]")).toBeNull();
      expect(surface).toHaveClass("p-0!", "border-0!", "bg-transparent!");
      expect(card).toContainElement(dialog.getByRole("button", { name: "상담 팝업 닫기" }));
      expect(dialog.getAllByRole("heading")).toHaveLength(1);
      expect(dialog.queryByRole("link", { name: /032-528-2953/ })).not.toBeInTheDocument();
      expect(dialog.getByRole("link", { name: "이메일로 상담하기" })).toHaveAttribute("href", "mailto:kymkjh2002@dfkorealed.com");
      expect(dialog.getByRole("link", { name: /kymkjh2002@dfkorealed.com/ })).toHaveAttribute("href", "mailto:kymkjh2002@dfkorealed.com");
      expect(dialog.queryByRole("textbox")).not.toBeInTheDocument();
      expect(dialog.queryByRole("checkbox")).not.toBeInTheDocument();
      expect(document.querySelector("form")).toBeNull();
      fireEvent.click(dialog.getByRole("button", { name: "상담 팝업 닫기" }));
    }
    expect(container.textContent).not.toMatch(/접수번호|개인정보 수집/);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("keeps the selected plan as context for direct contact", async () => {
    render(<PricingPage />);
    fireEvent.click(screen.getByRole("button", { name: "Basic 도입 상담" }));
    const card = await screen.findByLabelText("이메일 도입 상담");
    expect(within(card).getByText(/선택한 요금제:/)).toHaveTextContent("선택한 요금제: Basic");
    expect(screen.queryByRole("button", { name: "상담 문의 보내기" })).not.toBeInTheDocument();
  });
});
