import { readJsonFile, writeJsonAtomic } from "../mesh/mesh-store-file";

export interface ApplianceHealthState {
  version: 1;
  status: "starting-unassigned" | "starting" | "healthy" | "unhealthy";
  assignment: boolean;
  mesh: boolean;
  mqtt: boolean;
  mapping: boolean;
  updatedAt: string;
  reason?: string;
}

export class ApplianceHealth {
  constructor(
    private readonly path: string,
    private readonly now: () => Date = () => new Date()
  ) {}

  startingUnassigned() {
    return this.write({ status: "starting-unassigned", assignment: false, mesh: false, mqtt: false, mapping: false });
  }

  startingAssigned() {
    return this.write({ status: "starting", assignment: true, mesh: false, mqtt: false, mapping: false });
  }

  meshReady() {
    return this.write({ status: "starting", assignment: true, mesh: true, mqtt: false, mapping: true });
  }

  healthy() {
    return this.write({ status: "healthy", assignment: true, mesh: true, mqtt: true, mapping: true });
  }

  unhealthy(reason: string) {
    return this.write({ status: "unhealthy", assignment: true, mesh: true, mqtt: false, mapping: true, reason });
  }

  async read(): Promise<ApplianceHealthState | null> {
    return await readJsonFile(this.path) as ApplianceHealthState | null;
  }

  private write(state: Omit<ApplianceHealthState, "version" | "updatedAt">) {
    return writeJsonAtomic(this.path, { version: 1, ...state, updatedAt: this.now().toISOString() } satisfies ApplianceHealthState);
  }
}
