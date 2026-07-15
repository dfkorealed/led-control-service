interface EnrollGatewayInventoryInput {
  serialNumber: string;
  claimCode: string;
  certificateFingerprint?: string | null;
}

interface InventoryDatabase {
  gatewayInventory: {
    create(input: { data: { serialNumber: string; claimCodeHash: string; certificateFingerprint?: string } }): Promise<unknown>;
  };
}

export async function enrollGatewayInventory(
  prisma: InventoryDatabase,
  input: EnrollGatewayInventoryInput,
  hashClaimCode: (claimCode: string) => Promise<string>
) {
  const serialNumber = required(input.serialNumber, "serialNumber");
  const claimCode = required(input.claimCode, "claimCode");
  let certificateFingerprint: string | undefined;

  if (input.certificateFingerprint != null) {
    certificateFingerprint = required(input.certificateFingerprint, "certificateFingerprint")
      .replace(/:/g, "")
      .toUpperCase();
    if (!/^[0-9A-F]{64}$/.test(certificateFingerprint)) {
      throw new Error("certificateFingerprint must be a SHA-256 fingerprint");
    }
  }

  const claimCodeHash = await hashClaimCode(claimCode);
  const data = {
    serialNumber,
    claimCodeHash,
    ...(certificateFingerprint ? { certificateFingerprint } : {})
  };
  return prisma.gatewayInventory.create({ data });
}

function required(value: string, name: string) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required`);
  return value.trim();
}
