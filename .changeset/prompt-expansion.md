---
"@missingstudio/sanddune-core": patch
"@missingstudio/sanddune": patch
---

Add **prompt expansion** — the third and final stage of the **prompt** pipeline.

`expandPrompt({ text, exec })` finds every `` !`command` `` **shell expression** in a **prompt template** and evaluates it via the supplied `exec` (bound to the **sandbox** at runtime), replacing the marker in place with the command's stdout.

- All shell expressions in a single prompt run in **parallel** (so multiple `gh issue list` / `git log` fetches don't serialize).
- The trailing newline on each command's stdout is trimmed; interior newlines are preserved.
- A non-zero exit from any expression rejects the call with the offending command and exit code; remaining commands continue to run on the sandbox but their results are discarded.
- Empty stdout collapses the marker to nothing.
- **Inline prompts skip this stage entirely** — gating is the caller's responsibility (see ADR-0008 / `resolvePrompt`).
- Wiring into `run()` (after `sandbox.onSandboxReady` hooks, before each iteration) is deferred to the slice that defines the hook ordering. The module is shipped standalone with unit tests against a fake `exec`.
