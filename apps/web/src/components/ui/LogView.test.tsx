import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import * as UI from "./index";

afterEach(cleanup);

describe("LogView", () => {
  it.each([0, 50, 1000])("keeps %s rows in a named keyboard-scroll body separate from filters and pagination", (count) => {
    const LogView = UI.LogView;
    expect(LogView, "public log layout is exported").toBeDefined();
    const Component = LogView;
    render(<div className="h-80 min-h-0"><Component label="운영 로그" className="consumer-log"
      filters={<UI.TextField label="조명 검색" />} pagination={<button>다음 결과</button>} status={<p>{"긴 오류 안내 ".repeat(20)}</p>}>
      {Array.from({ length: count }, (_, index) => <p key={index}>로그 {index + 1}</p>)}
    </Component></div>);
    const root = screen.getByRole("region", { name: "운영 로그" });
    const body = within(root).getByRole("region", { name: "운영 로그 본문" });
    expect(root).toHaveClass("h-full", "min-h-0", "overflow-hidden", "consumer-log");
    expect(body).toHaveAttribute("tabindex", "0");
    expect(body).toHaveClass("min-h-0", "overflow-y-auto");
    expect(within(body).queryByRole("textbox")).not.toBeInTheDocument();
    expect(body).not.toContainElement(screen.getByRole("button", { name: "다음 결과" }));
    expect(screen.getByRole("button", { name: "다음 결과" }).parentElement).toHaveClass("shrink-0");
    const header = within(root).getByRole("region", { name: "운영 로그 필터·상태" });
    expect(header).toHaveClass("min-h-0", "overflow-y-auto");
    expect(header).toHaveAttribute("tabindex", "0");
    header.focus(); expect(header).toHaveFocus();
    body.focus(); expect(body).toHaveFocus();
    if (count) expect(within(body).getByText(`로그 ${count}`)).toBeInTheDocument();
    expect(within(root).queryByRole("alert")).not.toBeInTheDocument();
    expect(within(root).queryByRole("status")).not.toBeInTheDocument();
    expect(body).not.toHaveAttribute("aria-live");
  });
});
