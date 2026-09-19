export const CAD_IMPORT_CONVERTER = Symbol("CAD_IMPORT_CONVERTER");
export const CAD_IMPORT_RULE_DETECTOR = Symbol("CAD_IMPORT_RULE_DETECTOR");
export const CAD_IMPORT_AI_DETECTOR = Symbol("CAD_IMPORT_AI_DETECTOR");
export const CAD_IMPORT_CORE_EXECUTOR = Symbol("CAD_IMPORT_CORE_EXECUTOR");
export const CAD_IMPORT_WORKER_OPTIONS = Symbol("CAD_IMPORT_WORKER_OPTIONS");

export interface FloorImportWorkerOptions {
  tempRoot: string;
  pollIntervalMs: number;
  enabled?: boolean;
  /** Keep true until U6 replaces legacy public apply/review with common documents.
   * False stops only duplicate cad_manifest/cad_tile uploads, not canonical data. */
  legacyDisplayCompatibility?: boolean;
}
