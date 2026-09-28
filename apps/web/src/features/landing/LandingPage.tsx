import { useEffect, useRef, useState } from "react";
import { Card } from "../../components/ui/Card";
import { Button } from "../../components/ui/Button";
import { LinkButton } from "../../components/ui/LinkButton";
import { ControlDemo } from "./field-day/ControlDemo";
import { MapDemo } from "./field-day/MapDemo";
import { MonitoringDemo } from "./field-day/MonitoringDemo";
import { ReportDemo } from "./field-day/ReportDemo";
import { Scene } from "./field-day/Scene";
import { StatisticsDemo } from "./field-day/StatisticsDemo";
import { PublicSiteLayout, type OpenInquiry } from "./PublicSiteLayout";

const container = "mx-auto w-[min(1180px,calc(100%-72px))] phone-wide:max-w-[360px] compact:max-w-[760px] tablet:max-w-[1024px] landing-wide:landing-stack:w-[calc(100%-38px)] landing-wide:landing-stack:landing-narrow:w-[calc(100%-30px)]";
const eyebrow = "eyebrow--light m-0 text-landing-eyebrow font-[850] text-brand-coral uppercase";

function Hero({ onInquiry, visualVariant }: { onInquiry: OpenInquiry; visualVariant: "site" | "concept" }) {
  const hero = useRef<HTMLElement>(null);
  const [isAnimating, setIsAnimating] = useState(false);
  useEffect(() => {
    const node = hero.current;
    if (!node) return;
    if (!("IntersectionObserver" in window)) { setIsAnimating(true); return; }
    let visible = false;
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.intersectionRatio >= .15 && !visible) {
        visible = true;
        if (!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
          // Toggle animation classes so replay preserves the controls and keyboard focus.
          setIsAnimating(true);
        }
      } else if (entry.intersectionRatio <= .001 && visible) {
        visible = false;
        setIsAnimating(false);
      }
    }, { threshold: [0, .15] });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  const copyMotion = isAnimating ? "motion-safe:animate-landing-hero-copy" : "";
  return <section className="hero after:absolute after:inset-0 after:-z-1 after:bg-linear-[125deg_in_srgb] after:from-surface-inverse/55 after:to-transparent after:to-65% after:content-[''] relative isolate flex min-h-[max(740px,100svh)] overflow-hidden bg-brand-navy text-surface-panel scroll-mt-landing-anchor-anchor-offset landing-wide:landing-stack:min-h-[790px] landing-wide:landing-stack:landing-narrow:min-h-[760px]" id="top" ref={hero} aria-labelledby="hero-title">
    <div className="hero-orbit hero-orbit--one pointer-events-none absolute -z-1 size-[750px] top-11/100 right-landing-hero-orbit-near-right rounded-landing-ellipse border border-action-primary-soft/13" aria-hidden="true" />
    <div className="hero-orbit hero-orbit--two pointer-events-none absolute -z-1 size-[1070px] -top-8/100 right-landing-hero-orbit-far-right rounded-landing-ellipse border border-action-primary-soft/13" aria-hidden="true" />
    <div className={`${container} hero-inner grid grid-cols-[minmax(0,1.08fr)_minmax(0,.92fr)] items-center gap-landing-hero-frame-gap py-landing-hero-frame-block-inset landing-wide:grid-cols-[1fr_.8fr] landing-wide:landing-stack:grid-cols-1 landing-wide:landing-stack:content-center landing-wide:landing-stack:gap-landing-hero-frame-stacked-gap landing-wide:landing-stack:py-landing-hero-frame-stacked-block-inset`}>
      <div className="hero-copy relative z-2">
        <p className={`${eyebrow} ${copyMotion}`}>KINDA / A DAY IN THE FIELD</p>
        <h1 id="hero-title" className={`max-w-[780px] m-landing-hero-heading-margin font-[850] ${visualVariant === "concept" ? "text-landing-concept-hero-fluid" : "text-landing-hero-fluid"} landing-wide:landing-stack:text-landing-hero-fluid-stacked landing-wide:landing-stack:landing-narrow:text-landing-hero-fluid-narrow ${copyMotion}`} style={{ animationDelay: ".1s" }}>현장의 하루,<br /><span className="text-brand-coral">한눈에 이어지다.</span></h1>
        <p className={`m-0 max-w-[500px] text-landing-hero-description text-action-primary-soft landing-wide:landing-stack:landing-narrow:text-landing-narrative-copy-narrow ${copyMotion}`} style={{ animationDelay: ".2s" }}>조명의 위치를 찾는 아침부터 운영을 기록하는 저녁까지.<span className="hero-copy__second-line block">다섯 장면으로 킨다의 관제 흐름을 살펴보세요.</span></p>
        <div className={`hero-actions mt-landing-hero-actions-top-space flex flex-wrap items-center gap-landing-hero-actions-gap landing-wide:landing-stack:landing-narrow:gap-landing-hero-actions-narrow-gap ${copyMotion}`} style={{ animationDelay: ".3s" }}><LinkButton href="#monitoring" variant="landingCta">하루 따라가기 <span aria-hidden="true">↓</span></LinkButton><Button type="button" variant="landingHeroContact" className="hero-contact" onClick={onInquiry}>도입 상담 <span aria-hidden="true">↗</span></Button></div>
      </div>
      <div className="hero-art relative m-auto aspect-square w-full max-w-[540px] landing-wide:landing-stack:w-[min(75vw,350px)] landing-wide:landing-stack:mt-landing-hero-illustration-stacked-top-space landing-wide:landing-stack:opacity-85 landing-wide:landing-stack:landing-narrow:w-[74vw] landing-wide:landing-stack:landing-narrow:mt-landing-hero-illustration-narrow-top-space" aria-hidden="true">
        <div className={`hero-art__ring absolute inset-2/100 rounded-landing-ellipse border border-surface-panel/18 bg-radial-[circle_at_42%_38%_in_srgb] from-action-primary-soft via-brand-blue via-65% to-brand-navy to-98% shadow-landing-hero-atmosphere ${isAnimating ? "motion-safe:animate-landing-hero-ring" : ""}`} />
        <Card variant="landingGlass" className="hero-art__panel hero-art__panel--back absolute top-17/100 -right-2/100 min-h-[33%] w-[43%] transform-[rotate(9deg)] bg-surface-panel/14 p-landing-hero-art-background-card-inset landing-wide:landing-stack:p-landing-hero-art-background-card-stacked-inset">
          <span className="mb-5 block text-landing-hero-art-label font-extrabold text-surface-panel">MONITORING</span>
          {["w-full", "w-[70%]", "w-[85%]"].map(width => <i key={width} className={`my-3 block h-[9px] rounded-control bg-surface-panel/35 ${width}`} />)}
        </Card>
        <Card variant="landingGlass" className="hero-art__panel hero-art__panel--front absolute bottom-12/100 left-3/100 w-[66%] transform-[rotate(-5deg)] bg-surface-panel/93 p-landing-hero-art-metric-card-inset text-brand-navy landing-wide:landing-stack:p-4.5">
          <span className="block text-landing-demo-meta font-extrabold text-brand-blue">하나의 현장</span><strong className="mt-2.5 block text-landing-hero-art-metric">위치 · 제어 · 기록</strong>
          <div className="mt-landing-hero-art-chart-top-space flex h-[80px] items-end justify-between gap-landing-hero-art-chart-gap landing-wide:landing-stack:h-[42px]">
            {["h-[35%] bg-action-primary-soft", "h-[62%] bg-brand-blue", "h-[49%] bg-action-primary-soft", "h-[80%] bg-brand-coral", "h-[67%] bg-brand-blue", "h-[88%] bg-brand-blue"].map((bar, index) => <b key={bar} className={`block flex-1 rounded-landing-hero-chart-bar ${bar} ${isAnimating ? "origin-bottom motion-safe:animate-landing-hero-bars" : ""}`} style={{ animationDelay: `${index * .15}s` }} />)}
          </div>
        </Card>
        <div className={`hero-art__pulse absolute top-24/100 left-26/100 size-[18px] rounded-landing-ellipse border-5 border-surface-panel bg-brand-coral shadow-landing-hero-highlight ${isAnimating ? "motion-safe:animate-landing-hero-dot" : ""}`} />
        <div className={`hero-art__pointer absolute top-30/100 left-31/100 h-[30px] w-[25px] bg-surface-panel [clip-path:polygon(0_0,0_100%,26%_74%,44%_100%,59%_92%,42%_64%,75%_66%)] drop-shadow-[0_2px_1px_var(--color-brand-navy)] ${isAnimating ? "motion-safe:animate-landing-hero-pointer" : ""}`} />
      </div>
    </div>
    <div className={`${container} hero-footer absolute inset-x-0 bottom-landing-hero-footer-bottom flex justify-between text-landing-hero-footer font-extrabold text-action-primary-soft landing-wide:landing-stack:landing-narrow:bottom-4.5`}><span>SCROLL TO EXPLORE</span><span>01 — 05</span></div>
  </section>;
}

