import { CircleCheck, FileUp, Link2Off, TriangleAlert } from "lucide-react";
import { useRef, useState } from "react";
import { uploadFloorAsset } from "../../api/floor-editor";
import { Button, FeedbackState } from "../../components/ui";
import type { FloorAsset, FloorPlanDraft } from "./editor-types";

const MAX_ASSET_BYTES = 50 * 1024 * 1024;
const MIME_BY_EXTENSION = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  pdf: "application/pdf"
} as const;

export interface FloorAssetUploadPanelProps {
  floorId: string;
  floorPlan: FloorPlanDraft | null;
  disabled?: boolean;
  onUploadingChange: (uploading: boolean) => void;
  onUploaded: (asset: FloorAsset, floorPlan: FloorPlanDraft | null) => void;
  onRemoved: (floorPlan: FloorPlanDraft) => void;
}

export function FloorAssetUploadPanel({
  floorId,
  floorPlan,
  disabled = false,
  onUploadingChange,
  onUploaded,
  onRemoved
}: FloorAssetUploadPanelProps) {
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [uploadedAsset, setUploadedAsset] = useState<FloorAsset | null>(null);
  const lock = useRef(false);

  async function handleUpload() {
    if (!file || disabled || lock.current) return;
    lock.current = true;
    setUploading(true);
    setError(null);
    onUploadingChange(true);
    try {
      const asset = await uploadFloorAsset(floorId, file);
      if (asset.status !== "ready") throw new Error("Floor asset did not become ready");
      const nextFloorPlan = file.type === "application/pdf"
        ? pdfFloorPlan(asset, floorPlan)
        : imageFloorPlan(asset, floorPlan);
      onUploaded(asset, nextFloorPlan);
      setUploadedAsset(asset);
      setFile(null);
    } catch {
      setError("도면을 업로드하지 못했습니다.");
    } finally {
      lock.current = false;
      setUploading(false);
      onUploadingChange(false);
    }
  }

  return (
    <section aria-label="도면 자산">
      <div>
        <span className="eyebrow">도면</span>
        <h3>실도면 업로드</h3>
      </div>
      <label>
        <span>도면 파일</span>
        <input
          type="file"
          accept=".png,.jpg,.jpeg,.pdf,image/png,image/jpeg,application/pdf"
          disabled={disabled || uploading}
          onChange={(event) => {
            const selected = event.target.files?.[0] ?? null;
            const validationError = selected ? validateAssetFile(selected) : null;
            setFile(validationError ? null : selected);
            setError(validationError);
            setUploadedAsset(null);
          }}
        />
      </label>
      {file ? <p>{file.name}</p> : null}
      {error ? <FeedbackState tone="danger" icon={TriangleAlert} title={error} /> : null}
      {uploadedAsset ? (
        <FeedbackState
          tone="success"
          icon={CircleCheck}
          title={uploadedAsset.mimeType === "application/pdf"
            ? "PDF 원본이 연결되었습니다."
            : "도면 배경이 편집 초안에 적용되었습니다."}
        />
      ) : null}
      <Button
        variant="secondary"
        disabled={!file || disabled}
        isLoading={uploading}
        loadingLabel="업로드 중"
        onClick={() => void handleUpload()}
      >
        <FileUp size={16} aria-hidden="true" />
        {error && file ? "도면 업로드 다시 시도" : "도면 업로드"}
      </Button>
      {floorPlan && floorPlan.sourceType !== "none" ? (
        <Button
          variant="ghost"
          disabled={disabled || uploading}
          onClick={() => onRemoved(mapOnlyFloorPlan(floorPlan))}
        >
          <Link2Off size={16} aria-hidden="true" />
          현재 도면 연결 제거
        </Button>
      ) : null}
    </section>
  );
}

function validateAssetFile(file: File): string | null {
  if (file.size === 0) return "빈 파일은 업로드할 수 없습니다.";
  if (file.size > MAX_ASSET_BYTES) return "파일 크기는 50 MB 이하여야 합니다.";
  const extension = file.name.toLowerCase().match(/\.([^.]+)$/)?.[1];
  if (!extension || !Object.hasOwn(MIME_BY_EXTENSION, extension)) {
    return "PNG, JPG, PDF 파일만 업로드할 수 있습니다.";
  }
  if (MIME_BY_EXTENSION[extension as keyof typeof MIME_BY_EXTENSION] !== file.type) {
    return "파일 형식과 확장자가 일치하지 않습니다.";
  }
  return null;
}

function imageFloorPlan(asset: FloorAsset, current: FloorPlanDraft | null): FloorPlanDraft {
  return {
    sourceType: "image",
    imageUrl: asset.accessPath,
    originalFileUrl: asset.accessPath,
    renderedImageUrl: asset.accessPath,
    width: current?.width ?? 1200,
    height: current?.height ?? 800,
    gridSize: current?.gridSize ?? 10,
    version: (current?.version ?? 0) + 1
  };
}

function pdfFloorPlan(asset: FloorAsset, current: FloorPlanDraft | null): FloorPlanDraft {
  const renderedImageUrl = current?.renderedImageUrl || (current?.sourceType === "image" ? current.imageUrl : null);
  return {
    sourceType: "pdf",
    imageUrl: renderedImageUrl ?? "",
    originalFileUrl: asset.accessPath,
    renderedImageUrl,
    width: current?.width ?? 1200,
    height: current?.height ?? 800,
    gridSize: current?.gridSize ?? 10,
    version: (current?.version ?? 0) + 1
  };
}

function mapOnlyFloorPlan(current: FloorPlanDraft): FloorPlanDraft {
  return {
    sourceType: "none",
    imageUrl: "",
    originalFileUrl: null,
    renderedImageUrl: null,
    width: current.width,
    height: current.height,
    gridSize: current.gridSize ?? 10,
    version: current.version + 1
  };
}
