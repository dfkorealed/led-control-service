import type { LandingInquiry } from "@prisma/client";

export type LandingMailMessage = { subject: string; html: string; text: string };
type InquiryContent = Pick<LandingInquiry, "reference" | "companyName" | "contactName" | "email" | "phone" | "audience" | "message">;

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
}

export function renderLandingMail(inquiry: InquiryContent): LandingMailMessage {
  const fields = [
    ["접수번호", inquiry.reference], ["회사명", inquiry.companyName], ["담당자", inquiry.contactName],
    ["회신 이메일", inquiry.email], ["전화번호", inquiry.phone || "미입력"],
    ["고객 유형", inquiry.audience === "facility" ? "시설 운영" : inquiry.audience === "partner" ? "시공·유통" : "미선택"],
    ["문의 내용", inquiry.message]
  ];
  return {
    subject: `[킨다 상담 ${inquiry.reference}] ${inquiry.companyName}`.replace(/[\r\n]/g, " "),
    html: `<h1>킨다 상담 문의</h1>${fields.map(([label, value]) => `<p><strong>${label}</strong><br>${escapeHtml(value).replace(/\r?\n/g, "<br>")}</p>`).join("")}`,
    text: fields.map(([label, value]) => `${label}: ${value}`).join("\n\n")
  };
}
