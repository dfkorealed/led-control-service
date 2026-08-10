import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { AuthUser } from "../../api/auth";
import { apiPost } from "../../api/client";
import { useControlDashboard } from "../../api/queries";
import { useCommandStatus, type CommandStage } from "../../api/commands";

type ControlMode = "fixture" | "group";

export function ControlView({ siteId, userRole }: { siteId?: string; userRole: AuthUser["role"] }) {
  const { data } = useControlDashboard(siteId);
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<ControlMode>("fixture");
  const [targetId, setTargetId] = useState("");
  const [groupId, setGroupId] = useState("");
  const [brightness, setBrightness] = useState(70);
  const [message, setMessage] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [commandId, setCommandId] = useState<string | null>(null);
  const commandQuery = useCommandStatus(commandId);
  const fixtures = useMemo(() => data?.floors.flatMap((floor) => floor.fixtures) ?? [], [data]);
  const selectedFixture = fixtures.find((fixture) => fixture.id === targetId) ?? fixtures[0];
  const groups = data?.groups ?? [];
  const selectedGroup = groups.find((group) => group.id === groupId) ?? groups[0];
  const selectedGroupFixtures = selectedGroup ? fixtures.filter((fixture) => selectedGroup.fixtureIds.includes(fixture.id)) : [];
  const selectedTargetName = mode === "fixture" ? selectedFixture?.name : selectedGroup?.name;
  const blockedFixture = mode === "fixture" ? selectedFixture : selectedGroupFixtures.find((fixture) => !fixture.controllable);
  const blockMessage = blockedFixture && !blockedFixture.controllable
    ? formatControlBlockReason(blockedFixture.controlBlockReason, mode === "group" ? blockedFixture.name : undefined)
    : null;
  const readOnly = userRole === "viewer";
  const canSubmit = Boolean(data && selectedTargetName && !blockMessage && !isSubmitting && !readOnly);

  async function submitCommand() {
    const commandTargetId = mode === "fixture" ? targetId || selectedFixture?.id : groupId || selectedGroup?.id;
    if (!data || !commandTargetId || readOnly) return;

    setIsSubmitting(true);
    setMessage("");
    try {
      const command = await apiPost<{ id: string; dispatchCount: number }>("/commands/dimming", {
        siteId: data.site.id,
        targetType: mode,
        targetId: commandTargetId,
        brightness
      });
      setCommandId(command.id);
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
          <button className={mode === "fixture" ? "active" : ""} onClick={() => setMode("fixture")} disabled={readOnly}>
            개별
          </button>
          <button className={mode === "group" ? "active" : ""} onClick={() => setMode("group")} disabled={readOnly}>
            그룹
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
                  disabled={readOnly}
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
                  disabled={readOnly}
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
            <span className={`status-pill ${canSubmit ? "online" : "offline"}`}>
              {readOnly ? "조회 전용" : canSubmit ? "전송 가능" : blockMessage ? "제어 불가" : "대상 없음"}
            </span>
          </div>

          {readOnly ? (
            <p className="danger-text" role="alert">
              조회 전용 계정입니다. 조명 제어는 operator 또는 admin 계정으로만 수행할 수 있습니다.
            </p>
          ) : null}

          <div className="dial-card">
            <span>밝기</span>
            <strong>{brightness}%</strong>
            <input
              aria-label="밝기"
              type="range"
              min="0"
              max="100"
              value={brightness}
              disabled={readOnly}
              onChange={(event) => setBrightness(Number(event.target.value))}
            />
          </div>

          {mode === "fixture" ? (
            <label className="select-field">
              조명 선택
              <select
                value={targetId || selectedFixture?.id || ""}
                disabled={readOnly}
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
                disabled={readOnly}
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
              <button key={value} onClick={() => setBrightness(value)} disabled={readOnly}>
                {value}%
              </button>
            ))}
          </div>

          <button className="primary-button" onClick={submitCommand} disabled={!canSubmit}>
            {isSubmitting ? "전송 중" : "적용"}
          </button>
          {blockMessage && <p className="danger-text" role="alert">{blockMessage}</p>}
          {message && <p className="success-text">{message}</p>}
          {commandQuery.data && <CommandProgress status={commandQuery.data} />}
          {commandQuery.error && <p className="danger-text" role="alert">명령 처리 상태를 불러오지 못했습니다.</p>}
        </aside>
      </div>

      <div className="group-strip">
        {groups.map((group) => (
          <button
            className={group.id === selectedGroup?.id && mode === "group" ? "group-card active" : "group-card"}
            key={group.id}
            disabled={readOnly}
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

function CommandProgress({ status }: { status: NonNullable<ReturnType<typeof useCommandStatus>["data"]> }) {
  const failedResults = status.dispatches.flatMap((dispatch) =>
    dispatch.results.filter((result) => result.status === "failed" || result.status === "timed_out")
  );
  const isFailure = status.stage === "partial_failed" || status.stage === "failed" || status.stage === "timed_out";
  return (
    <div className="dial-card" aria-live="polite">
      <span>최근 명령 상태</span>
      <strong>{commandStageLabel(status.stage)}</strong>
      <small>{status.completedFixtureCount} / {status.totalFixtureCount} 처리</small>
      {failedResults.map((result) => (
        <small className={isFailure ? "danger-text" : ""} key={result.fixtureId}>
          {result.fixtureName}: {result.errorMessage ?? (result.status === "timed_out" ? "응답 시간 초과" : "적용 실패")}
        </small>
      ))}
    </div>
  );
}

function commandStageLabel(stage: CommandStage) {
  const labels: Record<CommandStage, string> = {
    queued: "명령 접수 완료",
    published: "게이트웨이 전송 완료",
    accepted: "게이트웨이 수신 완료",
    completed: "조명 적용 완료",
    partial_failed: "일부 조명 적용 실패",
    failed: "명령 처리 실패",
    timed_out: "명령 응답 시간 초과"
  };
  return labels[stage];
}

function formatControlBlockReason(
  reason: "fixture_unmapped" | "gateway_offline" | "fixture_fault" | "fixture_offline" | null,
  fixtureName?: string
) {
  const prefix = fixtureName ? `${fixtureName}: ` : "";
  const detail = reason === "fixture_unmapped"
    ? "게이트웨이에 매핑되지 않았습니다."
    : reason === "gateway_offline"
      ? "게이트웨이가 오프라인입니다."
      : reason === "fixture_fault"
        ? "조명 장애를 먼저 점검해야 합니다."
        : reason === "fixture_offline"
          ? "조명이 오프라인입니다."
          : "현재 제어할 수 없습니다.";
  return `${prefix}${detail}`;
}
