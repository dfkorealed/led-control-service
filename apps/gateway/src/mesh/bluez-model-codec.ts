const LIGHT_LIGHTNESS_SET = Buffer.from([0x82, 0x4c]);
const LIGHT_LIGHTNESS_SET_UNACKNOWLEDGED = Buffer.from([0x82, 0x4d]);
const LIGHT_LIGHTNESS_STATUS = Buffer.from([0x82, 0x4e]);
const GENERIC_ONOFF_SET = Buffer.from([0x82, 0x02]);
const GENERIC_ONOFF_STATUS = Buffer.from([0x82, 0x04]);
const HEALTH_CURRENT_STATUS = 0x04;
const HEALTH_FAULT_STATUS = 0x05;

export function encodeLightnessSet(input: { lightness: number; tid: number }) {
  assertUint16(input.lightness, "lightness");
  assertUint8(input.tid, "tid");
  const payload = Buffer.alloc(5);
  LIGHT_LIGHTNESS_SET.copy(payload, 0);
  payload.writeUInt16LE(input.lightness, 2);
  payload.writeUInt8(input.tid, 4);
  return payload;
}

export function encodeLightnessSetUnacknowledged(lightness: number, tid: number) {
  assertUint16(lightness, "lightness");
  assertUint8(tid, "tid");
  const payload = Buffer.alloc(5);
  LIGHT_LIGHTNESS_SET_UNACKNOWLEDGED.copy(payload, 0);
  payload.writeUInt16LE(lightness, 2);
  payload.writeUInt8(tid, 4);
  return payload;
}

export function encodeGenericOnOffSet(input: { on: boolean; tid: number }) {
  assertUint8(input.tid, "tid");
  return Buffer.from([...GENERIC_ONOFF_SET, input.on ? 1 : 0, input.tid]);
}

export function decodeLightnessStatus(payload: Buffer) {
  if (payload.length !== 4 && payload.length !== 7) throw new Error("invalid Light Lightness Status length");
  if (!payload.subarray(0, 2).equals(LIGHT_LIGHTNESS_STATUS)) throw new Error("unexpected Light Lightness Status opcode");
  const result: { present: number; target?: number; remainingTime?: number } = { present: payload.readUInt16LE(2) };
  if (payload.length === 7) {
    result.target = payload.readUInt16LE(4);
    result.remainingTime = payload.readUInt8(6);
  }
  return result;
}

export function decodeGenericOnOffStatus(payload: Buffer) {
  if (payload.length !== 3 && payload.length !== 5) throw new Error("invalid Generic OnOff Status length");
  if (!payload.subarray(0, 2).equals(GENERIC_ONOFF_STATUS)) throw new Error("unexpected Generic OnOff Status opcode");
  const result: { present: boolean; target?: boolean; remainingTime?: number } = { present: payload[2] !== 0 };
  if (payload.length === 5) {
    result.target = payload[3] !== 0;
    result.remainingTime = payload[4];
  }
  return result;
}

export function decodeHealthStatus(payload: Buffer) {
  if (payload.length < 4 || (payload[0] !== HEALTH_CURRENT_STATUS && payload[0] !== HEALTH_FAULT_STATUS)) {
    throw new Error("invalid Health status");
  }
  return {
    kind: payload[0] === HEALTH_CURRENT_STATUS ? "current" as const : "registered" as const,
    testId: payload[1],
    companyId: payload.readUInt16LE(2),
    faults: [...payload.subarray(4)].filter((fault) => fault !== 0)
  };
}

export function percentToLightness(percent: number) {
  if (!Number.isInteger(percent) || percent < 0 || percent > 100) throw new Error("brightness percent must be 0 to 100");
  return Math.round((percent / 100) * 65535);
}

export function lightnessToPercent(lightness: number) {
  assertUint16(lightness, "lightness");
  return Math.round((lightness / 65535) * 100);
}

function assertUint8(value: number, name: string) {
  if (!Number.isInteger(value) || value < 0 || value > 0xff) throw new Error(`${name} must be uint8`);
}

function assertUint16(value: number, name: string) {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff) throw new Error(`${name} must be uint16`);
}
