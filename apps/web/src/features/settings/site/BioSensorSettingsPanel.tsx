import { useEffect, useRef, useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getBioSensorPolicy, saveBioSensorPolicy, vehicleEventRuleQueryKey } from "../../../api/automation";
import { useControlDashboard } from "../../../api/queries";
import { LoadingIndicator, Button, Card, Checkbox, Heading, SelectBox, Text, TextField  } from "../../../components/ui";
import { BioSensorPreparationPanel } from "../../control/automation/BioSensorPreparationPanel";

export function BioSensorSettingsPanel({ siteId, ownerUserId, canPrepare }: { siteId: string; ownerUserId: string; canPrepare: boolean }) {
  const client = useQueryClient();
  const policy = useQuery({ queryKey: ["bio-sensor-policy", siteId], queryFn: () => getBioSensorPolicy(siteId) });
  const dashboard = useControlDashboard(siteId);
  const [enabled, setEnabled] = useState(false); const [seconds, setSeconds] = useState(""); const [action, setAction] = useState("");
  const [fixtureId, setFixtureId] = useState(""); const [pending, setPending] = useState(false); const [error, setError] = useState(""); const [notice, setNotice] = useState("");
  const busy = useRef(false); const generation = useRef(0);
  useEffect(() => { generation.current += 1; setEnabled(false); setSeconds(""); setAction(""); setFixtureId(""); setError(""); setNotice(""); setPending(false); busy.current = false; return () => { generation.current += 1; }; }, [siteId, ownerUserId]);
  useEffect(() => { if (policy.data) { setEnabled(policy.data.enabled); setSeconds(policy.data.maximumResponseSeconds?.toString() ?? ""); setAction(policy.data.escalationAction ?? ""); } }, [policy.data]);
  const fixtures = dashboard.data?.floors.flatMap(floor => floor.fixtures) ?? [];
  const selectedFixture = fixtures.find(fixture => fixture.id === fixtureId);

  async function submit(event: FormEvent) {
    event.preventDefault(); if (busy.current || !policy.data) return;
    const response = seconds.trim() ? Number(seconds) : null; const escalation = action.trim() || null;
    if ((response !== null && (!Number.isInteger(response) || response < 1 || response > 2147483647)) || (enabled && (!response || !escalation))) {
      setError("유효한 최대 대응 시간과 연결 이상 시 조치를 입력하세요."); return;
    }
    const current = generation.current; busy.current = true; setPending(true); setError(""); setNotice("");
    try {
      const result = await saveBioSensorPolicy(siteId, { enabled, ownerUserId: response !== null || escalation !== null || enabled ? ownerUserId : null, maximumResponseSeconds: response, escalationAction: escalation });
      if (generation.current !== current) return;
      // OFF metadata is a draft. Preserve local editable text even when the
      // server normalizes it; enabling still requires freshly authorized owner.
      setEnabled(result.enabled); setNotice("센서 운영 정책을 저장했습니다. 조명의 준비 상태를 다시 확인해 주세요.");
      await Promise.all([client.invalidateQueries({ queryKey: ["dashboard"] }), client.invalidateQueries({ queryKey: vehicleEventRuleQueryKey(siteId) })]);
    } catch { if (generation.current === current) setError("센서 운영 정책을 저장하지 못했습니다. 권한과 최신 정보를 확인해 주세요."); }
    finally { if (generation.current === current) { busy.current = false; setPending(false); } }
  }

  return <section className="grid min-w-0 gap-4" aria-label="센서 운영 관리">
    <Card className="grid gap-3 p-4">
      <Heading as="h3" variant="card-title">센서 운영 정책</Heading>
      <Text>기본 OFF · 현장 대응 정책과 승인된 호환 프로파일이 모두 확인되어야 사용할 수 있습니다. 저장만으로 센서가 사용 가능 상태가 되지 않습니다.</Text>
      {policy.isPending ? <LoadingIndicator isPaused={policy.isPaused}>센서 운영 정책을 불러오는 중입니다.</LoadingIndicator> : null}
      {policy.error ? <><Text role="alert" tone="danger">센서 운영 정책을 불러오지 못했습니다.</Text><Button type="button" variant="secondary" onClick={() => void policy.refetch()}>정책 다시 조회</Button></> : null}
      {policy.data ? <form className="grid gap-3" onSubmit={submit} noValidate>
        <Checkbox label="현장 이벤트 운영 허용" isSelected={enabled} isDisabled={pending} onChange={setEnabled} />
        <Text variant="caption">장애 대응 담당자는 현재 로그인한 현장 관리자입니다. 담당자 권한이 해제되면 서버에서 운영을 OFF로 전환합니다.</Text>
        <div className="grid gap-3 tablet:grid-cols-2">
          <TextField label="최대 대응 시간 (초)" inputMode="numeric" value={seconds} onChange={setSeconds} isDisabled={pending} />
          <TextField label="연결 이상 시 조치" value={action} onChange={setAction} isDisabled={pending} />
        </div>
        <Button type="submit" disabled={pending} isLoading={pending} loadingLabel="저장 중">센서 운영 정책 저장</Button>
      </form> : null}
      {error ? <Text role="alert" tone="danger">{error}</Text> : null}
      {notice ? <Text role="status">{notice}</Text> : null}
    </Card>
    <Card className="grid min-w-0 gap-3 p-4">
      <Heading as="h3" variant="card-title">등록 조명 센서 준비</Heading>
      <Text variant="caption">조명을 하나씩 선택해 준비 상태와 차단 사유를 확인합니다.</Text>
      {dashboard.error ? <><Text role="alert" tone="danger">등록 조명의 준비 정보를 불러오지 못했습니다.</Text><Button type="button" variant="secondary" onClick={() => void dashboard.refetch()}>조명 다시 조회</Button></> : null}
      <SelectBox label="준비 상태를 확인할 조명" items={fixtures.map(fixture => ({ id: fixture.id, label: fixture.name }))} selectedKey={fixtureId || null} onSelectionChange={value => setFixtureId(value ?? "")} />
      {selectedFixture ? <BioSensorPreparationPanel siteId={siteId} fixture={selectedFixture} disabled={pending} canPrepare={canPrepare} onRefreshSource={() => dashboard.refetch()} /> : <Text>준비 상태를 확인할 등록 조명을 선택하세요.</Text>}
    </Card>
  </section>;
}
