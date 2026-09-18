// Names mirror styles/theme.css; values are always read from the live theme.
// The contract test requires exact inventory parity when the theme changes.
export const themeColorTokens = [
  "brand-navy", "brand-blue", "brand-coral", "brand-paper",
  "surface-canvas", "surface-panel", "surface-elevated", "surface-inset", "surface-inverse",
  "content-primary", "content-secondary", "content-muted", "content-inverse", "content-disabled",
  "border-subtle", "border-default", "border-strong", "border-focus", "border-disabled",
  "action-primary", "action-primary-hover", "action-primary-active", "action-primary-soft",
  "action-secondary", "action-disabled", "action-danger-background", "action-danger-foreground", "action-danger-border",
  "status-neutral-foreground", "status-neutral-background", "status-neutral-border",
  "status-info-foreground", "status-info-background", "status-info-border",
  "status-success-foreground", "status-success-background", "status-success-border",
  "status-warning-foreground", "status-warning-background", "status-warning-border",
  "status-danger-foreground", "status-danger-background", "status-danger-border",
  "status-warning-badge", "status-danger-badge", "status-info-feedback-foreground", "status-info-feedback-background",
  "status-success-feedback-foreground", "status-warning-feedback-foreground", "status-warning-feedback-background", "status-danger-feedback-foreground",
  "chart-usage", "chart-cost", "chart-baseline", "chart-forecast", "chart-grid", "chart-point", "chart-ranking",
  "chart-heatmap-empty", "chart-heatmap-1", "chart-heatmap-2", "chart-heatmap-3", "chart-heatmap-4", "chart-heatmap-5", "chart-heatmap-default",
  "fixture-connected", "fixture-inspection", "fixture-offline", "fixture-fault", "fixture-off", "fixture-on",
  "fixture-brightness-1", "fixture-brightness-2", "fixture-brightness-3", "fixture-brightness-4", "fixture-brightness-5",
  "fixture-brightness-6", "fixture-brightness-7", "fixture-brightness-8", "fixture-brightness-9", "fixture-brightness-10",
  "fixture-offline-background", "fixture-offline-border", "fixture-inspection-background", "fixture-inspection-border", "fixture-inspection-foreground", "fixture-selected",
  "fixture-editor-connected", "fixture-editor-offline", "fixture-editor-fault", "fixture-editor-selected", "fixture-editor-label", "fixture-editor-border",
  "fixture-editor-fill", "fixture-editor-guide", "fixture-editor-marquee", "fixture-editor-preview", "fixture-editor-minimap"
] as const;

export type ThemeColorToken = typeof themeColorTokens[number];

export function themeColor(token: ThemeColorToken): string {
  return getComputedStyle(document.documentElement).getPropertyValue(`--color-${token}`).trim();
}
