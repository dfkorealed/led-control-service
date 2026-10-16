import { Button } from "./Button";
import { panelPaddingClass } from "./FunctionalLayout";
import { Text } from "./Typography";

/** Presentation only: each entry retains ownership of bootstrap and root lifetime. */
export function MobilePreparation({ failed = false }: { failed?: boolean }) {
  return <main className={`flex min-h-dvh flex-col items-center justify-center gap-5 bg-surface-canvas ${panelPaddingClass("regular")} text-body text-content-primary`} role={failed ? "alert" : "status"}>
    <Text>{failed ? "앱 연결을 준비하지 못했습니다. 다시 시도해 주세요." : "앱 연결을 준비하고 있습니다."}</Text>
    {failed && <Button onClick={() => location.reload()}>다시 연결</Button>}
  </main>;
}
