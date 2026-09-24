import { useMutation, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Clock3, Wand2 } from "lucide-react";
import { useMemo, useState } from "react";
import { createInitialSiteSetup, type InitialFloorInput } from "../../api/setup";
import { Button, Card, ConfirmDialog, FeedbackState, NumberField, ProgressSteps, SelectBox, StatusBadge, TextField } from "../../components/ui";

interface SetupWizardProps {
  siteId: string;
  customerName: string;
  siteName: string;
  onComplete?: () => void;
}

const MAX_FLOOR_COUNT = 20;
const MAX_TARIFF_KWH_RATE = 100000;

export function SetupWizard({ siteId, customerName, siteName, onComplete }: SetupWizardProps) {
  const queryClient = useQueryClient();
  const [address, setAddress] = useState("");
  const [tariffKwhRate, setTariffKwhRate] = useState("160");
  const [timeZone, setTimeZone] = useState("Asia/Seoul");
  const [basementCount, setBasementCount] = useState("2");
  const [groundCount, setGroundCount] = useState("0");
  const [floors, setFloors] = useState<InitialFloorInput[]>(buildFloors(2, 0));
  const [lastGeneratedFloors, setLastGeneratedFloors] = useState<InitialFloorInput[]>(buildFloors(2, 0));
  const [pendingGeneratedFloors, setPendingGeneratedFloors] = useState<InitialFloorInput[] | null>(null);
  const [successMessage, setSuccessMessage] = useState("");

  const validationMessage = useMemo(() => {
    const tariff = Number(tariffKwhRate);
    const basement = parseCount(basementCount);
    const ground = parseCount(groundCount);
    const floorNames = floors.map((floor) => floor.name.trim()).filter(Boolean);
    const floorLevels = floors.map((floor) => floor.level);

    if (!address.trim()) return "주소를 입력하세요.";
    if (!Number.isFinite(tariff) || tariff <= 0 || tariff > MAX_TARIFF_KWH_RATE) {
      return `kWh 단가는 0보다 큰 ${MAX_TARIFF_KWH_RATE} 이하의 숫자여야 합니다.`;
    }
    if (!isValidTimeZone(timeZone)) return "유효한 시간대를 선택하세요.";
    if (!isValidFloorCount(basement) || !isValidFloorCount(ground)) {
      return `층수는 지하와 지상 각각 ${MAX_FLOOR_COUNT}층 이하의 숫자여야 합니다.`;
    }
    if (floors.length === 0) return "층을 1개 이상 생성하세요.";
    if (floors.filter((floor) => floor.level < 0).length !== basement
      || floors.filter((floor) => floor.level > 0).length !== ground
      || floors.length !== basement + ground) {
      return "층수와 층 목록이 일치하지 않습니다. 층을 다시 생성하세요.";
    }
    if (floors.some((floor) => !floor.name.trim())) return "층 이름을 입력하세요.";
    if (floors.some((floor) => !Number.isInteger(floor.level) || floor.level === 0)) {
      return "층 level은 0이 아닌 정수여야 합니다.";
    }
    if (new Set(floorNames).size !== floorNames.length) return "층 이름은 중복될 수 없습니다.";
    if (new Set(floorLevels).size !== floorLevels.length) return "층 level은 중복될 수 없습니다.";
    return "";
  }, [address, basementCount, floors, groundCount, tariffKwhRate, timeZone]);

  const setupMutation = useMutation({
    mutationFn: () =>
      createInitialSiteSetup({
        siteId,
        address: address.trim(),
        tariffKwhRate: Number(tariffKwhRate),
        timeZone,
        floors: floors.map((floor) => ({ name: floor.name.trim(), level: floor.level }))
      }),
    onSuccess: (dashboard) => {
      queryClient.setQueryData(["dashboard", siteId], dashboard);
      queryClient.setQueryData(["dashboard", "default"], dashboard);
      queryClient.invalidateQueries({ queryKey: ["dashboard"] });
      setSuccessMessage("초기 설정을 저장했습니다.");
      onComplete?.();
    }
  });

  const canSubmit = !validationMessage && !setupMutation.isPending;

  function applyGeneratedFloors(next: InitialFloorInput[]) {
    setFloors(next);
    setLastGeneratedFloors(next);
    setPendingGeneratedFloors(null);
  }

  return (
    <section className="grid min-w-0 gap-4 rounded-panel border border-border-default bg-surface-panel p-4.5 shadow-panel" data-testid="site-setup-flow" aria-labelledby="setup-wizard-title">
      <div className="flex items-start justify-between gap-3">
        <div className="grid min-w-0 gap-1">
          <span className="text-overline font-bold text-content-secondary">초기 설치</span>
          <h3 className="m-0 text-card-title text-content-primary" id="setup-wizard-title">현장 기본 정보를 입력하세요</h3>
        </div>
        <StatusBadge tone={successMessage ? "success" : "neutral"} icon={successMessage ? CheckCircle2 : Clock3}>
          {successMessage ? "저장됨" : "준비"}
        </StatusBadge>
      </div>

      <ProgressSteps className="flex-wrap" label="현장 설치 진행" steps={[
        { id: "site", label: "현장 정보", state: "current" },
        { id: "gateway", label: "Gateway 연결", state: "pending" },
        { id: "fixtures", label: "조명 등록", state: "pending" },
        { id: "operate", label: "운영 시작", state: "pending" }
      ]} />

      <Card className="grid gap-3 p-4">
          <h4 className="m-0 text-card-title text-content-primary">현장 정보</h4>
          <div className="grid grid-cols-1 gap-3 compact:grid-cols-2">
          <div className="grid gap-1 rounded-control border border-border-default bg-surface-inset p-3">
            <span className="text-caption text-content-secondary">고객사</span>
            <strong className="break-words text-label text-content-primary">{customerName}</strong>
          </div>
          <div className="grid gap-1 rounded-control border border-border-default bg-surface-inset p-3">
            <span className="text-caption text-content-secondary">현장</span>
            <strong className="break-words text-label text-content-primary">{siteName}</strong>
          </div>
          <TextField label="주소" value={address} onChange={setAddress} placeholder="서울시 강남구" />
          <Button variant="secondary" type="button" onClick={() => setAddress("미입력")}>
            주소 미입력
          </Button>
          <TextField label="kWh 단가" inputMode="decimal" value={tariffKwhRate} onChange={setTariffKwhRate} />
          <SelectBox
            label="시간대"
            items={[
              { id: "Asia/Seoul", label: "Asia/Seoul" },
              { id: "UTC", label: "UTC" },
              { id: "Asia/Tokyo", label: "Asia/Tokyo" }
            ]}
            selectedKey={timeZone}
            onSelectionChange={(key) => { if (key) setTimeZone(key); }}
          />
        </div>
      </Card>

      <Card className="grid gap-3 p-4">
        <h4 className="m-0 text-card-title text-content-primary">층 생성</h4>
        <div className="grid grid-cols-1 items-end gap-3 compact:grid-cols-2 tablet:grid-cols-3">
          <TextField label="지하 층수" inputMode="numeric" value={basementCount} onChange={setBasementCount} />
          <TextField label="지상 층수" inputMode="numeric" value={groundCount} onChange={setGroundCount} />
          <Button
            variant="secondary"
            type="button"
            onClick={() => {
              const basement = parseCount(basementCount);
              const ground = parseCount(groundCount);
              if (!isValidFloorCount(basement) || !isValidFloorCount(ground)) return;
              const next = buildFloors(basement, ground);
              const customized = !sameFloorList(floors, lastGeneratedFloors);
              if (customized && !sameFloorList(next, floors)) setPendingGeneratedFloors(next);
              else applyGeneratedFloors(next);
            }}
          >
            <Wand2 size={16} />
            층 자동 생성
          </Button>
        </div>

        <div className="grid gap-2.5" aria-label="생성된 층 목록">
          {floors.length === 0 ? (
            <p className="m-0 text-body-sm text-content-secondary">생성된 층이 없습니다.</p>
          ) : (
            floors.map((floor, index) => (
              <div className="grid grid-cols-1 gap-2.5 compact:grid-cols-2" key={`${floor.level}-${index}`}>
                <TextField
                  label={`층 이름 ${index + 1}`}
                  value={floor.name}
                  onChange={(value) => setFloors((current) => current.map((item, itemIndex) =>
                    itemIndex === index ? { ...item, name: value } : item
                  ))}
                />
                <NumberField
                  label={`층 level ${index + 1}`}
                  value={Number.isNaN(floor.level) ? null : floor.level}
                  onChange={(value) => setFloors((current) => current.map((item, itemIndex) =>
                    itemIndex === index ? { ...item, level: value ?? Number.NaN } : item
                  ))}
                />
              </div>
            ))
          )}
        </div>
      </Card>

      {validationMessage ? (
        <p className="m-0 text-body-sm font-bold text-status-danger-foreground" role="alert">
          {validationMessage}
        </p>
      ) : null}
      {setupMutation.error ? <FeedbackState tone="danger" icon={CheckCircle2} title="초기 설정을 저장하지 못했습니다." /> : null}
      {successMessage ? (
        <FeedbackState tone="success" icon={CheckCircle2} title={successMessage} />
      ) : null}

      <Button className="w-full justify-self-start compact:w-auto" variant="primary" disabled={!canSubmit} isLoading={setupMutation.isPending} loadingLabel="초기 설정 저장 중" onClick={() => setupMutation.mutate()}>
        <CheckCircle2 size={16} />
        초기 설정 완료
      </Button>
      <ConfirmDialog
        isOpen={pendingGeneratedFloors !== null}
        role="alertdialog"
        title="층 목록 다시 생성"
        confirmLabel="다시 생성"
        onCancel={() => setPendingGeneratedFloors(null)}
        onConfirm={() => { if (pendingGeneratedFloors) applyGeneratedFloors(pendingGeneratedFloors); }}
      >
        직접 수정한 층 이름과 층 번호가 새 목록으로 바뀝니다. 계속할까요?
      </ConfirmDialog>
    </section>
  );
}

