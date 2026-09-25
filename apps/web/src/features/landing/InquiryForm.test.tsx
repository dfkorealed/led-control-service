import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, ApiTimeoutError, ApiTransportError } from "../../api/client";
import { InquiryForm } from "./InquiryForm";

const submitLandingInquiry = vi.hoisted(() => vi.fn());
vi.mock("../../api/landing-inquiries", () => ({ submitLandingInquiry }));

beforeEach(() => submitLandingInquiry.mockReset());
afterEach(cleanup);

function fillValidForm() {
  fireEvent.change(screen.getByRole("textbox", { name: "회사명" }), { target: { value: "  킨다 시설  " } });
  fireEvent.change(screen.getByRole("textbox", { name: "담당자 이름" }), { target: { value: "  홍길동  " } });
  fireEvent.change(screen.getByRole("textbox", { name: "회신 이메일" }), { target: { value: "  owner@example.com  " } });
  fireEvent.change(screen.getByRole("textbox", { name: "전화번호" }), { target: { value: "  010-1234-5678  " } });
  fireEvent.change(screen.getByRole("textbox", { name: "문의 내용" }), { target: { value: "  B2 조명 상담  " } });
  fireEvent.click(screen.getByRole("checkbox", { name: /개인정보 수집·이용에 동의/ }));
}

function submit() {
  fireEvent.click(screen.getByRole("button", { name: "상담 문의 보내기" }));
}

