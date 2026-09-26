import { useId, useState } from "react";
import { Activity, BarChart3, CalendarDays, Check, ChevronDown, Clock3, Layers, Lightbulb, SlidersHorizontal } from "lucide-react";
import { Button } from "../../components/ui/Button";
import { StatusBadge } from "../../components/ui/StatusBadge";

type PreviewMode = "monitoring" | "control" | "records";

const modes = [
  { id: "monitoring", label: "모니터링", icon: Activity },
  { id: "control", label: "제어", icon: SlidersHorizontal },
  { id: "records", label: "기록", icon: BarChart3 }
] as const;

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

function PreviewHeading({ step, title, description }: { step: string; title: string; description: string }) {
  return <div className="mb-4 flex min-w-0 flex-wrap items-end justify-between gap-2 compact:mb-5">
    <div className="min-w-0">
      <p className="mb-1 text-label font-bold text-action-primary">{step}</p>
      <h3 className="text-body-lg font-bold text-brand-navy compact:text-card-title">{title}</h3>
      <p className="mt-1 text-body-sm text-brand-navy/80">{description}</p>
    </div>
    <span className="inline-flex items-center gap-1.5 rounded-control border border-border-default bg-surface-panel px-3 py-2 text-label text-brand-navy/80"><Layers size={14} aria-hidden="true" />지하 1층</span>
  </div>;
}

function MonitoringView() {
  return <>
    <PreviewHeading step="01 · 위치 파악" title="도면에서 위치와 상태 확인" description="현장과 층을 선택해 조명이 어디에 있는지 살펴봅니다." />
    <div className="grid min-w-0 gap-3 tablet:grid-cols-[minmax(0,1fr)_14rem]">
      <div className="min-w-0 overflow-hidden rounded-control border border-border-default bg-surface-panel">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border-subtle px-3 py-3 text-label"><span className="font-bold">지하 1층 · 주차장 도면</span><span className="text-action-primary">출입구 구역</span></div>
        <div className="bg-surface-canvas px-1 py-3 compact:px-3 compact:py-5"><FloorIllustration /></div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-border-subtle px-3 py-3 text-label text-brand-navy/80"><span className="flex items-center gap-1.5"><span className="h-1.5 w-4 rounded-pill bg-action-primary" aria-hidden="true" />조명 위치</span><span className="flex items-center gap-1.5"><span className="size-3 rounded-pill border-2 border-action-primary" aria-hidden="true" />선택한 조명</span></div>
      </div>
      <div className="grid gap-3 compact:grid-cols-2 tablet:grid-cols-1">
        <div className="rounded-control border border-border-default bg-surface-panel p-4">
          <p className="text-label text-brand-navy/80">선택한 조명</p><p className="mt-2 text-body font-bold">출입구 조명</p>
          <div className="mt-3"><StatusBadge tone="success" icon={Check}>연결됨</StatusBadge></div>
          <div className="mt-4 flex justify-between gap-2 border-t border-border-subtle pt-3 text-label"><span className="text-brand-navy/80">최근 확인 상태</span><span className="font-bold">켜짐</span></div>
        </div>
        <div className="rounded-control border border-border-default bg-surface-panel p-4">
          <p className="text-label text-brand-navy/80">현장 범위</p><p className="mt-2 text-body font-bold">예시 현장</p>
          <div className="mt-4 grid gap-2 border-t border-border-subtle pt-3 text-label text-brand-navy/80"><span>지하 1층 · 주차장</span><span>도면 위치 기준으로 확인</span></div>
        </div>
      </div>
    </div>
  </>;
}

