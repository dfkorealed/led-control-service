import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { saveEditorStateSchema } from "@led-control/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FloorAssetUploadPanel } from "./FloorAssetUploadPanel";
import { buildEditorChanges } from "./editor-diff";
import type { FloorAsset, FloorEditorState } from "./editor-types";

const floorEditorApi = vi.hoisted(() => ({
  uploadFloorAsset: vi.fn()
}));

vi.mock("../../api/floor-editor", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../api/floor-editor")>(),
  uploadFloorAsset: floorEditorApi.uploadFloorAsset
}));

const readyAsset: FloorAsset = {
  id: "asset-1",
  kind: "original",
  status: "ready",
  mimeType: "image/png",
  sizeBytes: 3,
  sha256: "a".repeat(64),
  accessPath: "/api/floors/floor-1/assets/asset-1/content"
};

function renderPanel() {
  const onUploadingChange = vi.fn();
  const onUploaded = vi.fn();
  const onRemoved = vi.fn();
  render(
    <FloorAssetUploadPanel
      floorId="floor-1"
      floorPlan={null}
      onUploadingChange={onUploadingChange}
      onUploaded={onUploaded}
      onRemoved={onRemoved}
    />
  );
  return { onUploadingChange, onUploaded, onRemoved };
}

function selectFile(file: File) {
  fireEvent.change(screen.getByLabelText("도면 파일"), { target: { files: [file] } });
}

describe("FloorAssetUploadPanel", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it.each([
    ["parking.png", "image/png"],
    ["parking.jpg", "image/jpeg"],
    ["parking.jpeg", "image/jpeg"],
    ["parking.pdf", "application/pdf"]
  ])("accepts %s with its matching MIME type", async (name, mimeType) => {
    floorEditorApi.uploadFloorAsset.mockResolvedValueOnce({ ...readyAsset, mimeType });
    const { onUploaded } = renderPanel();
    selectFile(new File(["map"], name, { type: mimeType }));

    fireEvent.click(screen.getByRole("button", { name: "도면 업로드" }));

    await waitFor(() => expect(onUploaded).toHaveBeenCalledOnce());
  });

  it.each([
    [new File(["map"], "parking.svg", { type: "image/svg+xml" }), "PNG, JPG, PDF"],
    [new File(["map"], "parking.png", { type: "application/pdf" }), "파일 형식과 확장자"],
    [new File([], "parking.png", { type: "image/png" }), "빈 파일"],
    [new File([new Uint8Array(50 * 1024 * 1024 + 1)], "parking.png", { type: "image/png" }), "50 MB"]
  ])("rejects an invalid file without starting an upload", (file, message) => {
    renderPanel();
    selectFile(file);

    expect(screen.getByRole("alert")).toHaveTextContent(message);
    expect(screen.getByRole("button", { name: "도면 업로드" })).toBeDisabled();
    expect(floorEditorApi.uploadFloorAsset).not.toHaveBeenCalled();
  });

  it("locks duplicate uploads until the active upload settles", async () => {
    const upload = deferred<FloorAsset>();
    floorEditorApi.uploadFloorAsset.mockReturnValueOnce(upload.promise);
    const { onUploadingChange } = renderPanel();
    selectFile(new File(["map"], "parking.png", { type: "image/png" }));

    const uploadButton = screen.getByRole("button", { name: "도면 업로드" });
    fireEvent.click(uploadButton);
    fireEvent.click(uploadButton);

    expect(floorEditorApi.uploadFloorAsset).toHaveBeenCalledOnce();
    expect(screen.getByLabelText("도면 파일")).toBeDisabled();
    expect(onUploadingChange).toHaveBeenCalledWith(true);
    upload.resolve(readyAsset);
    await waitFor(() => expect(onUploadingChange).toHaveBeenLastCalledWith(false));
  });

  it("preserves the selected file after failure so the same upload can be retried", async () => {
    floorEditorApi.uploadFloorAsset
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce(readyAsset);
    const { onUploaded } = renderPanel();
    selectFile(new File(["map"], "parking.png", { type: "image/png" }));

    fireEvent.click(screen.getByRole("button", { name: "도면 업로드" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("업로드하지 못했습니다");
    expect(screen.getByText("parking.png")).toBeInTheDocument();
    expect(onUploaded).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "도면 업로드 다시 시도" }));
    await waitFor(() => expect(onUploaded).toHaveBeenCalledWith(readyAsset, expect.anything()));
    expect(floorEditorApi.uploadFloorAsset).toHaveBeenCalledTimes(2);
  });

  it("keeps a ready PDF original in the editable floor plan without inventing a rendered image", async () => {
    const pdfAsset = { ...readyAsset, mimeType: "application/pdf" as const };
    floorEditorApi.uploadFloorAsset.mockResolvedValueOnce(pdfAsset);
    const { onUploaded } = renderPanel();
    selectFile(new File(["pdf"], "parking.pdf", { type: "application/pdf" }));

    fireEvent.click(screen.getByRole("button", { name: "도면 업로드" }));

    await waitFor(() => expect(onUploaded).toHaveBeenCalledWith(pdfAsset, {
      sourceType: "pdf",
      imageUrl: "",
      originalFileUrl: pdfAsset.accessPath,
      renderedImageUrl: null,
      width: 1200,
      height: 800,
      gridSize: 10,
      version: 1
    }));

    const initial: FloorEditorState = {
      floor: { id: "floor-1", siteId: "site-1", name: "B1", level: -1, mapRevision: 7, floorPlan: null },
      fixtures: [],
      objects: []
    };
    const uploadedDraft = onUploaded.mock.calls[0][1];
    const changes = buildEditorChanges(initial, {
      ...initial,
      floor: { ...initial.floor, floorPlan: uploadedDraft }
    });

    expect(changes.floorPlan).toEqual({
      sourceType: "pdf",
      imageUrl: "",
      originalFileUrl: pdfAsset.accessPath,
      renderedImageUrl: null,
      width: 1200,
      height: 800,
      gridSize: 10
    });
    expect(() => saveEditorStateSchema.parse({ ...changes, leaseToken: "lease-token", leaseFence: 1 })).not.toThrow();
  });

  it("turns the current floor plan into a map-only draft when the link is removed", () => {
    const onRemoved = vi.fn();
    render(
      <FloorAssetUploadPanel
        floorId="floor-1"
        floorPlan={{
          sourceType: "image",
          imageUrl: readyAsset.accessPath,
          originalFileUrl: readyAsset.accessPath,
          renderedImageUrl: readyAsset.accessPath,
          width: 1200,
          height: 800,
          gridSize: 10,
          version: 2
        }}
        onUploadingChange={vi.fn()}
        onUploaded={vi.fn()}
        onRemoved={onRemoved}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "현재 도면 연결 제거" }));

    expect(onRemoved).toHaveBeenCalledWith({
      sourceType: "none",
      imageUrl: "",
      originalFileUrl: null,
      renderedImageUrl: null,
      width: 1200,
      height: 800,
      gridSize: 10,
      version: 3
    });
  });
});

