import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import type { FixtureGroupMetadata } from "@led-control/shared";
import { Archive, CheckCircle2, CircleAlert, Clock3, Lightbulb, Network, Plus, RotateCcw, Save } from "lucide-react";
import { ApiError } from "../../../api/client";
import { deleteFixtureGroup, fixtureGroupQueryKey, listFixtureGroups } from "../../../api/fixture-groups";
import {
  archiveFloor,
  createFloor,
  floorFixtureSettingsQueryKey,
  floorFixturesQueryKey,
  getFloorFixtureSettings,
  getSiteSettings,
  restoreFloor,
  siteSettingsQueryKey,
  updateFixtureMetadata,
  updateFloor,
  updateSiteSettings,
  type FixtureSettingsItem,
  type SiteSettings,
  type SiteSettingsFloor
} from "../../../api/site-settings";
import { Button, Card, DataGrid, FeedbackState, ModalDialog, PageHeader, SelectBox, StatusBadge, StatusDetailButton, TextField, type DataGridColumn } from "../../../components/ui";
import { BioSensorSettingsPanel } from "./BioSensorSettingsPanel";
import { SiteInformationEditDialog } from "./SiteInformationEditDialog";
import { FloorEditDialog } from "./FloorEditDialog";

interface RetryableError {
  title: string;
  retryLabel: string;
  retry: () => void;
}

const TARIFF_RATE_RANGE = { min: 0, max: 99_999_999.99 } as const;
const RATED_WATT_RANGE = { min: 0.01, max: 999_999.99 } as const;

