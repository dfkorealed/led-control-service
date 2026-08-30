export const CONFIG_OPCODES = {
  compositionDataGet: Uint8Array.from([0x80, 0x08]),
  compositionDataStatus: Uint8Array.from([0x02]),
  appKeyStatus: Uint8Array.from([0x80, 0x03]),
  modelAppBind: Uint8Array.from([0x80, 0x3d]),
  modelAppStatus: Uint8Array.from([0x80, 0x3e]),
  modelSubscriptionAdd: Uint8Array.from([0x80, 0x1b]),
  modelSubscriptionDelete: Uint8Array.from([0x80, 0x1c]),
  modelSubscriptionStatus: Uint8Array.from([0x80, 0x1f]),
  modelPublicationSet: Uint8Array.from([0x03]),
  modelPublicationStatus: Uint8Array.from([0x80, 0x19])
} as const;

export function encodeCompositionDataGet(page = 0) {
  assertByte(page, "composition page");
  return Uint8Array.from([...CONFIG_OPCODES.compositionDataGet, page]);
}

export function encodeModelAppBind(elementAddress: number, appKeyIndex: number, modelId: number, companyId?: number) {
  assertUnicast(elementAddress);
  assertKeyIndex(appKeyIndex);
  assertUint16(modelId, "model id");
  if (companyId !== undefined) assertUint16(companyId, "company id");
  return Uint8Array.from([
    ...CONFIG_OPCODES.modelAppBind,
    ...uint16Le(elementAddress),
    ...uint16Le(appKeyIndex),
    ...(companyId === undefined ? [] : uint16Le(companyId)),
    ...uint16Le(modelId)
  ]);
}

export function encodeModelPublicationSet(input: {
  elementAddress: number;
  publishAddress: number;
  appKeyIndex: number;
  ttl: number;
  modelId: number;
  companyId?: number;
  period?: number;
  retransmit?: number;
  friendshipCredential?: boolean;
}) {
  assertUnicast(input.elementAddress);
  assertUint16(input.publishAddress, "publish address");
  assertKeyIndex(input.appKeyIndex);
  assertByte(input.ttl, "ttl");
  assertUint16(input.modelId, "model id");
  if (input.companyId !== undefined) assertUint16(input.companyId, "company id");
  const appKeyAndCredential = input.appKeyIndex | (input.friendshipCredential ? 0x1000 : 0);
  return Uint8Array.from([
    ...CONFIG_OPCODES.modelPublicationSet,
    ...uint16Le(input.elementAddress),
    ...uint16Le(input.publishAddress),
    ...uint16Le(appKeyAndCredential),
    input.ttl,
    input.period ?? 0,
    input.retransmit ?? 0,
    ...(input.companyId === undefined ? [] : uint16Le(input.companyId)),
    ...uint16Le(input.modelId)
  ]);
}

export function encodeModelSubscriptionAdd(elementAddress: number, groupAddress: number, modelId: number) {
  assertUnicast(elementAddress);
  assertGroupAddress(groupAddress);
  assertUint16(modelId, "model id");
  return Uint8Array.from([
    ...CONFIG_OPCODES.modelSubscriptionAdd,
    ...uint16Le(elementAddress),
    ...uint16Le(groupAddress),
    ...uint16Le(modelId)
  ]);
}

export function encodeModelSubscriptionDelete(elementAddress: number, groupAddress: number, modelId: number) {
  assertUnicast(elementAddress);
  assertGroupAddress(groupAddress);
  assertUint16(modelId, "model id");
  return Uint8Array.from([
    ...CONFIG_OPCODES.modelSubscriptionDelete,
    ...uint16Le(elementAddress),
    ...uint16Le(groupAddress),
    ...uint16Le(modelId)
  ]);
}

/** Bluetooth Mesh publication periods use a 6-bit step count plus a 2-bit resolution. */
export function encodePublicationPeriod(milliseconds: number) {
  if (!Number.isInteger(milliseconds) || milliseconds <= 0) throw new Error("Invalid publication period");
  const resolutions = [
    { milliseconds: 600_000, value: 3 },
    { milliseconds: 10_000, value: 2 },
    { milliseconds: 1_000, value: 1 },
    { milliseconds: 100, value: 0 }
  ];
  const resolution = resolutions.find(({ milliseconds: unit }) => milliseconds % unit === 0 && milliseconds / unit <= 0x3f);
  if (!resolution) throw new Error("Invalid publication period");
  return (resolution.value << 6) | (milliseconds / resolution.milliseconds);
}

