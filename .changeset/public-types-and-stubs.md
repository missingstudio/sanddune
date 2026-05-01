---
"@missingstudio/sanddune": patch
"@missingstudio/sanddune-core": patch
---

Declare the public type surface and entry-point stubs for `run`, `createSandbox`, `createWorktree`, and `interactive`. Sandbox provider factories under `./sandboxes/{docker,podman,vercel,no-sandbox}` are exposed as stubs that throw `NotImplementedError` at runtime.

Public surface introduced (defined in `@missingstudio/sanddune-core`, re-exported from `@missingstudio/sanddune`): `RunOptions`, `RunResult`, `IterationResult`, `IterationUsage`, `CompletionSignal`, `CopyToWorktree`, `CreateSandboxOptions`, `SandboxRunOptions`, `Sandbox`, `CloseResult`, `CreateWorktreeOptions`, `WorktreeRunOptions`, `WorktreeInteractiveOptions`, `WorktreeCreateSandboxOptions`, `Worktree`, `BranchStrategy` (`head` / `merge-to-head` / `branch`), `SandboxProvider`, `BindMountSandboxProvider`, `IsolatedSandboxProvider`, `NoSandboxProvider`, `BindMountSandboxHandle`, `IsolatedSandboxHandle`, `ExecResult`, `AgentProvider`, `AgentStreamEvent`, `SandboxHooks`, `HostHook`, `SandboxHook`, `Timeouts`, `LoggingOption`, `InteractiveOptions`, `NotImplementedError`, and an Effect `Context.Tag` for `AgentInvoker`.

Type-level architectural rejections enforced at compile time: `head` strategy with an isolated provider, `noSandbox()` passed to `run()` or `createSandbox()`, `head` passed to `createWorktree()`, and `prompt`/`promptFile`/`promptArgs` mutual exclusion.

Negative type tests are written as `@ts-expect-error` directives rather than `expect-type` / `tsd`. The directives serve the same purpose (an unused directive is itself a type error) without pulling in another devDep, and read more naturally for purely-negative cases.

Both packages now emit `.d.ts` declarations via `tsc -p tsconfig.build.json` ahead of the JS bundle, so npm consumers receive types. `@missingstudio/sanddune-core` is now publishable (was internal); it remains the source of truth for public types and `@missingstudio/sanddune` re-exports from it.
