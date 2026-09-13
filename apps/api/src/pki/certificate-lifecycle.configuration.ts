import type { publishCrlAtomically } from "./crl-publisher";

export const CERTIFICATE_LIFECYCLE_CONFIGURATION = Symbol("CERTIFICATE_LIFECYCLE_CONFIGURATION");

export interface CertificateLifecycleConfiguration {
  deviceCrlPath?: string;
  mqttCrlPath?: string;
  trustedRootCrlPem?: string;
  publishCrl: typeof publishCrlAtomically;
}
