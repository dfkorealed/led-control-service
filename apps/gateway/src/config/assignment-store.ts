import { open, mkdir, readFile, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { GatewayAssignment, parseGatewayAssignment } from "./assignment";

export class AssignmentStore {
  constructor(private readonly path: string) {}

  async read(): Promise<GatewayAssignment | null> {
    try {
      return parseGatewayAssignment(JSON.parse(await readFile(this.path, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async writeAtomic(assignment: GatewayAssignment) {
    const validated = parseGatewayAssignment(assignment);
    const directory = dirname(this.path);
    const temporaryPath = `${this.path}.${process.pid}.${Date.now()}.tmp`;
    await mkdir(directory, { recursive: true, mode: 0o700 });

    try {
      const file = await open(temporaryPath, "wx", 0o600);
      try {
        await file.writeFile(`${JSON.stringify(validated, null, 2)}\n`, "utf8");
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temporaryPath, this.path);
      const directoryHandle = await open(directory, "r");
      try {
        await directoryHandle.sync();
      } finally {
        await directoryHandle.close();
      }
    } catch (error) {
      await rm(temporaryPath, { force: true });
      throw error;
    }
  }
}
