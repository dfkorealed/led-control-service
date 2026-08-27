import { PrismaClient } from "@prisma/client";
import { PasswordService } from "../src/auth/password.service";
import { bootstrapFirstOperator, type BootstrapDatabase } from "../src/auth/bootstrap-operator";

const prisma = new PrismaClient();

function required(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function main() {
  const passwords = new PasswordService();
  const result = await bootstrapFirstOperator(
    prisma as unknown as BootstrapDatabase,
    {
      organizationName: required("BOOTSTRAP_ORGANIZATION_NAME"),
      loginId: required("BOOTSTRAP_OPERATOR_LOGIN_ID"),
      name: required("BOOTSTRAP_OPERATOR_NAME"),
      password: required("BOOTSTRAP_OPERATOR_PASSWORD")
    },
    (password) => passwords.hash(password)
  );
  console.log(JSON.stringify(result));
}

void main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => prisma.$disconnect());