export function parseCompositionDataStatus(data: Uint8Array) {
  expectOpcode(data, CONFIG_OPCODES.compositionDataStatus, 2);
  return { page: data[1], data: data.slice(2) };
}

export function parseAppKeyStatus(data: Uint8Array, options: { allowAlreadyStored?: boolean } = {}) {
  const offset = expectOpcode(data, CONFIG_OPCODES.appKeyStatus, 6);
  if (data[offset] !== 0 && !(options.allowAlreadyStored && data[offset] === 0x06)) assertSuccess(data[offset]);
  const [netKeyIndex, appKeyIndex] = unpackKeyIndexes(data.slice(offset + 1, offset + 4));
  return { netKeyIndex, appKeyIndex };
}

export function parseModelAppStatus(data: Uint8Array) {
  const offset = expectOpcode(data, CONFIG_OPCODES.modelAppStatus, 9);
  if (data.length !== 9 && data.length !== 11) throw new Error("Malformed Bluetooth Mesh Config status");
  assertSuccess(data[offset]);
  const base = {
    elementAddress: readUint16Le(data, offset + 1),
    appKeyIndex: readUint16Le(data, offset + 3) & 0x0fff
  };
  return data.length === 9
    ? { ...base, modelId: readUint16Le(data, offset + 5) }
    : { ...base, companyId: readUint16Le(data, offset + 5), modelId: readUint16Le(data, offset + 7) };
}

export function parseModelPublicationStatus(data: Uint8Array) {
  const offset = expectOpcode(data, CONFIG_OPCODES.modelPublicationStatus, 14);
  if (data.length !== 14 && data.length !== 16) throw new Error("Malformed Bluetooth Mesh Config status");
  assertSuccess(data[offset]);
  const appKeyAndCredential = readUint16Le(data, offset + 5);
  const base = {
    elementAddress: readUint16Le(data, offset + 1),
    publishAddress: readUint16Le(data, offset + 3),
    appKeyIndex: appKeyAndCredential & 0x0fff,
    friendshipCredential: Boolean(appKeyAndCredential & 0x1000),
    ttl: data[offset + 7],
    period: data[offset + 8],
    retransmit: data[offset + 9]
  };
  return data.length === 14
    ? { ...base, modelId: readUint16Le(data, offset + 10) }
    : { ...base, companyId: readUint16Le(data, offset + 10), modelId: readUint16Le(data, offset + 12) };
}

export function parsePrimaryElementCompositionModels(data: Uint8Array) {
  if (data.length < 14) throw new Error("Malformed Bluetooth Mesh Composition Data");
  let offset = 10;
  let primary: { sigModelIds: number[]; vendorModels: Array<{ companyId: number; modelId: number }> } | undefined;
  while (offset < data.length) {
    if (offset + 4 > data.length) throw new Error("Malformed Bluetooth Mesh Composition Data");
    const sigCount = data[offset + 2]!;
    const vendorCount = data[offset + 3]!;
    offset += 4;
    const modelsLength = sigCount * 2 + vendorCount * 4;
    if (offset + modelsLength > data.length) throw new Error("Malformed Bluetooth Mesh Composition Data");
    const sigModelIds = Array.from({ length: sigCount }, (_, index) => readUint16Le(data, offset + index * 2));
    const vendorOffset = offset + sigCount * 2;
    const vendorModels = Array.from({ length: vendorCount }, (_, index) => ({
      companyId: readUint16Le(data, vendorOffset + index * 4),
      modelId: readUint16Le(data, vendorOffset + index * 4 + 2)
    }));
    primary ??= { sigModelIds, vendorModels };
    offset += modelsLength;
  }
  if (!primary || offset !== data.length) throw new Error("Malformed Bluetooth Mesh Composition Data");
  return primary;
}

export function parseModelSubscriptionStatus(data: Uint8Array) {
  const offset = expectOpcode(data, CONFIG_OPCODES.modelSubscriptionStatus, 9);
  assertSuccess(data[offset]);
  return {
    elementAddress: readUint16Le(data, offset + 1),
    groupAddress: readUint16Le(data, offset + 3),
    modelId: readUint16Le(data, offset + 5)
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

function assertGroupAddress(value: number) {
  if (!Number.isInteger(value) || value < 0xc000 || value > 0xfeff) throw new Error("Invalid group address");
}

function assertByte(value: number, name: string) {
  if (!Number.isInteger(value) || value < 0 || value > 0xff) throw new Error(`Invalid ${name}`);
}

function assertUint16(value: number, name: string) {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff) throw new Error(`Invalid ${name}`);
}
