# LOCAL_LLM_HANDOFF.md

## Purpose
This project was previously worked on by Codex. Local LLM agents must review the existing project state before making changes.

## Required Review Order
1. Read AGENTS.md, AGENTS_QWEN.md
2. Read README.md if available.
3. Inspect package.json, tsconfig files, and workspace configuration.
4. Inspect recent git changes with:
   - git status
   - git diff --stat
   - git diff
   - git log --oneline -10
5. Identify Codex-created or recently modified files.
6. Summarize the current project state before editing.

## Operating Rules
- Do not rewrite Codex work unless there is a clear bug or conflict.
- Preserve existing architecture and naming.
- Do not introduce new libraries without approval.
- Do not perform broad refactoring.
- Do not modify hardware, backend, frontend, or mobile layers outside the requested scope.
- Before coding, explain:
  1. files reviewed
  2. likely change targets
  3. implementation plan
  4. verification command

## Completion Criteria
- Minimal files changed.
- TypeScript passes for the affected package.
- Existing behavior is preserved unless the task explicitly changes it.
- Final answer includes changed files, reason, and test result.