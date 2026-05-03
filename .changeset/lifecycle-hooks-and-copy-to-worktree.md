---
"@missingstudio/sanddune": patch
---

Wire lifecycle hooks and `copyToWorktree` into `run()`.

`copyToWorktree` now copies host paths into the worktree before any hook fires (relative paths resolve against `cwd`; rejected with `branchStrategy: { type: "head" }`). Hooks run as `host.onWorktreeReady` (sequential) → sandbox created → `host.onSandboxReady ∥ sandbox.onSandboxReady` (parallel).

Per ADR-0001 (amended), user-supplied lifecycle steps accept caller-supplied timeout overrides:

- Per-hook `timeoutMs?` on host and sandbox hooks (default `60_000ms`).
- `timeouts.copyToWorktreeMs?` for the `copyToWorktree` step (default `60_000ms`).

Non-zero hook exit fails the run immediately with the offending command and exit code. The caller `signal` is threaded into every hook and the `copyToWorktree` step. In the parallel `onSandboxReady` step, a failure on either side cancels the in-flight sibling so a failed run doesn't leave orphan host or sandbox work running.

Breaking type changes (no runtime breakage — these surfaces were not yet wired):

- `SandboxHooks` is now array-only — single-hook shorthand (`HostHook | readonly HostHook[]`) is removed. Wrap a single hook in `[ ... ]`.
- Removed exports: `HostHook`, `SandboxHook`, `HostHooks`, `InSandboxHooks`. The element shape is inlined inside `SandboxHooks`.
- `RunOptions.copyToWorktree` is now `readonly string[]` — the speculative `{ source, destination? }` object form has been removed along with the `CopyToWorktree` type export.

New typed errors: `HookTimeoutError`, `CopyToWorktreeTimeoutError` (the latter carries `currentItem` — the resolved path of the entry being copied when the timeout fired).
