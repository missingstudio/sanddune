---
"@missingstudio/sanddune": patch
---

Folded `@missingstudio/sanddune-core` into `@missingstudio/sanddune`. The `core` package is no longer published — its public types and helpers are now re-exported from the main `@missingstudio/sanddune` entry point, so `import { ... } from "@missingstudio/sanddune"` continues to work for every public symbol that previously lived in `core` (e.g. `BranchStrategy`, `RunOptions`, `AgentProvider`, `BindMountSandboxProvider`, `AgentInvoker`, `createBindMountSandboxProvider`, `createAgentProvider`, `resolvePrompt`, `substitutePromptArgs`, `expandPrompt`, `NotImplementedError`).

Migration: replace `from "@missingstudio/sanddune-core"` with `from "@missingstudio/sanddune"`. The two-package split was a hypothetical seam — the sole consumer of `core` was always `sanddune`, so collapsing removes a publish step and a re-export layer without changing the runtime API.
