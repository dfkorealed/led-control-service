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

export const LED_CONTROL_COMPANY_ID = 0x02e5;

/** Product-owned values shared with the Task 16 ESP32-H2 vendor model. */
export const VEHICLE_SENSOR_VENDOR_MODEL = {
  protocolVersion: 1,
  serverModelId: 0x0000,
  clientModelId: 0x0001,
  eventOpcode: Uint8Array.from([0xc1, LED_CONTROL_COMPANY_ID & 0xff, LED_CONTROL_COMPANY_ID >> 8]),
  acknowledgementOpcode: Uint8Array.from([0xc2, LED_CONTROL_COMPANY_ID & 0xff, LED_CONTROL_COMPANY_ID >> 8]),
  eventPayloadLength: 11,
  acknowledgementPayloadLength: 9
} as const;

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
