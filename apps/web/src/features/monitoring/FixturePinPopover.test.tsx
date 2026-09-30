import { useRef } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { FixturePinPopover } from "./FixturePinPopover";
afterEach(cleanup);
it("has a detail action, dismisses with Escape, and exposes no redundant close button", () => {
  const close = vi.fn(), detail = vi.fn();
  function Harness() {
    const ref = useRef<HTMLButtonElement>(null);
    return <><button ref={ref}>핀</button><FixturePinPopover name="미조회" fixture={null} position={null}
      triggerRef={ref} open onOpenChange={close} onShowDetails={detail} timeZone="Asia/Seoul" /></>;
  }
  render(<Harness />);
  const dialog = screen.getByRole("dialog", { name: "미조회 조명 정보" });
  expect(dialog).not.toHaveTextContent(/0%|지도 좌표|RSSI|Health|기술 정보/);
  fireEvent.click(screen.getByRole("button", { name: "상세 보기" })); expect(detail).toHaveBeenCalledOnce();
  expect(screen.queryByRole("button", { name: "조명 정보 닫기" })).not.toBeInTheDocument();
  fireEvent.keyDown(dialog, { key: "Escape" }); expect(close).toHaveBeenCalledWith(false);
});
