import { describe, expect, it } from "vitest";
import { mockGet, mockPost } from "./mock";

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

describe("mock command api", () => {
  it("returns a command id and a queryable terminal status", async () => {
    const created = await mockPost<{ id: string; dispatchCount: number }>("/commands/dimming", {
      targetType: "fixture",
      targetId: "fixture-1",
      brightness: 70
    });

    expect(created.dispatchCount).toBe(1);
    await expect(mockGet(`/commands/${created.id}`)).resolves.toMatchObject({ id: created.id, stage: "completed" });
  });
});
