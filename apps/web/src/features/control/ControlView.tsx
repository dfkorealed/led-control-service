import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { apiPost } from "../../api/client";
import { useDashboard } from "../../api/queries";

type ControlMode = "fixture" | "group";

export function ControlView() {
  const { data } = useDashboard();
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<ControlMode>("fixture");
  const [targetId, setTargetId] = useState("");
  const [groupId, setGroupId] = useState("");
  const [brightness, setBrightness] = useState(70);
  const [message, setMessage] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const fixtures = useMemo(() => data?.floors.flatMap((floor) => floor.fixtures) ?? [], [data]);
  const selectedFixture = fixtures.find((fixture) => fixture.id === targetId) ?? fixtures[0];
  const groups = data?.groups ?? [];
  const selectedGroup = groups.find((group) => group.id === groupId) ?? groups[0];
  const selectedGroupFixtures = selectedGroup ? fixtures.filter((fixture) => selectedGroup.fixtureIds.includes(fixture.id)) : [];
  const selectedTargetName = mode === "fixture" ? selectedFixture?.name : selectedGroup?.name;
  const canSubmit = Boolean(data && selectedTargetName && !isSubmitting);

  async function submitCommand() {
    const commandTargetId = mode === "fixture" ? targetId || selectedFixture?.id : groupId || selectedGroup?.id;
    if (!data || !commandTargetId) return;

    setIsSubmitting(true);
    setMessage("");
    try {
      await apiPost("/commands/dimming", {
        siteId: data.site.id,
        targetType: mode,
        targetId: commandTargetId,
        brightness
      });
      setMessage("명령을 전송했습니다. 장비 ACK를 기다리는 중입니다.");
      await queryClient.invalidateQueries({ queryKey: ["dashboard"] });
    } catch {
      setMessage("명령 전송에 실패했습니다. 대상 상태와 게이트웨이 연결을 확인하세요.");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <section className="control-screen">
      <div className="screen-heading">
        <div>
          <span className="eyebrow">수동 제어</span>
          <h2>빠른 밝기 제어</h2>
        </div>
        <div className="segmented-control" aria-label="제어 모드">
          <button className={mode === "fixture" ? "active" : ""} onClick={() => setMode("fixture")}>
            개별
          </button>
          <button className={mode === "group" ? "active" : ""} onClick={() => setMode("group")}>
            그룹
          </button>
          <button disabled title="스케줄 제어는 추후 구현 예정입니다.">
            스케줄
          </button>
        </div>
      </div>

      <div className="control-layout">
        <div className="device-card-grid">
          {mode === "fixture"
            ? fixtures.slice(0, 8).map((fixture) => (
                <button
                  key={fixture.id}
                  className={fixture.id === selectedFixture?.id ? "device-control-card active" : "device-control-card"}
                  onClick={() => {
                    setTargetId(fixture.id);
                    setBrightness(fixture.brightness);
                    setMessage("");
                  }}
                >
                  <span className={`device-state ${fixture.status === "fault" ? "danger" : fixture.status === "offline" ? "muted" : ""}`} />
                  <strong>{fixture.name}</strong>
                  <span>{fixture.brightness}%</span>
                </button>
              ))
            : groups.map((group) => (
                <button
                  key={group.id}
                  className={group.id === selectedGroup?.id ? "device-control-card active" : "device-control-card"}
                  onClick={() => {
                    setGroupId(group.id);
                    setMessage("");
                  }}
                >
                  <span className="device-state" />
                  <strong>{group.name}</strong>
                  <span>{group.fixtureIds.length}개</span>
                </button>
              ))}
        </div>

        <aside className="control-panel">
          <div className="panel-title-row">
            <div>
              <span className="eyebrow">{mode === "fixture" ? "선택 조명" : "선택 그룹"}</span>
              <h3>{selectedTargetName ?? "대상 선택"}</h3>
            </div>
            <span className={`status-pill ${canSubmit ? "online" : "offline"}`}>{canSubmit ? "전송 가능" : "대상 없음"}</span>
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

          {mode === "fixture" ? (
            <label className="select-field">
              조명 선택
              <select
                value={targetId || selectedFixture?.id || ""}
                onChange={(event) => {
                  const fixture = fixtures.find((item) => item.id === event.target.value);
                  setTargetId(event.target.value);
                  if (fixture) setBrightness(fixture.brightness);
                  setMessage("");
                }}
              >
                {fixtures.map((fixture) => (
                  <option key={fixture.id} value={fixture.id}>
                    {fixture.name}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <label className="select-field">
              그룹 선택
              <select
                value={groupId || selectedGroup?.id || ""}
                onChange={(event) => {
                  setGroupId(event.target.value);
                  setMessage("");
                }}
              >
                {groups.map((group) => (
                  <option key={group.id} value={group.id}>
                    {group.name}
                  </option>
                ))}
              </select>
              <small>{selectedGroupFixtures.length}개 조명에 같은 밝기를 적용합니다.</small>
            </label>
          )}

          <div className="preset-row">
            {[0, 30, 70, 100].map((value) => (
              <button key={value} onClick={() => setBrightness(value)}>
                {value}%
              </button>
            ))}
          </div>

          <button className="primary-button" onClick={submitCommand} disabled={!canSubmit}>
            {isSubmitting ? "전송 중" : "적용"}
          </button>
          {message && <p className="success-text">{message}</p>}
        </aside>
      </div>

      <div className="group-strip">
        {groups.map((group) => (
          <button
            className={group.id === selectedGroup?.id && mode === "group" ? "group-card active" : "group-card"}
            key={group.id}
            onClick={() => {
              setMode("group");
              setGroupId(group.id);
              setMessage("");
            }}
          >
            <span>그룹</span>
            <strong>{group.name}</strong>
            <small>{group.fixtureIds.length}개 조명</small>
          </button>
        ))}
      </div>
    </section>
  );
}