export function SiteOperationsView({ siteId, ownerUserId, canPrepare = false }: { siteId?: string; ownerUserId?: string; canPrepare?: boolean }) {
  const queryClient = useQueryClient();
  const settingsQuery = useQuery({
    queryKey: siteSettingsQueryKey(siteId ?? "unselected"),
    queryFn: () => getSiteSettings(siteId!),
    enabled: Boolean(siteId)
  });
  const [selectedFloorId, setSelectedFloorId] = useState("");
  const [floorToArchive, setFloorToArchive] = useState<SiteSettingsFloor | null>(null);
  const [floorActionError, setFloorActionError] = useState<RetryableError | null>(null);
  const [floorEditor, setFloorEditor] = useState<{ id: string; trigger: HTMLElement } | null>(null);
  const activeFloors = useMemo(
    () => settingsQuery.data?.floors.filter((floor) => floor.status === "active") ?? [],
    [settingsQuery.data?.floors]
  );

  useEffect(() => {
    if (!activeFloors.some((floor) => floor.id === selectedFloorId)) {
      setSelectedFloorId(activeFloors[0]?.id ?? "");
    }
  }, [activeFloors, selectedFloorId]);

  const archiveMutation = useMutation({
    mutationFn: (floor: SiteSettingsFloor) => archiveFloor(siteId!, floor.id, floor.updatedAt),
    onSuccess: async () => {
      setFloorToArchive(null);
      setFloorActionError(null);
      await invalidateSiteOperations(queryClient, siteId!);
    },
    onError: (error, floor) => {
      setFloorToArchive(null);
      setFloorActionError(isConflict(error)
        ? {
            title: isVersionConflict(error)
              ? "층 상태가 변경되어 보관하지 못했습니다."
              : "층에 조명, 활성 구역 또는 진행 중인 등록 작업이 있어 보관하지 못했습니다.",
            retryLabel: "최신 정보 불러오기",
            retry: () => {
              setFloorActionError(null);
              void settingsQuery.refetch();
            }
          }
        : {
            title: "층을 보관하지 못했습니다.",
            retryLabel: "보관 다시 시도",
            retry: () => archiveMutation.mutate(floor)
          });
    }
  });

  const restoreMutation = useMutation({
    mutationFn: (floor: SiteSettingsFloor) => restoreFloor(siteId!, floor.id, floor.updatedAt),
    onSuccess: async () => {
      setFloorActionError(null);
      await invalidateSiteOperations(queryClient, siteId!);
    },
    onError: (error, floor) => setFloorActionError(isVersionConflict(error)
      ? {
          title: "층 상태가 변경되어 복구하지 못했습니다.",
          retryLabel: "최신 정보 불러오기",
          retry: () => {
            setFloorActionError(null);
            void settingsQuery.refetch();
          }
        }
      : {
          title: "층을 복구하지 못했습니다.",
          retryLabel: "복구 다시 시도",
          retry: () => restoreMutation.mutate(floor)
        })
  });

  if (!siteId) {
    return <FeedbackState tone="neutral" icon={CircleAlert} title="운영 정보를 관리할 현장을 선택하세요." />;
  }

  return (
    <section className="grid min-w-0 content-start gap-6" aria-label="현장 관리">
      <div role="group" aria-label="현장 관리 도구" className="flex min-w-0 flex-wrap items-center justify-between gap-3">
        <p className="m-0 text-body text-content-secondary">설치 후 운영에 필요한 현장, 층, 조명, 구역 정보를 관리합니다.</p>
        {settingsQuery.error && settingsQuery.data ? <StatusDetailButton label="운영 정보 갱신 실패"
          description="최신 운영 정보를 불러오지 못했습니다. 기존 정보를 표시합니다."
          action={{ label: "다시 시도", onClick: () => { void settingsQuery.refetch(); } }} /> : null}
      </div>

      {settingsQuery.isPending && !settingsQuery.data
        ? <FeedbackState tone="neutral" icon={Clock3} title="현장 운영 정보를 불러오는 중입니다." />
        : null}
      {settingsQuery.error && !settingsQuery.data ? (
        <FeedbackState tone="danger" icon={CircleAlert} title="현장 운영 정보를 불러오지 못했습니다." action={<Button type="button" onClick={() => void settingsQuery.refetch()}>다시 시도</Button>} />
      ) : null}

      {settingsQuery.data ? <>
        <div className="grid min-w-0 gap-5 tablet:grid-cols-2">
          <SiteInformationForm siteId={siteId} site={settingsQuery.data.site} />
          <Card className="grid content-start gap-4 p-5" role="region" aria-label="현장 구성">
            <h2 className="m-0 text-customer-section-title font-bold">현장 구성</h2>
            <dl className="grid grid-cols-2 gap-4">
              <div><dt className="text-body-sm text-content-secondary">운영 층</dt><dd className="m-0 text-customer-metric font-bold">{activeFloors.length}개</dd></div>
              <div><dt className="text-body-sm text-content-secondary">등록 조명</dt><dd className="m-0 text-customer-metric font-bold">{settingsQuery.data.floors.reduce((count, floor) => count + floor.fixtureCount, 0)}개</dd></div>
            </dl>
            <p className="m-0 text-body-sm text-content-secondary">운영 층 {activeFloors.length}개 · 보관 층 {settingsQuery.data.floors.length - activeFloors.length}개 · 등록 조명 {settingsQuery.data.floors.reduce((count, floor) => count + floor.fixtureCount, 0)}개</p>
          </Card>
        </div>
        {ownerUserId ? <BioSensorSettingsPanel key={siteId} siteId={siteId} ownerUserId={ownerUserId} canPrepare={canPrepare} /> : null}

        <section className="grid min-w-0 items-start gap-5 tablet:grid-cols-2" aria-label="층·구역 관리">
        <section className="grid min-w-0 gap-4 border-t border-border-default pt-6" aria-label="층 관리">
          <PageHeader variant="customer" title="층 관리" headingLevel={3} description="층의 운영 표시 정보와 보관 상태를 관리합니다."
            actions={<Button variant="primary" onClick={event => setFloorEditor({ id: "create", trigger: event.currentTarget })}><Plus size={16} aria-hidden="true" />층 추가</Button>} />
          {floorActionError ? (
            <FeedbackState tone="danger" icon={CircleAlert} title={floorActionError.title} action={<Button type="button" onClick={floorActionError.retry}>{floorActionError.retryLabel}</Button>} />
          ) : null}
          <CreateFloorForm siteId={siteId} nextDisplayOrder={settingsQuery.data.floors.length} isOpen={floorEditor?.id === "create"} trigger={floorEditor?.trigger ?? null} onClose={() => setFloorEditor(null)} />
          <DataGrid caption="층 목록" rows={settingsQuery.data.floors} getRowKey={floor => floor.id} variant="compact"
            columns={floorColumns(floor => setFloorEditor(floor), archiveMutation.isPending || restoreMutation.isPending,
              floor => { setFloorActionError(null); setFloorToArchive(floor); }, floor => { setFloorActionError(null); restoreMutation.mutate(floor); })} />
            {settingsQuery.data.floors.map((floor) => (
              <FloorRow
                key={floor.id}
                siteId={siteId}
                floor={floor}
                isOpen={floorEditor?.id === floor.id}
                trigger={floorEditor?.trigger ?? null}
                onClose={() => setFloorEditor(null)}
              />
            ))}
        </section>

        <FixtureGroupSection siteId={siteId} floors={settingsQuery.data.floors} />
        </section>

        <FixtureSection
          siteId={siteId}
          floors={activeFloors}
          selectedFloorId={selectedFloorId}
          onSelectedFloorIdChange={setSelectedFloorId}
        />
      </> : null}

      {floorToArchive ? (
        <ModalDialog
          role="alertdialog"
          title={`${floorToArchive.name} 층 보관`}
          description="보관한 층은 복구할 수 있습니다."
          isPending={archiveMutation.isPending}
          onClose={() => setFloorToArchive(null)}
          actions={<>
            <Button type="button" onClick={() => setFloorToArchive(null)}>취소</Button>
            <Button type="button" variant="danger" isLoading={archiveMutation.isPending} loadingLabel="보관 중" onClick={() => archiveMutation.mutate(floorToArchive)}>
              <Archive size={16} aria-hidden="true" /> 층 보관
            </Button>
          </>}
        >
          <p>조명과 활성 구역이 없는지 다시 확인한 뒤 보관하세요.</p>
        </ModalDialog>
      ) : null}
    </section>
  );
}

