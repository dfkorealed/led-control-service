export const CONFIG_OPCODES = {
  compositionDataGet: Uint8Array.from([0x80, 0x08]),
  compositionDataStatus: Uint8Array.from([0x02]),
  appKeyStatus: Uint8Array.from([0x80, 0x03]),
  modelAppBind: Uint8Array.from([0x80, 0x3d]),
  modelAppStatus: Uint8Array.from([0x80, 0x3e]),
  modelPublicationSet: Uint8Array.from([0x03]),
  modelPublicationStatus: Uint8Array.from([0x80, 0x19])
} as const;

export function encodeCompositionDataGet(page = 0) {
  assertByte(page, "composition page");
  return Uint8Array.from([...CONFIG_OPCODES.compositionDataGet, page]);
}

export function encodeModelAppBind(elementAddress: number, appKeyIndex: number, modelId: number) {
  assertUnicast(elementAddress);
  assertKeyIndex(appKeyIndex);
  assertUint16(modelId, "model id");
  return Uint8Array.from([
    ...CONFIG_OPCODES.modelAppBind,
    ...uint16Le(elementAddress),
    ...uint16Le(appKeyIndex),
    ...uint16Le(modelId)
  ]);
}

export function encodeModelPublicationSet(input: {
  elementAddress: number;
  publishAddress: number;
  appKeyIndex: number;
  ttl: number;
  modelId: number;
  period?: number;
  retransmit?: number;
  friendshipCredential?: boolean;
}) {
  assertUnicast(input.elementAddress);
  assertUint16(input.publishAddress, "publish address");
  assertKeyIndex(input.appKeyIndex);
  assertByte(input.ttl, "ttl");
  assertUint16(input.modelId, "model id");
  const appKeyAndCredential = input.appKeyIndex | (input.friendshipCredential ? 0x1000 : 0);
  return Uint8Array.from([
    ...CONFIG_OPCODES.modelPublicationSet,
    ...uint16Le(input.elementAddress),
    ...uint16Le(input.publishAddress),
    ...uint16Le(appKeyAndCredential),
    input.ttl,
    input.period ?? 0,
    input.retransmit ?? 0,
    ...uint16Le(input.modelId)
  ]);
}

export function parseCompositionDataStatus(data: Uint8Array) {
  expectOpcode(data, CONFIG_OPCODES.compositionDataStatus, 2);
  return { page: data[1], data: data.slice(2) };
}

export function parseAppKeyStatus(data: Uint8Array) {
  const offset = expectOpcode(data, CONFIG_OPCODES.appKeyStatus, 6);
  assertSuccess(data[offset]);
  const [netKeyIndex, appKeyIndex] = unpackKeyIndexes(data.slice(offset + 1, offset + 4));
  return { netKeyIndex, appKeyIndex };
}

export function parseModelAppStatus(data: Uint8Array) {
  const offset = expectOpcode(data, CONFIG_OPCODES.modelAppStatus, 9);
  assertSuccess(data[offset]);
  return {
    elementAddress: readUint16Le(data, offset + 1),
    appKeyIndex: readUint16Le(data, offset + 3) & 0x0fff,
    modelId: readUint16Le(data, offset + 5)
  };
}

export function parseModelPublicationStatus(data: Uint8Array) {
  const offset = expectOpcode(data, CONFIG_OPCODES.modelPublicationStatus, 14);
  assertSuccess(data[offset]);
  const appKeyAndCredential = readUint16Le(data, offset + 5);
  return {
    elementAddress: readUint16Le(data, offset + 1),
    publishAddress: readUint16Le(data, offset + 3),
    appKeyIndex: appKeyAndCredential & 0x0fff,
    friendshipCredential: Boolean(appKeyAndCredential & 0x1000),
    ttl: data[offset + 7],
    period: data[offset + 8],
    retransmit: data[offset + 9],
    modelId: readUint16Le(data, offset + 10)
  };
}

export function startsWithOpcode(data: Uint8Array, opcode: Uint8Array) {
  return data.length >= opcode.length && opcode.every((value, index) => data[index] === value);
}

function unpackKeyIndexes(data: Uint8Array): [number, number] {
  if (data.length !== 3) throw new Error("Malformed Config AppKey Status");
  return [data[0] | ((data[1] & 0x0f) << 8), (data[1] >> 4) | (data[2] << 4)];
}

function expectOpcode(data: Uint8Array, opcode: Uint8Array, minimumLength: number) {
  if (!startsWithOpcode(data, opcode) || data.length < minimumLength) throw new Error("Malformed Bluetooth Mesh Config status");
  return opcode.length;
}

function assertSuccess(status: number) {
  if (status !== 0) throw new Error(`Bluetooth Mesh Config status 0x${status.toString(16).padStart(2, "0")}`);
}

function uint16Le(value: number) {
  return [value & 0xff, (value >> 8) & 0xff];
}

function readUint16Le(data: Uint8Array, offset: number) {
  return data[offset] | (data[offset + 1] << 8);
}

function assertUnicast(value: number) {
  if (!Number.isInteger(value) || value < 1 || value > 0x7fff) throw new Error("Invalid unicast address");
}

function assertKeyIndex(value: number) {
  if (!Number.isInteger(value) || value < 0 || value > 0x0fff) throw new Error("Invalid key index");
}

function assertByte(value: number, name: string) {
  if (!Number.isInteger(value) || value < 0 || value > 0xff) throw new Error(`Invalid ${name}`);
}

function assertUint16(value: number, name: string) {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff) throw new Error(`Invalid ${name}`);
}