describe("InquiryForm", () => {
  it("shows a Korean audience placeholder", () => {
    render(<InquiryForm />);
    expect(screen.getByRole("button", { name: /고객 유형/ })).toHaveTextContent("선택해 주세요");
  });

  it("blocks missing required fields, malformed email, and absent consent", async () => {
    render(<InquiryForm />);
    submit();
    expect(submitLandingInquiry).not.toHaveBeenCalled();
    expect(screen.getByRole("textbox", { name: "회사명" })).toHaveFocus();
    expect(screen.getByText("회사명을 입력해 주세요.")).toBeInTheDocument();

    fillValidForm();
    fireEvent.change(screen.getByRole("textbox", { name: "회신 이메일" }), { target: { value: "invalid" } });
    fireEvent.click(screen.getByRole("checkbox", { name: /개인정보 수집·이용에 동의/ }));
    submit();
    expect(submitLandingInquiry).not.toHaveBeenCalled();
    expect(screen.getByRole("textbox", { name: "회신 이메일" })).toHaveFocus();
    expect(screen.getByText("올바른 이메일 주소를 입력해 주세요.")).toBeInTheDocument();
    expect(screen.getByText("개인정보 수집·이용에 동의해 주세요.")).toBeInTheDocument();
  });

  it("posts normalized fields with UUID, consent version, audience, and empty honeypot", async () => {
    submitLandingInquiry.mockResolvedValue({ reference: "KI-123", status: "received" });
    render(<InquiryForm />);
    fillValidForm();
    fireEvent.click(screen.getByRole("button", { name: "고객 유형" }));
    fireEvent.click(screen.getByRole("option", { name: "시공·유통 파트너" }));
    submit();
    await waitFor(() => expect(submitLandingInquiry).toHaveBeenCalledTimes(1));
    const posted = submitLandingInquiry.mock.calls[0][0];
    expect(posted).toEqual({
      idempotencyKey: expect.stringMatching(/^[0-9a-f-]{36}$/i),
      companyName: "킨다 시설", contactName: "홍길동", email: "owner@example.com",
      phone: "010-1234-5678", audience: "partner", message: "B2 조명 상담",
      consent: true, consentVersion: "landing-2026-09-v1-90d", website: ""
    });
    expect(JSON.stringify(posted)).not.toContain("kymkjh2002@dfkorealed.com");
    expect(await screen.findByText(/KI-123/)).toBeInTheDocument();
    expect(screen.queryByText(/이메일.*발송|메일.*전달/)).not.toBeInTheDocument();
  });

  it("rejects phone beyond the server limit and oversized UTF-8 messages before posting", () => {
    render(<InquiryForm />);
    fillValidForm();
    fireEvent.change(screen.getByRole("textbox", { name: "전화번호" }), { target: { value: "1".repeat(31) } });
    submit();
    expect(submitLandingInquiry).not.toHaveBeenCalled();
    expect(screen.getByRole("textbox", { name: "전화번호" })).toHaveFocus();

    fireEvent.change(screen.getByRole("textbox", { name: "전화번호" }), { target: { value: "" } });
    fireEvent.change(screen.getByRole("textbox", { name: "문의 내용" }), { target: { value: "가".repeat(1500) } });
    submit();
    expect(submitLandingInquiry).not.toHaveBeenCalled();
    expect(screen.getByRole("textbox", { name: "문의 내용" })).toHaveFocus();
    expect(screen.getByText("문의 내용이 너무 깁니다. 내용을 줄여 주세요.")).toBeInTheDocument();
  });

  it.each([new ApiTimeoutError(), new ApiTransportError(), new ApiError("server", 500, {})])(
    "keeps fields and key on uncertain failure %s; editing creates a new key",
    async (error) => {
      submitLandingInquiry.mockRejectedValueOnce(error).mockResolvedValue({ reference: "KI-456", status: "received" });
      render(<InquiryForm />);
      fillValidForm();
      submit();
      await screen.findByRole("alert");
      expect(screen.getByRole("textbox", { name: "회사명" })).toHaveValue("  킨다 시설  ");
      const firstKey = submitLandingInquiry.mock.calls[0][0].idempotencyKey;
      submit();
      await waitFor(() => expect(submitLandingInquiry).toHaveBeenCalledTimes(2));
      expect(submitLandingInquiry.mock.calls[1][0].idempotencyKey).toBe(firstKey);
      await screen.findByText(/KI-456/);
    }
  );

  it("changes the key after an edit following failure", async () => {
    submitLandingInquiry.mockRejectedValueOnce(new ApiTimeoutError()).mockResolvedValue({ reference: "KI-789", status: "received" });
    render(<InquiryForm />);
    fillValidForm();
    submit();
    await screen.findByRole("alert");
    const firstKey = submitLandingInquiry.mock.calls[0][0].idempotencyKey;
    fireEvent.change(screen.getByRole("textbox", { name: "문의 내용" }), { target: { value: "다른 상담 내용" } });
    submit();
    await waitFor(() => expect(submitLandingInquiry).toHaveBeenCalledTimes(2));
    expect(submitLandingInquiry.mock.calls[1][0].idempotencyKey).not.toBe(firstKey);
  });

  it.each([
    [429, /잠시 후 다시 시도/, false],
    [503, /현재 온라인 상담을 접수할 수 없습니다/, true]
  ])("shows distinct guidance for %i and mail fallback only when unavailable", async (status, message, hasMail) => {
    submitLandingInquiry.mockRejectedValueOnce(new ApiError("failed", status, {}));
    render(<InquiryForm />);
    fillValidForm();
    submit();
    expect(await screen.findByRole("alert")).toHaveTextContent(message);
    const mail = screen.queryByRole("link", { name: "이메일로 직접 문의하기" });
    if (hasMail) expect(mail).toHaveAttribute("href", "mailto:kymkjh2002@dfkorealed.com");
    else expect(mail).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "회사명" })).toHaveValue("  킨다 시설  ");
  });

  it("prevents a duplicate click while a request is pending", async () => {
    let finish!: (value: { reference: string; status: "received" }) => void;
    submitLandingInquiry.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    render(<InquiryForm />);
    fillValidForm();
    submit();
    expect(screen.getByRole("button", { name: "접수 중" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "접수 중" }));
    expect(submitLandingInquiry).toHaveBeenCalledTimes(1);
    finish({ reference: "KI-987", status: "received" });
    expect(await screen.findByText(/KI-987/)).toBeInTheDocument();
  });
});
