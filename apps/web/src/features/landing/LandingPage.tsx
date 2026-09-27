import { useEffect, useRef, type MouseEvent } from "react";
import { Button } from "../../components/ui/Button";
import { LinkButton } from "../../components/ui/LinkButton";
import { ControlDemo } from "./field-day/ControlDemo";
import { MapDemo } from "./field-day/MapDemo";
import { MonitoringDemo } from "./field-day/MonitoringDemo";
import { ReportDemo } from "./field-day/ReportDemo";
import { Scene } from "./field-day/Scene";
import { StatisticsDemo } from "./field-day/StatisticsDemo";
import { PublicSiteLayout } from "./PublicSiteLayout";

function Hero({ onInquiry }: { onInquiry: (event: MouseEvent<HTMLButtonElement>) => void }) {
  const hero = useRef<HTMLElement>(null);
  useEffect(() => {
    const node = hero.current;
    if (!node) return;
    if (!('IntersectionObserver' in window)) { node.classList.add("is-animating"); return; }
    let visible = false;
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.intersectionRatio >= .15 && !visible) {
        visible = true;
        if (!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
          node.classList.remove("is-animating");
          void node.offsetWidth;
          node.classList.add("is-animating");
        }
      } else if (entry.intersectionRatio <= .001 && visible) {
        visible = false;
        node.classList.remove("is-animating");
      }
    }, { threshold: [0, .15] });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return <section className="hero" id="top" ref={hero} aria-labelledby="hero-title">
    <div className="hero-orbit hero-orbit--one" aria-hidden="true" /><div className="hero-orbit hero-orbit--two" aria-hidden="true" />
    <div className="container hero-inner">
      <div className="hero-copy">
        <p className="eyebrow eyebrow--light">KINDA / A DAY IN THE FIELD</p>
        <h1 id="hero-title">현장의 하루,<br /><span>한눈에 이어지다.</span></h1>
        <p>조명의 위치를 찾는 아침부터 운영을 기록하는 저녁까지.<span className="hero-copy__second-line">다섯 장면으로 킨다의 관제 흐름을 살펴보세요.</span></p>
        <div className="hero-actions"><LinkButton href="#monitoring" className="button button--coral">하루 따라가기 <span aria-hidden="true">↓</span></LinkButton><Button type="button" variant="link" className="hero-contact" onClick={onInquiry}>도입 상담 <span aria-hidden="true">↗</span></Button></div>
      </div>
      <div className="hero-art" aria-hidden="true"><div className="hero-art__ring" /><div className="hero-art__panel hero-art__panel--back"><span>MONITORING</span><i /><i /><i /></div><div className="hero-art__panel hero-art__panel--front"><span>하나의 현장</span><strong>위치 · 제어 · 기록</strong><div>{Array.from({ length: 6 }, (_, index) => <b key={index} />)}</div></div><div className="hero-art__pulse" /><div className="hero-art__pointer" /></div>
    </div>
    <div className="container hero-footer"><span>SCROLL TO EXPLORE</span><span>01 — 05</span></div>
  </section>;
}

export function LandingPage() {
  return <PublicSiteLayout page="home">{openInquiry => <main id="main" tabIndex={-1}>
      <Hero onInquiry={openInquiry} />
      <div className="timeline" role="group" aria-label="현장의 하루: 모니터링, 제어, 통계 그래프, 보고서, 맵 편집의 다섯 장면">
        <Scene kind="monitoring" id="monitoring" number="01" time="08:30 · MONITORING" eyebrow="아침, 현장을 살펴볼 때" title={<>찾는 조명은<br /><em>도면 위에.</em></>} description="층과 구역을 열고 도면에서 조명 위치를 확인하세요. 선택한 조명의 연결 상태와 최근 확인 상태를 같은 화면에서 살펴볼 수 있습니다." benefit="위치와 상태를 오가며 찾는 시간을 줄입니다.">{motion => <MonitoringDemo key={motion.run} motion={motion} />}</Scene>
        <Scene kind="control" id="control" number="02" time="14:00 · CONTROL" eyebrow="오후, 운영을 조정할 때" title={<>필요한 만큼<br /><em>밝기를 맞추다.</em></>} description="개별 조명이나 그룹을 선택해 점등과 밝기를 조정하세요. 자주 반복되는 운영은 일정으로 정리할 수 있습니다." benefit="대상과 시간에 맞는 운영 기준을 세웁니다.">{motion => <ControlDemo key={motion.run} motion={motion} />}</Scene>
        <Scene kind="statistics" id="statistics" number="03" time="17:00 · STATISTICS" eyebrow="변화를 살펴볼 때" title={<>운영의 흐름을<br /><em>그래프로 보다.</em></>} description="기간별 상태 기반 추정 전력을 그래프로 살펴보세요. 달라진 흐름을 비교하며 다음 운영 계획을 세우는 데 참고할 수 있습니다." benefit="숫자의 흐름을 더 쉽게 읽습니다.">{motion => <StatisticsDemo key={motion.run} motion={motion} />}</Scene>
        <Scene kind="report" id="report" number="04" time="18:00 · REPORT" eyebrow="공유할 자료가 필요할 때" title={<>정리한 기록을<br /><em>보고서로.</em></>} description="운영 데이터를 기간에 맞춰 정리하고 보고서로 내보낼 수 있습니다. 생성 이력을 다시 확인하고 필요한 파일을 내려받는 흐름까지 이어집니다." benefit="반복되는 보고 준비를 한곳에서 처리합니다.">{motion => <ReportDemo key={motion.run} motion={motion} />}</Scene>
        <Scene kind="map" id="map-editor" number="05" time="MAP EDITOR" eyebrow="새 구역을 준비할 때" title={<>도면도 조명도<br /><em>직접, 쉽게 배치.</em></>} description="CAD 도면을 검토하고 도형과 조명 위치를 화면에서 조정하세요. 운영자가 배치를 확인한 뒤 저장하는 흐름으로 새 현장을 준비합니다." benefit="현장 배치를 보면서 설정할 수 있습니다.">{motion => <MapDemo key={motion.run} motion={motion} />}</Scene>
      </div>
      <section className="closing" aria-labelledby="closing-title"><div className="container closing-inner"><p className="eyebrow eyebrow--light">YOUR FIELD, YOUR DAY</p><h2 id="closing-title">우리 현장에는<br />어떤 흐름이 필요할까요?</h2><p>현장 규모와 조명 배치, 운영 방식을 알려주세요. 필요한 관제 구성을 함께 살펴보겠습니다.</p><Button type="button" variant="primary" className="button button--coral" onClick={openInquiry}>도입 상담하기 <span aria-hidden="true">↗</span></Button></div></section>
    </main>}</PublicSiteLayout>;
}
