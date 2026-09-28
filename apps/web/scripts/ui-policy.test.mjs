import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { inspectUiSource, inspectWorkspace } from "./ui-policy.mjs";

const approvedLandingVariants = `@custom-variant landing-narrow (@media (max-width: 430px));
@custom-variant landing-stack (@media (max-width: 720px));
@custom-variant landing-wide (@media (max-width: 1050px));`;
const canonicalStyles = '@import "tailwindcss"; @import "./styles/theme.css"; @import "./styles/base.css"; @import "./styles/exceptions.css";' + "\n" + approvedLandingVariants;

// Reviewed role/value inventory: docs/ui-spacing.md, landing Task 1 approval.
// Keep this frozen expectation independent of the live theme and policy anchor.
test("landing token proposal preserves exact values", async () => {
  const approved = {
    "--text-landing-button": "14px",
    "--text-landing-button--line-height": "1.2",
    "--text-landing-eyebrow": "13px",
    "--text-landing-eyebrow--letter-spacing": ".16em",
    "--text-landing-brand": "22px",
    "--text-landing-brand--letter-spacing": "-.07em",
    "--text-landing-navigation": "13px",
    "--text-landing-hero-fluid": "clamp(55px, 5.3vw, 78px)",
    "--text-landing-hero-fluid--line-height": "1.15",
    "--text-landing-hero-fluid--letter-spacing": "-.085em",
    "--text-landing-hero-description": "clamp(16px, 1.55vw, 20px)",
    "--text-landing-hero-description--line-height": "1.8",
    "--text-landing-hero-footer": "10px",
    "--text-landing-hero-footer--letter-spacing": ".2em",
    "--text-landing-hero-art-label": "10px",
    "--text-landing-hero-art-label--letter-spacing": ".15em",
    "--text-landing-hero-art-metric": "clamp(17px, 2.1vw, 26px)",
    "--text-landing-hero-art-metric--letter-spacing": "-.05em",
    "--text-landing-scene-watermark": "clamp(120px, 17vw, 250px)",
    "--text-landing-scene-watermark--letter-spacing": "-.1em",
    "--text-landing-scene-number": "11px",
    "--text-landing-scene-number--letter-spacing": ".12em",
    "--text-landing-scene-heading": "clamp(43px, 4.55vw, 70px)",
    "--text-landing-scene-heading--line-height": "1.2",
    "--text-landing-scene-heading--letter-spacing": "-.073em",
    "--text-landing-scene-description": "clamp(16px, 1.35vw, 18px)",
    "--text-landing-scene-description--line-height": "1.8",
    "--text-landing-scene-benefit": "14px",
    "--text-landing-scene-benefit--line-height": "1.6",
    "--text-landing-scene-benefit-marker": "20px",
    "--text-landing-scene-benefit-marker--line-height": "1",
    "--text-landing-demo-disclaimer": "10px",
    "--text-landing-demo-disclaimer--line-height": "1.55",
    "--text-landing-demo-status": "11px",
    "--text-landing-demo-status--line-height": "1.5",
    "--text-landing-inspector-heading": "17px",
    "--text-landing-inspector-heading--letter-spacing": "-.04em",
    "--text-landing-control-metric": "28px",
    "--text-landing-control-metric--letter-spacing": "-.05em",
    "--text-landing-control-hint": "11px",
    "--text-landing-control-hint--line-height": "1.55",
    "--text-landing-chart-heading": "20px",
    "--text-landing-chart-heading--letter-spacing": "-.04em",
    "--text-landing-demo-micro": "9px",
    "--text-landing-report-micro": "9px",
    "--text-landing-report-micro--letter-spacing": ".1em",
    "--text-landing-report-meta": "9px",
    "--text-landing-report-meta--letter-spacing": "0",
    "--text-landing-report-heading": "22px",
    "--text-landing-report-heading--letter-spacing": "-.05em",
    "--text-landing-section-heading": "clamp(40px, 4.4vw, 66px)",
    "--text-landing-section-heading--line-height": "1.18",
    "--text-landing-section-heading--letter-spacing": "-.075em",
    "--text-landing-section-description": "17px",
    "--text-landing-section-description--line-height": "1.75",
    "--text-landing-feature-card-number": "11px",
    "--text-landing-feature-card-number--letter-spacing": ".11em",
    "--text-landing-feature-card-heading": "clamp(22px, 2vw, 28px)",
    "--text-landing-feature-card-heading--line-height": "1.35",
    "--text-landing-feature-card-heading--letter-spacing": "-.055em",
    "--text-landing-feature-card-body": "13px",
    "--text-landing-feature-card-body--line-height": "1.65",
    "--text-landing-feature-card-outcome": "12px",
    "--text-landing-feature-card-outcome--line-height": "1.55",
    "--text-landing-feature-detail-heading": "clamp(36px, 4vw, 58px)",
    "--text-landing-feature-detail-heading--line-height": "1.24",
    "--text-landing-feature-detail-heading--letter-spacing": "-.07em",
    "--text-landing-feature-detail-description": "16px",
    "--text-landing-feature-detail-description--line-height": "1.8",
    "--text-landing-feature-detail-step": "15px",
    "--text-landing-feature-detail-step--line-height": "1.6",
    "--text-landing-feature-detail-step-number": "12px",
    "--text-landing-feature-detail-step-number--letter-spacing": ".08em",
    "--text-landing-feature-detail-outcome": "15px",
    "--text-landing-feature-detail-outcome--line-height": "1.65",
    "--text-landing-plan-name": "15px",
    "--text-landing-plan-name--letter-spacing": ".04em",
    "--text-landing-plan-badge": "11px",
    "--text-landing-plan-badge--letter-spacing": "0",
    "--text-landing-plan-summary": "15px",
    "--text-landing-plan-summary--line-height": "1.65",
    "--text-landing-price": "clamp(34px, 3.2vw, 48px)",
    "--text-landing-price--line-height": "1.1",
    "--text-landing-price--letter-spacing": "-.06em",
    "--text-landing-plan-feature": "15px",
    "--text-landing-plan-feature--line-height": "1.5",
    "--text-landing-pricing-note": "12px",
    "--text-landing-pricing-note--line-height": "1.7",
    "--text-landing-closing-heading": "clamp(46px, 6vw, 82px)",
    "--text-landing-closing-heading--line-height": "1.2",
    "--text-landing-closing-heading--letter-spacing": "-.08em",
    "--text-landing-closing-description": "17px",
    "--text-landing-closing-description--line-height": "1.7",
    "--text-landing-footer-company": "23px",
    "--text-landing-footer-legal": "11px",
    "--text-landing-footer-legal--line-height": "1.6",
    "--text-landing-feature-detail-heading-stacked": "clamp(37px, 7.4vw, 48px)",
    "--text-landing-navigation-stacked": "12px",
    "--text-landing-hero-fluid-stacked": "clamp(48px, 10vw, 72px)",
    "--text-landing-scene-heading-stacked": "clamp(40px, 8.2vw, 58px)",
    "--text-landing-section-heading-narrow": "40px",
    "--text-landing-feature-card-heading-narrow": "21px",
    "--text-landing-feature-detail-heading-narrow": "37px",
    "--text-landing-brand-narrow": "20px",
    "--text-landing-navigation-narrow": "11px",
    "--text-landing-hero-fluid-narrow": "clamp(46px, 11vw, 57px)",
    "--text-landing-scene-heading-narrow": "clamp(38px, 10vw, 48px)",
    "--text-landing-closing-heading-narrow": "clamp(40px, 10vw, 52px)",
    "--text-landing-concept-hero-fluid": "clamp(55px, 6.7vw, 100px)",
    "--text-landing-concept-hero-fluid--line-height": "1.15",
    "--text-landing-concept-hero-fluid--letter-spacing": "-.085em",
    "--text-landing-concept-inquiry-eyebrow": "10px",
    "--text-landing-concept-inquiry-eyebrow--letter-spacing": ".17em",
    "--text-landing-concept-inquiry-title": "32px",
    "--text-landing-concept-inquiry-title--letter-spacing": "-.07em",
    "--text-landing-concept-inquiry-description": "13px",
    "--text-landing-concept-inquiry-description--line-height": "1.6",
    "--text-landing-concept-inquiry-dismiss": "14px",
    "--text-landing-concept-inquiry-label": "12px",
    "--text-landing-concept-inquiry-optional": "11px",
    "--text-landing-concept-inquiry-error": "11px",
    "--text-landing-concept-inquiry-error--line-height": "1.5",
    "--text-landing-concept-inquiry-privacy": "12px",
    "--text-landing-concept-inquiry-privacy--line-height": "1.65",
    "--text-landing-concept-inquiry-feedback": "12px",
    "--text-landing-concept-inquiry-feedback--line-height": "1.6",
    "--text-landing-action": "14px",
    "--text-landing-footer-heading": "14px",
    "--text-landing-feature-detail-copy-narrow": "14px",
    "--text-landing-demo-meta": "11px",
    "--text-landing-feature-card-copy-narrow": "11px",
    "--text-landing-concept-footer-body": "11px",
    "--text-landing-preview-control-value-expanded": "19px",
    "--text-landing-report-heading-narrow": "19px",
    "--text-landing-chart-heading-narrow": "16px",
    "--text-landing-demo-title": "12px",
    "--text-landing-compact-action": "12px",
    "--text-landing-feature-supporting-note": "12px",
    "--text-landing-plan-feature-marker": "12px",
    "--text-landing-scene-benefit-narrow": "12px",
    "--text-landing-control-heading": "13px",
    "--text-landing-feature-card-link": "13px",
    "--text-landing-inquiry-plan": "13px",
    "--text-landing-footer-body": "13px",
    "--text-landing-price-unit": "15px",
    "--text-landing-narrative-copy-narrow": "15px",
    "--text-landing-demo-caption": "10px",
    "--text-landing-demo-control-label": "10px",
    "--text-landing-replay-icon": "18px",
    "--tracking-landing-monitoring-watermark": "-.045em",
    "--tracking-landing-report-footer": "0",
    "--leading-landing-footer-description": "1.65",
    "--leading-landing-footer-contact-row": "1.6",
    "--leading-landing-concept-inquiry-message": "1.5",
    "--spacing-landing-anchor-anchor-offset": "100px",
    "--spacing-landing-skip-link-top": "-100px",
    "--spacing-landing-button-inset": "0 19px",
    "--spacing-landing-brand-mark-inset": "3px",
    "--spacing-landing-navigation-gap": "30px",
    "--spacing-landing-hero-orbit-near-right": "-90px",
    "--spacing-landing-hero-orbit-far-right": "-250px",
    "--spacing-landing-hero-frame-gap": "5%",
    "--spacing-landing-hero-frame-block-inset": "150px 130px",
    "--spacing-landing-hero-heading-margin": "22px 0 26px",
    "--spacing-landing-hero-actions-gap": "26px",
    "--spacing-landing-hero-actions-top-space": "36px",
    "--spacing-landing-hero-footer-bottom": "36px",
    "--spacing-landing-hero-art-background-card-inset": "25px",
    "--spacing-landing-hero-art-metric-card-inset": "27px",
    "--spacing-landing-hero-art-chart-gap": "9px",
    "--spacing-landing-hero-art-chart-top-space": "15px",
    "--spacing-landing-scene-frame-gap": "clamp(28px, 4.5vw, 76px)",
    "--spacing-landing-scene-frame-block-inset": "clamp(95px, 9vh, 135px)",
    "--spacing-landing-scene-number-margin": "0 0 clamp(45px, 8vh, 90px)",
    "--spacing-landing-scene-heading-margin": "17px 0 24px",
    "--spacing-landing-scene-benefit-margin": "30px 0 0",
    "--spacing-landing-scene-benefit-top-inset": "23px",
    "--spacing-landing-demo-backplate-right": "-35px",
    "--spacing-landing-demo-backplate-bottom": "-38px",
    "--spacing-landing-demo-frame-inline-inset": "22px",
    "--spacing-landing-demo-disclaimer-inset": "11px 22px",
    "--spacing-landing-floorplan-caption-inset": "11px 13px",
    "--spacing-landing-parking-spaces-gap": "3%",
    "--spacing-landing-demo-map-label-inset": "5px 9px",
    "--spacing-landing-demo-status-label-gap": "5px",
    "--spacing-landing-demo-status-label-inset": "6px 9px",
    "--spacing-landing-inspector-property-top-inset": "13px",
    "--spacing-landing-control-pendant-cord-top": "-65px",
    "--spacing-landing-control-caption-bottom": "19px",
    "--spacing-landing-control-panel-inset": "23px",
    "--spacing-landing-control-slider-margin": "28px 0 9px",
    "--spacing-landing-control-hint-margin": "30px 0 14px",
    "--spacing-landing-demo-result-top-space": "15px",
    "--spacing-landing-chart-content-inset": "25px 27px 20px",
    "--spacing-landing-chart-heading-gap": "15px",
    "--spacing-landing-chart-frame-top-space": "33px",
    "--spacing-landing-chart-frame-inset": "0 4px 0 31px",
    "--spacing-landing-chart-axis-top": "-5px",
    "--spacing-landing-chart-axis-bottom": "22px",
    "--spacing-landing-chart-footer-top-space": "29px",
    "--spacing-landing-chart-legend-gap": "7px",
    "--spacing-landing-report-content-inset": "20px 25px 23px",
    "--spacing-landing-report-controls-bottom-space": "17px",
    "--spacing-landing-report-format-inset": "0 9px",
    "--spacing-landing-report-sheet-inset": "26px 31px 18px",
    "--spacing-landing-report-heading-margin": "37px 0 5px",
    "--spacing-landing-report-divider-margin": "23px 0 8px",
    "--spacing-landing-report-footer-top-inset": "11px",
    "--spacing-landing-report-history-inset": "10px 13px",
    "--spacing-landing-map-content-inset": "20px 24px 22px",
    "--spacing-landing-map-toolbar-gap": "7px",
    "--spacing-landing-map-hint-left": "15px",
    "--spacing-landing-map-result-top-space": "13px",
    "--spacing-landing-section-frame-block-inset": "clamp(100px, 11vw, 180px)",
    "--spacing-landing-feature-card-inset": "30px",
    "--spacing-landing-feature-card-heading-margin": "15px 0 10px",
    "--spacing-landing-feature-card-link-top-space": "23px",
    "--spacing-landing-preview-canvas-position-inset": "39px 12px 12px",
    "--spacing-landing-preview-control-inset": "23px 16px",
    "--spacing-landing-preview-slider-top-space": "25px",
    "--spacing-landing-preview-value-top-space": "11px",
    "--spacing-landing-preview-schedule-gap": "7px",
    "--spacing-landing-preview-schedule-top-space": "17px",
    "--spacing-landing-preview-chart-gap": "7px",
    "--spacing-landing-preview-chart-margin": "14px 17px",
    "--spacing-landing-preview-chart-inset": "15px 5px 6px",
    "--spacing-landing-preview-report-inset": "14% 9%",
    "--spacing-landing-feature-detail-block-inset": "clamp(105px, 9vw, 160px)",
    "--spacing-landing-feature-frame-gap": "clamp(40px, 6vw, 110px)",
    "--spacing-landing-feature-detail-heading-margin": "20px 0 22px",
    "--spacing-landing-feature-steps-margin": "32px 0 30px",
    "--spacing-landing-feature-detail-outcome-inset": "14px 0 14px 17px",
    "--spacing-landing-feature-detail-link-gap": "11px",
    "--spacing-landing-feature-detail-link-top-space": "29px",
    "--spacing-landing-preview-stage-inset": "45px",
    "--spacing-landing-preview-toolbar-expanded-inline-inset": "19px",
    "--spacing-landing-preview-canvas-expanded-position-inset": "60px 24px 22px",
    "--spacing-landing-preview-control-expanded-inset": "52px 35px",
    "--spacing-landing-preview-slider-expanded-top-space": "55px",
    "--spacing-landing-preview-schedule-expanded-top-space": "36px",
    "--spacing-landing-preview-chart-expanded-margin": "27px 35px",
    "--spacing-landing-preview-chart-expanded-gap": "11px",
    "--spacing-landing-pricing-intro-bottom-space": "44px",
    "--spacing-landing-pricing-card-inset": "clamp(28px, 3vw, 44px)",
    "--spacing-landing-pricing-value-row-gap": "7px",
    "--spacing-landing-pricing-value-row-bottom-inset": "30px",
    "--spacing-landing-pricing-features-margin": "31px 0 39px",
    "--spacing-landing-pricing-note-margin": "25px 0 0",
    "--spacing-landing-inquiry-plan-inset": "11px 14px",
    "--spacing-landing-closing-block-inset": "90px",
    "--spacing-landing-closing-heading-margin": "19px 0 24px",
    "--spacing-landing-closing-description-margin": "0 auto 30px",
    "--spacing-landing-footer-body-block-inset": "70px 27px",
    "--spacing-landing-footer-main-gap": "clamp(35px, 6vw, 95px)",
    "--spacing-landing-footer-main-bottom-inset": "67px",
    "--spacing-landing-footer-description-margin": "17px 0 24px",
    "--spacing-landing-footer-heading-margin": "4px 0 22px",
    "--spacing-landing-footer-contacts-gap": "15px",
    "--spacing-landing-footer-legal-top-inset": "25px",
    "--spacing-landing-feature-frame-medium-gap": "45px",
    "--spacing-landing-scene-frame-medium-gap": "50px",
    "--spacing-landing-feature-detail-stacked-block-inset": "110px 90px",
    "--spacing-landing-preview-stage-stacked-inset": "30px",
    "--spacing-landing-header-frame-stacked-gap": "5px 20px",
    "--spacing-landing-navigation-login-stacked-inline-inset": "11px",
    "--spacing-landing-hero-frame-stacked-gap": "15px",
    "--spacing-landing-hero-frame-stacked-block-inset": "120px 95px",
    "--spacing-landing-hero-illustration-stacked-top-space": "-15px",
    "--spacing-landing-hero-art-background-card-stacked-inset": "15px",
    "--spacing-landing-scene-frame-stacked-block-inset": "85px 90px",
    "--spacing-landing-demo-backplate-stacked-bottom": "-13px",
    "--spacing-landing-inspector-stacked-gap": "7px 12px",
    "--spacing-landing-control-panel-stacked-margin": "15px",
    "--spacing-landing-footer-main-stacked-gap": "38px",
    "--spacing-landing-anchor-narrow-anchor-offset": "118px",
    "--spacing-landing-section-frame-block-inset-narrow": "120px 90px",
    "--spacing-landing-feature-card-narrow-inset": "17px",
    "--spacing-landing-feature-card-link-narrow-top-space": "15px",
    "--spacing-landing-preview-canvas-expanded-narrow-position-inset": "50px 15px 15px",
    "--spacing-landing-preview-control-expanded-narrow-inset": "33px 22px",
    "--spacing-landing-preview-slider-expanded-narrow-top-space": "34px",
    "--spacing-landing-preview-schedule-expanded-narrow-top-space": "19px",
    "--spacing-landing-preview-chart-expanded-narrow-margin": "22px 17px",
    "--spacing-landing-navigation-login-narrow-inline-inset": "7px",
    "--spacing-landing-hero-actions-narrow-gap": "15px",
    "--spacing-landing-hero-illustration-narrow-top-space": "-5px",
    "--spacing-landing-scene-frame-narrow-gap": "37px",
    "--spacing-landing-scene-frame-narrow-block-inset": "72px 80px",
    "--spacing-landing-scene-number-narrow-bottom-space": "30px",
    "--spacing-landing-scene-benefit-narrow-top-space": "19px",
    "--spacing-landing-scene-benefit-narrow-top-inset": "17px",
    "--spacing-landing-demo-frame-compact-inline-inset": "13px",
    "--spacing-landing-demo-title-narrow-gap": "7px",
    "--spacing-landing-demo-content-compact-inset": "15px 12px",
    "--spacing-landing-report-heading-narrow-top-space": "26px",
    "--spacing-landing-html-scroll-padding": "94px",
    "--spacing-landing-concept-footer-body-inset": "25px 0",
    "--spacing-landing-concept-inquiry-header-inset": "30px 34px 20px",
    "--spacing-landing-concept-inquiry-description-margin": "9px 0 0",
    "--spacing-landing-concept-inquiry-form-gap": "19px",
    "--spacing-landing-concept-inquiry-form-inset": "24px 34px 34px",
    "--spacing-landing-concept-inquiry-fields-gap": "15px",
    "--spacing-landing-concept-inquiry-field-gap": "7px",
    "--spacing-landing-concept-inquiry-message-inset": "15px 17px",
    "--spacing-landing-concept-inquiry-message-description-space": "5px 0 0",
    "--spacing-landing-concept-inquiry-consent-gap": "9px",
    "--spacing-landing-concept-inquiry-feedback-action-top-space": "7px",
    "--spacing-landing-html-stacked-scroll-padding": "78px",
    "--spacing-landing-concept-inquiry-header-stacked-inset": "23px 20px 17px",
    "--radius-landing-skip-link": "8px",
    "--radius-landing-button": "12px",
    "--radius-landing-demo-surface": "15px",
    "--radius-landing-brand-mark": "8px",
    "--radius-landing-ellipse": "50%",
    "--radius-landing-glass-panel": "18px",
    "--radius-landing-hero-chart-bar": "5px 5px 0 0",
    "--radius-landing-demo-backplate": "30px",
    "--radius-landing-demo-card": "20px",
    "--radius-landing-floorplan": "12px",
    "--radius-landing-floorplan-entry": "4px",
    "--radius-landing-control-pendant": "0 0 31px 31px",
    "--radius-landing-report-progress": "6px",
    "--radius-landing-map-tool": "8px",
    "--radius-landing-map-hint": "6px",
    "--radius-landing-preview-label-bar": "4px",
    "--radius-landing-preview-detail": "5px",
    "--radius-landing-preview-chart-bar": "4px 4px 0 0",
    "--radius-landing-preview-stage": "35px",
    "--radius-landing-preview-window-expanded": "24px",
    "--radius-landing-preview-stage-narrow": "20px",
    "--radius-landing-preview-window-expanded-narrow": "16px",
    "--radius-landing-inquiry-modal": "18px",
    "--radius-landing-concept-inquiry-privacy": "11px",
    "--radius-landing-concept-inquiry-modal-stacked": "13px",
    "--radius-landing-compact-control": "9px",
    "--radius-landing-compact-summary-surface": "9px",
    "--radius-landing-inset-surface": "7px",
    "--radius-landing-compact-choice-control": "7px",
    "--shadow-landing-demo-card": "0 18px 55px rgb(21 50 74 / .10)",
    "--shadow-landing-hero-atmosphere": "0 0 80px rgb(37 111 161 / .20)",
    "--shadow-landing-glass-panel": "0 25px 50px rgb(23 32 51 / .26)",
    "--shadow-landing-hero-highlight": "0 0 0 16px rgb(255 122 92 / .18)",
    "--shadow-landing-control-floor-glow": "0 0 var(--floor-glow, 15px) rgb(232 242 248 / .42)",
    "--shadow-landing-report-sheet": "0 12px 30px rgb(21 50 74 / .07)",
    "--shadow-landing-map-drag-preview": "0 0 0 6px var(--color-action-primary-soft), 0 7px 17px rgb(21 50 74 / .24)",
    "--shadow-landing-feature-card": "0 9px 32px rgb(21 50 74 / .05)",
    "--shadow-landing-preview-window": "12px 14px 0 var(--color-action-primary-soft)",
    "--shadow-landing-preview-report": "0 7px 16px rgb(21 50 74 / .11)",
    "--shadow-landing-preview-window-expanded": "17px 20px 0 rgb(37 111 161 / .1)",
    "--shadow-landing-pricing-card": "0 12px 36px rgb(21 50 74 / .06)",
    "--shadow-landing-pricing-featured-card": "0 20px 54px rgb(21 50 74 / .11)",
    "--shadow-landing-preview-window-narrow": "6px 7px 0 var(--color-action-primary-soft)",
    "--shadow-landing-concept-inquiry-modal": "0 24px 80px rgb(23 32 51 / .25)",
    "--shadow-landing-header-raised": "0 8px 24px rgb(23 32 51 / .14)",
    "--shadow-landing-fixture-highlight": "0 0 0 5px var(--color-action-primary-soft), 0 0 0 9px rgb(37 111 161 / .12)",
    "--animate-landing-monitoring-cursor": "cursor-path 3.4s ease-in-out forwards",
    "--animate-landing-chart-line": "draw-chart 2.3s ease forwards",
    "--animate-landing-chart-area": "reveal-area 1.1s 1.2s ease forwards",
    "--animate-landing-chart-points": "reveal-points .45s 2s ease forwards",
    "--animate-landing-report-row": "report-row-in .45s ease forwards",
    "--animate-landing-report-history": "report-row-in .45s 1.45s ease forwards",
    "--animate-landing-hero-copy": "rise-in .8s both",
    "--animate-landing-hero-ring": "art-float 1.2s .3s both",
    "--animate-landing-hero-bars": "hero-bar-rise 1.55s ease-out both",
    "--animate-landing-hero-dot": "hero-dot-drift 3.8s ease-in-out both",
    "--animate-landing-hero-pointer": "hero-pointer-drift 3.8s ease-in-out both",
    "--color-status-inquiry-danger-foreground": "#b42318",
    "--color-status-inquiry-danger-border": "#fecdca",
    "--color-status-inquiry-danger-background": "#fff5f4",
    "--leading-landing-concept-document": "normal",
    "--leading-landing-text-action": "var(--text-body--line-height)",
    "--leading-landing-compact-button": "var(--text-landing-button--line-height)",
    "--background-image-landing-preview-map-grid": "linear-gradient(90deg, transparent 48%, var(--color-border-default) 49%, var(--color-border-default) 50%, transparent 51%), linear-gradient(transparent 49%, var(--color-border-default) 50%, transparent 51%)",
    "--background-image-landing-preview-editor-grid": "linear-gradient(var(--color-border-default) 1px, transparent 1px), linear-gradient(90deg, var(--color-border-default) 1px, transparent 1px)",
    "--font-landing": "Inter, \"Pretendard\", \"Noto Sans KR\", -apple-system, BlinkMacSystemFont, \"Segoe UI\", sans-serif"
  };
  const theme = (await readFile(new URL("../src/styles/theme.css", import.meta.url), "utf8"))
    .replace(/\/\*[\s\S]*?\*\//g, "");
  const declarations = [...theme.matchAll(/(--[\w-]+)\s*:\s*([^;{}]+);/g)];
  // Root theme gradients resolve nested runtime positions before the input owns them.
  assert.ok(!declarations.some(([, name]) => name === "--background-image-landing-brightness-track"));
  for (const [name, value] of Object.entries(approved)) {
    const matches = declarations.filter(([, declaredName]) => declaredName === name);
    assert.equal(matches.length, 1, `${name} must be declared exactly once`);
    assert.equal(matches[0][2].trim(), value, `${name} must preserve the reviewed value`);
  }
});

test("production UI has no legacy policy violations", async () => {
  const result = await inspectWorkspace({ baseline: {} });
  assert.deepEqual(result.violations, []);
});

test("workspace inspection rejects non-empty debt allowances", async () => {
  await assert.rejects(
    inspectWorkspace({ baseline: { "src/New.tsx": { "raw-color": { count: 1, matches: { red: 1 } } } } }),
    /zero-baseline/
  );
});

test("rejects arbitrary spacing, raw colors and production querySelector", () => {
  const violations = inspectUiSource("sample.tsx", 'className="p-[13px] text-[#fff]"; node.querySelector("button")');
  assert.deepEqual(violations.map(({ rule }) => rule), ["arbitrary-spacing", "raw-color", "query-selector"]);
  assert.deepEqual(violations[0], { rule: "arbitrary-spacing", path: "sample.tsx", match: "p-[13px]" });
});

test("accepts all approved spacing steps, semantic colors and typography", () => {
  const source = 'className="p-0.5 p-1 p-1.5 p-2 p-2.5 p-3 p-3.5 p-4 p-4.5 p-5 p-6 p-7 p-8 p-10 p-12 p-16 p-0 -mt-2 mx-auto top-1/2 max-compact:gap-3 bg-surface-panel text-content-primary text-body rounded-panel shadow-panel"';
  assert.deepEqual(inspectUiSource("sample.tsx", source), []);
});

test("rejects arbitrary radius and shadow utilities without a legacy debt allowance", () => {
  const arbitrary = 'className="rounded-[3px] shadow-[0_0_2px_red]"';
  assert.deepEqual(inspectUiSource("src/New.tsx", arbitrary).map(v => v.rule), ["arbitrary-theme-utility", "arbitrary-theme-utility"]);

  const fixtureShadow = "shadow-[0_0_0_0_color-mix(in_srgb,var(--color-fixture-on)_0%,transparent),inset_0_0_0_1px_color-mix(in_srgb,var(--color-content-inverse)_24%,transparent)]";
  assert.deepEqual(
    inspectUiSource("src/features/floor-map/FloorScene.tsx", `"rounded-[3px] ${fixtureShadow}"`).map(v => v.rule),
    ["arbitrary-theme-utility", "arbitrary-theme-utility"]
  );
});

test("permits runtime exceptions only in their reviewed syntax context", () => {
  const geometry = 'const base = { strokeColor: "#2563eb", fillColor: "#dbeafe", fontSize: 16 };';
  assert.deepEqual(inspectUiSource("src/features/floor-editor/geometry.ts", geometry), []);
  assert.deepEqual(
    inspectUiSource("src/features/floor-editor/geometry.ts", `${geometry}\nconst unrelated = "#2563eb";`).map(v => v.match),
    ["#2563eb"]
  );
  assert.deepEqual(
    inspectUiSource("src/features/floor-editor/geometry.ts", 'const unrelated = { strokeColor: "#2563eb", fillColor: "#dbeafe", fontSize: 16 };').map(v => v.rule),
    ["raw-color", "raw-color", "literal-typography"]
  );
  assert.deepEqual(
    inspectUiSource("src/features/floor-editor/geometry.ts", 'const base = { nested: { strokeColor: "#2563eb", fillColor: "#dbeafe", fontSize: 16 } };').map(v => v.rule),
    ["raw-color", "raw-color", "literal-typography"]
  );

  const chart = '<ComposedChart margin={{ top: 12, right: 12, left: 0, bottom: 8 }} />';
  assert.deepEqual(inspectUiSource("src/features/statistics/EnergyComparisonChart.tsx", chart), []);
  assert.deepEqual(
    inspectUiSource("src/features/statistics/EnergyComparisonChart.tsx", `${chart}\nconst unrelated = { top: 12, right: 12, bottom: 8 };`).map(v => v.match),
    ["top: 12", "right: 12", "bottom: 8"]
  );
  assert.deepEqual(inspectUiSource("src/features/statistics/EnergyComparisonChart.tsx", '<ComposedChart margin={{ top: 13, right: 12, left: 0, bottom: 8 }} />').map(v => v.match), ["top: 13"]);
  assert.deepEqual(
    inspectUiSource("src/features/statistics/EnergyComparisonChart.tsx", '<ComposedChart margin={{ nested: { top: 12, right: 12, bottom: 8 } }} />').map(v => v.rule),
    Array(3).fill("literal-spacing")
  );
});

test("layer wrappers preserve first-selector and raw-form fingerprints without hiding debt", () => {
  const css = '.first { padding: 13px; color: red; } button.custom { margin: 4px; }';
  const expected = inspectUiSource("src/styles.css", css);
  assert.deepEqual(expected.filter(v => v.rule === "css-selector").map(v => v.match), [".first", "button.custom"]);
  assert.deepEqual(expected.filter(v => v.rule === "raw-form-style").map(v => v.match), ["button.custom"]);
  for (const wrapped of [
    `@layer components { ${css} }`,
    `@layer { ${css} }`,
    `@layer components { @layer controls { ${css} } }`,
    `@media (min-width: 760px) { @layer components { ${css} } }`
  ]) assert.deepEqual(inspectUiSource("src/styles.css", wrapped), expected, wrapped);
});

test("adjacent component layers count each first selector exactly once", () => {
  const css = '@layer components { button.first {} } @layer components { input.second {} }';
  const violations = inspectUiSource("src/styles.css", css);
  assert.deepEqual(violations.map(v => [v.rule, v.match]), [
    ["css-selector", "button.first"], ["raw-form-style", "button.first"],
    ["css-selector", "input.second"], ["raw-form-style", "input.second"]
  ]);
  assert.deepEqual(inspectUiSource("src/styles/base.css", '@layer base { button, input, select, textarea { font: inherit; } }'), []);
});

for (const group of ["@media (min-width: 760px)", "@supports (display: grid)", "@supports (display: grid) { @media (min-width: 760px)"]) {
  test(`nested layer ${group} preserves every first form selector`, () => {
    const nested = `${group} { button.first {} input.second {} }${group.includes("{") ? " }" : ""}`;
    assert.deepEqual(inspectUiSource("src/styles.css", `@layer components { ${nested} }`).map(v => [v.rule, v.match]), [
      ["css-selector", "button.first"], ["raw-form-style", "button.first"],
      ["css-selector", "input.second"], ["raw-form-style", "input.second"]
    ]);
  });
}

test("keyframe steps are not selectors and do not hide adjacent form rules", () => {
  for (const prefix of ["@keyframes", "@-webkit-keyframes"]) {
    const css = `@layer components { @supports (display: grid) { ${prefix} pulse { from { opacity: 0; } 25%, 50% { opacity: .5; } to { opacity: 1; } } button.first {} } input.second {} }`;
    assert.deepEqual(inspectUiSource("src/styles.css", css).map(v => [v.rule, v.match]), [
      ["css-selector", "button.first"], ["raw-form-style", "button.first"],
      ["css-selector", "input.second"], ["raw-form-style", "input.second"]
    ]);
  }
});

test("keyframe declarations retain color and spacing debt without selector debt", () => {
  assert.deepEqual(inspectUiSource("src/styles.css", '@keyframes pulse { from { color: red; } to { padding: 13px; content: "}"; } } button.next {}').map(v => [v.rule, v.match]), [
    ["raw-color", "red"], ["literal-spacing", "padding: 13px"],
    ["css-selector", "button.next"], ["raw-form-style", "button.next"]
  ]);
});

test("blocks numeric spacing outside the approved scale, including variants and negatives", () => {
  assert.deepEqual(inspectUiSource("sample.tsx", '"p-9 hover:gap-11 -mt-13 max-compact:px-0.75 inset-15"').map(v => v.rule), Array(5).fill("unapproved-spacing"));
});

test("I1 rejects px spacing utilities and static calc/clamp without banning runtime positions", () => {
  assert.deepEqual(inspectUiSource("src/New.tsx", '<div className="p-px hover:gap-px max-compact:-mt-px" />').map(v => v.rule), ["unapproved-spacing", "unapproved-spacing", "unapproved-spacing"]);
  const css = 'body { padding: calc(13px); gap: clamp(0px, 13px, 20px); margin: calc(var(--space-1) + 13px); }';
  assert.deepEqual(inspectUiSource("src/styles/base.css", css).map(v => v.rule), ["literal-spacing", "literal-spacing", "literal-spacing"]);
  assert.equal(inspectUiSource("src/New.tsx", 'style={{ padding: "calc(13px)", gap: "clamp(0px, 13px, 20px)" }}').filter(v => v.rule === "literal-spacing").length, 2);
  assert.deepEqual(inspectUiSource("src/styles/base.css", 'body { top: clamp(16px, var(--fixture-top), calc(100% - 16px)); left: calc(50% - 10px); padding: var(--space-4); margin: 0 auto; gap: 0; }'), []);
  assert.deepEqual(inspectUiSource("src/New.tsx", 'style={{ top: position.y, left: "calc(var(--measured-left) - 10px)" }}'), []);
  assert.deepEqual(inspectUiSource("src/styles/base.css", 'body { border-top: 1px solid #fff; border-left: 1px solid var(--color-border-default); }').map(v => v.rule), ["raw-color"]);
});

test("blocks variable arbitrary spacing, arbitrary colors and stock palette classes", () => {
  assert.deepEqual(inspectUiSource("sample.tsx", '"p-(--custom) bg-[var(--custom)] text-red-500"').map(v => v.rule), ["arbitrary-spacing", "arbitrary-color", "unapproved-color"]);
});

test("blocks CSS and React literal spacing and typography without flagging geometry", () => {
  assert.deepEqual(inspectUiSource("sample.tsx", 'style={{ padding: 13, gap: "1rem", fontSize: 17, lineHeight: 1.7, letterSpacing: "0.1em", width: 44, height: "100%", top: position.y }}').map(v => v.rule), ["literal-spacing", "literal-spacing", "literal-typography", "literal-typography", "literal-typography"]);
  assert.deepEqual(inspectUiSource("src/styles/base.css", 'body { margin: 0; padding: 13px 1rem; font-size: 17px; border: 1px solid var(--color-border-default); min-height: 44px; }').filter(v => v.rule !== "css-selector").map(v => v.rule), ["literal-spacing", "literal-typography"]);
});

test("rejects literal colors in CSS, SVG props and style objects", () => {
  assert.deepEqual(inspectUiSource("sample.tsx", '<path fill="white" stroke="#ff00aa" style={{ color: "rgb(1 2 3)", background: "rebeccapurple" }} />').map(v => v.rule), Array(4).fill("raw-color"));
});

test("I3 accepts semantic custom properties and catches literal JSX/style color values", () => {
  assert.deepEqual(inspectUiSource("src/styles/base.css", 'body { color: var(--color-brand-blue); background: var(--color-brand-navy); border: 1px solid var(--color-brand-coral); }'), []);
  assert.deepEqual(inspectUiSource("src/New.tsx", '<path fill={"var(--color-brand-blue)"} style={{ stroke: "var(--color-brand-coral)" }} />'), []);
  assert.deepEqual(inspectUiSource("src/New.tsx", '<path fill={"white"} stroke={\'red\'} style={{ color: "rebeccapurple", backgroundColor: "blue" }} />').map(v => v.match), ["white", "red", "rebeccapurple", "blue"]);
  assert.deepEqual(inspectUiSource("src/styles/base.css", 'body { color: var(--color-brand-blue, red); background: linear-gradient(white, var(--color-brand-navy)); }').map(v => v.match), ["red", "white"]);
  assert.deepEqual(inspectUiSource("src/New.tsx", '<path fill={palette.red} style={{ color: palette.blue }} />'), []);
});

test("I7 catches literal template, image and shadow colors without treating runtime values as CSS", () => {
  const jsx = '<path fill={`white`} style={{ backgroundImage: "linear-gradient(red, blue)", boxShadow: `0 0 2px red` }} />';
  assert.deepEqual(inspectUiSource("src/New.tsx", jsx).map(v => v.match), ["white", "red", "blue", "red"]);
  assert.deepEqual(inspectUiSource("src/styles/base.css", 'body { background-image: linear-gradient(red, blue); box-shadow: 0 0 2px red; text-shadow: 0 0 2px blue; }').map(v => v.match), ["red", "blue", "red", "blue"]);
  assert.deepEqual(inspectUiSource("src/New.tsx", '<div style={{ backgroundImage: "linear-gradient(#123456, rgb(1 2 3))", boxShadow: `0 0 2px #fff` }} />').map(v => v.rule), Array(3).fill("raw-color"));
  assert.deepEqual(inspectUiSource("src/New.tsx", '<path fill={`${palette.white}`} style={{ backgroundImage: palette.red, boxShadow: shadows.blue, color: `var(--color-brand-blue)` }} />'), []);
  assert.deepEqual(inspectUiSource("src/styles/base.css", 'body { background-image: linear-gradient(var(--color-brand-blue), var(--color-brand-coral)); box-shadow: var(--shadow-panel); }'), []);
});

test("I9 scans template static segments, filter and SVG stop colors but not expressions or URL payloads", () => {
  const source = '<stop stopColor={`white-${suffix}`} style={{ backgroundImage: `linear-gradient(red, ${palette.blue})`, filter: "drop-shadow(0 0 2px red)" }} />';
  assert.deepEqual(inspectUiSource("src/New.tsx", source).map(v => v.match), ["white", "red", "red"]);
  assert.deepEqual(inspectUiSource("src/styles/base.css", 'body { filter: drop-shadow(0 0 2px blue); stop-color: red; }').map(v => v.match), ["blue", "red"]);
  assert.deepEqual(inspectUiSource("src/New.tsx", '<stop stopColor={`${palette.white}`} style={{ backgroundImage: `linear-gradient(var(--color-brand-blue), ${palette.red})`, filter: filters.red }} />'), []);
});

test("I9 ignores URL payload words while scanning adjacent gradient colors", () => {
  assert.deepEqual(inspectUiSource("src/New.tsx", '<div style={{ backgroundImage: "url(/images/white.png)" }} />'), []);
  assert.deepEqual(inspectUiSource("src/styles/base.css", 'body { background-image: url("/images/red.png"), linear-gradient(blue, var(--color-brand-blue)); }').map(v => v.match), ["blue"]);
  assert.deepEqual(inspectUiSource("src/styles/base.css", 'body { background-image: url("/images/red.png"),\n linear-gradient(blue, var(--color-brand-blue)); }').map(v => v.match), ["blue"]);
});

test("blocks stock and arbitrary typography, fractional padding and subpixel literals", () => {
  assert.deepEqual(inspectUiSource("sample.tsx", '"text-sm leading-7 tracking-wide text-[17px] p-1/2"; style={{ gap: 0.5 }}').map(v => v.rule), ["unapproved-typography", "unapproved-typography", "unapproved-typography", "arbitrary-typography", "unapproved-spacing", "literal-spacing"]);
});

test("I2 rejects semantic text line-height overrides in numeric, arbitrary and variable forms", () => {
  const classes = '"text-body/7 text-body/[17px] max-compact:text-page-title/(--custom-leading) text-body/[var(--custom-leading)]"';
  assert.deepEqual(inspectUiSource("src/New.tsx", classes).map(v => v.rule), Array(4).fill("unapproved-typography"));
  assert.deepEqual(inspectUiSource("src/New.tsx", '"text-body text-page-title text-content-primary/70"'), []);
});

test("rejects static CSS and inline typography hidden in calculations", () => {
  assert.deepEqual(inspectUiSource("src/styles/base.css", 'body { font-size: calc(17px); line-height: clamp(0px, 17px, 24px); letter-spacing: calc(1px); }').map(v => v.rule), Array(3).fill("literal-typography"));
  assert.equal(inspectUiSource("src/New.tsx", 'style={{ fontSize: "calc(17px)" }}')[0].rule, "literal-typography");
});

test("theme permits only token declarations, not arbitrary rules or new CSS imports", async () => {
  const path = "src/styles/theme.css";
  assert.deepEqual(inspectUiSource(path, await readFile(new URL("../src/styles/theme.css", import.meta.url), "utf8")), []);
  assert.ok(inspectUiSource(path, 'body { color: #fff; padding: 13px; }').some(v => v.rule === "raw-color"));
  assert.ok(inspectUiSource(path, '@import "./rogue.css";').some(v => v.rule === "css-import"));
  assert.ok(inspectUiSource("src/other/theme.css", '@theme { --color-test: #fff; }').some(v => v.rule === "raw-color"));
});

test("anchors the fixture marker radius and every brightness shadow token", async () => {
  const path = "src/styles/theme.css";
  const theme = await readFile(new URL("../src/styles/theme.css", import.meta.url), "utf8");
  const names = ["--radius-fixture-marker", ...Array.from({ length: 10 }, (_, index) => `--shadow-fixture-brightness-${index + 1}`)];
  for (const name of names) assert.match(theme, new RegExp(`${name}: [^;]+;`), name);
  for (const name of names) {
    const changed = theme.replace(new RegExp(`${name}: [^;]+;`), `${name}: 0 0 1px red;`);
    assert.ok(inspectUiSource(path, changed).some(v => v.rule === "unapproved-theme-value"), name);
  }
});

test("I6 rejects changed anchored theme values across every token family", async () => {
  const path = "src/styles/theme.css";
  const theme = await readFile(new URL("../src/styles/theme.css", import.meta.url), "utf8");
  assert.deepEqual(inspectUiSource(path, theme), []);
  for (const [name, value] of [["--spacing", "13px"], ["--text-body", "13px"], ["--breakpoint-compact", "777px"], ["--color-brand-blue", "red"], ["--radius-panel", "1px"], ["--shadow-panel", "0 0 2px red"], ["--color-*", "red"]]) {
    const changed = theme.replace(new RegExp(`${name.replace("*", "\\*")}: [^;]+;`), `${name}: ${value};`);
    assert.ok(inspectUiSource(path, changed).some(v => v.rule === "unapproved-theme-value"), name);
  }
  assert.deepEqual(inspectUiSource(path, theme.replace("0 8px 24px rgb(30 64 175 / 0.06)", "0  /* explanation */ 8px\n 24px rgb( 30 64 175/0.06 )")), []);
  assert.ok(inspectUiSource(path, "@theme static { --spacing: 13px }").some(v => v.rule === "unapproved-theme-value"));
  // Only the final declaration may omit its semicolon. Later approved tokens
  // mean the font declaration is no longer the final one.
  assert.deepEqual(inspectUiSource(path, theme.replace(/;(\s*})$/, "$1")), []);
});

