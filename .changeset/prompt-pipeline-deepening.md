---
"@missingstudio/sanddune": patch
---

Collapsed the three previously separate **prompt** modules — `resolvePrompt`, `substitutePromptArgs`, `expandPrompt` — into a single owner: the **prompt pipeline** (`preparePromptPipeline`, exported from the package root). The pipeline handles option validation, file read, **prompt argument substitution**, and per-iteration **prompt expansion** behind a single interface: `prepared.getPromptForIteration(exec) → Promise<string>`.

Public surface changes (pre-1.0, no breaking-change shim):

- **Removed** the `resolvePrompt`, `substitutePromptArgs`, `expandPrompt` exports and their associated input/result types (`ResolvedPrompt`, `PromptResolverInput`, `SubstitutePromptArgsInput`, `SubstitutePromptArgsResult`, `ExpandPromptInput`, `ExpandPromptResult`). All three were originally exported for orchestration; the **iteration loop** is the only caller and now goes through the pipeline.
- **Added** `preparePromptPipeline`, `PromptPipelineInput`, and `PreparedPromptPipeline`.
- `BUILT_IN_PROMPT_ARGS`, `BuiltInPromptArg`, and `SandboxExec` remain exported, now from the prompt-pipeline module.

Internal: the **iteration loop**'s input dropped `prompt`, `promptKind`, and `sandboxExec` and gained a single `getPromptForIteration: () => Promise<string>` closure that `runProgram` builds by binding the live sandbox handle's `exec` into the pipeline. The loop no longer knows whether the prompt is **inline** or **template** — that distinction is now an implementation detail of the pipeline. Behaviour and error contracts (mutually-exclusive options, ADR-0008 inline-skips-substitution-and-expansion, built-in arg overrides, missing/invalid keys, shell-expression error wrapping, parallel expansion) are preserved verbatim.
