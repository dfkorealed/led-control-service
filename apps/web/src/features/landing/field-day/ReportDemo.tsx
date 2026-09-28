import { useEffect, useState } from "react";
import { Button } from "../../../components/ui/Button";
import { Card } from "../../../components/ui/Card";
import { DemoCard, useConceptPresentation, type SceneMotion } from "./Scene";

const siteFormats = ["PDF", "XLSX"] as const;
const conceptFormats = ["PDF", "XLSX", "CSV"] as const;

export function ReportDemo({ motion }: { motion: SceneMotion }) {
  const concept = useConceptPresentation();
  const formats = concept ? conceptFormats : siteFormats;
  const [format, setFormat] = useState<(typeof conceptFormats)[number]>("PDF");
  const [manual, setManual] = useState(false);
  useEffect(() => { setFormat("PDF"); setManual(false); }, [motion.run]);
  return <DemoCard title="보고서" detail="생성 미리보기" name="보고서 생성 흐름 미리보기"
    disclaimer="설명용 보고서입니다. 형식 선택은 미리보기만 바꾸며 파일을 만들거나 내려받지 않습니다." motion={motion} className="report-demo">
    <div className="report-content p-landing-report-content-inset bg-brand-paper landing-narrow:p-landing-demo-content-compact-inset">
      <div className="report-controls flex items-center justify-between gap-2.5 mb-landing-report-controls-bottom-space text-landing-demo-meta font-[750]"><span className="landing-narrow:text-landing-demo-caption">예시 현장 / 이번 주</span><div className="flex gap-1" role="group" aria-label="보고서 파일 형식 미리보기">
        {formats.map(option => <Button variant="landingReportFormat" key={option} className={`format-button ${option === format ? "is-selected" : ""}`} type="button" aria-pressed={format === option}
          onClick={() => { setManual(true); motion.stop(); setFormat(option); }}>{option}</Button>)}
      </div></div>
      <Card key={motion.run} variant="landingDemoSurface" className="report-sheet card w-[min(100%,440px)] mx-auto p-landing-report-sheet-inset shadow-landing-report-sheet landing-narrow:px-4.5 landing-narrow:pt-5 landing-narrow:pb-4"><div className="report-sheet__top flex justify-between gap-2.5 text-brand-blue text-landing-report-micro font-extrabold"><span>KINDA / REPORT</span><small className="text-status-neutral-foreground text-landing-report-meta">예시 · 다운로드 불가</small></div>
        <h3 className={`${concept ? "font-bold" : ""} m-landing-report-heading-margin text-landing-report-heading landing-narrow:mt-landing-report-heading-narrow-top-space landing-narrow:text-landing-report-heading-narrow`}>주간 조명 운영 보고서</h3><p className="m-0 text-content-secondary text-landing-demo-meta">예시 현장 · 9월 둘째 주</p><div className="report-rule h-0.75 m-landing-report-divider-margin bg-brand-blue" />
        {["운영 현황", "조명 상태 요약", "추정 전력 추이", "명령 처리 내역"].map((name, index) => <div className={`report-row motion-reduce:opacity-100 motion-reduce:transform-none grid grid-cols-[25px_1fr_50px] items-center gap-2.5 min-h-[45px] border-b border-border-subtle ${motion.phase === "playing" ? `opacity-0 transform-[translateY(9px)] animate-landing-report-row ${["[animation-delay:300ms]", "[animation-delay:600ms]", "[animation-delay:900ms]", "[animation-delay:1200ms]"][index]}` : "opacity-100 transform-none"}`} key={name}><span className="text-brand-blue text-landing-demo-caption font-extrabold">{String(index + 1).padStart(2, "0")}</span><strong className="text-landing-demo-meta">{name}</strong><i className="h-1.5 rounded-landing-report-progress bg-action-primary-soft" /></div>)}
        <div className="report-sheet__footer flex justify-between gap-2.5 mt-5 pt-landing-report-footer-top-inset text-content-secondary text-landing-report-meta font-extrabold"><span>작성 완료 예시</span><span>{concept ? `${format} 형식` : <>{format} 형식</>}</span></div>
      </Card>
      <div key={`history-${motion.run}`} className={`report-history motion-reduce:opacity-100 motion-reduce:transform-none flex items-center justify-between gap-2.5 w-[min(100%,440px)] mx-auto mt-3 p-landing-report-history-inset border border-border-default rounded-landing-compact-summary-surface bg-surface-panel text-landing-demo-micro ${motion.phase === "playing" ? "opacity-0 transform-[translateY(8px)] animate-landing-report-history" : "opacity-100 transform-none"}`}><span className="text-content-secondary whitespace-nowrap landing-narrow:hidden">생성 이력 예시</span><strong className="overflow-hidden text-landing-demo-caption text-ellipsis whitespace-nowrap">주간 조명 운영 보고서 · <span>{format}</span></strong><span className="text-brand-blue font-extrabold whitespace-nowrap">확인 · 다운로드</span></div>
      <p className="demo-status mx-auto mb-0 mt-landing-demo-result-top-space text-center text-brand-blue text-landing-demo-status font-[750]" role="status" aria-live="polite">{manual ? `${format} 형식의 설명용 미리보기입니다.` : motion.phase === "playing" ? "예시 보고서 미리보기를 준비합니다." : "예시 보고서 미리보기가 준비됐습니다."}</p>
    </div>
  </DemoCard>;
}
