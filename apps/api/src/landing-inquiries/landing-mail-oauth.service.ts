import { createHash, randomBytes } from "node:crypto";
import { BadRequestException, Injectable, ServiceUnavailableException } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import type { LandingMailConnection } from "./landing-mail-connection";
import { LandingMailTokenCipher } from "./landing-mail-token-cipher";

// Fixed official endpoints prevent configuration from exfiltrating client secrets.
const authorizeEndpoint = "https://auth.worksmobile.com/oauth2/v2.0/authorize";
const tokenEndpoint = "https://auth.worksmobile.com/oauth2/v2.0/token";
const credentialId = "naver-works";
const refreshLifetimeMs = 90 * 24 * 60 * 60 * 1000;
const unavailable = () => new ServiceUnavailableException("메일 연결을 사용할 수 없습니다. 운영자에게 문의해 주세요.");
const stateError = () => new BadRequestException("메일 연결 요청이 만료되었거나 유효하지 않습니다. 다시 시작해 주세요.");
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

function readConfiguration() {
  const clientId = process.env.LANDING_NAVER_WORKS_CLIENT_ID?.trim();
  const clientSecret = process.env.LANDING_NAVER_WORKS_CLIENT_SECRET?.trim();
  const redirectUri = process.env.LANDING_NAVER_WORKS_REDIRECT_URI;
  const sender = process.env.LANDING_NAVER_WORKS_SENDER?.trim();
  const cipher = LandingMailTokenCipher.fromConfiguration(process.env.LANDING_MAIL_TOKEN_KEY);
  if (!clientId || !clientSecret || !redirectUri || !sender || !cipher || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(sender)) return null;
  try {
    const uri = new URL(redirectUri);
    if (uri.protocol !== "https:" || uri.username || uri.password || uri.hash || uri.search ||
      uri.pathname !== "/landing-mail/oauth/callback" || uri.href !== redirectUri) return null;
  } catch { return null; }
  return { clientId, clientSecret, redirectUri, cipher, connectionKey: hash(JSON.stringify([clientId, redirectUri, sender])) };
}
type Configuration = NonNullable<ReturnType<typeof readConfiguration>>;

@Injectable()
export class LandingMailOAuthService implements LandingMailConnection {
  constructor(private readonly prisma: PrismaService) {}

  async getConnectionStatus(): Promise<{ connected: boolean }> {
    const config = readConfiguration();
    if (!config) return { connected: false };
    const record = await this.prisma.landingMailCredential.findUnique({ where: { id: credentialId } });
    if (!record || record.connectionKey !== config.connectionKey || record.refreshTokenExpiresAt <= new Date()) return { connected: false };
    try { config.cipher.decrypt(record); return { connected: true }; }
    catch { return { connected: false }; }
  }

  async beginAuthorization(operatorId: string): Promise<{ authorizationUrl: string }> {
    const config = this.requireConfiguration();
    const state = randomBytes(32).toString("base64url");
    const now = new Date();
    await this.prisma.landingMailOAuthState.deleteMany({ where: { expiresAt: { lte: now } } });
    await this.prisma.landingMailOAuthState.create({ data: {
      stateHash: hash(state), operatorId, connectionKey: config.connectionKey,
      expiresAt: new Date(now.getTime() + 10 * 60 * 1000)
    } });
    const url = new URL(authorizeEndpoint);
    url.search = new URLSearchParams({ client_id: config.clientId, redirect_uri: config.redirectUri,
      scope: "mail", response_type: "code", state }).toString();
    return { authorizationUrl: url.toString() };
  }

  async completeAuthorization(code: string, state: string): Promise<void> {
    if (typeof code !== "string" || !code || code.length > 4096 || typeof state !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(state)) throw stateError();
    const config = this.requireConfiguration();
    // Commit the claim before the external exchange: a timeout must not make this
    // state replayable. Atomic conditional deletion also excludes parallel callbacks.
    const claimed = await this.prisma.$transaction((tx) => tx.landingMailOAuthState.deleteMany({ where: {
      stateHash: hash(state), connectionKey: config.connectionKey, expiresAt: { gt: new Date() }
    } }));
    if (claimed.count !== 1) throw stateError();
    await this.withCredentialLock(async (tx) => {
      const token = await this.exchange(config, { grant_type: "authorization_code", code, redirect_uri: config.redirectUri });
      await this.storeTokens(tx, config, token, undefined);
    });
  }

  async getAccessToken(forceRefresh = false): Promise<string> {
    const config = this.requireConfiguration();
    return this.withCredentialLock(async (tx) => {
      const record = await tx.landingMailCredential.findUnique({ where: { id: credentialId } });
      if (!record || record.connectionKey !== config.connectionKey || record.refreshTokenExpiresAt <= new Date()) throw unavailable();
      let tokens;
      try { tokens = config.cipher.decrypt(record); } catch { throw unavailable(); }
      if (!forceRefresh && record.accessTokenExpiresAt.getTime() > Date.now() + 30_000) return tokens.accessToken;
      const token = await this.exchange(config, { grant_type: "refresh_token", refresh_token: tokens.refreshToken });
      return this.storeTokens(tx, config, token, { refreshToken: tokens.refreshToken, expiresAt: record.refreshTokenExpiresAt });
    });
  }

  private requireConfiguration(): Configuration {
    const config = readConfiguration();
    if (!config) throw unavailable();
    return config;
  }

  private async withCredentialLock<T>(run: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    // A transaction-scoped lock coordinates all API processes, including the first
    // callback before a credential row exists. It prevents refresh/reconnect races.
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(1718360139, 1)`;
      return run(tx);
    }, { timeout: 15_000, maxWait: 5_000 });
  }

  private async exchange(config: Configuration, parameters: Record<string, string>): Promise<Record<string, unknown>> {
    try {
      const response = await fetch(tokenEndpoint, {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(5_000),
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ ...parameters, client_id: config.clientId, client_secret: config.clientSecret })
      });
      if (!response.ok) throw unavailable();
      const body: unknown = await response.json();
      if (!body || typeof body !== "object" || Array.isArray(body)) throw unavailable();
      return body as Record<string, unknown>;
    } catch { throw unavailable(); }
  }

  private async storeTokens(tx: Prisma.TransactionClient, config: Configuration, response: Record<string, unknown>, previous?: { refreshToken: string; expiresAt: Date }): Promise<string> {
    const accessToken = response.access_token;
    const refreshToken = response.refresh_token ?? previous?.refreshToken;
    const seconds = Number(response.expires_in);
    const scope = typeof response.scope === "string" ? response.scope.split(/[ ,]+/) : [];
    if (typeof accessToken !== "string" || !accessToken || typeof refreshToken !== "string" || !refreshToken ||
      !Number.isInteger(seconds) || seconds < 1 || seconds > 86400 || !scope.includes("mail") || response.token_type !== "Bearer") throw unavailable();
    const record = { connectionKey: config.connectionKey, ...config.cipher.encrypt({ accessToken, refreshToken }),
      accessTokenExpiresAt: new Date(Date.now() + seconds * 1000),
      refreshTokenExpiresAt: response.refresh_token ? new Date(Date.now() + refreshLifetimeMs) : previous!.expiresAt };
    await tx.landingMailCredential.upsert({ where: { id: credentialId }, create: { id: credentialId, ...record }, update: record });
    return accessToken;
  }
}
