import type { CertificatePurpose, RevokeCertificateInput, SignCsrInput, SignedCertificate } from "./pki.types";

export const CERTIFICATE_AUTHORITY_PROVIDER = Symbol("CERTIFICATE_AUTHORITY_PROVIDER");

export interface CertificateAuthorityProvider {
  signCsr(input: SignCsrInput): Promise<SignedCertificate>;
  revoke(input: RevokeCertificateInput): Promise<void>;
  readCrl(purpose: CertificatePurpose): Promise<string>;
}

export class UnavailableCertificateAuthorityProvider implements CertificateAuthorityProvider {
  async signCsr(_input: SignCsrInput): Promise<SignedCertificate> {
    throw new Error("certificate authority is unavailable");
  }

  async revoke(_input: RevokeCertificateInput): Promise<void> {
    throw new Error("certificate authority is unavailable");
  }

  async readCrl(_purpose: CertificatePurpose): Promise<string> {
    throw new Error("certificate authority is unavailable");
  }
}
