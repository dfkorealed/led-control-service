import { useRef, useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { bioSensorProfileV1Schema } from "@led-control/shared/bio-sensor-profile-contracts";
import { createBioSensorProfile, listBioSensorProfiles, revokeBioSensorProfile } from "../../api/automation";
import { LoadingIndicator, Button, Card, Checkbox, ConfirmDialog, PageHeader, Text, TextArea  } from "../../components/ui";

export function SensorProfilesView() {
  const client = useQueryClient();
  const profiles = useQuery({ queryKey: ["bio-sensor-profiles"], queryFn: listBioSensorProfiles });
  // The API lists immutable history but withdrawal targets current profile state,
  // not the displayed revision. Never offer that action from a historical row.
  const currentRevisions = new Map<string, number>();
  for (const profile of profiles.data ?? []) currentRevisions.set(profile.profileId, Math.max(currentRevisions.get(profile.profileId) ?? 0, profile.revision));
  const [json, setJson] = useState(""); const [confirmed, setConfirmed] = useState(false); const [pending, setPending] = useState(false);
  const [revokeId, setRevokeId] = useState<string | null>(null); const [error, setError] = useState(""); const [notice, setNotice] = useState(""); const busy = useRef(false);
  async function changed(message: string) {
    setNotice(message);
    await Promise.all([client.invalidateQueries({ queryKey: ["bio-sensor-profiles"] }), client.invalidateQueries({ queryKey: ["dashboard"] }), client.invalidateQueries({ queryKey: ["registration-sessions"] }), client.invalidateQueries({ queryKey: ["registration-session"] })]);
  }
  async function approve(event: FormEvent) {
    event.preventDefault(); if (busy.current || !confirmed) return; setError(""); setNotice("");
    let parsed;
    try { parsed = bioSensorProfileV1Schema.safeParse(JSON.parse(json)); }
    catch { setError("승인 프로파일 형식을 확인하세요. 검증된 전체 계약이 필요합니다."); return; }
    if (!parsed.success || parsed.data.status !== "approved") { setError("승인 프로파일 형식을 확인하세요. 식별 조합·exact body·독립 연결 정책·검증 근거·재사용 범위가 필요합니다."); return; }
    busy.current = true; setPending(true);
    try { await createBioSensorProfile(parsed.data); setJson(""); setConfirmed(false); await changed("프로파일 승인 등록 요청을 저장했습니다. 현재 장비 준비 확인이 추가로 필요합니다."); }
    catch { setError("프로파일을 승인 등록하지 못했습니다. 최신 revision과 운영자 권한을 확인해 주세요."); }
    finally { busy.current = false; setPending(false); }
  }
  async function revoke() {
    if (!revokeId || busy.current) return; busy.current = true; setPending(true); setError(""); setNotice("");
    try { await revokeBioSensorProfile(revokeId); setRevokeId(null); await changed("프로파일 철회를 저장했습니다. 이전 준비 상태는 재검증해야 합니다."); }
    catch { setError("프로파일을 철회하지 못했습니다. 최신 정보와 운영자 권한을 확인해 주세요."); }
    finally { busy.current = false; setPending(false); }
  }
  return <section className="grid min-w-0 gap-4" aria-label="센서 호환 프로파일 관리">
    <PageHeader title="센서 호환 프로파일" headingLevel={1} description="서비스 운영자 전용 · 검증 근거와 재사용 범위를 가진 장비군을 버전별로 승인·철회합니다." />
    <Text>승인 프로파일 기본 목록은 비어 있습니다. 프로파일 등록은 실제 장비 검증이나 현장 운영 정책 승인을 대신하지 않습니다.</Text>
    {profiles.isPending ? <LoadingIndicator isPaused={profiles.isPaused}>프로파일 목록을 불러오는 중입니다.</LoadingIndicator> : null}
    {profiles.error ? <><Text role="alert" tone="danger">프로파일 목록을 불러오지 못했습니다.</Text><Button type="button" variant="secondary" onClick={() => void profiles.refetch()}>목록 다시 조회</Button></> : null}
    {profiles.data?.length === 0 ? <Text>승인된 호환 프로파일이 없습니다. 미검증 조명은 호환 확인이 필요합니다.</Text> : null}
    <div className="grid max-h-80 gap-3 overflow-y-auto overscroll-contain" aria-label="프로파일 revision 목록">
      {profiles.data?.map(profile => <Card key={`${profile.profileId}@${profile.revision}`} role="group" aria-label={`${profile.profileId} revision ${profile.revision}`} className="grid min-w-0 gap-2 p-4">
        <Text className="break-all" weight="semibold">{profile.profileId} · revision {profile.revision} · {profile.status === "approved" ? "승인" : "철회"}</Text>
        <Text variant="caption">{currentRevisions.get(profile.profileId) === profile.revision ? "현재 revision" : "이전 revision · 읽기 전용"}</Text>
        <Text>재사용 범위: {profile.reuseScope}</Text><Text variant="caption" className="break-all">검증 근거: {profile.evidenceDigest}</Text>
        {currentRevisions.get(profile.profileId) === profile.revision && profile.status === "approved" ? <Button type="button" variant="danger" disabled={pending} onClick={() => setRevokeId(profile.profileId)}>프로파일 철회</Button> : null}
      </Card>)}
    </div>
    <Card className="grid min-w-0 gap-3 p-4"><form className="grid min-w-0 gap-3" onSubmit={approve} noValidate>
      <Text>새 revision은 전체 승인 계약을 입력합니다. profileId는 유지하고 revision은 최신 값 + 1입니다. 최초 revision은 1이며 이전 기록을 덮어쓰지 않습니다.</Text>
      <TextArea label="승인 프로파일 JSON" description="profileId, revision, status=approved, fingerprint, bodyHexes, linkPolicy, evidenceDigest, reuseScope를 검증 근거대로 입력하세요." rows={8} value={json} onChange={setJson} isDisabled={pending} />
      <Checkbox label="검증 근거와 재사용 범위를 확인했으며 이 revision을 승인합니다." isSelected={confirmed} onChange={setConfirmed} isDisabled={pending} />
      <Button type="submit" disabled={pending || !confirmed} isLoading={pending && !revokeId} loadingLabel="승인 등록 중">프로파일 승인 등록</Button>
    </form></Card>
    {error ? <Text role="alert" tone="danger">{error}</Text> : null}{notice ? <Text role="status">{notice}</Text> : null}
    <ConfirmDialog isOpen={revokeId !== null} title="호환 프로파일 철회" description="이 장비군의 이전 준비 상태가 무효화됩니다. 운영 중 규칙은 서버의 장애·복원 정책에 따라 처리됩니다." confirmLabel="철회" isPending={pending} onCancel={() => setRevokeId(null)} onConfirm={() => void revoke()}>{null}</ConfirmDialog>
  </section>;
}
