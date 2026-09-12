import { HttpException, ServiceUnavailableException } from "@nestjs/common";
import { AuditService } from "../audit/audit.service";
import { LoginRateLimitService } from "./login-rate-limit.service";

describe("LoginRateLimitService", () => {
  const input = {
    ipAddress: "203.0.113.10", loginId: "admin_01", organizationId: "org-1", userId: "user-1", userAgent: "browser"
  };

  function fixture(evalResult: unknown = [0, 0]) {
    const client = { eval: jest.fn().mockResolvedValue(evalResult), del: jest.fn().mockResolvedValue(1) };
    const audit = { record: jest.fn().mockResolvedValue({ id: "audit-1" }) };
    const service = new LoginRateLimitService({ getClient: () => client } as any, audit as unknown as AuditService);
    return { client, audit, service };
  }

  it("atomically consumes hashed IP, account and tenant-IP buckets without putting identifiers in keys", async () => {
    const { client, service } = fixture();

    await service.consume(input);

    expect(client.eval).toHaveBeenCalledTimes(1);
    const args = client.eval.mock.calls[0];
    expect(args[1]).toBe(3);
    const keys = args.slice(2, 5) as string[];
    expect(keys).toEqual([
      expect.stringMatching(/^auth:rate:ip:[a-f0-9]{64}$/),
      expect.stringMatching(/^auth:rate:account:[a-f0-9]{64}$/),
      expect.stringMatching(/^auth:rate:tenant-ip:[a-f0-9]{64}$/)
    ]);
    expect(keys.join(" ")).not.toContain(input.ipAddress);
    expect(keys.join(" ")).not.toContain(input.loginId);
    expect(keys.join(" ")).not.toContain(input.organizationId);
  });

  it("omits the tenant-IP bucket when the account is unknown", async () => {
    const { client, service } = fixture();
    await service.consume({ ...input, organizationId: undefined, userId: undefined });
    expect(client.eval.mock.calls[0][1]).toBe(2);
  });

  it("returns a uniform 429 and audits the blocked dimension", async () => {
    const { audit, service } = fixture([2, 418]);
    const error = await service.consume(input).catch((reason: unknown) => reason) as HttpException;

    expect(error.getStatus()).toBe(429);
    expect(error.getResponse()).toEqual({ code: "LOGIN_RATE_LIMITED", message: "Too many login attempts", retryAfterSeconds: 418 });
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({
      action: "auth.login_rate_limited", outcome: "blocked", organizationId: input.organizationId,
      targetId: input.userId, metadata: { dimension: "account", retryAfterSeconds: 418 }
    }));
  });

  it("fails closed and audits when Redis is unavailable", async () => {
    const { audit, client, service } = fixture();
    client.eval.mockRejectedValueOnce(new Error("redis down"));

    await expect(service.consume(input)).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({
      action: "auth.login_rate_limit_unavailable", outcome: "failure"
    }));
  });

  it("clears account and tenant-IP buckets only after complete authentication", async () => {
    const { client, service } = fixture();
    await service.resetAfterSuccess(input);
    expect(client.del).toHaveBeenCalledWith(
      expect.stringMatching(/^auth:rate:account:/), expect.stringMatching(/^auth:rate:tenant-ip:/)
    );
  });
});
