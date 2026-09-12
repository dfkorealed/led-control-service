import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
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
import { Button, Card, FeedbackState, ModalDialog, PageHeader, StatusBadge } from "../../../components/ui";
import "./SiteOperationsView.css";

interface RetryableError {
  title: string;
  retryLabel: string;
  retry: () => void;
}

export function SiteOperationsView({ siteId }: { siteId?: string }) {
  const queryClient = useQueryClient();
  const settingsQuery = useQuery({
    queryKey: siteSettingsQueryKey(siteId ?? "unselected"),
    queryFn: () => getSiteSettings(siteId!),
    enabled: Boolean(siteId)
  });
  const [selectedFloorId, setSelectedFloorId] = useState("");
  const [floorToArchive, setFloorToArchive] = useState<SiteSettingsFloor | null>(null);
  const [floorActionError, setFloorActionError] = useState<RetryableError | null>(null);
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
    <section className="settings-screen site-operations-screen" aria-label="현장 관리">
      <PageHeader title="현장 관리" description="설치 후 운영에 필요한 현장, 층, 조명, 구역 정보를 관리합니다." />

      {settingsQuery.isPending && !settingsQuery.data
        ? <FeedbackState tone="neutral" icon={Clock3} title="현장 운영 정보를 불러오는 중입니다." />
        : null}
      {settingsQuery.error && !settingsQuery.data ? (
        <FeedbackState tone="danger" icon={CircleAlert} title="현장 운영 정보를 불러오지 못했습니다." action={<Button type="button" onClick={() => void settingsQuery.refetch()}>다시 시도</Button>} />
      ) : null}
      {settingsQuery.error && settingsQuery.data ? (
        <FeedbackState tone="danger" icon={CircleAlert} title="최신 운영 정보를 불러오지 못했습니다. 기존 정보를 표시합니다." action={<Button type="button" onClick={() => void settingsQuery.refetch()}>다시 시도</Button>} />
      ) : null}

      {settingsQuery.data ? <>
        <SiteInformationForm siteId={siteId} site={settingsQuery.data.site} />

        <section className="site-operations-section" aria-label="층 관리">
          <PageHeader title="층 관리" headingLevel={3} description="층의 운영 표시 정보와 보관 상태를 관리합니다." />
          {floorActionError ? (
            <FeedbackState tone="danger" icon={CircleAlert} title={floorActionError.title} action={<Button type="button" onClick={floorActionError.retry}>{floorActionError.retryLabel}</Button>} />
          ) : null}
          <CreateFloorForm siteId={siteId} nextDisplayOrder={settingsQuery.data.floors.length} />
          <div className="site-operations-list" aria-label="층 목록">
            {settingsQuery.data.floors.map((floor) => (
              <FloorRow
                key={floor.id}
                siteId={siteId}
                floor={floor}
                busy={archiveMutation.isPending || restoreMutation.isPending}
                onArchive={() => {
                  setFloorActionError(null);
                  setFloorToArchive(floor);
                }}
                onRestore={() => {
                  setFloorActionError(null);
                  restoreMutation.mutate(floor);
                }}
              />
            ))}
          </div>
        </section>

        <FixtureSection
          siteId={siteId}
          floors={activeFloors}
          selectedFloorId={selectedFloorId}
          onSelectedFloorIdChange={setSelectedFloorId}
        />
        <FixtureGroupSection siteId={siteId} floors={settingsQuery.data.floors} />
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
  const [currency, setCurrency] = useState(site.currency);
  const [tariffKwhRate, setTariffKwhRate] = useState(site.tariffKwhRate?.toString() ?? "");
  const [notice, setNotice] = useState("");
  const [actionError, setActionError] = useState<RetryableError | null>(null);

  useEffect(() => {
    setName(site.name);
    setAddress(site.address ?? "");
    setTimeZone(site.timeZone);
    setCurrency(site.currency);
    setTariffKwhRate(site.tariffKwhRate?.toString() ?? "");
  }, [site]);

  const mutation = useMutation({
    mutationFn: () => updateSiteSettings(siteId, {
      expectedUpdatedAt: site.updatedAt,
      name: name.trim(),
      address: address.trim() || null,
      timeZone: timeZone.trim(),
      currency,
      tariffKwhRate: tariffKwhRate === "" ? null : Number(tariffKwhRate)
    }),
    onSuccess: async () => {
      setActionError(null);
      setNotice("현장 정보를 저장했습니다.");
      await invalidateSiteOperations(queryClient, siteId);
    },
    onError: (error) => {
      setNotice("");
      setActionError(isVersionConflict(error)
        ? staleSettingsError(queryClient, siteId, setActionError)
        : {
            title: "현장 정보를 저장하지 못했습니다. 입력값을 유지합니다.",
            retryLabel: "현장 정보 다시 저장",
            retry: () => mutation.mutate()
          });
    }
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    setNotice("");
    setActionError(null);
    mutation.mutate();
  }

  return (
    <section className="site-operations-section" aria-label="현장 정보">
      <PageHeader title="현장 정보" headingLevel={3} description="요금 계산과 현장 시간 기준에 사용하는 기본 정보입니다." />
      {notice ? <FeedbackState tone="success" icon={CheckCircle2} title={notice} /> : null}
      {actionError ? <FeedbackState tone="danger" icon={CircleAlert} title={actionError.title} action={<Button type="button" onClick={actionError.retry}>{actionError.retryLabel}</Button>} /> : null}
      <Card className="site-operations-card">
        <form aria-label="현장 정보" className="site-operations-form site-information-grid" onSubmit={submit}>
          <Field label="현장명"><input required maxLength={120} value={name} onChange={(event) => setName(event.target.value)} /></Field>
          <Field label="주소" className="site-address-field"><input maxLength={500} value={address} onChange={(event) => setAddress(event.target.value)} /></Field>
          <Field label="시간대"><input required maxLength={100} value={timeZone} onChange={(event) => setTimeZone(event.target.value)} /></Field>
          <Field label="통화"><input required inputMode="text" minLength={3} maxLength={3} pattern="[A-Z]{3}" value={currency} onChange={(event) => setCurrency(event.target.value.toUpperCase())} /></Field>
          <Field label="kWh 단가"><input type="number" min="0" max="99999999.99" step="0.01" value={tariffKwhRate} onChange={(event) => setTariffKwhRate(event.target.value)} /></Field>
          <div className="site-operations-form-actions">
            <Button type="submit" variant="primary" isLoading={mutation.isPending} loadingLabel="저장 중"><Save size={16} aria-hidden="true" /> 현장 정보 저장</Button>
          </div>
        </form>
      </Card>
    </section>
  );
}

function CreateFloorForm({ siteId, nextDisplayOrder }: { siteId: string; nextDisplayOrder: number }) {
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
      await invalidateSiteOperations(queryClient, siteId);
    },
    onError: () => setActionError({
      title: "층을 추가하지 못했습니다. 입력값을 유지합니다.",
      retryLabel: "층 추가 다시 시도",
      retry: () => mutation.mutate()
    })
  });

  return (
    <Card className="site-operations-card floor-create-card">
      {actionError ? <FeedbackState tone="danger" icon={CircleAlert} title={actionError.title} action={<Button type="button" onClick={actionError.retry}>{actionError.retryLabel}</Button>} /> : null}
      <form aria-label="층 추가" className="site-operations-form floor-form-grid" onSubmit={(event) => { event.preventDefault(); setActionError(null); mutation.mutate(); }}>
        <Field label="새 층 이름"><input required maxLength={120} value={name} onChange={(event) => setName(event.target.value)} /></Field>
        <Field label="새 층 레벨"><input required type="number" step="1" value={level} onChange={(event) => setLevel(event.target.value)} /></Field>
        <Field label="새 층 표시 순서"><input required type="number" min="0" step="1" value={displayOrder} onChange={(event) => setDisplayOrder(event.target.value)} /></Field>
        <div className="site-operations-form-actions">
          <Button type="submit" variant="primary" isLoading={mutation.isPending} loadingLabel="추가 중"><Plus size={16} aria-hidden="true" /> 층 추가</Button>
        </div>
      </form>
    </Card>
  );
}

