---
"@missingstudio/sanddune": patch
---

Add Claude-Code-specific **agent session** capture and resume.

After each iteration with `claudeCode()` (default `captureSessions: true`), the session JSONL is transferred from the **sandbox** to the **host** at `~/.claude/projects/<encoded-path>/sessions/<session-id>.jsonl`, with `cwd` fields rewritten to the host repo root so `claude --resume` works natively. `IterationResult.sessionId` and `IterationResult.sessionFilePath` are populated on success. Capture is **best-effort** — failure logs a warning to stderr and leaves `sessionFilePath` undefined; the run still resolves successfully.

`RunOptions.resumeSession: "<id>"` validates the host file exists, transfers it into the sandbox with `cwd` rewritten to the sandbox-side worktree path, and passes `--resume <id>` to Claude Code on iteration 1 only. Validation runs **before** sandbox creation:

- `resumeSession` + `maxIterations > 1` throws (long-lived loops can't chain Claude session state).
- Missing host session file throws.

Opt out with `claudeCode("model", { captureSessions: false })`. Non-Claude agent providers ignore `captureSessions` and `resumeSession` (no-ops, no errors).

New optional surface on the `AgentProvider` interface: `sessionCapture?: AgentSessionCapture` (parses session id from a stream line, owns host/sandbox path layout, and rewrites `cwd` fields). `AgentBuildCommandInput` gains `resumeSessionId?: string` so providers can append their own resume args. New `IterationResult.sessionId?: string` field complements the existing `sessionFilePath`.
