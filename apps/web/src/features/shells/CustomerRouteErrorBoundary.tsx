import { Component, type ReactNode } from "react";
import { CircleAlert } from "lucide-react";
import { Button, FeedbackState } from "../../components/ui";

export class CustomerRouteErrorBoundary extends Component<{ children: ReactNode; scope: string }, { failed: boolean; scope: string }> {
  state = { failed: false, scope: this.props.scope };
  static getDerivedStateFromError() { return { failed: true }; }
  static getDerivedStateFromProps(props: { scope: string }, state: { scope: string }) {
    return props.scope !== state.scope ? { failed: false, scope: props.scope } : null;
  }
  render() {
    return this.state.failed ? <FeedbackState tone="danger" icon={CircleAlert} title="화면을 불러오지 못했습니다."
      description="설정의 내 계정에서 로그아웃하거나 화면을 새로고침하세요." action={<Button type="button" onClick={() => window.location.reload()}>화면 새로고침</Button>} /> : this.props.children;
  }
}