test("I8 requires one complete canonical theme declaration inventory", async () => {
  const path = "src/styles/theme.css";
  const theme = await readFile(new URL("../src/styles/theme.css", import.meta.url), "utf8");
  const cases = [
    [theme.replace(/--color-chart-cost:[^;]+;/, ""), "missing-theme-token"],
    [theme.replace(/--breakpoint-tablet:[^;]+;/, ""), "missing-theme-token"],
    ["/* theme removed */", "missing-theme-token"],
    [theme.replace("--spacing: 4px;", "--spacing: 4px; --spacing: 4px;"), "duplicate-theme-token"],
    [theme.replace("--spacing: 4px;", "--rogue: 4px; --spacing: 4px;"), "unapproved-theme-token"],
    [theme.replace("--spacing: 4px;", "--spacing: 13px;"), "unapproved-theme-value"],
    [theme.replace("@theme static", "@theme inline"), "unapproved-theme-block"],
    [theme + "\n@theme static {}", "unapproved-theme-block"],
    ["@theme inline { --spacing: 13px; }", "unapproved-theme-block"],
  ];
  assert.deepEqual(cases.map(([source, rule]) => inspectUiSource(path, source).some(v => v.rule === rule)), Array(9).fill(true));
});

test("rejects unknown theme names, semantic typos and arbitrary responsive breakpoints", () => {
  assert.ok(inspectUiSource("src/styles/theme.css", '@theme static { --text-rogue: 1rem; --breakpoint-rogue: 777px; }').some(v => v.rule === "unapproved-theme-token"));
  assert.deepEqual(inspectUiSource("src/New.tsx", '"max-[777px]:p-4 tablet:bg-surface-pannel text-rogue rounded-rogue shadow-rogue"').map(v => v.rule), ["unapproved-breakpoint", "unapproved-color", "unapproved-typography", "unapproved-theme-utility", "unapproved-theme-utility"]);
  assert.deepEqual(inspectUiSource("src/New.tsx", '"max-compact:p-4 tablet:p-6 bg-surface-panel text-body rounded-panel shadow-popover text-center"'), []);
  assert.deepEqual(inspectUiSource("src/styles/base.css", 'body { text-align: center; text-transform: none; text-decoration: none; }'), []);
  assert.deepEqual(inspectUiSource("src/New.tsx", 'const values = { [key]: value }; const selector = "[tabindex]:not([disabled])";'), []);
});