describe("uploadFloorAsset", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("hashes bytes with Web Crypto before intent, signed PUT, and completion", async () => {
    const digest = vi.fn().mockResolvedValue(new Uint8Array(32).fill(0xab).buffer);
    vi.stubGlobal("crypto", { ...globalThis.crypto, subtle: { digest } });
    const responses = [
      jsonResponse({
        assetId: "asset-1",
        uploadUrl: "https://storage.example/upload",
        accessPath: "/api/floors/floor-1/assets/asset-1/content",
        expiresInSeconds: 300
      }),
      new Response(null, { status: 200 }),
      jsonResponse(readyAsset)
    ];
    const fetchMock = vi.fn().mockImplementation(async () => responses.shift());
    vi.stubGlobal("fetch", fetchMock);
    const file = Object.assign(new File(["map"], "parking.png", { type: "image/png" }), {
      arrayBuffer: vi.fn().mockResolvedValue(new TextEncoder().encode("map").buffer)
    });
    const { uploadFloorAsset } = await vi.importActual<typeof import("../../api/floor-editor")>("../../api/floor-editor");

    await expect(uploadFloorAsset("floor-1", file)).resolves.toEqual(readyAsset);

    expect(digest).toHaveBeenCalledOnce();
    expect(digest.mock.calls[0][0]).toBe("SHA-256");
    expect(digest.mock.calls[0][1]).toHaveProperty("byteLength", 3);
    expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/floors/floor-1/assets/upload-intent", expect.objectContaining({
      method: "POST",
      credentials: "include",
      body: JSON.stringify({
        kind: "original",
        mimeType: "image/png",
        sizeBytes: 3,
        sha256: "ab".repeat(32)
      })
    }));
    expect(fetchMock).toHaveBeenNthCalledWith(2, "https://storage.example/upload", {
      method: "PUT",
      headers: {
        "Content-Type": "image/png",
        "x-amz-checksum-sha256": "q6urq6urq6urq6urq6urq6urq6urq6urq6urq6urq6s="
      },
      body: file
    });
    expect(fetchMock).toHaveBeenNthCalledWith(3, "/api/floors/floor-1/assets/asset-1/complete", expect.objectContaining({
      method: "POST",
      credentials: "include",
      body: "{}"
    }));
  });
});

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}
