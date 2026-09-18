import type { CadScenePrimitive } from "@led-control/shared";

const strokeStyle = {
  strokeColor: "#123456",
  fillColor: null,
  strokeWidth: 1.5,
  opacity: 0.75
} as const;

export const cadSceneCodecGolden = {
  primitives: [
    {
      elementId: "line-golden", groupId: null, layerName: "WALLS", sourceType: "GOLDEN",
      bounds: { minX: 1, minY: 2, maxX: 11, maxY: 12 }, clipBounds: null, style: strokeStyle,
      type: "line", geometry: { start: { x: 1, y: 2 }, end: { x: 11, y: 12 } }
    },
    {
      elementId: "polyline-golden", groupId: "golden-group", layerName: "WALLS", sourceType: "GOLDEN",
      bounds: { minX: 20, minY: 20, maxX: 40, maxY: 35 }, clipBounds: null,
      style: { strokeColor: "#123456", fillColor: "#abcdef", strokeWidth: 2, opacity: 0.5 },
      type: "polyline",
      geometry: { points: [{ x: 20, y: 20 }, { x: 40, y: 20 }, { x: 30, y: 35 }], closed: true }
    },
    {
      elementId: "rectangle-golden", groupId: "golden-group", layerName: "DOORS", sourceType: "GOLDEN",
      bounds: { minX: 50, minY: 50, maxX: 80, maxY: 75 }, clipBounds: null, style: strokeStyle,
      type: "rectangle", geometry: { origin: { x: 50, y: 50 }, width: 30, height: 20, rotation: 15 }
    },
    {
      elementId: "triangle-golden", groupId: "golden-group", layerName: "DOORS", sourceType: "GOLDEN",
      bounds: { minX: 90, minY: 50, maxX: 120, maxY: 80 }, clipBounds: null, style: strokeStyle,
      type: "triangle",
      geometry: { points: [{ x: 90, y: 80 }, { x: 105, y: 50 }, { x: 120, y: 80 }] }
    },
    {
      elementId: "ellipse-golden", groupId: "golden-group", layerName: "ELECTRICAL", sourceType: "GOLDEN",
      bounds: { minX: 130, minY: 50, maxX: 170, maxY: 80 }, clipBounds: null, style: strokeStyle,
      type: "ellipse",
      geometry: { center: { x: 150, y: 65 }, radiusX: 20, radiusY: 15, rotation: 22.5 }
    },
    {
      elementId: "arc-golden", groupId: "golden-group", layerName: "ELECTRICAL", sourceType: "GOLDEN",
      bounds: { minX: 180, minY: 50, maxX: 220, maxY: 90 }, clipBounds: null, style: strokeStyle,
      type: "arc",
      geometry: {
        center: { x: 200, y: 70 }, radius: 20, startAngle: 350, endAngle: 45, counterClockwise: true
      }
    },
    {
      elementId: "text-golden", groupId: "golden-group", layerName: "LABELS", sourceType: "GOLDEN",
      bounds: { minX: 460, minY: 470, maxX: 512, maxY: 500 },
      clipBounds: { minX: 0, minY: 0, maxX: 512, maxY: 512 }, style: strokeStyle,
      type: "text",
      geometry: {
        position: { x: 460, y: 500 }, text: "B1 주차장 안내🙂", width: 100, height: 30,
        rotation: 12.5, fontSize: 18
      }
    }
  ] satisfies CadScenePrimitive[],
  payloadBase64: "Q0RUTAEAAABJBAAABwAAAL5+RiIJfoyEloju0vamqhoep3KnFJ0uryqqlprNG5S2EAAAAAsAAABsaW5lLWdvbGRlbgUAAABXQUxMUwYAAABHT0xERU4HAAAAIzEyMzQ1Ng8AAABwb2x5bGluZS1nb2xkZW4MAAAAZ29sZGVuLWdyb3VwBwAAACNhYmNkZWYQAAAAcmVjdGFuZ2xlLWdvbGRlbgUAAABET09SUw8AAAB0cmlhbmdsZS1nb2xkZW4OAAAAZWxsaXBzZS1nb2xkZW4KAAAARUxFQ1RSSUNBTAoAAABhcmMtZ29sZGVuCwAAAHRleHQtZ29sZGVuBgAAAExBQkVMUxcAAABCMSDso7zssKjsnqUg7JWI64K08J+ZggEAAAAA/////wEAAAACAAAAAAAAAAAA8D8AAAAAAAAAQAAAAAAAACZAAAAAAAAAKEAAAwAAAP////8AAAAAAAD4PwAAAAAAAOg/AAAAAAAA8D8AAAAAAAAAQAAAAAAAACZAAAAAAAAAKEACBAAAAAUAAAABAAAAAgAAAAAAAAAAADRAAAAAAAAANEAAAAAAAABEQAAAAAAAgEFAAAMAAAAGAAAAAAAAAAAAAEAAAAAAAADgPwMAAAABAAAAAAAANEAAAAAAAAA0QAAAAAAAAERAAAAAAAAANEAAAAAAAAA+QAAAAAAAgEFAAwcAAAAFAAAACAAAAAIAAAAAAAAAAABJQAAAAAAAAElAAAAAAAAAVEAAAAAAAMBSQAADAAAA/////wAAAAAAAPg/AAAAAAAA6D8AAAAAAABJQAAAAAAAAElAAAAAAAAAPkAAAAAAAAA0QAAAAAAAAC5ABAkAAAAFAAAACAAAAAIAAAAAAAAAAIBWQAAAAAAAAElAAAAAAAAAXkAAAAAAAABUQAADAAAA/////wAAAAAAAPg/AAAAAAAA6D8AAAAAAIBWQAAAAAAAAFRAAAAAAABAWkAAAAAAAABJQAAAAAAAAF5AAAAAAAAAVEAFCgAAAAUAAAALAAAAAgAAAAAAAAAAQGBAAAAAAAAASUAAAAAAAEBlQAAAAAAAAFRAAAMAAAD/////AAAAAAAA+D8AAAAAAADoPwAAAAAAwGJAAAAAAABAUEAAAAAAAAA0QAAAAAAAAC5AAAAAAACANkAGDAAAAAUAAAALAAAAAgAAAAAAAAAAgGZAAAAAAAAASUAAAAAAAIBrQAAAAAAAgFZAAAMAAAD/////AAAAAAAA+D8AAAAAAADoPwAAAAAAAGlAAAAAAACAUUAAAAAAAAA0QAAAAAAA4HVAAAAAAACARkABBw0AAAAFAAAADgAAAAIAAAAAAAAAAMB8QAAAAAAAYH1AAAAAAAAAgEAAAAAAAEB/QAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgEAAAAAAAACAQAMAAAD/////AAAAAAAA+D8AAAAAAADoPwAAAAAAwHxAAAAAAABAf0APAAAAAAAAAAAAWUAAAAAAAAA+QAAAAAAAAClAAAAAAAAAMkA=",
  byteSize: 1_145,
  sha256: "353b769fd3870f8eae051de8d608ec75ae84da451245a7c28cac317044440bd8"
} as const;