function FloorRow({ siteId, floor, busy, onArchive, onRestore }: {
  siteId: string;
  floor: SiteSettingsFloor;
  busy: boolean;
  onArchive: () => void;
  onRestore: () => void;
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
  const archiveBlocked = floor.fixtureCount > 0 || floor.activeGroupCount > 0;

  useEffect(() => {
    setName(floor.name);
    setLevel(String(floor.level));
    setDisplayOrder(String(floor.displayOrder));
  }, [floor]);

  return (
    <Card className="site-operations-card floor-row-card" data-status={floor.status}>
      <div className="site-operations-row-heading">
        <strong>{floor.name}</strong>
        <StatusBadge tone={floor.status === "active" ? "success" : "neutral"} icon={floor.status === "active" ? CheckCircle2 : Archive}>
          {floor.status === "active" ? "운영 중" : "보관됨"}
        </StatusBadge>
      </div>
      {actionError ? <FeedbackState tone="danger" icon={CircleAlert} title={actionError.title} action={<Button type="button" onClick={actionError.retry}>{actionError.retryLabel}</Button>} /> : null}
      <form aria-label={`${floor.name} 층 정보 수정`} className="site-operations-form floor-form-grid" onSubmit={(event) => { event.preventDefault(); setActionError(null); mutation.mutate(); }}>
        <Field label="이름"><input aria-label={`${floor.name} 이름`} required maxLength={120} disabled={floor.status === "archived"} value={name} onChange={(event) => setName(event.target.value)} /></Field>
        <Field label="레벨"><input aria-label={`${floor.name} 레벨`} required type="number" step="1" disabled={floor.status === "archived"} value={level} onChange={(event) => setLevel(event.target.value)} /></Field>
        <Field label="표시 순서"><input aria-label={`${floor.name} 표시 순서`} required type="number" min="0" step="1" disabled={floor.status === "archived"} value={displayOrder} onChange={(event) => setDisplayOrder(event.target.value)} /></Field>
        <div className="site-operations-form-actions floor-row-actions">
          {floor.status === "active" ? <>
            <Button type="submit" isLoading={mutation.isPending} loadingLabel="저장 중" disabled={busy}><Save size={16} aria-hidden="true" /> {floor.name} 층 정보 저장</Button>
            <Button type="button" variant="danger" aria-label={`${floor.name} 보관`} disabled={archiveBlocked || busy || mutation.isPending} onClick={onArchive}><Archive size={16} aria-hidden="true" /> 보관</Button>
          </> : (
            <Button type="button" aria-label={`${floor.name} 복구`} disabled={busy} onClick={onRestore}><RotateCcw size={16} aria-hidden="true" /> 복구</Button>
          )}
        </div>
      </form>
      <p className={archiveBlocked ? "site-operations-block-reason" : "site-operations-counts"}>
        {archiveBlocked
          ? `조명 ${floor.fixtureCount}개와 활성 구역 ${floor.activeGroupCount}개가 있어 보관할 수 없습니다.`
          : `조명 ${floor.fixtureCount}개 · 활성 구역 ${floor.activeGroupCount}개`}
      </p>
    </Card>
  );
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
    <section className="site-operations-section" aria-label="조명 관리">
      <PageHeader
        title="조명 관리"
        headingLevel={3}
        description="이름과 정격전력만 수정합니다. 위치와 크기는 맵 관리에서 조정합니다."
        actions={floors.length > 0 ? (
          <label className="site-operations-floor-select"><span>층 선택</span>
            <select aria-label="조명 층 선택" value={selectedFloorId} onChange={(event) => onSelectedFloorIdChange(event.target.value)}>
              {floors.map((floor) => <option key={floor.id} value={floor.id}>{floor.name}</option>)}
            </select>
          </label>
        ) : null}
      />
      {floors.length === 0 ? <FeedbackState tone="neutral" icon={Lightbulb} title="조명을 조회할 운영 중인 층이 없습니다." /> : null}
      {fixturesQuery.isPending && selectedFloorId ? <FeedbackState tone="neutral" icon={Clock3} title="조명 목록을 불러오는 중입니다." /> : null}
      {fixturesQuery.error && fixtures.length === 0 ? <FeedbackState tone="danger" icon={CircleAlert} title="조명 목록을 불러오지 못했습니다." action={<Button type="button" onClick={() => void fixturesQuery.refetch()}>조명 목록 다시 시도</Button>} /> : null}
      {fixturesQuery.error && fixtures.length > 0 ? <FeedbackState tone="danger" icon={CircleAlert} title="다음 조명 목록을 불러오지 못했습니다. 기존 목록을 표시합니다." action={<Button type="button" onClick={() => void fixturesQuery.fetchNextPage()}>다음 목록 다시 시도</Button>} /> : null}
      {!fixturesQuery.isPending && !fixturesQuery.error && selectedFloorId && fixtures.length === 0 ? <FeedbackState tone="neutral" icon={Lightbulb} title="이 층에 등록된 조명이 없습니다." /> : null}
      {fixtures.length > 0 ? <div className="site-operations-list fixture-list" aria-label="조명 목록">
        {fixtures.map((fixture) => <FixtureRow key={fixture.id} siteId={siteId} floorId={selectedFloorId} fixture={fixture} />)}
      </div> : null}
      {fixturesQuery.hasNextPage ? <div className="site-operations-pagination">
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
  const [actionError, setActionError] = useState<RetryableError | null>(null);
  const mutation = useMutation({
    mutationFn: () => updateFixtureMetadata(siteId, floorId, fixture.id, {
      expectedUpdatedAt: fixture.updatedAt,
      name: name.trim(),
      ratedWatt: Number(ratedWatt)
    }),
    onSuccess: async () => {
      setActionError(null);
      await invalidateSiteOperations(queryClient, siteId);
    },
    onError: (error) => setActionError(isVersionConflict(error)
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
          retry: () => mutation.mutate()
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
  }, [fixture]);

  return (
    <Card className="site-operations-card fixture-row-card">
      <div className="site-operations-row-heading"><strong>{fixture.name}</strong></div>
      {identities.length > 0 ? <dl className="fixture-identities">
        {identities.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
      </dl> : null}
      {actionError ? <FeedbackState tone="danger" icon={CircleAlert} title={actionError.title} action={<Button type="button" onClick={actionError.retry}>{actionError.retryLabel}</Button>} /> : null}
      <form aria-label={`${fixture.name} 조명 정보 수정`} className="site-operations-form fixture-form-grid" onSubmit={(event) => { event.preventDefault(); setActionError(null); mutation.mutate(); }}>
        <Field label="이름"><input aria-label={`${fixture.name} 이름`} required maxLength={120} value={name} onChange={(event) => setName(event.target.value)} /></Field>
        <Field label="정격전력 (W)"><input aria-label={`${fixture.name} 정격전력`} required type="number" min="0.01" max="999999.99" step="0.01" value={ratedWatt} onChange={(event) => setRatedWatt(event.target.value)} /></Field>
        <div className="site-operations-form-actions">
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
    <section className="site-operations-section" aria-label="구역 관리">
      <PageHeader title="구역 관리" headingLevel={3} description="구역 구성은 맵 관리에서, 실제 조명 제어는 제어 화면에서 수행합니다. 여기서는 목록을 확인하고 보관을 시작할 수 있습니다." />
      {actionError ? <FeedbackState tone="danger" icon={CircleAlert} title={actionError.title} action={<Button type="button" onClick={actionError.retry}>{actionError.retryLabel}</Button>} /> : null}
      {groupsQuery.isPending ? <FeedbackState tone="neutral" icon={Clock3} title="구역 목록을 불러오는 중입니다." /> : null}
      {groupsQuery.error && !groupsQuery.data ? <FeedbackState tone="danger" icon={CircleAlert} title="구역 목록을 불러오지 못했습니다." action={<Button type="button" onClick={() => void groupsQuery.refetch()}>구역 목록 다시 시도</Button>} /> : null}
      {groupsQuery.error && groupsQuery.data ? <FeedbackState tone="danger" icon={CircleAlert} title="최신 구역 목록을 불러오지 못했습니다. 기존 목록을 표시합니다." action={<Button type="button" onClick={() => void groupsQuery.refetch()}>구역 목록 다시 시도</Button>} /> : null}
      {groupsQuery.data?.length === 0 ? <FeedbackState tone="neutral" icon={Network} title="등록된 구역이 없습니다." /> : null}
      {groupsQuery.data?.length ? <div className="site-operations-list group-list" aria-label="구역 목록">
        {groupsQuery.data.map((group) => (
          <Card className="site-operations-card group-row-card" key={group.id}>
            <div className="site-operations-row-heading">
              <div><strong>{group.name}</strong><span>{group.floorId ? floorNames.get(group.floorId) ?? "알 수 없는 층" : "층 미지정"}</span></div>
              <StatusBadge tone={groupTone(group.lifecycleStatus)} icon={group.lifecycleStatus === "active" ? CheckCircle2 : Archive}>{groupStatusLabel(group.lifecycleStatus)}</StatusBadge>
            </div>
            <div className="group-row-details"><span>조명 {group.fixtureCount}개</span><span>Mesh 상태 {meshStatusLabel(group.meshControlGroup?.status)}</span></div>
            {group.lifecycleStatus === "active" ? <div className="site-operations-form-actions">
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

function Field({ label, className = "", children }: { label: string; className?: string; children: ReactNode }) {
  return <label className={`site-operations-field ${className}`.trim()}><span>{label}</span>{children}</label>;
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
