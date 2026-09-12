import { onlineManager } from "@tanstack/react-query";
import React from "react";
import ReactDOM from "react-dom/client";
import { AppRoot } from "./AppRoot";

// React Query는 online/offline 이벤트 전에는 online을 기본값으로 사용하므로 부팅 상태도 전달한다.
onlineManager.setOnline(navigator.onLine);

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <AppRoot />
  </React.StrictMode>
);