test("allows exact entry imports and main entry only", () => {
  assert.deepEqual(inspectUiSource("src/styles.css", '@import "tailwindcss"; @import "./styles/theme.css"; @import "./styles/base.css"; @import "./styles/exceptions.css";'), []);
  assert.deepEqual(inspectUiSource("src/main.tsx", 'import "./styles.css";'), []);
  assert.ok(inspectUiSource("src/page.tsx", 'import "./page.css";').some(v => v.rule === "css-import"));
  assert.ok(inspectUiSource("src/page.tsx", 'import("./page.css");').some(v => v.rule === "css-import"));
});

test("rejects imports of the retired landing motion stylesheet", () => {
  assert.ok(inspectUiSource("src/styles.css", '@import "./features/landing/landing.css";').some(v => v.rule === "css-import"));
  assert.ok(inspectUiSource("src/page.tsx", 'import "./features/landing/landing.css";').some(v => v.rule === "css-import"));
  assert.ok(inspectUiSource("src/styles.css", '@import "./features/landing/other.css";').some(v => v.rule === "css-import"));
});

test("rejects retired landing motion selectors and stylesheets", () => {
  const source = '.landing-page[data-landing-motion] [data-landing-revealed] { animation: landing-enter 520ms both; }';
  assert.ok(inspectUiSource("src/features/landing/landing.css", source).some(v => v.rule === "css-file"));
  assert.ok(inspectUiSource("src/features/landing/landing.css", source).some(v => v.rule === "css-selector"));
  const hero = '.landing-page[data-landing-hero-ready] :is( .landing-hero-heading, .landing-hero-description, .landing-hero-actions, .landing-hero-preview ) { animation: landing-enter 560ms both; }';
  assert.ok(inspectUiSource("src/features/landing/landing.css", hero).some(v => v.rule === "css-selector"));
  const removedKicker = '.landing-page[data-landing-hero-ready] :is( .landing-hero-kicker, .landing-hero-heading, .landing-hero-description, .landing-hero-actions, .landing-hero-preview ) { animation: landing-enter 560ms both; }';
  assert.ok(inspectUiSource("src/features/landing/landing.css", removedKicker).some(v => v.rule === "css-selector"));
  const elsewhere = inspectUiSource("src/features/landing/other.css", source);
  assert.ok(elsewhere.some(v => v.rule === "css-file"));
  assert.ok(elsewhere.some(v => v.rule === "css-selector"));
});

