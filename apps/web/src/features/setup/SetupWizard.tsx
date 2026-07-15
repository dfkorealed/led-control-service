import { useMutation, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Loader2, Wand2 } from "lucide-react";
import { useMemo, useState } from "react";
import { createInitialSiteSetup, type InitialFloorInput } from "../../api/setup";

interface SetupWizardProps {
  onComplete?: () => void;
}

const MAX_FLOOR_COUNT = 20;
const MAX_TARIFF_KWH_RATE = 100000;

export function SetupWizard({ onComplete }: SetupWizardProps) {
  const queryClient = useQueryClient();
  const [siteName, setSiteName] = useState("");
  const [address, setAddress] = useState("");
  const [tariffKwhRate, setTariffKwhRate] = useState("160");
  const [basementCount, setBasementCount] = useState("2");
  const [groundCount, setGroundCount] = useState("0");
  const [floors, setFloors] = useState<InitialFloorInput[]>(buildFloors(2, 0));
  const [successMessage, setSuccessMessage] = useState("");

  const validationMessage = useMemo(() => {
    const tariff = Number(tariffKwhRate);
    const basement = parseCount(basementCount);
    const ground = parseCount(groundCount);
    const floorNames = floors.map((floor) => floor.name.trim()).filter(Boolean);
    const floorLevels = floors.map((floor) => floor.level);

    if (!siteName.trim()) return "현장명을 입력하세요.";
    if (!address.trim()) return "주소를 입력하세요.";
    if (!Number.isFinite(tariff) || tariff <= 0 || tariff > MAX_TARIFF_KWH_RATE) {
      return `kWh 단가는 0보다 큰 ${MAX_TARIFF_KWH_RATE} 이하의 숫자여야 합니다.`;
    }
    if (!isValidFloorCount(basement) || !isValidFloorCount(ground)) {
      return `층수는 지하와 지상 각각 ${MAX_FLOOR_COUNT}층 이하의 숫자여야 합니다.`;
    }
    if (floors.length === 0) return "층을 1개 이상 생성하세요.";
    if (floors.some((floor) => !floor.name.trim())) return "층 이름을 입력하세요.";
    if (floors.some((floor) => !Number.isInteger(floor.level) || floor.level === 0)) {
      return "층 level은 0이 아닌 정수여야 합니다.";
    }
    if (new Set(floorNames).size !== floorNames.length) return "층 이름은 중복될 수 없습니다.";
    if (new Set(floorLevels).size !== floorLevels.length) return "층 level은 중복될 수 없습니다.";
    return "";
  }, [address, basementCount, floors, groundCount, siteName, tariffKwhRate]);

  const setupMutation = useMutation({
    mutationFn: () =>
      createInitialSiteSetup({
        siteName: siteName.trim(),
        address: address.trim(),
        tariffKwhRate: Number(tariffKwhRate),
        floors: floors.map((floor) => ({ name: floor.name.trim(), level: floor.level }))
      }),
    onSuccess: (dashboard) => {
      queryClient.setQueryData(["dashboard"], dashboard);
      queryClient.invalidateQueries({ queryKey: ["dashboard"] });
      setSuccessMessage("초기 설정을 저장했습니다.");
      onComplete?.();
    }
  });

  const canSubmit = !validationMessage && !setupMutation.isPending;

  return (
    <section className="setup-wizard" aria-labelledby="setup-wizard-title">
      <div className="panel-title-row">
        <div>
          <span className="eyebrow">초기 설치</span>
          <h3 id="setup-wizard-title">초기 설치 설정</h3>
        </div>
        <span className={`status-pill ${successMessage ? "success" : "offline"}`} aria-live="polite">
          {successMessage ? "저장됨" : "준비"}
        </span>
      </div>

      <div className="setup-section">
        <h4>현장 정보</h4>
        <div className="setup-form-grid">
          <label>
            현장명
            <input value={siteName} onChange={(event) => setSiteName(event.target.value)} placeholder="A 주차장" />
          </label>
          <label>
            주소
            <input value={address} onChange={(event) => setAddress(event.target.value)} placeholder="서울시 강남구" />
          </label>
          <button className="secondary-button" type="button" onClick={() => setAddress("미입력")}>
            주소 미입력
          </button>
          <label>
            kWh 단가
            <input
              inputMode="decimal"
              step="0.01"
              type="text"
              value={tariffKwhRate}
              onChange={(event) => setTariffKwhRate(event.target.value)}
            />
          </label>
        </div>
      </div>

      <div className="setup-section">
        <h4>층 생성</h4>
        <div className="setup-range-row">
          <label>
            지하 층수
            <input
              inputMode="numeric"
              min="0"
              max={MAX_FLOOR_COUNT}
              type="text"
              value={basementCount}
              onChange={(event) => setBasementCount(event.target.value)}
            />
          </label>
          <label>
            지상 층수
            <input
              inputMode="numeric"
              min="0"
              max={MAX_FLOOR_COUNT}
              type="text"
              value={groundCount}
              onChange={(event) => setGroundCount(event.target.value)}
            />
          </label>
          <button
            className="secondary-button"
            type="button"
            onClick={() => {
              const basement = parseCount(basementCount);
              const ground = parseCount(groundCount);
              if (!isValidFloorCount(basement) || !isValidFloorCount(ground)) return;
              setFloors(buildFloors(basement, ground));
            }}
          >
            <Wand2 size={16} />
            층 자동 생성
          </button>
        </div>

        <div className="floor-edit-list" aria-label="생성된 층 목록">
          {floors.length === 0 ? (
            <p className="muted-text">생성된 층이 없습니다.</p>
          ) : (
            floors.map((floor, index) => (
              <div className="floor-edit-row" key={`${floor.level}-${index}`}>
                <label>
                  층 이름 {index + 1}
                  <input
                    value={floor.name}
                    onChange={(event) =>
                      setFloors((current) =>
                        current.map((item, itemIndex) =>
                          itemIndex === index ? { ...item, name: event.target.value } : item
                        )
                      )
                    }
                  />
                </label>
                <label>
                  층 level {index + 1}
                  <input
                    inputMode="numeric"
                    type="number"
                    value={Number.isNaN(floor.level) ? "" : floor.level}
                    onChange={(event) =>
                      setFloors((current) =>
                        current.map((item, itemIndex) =>
                          itemIndex === index ? { ...item, level: Number(event.target.value) } : item
                        )
                      )
                    }
                  />
                </label>
              </div>
            ))
          )}
        </div>
      </div>

      {validationMessage ? (
        <p className="danger-text" role="alert">
          {validationMessage}
        </p>
      ) : null}
      {setupMutation.error ? (
        <p className="danger-text" role="alert">
          초기 설정을 저장하지 못했습니다.
        </p>
      ) : null}
      {successMessage ? (
        <p className="success-text" aria-live="polite">
          <CheckCircle2 size={16} />
          {successMessage}
        </p>
      ) : null}

      <button className="primary-button setup-submit" disabled={!canSubmit} onClick={() => setupMutation.mutate()}>
        {setupMutation.isPending ? <Loader2 size={16} /> : <CheckCircle2 size={16} />}
        초기 설정 완료
      </button>
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

function parseCount(value: string) {
  const count = Number(value);
  if (!Number.isFinite(count)) return Number.NaN;
  return Math.max(0, Math.floor(count));
}

function isValidFloorCount(value: number) {
  return Number.isInteger(value) && value >= 0 && value <= MAX_FLOOR_COUNT;
}
