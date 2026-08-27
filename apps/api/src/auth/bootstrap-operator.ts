import { normalizeLoginId } from "./auth.types";

interface BootstrapOperatorInput {
  organizationName: string;
  loginId: string;
  name: string;
  password: string;
}

interface BootstrapRecord {
  id: string;
}

export interface BootstrapDatabase {
  user: {
    findFirst(input: { where: { role: "operator" }; select: { id: true } }): Promise<BootstrapRecord | null>;
    create(input: { data: Record<string, unknown> }): Promise<{ id: string; loginId: string }>;
  };
  organization: {
    findFirst(input: {
      where: { type: "service_provider" };
      select: { id: true };
    }): Promise<BootstrapRecord | null>;
    create(input: { data: { name: string; type: "service_provider" } }): Promise<{ id: string; name: string }>;
  };
  $executeRawUnsafe(query: string): Promise<unknown>;
  $transaction<T>(callback: (tx: BootstrapDatabase) => Promise<T>): Promise<T>;
}

export async function bootstrapFirstOperator(
  prisma: BootstrapDatabase,
  input: BootstrapOperatorInput,
  hashPassword: (password: string) => Promise<string>
) {
  const organizationName = input.organizationName.trim();
  const loginId = normalizeLoginId(input.loginId);
  const name = input.name.trim();
  if (!organizationName || !name) throw new Error("BOOTSTRAP_INPUT_REQUIRED");
  const passwordHash = await hashPassword(input.password);

  return prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe("SELECT pg_advisory_xact_lock(80520260721)");

    const [serviceProvider, operator] = await Promise.all([
      tx.organization.findFirst({
        where: { type: "service_provider" },
        select: { id: true }
      }),
      tx.user.findFirst({
        where: { role: "operator" },
        select: { id: true }
      })
    ]);

    if (serviceProvider || operator) {
      throw new Error("BOOTSTRAP_REFUSED: a service provider organization or operator already exists");
    }
    const organization = await tx.organization.create({
      data: { name: organizationName, type: "service_provider" }
    });
    const user = await tx.user.create({
      data: {
        organizationId: organization.id,
        loginId,
        email: null,
        name,
        passwordHash,
        role: "operator",
        status: "active"
      }
    });
    return { organizationId: organization.id, userId: user.id, loginId: user.loginId };
  });
}