test("retired landing CSS cannot bypass selector, color or spacing policy", () => {
  for (const selector of ["body", ".landing-page-rogue", ".landing-page, body", ".landing-page + .other", ".landing-page ~ .other"]) {
    assert.ok(inspectUiSource("src/features/landing/landing.css", `${selector} { animation: none; }`).some(v => v.rule === "css-selector"), selector);
  }
  const violations = inspectUiSource("src/features/landing/landing.css", '.landing-page[data-landing-motion] [data-landing-revealed] { color: red; padding: 13px; }');
  assert.ok(violations.some(v => v.rule === "raw-color"));
  assert.ok(violations.some(v => v.rule === "literal-spacing"));
});

test("rejects rogue utilities and extensionless CSS package imports", () => {
  assert.ok(inspectUiSource("src/styles.css", '@utility rogue { color: red; }').some(v => v.rule === "css-utility"));
  assert.ok(inspectUiSource("src/main.tsx", 'import "tailwindcss";').some(v => v.rule === "css-import"));
});

test("does not mistake JavaScript variant object keys for responsive utility prefixes", () => {
  const source = 'const sm = "px-3"; const classes = {sm:sm, md:"px-4", lg: { padding: "12%" }}; type Sizes = {sm:string; md: string; lg?: string};';
  assert.deepEqual(inspectUiSource("src/components/ui/fields/field-types.ts", source), []);
});

