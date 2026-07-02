import { describe, expect, it } from "vitest";
import { mockPost } from "./mock";

describe("mock auth api", () => {
  it("rejects login when demo credentials do not match", async () => {
    await expect(
      mockPost("/auth/login", {
        email: "anyone@example.com",
        password: "anything"
      })
    ).rejects.toThrow("Invalid mock credentials");
  });

  it("accepts login only with the demo credentials", async () => {
    await expect(
      mockPost("/auth/login", {
        email: "operator@example.com",
        password: "demo-password-1234"
      })
    ).resolves.toMatchObject({
      user: { email: "operator@example.com" }
    });
  });
});
