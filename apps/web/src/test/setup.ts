import "@testing-library/jest-dom/vitest";

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