test("still rejects actual unapproved responsive prefixes inside class strings and templates", () => {
  const samples = [
    ['const classes = { sm: "sm:p-3", md: "md:hover:bg-surface-panel" };', ["sm:", "md:"]],
    ['<div className="lg:flex xl:p-4" />', ["lg:", "xl:"]],
    ['const classes = `2xl:p-4 ${active ? "md:block" : "lg:hidden"} max-[777px]:p-4`;', ["2xl:", "md:", "lg:", "max-[777px]:"]],
    ['const prefix = "sm:"; const classes = `${prefix}p-4`;', ["sm:"]],
    ['const classes = "tablet:flex max-compact:p-4";', []]
  ];
  for (const [source, expected] of samples) assert.deepEqual(inspectUiSource("src/New.tsx", source).filter(v => v.rule === "unapproved-breakpoint").map(v => v.match), expected);
});

test("rejects arbitrary breakpoints even when an equivalent named phone-wide token exists", () => {
  const source = 'const classes = "min-[360px]:grid-cols-4 max-[359px]:order-1";';
  assert.deepEqual(
    inspectUiSource("src/New.tsx", source).filter(v => v.rule === "unapproved-breakpoint").map(v => v.match),
    ["min-[360px]:", "max-[359px]:"]
  );
});

