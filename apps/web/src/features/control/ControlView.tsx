import { useMemo, useState } from "react";
import { apiPost } from "../../api/client";
import { useDashboard } from "../../api/queries";

export function ControlView() {
  const { data } = useDashboard();
  const [targetId, setTargetId] = useState("");
  const [brightness, setBrightness] = useState(70);
  const [message, setMessage] = useState("");
  const fixtures = useMemo(() => data?.floors.flatMap((floor) => floor.fixtures) ?? [], [data]);

  async function submitCommand() {
    if (!data || !targetId) return;

    await apiPost("/commands/dimming", {
      siteId: data.site.id,
      targetType: "fixture",
      targetId,
      brightness,
      requestedBy: "operator@example.com"
    });
    setMessage("명령을 전송했습니다.");
  }

  return (
    <section className="panel form-panel">
      <h2>개별 조명 제어</h2>
      <label>
        조명
        <select value={targetId} onChange={(event) => setTargetId(event.target.value)}>
          <option value="">선택</option>
          {fixtures.map((fixture) => (
            <option key={fixture.id} value={fixture.id}>
              {fixture.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        밝기 {brightness}%
        <input
          type="range"
          min="0"
          max="100"
          value={brightness}
          onChange={(event) => setBrightness(Number(event.target.value))}
        />
      </label>
      <button className="primary-button" onClick={submitCommand} disabled={!targetId}>
        적용
      </button>
      {message && <p className="success-text">{message}</p>}
    </section>
  );
}
