---
"@missingstudio/sanddune": patch
---

Implement `Sandbox.interactive()` — previously threw `NotImplementedError`.

`sandbox.interactive(options)` launches the agent's TUI inside the existing long-lived sandbox container, reusing the same worktree and bind-mount handle that `sandbox.run()` uses. Multiple `sandbox.interactive()` calls (and `sandbox.run()` calls between them) all share one container and one branch, so there's no per-call rebuild cost.

`SandboxInteractiveOptions` now uses `OptionalPromptOption` (the prompt is optional — callers may launch a TUI with no seed) and adds a `signal: AbortSignal` field for parity with `sandbox.run()`. Pre-aborted signals reject before the TUI launches.

Requires the underlying `BindMountSandboxHandle` to implement the optional `execInteractive` method — providers that omit it raise a clear error rather than silently failing. Same requirement as the top-level `interactive()` bind-mount path.

Internally, the per-call helpers (`resolveInteractivePrompt`, `buildAgentInteractiveCommand`) were extracted from `interactive-program.ts` into a shared `interactive-shared.ts` module so both top-level `interactive()` and `sandbox.interactive()` use the same prompt-resolution and command-building logic.