test("accepts only the reviewed 360px phone-wide token and named utilities", async () => {
  const path = "src/styles/theme.css";
  const theme = await readFile(new URL("../src/styles/theme.css", import.meta.url), "utf8");
  assert.deepEqual(inspectUiSource(path, theme), []);
  assert.deepEqual(inspectUiSource("src/New.tsx", 'const classes = "phone-wide:grid-cols-4 max-phone-wide:order-1";'), []);
  assert.ok(inspectUiSource(path, theme.replace(/--breakpoint-phone-wide:[^;]+;/, "")).some(v => v.rule === "missing-theme-token"));
  assert.ok(inspectUiSource(path, theme.replace(/--breakpoint-phone-wide:[^;]+;/, "--breakpoint-phone-wide: 22rem;")).some(v => v.rule === "unapproved-theme-value"));
});

test("accepts only the reviewed final atlas shell layout tokens", async () => {
  const path = "src/styles/theme.css";
  const theme = await readFile(new URL("../src/styles/theme.css", import.meta.url), "utf8");
  const tokens = new Map([
    ["--spacing-shell-rail", "5.5rem"],
    ["--container-auth", "60rem"],
    ["--container-operator", "72.5rem"],
    ["--container-status-drawer", "27.5rem"]
  ]);
  for (const [name, value] of tokens) {
    assert.match(theme, new RegExp(`${name}: ${value.replace(".", "\\.")};`));
    const changed = theme.replace(`${name}: ${value};`, `${name}: 1rem;`);
    assert.ok(inspectUiSource(path, changed).some(violation => violation.rule === "unapproved-theme-value"), name);
  }
});

test("inventories unapproved CSS files, selectors and raw form styling", () => {
  const violations = inspectUiSource("src/page.css", '.new-panel { display: grid; } input { appearance: none; }');
  assert.ok(violations.some(v => v.rule === "css-file"));
  assert.equal(violations.filter(v => v.rule === "css-selector").length, 2);
  assert.ok(violations.some(v => v.rule === "raw-form-style"));
});

test("blocks newly styled native fields outside the shared UI ownership boundary", () => {
  const source = '<input className="p-2" />';
  assert.ok(inspectUiSource("src/features/example.tsx", source).some(v => v.rule === "raw-form-style"));
  assert.deepEqual(inspectUiSource("src/components/ui/TextField.tsx", source), []);
});

test("blocks native form styling hidden behind JSX spreads and React.createElement", () => {
  for (const source of [
    '<input {...{ className: "p-2" }} />',
    '<select {...props} />',
    'React.createElement("textarea", { style: styles })',
    'React.createElement("button", { ...props })',
    'React.createElement(("input"), { "className": "p-2" })',
    'import { createElement as h } from "react"; h("input", { className: "p-2" })',
    '<FormField><input {...{ className: "p-2" }} /></FormField>'
  ]) {
    assert.ok(inspectUiSource("src/features/example.tsx", source).some(v => v.rule === "raw-form-style"), source);
  }
  assert.deepEqual(inspectUiSource("src/features/example.tsx", 'import { FormField } from "../components/ui"; <FormField><input {...attributes} /></FormField>'), []);
  assert.deepEqual(inspectUiSource("src/components/ui/Field.tsx", '<input {...props} />'), []);
});

test("rejects unquoted CSS URL imports", () => {
  assert.ok(inspectUiSource("src/styles.css", '@import url(./rogue.css);').some(v => v.rule === "css-import"));
});

test("M1 CSS query/hash imports require an exact approved resource ID", () => {
  assert.deepEqual(inspectUiSource("src/New.tsx", 'import "./new.css?inline"; import("./old.css#theme");').map(v => v.rule), ["css-import", "css-import"]);
  assert.equal(inspectUiSource("src/main.tsx", 'import "./styles.css?inline";')[0].rule, "css-import");
  assert.deepEqual(inspectUiSource("src/New.tsx", 'import "./data.json?raw";'), []);
});

test("skips test-only paths and comments, not production paths containing test", () => {
  for (const path of ["src/page.test.tsx", "src/page.spec.ts", "src/test/fixture.ts", "e2e/page.ts"]) {
    assert.deepEqual(inspectUiSource(path, '"p-[13px]"; node.querySelector("button")'), []);
  }
  assert.deepEqual(inspectUiSource("src/latest.tsx", '// "p-[13px]"\n/* color: #fff; */'), []);
  assert.equal(inspectUiSource("src/latest.tsx", 'node.querySelectorAll("button")').length, 1);
});

test("skips only precise CAD smoke and golden fixture suffixes", () => {
  const source = 'const color = "#123456"; node.querySelector("canvas");';
  for (const path of ["src/cad/scene.smoke.ts", "src/cad/scene-smoke.tsx", "src/cad/scene.golden.ts"]) {
    assert.deepEqual(inspectUiSource(path, source), [], path);
  }
  for (const path of [
    "src/cad/smoke.ts", "src/cad/golden.ts", "src/cad/scene-smoke.ts",
    "src/cad/scene.smoke.tsx", "src/cad/scene.golden.tsx", "src/cad/scene.golden.css",
    "src/cad/scene.smoke.ts.backup.ts", "src/cad/scene-smoke-helper.tsx", "src/cad/smoke/scene.ts"
  ]) {
    assert.ok(inspectUiSource(path, source).some(v => v.rule === "raw-color"), path);
  }
});

test("production imports cannot enter skipped CAD fixtures", () => {
  for (const specifier of [
    "./scene.smoke.ts", "./scene-smoke.tsx", "./scene.golden.ts",
    "./scene.smoke", "./scene-smoke", "./scene.golden",
    "./scene.smoke.ts?raw", "./scene-smoke.tsx#entry", "./scene.golden?raw",
    "/src/cad/scene.golden.ts", "../cad/scene-smoke"
  ]) {
    for (const source of [
      `import ${JSON.stringify(specifier)};`,
      `export * from ${JSON.stringify(specifier)};`,
      `import(${JSON.stringify(specifier)});`
    ]) {
      assert.ok(inspectUiSource("src/cad/production.ts", source).some(v => v.rule === "test-import" && v.match === specifier), source);
    }
  }
  assert.deepEqual(inspectUiSource("src/cad/production.ts", 'import "./scene-smoke-helper"; import "./golden";'), []);
});

