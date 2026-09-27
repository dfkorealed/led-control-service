import { useEffect, useState } from "react";
import { DemoCard, type SceneMotion } from "./Scene";

const formats = ["PDF", "XLSX"] as const;

export function ReportDemo({ motion }: { motion: SceneMotion }) {
  const [format, setFormat] = useState<(typeof formats)[number]>("PDF");
  const [manual, setManual] = useState(false);
  useEffect(() => { setFormat("PDF"); setManual(false); }, [motion.run]);
  return <DemoCard title="보고서" detail="생성 미리보기" name="보고서 생성 흐름 미리보기"
    disclaimer="설명용 보고서입니다. 형식 선택은 미리보기만 바꾸며 파일을 만들거나 내려받지 않습니다." motion={motion} className="report-demo">
    <div className="report-content">
      <div className="report-controls"><span>예시 현장 / 이번 주</span><div role="group" aria-label="보고서 파일 형식 미리보기">
        {formats.map(option => <button key={option} className={`format-button ${option === format ? "is-selected" : ""}`} type="button" aria-pressed={format === option}
          onClick={() => { setManual(true); motion.stop(); setFormat(option); }}>{option}</button>)}
      </div></div>
      <div className="report-sheet card"><div className="report-sheet__top"><span>KINDA / REPORT</span><small>예시 · 다운로드 불가</small></div>
        <h3>주간 조명 운영 보고서</h3><p>예시 현장 · 9월 둘째 주</p><div className="report-rule" />
        {["운영 현황", "조명 상태 요약", "추정 전력 추이", "명령 처리 내역"].map((name, index) => <div className="report-row" key={name}><span>{String(index + 1).padStart(2, "0")}</span><strong>{name}</strong><i /></div>)}
        <div className="report-sheet__footer"><span>작성 완료 예시</span><span>{format} 형식</span></div>
      </div>
      <div className="report-history"><span>생성 이력 예시</span><strong>주간 조명 운영 보고서 · <span>{format}</span></strong><span>확인 · 다운로드</span></div>
      <p className="demo-status" role="status" aria-live="polite">{manual ? `${format} 형식의 설명용 미리보기입니다.` : motion.phase === "playing" ? "예시 보고서 미리보기를 준비합니다." : "예시 보고서 미리보기가 준비됐습니다."}</p>
    </div>
  </DemoCard>;
}
