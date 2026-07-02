import { useMemo, useState } from "react";
import { apiPost } from "../../api/client";
import { useDashboard } from "../../api/queries";

const operatorId = import.meta.env.VITE_OPERATOR_ID ?? "00000000-0000-4000-8000-000000000002";

export function ControlView() {
  const { data } = useDashboard();
  const [targetId, setTargetId] = useState("");
  const [brightness, setBrightness] = useState(70);
  const [message, setMessage] = useState("");
  const fixtures = useMemo(() => data?.floors.flatMap((floor) => floor.fixtures) ?? [], [data]);
  const selectedFixture = fixtures.find((fixture) => fixture.id === targetId) ?? fixtures[0];
  const groups = data?.groups ?? [];

  async function submitCommand() {
    const commandTargetId = targetId || selectedFixture?.id;
    if (!data || !commandTargetId) return;

    await apiPost("/commands/dimming", {
      siteId: data.site.id,
      targetType: "fixture",
      targetId: commandTargetId,
      brightness,
      requestedBy: operatorId
    });
    setMessage("명령을 전송했습니다.");
  }

  return (
    <section className="control-screen">
      <div className="screen-heading">
        <div>
          <span className="eyebrow">수동 제어</span>
          <h2>빠른 밝기 제어</h2>
        </div>
        <div className="segmented-control" aria-label="제어 모드">
          <button className="active">개별</button>
          <button>그룹</button>
          <button>스케줄</button>
        </div>
      </div>

      <div className="control-layout">
        <div className="device-card-grid">
          {fixtures.slice(0, 8).map((fixture) => (
            <button
              key={fixture.id}
              className={fixture.id === selectedFixture?.id ? "device-control-card active" : "device-control-card"}
              onClick={() => {
                setTargetId(fixture.id);
                setBrightness(fixture.brightness);
              }}
            >
              <span className={`device-state ${fixture.status === "fault" ? "danger" : fixture.status === "offline" ? "muted" : ""}`} />
              <strong>{fixture.name}</strong>
              <span>{fixture.brightness}%</span>
            </button>
          ))}
        </div>

        <aside className="control-panel">
          <div className="panel-title-row">
            <div>
              <span className="eyebrow">선택 조명</span>
              <h3>{selectedFixture?.name ?? "대상 선택"}</h3>
            </div>
            <span className="status-pill online">전송 가능</span>
          </div>

          <div className="dial-card">
            <span>밝기</span>
            <strong>{brightness}%</strong>
            <input
              aria-label="밝기"
              type="range"
              min="0"
              max="100"
              value={brightness}
              onChange={(event) => setBrightness(Number(event.target.value))}
            />
          </div>

          <label className="select-field">
            조명 선택
            <select value={targetId || selectedFixture?.id || ""} onChange={(event) => setTargetId(event.target.value)}>
              {fixtures.map((fixture) => (
                <option key={fixture.id} value={fixture.id}>
                  {fixture.name}
                </option>
              ))}
            </select>
          </label>

          <div className="preset-row">
            {[0, 30, 70, 100].map((value) => (
              <button key={value} onClick={() => setBrightness(value)}>
                {value}%
              </button>
            ))}
          </div>

          <button className="primary-button" onClick={submitCommand} disabled={!selectedFixture}>
            적용
          </button>
          {message && <p className="success-text">{message}</p>}
        </aside>
      </div>

      <div className="group-strip">
        {groups.map((group) => (
          <div className="group-card" key={group.id}>
            <span>그룹</span>
            <strong>{group.name}</strong>
            <small>{group.fixtureIds.length}개 조명</small>
          </div>
        ))}
      </div>
    </section>
  );
}
