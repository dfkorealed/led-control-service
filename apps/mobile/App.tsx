import { WebShell } from "./src/WebShell";

export default function App() {
  return <WebShell webUrl={process.env.EXPO_PUBLIC_WEB_URL ?? "http://localhost:5173"} />;
}
