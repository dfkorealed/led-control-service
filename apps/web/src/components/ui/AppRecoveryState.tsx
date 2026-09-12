import { useEffect, useId, useRef } from "react";
import { Button } from "./Button";
import { Card } from "./Card";

export interface AppRecoveryStateProps {
  variant: "service_unavailable" | "forbidden" | "chunk_error";
  onRetry?: () => void;
  onReload?: () => void;
  onRelogin: () => void;
  isPending?: boolean;
}

const recoveryCopy = {
  service_unavailable: { title: "서비스에 연결할 수 없습니다", description: "연결 상태를 확인한 뒤 다시 시도해 주세요. 문제가 계속되면 잠시 후 이용해 주세요." },
  forbidden: { title: "다시 로그인이 필요합니다", description: "현재 계정의 접근 권한이나 인증 상태를 확인할 수 없습니다. 다시 로그인해 주세요." },
  chunk_error: { title: "화면을 불러오지 못했습니다", description: "새로고침하여 화면을 다시 불러와 주세요. 문제가 계속되면 다시 로그인해 주세요." }
};

export function AppRecoveryState({ variant, onRetry, onReload, onRelogin, isPending = false }: AppRecoveryStateProps) {
  const heading = useRef<HTMLHeadingElement>(null);
  const headingId = useId();
  useEffect(() => { heading.current?.focus(); }, [variant]);
  const copy = recoveryCopy[variant];

  return <main className="app-recovery" aria-labelledby={headingId}>
    <Card className="app-recovery-panel">
      <div role="alert">
        <h1 id={headingId} ref={heading} tabIndex={-1}>{copy.title}</h1>
        <p>{copy.description}</p>
      </div>
      <div className="app-recovery-actions" aria-busy={isPending}>
        {variant === "service_unavailable" && <Button variant="primary" disabled={isPending} onClick={onRetry}>다시 시도</Button>}
        {variant === "chunk_error" && <Button variant="primary" disabled={isPending} onClick={onReload}>새로고침</Button>}
        <Button disabled={isPending} onClick={onRelogin}>다시 로그인</Button>
      </div>
      {isPending && <p role="status">복구하는 중입니다.</p>}
    </Card>
  </main>;
}
