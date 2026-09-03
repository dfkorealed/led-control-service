/** Values mirrored from ESP-IDF's Bluetooth Mesh assigned-number headers. */
export const BLUETOOTH_MESH_MODELS = {
  sensorServer: 0x1100,
  sensorClient: 0x1102
} as const;

export const BLUETOOTH_MESH_SENSOR = {
  opcodes: {
    get: Uint8Array.from([0x82, 0x31]),
    status: Uint8Array.from([0x52])
  },
  properties: {
    motionSensed: 0x0042,
    presenceDetected: 0x004d
  }
} as const;

/** Product-owned values shared with the Task 16 ESP32-H2 vendor model. */
export const VEHICLE_SENSOR_VENDOR_MODEL = {
  protocolVersion: 1,
  serverModelId: 0x0000,
  clientModelId: 0x0001,
  eventOpcodeNumber: 0xc1,
  acknowledgementOpcodeNumber: 0xc2,
  eventPayloadLength: 11,
  acknowledgementPayloadLength: 9
} as const;

export type VehicleSensorVendorModel = typeof VEHICLE_SENSOR_VENDOR_MODEL & {
  companyId: number;
  eventOpcode: Uint8Array;
  acknowledgementOpcode: Uint8Array;
};

export function createVehicleSensorVendorModel(companyId: number): VehicleSensorVendorModel {
  if (!Number.isInteger(companyId) || companyId < 0 || companyId >= 0xffff) {
    throw new Error("invalid_bluetooth_company_id");
  }
  return {
    ...VEHICLE_SENSOR_VENDOR_MODEL,
    companyId,
    eventOpcode: vendorOpcode(VEHICLE_SENSOR_VENDOR_MODEL.eventOpcodeNumber, companyId),
    acknowledgementOpcode: vendorOpcode(VEHICLE_SENSOR_VENDOR_MODEL.acknowledgementOpcodeNumber, companyId)
  };
}

function vendorOpcode(opcode: number, companyId: number) {
  return Uint8Array.from([opcode, companyId & 0xff, companyId >> 8]);
}

export function encodePresenceDetectedSensorGet() {
  const propertyId = BLUETOOTH_MESH_SENSOR.properties.presenceDetected;
  return Uint8Array.from([
    ...BLUETOOTH_MESH_SENSOR.opcodes.get,
    propertyId & 0xff,
    propertyId >> 8
  ]);
}

export function startsWithMeshOpcode(data: Uint8Array, opcode: Uint8Array) {
  return data.length >= opcode.length && opcode.every((value, index) => data[index] === value);
}
