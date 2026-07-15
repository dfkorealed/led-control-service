import "reflect-metadata";
import { BadRequestException, Injectable } from "@nestjs/common";
import { webcrypto } from "node:crypto";
import { Pkcs10CertificateRequest } from "@peculiar/x509";

const MAX_CSR_BYTES = 16 * 1024;
const nodeCrypto = webcrypto as unknown as Crypto;

export interface ValidatedGatewayCsr {
  publicKey: CryptoKey;
}

export async function validateGatewayCsr(csrPem: string): Promise<ValidatedGatewayCsr> {
  if (typeof csrPem !== "string" || !csrPem.trim() || Buffer.byteLength(csrPem, "utf8") > MAX_CSR_BYTES) {
    throw new BadRequestException("CSR is invalid");
  }

  let request: Pkcs10CertificateRequest;
  try {
    request = new Pkcs10CertificateRequest(csrPem);
  } catch {
    throw new BadRequestException("CSR is invalid");
  }

  let verified: boolean;
  try {
    verified = await request.verify(nodeCrypto);
  } catch {
    throw new BadRequestException("CSR proof-of-possession is invalid");
  }
  if (!verified) throw new BadRequestException("CSR proof-of-possession is invalid");

  const algorithm = request.publicKey.algorithm as EcKeyAlgorithm;
  if (algorithm.name !== "ECDSA" || algorithm.namedCurve !== "P-256") {
    throw new BadRequestException("CSR public key must be ECDSA P-256");
  }

  try {
    return { publicKey: await request.publicKey.export(nodeCrypto) };
  } catch {
    throw new BadRequestException("CSR public key is invalid");
  }
}

@Injectable()
export class GatewayCsrValidator {
  validate(csrPem: string) {
    return validateGatewayCsr(csrPem);
  }
}
