import { UnauthorizedException } from "@nestjs/common";
import { randomBytes, randomUUID } from "node:crypto";
import { AuditService } from "../audit/audit.service";
import { PrismaService } from "../prisma/prisma.service";
import { RedisProvider } from "../redis/redis.provider";
import { AuthChallengeStore } from "./auth-challenge.store";
import { AuthService } from "./auth.service";
import { LoginRateLimitService } from "./login-rate-limit.service";
import { MfaCryptoService } from "./mfa-crypto.service";
import { MfaService } from "./mfa.service";
import { PasswordService } from "./password.service";
import { SessionManagementService } from "./session-management.service";
import { TotpService } from "./totp.service";

const databaseUrl = process.env.AUTH_SECURITY_TEST_DATABASE_URL;
const redisUrl = process.env.AUTH_SECURITY_TEST_REDIS_URL;
const describeIntegration = databaseUrl && redisUrl ? describe : describe.skip;

describeIntegration("Account security PostgreSQL and Redis integration", () => {
  let prisma: PrismaService;
  let redis: RedisProvider;
  let auth: AuthService;
  let mfa: MfaService;
  let sessions: SessionManagementService;
  let totp: TotpService;
  let organizationId: string;
  let userId: string;
  const password = "integration security password";
  const ipAddress = "203.0.113.77";
  const userAgent = "security-integration";
  const previous = {
    redisUrl: process.env.REDIS_URL,
    mfaKey: process.env.MFA_ENCRYPTION_KEY
  };

  beforeAll(async () => {
    process.env.REDIS_URL = redisUrl!;
    process.env.MFA_ENCRYPTION_KEY = randomBytes(32).toString("base64");
    prisma = new PrismaService({ datasources: { db: { url: databaseUrl! } } });
    await prisma.$connect();
    redis = new RedisProvider();
    const audit = new AuditService(prisma);
    const passwords = new PasswordService();
    const crypto = new MfaCryptoService();
    totp = new TotpService();
    const challenges = new AuthChallengeStore(redis, crypto);
    const rateLimit = new LoginRateLimitService(redis, audit);
    mfa = new MfaService(prisma, passwords, audit, challenges, crypto, totp, rateLimit);
    auth = new AuthService(prisma, passwords, audit, rateLimit, mfa);
    sessions = new SessionManagementService(prisma, audit);

    organizationId = randomUUID();
    userId = randomUUID();
    await prisma.organization.create({ data: { id: organizationId, name: "Security integration", type: "customer" } });
    await prisma.user.create({ data: {
      id: userId, organizationId, loginId: `secure_${userId.slice(0, 8)}`, name: "Security Admin",
      passwordHash: await passwords.hash(password), role: "admin", status: "active"
    } });
  });

  afterAll(async () => {
    if (prisma) {
      await prisma.session.deleteMany({ where: { userId } });
      await prisma.userMfa.deleteMany({ where: { userId } });
      await prisma.user.deleteMany({ where: { id: userId } });
      await prisma.auditLog.deleteMany({ where: { organizationId } });
      await prisma.organization.deleteMany({ where: { id: organizationId } });
      await prisma.$disconnect();
    }
    await redis?.onModuleDestroy();
    if (previous.redisUrl === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = previous.redisUrl;
    if (previous.mfaKey === undefined) delete process.env.MFA_ENCRYPTION_KEY;
    else process.env.MFA_ENCRYPTION_KEY = previous.mfaKey;
  });

  it("enrolls MFA, rotates sessions, logs in with TOTP/recovery once, and disables MFA", async () => {
    const loginId = (await prisma.user.findUniqueOrThrow({ where: { id: userId } })).loginId;
    const direct = await auth.login({ loginId, password, rememberMe: true, ipAddress, userAgent });
    expect(direct).toHaveProperty("sessionToken");

    const enrollment = await mfa.startEnrollment(direct.user);
    const enrolled = await mfa.confirmEnrollment(direct.user, direct.sessionToken, {
      enrollmentToken: enrollment.enrollmentToken,
      code: totp.codeAt(enrollment.secret, Date.now())
    });
    await expect(auth.getUserBySessionToken(direct.sessionToken)).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(auth.getUserBySessionToken(enrolled.sessionToken)).resolves.toMatchObject({ id: userId });

    const challenge = await auth.login({ loginId, password, rememberMe: false, ipAddress, userAgent });
    expect(challenge).toMatchObject({ mfaRequired: true });
    const verified = await mfa.completeLogin({
      challengeToken: challenge.challengeToken,
      code: totp.codeAt(enrollment.secret, Date.now())
    }, ipAddress, userAgent);
    await expect(auth.getUserBySessionToken(verified.sessionToken)).resolves.toMatchObject({ id: userId });

    const active = await sessions.list(verified.user, verified.sessionToken);
    expect(active.sessions.some((session: { current: boolean }) => session.current)).toBe(true);
    await expect(sessions.revokeOthers(verified.user, verified.sessionToken)).resolves.toMatchObject({ revokedSessionCount: expect.any(Number) });
    await expect(auth.getUserBySessionToken(enrolled.sessionToken)).rejects.toBeInstanceOf(UnauthorizedException);

    const recoveryChallenge = await auth.login({ loginId, password, rememberMe: false, ipAddress, userAgent });
    const recovery = enrolled.recoveryCodes[0];
    const recovered = await mfa.completeLogin({ challengeToken: recoveryChallenge.challengeToken, recoveryCode: recovery }, ipAddress, userAgent);
    expect(recovered.recoveryCodeUsed).toBe(true);

    const replayChallenge = await auth.login({ loginId, password, rememberMe: false, ipAddress, userAgent });
    await expect(mfa.completeLogin({ challengeToken: replayChallenge.challengeToken, recoveryCode: recovery }, ipAddress, userAgent))
      .rejects.toBeInstanceOf(UnauthorizedException);

    const disabled = await mfa.disable(recovered.user, recovered.sessionToken, {
      currentPassword: password,
      code: totp.codeAt(enrollment.secret, Date.now())
    });
    await expect(auth.getUserBySessionToken(recovered.sessionToken)).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(auth.getUserBySessionToken(disabled.sessionToken)).resolves.toMatchObject({ id: userId });
    await expect(mfa.status(recovered.user)).resolves.toEqual({ enabled: false, enabledAt: null });
  }, 30_000);

  it("blocks the account bucket on Redis and records the rate-limit audit", async () => {
    const missingLoginId = `missing_${randomUUID().slice(0, 8)}`;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await expect(auth.login({
        loginId: missingLoginId, password: "wrong password", rememberMe: false,
        ipAddress: "198.51.100.50", userAgent
      })).rejects.toBeInstanceOf(UnauthorizedException);
    }
    const blocked = await auth.login({
      loginId: missingLoginId, password: "wrong password", rememberMe: false,
      ipAddress: "198.51.100.50", userAgent
    }).catch((error: unknown) => error) as { getStatus: () => number };
    expect(blocked.getStatus()).toBe(429);
    await expect(prisma.auditLog.count({ where: { action: "auth.login_rate_limited", outcome: "blocked" } })).resolves.toBeGreaterThan(0);
  });
});
