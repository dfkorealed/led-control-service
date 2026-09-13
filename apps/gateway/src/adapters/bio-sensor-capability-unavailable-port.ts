import type {
  ConfirmedVehicleSensorSource,
  VehicleSensorMeshPort
} from "../mesh/vehicle-sensor-client";

const BIO_SENSOR_CLOUD_UNSUPPORTED = "bio_sensor_cloud_unsupported";

/**
 * BIO 조명 모듈의 cloud 차량 센서 capability 경계다.
 *
 * - [확인됨] 이번 adapter가 검증한 제품 경로는 검색·주소·조명 제어뿐이다. 따라서 cloud
 *   sensor source 목록은 항상 비어 있고 configure/send는 같은 명시 오류로 닫힌다.
 * - [추정] 조명 내부 sensor mode는 firmware에서 계속 동작할 수 있지만 cloud 입력 지원과는
 *   별개다. 가짜 bind나 성공 응답을 만들면 안 된다.
 * - [미확인] vendor sensor event와 scaling은 Task 9 HIL 및 후속 설계 전까지 지원하지 않는다.
 */
export class BioSensorCapabilityUnavailablePort implements VehicleSensorMeshPort {
  readonly vehicleSensorCloudSupported = false;

  async listConfirmedSources(): Promise<ConfirmedVehicleSensorSource[]> { return []; }
  async resolveByFixtureId(_fixtureId: string) { return null; }
  async resolveBySourceUnicast(_sourceUnicast: number) { return null; }
  async configureSource(_source: ConfirmedVehicleSensorSource): Promise<never> { throw unsupported(); }
  async send(_destination: number, _payload: Uint8Array): Promise<never> { throw unsupported(); }
  onMessage(_listener: (sourceUnicast: number, data: Uint8Array) => void) { return () => undefined; }
}

function unsupported() {
  return Object.assign(new Error(BIO_SENSOR_CLOUD_UNSUPPORTED), { code: BIO_SENSOR_CLOUD_UNSUPPORTED });
}
