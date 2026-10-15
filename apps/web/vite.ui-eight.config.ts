import { defineConfig } from "vite";
import base from "./vite.config";

// Browser fixtures must never fall through to an existing API service.
export default defineConfig({ ...base, server: { ...base.server, proxy: undefined } });
