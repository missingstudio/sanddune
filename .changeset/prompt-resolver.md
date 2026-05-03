---
"@missingstudio/sanddune-core": patch
"@missingstudio/sanddune": patch
---

Add the **`PromptResolver`** — the first stage of the **prompt** pipeline. `resolvePrompt({ prompt | promptFile, promptArgs? })` returns a tagged `ResolvedPrompt`:

- `kind: "inline"` — the verbatim string. No `{{KEY}}` scan, no shell-expression scan, no built-in argument injection (per ADR-0008's "inline = literal").
- `kind: "template"` — the file contents read from disk plus the untouched `promptArgs` map and the resolved absolute path. **Prompt argument substitution** and **prompt expansion** are out of scope for this slice — they consume the tag in later slices.

Runtime guards (defense in depth on the existing compile-time mutual exclusion):

- Passing both `prompt` and `promptFile` throws.
- Passing `promptArgs` alongside an inline `prompt` throws (per ADR-0008).
- A missing `promptFile` throws an error naming the resolved absolute path.

`promptFile` resolves relative paths against `process.cwd()` (the caller's perspective), **not** against `RunOptions.cwd` — those are deliberately different per CONTEXT.md's "two perspectives" rule.

`run()` no longer hard-rejects `promptFile`; it now calls the resolver in place of the previous "promptFile is not yet supported" branch and feeds the resolved text into the iteration loop. Templates without `{{KEY}}` or shell expressions work today; substitution and expansion land in later slices.
