// Test-only temporal binding for this one immutable BIO handoff. Callers pass
// their existing canonical hash; no production export or second hash algorithm.
function instantiateBioSensorCommonPath(asset, baseInstant, canonicalHash) {
  const delta = Date.parse(baseInstant) - Date.parse(asset.exemplarBaseInstant);
  if (asset.version !== 1 || asset.testOnly !== true || !Number.isFinite(delta)) throw new Error("invalid BIO test temporal binding");
  const shift = (value, key = "") => {
    if (typeof value === "string" && key.endsWith("At") && /^\d{4}-\d\d-\d\dT/.test(value)) {
      return new Date(Date.parse(value) + delta).toISOString();
    }
    if (Array.isArray(value)) return value.map(item => shift(item));
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, shift(item, name)]));
    return value;
  };
  const result = shift(asset.handoff);
  if (result.catalog) {
    result.catalog.payloadHash = canonicalHash(result.catalog.payload);
    result.catalog.ack.deliveryPayloadHash = result.catalog.payloadHash;
  }
  for (const preparation of result.preparations) {
    preparation.commandPayloadHash = canonicalHash(preparation.command);
    preparation.report.commandPayloadHash = preparation.commandPayloadHash;
    preparation.reportPayloadHash = canonicalHash(preparation.report);
    preparation.ack.reportPayloadHash = preparation.reportPayloadHash;
  }
  for (const live of result.live) {
    live.deliveryPayloadHash = canonicalHash(live.delivery);
    live.ack.deliveryPayloadHash = live.deliveryPayloadHash;
  }
  for (const snapshot of result.snapshots) {
    const { payloadHash: _hash, ...body } = snapshot.payload;
    snapshot.payload.payloadHash = canonicalHash(body);
    if (snapshot.configAppliedDelivery) snapshot.configAppliedDelivery.acknowledgement.payloadHash = snapshot.payload.payloadHash;
  }
  return result;
}
module.exports = { instantiateBioSensorCommonPath };
