interface BootstrapOwnerInput {
  organizationName: string;
  email: string;
  name: string;
  password: string;
}

export interface BootstrapDatabase {
  user: {
    count(): Promise<number>;
    create(input: { data: Record<string, unknown> }): Promise<{ id: string; email: string }>;
  };
  organization: {
    create(input: { data: { name: string } }): Promise<{ id: string; name: string }>;
  };
  $transaction<T>(callback: (tx: BootstrapDatabase) => Promise<T>): Promise<T>;
}

export async function bootstrapFirstOwner(
  prisma: BootstrapDatabase,
  input: BootstrapOwnerInput,
  hashPassword: (password: string) => Promise<string>
) {
  const organizationName = input.organizationName.trim();
  const email = input.email.trim().toLowerCase();
  const name = input.name.trim();
  if (!organizationName || !email || !name) throw new Error("BOOTSTRAP_INPUT_REQUIRED");
  const passwordHash = await hashPassword(input.password);

  return prisma.$transaction(async (tx) => {
    if ((await tx.user.count()) !== 0) {
      throw new Error("BOOTSTRAP_REFUSED: at least one user already exists");
    }
    const organization = await tx.organization.create({ data: { name: organizationName } });
    const user = await tx.user.create({
      data: {
        organizationId: organization.id,
        email,
        name,
        passwordHash,
        role: "owner",
        status: "active"
      }
    });
    return { organizationId: organization.id, userId: user.id, email: user.email };
  });
}
