import { expect } from "vitest";
import * as matchers from "@testing-library/jest-dom/matchers";
import type { TestingLibraryMatchers } from "@testing-library/jest-dom/matchers";

// Augment the same Vitest module as this runner; the package's side-effect
// declaration can otherwise attach DOM matcher types to a hoisted older peer.
declare module "vitest" {
  interface Assertion<T = any> extends TestingLibraryMatchers<any, T> {}
  interface AsymmetricMatchersContaining extends TestingLibraryMatchers<any, any> {}
}

// jest-dom's Vitest entry can resolve another workspace's hoisted Vitest peer.
// Extend this web runner's own expect so secure tool upgrades keep DOM assertions.
expect.extend(matchers);

const canvasContextMock = new Proxy(
  {},
  {
    get: (_, property) => {
      if (property === "canvas") return document.createElement("canvas");
      if (property === "measureText") return () => ({ width: 0 });
      if (property === "getImageData") return () => ({ data: [] });
      if (property === "createLinearGradient" || property === "createRadialGradient") {
        return () => ({ addColorStop: () => undefined });
      }
      return () => undefined;
    }
  }
);

Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
  value: () => canvasContextMock,
  writable: true
});
