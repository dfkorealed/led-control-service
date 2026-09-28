import { cn } from "../../../components/ui/utils/cn";
import { Card } from "../../../components/ui/Card";

const features = [
  {
    id: "monitoring", number: "01", title: "모니터링", lead: "찾는 조명과 상태를 같은 도면에서.", description: "층과 구역을 열어 조명 위치, 연결 상태, 최근 확인 상태를 함께 살펴보세요.", benefit: "현장과 목록을 오가며 대상을 찾는 수고를 줄입니다.",
    detailTitle: "현장을 열면 조명 위치부터 보입니다.", problem: "현장 규모가 커질수록 조명 이름만으로는 대상을 찾기 어렵습니다. 킨다는 도면 위 위치와 상태를 이어서 보여줍니다.",
    steps: ["현장의 층과 구역을 선택합니다.", "도면에서 확인할 조명의 위치를 찾습니다.", "선택한 조명의 연결 상태와 최근 확인 상태를 살펴봅니다."], outcome: "위치와 상태를 한 화면에서 확인해 대상을 찾는 수고를 줄입니다."
  },
  {
    id: "control", number: "02", title: "제어", lead: "대상에 맞춰 밝기와 시간을 조정.", description: "개별 조명이나 그룹의 점등과 밝기를 조정하고 반복되는 운영은 일정으로 정리하세요.", benefit: "상황에 맞는 운영 기준을 한곳에서 관리합니다.",
    detailTitle: "필요한 조명만, 필요한 만큼 조정합니다.", problem: "구역과 시간에 따라 필요한 밝기가 달라집니다. 대상과 실행 시간을 나누어 조명 운영을 정리할 수 있습니다.",
    steps: ["개별 조명이나 그룹을 선택합니다.", "점등과 밝기를 조정하고 처리 결과를 확인합니다.", "반복되는 운영은 일정으로 등록해 관리합니다."], outcome: "조정 대상과 시간을 명확히 하여 현장 운영 기준을 세웁니다."
  },
  {
    id: "statistics", number: "03", title: "통계", lead: "운영 기록을 판단의 근거로.", description: "기간별 상태 기반 추정 전력을 그래프로 비교하고 PDF 보고서로 정리하세요.", benefit: "변화의 흐름을 읽고 공유할 자료를 준비합니다.",
    detailTitle: "그래프에서 흐름을 읽고 보고서로 남깁니다.", problem: "조명 운영 기록을 숫자만으로 읽기는 어렵습니다. 기간별 추이를 보고 필요한 자료를 같은 흐름에서 준비하세요.",
    steps: ["기간과 현장 범위를 선택합니다.", "상태 기반 추정 전력의 그래프와 변화를 비교합니다.", "PDF 보고서를 요청하고 생성 이력에서 확인합니다."], outcome: "운영 흐름을 비교하고 공유할 자료를 한곳에서 준비합니다. 추정치는 실측 전력이나 절감 보장을 뜻하지 않습니다."
  },
  {
    id: "map-editor", number: "04", title: "맵 편집", lead: "도면 위 배치를 직접 확인하며 설정.", description: "CAD 도면을 검토하고 도형과 조명의 위치를 화면에서 조정한 뒤 저장하세요.", benefit: "현장 구조에 맞게 배치를 검토하고 수정합니다.",
    detailTitle: "도면과 조명을 현장에 맞춰 배치합니다.", problem: "현장 구조가 바뀌면 도면과 조명 위치도 다시 맞춰야 합니다. 운영자가 화면에서 배치를 확인하며 설정할 수 있습니다.",
    steps: ["CAD 도면의 후보를 검토합니다.", "도형과 조명 위치를 화면에서 조정합니다.", "운영자가 배치를 확인한 뒤 저장합니다."], outcome: "자동 등록에 맡기지 않고 현장 배치를 검토하며 수정합니다."
  }
] as const;

