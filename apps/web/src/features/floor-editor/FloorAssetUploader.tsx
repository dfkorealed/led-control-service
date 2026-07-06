import { FileImage, FileText, X } from "lucide-react";
import { useState } from "react";
import { useFloorEditorStore } from "./editor-store";
import type { FloorPlanDraft } from "./editor-types";

export function FloorAssetUploader() {
  const { state, updateFloorPlan } = useFloorEditorStore();
  const [status, setStatus] = useState<string>("");

  async function handleFile(file: File) {
    setStatus("도면을 읽는 중");
    try {
      const floorPlan = file.type === "application/pdf" ? await renderPdfFirstPage(file) : await readImageFile(file);
      updateFloorPlan(floorPlan);
      setStatus(file.type === "application/pdf" ? "PDF 첫 페이지가 배경으로 등록되었습니다." : "이미지 배경이 등록되었습니다.");
    } catch {
      setStatus("도면 파일을 읽지 못했습니다.");
    }
  }

  return (
    <div className="floor-asset-uploader">
      <div>
        <span className="eyebrow">도면 배경</span>
        <strong>{state?.floor.floorPlan?.sourceType === "none" || !state?.floor.floorPlan ? "배경 없음" : "배경 등록됨"}</strong>
      </div>
      <div className="floor-asset-actions">
        <label className="secondary-button">
          <FileImage size={16} />
          이미지
          <input
            type="file"
            accept="image/jpeg,image/png"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void handleFile(file);
              event.currentTarget.value = "";
            }}
          />
        </label>
        <label className="secondary-button">
          <FileText size={16} />
          PDF
          <input
            type="file"
            accept="application/pdf"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void handleFile(file);
              event.currentTarget.value = "";
            }}
          />
        </label>
        <button
          className="secondary-button"
          onClick={() => {
            updateFloorPlan({
              imageUrl: "",
              sourceType: "none",
              originalFileUrl: null,
              renderedImageUrl: null,
              width: state?.floor.floorPlan?.width ?? 1200,
              height: state?.floor.floorPlan?.height ?? 800,
              version: state?.floor.floorPlan?.version ?? 1
            });
            setStatus("배경 없음으로 설정했습니다.");
          }}
        >
          <X size={16} />
          배경 없음
        </button>
      </div>
      {status ? <p className="muted-text">{status}</p> : null}
    </div>
  );
}

async function readImageFile(file: File): Promise<FloorPlanDraft> {
  const dataUrl = await readFileAsDataUrl(file);
  const size = await getImageSize(dataUrl);
  return {
    imageUrl: dataUrl,
    sourceType: "image",
    originalFileUrl: dataUrl,
    renderedImageUrl: dataUrl,
    width: size.width,
    height: size.height,
    version: 1
  };
}

async function renderPdfFirstPage(file: File): Promise<FloorPlanDraft> {
  const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");
  pdfjsLib.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/legacy/build/pdf.worker.mjs", import.meta.url).toString();
  const buffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: buffer }).promise;
  const page = await pdf.getPage(1);
  const viewport = page.getViewport({ scale: 2 });
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  if (!context) throw new Error("canvas context unavailable");

  canvas.width = Math.round(viewport.width);
  canvas.height = Math.round(viewport.height);
  await page.render({ canvas, canvasContext: context, viewport }).promise;
  const renderedImageUrl = canvas.toDataURL("image/png");

  return {
    imageUrl: renderedImageUrl,
    sourceType: "pdf",
    originalFileUrl: await readFileAsDataUrl(file),
    renderedImageUrl,
    width: canvas.width,
    height: canvas.height,
    version: 1
  };
}

function readFileAsDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function getImageSize(src: string) {
  return new Promise<{ width: number; height: number }>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve({ width: image.naturalWidth || 1200, height: image.naturalHeight || 800 });
    image.onerror = reject;
    image.src = src;
  });
}