function ControlView() {
  return <>
    <PreviewHeading step="02 · 제어" title="대상을 고르고 조명 제어" description="개별 조명이나 그룹을 선택하고 일정에 맞춰 운영합니다." />
    <div className="grid min-w-0 gap-3 tablet:grid-cols-[minmax(0,1fr)_14rem]">
      <div className="min-w-0 rounded-control border border-border-default bg-surface-panel p-4 compact:p-5">
        <div className="flex flex-wrap items-center justify-between gap-2"><div><p className="text-label text-brand-navy/80">제어 대상</p><p className="mt-1 text-body font-bold">출입구 구역</p></div><span className="rounded-control bg-action-primary-soft px-3 py-2 text-label font-bold text-action-primary">지하 1층</span></div>
        {/* These rows explain a possible selection; only the three mode buttons operate in this preview. */}
        <div className="mt-5 grid gap-2">
          {["출입구 조명 01", "출입구 조명 02", "출입구 조명 03"].map((name, index) => <div key={name} className="flex min-w-0 items-center gap-3 rounded-control border border-border-subtle bg-surface-canvas px-3 py-3">
            <span className={`flex size-9 shrink-0 items-center justify-center rounded-control ${index === 0 ? "bg-action-primary text-content-inverse" : "bg-action-primary-soft text-action-primary"}`}><Lightbulb size={17} aria-hidden="true" /></span>
            <span className="min-w-0 flex-1 truncate text-body-sm font-bold">{name}</span><span className="shrink-0 text-label text-brand-navy/80">켜짐</span>
          </div>)}
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-border-subtle pt-4 text-label"><span className="rounded-control bg-action-primary-soft px-2.5 py-1.5 font-bold text-action-primary">입구 그룹</span><span className="text-brand-navy/80">3개 조명 대상</span></div>
      </div>
      <div className="grid gap-3 compact:grid-cols-3 tablet:grid-cols-1">
        <div className="rounded-control border border-border-default bg-surface-panel p-4"><p className="flex items-center gap-2 text-label font-bold text-action-primary"><Lightbulb size={16} aria-hidden="true" />개별 제어</p><p className="mt-3 text-body font-bold">출입구 조명 01</p><p className="mt-1 text-label text-brand-navy/80">점등 · 밝기 70%</p><div className="mt-3 h-1.5 rounded-pill bg-action-primary-soft"><span className="block h-full w-[70%] rounded-pill bg-action-primary" /></div></div>
        <div className="rounded-control border border-border-default bg-surface-panel p-4"><p className="flex items-center gap-2 text-label font-bold text-action-primary"><Layers size={16} aria-hidden="true" />그룹 제어</p><p className="mt-3 text-body font-bold">입구 그룹</p><p className="mt-1 text-label text-brand-navy/80">같은 작업을 함께 적용</p></div>
        <div className="rounded-control border border-border-default bg-surface-panel p-4"><p className="flex items-center gap-2 text-label font-bold text-action-primary"><CalendarDays size={16} aria-hidden="true" />일정 운영</p><p className="mt-3 text-body font-bold">평일 18:00</p><p className="mt-1 text-label text-brand-navy/80">설정한 일정으로 점등</p></div>
      </div>
    </div>
  </>;
}