// Preserve the original decoration DOM: expanded previews change dimensions,
// while the same nodes and pseudo element continue to draw each example.
function FeaturePreview({ kind, expanded = false }: { kind: (typeof features)[number]["id"]; expanded?: boolean }) {
  const dot = cn("absolute size-[10px] rounded-landing-ellipse border-2 border-brand-blue bg-surface-panel", expanded && "size-[17px] border-4");
  const canvas = cn("absolute inset-landing-preview-canvas-position-inset", expanded && "inset-landing-preview-canvas-expanded-position-inset landing-wide:landing-stack:landing-narrow:inset-landing-preview-canvas-expanded-narrow-position-inset");
  return <div className={cn(`feature-preview feature-preview--${kind} relative overflow-hidden border border-border-default rounded-landing-glass-panel bg-surface-inset shadow-landing-preview-window w-[172px] h-[172px] landing-wide:size-[130px] landing-wide:landing-stack:size-[145px] landing-wide:landing-stack:landing-narrow:w-[100px] landing-wide:landing-stack:landing-narrow:h-[118px] landing-wide:landing-stack:landing-narrow:shadow-landing-preview-window-narrow`, expanded && "w-[min(100%,450px)] h-[330px] rounded-landing-preview-window-expanded shadow-landing-preview-window-expanded landing-wide:w-[min(100%,450px)] landing-wide:h-[330px] landing-wide:landing-stack:w-[min(100%,450px)] landing-wide:landing-stack:h-[270px] landing-wide:landing-stack:landing-narrow:w-[min(100%,450px)] landing-wide:landing-stack:landing-narrow:h-[220px] landing-wide:landing-stack:landing-narrow:rounded-landing-preview-window-expanded-narrow landing-wide:landing-stack:landing-narrow:shadow-landing-preview-window-expanded")} aria-hidden="true">
    <div className={cn("feature-preview__header flex gap-1 items-center h-[27px] px-3 border-b border-border-default bg-surface-panel", expanded && "h-[42px] px-landing-preview-toolbar-expanded-inline-inset")}>
      {[0, 1, 2].map(index => <span key={index} className={cn("size-[5px] rounded-landing-ellipse", index === 0 ? "bg-brand-coral" : "bg-border-default", expanded && "size-[7px]")} />)}
    </div>
    {kind === "monitoring" && <div className={`${canvas} feature-preview__map border border-border-default rounded-landing-inset-surface bg-landing-preview-map-grid`}>
      {["left-20/100 top-22/100", "left-46/100 top-20/100", "left-74/100 top-24/100", "left-23/100 top-68/100", "left-52/100 top-68/100 bg-brand-coral", "left-77/100 top-68/100"].map(position => <span key={position} className={cn(dot, position)} />)}
    </div>}
    {kind === "control" && <div className={cn("feature-preview__control p-landing-preview-control-inset", expanded && "p-landing-preview-control-expanded-inset landing-wide:landing-stack:landing-narrow:p-landing-preview-control-expanded-narrow-inset")}>
      <span className={cn("block w-[58px] h-[8px] rounded-landing-preview-label-bar bg-border-default", expanded && "w-[150px] h-[13px]")} />
      <div className={cn("relative h-[6px] mt-landing-preview-slider-top-space rounded-landing-preview-detail bg-border-default before:content-[''] before:absolute before:top-0 before:bottom-0 before:left-0 before:right-32/100 before:rounded-landing-preview-detail before:bg-brand-blue", expanded && "h-[11px] mt-landing-preview-slider-expanded-top-space landing-wide:landing-stack:landing-narrow:mt-landing-preview-slider-expanded-narrow-top-space")}><i className={cn("absolute left-68/100 top-1/2 size-[17px] border-4 border-surface-panel rounded-landing-ellipse bg-brand-blue ring-1 ring-brand-blue transform-[translate(-50%,-50%)]", expanded && "size-[28px]")} /></div>
      <small className={cn("block mt-landing-preview-value-top-space text-brand-blue font-[850] text-right", expanded && "text-landing-preview-control-value-expanded")}>68%</small>
      <div className={cn("feature-preview__schedule flex justify-between gap-landing-preview-schedule-gap mt-landing-preview-schedule-top-space", expanded && "mt-landing-preview-schedule-expanded-top-space landing-wide:landing-stack:landing-narrow:mt-landing-preview-schedule-expanded-narrow-top-space")}>
        {[0, 1, 2].map(index => <b key={index} className={cn("w-[45px] h-[23px] rounded-landing-preview-detail", index === 1 ? "bg-brand-blue" : "bg-action-primary-soft", expanded && "w-[80px] h-[39px]")} />)}
      </div>
    </div>}
    {kind === "statistics" && <><div className={cn("feature-preview__chart flex items-end gap-landing-preview-chart-gap h-[115px] m-landing-preview-chart-margin p-landing-preview-chart-inset border-b border-border-default", expanded && "h-[225px] m-landing-preview-chart-expanded-margin gap-landing-preview-chart-expanded-gap landing-wide:landing-stack:landing-narrow:h-[145px] landing-wide:landing-stack:landing-narrow:m-landing-preview-chart-expanded-narrow-margin landing-wide:landing-stack:landing-narrow:gap-1.5")}>
      {["h-[38%] bg-action-primary-soft", "h-[59%] bg-action-primary-soft", "h-[48%] bg-action-primary-soft", "h-[77%] bg-brand-blue", "h-[65%] bg-action-primary-soft", "h-[88%] bg-brand-coral"].map(bar => <span key={bar} className={`flex-1 rounded-landing-preview-chart-bar ${bar}`} />)}
    </div><div className="feature-preview__report absolute right-8/100 bottom-8/100 w-[39%] h-[42%] p-landing-preview-report-inset border border-border-default rounded-landing-inset-surface bg-surface-panel shadow-landing-preview-report"><i className="block h-1 mb-1.5 rounded-fixture-marker w-[70%] bg-brand-blue" /><i className="block h-1 mb-1.5 rounded-fixture-marker bg-border-default" /><i className="block h-1 mb-1.5 rounded-fixture-marker w-[55%] bg-border-default" /></div></>}
    {kind === "map-editor" && <div className={`${canvas} feature-preview__editor bg-landing-preview-editor-grid bg-size-[17px_17px]`}><span className="absolute border-2 border-border-default bg-brand-paper left-7/100 top-15/100 w-[58%] h-[63%]" /><span className="absolute border-2 border-border-default bg-action-primary-soft left-56/100 top-35/100 w-[34%] h-[43%]" /><i className={`${dot} left-25/100 top-34/100`} /><i className={`${dot} left-43/100 top-61/100`} /><i className={cn(dot, "left-73/100 top-1/2 bg-brand-coral")} /></div>}
  </div>;
}

