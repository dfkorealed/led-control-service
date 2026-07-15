import { useMutation, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Loader2 } from "lucide-react";
import { useState } from "react";
import { claimGateway } from "../../api/setup";

interface GatewayClaimPanelProps {
  siteId: string;
}

export function GatewayClaimPanel({ siteId }: GatewayClaimPanelProps) {
  const queryClient = useQueryClient();
  const [name, setName] = useState("메인 게이트웨이");
  const [serialNumber, setSerialNumber] = useState("");
  const [claimCode, setClaimCode] = useState("");

  const mutation = useMutation({
    mutationFn: () => claimGateway({ siteId, name: name.trim(), serialNumber: serialNumber.trim(), claimCode: claimCode.trim() }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["dashboard"] })
  });
  const disabled = mutation.isPending || !name.trim() || !serialNumber.trim() || !claimCode.trim();

  return (
    <section className="panel setup-section" aria-labelledby="gateway-claim-title">
      <div className="panel-title-row">
        <div>
          <span className="eyebrow">장비 연결</span>
          <h3 id="gateway-claim-title">게이트웨이 등록</h3>
        </div>
      </div>
      <div className="setup-form-grid">
        <label>
          게이트웨이 이름
          <input value={name} onChange={(event) => setName(event.target.value)} />
        </label>
        <label>
          제품 시리얼
          <input value={serialNumber} onChange={(event) => setSerialNumber(event.target.value)} autoComplete="off" />
        </label>
        <label>
          일회성 등록 코드
          <input value={claimCode} onChange={(event) => setClaimCode(event.target.value)} type="password" autoComplete="one-time-code" />
        </label>
      </div>
      {mutation.error ? <p className="danger-text" role="alert">게이트웨이 등록에 실패했습니다. 제품 정보와 등록 코드를 확인하세요.</p> : null}
      {mutation.isSuccess ? <p className="success-text"><CheckCircle2 size={16} />게이트웨이가 현장에 등록되었습니다.</p> : null}
      <button className="primary-button setup-submit" disabled={disabled} onClick={() => mutation.mutate()}>
        {mutation.isPending ? <Loader2 size={16} /> : <CheckCircle2 size={16} />}
        게이트웨이 등록
      </button>
    </section>
  );
}
