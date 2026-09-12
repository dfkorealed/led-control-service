import { Component, type ReactNode } from "react";
import { AppRecoveryState } from "./AppRecoveryState";

interface AppErrorBoundaryProps {
  children: ReactNode;
  onRelogin: () => void;
  onReload?: () => void;
  resetKey: number;
  isPending?: boolean;
}

export class AppErrorBoundary extends Component<AppErrorBoundaryProps, { failed: boolean; resetKey: number }> {
  state = { failed: false, resetKey: this.props.resetKey };

  static getDerivedStateFromError() { return { failed: true }; }

  static getDerivedStateFromProps(props: AppErrorBoundaryProps, state: { resetKey: number }) {
    // 실패한 lazy Promise를 반복 mount하지 않는다. 인증을 정리한 명시적 전환만 boundary를 해제한다.
    return props.resetKey !== state.resetKey ? { failed: false, resetKey: props.resetKey } : null;
  }

  render() {
    if (this.state.failed) return <AppRecoveryState
      variant="chunk_error"
      onReload={this.props.onReload ?? (() => window.location.reload())}
      onRelogin={this.props.onRelogin}
      isPending={this.props.isPending}
    />;
    return this.props.children;
  }
}