function RecordsView() {
  return <>
    <PreviewHeading step="03 · 결과 확인" title="명령 이력과 추정 전력 확인" description="처리된 명령과 기간별 사용량을 운영 판단에 참고합니다." />
    <div className="grid min-w-0 gap-3 tablet:grid-cols-[minmax(0,1fr)_14rem]">
      <div className="min-w-0 rounded-control border border-border-default bg-surface-panel p-4 compact:p-5">
        <div className="flex flex-wrap items-center justify-between gap-2"><div><p className="text-label text-brand-navy/80">운영 기록</p><p className="mt-1 text-body font-bold">명령 처리 이력</p></div><Clock3 size={19} className="text-action-primary" aria-hidden="true" /></div>
        <div className="mt-5 grid gap-2">
          {[
            ["출입구 조명 밝기 변경", "9/23 18:05", "처리 완료"],
            ["입구 그룹 점등", "9/23 18:00", "처리 완료"],
            ["주차장 그룹 소등", "9/22 23:00", "처리 완료"]
          ].map(([action, time, status]) => <div key={action} className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 rounded-control border border-border-subtle bg-surface-canvas px-3 py-3 text-body-sm">
            <span className="min-w-0 flex-1 font-bold">{action}</span><span className="text-label text-brand-navy/80">{time}</span><span className="rounded-pill bg-action-primary-soft px-2 py-1 text-label font-bold text-action-primary">{status}</span>
          </div>)}
        </div>
      </div>
      <div className="rounded-control border border-border-default bg-surface-panel p-4">
        <p className="text-label text-brand-navy/80">기간별 통계</p><p className="mt-1 text-body font-bold">상태 기반 추정 전력</p><p className="mt-2 text-label text-brand-navy/80">예시 기간 · 3일</p>
        <div className="mt-5 grid gap-3 text-label">
          {[{ day: "월", value: "14.2 kWh", width: "w-3/5" }, { day: "화", value: "18.4 kWh", width: "w-4/5" }, { day: "수", value: "16.1 kWh", width: "w-2/3" }].map(({ day, value, width }) => <div key={day}>
            <div className="mb-1.5 flex justify-between gap-2"><span className="font-bold">{day}</span><span className="text-brand-navy/80">{value}</span></div><div className="h-2 rounded-pill bg-action-primary-soft"><span className={`block h-full rounded-pill bg-action-primary ${width}`} /></div>
          </div>)}
        </div>
        <p className="mt-5 border-t border-border-subtle pt-3 text-label text-brand-navy/80">조명 상태를 기준으로 계산한 추정값</p>
      </div>
    </div>
  </>;
}

export function DashboardPreview() {
  const [mode, setMode] = useState<PreviewMode>("monitoring");
  const id = useId();
  const panelId = `${id}-preview-panel`;
  const descriptionId = `${id}-preview-description`;

  return <figure aria-label="킨다 관제 구성 예시" aria-describedby={descriptionId} data-preview-mode={mode} className="min-w-0">
    <div className="overflow-hidden rounded-panel border border-brand-navy bg-brand-navy p-2 shadow-popover compact:p-3">
      <div className="min-w-0 overflow-hidden rounded-control bg-surface-canvas">
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-border-subtle bg-surface-panel px-3 py-3 compact:px-5">
          <div className="flex items-center gap-2 text-body-sm font-bold text-brand-navy"><img src="/brand/kinda-mark.svg" width="26" height="26" alt="" />킨다 관제</div>
          <div className="flex min-w-0 items-center gap-2 text-label text-brand-navy/80"><span className="inline-flex items-center gap-1.5 font-bold text-brand-navy">예시 현장 <ChevronDown size={14} aria-hidden="true" /></span><span aria-hidden="true">/</span><span>지하 1층</span></div>
        </div>
        <div className="border-b border-border-subtle bg-surface-panel px-2 pb-2 compact:px-5 compact:pb-3">
          <div role="group" aria-label="구성 화면 선택" className="grid grid-cols-3 gap-1.5 rounded-control bg-surface-inset p-1.5 compact:max-w-lg">
            {modes.map(({ id: modeId, label, icon: Icon }) => <Button key={modeId} type="button" variant={mode === modeId ? "primary" : "ghost"} size="sm" aria-pressed={mode === modeId} aria-controls={panelId} onClick={() => setMode(modeId)} className="min-w-0 px-1.5 text-label compact:px-3 compact:text-body-sm"><Icon size={15} className="hidden compact:block" aria-hidden="true" />{label}</Button>)}
          </div>
        </div>
        <section key={mode} id={panelId} role="region" aria-label={`${modes.find((item) => item.id === mode)?.label} 구성 화면`} data-preview-panel className="min-w-0 p-3 compact:p-5">
          {mode === "monitoring" ? <MonitoringView /> : mode === "control" ? <ControlView /> : <RecordsView />}
        </section>
      </div>
    </div>
    <figcaption id={descriptionId} className="mx-auto mt-4 max-w-2xl text-center text-label text-brand-navy/80">이해를 돕기 위한 구성 예시이며 실제 운영 데이터가 아닙니다. 화면 선택은 이 예시 안에서만 바뀝니다.</figcaption>
  </figure>;
}
