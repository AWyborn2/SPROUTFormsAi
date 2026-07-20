---
name: Replit port and pnpm setup quirks
description: Why the API runs on 8000 (not repo default 8787) and how pnpm install works here
---
- Replit workflows only allow ports 3000-3003, 4200, 5000 (webview), 5173, 6000, 6800, 8000, 8008, 8080, 8099, 9000. The repo's default API port 8787 is not allowed, so the API runs with `API_PORT=8000` (workflow + deploy run command + vite proxy target all assume 8000).
  **Why:** configureWorkflow rejects 8787. **How to apply:** keep API on 8000; if changing, update vite.config.ts proxy (server + preview), both workflow commands, and the deployment run command together.
- `pnpm install` initially failed because the `packageManager` pin (10.33.0) triggered pnpm self-install, which fails in this sandbox. Fixed by pinning to the nix-provided pnpm version and adding `pnpm.onlyBuiltDependencies: ["esbuild"]` + `pnpm rebuild esbuild` (build scripts are blocked by default and vite needs the esbuild binary).