export function LandingStory({ onInquiry, visualVariant = "site" }: { onInquiry: OpenInquiry; visualVariant?: "site" | "concept" }): JSX.Element {
  return <main id="main" tabIndex={-1}>
      <Hero onInquiry={onInquiry} visualVariant={visualVariant} />
      <div className="timeline" role="group" aria-label="현장의 하루: 모니터링, 제어, 통계 그래프, 보고서, 맵 편집의 다섯 장면">
        <Scene kind="monitoring" id="monitoring" number="01" time="08:30 · MONITORING" eyebrow="아침, 현장을 살펴볼 때" title={<>찾는 조명은<br /><em className="text-brand-blue not-italic">도면 위에.</em></>} description="층과 구역을 열고 도면에서 조명 위치를 확인하세요. 선택한 조명의 연결 상태와 최근 확인 상태를 같은 화면에서 살펴볼 수 있습니다." benefit="위치와 상태를 오가며 찾는 시간을 줄입니다.">{motion => <MonitoringDemo motion={motion} />}</Scene>
        <Scene kind="control" id="control" number="02" time="14:00 · CONTROL" eyebrow="오후, 운영을 조정할 때" title={<>필요한 만큼<br /><em className="text-brand-blue not-italic">밝기를 맞추다.</em></>} description="개별 조명이나 그룹을 선택해 점등과 밝기를 조정하세요. 자주 반복되는 운영은 일정으로 정리할 수 있습니다." benefit="대상과 시간에 맞는 운영 기준을 세웁니다.">{motion => <ControlDemo motion={motion} />}</Scene>
        <Scene kind="statistics" id="statistics" number="03" time="17:00 · STATISTICS" eyebrow="변화를 살펴볼 때" title={<>운영의 흐름을<br /><em className="text-brand-coral not-italic">그래프로 보다.</em></>} description="기간별 상태 기반 추정 전력을 그래프로 살펴보세요. 달라진 흐름을 비교하며 다음 운영 계획을 세우는 데 참고할 수 있습니다." benefit="숫자의 흐름을 더 쉽게 읽습니다.">{motion => <StatisticsDemo key={motion.run} motion={motion} />}</Scene>
        <Scene kind="report" id="report" number="04" time="18:00 · REPORT" eyebrow="공유할 자료가 필요할 때" title={<>정리한 기록을<br /><em className="text-brand-blue not-italic">보고서로.</em></>} description="운영 데이터를 기간에 맞춰 정리하고 보고서로 내보낼 수 있습니다. 생성 이력을 다시 확인하고 필요한 파일을 내려받는 흐름까지 이어집니다." benefit="반복되는 보고 준비를 한곳에서 처리합니다.">{motion => <ReportDemo key={motion.run} motion={motion} />}</Scene>
        <Scene kind="map" id="map-editor" number="05" time="MAP EDITOR" eyebrow="새 구역을 준비할 때" title={<>도면도 조명도<br /><em className="text-brand-blue not-italic">직접, 쉽게 배치.</em></>} description="CAD 도면을 검토하고 도형과 조명 위치를 화면에서 조정하세요. 운영자가 배치를 확인한 뒤 저장하는 흐름으로 새 현장을 준비합니다." benefit="현장 배치를 보면서 설정할 수 있습니다.">{motion => <MapDemo key={motion.run} motion={motion} />}</Scene>
      </div>
      <section className="closing flex min-h-svh items-center bg-surface-inverse py-landing-closing-block-inset text-center text-surface-panel" aria-labelledby="closing-title"><div className={`${container} closing-inner`}><p className={eyebrow}>YOUR FIELD, YOUR DAY</p><h2 id="closing-title" className="m-landing-closing-heading-margin text-landing-closing-heading landing-wide:landing-stack:landing-narrow:text-landing-closing-heading-narrow">우리 현장에는<br />어떤 흐름이 필요할까요?</h2><p className="max-w-[560px] m-landing-closing-description-margin text-landing-closing-description text-action-primary-soft landing-wide:landing-stack:landing-narrow:text-landing-narrative-copy-narrow">현장 규모와 조명 배치, 운영 방식을 알려주세요. 필요한 관제 구성을 함께 살펴보겠습니다.</p><Button type="button" variant="landingCta" onClick={onInquiry}>도입 상담하기 <span aria-hidden="true">↗</span></Button></div></section>
    </main>;
}

export function LandingPage() {
  return <PublicSiteLayout page="home">{onInquiry => <LandingStory onInquiry={onInquiry} />}</PublicSiteLayout>;
}
