type BackRequest = { documentId: string; requestId: string };
type BackResult = BackRequest & { handled: boolean; canGoBack: boolean };

export class BackNavigation {
  private documentId?: string;
  private pending?: BackRequest;
  private timer?: ReturnType<typeof setTimeout>;
  private sequence = 0;
  onTimeout?: () => void;
  constructor(private send: (request: BackRequest) => void, private exit: () => void) {}
  bind(documentId: string): void { if (documentId !== this.documentId) { this.reset(); this.documentId = documentId; } }
  request(): void {
    if (!this.documentId || this.pending) return;
    this.pending = { documentId: this.documentId, requestId: `native-back-${++this.sequence}` };
    this.timer = setTimeout(() => { this.pending = undefined; this.onTimeout?.(); }, 2000);
    this.send(this.pending);
  }
  result(result: BackResult): void {
    if (!this.pending || result.documentId !== this.pending.documentId || result.requestId !== this.pending.requestId) return;
    clearTimeout(this.timer); this.pending = undefined;
    // Only a timely explicit top-level acknowledgment permits native exit.
    // Timeout or web history availability never bypasses a web dirty/overlay guard.
    if (!result.handled && !result.canGoBack) this.exit();
  }
  reset(): void { clearTimeout(this.timer); this.pending = undefined; this.documentId = undefined; }
}
