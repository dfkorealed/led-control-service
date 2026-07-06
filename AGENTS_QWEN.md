## Project Stack
- Language: TypeScript
- Web: React
- Backend: NestJS
- Mobile: React Native WebView
- Hardware: Raspberry Pi + ESP32-H2

## Core Rules
- Make the smallest safe change.
- Inspect only files related to the requested task.
- Do not scan the entire repository unless asked.
- Do not introduce new dependencies without approval.
- Do not perform large refactors during feature work.
- Keep React WebView compatibility for mobile.
- Preserve existing naming, folder structure, and coding style.

## Workflow
1. Read LOCAL_LLM_HANDOFF.md.
2. Check current git state.
3. Analyze relevant files only.
4. Present a short implementation plan before editing.
5. Edit with minimal diff.
6. Run targeted verification only.
7. Summarize changes.

## Useful Commands
- Install: `pnpm install`
- Type check: `pnpm typecheck`
- Lint: `pnpm lint`
- Test: `pnpm test`
- Web dev: `pnpm dev`
- API dev: `pnpm start:dev`

## Boundaries
- Frontend task: do not edit backend unless required.
- Backend task: do not edit frontend unless API contract requires it.
- Mobile task: prefer WebView-compatible web changes.
- Hardware task: do not modify cloud service code unless explicitly required.

## Subagent Policy
- Local LLM must not spawn subagents.
- Use single-agent reasoning only.
- For complex work, split into smaller sequential tasks.