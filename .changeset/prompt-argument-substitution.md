---
"@missingstudio/sanddune-core": patch
"@missingstudio/sanddune": patch
---

Add **host-side prompt argument substitution** — the second stage of the **prompt** pipeline.

`substitutePromptArgs({ text, promptArgs, sourceBranch, targetBranch })` replaces every `{{KEY}}` placeholder in a **prompt template** with the corresponding value from `promptArgs`, and injects the **built-in prompt arguments** `{{SOURCE_BRANCH}}` and `{{TARGET_BRANCH}}` automatically. It runs once on the **host**, after `resolvePrompt` and before the **sandbox** is created.

- Built-ins are reserved: passing `SOURCE_BRANCH` or `TARGET_BRANCH` in `promptArgs` throws.
- A `{{KEY}}` with no matching arg (and not a built-in) throws naming the placeholder. (`interactive()` will defer this to a prompt-the-user flow in a later slice; AFK `run()` always throws.)
- Unused `promptArgs` keys are surfaced via the result's `unusedKeys` list — `run()` logs a warning to stderr per unused key without throwing.
- Substitution is single-pass: `{{...}}` and `` !`...` `` markers that appear inside `promptArgs` *values* are inert text, left for the downstream **prompt expansion** stage to interpret as already-substituted.
- **Inline prompts bypass substitution entirely** (per ADR-0008) — only `promptFile` templates flow through this stage.

`run()` now wires this stage in: `{{SOURCE_BRANCH}}` resolves to the explicitly provided `branch` option (or the sanddune-generated temp branch for `merge-to-head`), and `{{TARGET_BRANCH}}` resolves to the **host**'s current branch via `git rev-parse --abbrev-ref HEAD`. Templates that previously had `promptArgs` silently ignored are now substituted before reaching the agent.
