---
"@missingstudio/sanddune": patch
---

Complete the logging engine: terminal mode, `onAgentStreamEvent` callback, and `IterationResult.usage`.

- `logging: { type: "stdout" }` now renders **terminal mode** — spinners while iterations run, styled status lines per iteration, and a final summary. `RunResult.logFilePath` is `undefined` in this mode.
- `logging: { type: "file", path? }` writes a **run log** to `.sanddune/logs/` by default, or to `path` when supplied (relative paths resolve against `cwd`).
- `logging: { type: "file", onAgentStreamEvent }` exposes a sync, fire-and-forget per-event callback alongside the run log. Errors thrown by the callback are swallowed onto stderr so a broken forwarder cannot kill the run. Available in **log-to-file mode** only.
- `IterationResult.usage` is populated from the captured **agent session** JSONL (Claude Code: last assistant message's `usage` field). Raw token counts only — no percentage — per ADR-0005b. `undefined` when capture is off or the agent provider does not implement `parseUsage`.
- `RunOptions.name` adds an optional display prefix (`[name] tail -f …`) to log output for parallel-run readability.
- `RunResult.logFilePath` is now optional — `undefined` in terminal mode.
- `IterationUsage` field renames: `cacheCreationTokens` → `cacheCreationInputTokens`, `cacheReadTokens` → `cacheReadInputTokens` (matches the source field names in Claude session JSONL).
- Internal: `AgentInvokeInput.onEvent` replaces the production invoker's constructor `onEvent`, so test fakes can drive event fan-out the same way the production invoker does.