test("workspace skips CAD fixtures without admitting their production HTML entries", async () => {
  const root = await mkdtemp(join(tmpdir(), "led-ui-cad-fixtures-"));
  const fixtures = ["scene.smoke.ts", "scene-smoke.tsx", "scene.golden.ts"];
  try {
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src/App.tsx"), 'import "./styles.css";');
    await writeFile(join(root, "src/styles.css"), canonicalStyles);
    for (const fixture of fixtures) {
      await writeFile(join(root, "src", fixture), 'import "./styles.css"; const color = "#123456";');
    }
    assert.deepEqual((await inspectWorkspace({ root })).violations, []);

    const entries = fixtures.flatMap(fixture => [`/src/${fixture}`, `/src/${fixture}?entry#fixture`]);
    await writeFile(join(root, "index.html"), entries.map(entry => `<script type="module" src="${entry}"></script>`).join("\n"));
    assert.deepEqual((await inspectWorkspace({ root })).violations.map(v => ({ rule: v.rule, match: v.match })), entries.map(match => ({ rule: "test-import", match })));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("M3 ignores trailing and JSX comments but preserves strings, templates and URLs", () => {
  assert.deepEqual(inspectUiSource("src/New.tsx", 'const x = 1; // old p-[13px]\nconst view = <div>{/* old gap-[13px] */}</div>;'), []);
  assert.deepEqual(inspectUiSource("src/New.tsx", 'const classes = `p-2 ${(() => { /* old p-[13px] */ return "gap-3"; })()}`;'), []);
  assert.deepEqual(inspectUiSource("src/New.tsx", 'const url = "https://host/p-[13px]"; const text = `/* gap-[15px] */`;').map(v => v.match), ["p-[13px]", "gap-[15px]"]);
  assert.deepEqual(inspectUiSource("src/New.tsx", 'const text = "a\\\"// p-[13px]"; const view = <div>// gap-[15px]</div>;').map(v => v.match), ["p-[13px]", "gap-[15px]"]);
  assert.deepEqual(inspectUiSource("src/styles/base.css", '/* p-[13px] */ body { background-image: url("https://host/example.png"); }'), []);
});

test("rejects TypeScript generic and optional-chain production DOM queries", () => {
  assert.deepEqual(inspectUiSource("src/Modal.tsx", 'ref.current?.querySelector<HTMLElement>(selector); dialog.querySelectorAll<HTMLButtonElement>(selector)').map(v => v.rule), ["query-selector", "query-selector"]);
});

test("M2 rejects optional DOM method calls including receiver and generic combinations", () => {
  const source = 'element.querySelector?.("button"); ref.current?.querySelectorAll?.<HTMLElement>("input")';
  const violations = inspectUiSource("src/New.tsx", source);
  assert.equal(violations.length, 2);
  assert.equal(violations[0].match, 'element.querySelector?.("button")');
  assert.equal(violations[1].match, 'ref.current?.querySelectorAll?.<HTMLElement>("input")');
});

test("rejects computed DOM query method calls", () => {
  const source = 'element["querySelector"]("button"); element[`querySelectorAll`]("input"); element["query" + "Selector"]("a"); element[("querySelector")]("button"); element[`query${"Selector"}`]("button")';
  assert.deepEqual(inspectUiSource("src/New.tsx", source).map(v => v.rule), Array(5).fill("query-selector"));
});

test("I4 fingerprints the receiver and complete selector call, independently of surrounding lines", () => {
  const path = "src/ConfirmDialog.tsx";
  const old = 'oldDialog.querySelectorAll<HTMLElement>("button")';
  const changed = 'document.querySelectorAll<HTMLElement>("input")';
  assert.notDeepEqual(inspectUiSource(path, old), inspectUiSource(path, changed));
  assert.deepEqual(inspectUiSource(path, old), inspectUiSource(path, 'const unrelated = 1;\n' + old + ';\nconst extra = 2;'));
  const nested = 'dialog.querySelector<HTMLElement>(`[data-id="${CSS.escape(id)}"]`)';
  assert.equal(inspectUiSource(path, nested)[0].match, nested);
});

test("I4 CLI rejects every production DOM query with a zero baseline", async () => {
  const root = await mkdtemp(join(tmpdir(), "led-ui-query-policy-"));
  const run = () => spawnSync(process.execPath, [new URL("./ui-policy.mjs", import.meta.url).pathname, "--root", root], { encoding: "utf8" });
  try {
    await mkdir(join(root, "src"));
    await mkdir(join(root, "src/components"));
    await mkdir(join(root, "scripts"));
    await writeFile(join(root, "src/App.tsx"), 'import "./styles.css";');
    await writeFile(join(root, "src/styles.css"), canonicalStyles);
    await writeFile(join(root, "scripts/ui-policy-baseline.json"), JSON.stringify({ version: 1, sourceRef: "7b2617b173618d376e7b3a90ec31e1392c3b7bc0", files: {} }));
    await writeFile(join(root, "src/components/ConfirmDialog.tsx"), 'dialogElement.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR);');
    assert.equal(run().status, 1);
    await writeFile(join(root, "src/components/ConfirmDialog.tsx"), 'const unused = 1;\ndialogElement.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR);');
    assert.equal(run().status, 1);
    await writeFile(join(root, "src/components/ConfirmDialog.tsx"), 'document.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR);');
    assert.equal(run().status, 1);
    await writeFile(join(root, "src/components/ConfirmDialog.tsx"), 'const clean = true;');
    assert.equal(run().status, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI inventories only production src and rejects any policy debt", async () => {
  const root = await mkdtemp(join(tmpdir(), "led-ui-policy-"));
  const cli = new URL("./ui-policy.mjs", import.meta.url);
  const run = () => spawnSync(process.execPath, [cli.pathname, "--root", root], { encoding: "utf8" });
  try {
    await mkdir(join(root, "src"));
    await mkdir(join(root, "scripts"));
    await writeFile(join(root, "src/App.tsx"), 'import "./styles.css";');
    await writeFile(join(root, "src/styles.css"), canonicalStyles);
    await writeFile(join(root, "src/ignored.test.tsx"), '"p-[15px]"');
    await writeFile(join(root, "scripts/ui-policy-baseline.json"), JSON.stringify({ version: 1, sourceRef: "7b2617b173618d376e7b3a90ec31e1392c3b7bc0", files: {} }));
    assert.equal(run().status, 0);
    await writeFile(join(root, "src/App.tsx"), 'import "./new.css";');
    assert.equal(run().status, 1);
    await writeFile(join(root, "src/App.tsx"), 'import "./styles.css"; "gap-3"');
    assert.equal(run().status, 0);
    await writeFile(join(root, "src/new.tsx"), '"p-[15px]"');
    assert.equal(run().status, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("workspace closes skipped-module, entry HTML and public CSS scan gaps", async () => {
  const root = await mkdtemp(join(tmpdir(), "led-ui-graph-policy-"));
  try {
    await mkdir(join(root, "src"));
    await mkdir(join(root, "public"));
    await writeFile(join(root, "src/App.tsx"), 'import "./styles.css"; import "./hidden.test"; import "./hidden.spec?raw";');
    await writeFile(join(root, "src/styles.css"), canonicalStyles);
    await writeFile(join(root, "index.html"), '<link rel="stylesheet" href="/rogue.css"><link rel=stylesheet href=/theme><script type="module" src="/e2e/page.ts"></script>');
    await writeFile(join(root, "public/rogue.css"), 'body {}');

    const result = await inspectWorkspace({ root, baseline: {} });
    assert.ok(result.violations.some(v => v.rule === "test-import" && v.match === "./hidden.test"));
    assert.ok(result.violations.some(v => v.rule === "test-import" && v.match === "./hidden.spec?raw"));
    assert.ok(result.violations.some(v => v.rule === "test-import" && v.match === "/e2e/page.ts"));
    assert.ok(result.violations.some(v => v.rule === "html-css-entry" && v.match === "/rogue.css"));
    assert.ok(result.violations.some(v => v.rule === "html-css-entry" && v.match === "/theme"));
    assert.ok(result.violations.some(v => v.rule === "public-css" && v.path === "public/rogue.css"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("workspace requires every canonical CSS import exactly once", async () => {
  const root = await mkdtemp(join(tmpdir(), "led-ui-css-inventory-"));
  const canonical = canonicalStyles;
  try {
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src/App.tsx"), 'import "./styles.css";');
    await writeFile(join(root, "src/styles.css"), canonical);
    assert.deepEqual((await inspectWorkspace({ root, baseline: {} })).violations, []);

    await writeFile(join(root, "src/styles.css"), canonical.replace('@import "./styles/base.css";', ""));
    assert.ok((await inspectWorkspace({ root, baseline: {} })).violations.some(v => v.rule === "missing-css-import" && v.match === "./styles/base.css"));

    await writeFile(join(root, "src/styles.css"), `${canonical}\n@import "tailwindcss";`);
    assert.ok((await inspectWorkspace({ root, baseline: {} })).violations.some(v => v.rule === "duplicate-css-import" && v.match === "tailwindcss"));

    await writeFile(join(root, "src/styles.css"), `/* ${canonical} */`);
    assert.ok((await inspectWorkspace({ root, baseline: {} })).violations.some(v => v.rule === "missing-css-import"));

    await writeFile(join(root, "src/styles.css"), canonical.replace('@import "tailwindcss";', '@import "tailwindcss" print;'));
    const modified = await inspectWorkspace({ root, baseline: {} });
    assert.ok(modified.violations.some(v => v.rule === "missing-css-import" && v.match === "tailwindcss"));
    assert.ok(modified.violations.some(v => v.rule === "css-import" && v.match === "tailwindcss"));

    await writeFile(join(root, "src/styles.css"), canonical);
    await writeFile(join(root, "src/App.tsx"), 'import "./styles.css"; import "./styles.css";');
    assert.ok((await inspectWorkspace({ root, baseline: {} })).violations.some(v => v.rule === "duplicate-css-entry"));

    await writeFile(join(root, "src/App.tsx"), 'import "./styles.css";');
    await writeFile(join(root, "src/main.tsx"), 'import "./styles.css";');
    assert.ok((await inspectWorkspace({ root, baseline: {} })).violations.some(v => v.rule === "duplicate-css-entry"));

    await writeFile(join(root, "src/App.tsx"), "const clean = true;");
    await writeFile(join(root, "src/main.tsx"), "const clean = true;");
    assert.ok((await inspectWorkspace({ root, baseline: {} })).violations.some(v => v.rule === "missing-css-entry"));

    await writeFile(join(root, "src/only.test.ts"), 'import "./styles.css";');
    assert.ok((await inspectWorkspace({ root, baseline: {} })).violations.some(v => v.rule === "missing-css-entry"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("workspace rejects extensionless bare imports only when package metadata exposes CSS", async () => {
  const root = await mkdtemp(join(tmpdir(), "led-ui-package-css-"));
  const canonical = canonicalStyles;
  try {
    await mkdir(join(root, "src"));
    await mkdir(join(root, "node_modules/@vendor/theme"), { recursive: true });
    await mkdir(join(root, "node_modules/@vendor/runtime"), { recursive: true });
    await writeFile(join(root, "src/App.tsx"), 'import "./styles.css"; import "@vendor/theme"; import "@vendor/theme/tokens"; import "@vendor/runtime";');
    await writeFile(join(root, "src/styles.css"), canonical);
    await writeFile(join(root, "node_modules/@vendor/theme/package.json"), JSON.stringify({
      name: "@vendor/theme",
      style: "./index.css",
      exports: { ".": { style: "./index.css", import: "./index.js" }, "./tokens": "./tokens.css" }
    }));
    await writeFile(join(root, "node_modules/@vendor/runtime/package.json"), JSON.stringify({
      name: "@vendor/runtime",
      exports: { ".": { import: "./index.js", types: "./index.d.ts" } }
    }));

    const result = await inspectWorkspace({ root, baseline: {} });
    assert.deepEqual(
      result.violations.filter(v => v.rule === "css-import").map(v => v.match),
      ["@vendor/theme", "@vendor/theme/tokens"]
    );
    assert.ok(!result.violations.some(v => v.match === "@vendor/runtime"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("workspace resolves overlapping package export patterns by Node specificity, not declaration order", async () => {
  const root = await mkdtemp(join(tmpdir(), "led-ui-package-pattern-"));
  const canonical = canonicalStyles;
  try {
    await mkdir(join(root, "src"));
    await mkdir(join(root, "node_modules/@vendor/patterns"), { recursive: true });
    await mkdir(join(root, "node_modules/@vendor/reversed"), { recursive: true });
    await writeFile(join(root, "src/App.tsx"), [
      'import "./styles.css";',
      'import "@vendor/patterns/features/theme/tokens";',
      'import "@vendor/patterns/features/runtime/client";',
      'import "@vendor/patterns/icons/button.theme";',
      'import "@vendor/reversed/features/theme/tokens";'
    ].join(" "));
    await writeFile(join(root, "src/styles.css"), canonical);
    await writeFile(join(root, "node_modules/@vendor/patterns/package.json"), JSON.stringify({
      name: "@vendor/patterns",
      exports: {
        "./features/*": "./runtime/*.js",
        "./features/theme/*": "./theme/*.css",
        "./features/runtime/*": "./runtime/*.js",
        "./icons/*": "./runtime/*.js",
        "./icons/*.theme": "./themes/*.css"
      }
    }));
    await writeFile(join(root, "node_modules/@vendor/reversed/package.json"), JSON.stringify({
      name: "@vendor/reversed",
      exports: {
        "./features/theme/*": "./theme/*.css",
        "./features/*": "./runtime/*.js"
      }
    }));

    const result = await inspectWorkspace({ root, baseline: {} });
    assert.deepEqual(
      result.violations.filter(v => v.rule === "css-import").map(v => v.match),
      [
        "@vendor/patterns/features/theme/tokens",
        "@vendor/patterns/icons/button.theme",
        "@vendor/reversed/features/theme/tokens"
      ]
    );
    assert.ok(!result.violations.some(v => v.match === "@vendor/patterns/features/runtime/client"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("baseline must preserve the approved Git anchor and an empty violation map", async () => {
  const root = await mkdtemp(join(tmpdir(), "led-ui-baseline-integrity-"));
  const run = () => spawnSync(process.execPath, [new URL("./ui-policy.mjs", import.meta.url).pathname, "--root", root], { encoding: "utf8" });
  try {
    await mkdir(join(root, "src"));
    await mkdir(join(root, "scripts"));
    await writeFile(join(root, "scripts/ui-policy-baseline.json"), JSON.stringify({ version: 1, sourceRef: "0000000000000000000000000000000000000000", files: {} }));
    assert.equal(run().status, 1, "an edited sourceRef must fail even without current violations");
    await writeFile(join(root, "src/App.tsx"), 'const clean = true;');
    await writeFile(join(root, "scripts/ui-policy-baseline.json"), JSON.stringify({ version: 1, sourceRef: "7b2617b173618d376e7b3a90ec31e1392c3b7bc0", files: { "src/App.tsx": { "css-import": { count: 2, matches: { "./styles.css": 2 } } } } }));
    assert.equal(run().status, 1, "non-empty debt allowances must fail even with clean source");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

let compiledPolicyCss;
async function compilePolicyCss() {
  if (compiledPolicyCss) return compiledPolicyCss;
  compiledPolicyCss = (async () => {
    const { build } = await import("vite");
    const result = await build({
      root: fileURLToPath(new URL("../", import.meta.url)),
      logLevel: "warn",
      build: { write: false },
      plugins: [{
        name: "ui-policy-compile-proof",
        enforce: "pre",
        async load(id) {
          if (id.endsWith("/src/styles.css")) return await readFile(id, "utf8") + '\n@source inline("p-0.5 p-16 bg-surface-panel text-content-primary text-body max-compact:p-4 phone-wide:grid-cols-4 max-phone-wide:order-1 landing-narrow:block landing-stack:block landing-wide:block p-landing-demo-disclaimer-inset m-landing-hero-heading-margin gap-landing-header-frame-stacked-gap py-landing-hero-frame-block-inset text-landing-hero-fluid landing-stack:text-landing-hero-fluid-stacked landing-narrow:text-landing-hero-fluid-narrow leading-landing-concept-document font-landing");';
        }
      }]
    });
    return result.output.filter(item => item.type === "asset" && item.fileName.endsWith(".css")).map(item => item.source).join("\n");
  })();
  return compiledPolicyCss;
}

test("real Vite build emits semantic and reviewed responsive CSS without fixture pollution", async () => {
  const css = await compilePolicyCss();
  for (const declaration of [
    '.p-0\\.5{padding:calc(var(--spacing) * .5)}',
    '.p-16{padding:calc(var(--spacing) * 16)}',
    '.bg-surface-panel{background-color:var(--color-surface-panel)}',
    '.text-content-primary{color:var(--color-content-primary)}',
    '.text-body{font-size:var(--text-body);line-height:var(--tw-leading,var(--text-body--line-height))}'
  ]) assert.ok(css.includes(declaration), declaration);
  const compactMedia = css.match(/@media not all and \(min-width:47\.5rem\)\{(?:[^{}]*\{[^{}]*\})+\}/)?.[0];
  assert.ok(compactMedia?.includes('.max-compact\\:p-4{padding:calc(var(--spacing) * 4)}'));
  assert.ok(css.includes('.phone-wide\\:grid-cols-4{'), "phone-wide min-width CSS");
  assert.ok(css.includes('.max-phone-wide\\:order-1{'), "phone-wide max-width CSS");
  assert.ok(!css.includes('.p-9{') && !css.includes('.max-compact\\:px-0\\.75{'));
});

test("approved landing policy rejects mutated variant or anchor", async () => {
  const theme = await readFile(new URL("../src/styles/theme.css", import.meta.url), "utf8");
  assert.deepEqual(inspectUiSource("src/styles/theme.css", theme), [], "approved immutable theme");
  for (const source of [
    theme.replace("--text-landing-hero-fluid: clamp(55px, 5.3vw, 78px);", "--text-landing-hero-fluid: 1rem;"),
    theme.replace(/--text-landing-hero-fluid:[^;]+;/, ""),
    theme.replace("--text-landing-hero-fluid: clamp(55px, 5.3vw, 78px);", "--text-landing-hero-fluid: clamp(55px, 5.3vw, 78px); --text-landing-hero-fluid: clamp(55px, 5.3vw, 78px);")
  ]) assert.ok(inspectUiSource("src/styles/theme.css", source).length);
  assert.deepEqual(inspectUiSource("src/New.tsx", '"landing-narrow:block landing-stack:block landing-wide:block"'), []);
  assert.ok(inspectUiSource("src/New.tsx", '"max-[777px]:block"').some(v => v.rule === "unapproved-breakpoint"));
  assert.ok(inspectUiSource("src/New.tsx", '"landing-extra:block"').some(v => v.rule === "unapproved-breakpoint"));
  for (const source of [
    ...[430, 720, 1050].map(width => approvedLandingVariants.replace(`${width}px`, `${width + 1}px`)),
    approvedLandingVariants + "\n@custom-variant landing-extra (@media (max-width: 777px));",
    approvedLandingVariants + "\n@custom-variant landing-narrow (@media (max-width: 430px));",
    approvedLandingVariants.replace("(@media (max-width: 430px))", "(&:hover)"),
    approvedLandingVariants.replace("max-width", "max - width"),
    approvedLandingVariants.replace("landing-narrow (", "landing-narrow(")
  ]) assert.ok(inspectUiSource("src/styles.css", source).some(v => v.rule === "unapproved-custom-variant"), source);
  assert.ok(inspectUiSource("src/styles/base.css", approvedLandingVariants).some(v => v.rule === "unapproved-custom-variant"));
  const root = await mkdtemp(join(tmpdir(), "led-ui-landing-anchor-"));
  const canonical = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");
  const run = () => spawnSync(process.execPath, [new URL("./ui-policy.mjs", import.meta.url).pathname, "--root", root], { encoding: "utf8" });
  try {
    await mkdir(join(root, "src"));
    await mkdir(join(root, "scripts"));
    await writeFile(join(root, "src/App.tsx"), 'import "./styles.css";');
    await writeFile(join(root, "src/styles.css"), canonical);
    await writeFile(join(root, "scripts/ui-policy-baseline.json"), JSON.stringify({ version: 1, sourceRef: "7b2617b173618d376e7b3a90ec31e1392c3b7bc0", files: {} }));
    assert.equal(run().status, 0, "reviewed immutable ref and empty baseline");
    for (const width of [430, 720, 1050]) {
      await writeFile(join(root, "src/styles.css"), canonical.replace(new RegExp(`@custom-variant [^;]+${width}px[^;]+;`), ""));
      assert.ok((await inspectWorkspace({ root })).violations.some(v => v.rule === "missing-custom-variant"), `${width}px missing`);
    }
    await writeFile(join(root, "src/styles.css"), canonical);
    await writeFile(join(root, "scripts/ui-policy-baseline.json"), JSON.stringify({ version: 1, sourceRef: "24b5ea593e860575f7bf1007781146cf1101beb7", files: {} }));
    const stale = run();
    assert.equal(stale.status, 1);
    assert.match(stale.stderr, /sourceRef is not the reviewed Git commit/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("approved landing variants compile at inclusive boundaries", async () => {
  const css = await compilePolicyCss();
  for (const [variant, width] of [["landing-narrow", 430], ["landing-stack", 720], ["landing-wide", 1050]]) {
    const media = css.match(new RegExp(`@media\\s*\\(max-width:${width}px\\)\\{(?:[^{}]*\\{[^{}]*\\})+\\}`))?.[0];
    assert.ok(media?.includes(`.${variant}\\:block{display:block}`), `${variant} has exact inclusive max-width:${width}px`);
  }
  for (const declaration of [
    '.p-landing-demo-disclaimer-inset{padding:var(--spacing-landing-demo-disclaimer-inset)}',
    '.m-landing-hero-heading-margin{margin:var(--spacing-landing-hero-heading-margin)}',
    '.gap-landing-header-frame-stacked-gap{gap:var(--spacing-landing-header-frame-stacked-gap)}',
    '.py-landing-hero-frame-block-inset{padding-block:var(--spacing-landing-hero-frame-block-inset)}',
    '.landing-stack\\:text-landing-hero-fluid-stacked{font-size:var(--text-landing-hero-fluid-stacked)}',
    '.landing-narrow\\:text-landing-hero-fluid-narrow{font-size:var(--text-landing-hero-fluid-narrow)}',
    '.leading-landing-concept-document{--tw-leading:var(--leading-landing-concept-document);line-height:var(--leading-landing-concept-document)}',
    '.font-landing{font-family:var(--font-landing)}',
    '--font-landing:Inter, "Pretendard", "Noto Sans KR", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    '--leading-landing-concept-document:normal'
  ]) assert.ok(css.includes(declaration), declaration);
  const { chromium } = await import("@playwright/test");
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent('<iframe></iframe>');
    const evidence = await page.evaluate(async css => {
      const frame = document.querySelector("iframe");
      frame.contentDocument.head.innerHTML = `<style>${css}</style>`;
      frame.contentDocument.body.innerHTML = '<div id="spacing" class="p-landing-demo-disclaimer-inset m-landing-hero-heading-margin gap-landing-header-frame-stacked-gap"></div><div id="block" class="py-landing-hero-frame-block-inset"></div><h1 id="type" class="text-landing-hero-fluid landing-stack:text-landing-hero-fluid-stacked landing-narrow:text-landing-hero-fluid-narrow"></h1><div id="document" class="font-landing leading-landing-concept-document"></div>';
      // Chromium serializes BlinkMacSystemFont as system-ui on some platforms;
      // compare the computed family to the same original CSS declaration.
      const reference = frame.contentDocument.createElement("div");
      reference.style.fontFamily = 'Inter, "Pretendard", "Noto Sans KR", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
      frame.contentDocument.body.append(reference);
      const values = [];
      for (const width of [429, 430, 430.5, 431, 719, 720, 720.5, 721, 1049, 1050, 1050.5, 1051]) {
        frame.style.width = `${width}px`;
        await new Promise(resolve => requestAnimationFrame(resolve));
        const style = frame.contentWindow.getComputedStyle(frame.contentDocument.getElementById("type"));
        values.push({ width, matches: [430, 720, 1050].map(boundary => frame.contentWindow.matchMedia(`(max-width: ${boundary}px)`).matches), lineHeight: parseFloat(style.lineHeight) / parseFloat(style.fontSize), tracking: parseFloat(style.letterSpacing) / parseFloat(style.fontSize) });
      }
      const read = (id, properties) => {
        const style = frame.contentWindow.getComputedStyle(frame.contentDocument.getElementById(id));
        return properties.map(property => style[property]);
      };
      return { referenceFamily: frame.contentWindow.getComputedStyle(reference).fontFamily, values, spacing: read("spacing", ["paddingTop", "paddingRight", "paddingBottom", "paddingLeft", "marginTop", "marginRight", "marginBottom", "marginLeft", "rowGap", "columnGap"]), block: read("block", ["paddingTop", "paddingRight", "paddingBottom", "paddingLeft"]), document: read("document", ["fontFamily", "lineHeight"]) };
    }, css);
    assert.deepEqual(evidence.spacing, ["11px", "22px", "11px", "22px", "22px", "0px", "26px", "0px", "5px", "20px"]);
    assert.deepEqual(evidence.block, ["150px", "0px", "130px", "0px"]);
    assert.deepEqual(evidence.document, [evidence.referenceFamily, "normal"]);
    for (const value of evidence.values) {
      assert.deepEqual(value.matches, [value.width <= 430, value.width <= 720, value.width <= 1050], `${value.width}px inclusion`);
      assert.ok(Math.abs(value.lineHeight - 1.15) < 0.001, `${value.width}px retains line-height`);
      assert.ok(Math.abs(value.tracking + 0.085) < 0.001, `${value.width}px retains letter-spacing`);
    }
  } finally {
    await browser.close();
  }
});
