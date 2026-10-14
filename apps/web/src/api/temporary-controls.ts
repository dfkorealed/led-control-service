import {
  temporaryControlCreateSchema, temporaryControlEndSchema, temporaryControlViewSchema,
  temporaryControlListQuerySchema, temporaryControlListResponseSchema,
  type CreateTemporaryControlInput, type EndTemporaryControlInput, type TemporaryControlListQuery,
  type TemporaryControlListResponse, type TemporaryControlView, type TemporaryControlState
} from "@led-control/shared/temporary-control-contracts";
import { ApiError, apiGet, apiPost } from "./client";

const collection = (site: string) => `/sites/${encodeURIComponent(site)}/temporary-controls`;
const detail = (site: string, id: string) => `${collection(site)}/${encodeURIComponent(id)}`;
function view(raw: unknown, site: string, id?: string) {
  const parsed = temporaryControlViewSchema.safeParse(raw);
  if (!parsed.success || parsed.data.siteId !== site || (id && parsed.data.id !== id)) {
    throw new ApiError("Invalid temporary control evidence", 502, { code: "temporary_control_response_unverified" });
  }
  return parsed.data;
}
export async function startTemporaryControl(site: string, input: CreateTemporaryControlInput): Promise<TemporaryControlView> {
  return view(await apiPost<unknown>(collection(site), temporaryControlCreateSchema.parse(input), { timeoutMs: 8000 }), site);
}
export async function endTemporaryControl(site: string, id: string, input: EndTemporaryControlInput): Promise<TemporaryControlView> {
  return view(await apiPost<unknown>(`${detail(site, id)}/end`, temporaryControlEndSchema.parse(input), { timeoutMs: 8000 }), site, id);
}
export async function getTemporaryControl(site: string, id: string, signal?: AbortSignal): Promise<TemporaryControlView> {
  return view(await apiGet<unknown>(detail(site, id), { signal, timeoutMs: 8000 }), site, id);
}
export async function listTemporaryControls(site: string, query: TemporaryControlListQuery, signal?: AbortSignal): Promise<TemporaryControlListResponse> {
  const parsed = temporaryControlListQuerySchema.parse(query);
  const params = new URLSearchParams({ limit: String(parsed.limit) });
  if (parsed.state) params.set("state", parsed.state);
  if (parsed.cursor) params.set("cursor", parsed.cursor);
  const data = temporaryControlListResponseSchema.safeParse(await apiGet<unknown>(`${collection(site)}?${params}`, { signal, timeoutMs: 8000 }));
  if (!data.success || data.data.items.some(item => item.siteId !== site)) throw new ApiError("Invalid temporary history", 502, { code: "temporary_control_response_unverified" });
  return data.data;
}
export function temporaryControlIsTerminal(session: TemporaryControlView) {
  return ["restored", "rejected", "cancelled"].includes(session.state);
}
export const temporaryControlStateLabels: Record<TemporaryControlState, string> = {
  pending: "접수 대기", applying: "조명 적용 확인 중", holding: "지정 밝기 유지 중", partial: "일부 적용 · 조명별 확인 필요",
  unknown: "적용 여부 확인 필요", releasing: "자동 운전 복귀 확인 중", restored: "자동 운전 복귀 확인",
  recovery_pending: "복귀 미확인 · 안전 잠금", rejected: "접수 거절", cancelled: "적용 전 종료"
};
export function temporaryControlErrorMessage(error: unknown) {
  if (!(error instanceof ApiError)) return "응답을 확인하지 못했습니다. 같은 요청의 접수 상태를 확인해 주세요.";
  if (error.status === 401) return "로그인 세션이 만료되었습니다. 복구 식별자는 유지합니다.";
  if (error.status === 403) return "시간제 제어 권한이 없습니다.";
  if (error.status === 404) return "현장 또는 시간제 원본을 조회할 수 없습니다.";
  if (error.status === 409) return "BIO 자격·Gateway 적용 버전 또는 기존 제어와 충돌했습니다. 새 제어를 적용하지 않았습니다.";
  if (error.status === 400) return "밝기·대상·유지시간을 확인해 주세요.";
  return "시간제 상태를 확인하지 못했습니다. 복구 식별자를 유지하고 다시 조회해 주세요.";
}
