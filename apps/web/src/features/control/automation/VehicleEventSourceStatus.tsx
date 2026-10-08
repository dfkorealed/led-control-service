import type { DashboardFixture } from "../../../api/queries";
import { BioSensorPreparationPanel } from "./BioSensorPreparationPanel";

/** Shared current preparation UI; stored legacy GETs never become live eligibility. */
export function VehicleEventSourceStatus(props: {
  siteId: string; fixture: DashboardFixture; disabled: boolean; canPrepare?: boolean; onRefreshSource?: () => Promise<unknown>;
}) {
  if (!props.fixture.bioSensorPreparation && props.fixture.vehicleEventSource?.sensorProtocol !== "bio-usb-pulse") return null;
  return <BioSensorPreparationPanel {...props} />;
}
