import { useQuery } from "@tanstack/react-query";
import { CircleAlert, CircleCheck, Clock3, Mail } from "lucide-react";
import { useState } from "react";
import {
  getLandingMailStatus, landingMailStatusQueryKey, listOperatorLandingInquiries,
  operatorLandingInquiriesQueryKey, requestLandingMailAuthorization,
  type LandingDeliveryStatus, type OperatorLandingInquiry
} from "../../api/landing-inquiries";
import { Button } from "../../components/ui/Button";
import { Card } from "../../components/ui/Card";
import { DataGrid, type DataGridColumn } from "../../components/ui/DataGrid";
import { FeedbackState } from "../../components/ui/FeedbackState";
import { PageHeader } from "../../components/ui/PageHeader";
import { StatusBadge } from "../../components/ui/StatusBadge";
import { formatTimestamp } from "../../components/ui";

const deliveryPresentation = {
  queued: { label: "발송 대기", tone: "neutral", icon: Clock3 },
  retry_wait: { label: "재시도 대기", tone: "warning", icon: Clock3 },
  provider_accepted: { label: "제공자 수락", tone: "success", icon: CircleCheck },
  delivery_uncertain: { label: "수락 여부 불확실", tone: "warning", icon: CircleAlert },
  failed: { label: "발송 실패", tone: "danger", icon: CircleAlert }
} as const satisfies Record<LandingDeliveryStatus, { label: string; tone: "neutral" | "warning" | "success" | "danger"; icon: typeof Clock3 }>;

export function LandingInquiriesView() {
  const [cursorHistory, setCursorHistory] = useState<string[]>([]);
  const [connectionError, setConnectionError] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const cursor = cursorHistory.at(-1);
  const mail = useQuery({ queryKey: landingMailStatusQueryKey, queryFn: getLandingMailStatus });
  const inquiries = useQuery({ queryKey: [...operatorLandingInquiriesQueryKey, cursor ?? "first"], queryFn: () => listOperatorLandingInquiries(cursor) });

  async function connectMail() {
    if (isConnecting) return;
    setConnectionError(false);
    setIsConnecting(true);
    try { await requestLandingMailAuthorization(); }
    catch { setConnectionError(true); setIsConnecting(false); }
  }

  return <section className="grid gap-5" aria-label="상담 문의 관리">
    <PageHeader title="상담 문의 관리" headingLevel={1} description="최근 접수와 메일 전달 상태를 확인합니다. 접수일로부터 90일이 지난 문의는 목록에서 제외됩니다." />

    <Card className="grid gap-3 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="grid gap-1">
          <h2 className="text-card-title font-bold text-content-primary">NAVER WORKS 메일 연결</h2>
          {mail.isPending ? <p className="text-content-secondary">연결 상태를 확인하는 중입니다.</p> : null}
          {mail.isSuccess ? <p className="text-content-secondary">{mail.data.connected ? "연결됨" : "연결되지 않음"}</p> : null}
        </div>
        {mail.isSuccess ? <Button type="button" variant="primary" isLoading={isConnecting} loadingLabel="연결 시작 중" onClick={() => void connectMail()}>{mail.data.connected ? "NAVER WORKS 다시 연결" : "NAVER WORKS 연결"}</Button> : null}
      </div>
      {mail.isError ? <FeedbackState tone="danger" icon={CircleAlert} title="메일 연결 상태를 확인하지 못했습니다." description="잠시 후 다시 확인하세요." action={<Button type="button" onClick={() => void mail.refetch()}>다시 확인</Button>} /> : null}
      {connectionError ? <FeedbackState tone="danger" icon={CircleAlert} title="연결을 시작하지 못했습니다." description="서버 설정과 연결 상태를 확인한 뒤 다시 시도하세요." /> : null}
    </Card>

    <FeedbackState tone="info" icon={Mail} title="메일 전달 상태 안내" description="제공자 수락은 NAVER WORKS가 요청을 202로 수락했다는 뜻이며, 받은편지함 도착을 뜻하지 않습니다. 수락 여부 불확실 또는 발송 실패라면 보낸메일과 접수번호를 대조하고 회신 필요 여부를 확인하세요." />

    <div className="grid gap-3">
      <h2 className="text-card-title font-bold text-content-primary">최근 상담 문의</h2>
      {inquiries.isPending ? <FeedbackState tone="neutral" icon={Clock3} title="문의 목록을 불러오는 중입니다." /> : null}
      {inquiries.isError ? <FeedbackState tone="danger" icon={CircleAlert} title="문의 목록을 불러오지 못했습니다." description="연결을 확인한 뒤 다시 시도하세요." action={<Button type="button" onClick={() => void inquiries.refetch()}>다시 시도</Button>} /> : null}
      {inquiries.isSuccess ? <DataGrid caption="최근 상담 문의 표" rows={inquiries.data.items} columns={inquiryColumns}
        getRowKey={item => item.reference} emptyState="접수된 상담 문의가 없습니다." /> : null}
      <div className="flex justify-end gap-2">
        {cursorHistory.length > 0 ? <Button type="button" onClick={() => setCursorHistory((history) => history.slice(0, -1))}>이전 문의</Button> : null}
        {inquiries.isSuccess && inquiries.data.nextCursor ? <Button type="button" onClick={() => setCursorHistory((history) => [...history, inquiries.data.nextCursor!])}>다음 문의</Button> : null}
      </div>
    </div>
  </section>;
}

const inquiryColumns: readonly DataGridColumn<OperatorLandingInquiry>[] = [
  { id: "reference", header: "접수번호", minWidth: 140, sortValue: item => item.reference, renderCell: item => item.reference },
  { id: "createdAt", header: "접수일", minWidth: 180, sortValue: item => new Date(item.createdAt), renderCell: item => formatTimestamp(item.createdAt) },
  { id: "contact", header: "회사 / 담당자", minWidth: 160, sortValue: item => `${item.companyName} ${item.contactName}`, renderCell: item => <>{item.companyName}<br /><span className="text-content-secondary">{item.contactName}</span></> },
  { id: "reply", header: "회신 정보", minWidth: 180, sortValue: item => `${item.email} ${item.phone ?? ""}`, renderCell: item => <>{item.email}{item.phone ? <><br />{item.phone}</> : null}</> },
  { id: "message", header: "문의 내용", minWidth: 200, sortValue: item => item.message, renderCell: item => item.message },
  { id: "delivery", header: "메일 상태", minWidth: 150, align: "center", sortValue: item => deliveryPresentation[item.deliveryStatus].label, renderCell: item => {
    const status = deliveryPresentation[item.deliveryStatus];
    return <StatusBadge tone={status.tone} icon={status.icon}>{status.label}</StatusBadge>;
  } }
];
