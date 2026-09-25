import { renderLandingMail } from "./landing-mail-renderer";

describe("landing mail renderer", () => {
  it("escapes every user field and prevents subject header injection", () => {
    const mail = renderLandingMail({ reference: "K-123", companyName: '<img src=x>\r\nBcc: bad',
      contactName: "O'Reilly & <b>", email: 'a&b@example.com', phone: '<123>', audience: "facility",
      message: '<script>alert("x")</script>\nsecond' });
    expect(mail.subject).not.toMatch(/[\r\n]/);
    expect(mail.html).not.toContain("<script>");
    expect(mail.html).not.toContain("<img");
    expect(mail.html).toContain("O&#39;Reilly &amp; &lt;b&gt;");
    expect(mail.html).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
    expect(mail.html).toContain("a&amp;b@example.com");
    expect(mail.text).toContain('<script>alert("x")</script>\nsecond');
    expect(mail.text).toContain("K-123");
  });
});
