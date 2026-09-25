import { LandingMailTransport } from "./landing-mail.transport";
import { LandingMailOAuthService } from "./landing-mail-oauth.service";

describe("landing mail transport", () => {
  const oldFetch = global.fetch;
  const oldSender = process.env.LANDING_NAVER_WORKS_SENDER;
  const fetchMock = jest.fn();
  const token = jest.fn();
  const message = { subject: "subject", html: "<p>safe</p>", text: "safe" };
  let transport: LandingMailTransport;
  beforeEach(() => {
    process.env.LANDING_NAVER_WORKS_SENDER = "fixed@example.com";
    global.fetch = fetchMock; fetchMock.mockReset(); token.mockReset().mockResolvedValue("access-one");
    transport = new LandingMailTransport({ getAccessToken: token } as unknown as LandingMailOAuthService);
  });
  afterAll(() => { global.fetch = oldFetch; if (oldSender === undefined) delete process.env.LANDING_NAVER_WORKS_SENDER; else process.env.LANDING_NAVER_WORKS_SENDER = oldSender; });
  it("accepts only 202 and fixes sender, recipient, endpoint and redirect policy", async () => {
    fetchMock.mockResolvedValue({ status: 202 });
    expect(await transport.send(message)).toBe("provider_accepted");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://www.worksapis.com/v1.0/users/fixed%40example.com/mail");
    expect(init.redirect).toBe("error");
    expect(JSON.parse(init.body)).toMatchObject({ to: "kymkjh2002@dfkorealed.com", subject: "subject", contentType: "html", body: "<p>safe</p>" });
  });
  it("refreshes after a confirmed 401 rejection exactly once", async () => {
    fetchMock.mockResolvedValueOnce({ status: 401 }).mockResolvedValueOnce({ status: 202 });
    token.mockResolvedValueOnce("old").mockResolvedValueOnce("new");
    expect(await transport.send(message)).toBe("provider_accepted");
    expect(token.mock.calls).toEqual([[false], [true]]);
    expect(fetchMock.mock.calls[1][1].headers.Authorization).toBe("Bearer new");
  });
  it.each([[429, "retryable", "MAIL_RATE_LIMITED"], [400, "permanent", "MAIL_REJECTED"],
    [403, "permanent", "MAIL_REJECTED"], [500, "uncertain", "MAIL_ACCEPTANCE_UNKNOWN"],
    [200, "uncertain", "MAIL_ACCEPTANCE_UNKNOWN"], [302, "uncertain", "MAIL_ACCEPTANCE_UNKNOWN"]])("classifies %i safely", async (status, outcome, code) => {
    fetchMock.mockResolvedValue({ status });
    await expect(transport.send(message)).rejects.toMatchObject({ outcome, code });
  });
  it("does not loop after second 401", async () => {
    fetchMock.mockResolvedValue({ status: 401 });
    await expect(transport.send(message)).rejects.toMatchObject({ outcome: "permanent", code: "MAIL_REJECTED" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it.each([new Error("network secret"), new DOMException("timeout secret", "TimeoutError")])("never retries unknown network acceptance", async (error) => {
    fetchMock.mockRejectedValue(error);
    await expect(transport.send(message)).rejects.toMatchObject({ outcome: "uncertain", message: "MAIL_ACCEPTANCE_UNKNOWN" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it("token failure is safe to retry before send", async () => {
    token.mockRejectedValue(new Error("token secret"));
    await expect(transport.send(message)).rejects.toMatchObject({ outcome: "retryable", code: "MAIL_OAUTH_UNAVAILABLE" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("refresh failure following 401 is safe to retry", async () => {
    fetchMock.mockResolvedValue({ status: 401 });
    token.mockResolvedValueOnce("access").mockRejectedValueOnce(new Error("secret"));
    await expect(transport.send(message)).rejects.toMatchObject({ outcome: "retryable", code: "MAIL_OAUTH_UNAVAILABLE" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it("rejects invalid sender configuration before accessing provider", async () => {
    process.env.LANDING_NAVER_WORKS_SENDER = "attacker\r\n@example.com";
    await expect(transport.send(message)).rejects.toMatchObject({ outcome: "permanent", code: "MAIL_CONFIGURATION_INVALID" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