export function InstallationPending() {
  return (
    <section className="grid min-w-0 gap-4 rounded-panel border border-border-default bg-surface-panel p-4.5 shadow-panel" data-testid="site-setup-flow" aria-label="Viewer 설치 대기">
      <div className="flex items-start justify-between gap-3">
        <div className="grid min-w-0 gap-1">
          <span className="text-overline font-bold text-content-secondary">설치 준비</span>
          <h3 className="m-0 text-card-title text-content-primary" id="installation-pending-title">설치 담당자가 현장을 준비 중입니다</h3>
        </div>
        <StatusBadge tone="neutral" icon={Clock3}>대기</StatusBadge>
      </div>
      <FeedbackState tone="neutral" icon={Clock3} title="Viewer 설치 대기" description="현장 관리자가 설치와 조명 등록을 완료하면 조회할 수 있습니다." />
    </section>
  );
}

function buildFloors(basementCount: number, groundCount: number): InitialFloorInput[] {
  const basementFloors = Array.from({ length: basementCount }, (_, index) => {
    const level = -(basementCount - index);
    return { name: `B${Math.abs(level)}`, level };
  });
  const groundFloors = Array.from({ length: groundCount }, (_, index) => {
    const level = index + 1;
    return { name: `${level}F`, level };
  });
  return [...basementFloors, ...groundFloors];
}

function sameFloorList(left: InitialFloorInput[], right: InitialFloorInput[]) {
  return left.length === right.length && left.every((floor, index) =>
    floor.name === right[index].name && floor.level === right[index].level
  );
}

function parseCount(value: string) {
  if (!value.trim()) return Number.NaN;
  const count = Number(value);
  return Number.isInteger(count) ? count : Number.NaN;
}

function isValidFloorCount(value: number) {
  return Number.isInteger(value) && value >= 0 && value <= MAX_FLOOR_COUNT;
}

function isValidTimeZone(value: string) {
  try {
    new Intl.DateTimeFormat("ko-KR", { timeZone: value }).format(new Date(0));
    return true;
  } catch {
    return false;
  }
}
