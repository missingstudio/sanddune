# Branch strategy is per-call, not per-provider

## Context

An earlier iteration of the API attached the **branch strategy** to **sandbox providers** at construction time: `docker({ branchStrategy: { type: "branch", branch: "x" } })`. This made each provider a fully-configured factory and let the type system encode "isolated providers can't use head" at the constructor.

The cost was reuse. Callers running multiple operations against the same sandbox runtime had to construct a new provider per strategy — there was no way to say "Docker, but pick the strategy at the call site." Worse, `createWorktree()` (which is fundamentally a worktree-lifecycle primitive, not a sandbox concern) had no good place to take a strategy if the strategy lived on a sandbox.

## Decision

Move `branchStrategy` to the call site:

- `run()` accepts `branchStrategy?: BranchStrategy`, defaulting per provider type (`head` for **bind-mount**/**no-sandbox**, `merge-to-head` for **isolated**).
- `createWorktree()` accepts `branchStrategy: WorktreeBranchStrategy` (required, `head` excluded at the type level).
- `interactive()` does **not** accept `branchStrategy` — top-level interactive sessions always use the provider's default. Callers who need non-default branching with a TUI route through `createWorktree() + wt.interactive()`.
- `createSandbox()` opts out of the abstraction entirely and takes `branch: string`. A long-lived sandbox is single-branch by construction; `merge-to-head` would conflict with reusing the sandbox across multiple `sandbox.run()` calls, and `head` would conflict with having a stable worktree that survives across calls.

The "isolated provider can't use head" invariant is preserved via per-call type narrowing rather than constructor-encoded.

## Considered Options

1. **Strategy on provider construction** (rejected) — type-level invariants are encoded once, but reuse is poor and `createWorktree()` has no clean home for the option.
2. **Strategy on provider construction with provider methods like `provider.run()`** (rejected) — would require providers to know about the entire run lifecycle; bloats the provider interface.
3. **Full `BranchStrategy` on `createSandbox()`** (rejected) — would force `merge-to-head` and `head` semantics into a long-lived sandbox where they don't compose with `sandbox.run()` reuse.

## Consequences

- The `Sandbox` provider interface stays small — providers only know how to create sandboxes; branch logic is sanddune's concern.
- `createSandbox()`'s `branch: string` parameter is asymmetric with `run()`'s `branchStrategy` field. This is deliberate — the asymmetry encodes that `createSandbox()` is the "branch-strategy" mode only.
- The default-per-provider rule means a user who passes `docker()` with no `branchStrategy` to `run()` gets `head`; passing `vercel()` with no `branchStrategy` gets `merge-to-head`. Callers writing provider-agnostic code must set `branchStrategy` explicitly.
