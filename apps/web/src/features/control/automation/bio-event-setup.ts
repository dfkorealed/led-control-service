import { getBioSensorPreparation, requestBioSensorPreparation, type BioSensorPreparationOperation } from "../../../api/automation";
import type { Dashboard, DashboardFixture } from "../../../api/queries";

export class BioEventSetupError extends Error {}
interface SetupInput {
  siteId: string; gatewayId: string; fixtureIds: string[]; scopeKey: string;
  current(): boolean;
  dashboard(): Dashboard | undefined;
  refresh(): Promise<Dashboard>;
}
interface Dependencies {
  request: typeof requestBioSensorPreparation;
  read: typeof getBioSensorPreparation;
  wait(): Promise<void>;
}
interface RequestIdentity { clientRequestId: string; commandId?: string }

/** Selection is not execution authority. The existing server admission remains
 * authoritative after this helper completes; ready receipts alone never qualify. */
export function isSelectableVehicleEventSource(fixture: DashboardFixture) {
  if (fixture.vehicleEventSource?.sensorProtocol === "bio-usb-pulse") {
    return fixture.gateway !== null && fixture.controlBlockReason !== "fixture_unmapped";
  }
  return isVehicleEventSource(fixture);
}

export function isVehicleEventSource(fixture: DashboardFixture) {
  if (fixture.vehicleEventSource) return fixture.gateway !== null && fixture.vehicleEventSource.sourceEligible
    && fixture.vehicleEventSource.readiness === "ready";
  return fixture.gateway !== null && fixture.vehicleSensorCapabilityStatus === "supported"
    && typeof fixture.vehicleSensorCapabilityVerifiedAt === "string"
    && Number.isFinite(Date.parse(fixture.vehicleSensorCapabilityVerifiedAt))
    && new Date(fixture.vehicleSensorCapabilityVerifiedAt).toISOString() === fixture.vehicleSensorCapabilityVerifiedAt;
}

/** Owns uncertain request identities separately from changing dashboard renders.
 * Retrying a lost POST/GET resumes its exact operation, never another mode SET. */
export class BioEventSetup {
  private readonly requests = new Map<string, RequestIdentity>();
  constructor(private readonly dependencies: Dependencies = {
    request: requestBioSensorPreparation, read: getBioSensorPreparation,
    wait: () => new Promise(resolve => setTimeout(resolve, 1000))
  }) {}

  async prepare(input: SetupInput): Promise<void> {
    const first = this.source(input);
    if (first.vehicleEventSource?.sourceEligible === true) return;
    if (input.dashboard()?.capabilities?.commission !== true) throw new BioEventSetupError("센서 설정 권한이 없습니다. 현장 관리자에게 문의해 주세요.");
    const assignmentVersion = first.gateway!.assignmentVersion;
    const key = JSON.stringify([input.scopeKey, input.siteId, input.gatewayId, assignmentVersion, first.id]);
    let identity = this.requests.get(key);
    if (!identity) {
      const projection = first.bioSensorPreparation;
      identity = { clientRequestId: crypto.randomUUID(),
        ...(projection?.commandId && projection.status === "pending" ? { commandId: projection.commandId } : {}) };
      this.requests.set(key, identity);
    }
    const check = () => {
      const source = this.source(input);
      if (input.dashboard()?.capabilities?.commission !== true) throw new BioEventSetupError("센서 설정 권한이 변경되어 설정을 중단했습니다.");
      if (source.gateway?.assignmentVersion !== assignmentVersion) throw new BioEventSetupError("조명 연결 정보가 변경됐습니다. 다시 시도해 주세요.");
      return source;
    };
    const deadline = Date.now() + 120000;
    if (!identity.commandId) {
      check();
      const result = await this.dependencies.request({ siteId: input.siteId, fixtureId: first.id,
        operation: "ensure_sensor", clientRequestId: identity.clientRequestId });
      check(); this.assertReceipt(result, input, first.id);
      identity.commandId = result.commandId;
    }
    while (Date.now() < deadline) {
      check();
      const result = await this.dependencies.read(identity.commandId);
      check(); this.assertReceipt(result, input, first.id, identity.commandId);
      if (result.supersededAt) { this.requests.delete(key); throw new BioEventSetupError("다른 설정으로 변경됐습니다. 다시 시도해 주세요."); }
      if (result.status === "ready") {
        const latest = await input.refresh(); check();
        if (latest.site.id !== input.siteId) throw new BioEventSetupError("현장이 변경됐습니다. 다시 시도해 주세요.");
        const source = latest.floors.flatMap(floor => floor.fixtures).find(item => item.id === first.id);
        if (source?.controllable && source.status === "online" && source.gateway?.connectionStatus === "online"
          && source.gateway.id === input.gatewayId && source.gateway.assignmentVersion === assignmentVersion
          && source.vehicleEventSource?.sensorProtocol === "bio-usb-pulse" && source.vehicleEventSource.sourceEligible === true) {
          this.requests.delete(key); return;
        }
      } else if (result.status !== "pending") {
        this.requests.delete(key);
        throw new BioEventSetupError(result.status === "unsupported" ? "이 조명의 센서 설정을 적용할 수 없습니다. 관리자에게 문의해 주세요."
          : "센서 설정을 완료하지 못했습니다. 조명 연결을 확인한 뒤 다시 시도해 주세요.");
      }
      await this.dependencies.wait();
    }
    // Keep command attribution after a timeout: the next user retry reads it.
    throw new BioEventSetupError("센서 설정 결과를 아직 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.");
  }

  private source(input: SetupInput) {
    if (!input.current()) throw new BioEventSetupError("화면 또는 로그인 상태가 변경되어 설정을 중단했습니다.");
    const dashboard = input.dashboard();
    const source = dashboard?.floors.flatMap(floor => floor.fixtures).find(item => item.id === input.fixtureIds[0]);
    if (dashboard?.site.id !== input.siteId || input.fixtureIds.length !== 1 || !source
      || source.gateway?.id !== input.gatewayId || source.vehicleEventSource?.sensorProtocol !== "bio-usb-pulse") {
      throw new BioEventSetupError("감지 조명과 현장 연결을 다시 선택해 주세요.");
    }
    if (!source.controllable || source.status !== "online" || source.gateway.connectionStatus !== "online") {
      throw new BioEventSetupError("조명이 연결되어 있지 않습니다. 연결을 확인한 뒤 다시 시도해 주세요.");
    }
    return source;
  }
  private assertReceipt(result: BioSensorPreparationOperation, input: SetupInput, fixtureId: string, commandId?: string) {
    if (result.siteId !== input.siteId || result.fixtureId !== fixtureId || !result.commandId
      || commandId !== undefined && result.commandId !== commandId) throw new BioEventSetupError("센서 설정 결과를 확인하지 못했습니다. 다시 시도해 주세요.");
  }
}
