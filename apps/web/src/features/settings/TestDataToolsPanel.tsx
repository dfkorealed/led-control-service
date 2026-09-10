import { useMutation, useQueryClient } from "@tanstack/react-query";
import { CircleCheck, TriangleAlert } from "lucide-react";
import { useRef, useState } from "react";
import { ApiError } from "../../api/client";
import { createSiteTestData, deleteSiteTestData } from "../../api/test-data";
import type { Dashboard } from "../../api/queries";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { Button, Card, FeedbackState } from "../../components/ui";

type UserRole = "operator" | "admin" | "viewer";

export function TestDataToolsPanel({ userRole, dashboard }: { userRole: UserRole; dashboard: Dashboard }) {
  const canManage = import.meta.env.VITE_TEST_DATA_TOOLS_ENABLED === "true"
    && userRole === "admin"
    && dashboard.site.installationStatus === "installed";

  if (!canManage) return null;

  return <TestDataToolsControls dashboard={dashboard} />;
}

function TestDataToolsControls({ dashboard }: { dashboard: Dashboard }) {
  const queryClient = useQueryClient();
  const requestInFlight = useRef(false);
  const [deleteConfirmationOpen, setDeleteConfirmationOpen] = useState(false);
  const [message, setMessage] = useState("");
  const [createErrorMessage, setCreateErrorMessage] = useState("");
  const [deleteErrorMessage, setDeleteErrorMessage] = useState("");

  const createMutation = useMutation({
    mutationFn: () => createSiteTestData(dashboard.site.id),
    onSuccess: async (result) => {
      await invalidateAffectedQueries(queryClient, dashboard);
      requestInFlight.current = false;
      setMessage(`테스트 데이터 ${result.fixtures.created}개를 생성했습니다.`);
    },
    onError: () => {
      requestInFlight.current = false;
      setCreateErrorMessage("테스트 데이터를 생성하지 못했습니다. 잠시 후 다시 시도하세요.");
    }
  });
  const deleteMutation = useMutation({
    mutationFn: () => deleteSiteTestData(dashboard.site.id),
    onSuccess: async (result) => {
      await invalidateAffectedQueries(queryClient, dashboard);
      requestInFlight.current = false;
      setDeleteConfirmationOpen(false);
      setMessage(`테스트 데이터 ${result.fixtures.deleted}개를 삭제했습니다.`);
    },
    onError: (error) => {
      requestInFlight.current = false;
      setDeleteErrorMessage(error instanceof ApiError && error.status === 409
        ? "테스트 데이터에 연결된 사용 데이터가 있어 삭제할 수 없습니다. 연결된 구역·명령·통계 데이터를 먼저 확인하세요."
        : "테스트 데이터를 삭제하지 못했습니다. 잠시 후 다시 시도하세요.");
    }
  });
  const isMutating = createMutation.isPending || deleteMutation.isPending;

  function startOperation(operation: () => void) {
    if (requestInFlight.current || isMutating) return;
    requestInFlight.current = true;
    setMessage("");
    setCreateErrorMessage("");
    setDeleteErrorMessage("");
    operation();
  }

  return (
    <Card className="settings-test-data-card" aria-label="테스트 데이터">
      <div className="settings-card-heading">
        <TriangleAlert size={20} aria-hidden="true" />
        <div>
          <span>개발·검증 전용</span>
          <strong>테스트 데이터</strong>
        </div>
      </div>
      <p className="muted-text">현재 설치 현장에 테스트용 조명 데이터를 생성하거나 삭제합니다.</p>
      {message ? <FeedbackState tone="success" icon={CircleCheck} title={message} /> : null}
      {createErrorMessage ? <FeedbackState tone="danger" icon={TriangleAlert} title={createErrorMessage} /> : null}
      <div className="settings-test-data-actions">
        <Button variant="secondary" disabled={isMutating} isLoading={createMutation.isPending} loadingLabel="테스트 데이터 생성 중" onClick={() => startOperation(() => createMutation.mutate())}>
          테스트 데이터 생성
        </Button>
        <Button variant="danger" disabled={isMutating} onClick={() => {
          setDeleteErrorMessage("");
          setDeleteConfirmationOpen(true);
        }}>
          테스트 데이터 삭제
        </Button>
      </div>
      <ConfirmDialog
        open={deleteConfirmationOpen}
        title="테스트 데이터 삭제 확인"
        description="이 현장의 테스트 데이터가 삭제됩니다. 이 작업은 되돌릴 수 없습니다."
        confirmLabel="삭제"
        destructive
        isPending={deleteMutation.isPending}
        onClose={() => {
          if (isMutating) return;
          setDeleteErrorMessage("");
          setDeleteConfirmationOpen(false);
        }}
        onConfirm={() => startOperation(() => deleteMutation.mutate())}
      >
        {deleteErrorMessage ? <FeedbackState tone="danger" icon={TriangleAlert} title={deleteErrorMessage} /> : null}
      </ConfirmDialog>
    </Card>
  );
}

async function invalidateAffectedQueries(queryClient: ReturnType<typeof useQueryClient>, dashboard: Dashboard) {
  await Promise.all([
    // SettingsView uses this key before a site is explicitly selected; the ID-scoped key serves selected-site consumers.
    queryClient.invalidateQueries({ queryKey: ["dashboard", "default"] }),
    queryClient.invalidateQueries({ queryKey: ["dashboard", dashboard.site.id] }),
    ...dashboard.floors.flatMap((floor) => [
      queryClient.invalidateQueries({ queryKey: ["floor-fixtures", dashboard.site.id, floor.id] }),
      queryClient.invalidateQueries({ queryKey: ["floor-map", dashboard.site.id, floor.id] })
    ])
  ]);
}
