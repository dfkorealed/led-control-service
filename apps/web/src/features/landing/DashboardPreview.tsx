import { Activity, BarChart3, Check, ChevronDown, Layers, Map, Settings2, SlidersHorizontal } from "lucide-react";
import { StatusBadge } from "../../components/ui/StatusBadge";

function FloorIllustration() {
  return <svg viewBox="0 0 640 340" className="block w-full" aria-hidden="true">
    <rect x="20" y="24" width="600" height="290" rx="4" className="fill-surface-panel stroke-border-strong" strokeWidth="2" />
    <path d="M20 128H620M20 214H620M240 24V128M400 214V314" className="stroke-border-strong" strokeWidth="2" fill="none" />
    <path d="M40 170H585M555 158L572 170L555 182" className="stroke-border-strong" strokeWidth="2" fill="none" strokeDasharray="6 6" />
    {[55, 115, 175, 295, 355, 415, 475, 535].map((x) => <path key={x} d={`M${x} 26V87H${x + 42}V26 M${x} 312V253H${x + 42}V312`} className="stroke-border-subtle" strokeWidth="2" fill="none" />)}
    <rect x="252" y="37" width="124" height="66" rx="4" className="fill-surface-inset stroke-border-strong" />
    <text x="314" y="76" textAnchor="middle" className="fill-content-secondary text-body">승강기</text>
    <rect x="262" y="226" width="128" height="69" rx="4" className="fill-action-primary-soft stroke-action-primary" strokeWidth="2" />
    <text x="326" y="269" textAnchor="middle" className="fill-action-primary text-body">출입구 구역</text>
    {[80, 160, 280, 360, 440, 540].map((x) => <g key={x}>
      <rect x={x - 10} y="105" width="20" height="6" rx="3" className="fill-action-primary" />
      <rect x={x - 10} y="228" width="20" height="6" rx="3" className="fill-action-primary" />
    </g>)}
    <circle cx="280" cy="231" r="19" className="fill-none stroke-action-primary" strokeWidth="2" />
    <path d="M32 170L49 160V180Z" className="fill-action-primary" />
  </svg>;
}

export function DashboardPreview() {
  return <figure aria-labelledby="preview-title" aria-describedby="preview-description" className="min-w-0">
    <figcaption className="mb-4 flex flex-wrap items-center justify-between gap-2 text-body-sm">
      <span id="preview-title" className="inline-flex items-center gap-2 font-bold text-brand-navy"><span className="size-2 rounded-pill bg-brand-coral" aria-hidden="true" />제품 화면 예시</span>
      <span className="text-brand-navy/80">현장 · 도면 · 조명을 한 화면에서</span>
    </figcaption>
    {/* This is a static explanatory illustration. Faux controls are not focusable or exposed as interactive UI. */}
    <div aria-hidden="true" className="overflow-hidden rounded-panel border border-brand-navy bg-brand-navy p-2 shadow-popover compact:p-3">
      <div className="flex min-w-0 overflow-hidden rounded-control bg-surface-canvas">
        <aside className="hidden w-44 shrink-0 flex-col gap-8 border-r border-border-subtle bg-surface-panel px-4 py-6 tablet:flex">
          <div className="flex items-center gap-2 font-bold"><img src="/brand/kinda-mark.svg" width="28" height="28" alt="" />킨다 관제</div>
          <div className="grid gap-2 text-body-sm">
            <span className="flex items-center gap-2 rounded-control bg-action-primary-soft px-3 py-3 font-bold text-action-primary"><Activity size={16} />모니터링</span>
            <span className="flex items-center gap-2 px-3 py-3 text-brand-navy/80"><SlidersHorizontal size={16} />제어</span>
            <span className="flex items-center gap-2 px-3 py-3 text-brand-navy/80"><BarChart3 size={16} />통계</span>
            <span className="flex items-center gap-2 px-3 py-3 text-brand-navy/80"><Settings2 size={16} />설정</span>
          </div>
          <div className="mt-auto border-t border-border-subtle pt-4 text-label text-brand-navy/80">설치부터 운영까지,<br />하나로 연결합니다.</div>
        </aside>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border-subtle bg-surface-panel px-4 py-4 compact:px-6">
            <span className="inline-flex items-center gap-2 text-body font-bold">예시 현장 <ChevronDown size={14} /></span>
            <span className="inline-flex items-center gap-1.5 text-label text-brand-navy/80"><Layers size={14} />지하 1층</span>
          </div>
          <div className="p-3 compact:p-5">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
              <div><p className="text-body-lg font-bold">조명 모니터링</p><p className="mt-1 text-label text-brand-navy/80">도면에서 위치와 상태를 확인합니다.</p></div>
              <span className="hidden items-center gap-1.5 rounded-control border border-border-default bg-surface-panel px-3 py-2 text-label compact:inline-flex"><Map size={14} />도면 보기</span>
            </div>
            <div className="grid min-w-0 gap-3 tablet:grid-cols-[minmax(0,1fr)_12rem]">
              <div className="min-w-0 overflow-hidden rounded-control border border-border-default bg-surface-panel">
                <div className="flex items-center justify-between gap-2 border-b border-border-subtle px-3 py-3 text-label"><span className="font-bold">지하 1층 · 주차장</span><span className="text-action-primary">출입구 구역</span></div>
                <div className="bg-surface-canvas py-4 compact:py-6"><FloorIllustration /></div>
                <div className="flex flex-wrap items-center gap-3 border-t border-border-subtle px-3 py-3 text-label text-brand-navy/80"><span className="flex items-center gap-1.5"><span className="h-1.5 w-4 rounded-pill bg-action-primary" />조명 위치</span><span className="flex items-center gap-1.5"><span className="size-3 rounded-pill border-2 border-action-primary" />선택한 조명</span></div>
              </div>
              <div className="grid gap-3 compact:grid-cols-2 tablet:grid-cols-1">
                <div className="rounded-control border border-border-default bg-surface-panel p-4">
                  <p className="mb-3 text-label text-brand-navy/80">선택한 조명</p><p className="mb-3 text-body font-bold">출입구 조명</p>
                  <StatusBadge tone="success" icon={Check}>연결됨</StatusBadge>
                  <div className="mt-4 flex justify-between gap-2 border-t border-border-subtle pt-3 text-label"><span className="text-brand-navy/80">최근 확인 상태</span><span className="font-bold">켜짐</span></div>
                </div>
                <div className="rounded-control border border-border-default bg-surface-panel p-4">
                  <p className="text-body font-bold">다음 작업</p><div className="mt-3 grid gap-3 text-label text-brand-navy/80"><span className="flex items-center gap-2"><SlidersHorizontal size={15} />개별·그룹 제어</span><span className="flex items-center gap-2"><BarChart3 size={15} />운영 기록 검토</span></div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
    <p id="preview-description" className="mt-4 text-center text-label text-brand-navy/80">이해를 돕기 위한 예시이며 실제 운영 데이터가 아닙니다. 현장과 층을 선택하고, 도면의 조명 상태를 확인한 뒤 제어와 운영 기록으로 이어지는 구성을 보여줍니다.</p>
  </figure>;
}
