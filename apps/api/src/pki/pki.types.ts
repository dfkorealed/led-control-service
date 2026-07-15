export type CertificatePurpose = "device" | "mqtt";

export type GatewayCertificateStatus =
  | "active"
  | "pending"
  | "replaced"
  | "revoked"
  | "expired";

export interface SignCsrInput {
  purpose: CertificatePurpose;
  csrPem: string;
  commonName: string;
  uriSans: string[];
  ttlSeconds: number;
}

export interface SignedCertificate {
  certificatePem: string;
  caChainPem: string[];
  certificateSerial: string;
  fingerprint: string;
  issuer: string;
  notBefore: string;
  notAfter: string;
}

export interface RevokeCertificateInput {
  purpose: CertificatePurpose;
  certificateSerial: string;
  issuer: string;
  fingerprint: string;
}

/**
 * Task 27/29 lifecycle transaction must reject a replacement when the two
 * certificates do not share this inventory and purpose, or when it creates a
 * cycle in the existing replacement chain.
 */
export interface CertificateReplacementInput {
  inventoryId: string;
  purpose: CertificatePurpose;
  replacedCertificateId: string;
  replacementCertificateId: string;
}
