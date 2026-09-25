import { configureApiBodyParser } from "./api-body-parser";

describe("landing inquiry HTTP body budget", () => {
  it("selects a 4KB JSON parser only for the public inquiry route", () => {
    const parsers: Array<{ limit: unknown; type: (request: any) => boolean }> = [];
    const app = {
      useBodyParser: jest.fn((_kind: string, options: any) => parsers.push(options)),
      use: jest.fn()
    };
    configureApiBodyParser(app as any);
    const inquiry = { url: "/landing/inquiries", headers: { "content-type": "application/json" } };
    const other = { url: "/sites", headers: { "content-type": "application/json" } };
    expect(parsers.some((parser) => parser.limit === "4kb" && parser.type(inquiry))).toBe(true);
    expect(parsers.filter((parser) => parser.type(inquiry))).toHaveLength(1);
    expect(parsers.some((parser) => parser.limit === "100kb" && parser.type(other))).toBe(true);
  });
});
