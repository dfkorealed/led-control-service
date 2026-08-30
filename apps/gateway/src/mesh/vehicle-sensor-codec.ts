import {
  BLUETOOTH_MESH_SENSOR,
  VEHICLE_SENSOR_VENDOR_MODEL,
  startsWithMeshOpcode,
  type VehicleSensorVendorModel
} from "./bluez-mesh-model-config";

const UINT32_MAX = 0xffff_ffff;
const MAX_SENSOR_STATUS_BYTES = 128;

export interface VendorVehicleEvent {
  bootId: number;
  sequence: number;
  eventKind: "detected" | "cleared";
  level: boolean;
}

export function decodeSensorStatus(data: Uint8Array) {
  if (data.length > MAX_SENSOR_STATUS_BYTES ||
    !startsWithMeshOpcode(data, BLUETOOTH_MESH_SENSOR.opcodes.status)) {
    throw new Error("malformed_vehicle_sensor_status");
  }
  const properties: Array<{ property: "presence_detected" | "motion_sensed"; active: boolean }> = [];
  let offset = BLUETOOTH_MESH_SENSOR.opcodes.status.length;
  while (offset < data.length) {
    const first = data[offset]!;
    const format = first & 0x01;
    const headerLength = format === 0 ? 2 : 3;
    if (offset + headerLength > data.length) throw new Error("malformed_vehicle_sensor_status");
    const encodedLength = format === 0 ? (first >> 1) & 0x0f : (first >> 1) & 0x7f;
    const valueLength = format === 1 && encodedLength === 0x7f ? 0 : encodedLength + 1;
    const propertyId = format === 0
      ? (data[offset + 1]! << 3) | (first >> 5)
      : data[offset + 1]! | (data[offset + 2]! << 8);
    const valueOffset = offset + headerLength;
    if (valueOffset + valueLength > data.length) throw new Error("malformed_vehicle_sensor_status");
    if (propertyId === BLUETOOTH_MESH_SENSOR.properties.presenceDetected ||
      propertyId === BLUETOOTH_MESH_SENSOR.properties.motionSensed) {
      const raw = data[valueOffset];
      const presence = propertyId === BLUETOOTH_MESH_SENSOR.properties.presenceDetected;
      if (valueLength !== 1 || raw === undefined || (presence ? raw > 1 : raw > 100)) {
        throw new Error("malformed_vehicle_sensor_status");
      }
      properties.push({
        property: presence ? "presence_detected" : "motion_sensed",
        active: raw > 0
      });
    }
    offset = valueOffset + valueLength;
  }
  return properties;
}

export function decodeVendorVehicleEvent(data: Uint8Array, vendorModel: VehicleSensorVendorModel): VendorVehicleEvent {
  const opcodeLength = vendorModel.eventOpcode.length;
  if (!startsWithMeshOpcode(data, vendorModel.eventOpcode) ||
    data.length !== opcodeLength + VEHICLE_SENSOR_VENDOR_MODEL.eventPayloadLength) {
    throw new Error("malformed_vehicle_sensor_vendor_event");
  }
  const payload = Buffer.from(data.subarray(opcodeLength));
  const version = payload.readUInt8(0);
  const bootId = payload.readUInt32LE(1);
  const sequence = payload.readUInt32LE(5);
  const eventKindByte = payload.readUInt8(9);
  const levelByte = payload.readUInt8(10);
  const eventKind = eventKindByte === 1 ? "detected" : eventKindByte === 2 ? "cleared" : null;
  if (version !== VEHICLE_SENSOR_VENDOR_MODEL.protocolVersion || !eventKind ||
    (levelByte !== 0 && levelByte !== 1) || (eventKind === "detected") !== (levelByte === 1)) {
    throw new Error("malformed_vehicle_sensor_vendor_event");
  }
  return { bootId, sequence, eventKind, level: levelByte === 1 };
}

export function encodeVendorVehicleEventAcknowledgement(
  event: Pick<VendorVehicleEvent, "bootId" | "sequence">,
  vendorModel: VehicleSensorVendorModel
) {
  assertUint32(event.bootId);
  assertUint32(event.sequence);
  const payload = Buffer.alloc(VEHICLE_SENSOR_VENDOR_MODEL.acknowledgementPayloadLength);
  payload.writeUInt8(VEHICLE_SENSOR_VENDOR_MODEL.protocolVersion, 0);
  payload.writeUInt32LE(event.bootId, 1);
  payload.writeUInt32LE(event.sequence, 5);
  return Uint8Array.from([...vendorModel.acknowledgementOpcode, ...payload]);
}

export function assertVendorEvent(event: VendorVehicleEvent) {
  assertUint32(event.bootId);
  assertUint32(event.sequence);
  if ((event.eventKind === "detected") !== event.level) {
    throw new Error("malformed_vehicle_sensor_vendor_event");
  }
}

function assertUint32(value: number) {
  if (!Number.isInteger(value) || value < 0 || value > UINT32_MAX) {
    throw new Error("malformed_vehicle_sensor_vendor_event");
  }
}
