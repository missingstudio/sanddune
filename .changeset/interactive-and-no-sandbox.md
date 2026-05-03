---
"@missingstudio/sanddune": patch
---

Implement `interactive()`, `wt.interactive()`, and the `noSandbox()` **sandbox provider** — the TUI side of the API.

`interactive()` launches an **agent**'s interactive UI inside a **sandbox** or directly on the **host** and resolves when the user exits the TUI. Accepts all three sandbox provider kinds (**bind-mount**, **isolated**, **no-sandbox**); always uses the provider's default **branch strategy** (no `branchStrategy` option — route through `createWorktree() + wt.interactive()` for non-default strategies, per ADR-0009). Honors `cwd` for cross-repo TUI sessions, `signal` for cancellable launch, `prompt` / `promptFile` / `promptArgs` for an optional seed prompt, and the standard `hooks` / `env` / `copyToWorktree` lifecycle. No `maxIterations` or `completionSignal` — interactive sessions are user-driven.

`noSandbox()` runs the **agent** directly on the **host** with no container. Accepted only by `interactive()` / `wt.interactive()`; the type system still rejects it for `run()` and `createSandbox()`. With **no-sandbox**, sanddune does **not** pass `--dangerously-skip-permissions` to the **agent provider** so the agent's normal permission prompts stay active. Bind-mount and isolated providers in interactive mode still receive the flag.

`wt.interactive()` accepts any **sandbox provider** and defaults to `noSandbox()` when none is supplied. The parent `Worktree` keeps ownership of the **worktree** for the duration of the TUI and across it (per ADR-0010 "ownership follows creation").

The **agent provider** interface gains an optional `buildInteractiveCommand(input)` capability used by `interactive()`. Agent providers without it are rejected at runtime when `interactive()` is invoked. The `claudeCode()` provider implements it: emits `claude --model <m>` plus `--dangerously-skip-permissions` only when `skipPermissions: true`. AFK `buildCommand` behavior is unchanged.

`BindMountSandboxHandle` gains an optional `execInteractive(command, { cwd?, signal? })` method for stdio-inherited subprocess launches; the `docker()` provider implements it via `docker exec -it`.

Out of scope of this slice: real `vercel()` / isolated-provider runtime (the type is accepted by `interactive()` but the orchestrator rejects it at runtime), `Sandbox.interactive()` on long-lived sandboxes, and `resumeSession` plumbing for interactive TUIs.