// Original headings inherit weight400 from the document after Tailwind preflight;
// the original scoped rules changed their size and leading, not their weight.
const container = "mx-auto w-[min(1180px,calc(100%-72px))] phone-wide:max-w-[360px] compact:max-w-[760px] tablet:max-w-[1024px] landing-wide:landing-stack:w-[calc(100%-38px)] landing-wide:landing-stack:landing-narrow:w-[calc(100%-30px)]";
const number = "feature-card__number text-brand-blue text-landing-feature-card-number font-[850]";

export function FeatureOverview() {
  return <><section className="feature-overview flex items-center min-h-svh py-landing-section-frame-block-inset bg-brand-paper scroll-mt-landing-anchor-anchor-offset landing-wide:landing-stack:landing-narrow:py-landing-section-frame-block-inset-narrow" id="features" aria-labelledby="features-title">
    <div className={container}>
      <div className="section-intro max-w-[670px] mb-12"><p className="m-0 text-brand-blue text-landing-eyebrow font-[850] uppercase">KINDA / FEATURES</p><h1 id="features-title" className="scroll-mt-landing-anchor-anchor-offset mt-4 mb-4.5 text-landing-section-heading landing-wide:landing-stack:landing-narrow:text-landing-section-heading-narrow">현장 운영에 필요한<br />네 가지 흐름</h1><p className="m-0 text-status-neutral-foreground text-landing-section-description landing-wide:landing-stack:landing-narrow:text-landing-narrative-copy-narrow">도면에서 찾고, 조정하고, 기록을 확인하는 과정을 한 서비스에서 이어갑니다.</p></div>
      <div className="feature-grid grid grid-cols-2 gap-4.5 landing-wide:landing-stack:grid-cols-1">{features.map(feature => <Card key={feature.id} role="article" aria-label={feature.title} variant="landingFeature" className="feature-card">
        <div className="feature-card__copy min-w-0"><span className={number}>{feature.number} / {feature.title}</span><h2 className="m-landing-feature-card-heading-margin text-landing-feature-card-heading landing-wide:landing-stack:landing-narrow:text-landing-feature-card-heading-narrow">{feature.lead}</h2><p className="m-0 text-content-secondary text-landing-feature-card-body landing-wide:landing-stack:landing-narrow:text-landing-feature-card-copy-narrow">{feature.description}</p><strong className="block mt-3 text-landing-feature-card-outcome font-bold landing-wide:landing-stack:landing-narrow:text-landing-feature-card-copy-narrow">{feature.benefit}</strong><a className="inline-flex gap-2.5 items-center mt-landing-feature-card-link-top-space text-brand-blue text-landing-feature-card-link font-[850] no-underline hover:underline hover:underline-offset-4 landing-wide:landing-stack:landing-narrow:mt-landing-feature-card-link-narrow-top-space landing-wide:landing-stack:landing-narrow:text-landing-compact-action" href={`#feature-${feature.id}`} aria-label={`${feature.title} 자세히 보기`}>자세히 보기 <span aria-hidden="true">↓</span></a></div>
        <FeaturePreview kind={feature.id} />
      </Card>)}</div>
      <p className="feature-overview__note mt-6 mb-0 text-status-neutral-foreground text-landing-feature-supporting-note">화면은 기능 이해를 위한 예시이며 실제 현장 데이터나 조명 제어 결과가 아닙니다.</p>
    </div>
  </section>
  {features.map(feature => <section key={feature.id} className={`feature-detail feature-detail--${feature.id} flex items-center min-h-svh py-landing-feature-detail-block-inset bg-surface-panel odd:bg-brand-paper scroll-mt-landing-anchor-anchor-offset landing-wide:landing-stack:py-landing-feature-detail-stacked-block-inset`} id={`feature-${feature.id}`} aria-labelledby={`feature-${feature.id}-title`}>
    <div className={`${container} feature-detail__layout grid grid-cols-[minmax(0,1fr)_minmax(0,.95fr)] items-center gap-landing-feature-frame-gap landing-wide:grid-cols-1 landing-wide:gap-landing-feature-frame-medium-gap`}>
      <div className="feature-detail__copy min-w-0"><span className={number}>{feature.number} / {feature.title}</span><h2 id={`feature-${feature.id}-title`} className="scroll-mt-landing-anchor-anchor-offset max-w-[620px] m-landing-feature-detail-heading-margin text-landing-feature-detail-heading landing-wide:landing-stack:text-landing-feature-detail-heading-stacked landing-wide:landing-stack:landing-narrow:text-landing-feature-detail-heading-narrow">{feature.detailTitle}</h2><p className="max-w-[550px] m-0 text-status-neutral-foreground text-landing-feature-detail-description landing-wide:landing-stack:landing-narrow:text-landing-feature-detail-copy-narrow">{feature.problem}</p>
        <ol className="grid gap-4.5 m-landing-feature-steps-margin p-0 list-none [counter-reset:feature-step]">{feature.steps.map(step => <li key={step} className="flex items-baseline gap-3.5 text-landing-feature-detail-step [counter-increment:feature-step] before:content-[counter(feature-step,decimal-leading-zero)] before:flex-none before:text-brand-blue before:text-landing-feature-detail-step-number before:font-[850] landing-wide:landing-stack:landing-narrow:text-landing-feature-detail-copy-narrow">{step}</li>)}</ol>
        <p className="feature-detail__outcome max-w-[560px] m-0 p-landing-feature-detail-outcome-inset border-l-3 border-brand-coral text-brand-navy text-landing-feature-detail-outcome font-[760]">{feature.outcome}</p>
        <a className="inline-flex gap-landing-feature-detail-link-gap mt-landing-feature-detail-link-top-space text-brand-blue text-landing-action font-[850] no-underline hover:underline hover:underline-offset-4" href={`/#${feature.id}`}>현장의 하루에서 보기 <span aria-hidden="true">↗</span></a>
      </div>
      <div className="feature-detail__preview grid place-items-center min-w-0 min-h-[440px] p-landing-preview-stage-inset rounded-landing-preview-stage bg-action-primary-soft landing-wide:w-[min(100%,700px)] landing-wide:mx-auto landing-wide:landing-stack:min-h-[360px] landing-wide:landing-stack:p-landing-preview-stage-stacked-inset landing-wide:landing-stack:landing-narrow:min-h-[310px] landing-wide:landing-stack:landing-narrow:p-5 landing-wide:landing-stack:landing-narrow:rounded-landing-preview-stage-narrow" aria-hidden="true"><FeaturePreview kind={feature.id} expanded /><span className="mt-5 text-status-neutral-foreground text-landing-feature-supporting-note">기능 이해를 위한 예시 화면</span></div>
    </div>
  </section>)}
  </>;
}