function SiteInformationForm({ siteId, site }: { siteId: string; site: SiteSettings }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState(site.name);
  const [address, setAddress] = useState(site.address ?? "");
  const [timeZone, setTimeZone] = useState(site.timeZone);
  const [tariffKwhRate, setTariffKwhRate] = useState(site.tariffKwhRate?.toString() ?? "");
  const [tariffKwhRateError, setTariffKwhRateError] = useState("");
  const [notice, setNotice] = useState("");
  const [actionError, setActionError] = useState<RetryableError | null>(null);
  const [editTrigger, setEditTrigger] = useState<HTMLElement | null>(null);
  const [isOpen, setIsOpen] = useState(false);

  useEffect(() => {
    setName(site.name);
    setAddress(site.address ?? "");
    setTimeZone(site.timeZone);
    setTariffKwhRate(site.tariffKwhRate?.toString() ?? "");
    setTariffKwhRateError("");
  }, [site]);

  const mutation = useMutation({
    mutationFn: (validatedTariffKwhRate: number) => updateSiteSettings(siteId, {
      expectedUpdatedAt: site.updatedAt,
      name: name.trim(),
      address: address.trim(),
      timeZone: timeZone.trim(),
      currency: "KRW",
      tariffKwhRate: validatedTariffKwhRate
    }),
    onSuccess: async () => {
      setActionError(null);
      setNotice("현장 정보를 저장했습니다.");
      setIsOpen(false);
      await invalidateSiteOperations(queryClient, siteId);
    },
    onError: (error, validatedTariffKwhRate) => {
      setNotice("");
      setActionError(isVersionConflict(error)
        ? staleSettingsError(queryClient, siteId, setActionError)
        : {
            title: "현장 정보를 저장하지 못했습니다. 입력값을 유지합니다.",
            retryLabel: "현장 정보 다시 저장",
            retry: () => mutation.mutate(validatedTariffKwhRate)
          });
    }
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    setNotice("");
    setActionError(null);
    const validation = validateDecimalDraft(tariffKwhRate, {
      requiredMessage: "kWh 단가를 입력하세요.",
      formatMessage: "kWh 단가는 소수점 둘째 자리까지 숫자로 입력하세요.",
      rangeMessage: "kWh 단가는 0 이상 99,999,999.99 이하로 입력하세요.",
      ...TARIFF_RATE_RANGE
    });
    if (!validation.ok) {
      setTariffKwhRateError(validation.error);
      return;
    }
    setTariffKwhRateError("");
    mutation.mutate(validation.value);
  }

  return (
    <section className="grid min-w-0 gap-4" aria-label="현장 정보">
      {notice ? <FeedbackState tone="success" icon={CheckCircle2} title={notice} /> : null}
      <Card className="p-5">
        <PageHeader variant="customer" title="현장 정보" headingLevel={2}
          actions={<Button onClick={event => { setEditTrigger(event.currentTarget); setIsOpen(true); }}>현장 정보 수정</Button>} />
        <dl className="m-0 grid gap-3 pt-4 text-body-sm">
          {[["현장 이름", site.name], ["주소", site.address ?? "미등록"], ["시간대", site.timeZone], ["통화", site.currency], ["kWh 단가", site.tariffKwhRate === null ? "미설정" : `${site.tariffKwhRate.toLocaleString("ko-KR")}원`]].map(([label, value]) =>
            <div key={label} className="flex min-w-0 justify-between gap-4 border-b border-border-default pb-3"><dt className="shrink-0 text-content-secondary">{label}</dt><dd className="m-0 break-words text-right">{value}</dd></div>)}
        </dl>
      </Card>
      <SiteInformationEditDialog isOpen={isOpen} pending={mutation.isPending} onClose={() => setIsOpen(false)} returnFocusElement={editTrigger}
        onSubmit={submit} values={{ name, address, timeZone, tariffKwhRate }} tariffError={tariffKwhRateError}
        onChange={(field, value) => {
          if (field === "name") setName(value);
          else if (field === "address") setAddress(value);
          else if (field === "timeZone") setTimeZone(value);
          else { setTariffKwhRate(value); setTariffKwhRateError(""); }
        }}>
        {actionError ? <FeedbackState tone="danger" icon={CircleAlert} title={actionError.title} action={<Button type="button" onClick={actionError.retry}>{actionError.retryLabel}</Button>} /> : null}
      </SiteInformationEditDialog>
    </section>
  );
}

function CreateFloorForm({ siteId, nextDisplayOrder, isOpen, trigger, onClose }: { siteId: string; nextDisplayOrder: number; isOpen: boolean; trigger: HTMLElement | null; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [level, setLevel] = useState("0");
  const [displayOrder, setDisplayOrder] = useState(String(nextDisplayOrder));
  const [actionError, setActionError] = useState<RetryableError | null>(null);
  const mutation = useMutation({
    mutationFn: () => createFloor(siteId, { name: name.trim(), level: Number(level), displayOrder: Number(displayOrder) }),
    onSuccess: async () => {
      setName("");
      setLevel("0");
      setDisplayOrder(String(nextDisplayOrder + 1));
      setActionError(null);
      onClose();
      await invalidateSiteOperations(queryClient, siteId);
    },
    onError: () => setActionError({
      title: "층을 추가하지 못했습니다. 입력값을 유지합니다.",
      retryLabel: "층 추가 다시 시도",
      retry: () => mutation.mutate()
    })
  });

  return (
    <FloorEditDialog isOpen={isOpen} pending={mutation.isPending} onClose={onClose} returnFocusElement={trigger}
      values={{ name, level, displayOrder }} onChange={(field, value) => { if (field === "name") setName(value); else if (field === "level") setLevel(value); else setDisplayOrder(value); }}
      onSubmit={event => { event.preventDefault(); setActionError(null); mutation.mutate(); }}>
      {actionError ? <FeedbackState tone="danger" icon={CircleAlert} title={actionError.title} action={<Button type="button" onClick={actionError.retry}>{actionError.retryLabel}</Button>} /> : null}
    </FloorEditDialog>
  );
}

function FloorRow({ siteId, floor, isOpen, trigger, onClose }: {
  siteId: string;
  floor: SiteSettingsFloor;
  isOpen: boolean;
  trigger: HTMLElement | null;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [name, setName] = useState(floor.name);
  const [level, setLevel] = useState(String(floor.level));
  const [displayOrder, setDisplayOrder] = useState(String(floor.displayOrder));
  const [actionError, setActionError] = useState<RetryableError | null>(null);
  const mutation = useMutation({
    mutationFn: () => updateFloor(siteId, floor.id, {
      expectedUpdatedAt: floor.updatedAt,
      name: name.trim(),
      level: Number(level),
      displayOrder: Number(displayOrder)
    }),
    onSuccess: async () => {
      setActionError(null);
      onClose();
      await invalidateSiteOperations(queryClient, siteId);
    },
    onError: (error) => setActionError(isVersionConflict(error)
      ? staleSettingsError(queryClient, siteId, setActionError)
      : {
          title: `${floor.name} 층 정보를 저장하지 못했습니다.`,
          retryLabel: "정보 저장 다시 시도",
          retry: () => mutation.mutate()
        })
  });

  useEffect(() => {
    setName(floor.name);
    setLevel(String(floor.level));
    setDisplayOrder(String(floor.displayOrder));
  }, [floor]);

  return (
    <FloorEditDialog isOpen={isOpen && floor.status === "active"} floorName={floor.name} pending={mutation.isPending} onClose={onClose} returnFocusElement={trigger}
      values={{ name, level, displayOrder }} onChange={(field, value) => { if (field === "name") setName(value); else if (field === "level") setLevel(value); else setDisplayOrder(value); }}
      onSubmit={event => { event.preventDefault(); setActionError(null); mutation.mutate(); }}>
      {actionError ? <FeedbackState tone="danger" icon={CircleAlert} title={actionError.title} action={<Button type="button" onClick={actionError.retry}>{actionError.retryLabel}</Button>} /> : null}
    </FloorEditDialog>
  );
}

function floorColumns(onEdit: (editor: { id: string; trigger: HTMLElement }) => void, busy: boolean,
  onArchive: (floor: SiteSettingsFloor) => void, onRestore: (floor: SiteSettingsFloor) => void): DataGridColumn<SiteSettingsFloor>[] {
  return [
    { id: "name", header: "층 이름", minWidth: 100, renderCell: floor => <strong>{floor.name}</strong> },
    { id: "level", header: "레벨 / 순서", minWidth: 100, renderCell: floor => `${floor.level} / ${floor.displayOrder}` },
    { id: "status", header: "상태", minWidth: 90, renderCell: floor => <StatusBadge tone={floor.status === "active" ? "success" : "neutral"} icon={floor.status === "active" ? CheckCircle2 : Archive}>{floor.status === "active" ? "운영 중" : "보관됨"}</StatusBadge> },
    { id: "count", header: "구성", minWidth: 160, renderCell: floor => <span>{floor.fixtureCount > 0 || floor.activeGroupCount > 0
      ? `조명 ${floor.fixtureCount}개와 활성 구역 ${floor.activeGroupCount}개가 있어 보관할 수 없습니다.`
      : `조명 ${floor.fixtureCount}개 · 활성 구역 ${floor.activeGroupCount}개`}</span> },
    { id: "actions", header: "작업", minWidth: 120, renderCell: floor => <div className="flex flex-wrap gap-2">{floor.status === "active" ? <>
      <Button aria-label={`${floor.name} 수정`} disabled={busy} variant="ghost" onClick={event => onEdit({ id: floor.id, trigger: event.currentTarget })}>수정</Button>
      <Button aria-label={`${floor.name} 보관`} disabled={busy || floor.fixtureCount > 0 || floor.activeGroupCount > 0} variant="danger" onClick={() => onArchive(floor)}>보관</Button>
    </> : <Button aria-label={`${floor.name} 복구`} disabled={busy} onClick={() => onRestore(floor)}><RotateCcw size={16} aria-hidden="true" />복구</Button>}</div> }
  ];
}

function FixtureSection({ siteId, floors, selectedFloorId, onSelectedFloorIdChange }: {
  siteId: string;
  floors: SiteSettingsFloor[];
  selectedFloorId: string;
  onSelectedFloorIdChange: (floorId: string) => void;
}) {
  const fixturesQuery = useInfiniteQuery({
    queryKey: floorFixtureSettingsQueryKey(siteId, selectedFloorId),
    queryFn: ({ pageParam }) => getFloorFixtureSettings(siteId, selectedFloorId, pageParam || undefined),
    initialPageParam: "",
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    enabled: Boolean(selectedFloorId)
  });
  const fixtures = useMemo(
    () => fixturesQuery.data?.pages.flatMap((page) => page.items) ?? [],
    [fixturesQuery.data?.pages]
  );

  return (
    <section className="grid gap-4 border-t border-border-default pt-6" aria-label="조명 관리">
      <PageHeader
        title="조명 관리"
        headingLevel={3}
        description="이름과 정격전력만 수정합니다. 위치와 크기는 맵 관리에서 조정합니다."
        actions={<div className="flex flex-wrap items-end gap-2">
          {fixturesQuery.error && fixtures.length > 0 ? <StatusDetailButton label="조명 목록 갱신 실패"
            description="다음 조명 목록을 불러오지 못했습니다. 기존 목록을 표시합니다."
            action={{ label: "다음 목록 다시 시도", onClick: () => { void fixturesQuery.fetchNextPage(); } }} /> : null}
          {floors.length > 0 ? <SelectBox aria-label="조명 층 선택" label="층 선택" className="min-w-48" items={floors.map((floor) => ({ id: floor.id, label: floor.name }))} selectedKey={selectedFloorId || null} onSelectionChange={(floorId) => { if (floorId) onSelectedFloorIdChange(floorId); }} /> : null}
        </div>}
      />
      {floors.length === 0 ? <FeedbackState tone="neutral" icon={Lightbulb} title="조명을 조회할 운영 중인 층이 없습니다." /> : null}
      {fixturesQuery.isPending && selectedFloorId ? <FeedbackState tone="neutral" icon={Clock3} title="조명 목록을 불러오는 중입니다." /> : null}
      {fixturesQuery.error && fixtures.length === 0 ? <FeedbackState tone="danger" icon={CircleAlert} title="조명 목록을 불러오지 못했습니다." action={<Button type="button" onClick={() => void fixturesQuery.refetch()}>조명 목록 다시 시도</Button>} /> : null}
      {!fixturesQuery.isPending && !fixturesQuery.error && selectedFloorId && fixtures.length === 0 ? <FeedbackState tone="neutral" icon={Lightbulb} title="이 층에 등록된 조명이 없습니다." /> : null}
      {fixtures.length > 0 ? <div className="grid gap-3" aria-label="조명 목록">
        {fixtures.map((fixture) => <FixtureRow key={fixture.id} siteId={siteId} floorId={selectedFloorId} fixture={fixture} />)}
      </div> : null}
      {fixturesQuery.hasNextPage ? <div className="flex flex-wrap items-center justify-between gap-3">
        <span>{fixtures.length}개 불러옴</span>
        <Button type="button" isLoading={fixturesQuery.isFetchingNextPage} loadingLabel="불러오는 중" onClick={() => void fixturesQuery.fetchNextPage()}>다음 200개 불러오기</Button>
      </div> : null}
    </section>
  );
}

function FixtureRow({ siteId, floorId, fixture }: { siteId: string; floorId: string; fixture: FixtureSettingsItem }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState(fixture.name);
  const [ratedWatt, setRatedWatt] = useState(String(fixture.ratedWatt));
  const [ratedWattError, setRatedWattError] = useState("");
  const [actionError, setActionError] = useState<RetryableError | null>(null);
  const mutation = useMutation({
    mutationFn: (validatedRatedWatt: number) => updateFixtureMetadata(siteId, floorId, fixture.id, {
      expectedUpdatedAt: fixture.updatedAt,
      name: name.trim(),
      ratedWatt: validatedRatedWatt
    }),
    onSuccess: async () => {
      setActionError(null);
      await invalidateSiteOperations(queryClient, siteId);
    },
    onError: (error, validatedRatedWatt) => setActionError(isVersionConflict(error)
      ? {
          title: `${fixture.name} 조명 정보가 다른 작업에서 변경되었습니다.`,
          retryLabel: "최신 정보 불러오기",
          retry: () => {
            setActionError(null);
            void queryClient.invalidateQueries({ queryKey: floorFixtureSettingsQueryKey(siteId, floorId) });
          }
        }
      : {
          title: `${fixture.name} 조명 정보를 저장하지 못했습니다. 입력값을 유지합니다.`,
          retryLabel: "조명 정보 다시 저장",
          retry: () => mutation.mutate(validatedRatedWatt)
        })
  });
  const identities = [
    ["시리얼", fixture.serialNumber],
    ["Mesh 주소", fixture.meshAddress],
    ["펌웨어", fixture.firmwareVersion]
  ].filter((entry): entry is [string, string] => Boolean(entry[1]));

  useEffect(() => {
    setName(fixture.name);
    setRatedWatt(String(fixture.ratedWatt));
    setRatedWattError("");
  }, [fixture]);

  function submit(event: FormEvent) {
    event.preventDefault();
    setActionError(null);
    const validation = validateDecimalDraft(ratedWatt, {
      requiredMessage: "정격전력을 입력하세요.",
      formatMessage: "정격전력은 소수점 둘째 자리까지 숫자로 입력하세요.",
      rangeMessage: "정격전력은 0.01 이상 999,999.99 이하로 입력하세요.",
      ...RATED_WATT_RANGE
    });
    if (!validation.ok) {
      setRatedWattError(validation.error);
      return;
    }
    setRatedWattError("");
    mutation.mutate(validation.value);
  }

  return (
    <Card className="grid gap-4 p-5">
      <div className="flex items-center justify-between gap-3"><strong>{fixture.name}</strong></div>
      {identities.length > 0 ? <dl className="flex flex-wrap gap-4 text-caption text-content-secondary">
        {identities.map(([label, value]) => <div className="flex gap-2" key={label}><dt>{label}</dt><dd className="m-0 font-bold text-content-primary">{value}</dd></div>)}
      </dl> : null}
      {actionError ? <FeedbackState tone="danger" icon={CircleAlert} title={actionError.title} action={<Button type="button" onClick={actionError.retry}>{actionError.retryLabel}</Button>} /> : null}
      <form aria-label={`${fixture.name} 조명 정보 수정`} className="grid gap-4 tablet:grid-cols-[2fr_1fr_auto] tablet:items-end" onSubmit={submit}>
        <TextField aria-label={`${fixture.name} 이름`} label="이름" isRequired maxLength={120} value={name} onChange={setName} />
        <TextField
          aria-label={`${fixture.name} 정격전력`}
          label="정격전력 (W)"
          isRequired
          inputMode="decimal"
          validationBehavior="aria"
          isInvalid={Boolean(ratedWattError)}
          errorMessage={ratedWattError}
          value={ratedWatt}
          onChange={(value) => {
            setRatedWatt(value);
            if (ratedWattError) setRatedWattError("");
          }}
        />
        <div className="flex items-end">
          <Button type="submit" isLoading={mutation.isPending} loadingLabel="저장 중"><Save size={16} aria-hidden="true" /> {fixture.name} 조명 정보 저장</Button>
        </div>
      </form>
    </Card>
  );
}

function FixtureGroupSection({ siteId, floors }: { siteId: string; floors: SiteSettingsFloor[] }) {
  const queryClient = useQueryClient();
  const groupsQuery = useQuery({ queryKey: fixtureGroupQueryKey(siteId), queryFn: () => listFixtureGroups(siteId) });
  const [groupToArchive, setGroupToArchive] = useState<FixtureGroupMetadata | null>(null);
  const [actionError, setActionError] = useState<RetryableError | null>(null);
  const floorNames = useMemo(() => new Map(floors.map((floor) => [floor.id, floor.name])), [floors]);
  const mutation = useMutation({
    mutationFn: (group: FixtureGroupMetadata) => deleteFixtureGroup(siteId, group.id),
    onSuccess: async () => {
      setGroupToArchive(null);
      setActionError(null);
      await invalidateSiteOperations(queryClient, siteId);
    },
    onError: (_error, group) => {
      setGroupToArchive(null);
      setActionError({
        title: "구역을 보관 상태로 전환하지 못했습니다.",
        retryLabel: "구역 보관 다시 시도",
        retry: () => mutation.mutate(group)
      });
    }
  });

  return (
    <section className="grid gap-4 border-t border-border-default pt-6" aria-label="구역 관리">
      <PageHeader title="구역 관리" headingLevel={3} description="구역 구성은 맵 관리에서, 실제 조명 제어는 제어 화면에서 수행합니다. 여기서는 목록을 확인하고 보관을 시작할 수 있습니다."
        actions={groupsQuery.error && groupsQuery.data ? <StatusDetailButton label="구역 목록 갱신 실패"
          description="최신 구역 목록을 불러오지 못했습니다. 기존 목록을 표시합니다."
          action={{ label: "구역 목록 다시 시도", onClick: () => { void groupsQuery.refetch(); } }} /> : null} />
      {actionError ? <FeedbackState tone="danger" icon={CircleAlert} title={actionError.title} action={<Button type="button" onClick={actionError.retry}>{actionError.retryLabel}</Button>} /> : null}
      {groupsQuery.isPending ? <FeedbackState tone="neutral" icon={Clock3} title="구역 목록을 불러오는 중입니다." /> : null}
      {groupsQuery.error && !groupsQuery.data ? <FeedbackState tone="danger" icon={CircleAlert} title="구역 목록을 불러오지 못했습니다." action={<Button type="button" onClick={() => void groupsQuery.refetch()}>구역 목록 다시 시도</Button>} /> : null}
      {groupsQuery.data?.length === 0 ? <FeedbackState tone="neutral" icon={Network} title="등록된 구역이 없습니다." /> : null}
      {groupsQuery.data?.length ? <div className="grid gap-3" aria-label="구역 목록">
        {groupsQuery.data.map((group) => (
          <Card className="grid gap-4 p-5" key={group.id}>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="grid gap-1"><strong>{group.name}</strong><span className="text-caption text-content-secondary">{group.floorId ? floorNames.get(group.floorId) ?? "알 수 없는 층" : "층 미지정"}</span></div>
              <StatusBadge tone={groupTone(group.lifecycleStatus)} icon={group.lifecycleStatus === "active" ? CheckCircle2 : Archive}>{groupStatusLabel(group.lifecycleStatus)}</StatusBadge>
            </div>
            <div className="flex flex-wrap gap-4 text-caption text-content-secondary"><span>조명 {group.fixtureCount}개</span><span>Mesh 상태 {meshStatusLabel(group.meshControlGroup?.status)}</span></div>
            {group.lifecycleStatus === "active" ? <div className="flex justify-end">
              <Button type="button" variant="danger" aria-label={`${group.name} 보관`} onClick={() => { setActionError(null); setGroupToArchive(group); }}><Archive size={16} aria-hidden="true" /> 보관</Button>
            </div> : null}
          </Card>
        ))}
      </div> : null}
      {groupToArchive ? (
        <ModalDialog
          role="alertdialog"
          title={`${groupToArchive.name} 구역 보관`}
          description="구역은 retiring 상태로 전환되며 장비 동기화가 이어집니다."
          isPending={mutation.isPending}
          onClose={() => setGroupToArchive(null)}
          actions={<>
            <Button type="button" onClick={() => setGroupToArchive(null)}>취소</Button>
            <Button type="button" variant="danger" isLoading={mutation.isPending} loadingLabel="보관 중" onClick={() => mutation.mutate(groupToArchive)}><Archive size={16} aria-hidden="true" /> 구역 보관</Button>
          </>}
        >
          <p>이 작업은 구역을 목록에서 즉시 삭제하지 않고 안전하게 보관 상태로 전환합니다.</p>
        </ModalDialog>
      ) : null}
    </section>
  );
}

function invalidateSiteOperations(queryClient: QueryClient, siteId: string) {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: siteSettingsQueryKey(siteId) }),
    queryClient.invalidateQueries({ queryKey: ["dashboard", siteId] }),
    queryClient.invalidateQueries({ queryKey: floorFixturesQueryKey(siteId) }),
    queryClient.invalidateQueries({ queryKey: floorFixtureSettingsQueryKey(siteId) }),
    queryClient.invalidateQueries({ queryKey: fixtureGroupQueryKey(siteId) })
  ]);
}

