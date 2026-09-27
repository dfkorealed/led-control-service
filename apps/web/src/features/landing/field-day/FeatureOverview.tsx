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
    id: "statistics", number: "03", title: "통계", lead: "운영 기록을 판단의 근거로.", description: "기간별 상태 기반 추정 전력을 그래프로 비교하고 PDF·XLSX 보고서로 정리하세요.", benefit: "변화의 흐름을 읽고 공유할 자료를 준비합니다.",
    detailTitle: "그래프에서 흐름을 읽고 보고서로 남깁니다.", problem: "조명 운영 기록을 숫자만으로 읽기는 어렵습니다. 기간별 추이를 보고 필요한 자료를 같은 흐름에서 준비하세요.",
    steps: ["기간과 현장 범위를 선택합니다.", "상태 기반 추정 전력의 그래프와 변화를 비교합니다.", "PDF·XLSX 보고서를 요청하고 생성 이력에서 확인합니다."], outcome: "운영 흐름을 비교하고 공유할 자료를 한곳에서 준비합니다. 추정치는 실측 전력이나 절감 보장을 뜻하지 않습니다."
  },
  {
    id: "map-editor", number: "04", title: "맵 편집", lead: "도면 위 배치를 직접 확인하며 설정.", description: "CAD 도면을 검토하고 도형과 조명의 위치를 화면에서 조정한 뒤 저장하세요.", benefit: "현장 구조에 맞게 배치를 검토하고 수정합니다.",
    detailTitle: "도면과 조명을 현장에 맞춰 배치합니다.", problem: "현장 구조가 바뀌면 도면과 조명 위치도 다시 맞춰야 합니다. 운영자가 화면에서 배치를 확인하며 설정할 수 있습니다.",
    steps: ["CAD 도면의 후보를 검토합니다.", "도형과 조명 위치를 화면에서 조정합니다.", "운영자가 배치를 확인한 뒤 저장합니다."], outcome: "자동 등록에 맡기지 않고 현장 배치를 검토하며 수정합니다."
  }
] as const;

function FeaturePreview({ kind }: { kind: (typeof features)[number]["id"] }) {
  return <div className={`feature-preview feature-preview--${kind}`} aria-hidden="true">
    <div className="feature-preview__header"><span /><span /><span /></div>
    {kind === "monitoring" && <div className="feature-preview__map"><span /><span /><span /><span /><span /><span /></div>}
    {kind === "control" && <div className="feature-preview__control"><span /><div><i /></div><small>68%</small><div className="feature-preview__schedule"><b /><b /><b /></div></div>}
    {kind === "statistics" && <><div className="feature-preview__chart"><span /><span /><span /><span /><span /><span /></div><div className="feature-preview__report"><i /><i /><i /></div></>}
    {kind === "map-editor" && <div className="feature-preview__editor"><span /><span /><i /><i /><i /></div>}
  </div>;
}

export function FeatureOverview() {
  return <><section className="feature-overview" id="features" aria-labelledby="features-title">
    <div className="container">
      <div className="section-intro"><p className="eyebrow">KINDA / FEATURES</p><h1 id="features-title">현장 운영에 필요한<br />네 가지 흐름</h1><p>도면에서 찾고, 조정하고, 기록을 확인하는 과정을 한 서비스에서 이어갑니다.</p></div>
      <div className="feature-grid">{features.map(feature => <Card key={feature.id} role="article" aria-label={feature.title} className="feature-card">
        <div className="feature-card__copy"><span className="feature-card__number">{feature.number} / {feature.title}</span><h2>{feature.lead}</h2><p>{feature.description}</p><strong>{feature.benefit}</strong><a href={`#feature-${feature.id}`} aria-label={`${feature.title} 자세히 보기`}>자세히 보기 <span aria-hidden="true">↓</span></a></div>
        <FeaturePreview kind={feature.id} />
      </Card>)}</div>
      <p className="feature-overview__note">화면은 기능 이해를 위한 예시이며 실제 현장 데이터나 조명 제어 결과가 아닙니다.</p>
    </div>
  </section>
  {features.map(feature => <section key={feature.id} className={`feature-detail feature-detail--${feature.id}`} id={`feature-${feature.id}`} aria-labelledby={`feature-${feature.id}-title`}>
    <div className="container feature-detail__layout">
      <div className="feature-detail__copy"><span className="feature-card__number">{feature.number} / {feature.title}</span><h2 id={`feature-${feature.id}-title`}>{feature.detailTitle}</h2><p>{feature.problem}</p>
        <ol>{feature.steps.map(step => <li key={step}>{step}</li>)}</ol>
        <p className="feature-detail__outcome">{feature.outcome}</p>
        <a href={`/#${feature.id}`}>현장의 하루에서 보기 <span aria-hidden="true">↗</span></a>
      </div>
      <div className="feature-detail__preview" aria-hidden="true"><FeaturePreview kind={feature.id} /><span>기능 이해를 위한 예시 화면</span></div>
    </div>
  </section>)}
  </>;
}
