import { Injectable } from "@nestjs/common";
import { isAbsolute } from "node:path";
import { probeCadConverterSpoolReadiness } from "./cad-converter-spool";

@Injectable()
export class CadSidecarReadinessService {
  async probeReadiness() {
    if (process.env.CAD_IMPORT_CONVERTER_MODE !== "sidecar") return;
    const spoolRoot = process.env.CAD_IMPORT_CONVERTER_SPOOL_ROOT?.trim();
    const digest = process.env.CAD_IMPORT_CONVERTER_SHA256?.trim();
    if (!spoolRoot || !isAbsolute(spoolRoot) || !digest || !/^[a-f0-9]{64}$/.test(digest)) {
      throw new Error("CAD converter sidecar readiness configuration is invalid");
    }
    await probeCadConverterSpoolReadiness(spoolRoot, digest);
  }
}