function isVersionConflict(error: unknown) {
  return error instanceof ApiError
    && error.status === 409
    && (error.body as { code?: string } | null)?.code === "settings_version_conflict";
}

function isConflict(error: unknown) {
  return error instanceof ApiError && error.status === 409;
}

function staleSettingsError(
  queryClient: QueryClient,
  siteId: string,
  clearError: (error: RetryableError | null) => void
): RetryableError {
  return {
    title: "설정이 다른 작업에서 변경되었습니다. 최신 정보를 확인한 뒤 다시 시도하세요.",
    retryLabel: "최신 정보 불러오기",
    retry: () => {
      clearError(null);
      void queryClient.invalidateQueries({ queryKey: siteSettingsQueryKey(siteId) });
    }
  };
}

function groupTone(status: FixtureGroupMetadata["lifecycleStatus"]) {
  if (status === "active") return "success" as const;
  if (status === "invalid") return "danger" as const;
  return "warning" as const;
}

function groupStatusLabel(status: FixtureGroupMetadata["lifecycleStatus"]) {
  return { active: "활성", retiring: "보관 중", retired: "보관됨", invalid: "오류" }[status];
}

function meshStatusLabel(status: "configuring" | "ready" | "failed" | "retiring" | "retired" | undefined) {
  if (!status) return "없음";
  return { configuring: "구성 중", ready: "준비됨", failed: "오류", retiring: "해제 중", retired: "해제됨" }[status];
}

function validateDecimalDraft(value: string, constraints: {
  min: number;
  max: number;
  requiredMessage: string;
  formatMessage: string;
  rangeMessage: string;
}): { ok: true; value: number } | { ok: false; error: string } {
  const draft = value.trim();
  if (!draft) return { ok: false, error: constraints.requiredMessage };
  if (!/^\d+(?:\.\d{1,2})?$/.test(draft)) return { ok: false, error: constraints.formatMessage };

  const parsed = Number(draft);
  if (!Number.isFinite(parsed)) return { ok: false, error: constraints.formatMessage };
  if (parsed < constraints.min || parsed > constraints.max) {
    return { ok: false, error: constraints.rangeMessage };
  }
  return { ok: true, value: parsed };
}
