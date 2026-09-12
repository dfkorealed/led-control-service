import { LoaderCircle } from "lucide-react";
import { FeedbackState } from "./FeedbackState";

export function RouteLoadingState({ variant = "panel" }: { variant?: "page" | "panel" }) {
  const content = <FeedbackState
    tone="info"
    icon={LoaderCircle}
    liveRole="status"
    livePoliteness="polite"
    title="화면을 불러오는 중입니다."
  />;

  if (variant === "page") {
    return <main className="operator-shell"><div className="operator-content">{content}</div></main>;
  }

  return content;
}
