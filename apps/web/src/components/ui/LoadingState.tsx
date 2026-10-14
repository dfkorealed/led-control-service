import { forwardRef } from "react";
import { Clock3 } from "lucide-react";
import { FeedbackState, type FeedbackStateProps } from "./FeedbackState";
import { LoadingSpinner } from "./LoadingIndicator";

export type LoadingStateProps = Omit<FeedbackStateProps, "icon" | "liveRole" | "livePoliteness"> & { isPaused?: boolean };

/** Only render for an active request. Error, empty, offline and device progress
 * remain separate caller-owned states rather than indefinite loading. */
export const LoadingState = forwardRef<HTMLElement, LoadingStateProps>(function LoadingState({ isPaused = false, ...props }, ref) {
  return <FeedbackState {...props} ref={ref} title={isPaused ? "네트워크 연결을 기다리고 있습니다." : props.title} icon={isPaused ? Clock3 : LoadingSpinner} liveRole="status" livePoliteness="polite" aria-busy={isPaused ? undefined : true} />;
});
