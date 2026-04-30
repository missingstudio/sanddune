# sanddune

A TypeScript toolkit that orchestrates AI coding agents inside isolated sandbox environments, managing the lifecycle of sandboxes, branches, prompts, and iterations.

## Language

### Core concepts

**sanddune**:
The TypeScript CLI tool that orchestrates an **agent** inside a **sandbox**.
_Avoid_: "the tool", "the CLI", "RALPH"

**Sandbox**:
The isolation boundary around the **agent** -- a container, VM, or similar environment that constrains the **agent**'s access.
_Avoid_: "container" (too specific), "Docker sandbox" (ambiguous with Claude's built-in feature), "workspace"

**Host**:
The developer's machine where sanddune runs and the real git repo lives.
_Avoid_: "local" (ambiguous -- the sandbox also has a local filesystem)

**Agent**:
The AI coding tool invoked inside the **sandbox** (e.g. Claude Code, Codex).
_Avoid_: "RALPH", "the bot", "Claude" (too specific -- agent is swappable)

### Sandboxes

**Sandbox provider**:
A pluggable implementation that creates and manages a **sandbox**, injected into `run()` via the `sandbox` option.
_Avoid_: "backend", "runtime", "sandbox factory"

**Bind-mount sandbox provider**:
A **sandbox provider** where the **host** filesystem is mounted directly into the environment.
_Avoid_: "local provider", "mount provider"

**Isolated sandbox provider**:
A **sandbox provider** where the environment has its own filesystem, requiring sync to move code in and commits out.
_Avoid_: "remote provider", "sync provider"

**No-sandbox provider**:
A **sandbox provider** where no container is created -- the **agent** runs directly on the **host**.
_Avoid_: "local provider", "none provider", "host provider"

### Branching

**Branch strategy**:
Per-call configuration that controls how the agent's changes relate to branches. Passed to `run()` (and `createWorktree()`); falls back to a per-provider default when omitted. **Sandbox providers** are constructed strategy-agnostic; the **branch strategy** is decided at the call site.
_Avoid_: "worktree mode" (old name), "branch mode"

**Head (branch strategy)**:
A **branch strategy** where the **agent** works directly in the **host** working directory -- no **worktree**, no branch indirection.
_Avoid_: `"none"` (old name), "direct"

**Merge-to-head (branch strategy)**:
A **branch strategy** where sanddune creates a temporary branch, the agent works on it, and changes are merged back to HEAD.
_Avoid_: `"temp-branch"` (old name), "auto-branch"

**Branch (branch strategy)**:
A **branch strategy** where commits land on an explicitly named branch provided by the caller.
_Avoid_: "named-branch"

**Worktree**:
A git worktree created in `.sanddune/worktrees/` on the **host**, used by the **merge-to-head** and **branch** strategies. For **bind-mount sandbox providers**, the **worktree** is mounted into the **sandbox**. For **isolated sandbox providers**, the **worktree** is the sync source/destination -- commits from the **sandbox** are pulled back into the **worktree**. Created explicitly via `createWorktree()` or implicitly by `run()`/`interactive()` when using a non-**head** **branch strategy**.
_Avoid_: "workspace", "branch copy", "clone"

**Source branch**:
The branch the **agent** works on -- determined by the **branch strategy**.
_Avoid_: "working branch", "agent branch"

**Target branch**:
The **host**'s active branch at `run()` time -- the branch sanddune merges into when using **merge-to-head**.
_Avoid_: "base branch", "destination branch", "merge target"

### Agents

**Agent provider**:
A pluggable implementation that builds commands and parses output for a specific **agent**, injected into `run()` via the `agent` option.
_Avoid_: "agent adapter", "agent driver"

### Execution

**Agent invoker**:
The Effect service (`Context.Tag`) that wraps the raw call handing a fully-resolved **prompt** to the **agent provider** for one **iteration**. The seam used to substitute a recording or scripted fake in tests without running a real **agent**.
_Avoid_: "agent runner", "agent caller"

**Iteration**:
A single invocation of the **agent** inside the **sandbox**, producing at most one commit against one **task**.
_Avoid_: "run" (ambiguous with the JS `run()` function), "cycle", "loop"

**Task**:
A work item from the **backlog manager** that the **agent** selects and works on during an **iteration**.
_Avoid_: "job", "work item", "ticket"

**Completion signal**:
A user-configured string (or list of strings) the **agent** emits to signal early termination of the **iteration** loop. Detected by substring match on the **agent**'s output stream. Configured via the `completionSignal` option as `string | string[]`; first match wins when multiple are provided. The matched string is returned as `result.completionSignal` (or `undefined` if `maxIterations` is reached without a match). The default is the convention `<promise>COMPLETE</promise>`, but the marker is a sanddune-recommended convention, not a protocol -- any string works, and sanddune never injects the marker into a **prompt** for the user.
_Avoid_: "done flag", "exit signal"

### Prompts

**Prompt**:
The instruction text passed to the **agent** at the start of each **iteration**.
_Avoid_: "system prompt" (too specific), "instructions" (too vague), "message"

**Inline prompt**:
A **prompt** provided as a string via the `prompt` option. Passed through to the **agent** as-is — no **prompt argument substitution**, no **prompt expansion**.
_Avoid_: "dynamic prompt", "string prompt"

**Prompt template**:
A **prompt** sourced from a file via the `promptFile` option. May contain `{{KEY}}` placeholders and `` !`command` `` **shell expressions**, which are resolved via **prompt argument substitution** and **prompt expansion** before being passed to the **agent**.
_Avoid_: "prompt file" (refers to the option, not the concept), "template prompt"

**Prompt argument**:
A runtime **template argument** passed via `promptArgs` in `run()` that substitutes a `{{KEY}}` placeholder in a **prompt**.
_Avoid_: "prompt variable" (ambiguous with env vars), "template variable", "parameter"

**Prompt argument substitution**:
**Template argument substitution** applied to a **prompt** at runtime, using the **prompt arguments** map.
_Avoid_: "template expansion", "interpolation", "variable substitution"

**Prompt expansion**:
The preprocessing step that evaluates **shell expressions** in a **prompt**, replacing them with their stdout.
_Avoid_: "prompt preprocessing" (too generic), "command expansion"

**Shell expression**:
A `` !`command` `` marker in a **prompt** that evaluates a shell command inside the **sandbox**.
_Avoid_: "command" (overloaded), "inline command", "prompt command"

**Built-in prompt argument**:
A **prompt argument** that sanddune injects automatically -- not provided by the user via `promptArgs`.
_Avoid_: "system variable", "auto argument", "default prompt argument"

### Hooks

**Host hook**:
A lifecycle hook that runs on the **host** machine, not inside the **sandbox**. Host hooks are `{ command: string }` — no `sudo`, no `cwd`.
_Avoid_: "local hook"

**Sandbox hook**:
A lifecycle hook that runs inside the **sandbox** container. Sandbox hooks are `{ command: string; sudo?: boolean }`.
_Avoid_: "container hook", "remote hook"

### Init

**Init**:
The CLI command that scaffolds the **config directory** in a **host** repo.
_Avoid_: "create", "bootstrap", "new"

**Config directory**:
The `.sanddune/` directory in a **host** repo containing sandbox configuration.
_Avoid_: ".sanddune folder", "sanddune dir"

**Backlog manager**:
A pluggable source of **tasks** for the **agent**, selected during **init** (e.g. GitHub Issues, Beads).
_Avoid_: "task source", "issue tracker"

**Template argument**:
A named `{{KEY}}` placeholder in a scaffold template (Dockerfile, prompt `.md` file) that **init** replaces with a value derived from the user's choices.
_Avoid_: "placeholder", "variable"

**Template argument substitution**:
The preprocessing step during **init** that replaces **template arguments** with their resolved values.
_Avoid_: "template expansion", "interpolation"

### Infrastructure

**Build-image**:
A provider-namespaced CLI command that rebuilds the image (e.g. `sanddune docker build-image`).
_Avoid_: "setup-sandbox" (old name)

**Remove-image**:
A provider-namespaced CLI command that removes the image (e.g. `sanddune docker remove-image`).
_Avoid_: "cleanup-sandbox" (old name)

**Agent session**:
The **agent**'s persisted conversation record. For Claude Code, a `<session-id>.jsonl` written per **iteration**. Resumable via `claude --resume`.
_Avoid_: "chat history", "transcript"

### Display

**Log-to-file mode**:
The display mode where sanddune writes iteration progress and agent output to a **run log**.
_Avoid_: "file mode", "file logging", "quiet mode"

**Run log**:
A log file written to `.sanddune/logs/` during a run session.
_Avoid_: "log file" (too generic), "output file"

**Terminal mode**:
The display mode where sanddune renders an interactive UI in the terminal with spinners and styled status messages.
_Avoid_: "stdout mode", "interactive mode", "CLI mode" (ambiguous with the CLI itself)

**Agent stream event**:
A single item in the **agent**'s output stream -- either a `text` chunk or a `toolCall` -- surfaced to the caller of `run()` so the stream can be forwarded to an external observability system. Available only in **log-to-file mode** via the `onAgentStreamEvent` callback on the `logging` option. Each event carries its `iteration` number and a `timestamp`.
_Avoid_: "log event" (the log file contains more than just agent output), "display entry" (internal UI type)

## Relationships

- **sanddune** orchestrates an **agent** inside a **sandbox**
- A **sandbox** is created by a **sandbox provider**, which is injected into `run()` via the `sandbox` option -- this is required, there is no default
- A **sandbox provider** is a **bind-mount sandbox provider**, **isolated sandbox provider**, or **no-sandbox provider**
- The **branch strategy** is passed per-call to `run()` (and `createWorktree()`), not at provider construction. When omitted, sanddune picks the per-provider default
- `createSandbox()` opts out of the **branch strategy** abstraction: it takes `branch: string` directly, because a long-lived **sandbox** is single-branch by construction. Only the **branch** strategy semantics apply -- **merge-to-head** would conflict with reusing the **sandbox** across multiple `sandbox.run()` calls, and **head** would conflict with having a stable **worktree** that survives across calls
- Conceptually, every long-lived **sandbox** is built on a **worktree**. The canonical primitive is `wt.createSandbox()`; top-level `createSandbox()` is a bundled convenience that creates the **worktree** internally and disposes both together. Both share an internal `createSandboxFromWorktree` helper and return the same `Sandbox` type
- Ownership-follows-creation governs `sandbox.close()`: when the **sandbox** was created via top-level `createSandbox()`, `close()` tears down the container **and** the **worktree** (preserved on disk if dirty). When created via `wt.createSandbox()`, `close()` tears down the container only -- the **worktree** is owned by the parent `Worktree` and cleaned up by `wt.close()`. The `Sandbox` type is the same in both cases; the distinction is a runtime contract enforced by documentation, not by the type system
- A **bind-mount sandbox provider** supports all three **branch strategies**: **head** (default), **merge-to-head**, and **branch**
- An **isolated sandbox provider** supports **merge-to-head** (default) and **branch** only -- **head** is not valid because it cannot write directly to the **host** filesystem and is rejected at the type level
- An **isolated sandbox provider** handles syncing code in and extracting commits out -- optionally using **bundle/patch sync**. **Isolated sandbox providers are defined in the type system but not yet implemented**
- A **no-sandbox provider** supports all three **branch strategies** (default: **head**). It is only accepted by `interactive()`, not `run()` -- enforced at the type level. The **agent provider** does not receive `dangerouslySkipPermissions: true`
- `interactive()` accepts all three **sandbox provider** types; `run()` accepts only **bind-mount** and **isolated**
- Top-level `interactive()` does not accept a **branch strategy** -- it always uses the provider's default (typically **head** for **bind-mount**/**no-sandbox**, **merge-to-head** for **isolated**). To run an interactive session on a non-default strategy, route through `createWorktree() + wt.interactive()`. This mirrors the layered ownership rule for `createSandbox()`: top-level is convenience; `wt.*` is the conceptual primitive when **worktree** lifecycle needs explicit control
- `createSandbox()` does not accept a **no-sandbox provider**
- **Sandbox providers** are imported from subpaths (e.g. `@missingstudio/sanddune/sandboxes/docker`) -- the main `sanddune` entry point does not re-export any provider
- **Host hooks** run on the **host**; **sandbox hooks** run inside the **sandbox**. Hooks are grouped under `host` and `sandbox` in the `hooks` option
- Lifecycle ordering: `copyToWorktree` -> `host.onWorktreeReady` (sequential) -> sandbox created -> `host.onSandboxReady` + `sandbox.onSandboxReady` (parallel)
- `host.onSandboxReady` and `sandbox.onSandboxReady` run in parallel and are not coordinated. Setup that requires ordering between **host** and **sandbox** must live entirely on one side -- typically `sandbox.onSandboxReady` for anything that touches repo dependencies; `host.onSandboxReady` is reserved for observability hooks (tail logs, register the run with a dashboard) that don't depend on sandbox state being settled
- Each **iteration** may produce one or more commits; iterations repeat until the **completion signal** fires or the max count is reached
- **Init** creates the **config directory** on the **host**, prompting the user to select an **agent** and **backlog manager**
- **Init** performs **template argument substitution** on Dockerfiles and scaffold `.md` files, replacing **template arguments** with values derived from the user's choices
- Each **backlog manager** declares a Dockerfile snippet (installed via **template argument substitution**) and command placeholders for **prompt** templates
- The **agent**'s Dockerfile template contains **template arguments** (e.g. `{{BACKLOG_MANAGER_TOOLS}}`) that **init** fills in based on the selected **backlog manager**
- **Build-image** and **remove-image** are namespaced under their provider in the CLI (e.g. `sanddune docker build-image`)
- The **agent provider** is selected via the `agent` field in config or `--agent` CLI flag
- At launch, sanddune resolves env vars from **config directory** `.env` and `process.env`, then passes the full env map into the **sandbox**
- Env vars come from four sources, layered (lowest -> highest precedence): (1) `process.env`, (2) `.sanddune/.env`, (3) **agent provider** `env` and **sandbox provider** `env` -- which must be disjoint (overlap throws at launch, since neither provider has authority over a shared key), (4) `RunOptions.env`, the call-site escape hatch that overrides everything below and is allowed to overlap with provider env. Per-provider `env` exists for type-level credential declarations (e.g. **agent providers** can require `ANTHROPIC_API_KEY` at compile time); `RunOptions.env` exists for arbitrary call-site overrides without forcing the user to pick a provider to "own" the key
- Path resolution follows two perspectives: caller's filesystem vs. target repo's filesystem. `cwd` (the option) and `promptFile` resolve relative paths against `process.cwd()` -- they describe where the *caller* is. `copyToWorktree` resolves relative paths against `cwd` -- the items being copied are conceptually attached to the *target* repo (`node_modules`, `.env.example`, etc.)
- `sandbox.run()` is reusable after abort: when the `signal` fires mid-iteration, the **agent** subprocess is killed and the call rejects with `signal.reason` verbatim, but the `Sandbox` handle remains usable -- callers may invoke `.run()` again with a fresh signal or `.close()` to tear down. The **worktree** is left in whatever state the killed **agent** produced; sanddune does not roll back partial edits or commits. Callers responsible for retry-from-clean-slate must inspect with `git status` and clean up themselves
- The `idleTimeoutSeconds` mechanism is implemented as a synthesized abort -- the same contract as a caller-supplied `signal`, with a sanddune-defined reason. The handle stays usable after timeout fires
- Each `sandbox.run()` call has its own independent **iteration** loop bounded by `maxIterations`; iteration counts do not carry across calls
- `resumeSession` is accepted only by top-level `run()`, not by `sandbox.run()`. Resuming a Claude **agent session** is a fresh-sandbox concern -- once inside a long-lived **sandbox**, iterations do not chain Claude session state through `--resume`
- **Agent session** capture is best-effort, not a run contract. If `claudeCode()` is configured to capture (the default) and capture fails -- disk full, permissions, transfer error -- sanddune logs a warning and leaves `IterationResult.sessionFilePath` `undefined`, but the run still resolves successfully provided the **agent** itself succeeded. The primary contract of a run is "agent ran, commits landed"; the session JSONL is an auxiliary artifact for later `claude --resume`. Callers who require a captured session must check `sessionFilePath` themselves
- **Inline prompts** bypass **prompt argument substitution** and **prompt expansion** entirely -- they are passed to the **agent** as-is. `promptArgs` cannot be combined with an **inline prompt**; doing so raises an error
- **Prompt argument substitution** and **prompt expansion** only apply to **prompt templates** (prompts sourced via `promptFile`)
- **Prompt argument substitution** runs once after prompt resolution, replacing `{{KEY}}` placeholders with values from **prompt arguments** -- this happens on the **host**, before the **sandbox** exists
- **Prompt expansion** runs before each **iteration**, evaluating all **shell expressions** inside the **sandbox**
- **Prompt argument substitution** runs before **prompt expansion**, so **prompt arguments** can inject values into **shell expressions**
- A `{{KEY}}` placeholder in a **prompt template** with no matching **prompt argument** is an error in `run()` (AFK mode); in `interactive()`, sanddune prompts the user to fill in missing values
- Unused **prompt arguments** produce a warning
- A **prompt** may contain zero or more **prompt arguments** and/or **shell expressions**; each substitution step is skipped if there are no matches
- sanddune injects **built-in prompt arguments** `{{SOURCE_BRANCH}}` and `{{TARGET_BRANCH}}` automatically
- If a user passes `SOURCE_BRANCH` or `TARGET_BRANCH` in `promptArgs`, **prompt argument substitution** fails with an error -- **built-in prompt arguments** cannot be overridden
- **Target branch** defaults to the **host**'s current branch at `run()` time (via `git rev-parse --abbrev-ref HEAD`)
- **Source branch** is either the explicitly provided `branch` option or a sanddune-generated temp branch
- **Log-to-file mode** is the default for programmatic use via `run()`; **terminal mode** is used when passing `logging: { type: 'stdout' }` to `run()`
- In **log-to-file mode**, sanddune writes a **run log** to `.sanddune/logs/` and prints a `tail -f` command to the console
- In **terminal mode**, sanddune renders spinners, styled status messages, and summaries directly in the terminal
- In **log-to-file mode**, callers may pass an `onAgentStreamEvent` callback on the `logging` option to receive each **agent stream event** alongside the file log -- intended for forwarding the **agent**'s output to an external observability system. The callback is sync, fire-and-forget, and errors thrown by the callback are swallowed so a broken forwarder cannot kill the run

## Example dialogue

### Sandbox providers & branch strategies

> **Dev:** "What if I want to use Podman instead of Docker?"

> **Domain expert:** "Import a different **sandbox provider**. Instead of `import { docker } from '@missingstudio/sanddune/sandboxes/docker'`, use `import { podman } from 'sanddune/sandboxes/podman'`. Both are **bind-mount sandbox providers** -- the **branch strategy** controls how changes land. By default it's **head**, so the agent writes directly to your working directory."

> **Dev:** "What if I want safety -- a temp branch that merges back?"

> **Domain expert:** "Pass `branchStrategy: { type: 'merge-to-head' }` when constructing the provider. sanddune creates a **worktree**, the agent works on a temp branch, and it gets merged back to HEAD when done."

> **Dev:** "What about a cloud VM that can't bind-mount my local filesystem?"

> **Domain expert:** "That would be an **isolated sandbox provider**. It defaults to **merge-to-head** -- syncs code in, agent works, changes get merged back. You can also use `{ type: 'branch', branch: 'foo' }` to sync back to a named branch. But you can't use **head** -- there's no host directory to write to directly."

> **Dev:** "Can I write my own provider?"

> **Domain expert:** "Yes. Implement a function that returns a `SandboxProvider`. If your environment can mount a host directory, use the bind-mount factory -- sanddune handles worktrees and commit extraction for you. If not, use the isolated factory and implement `copyIn`, `copyFileOut`, and `extractCommits`. The **branch strategy** is configured on the provider at construction time."

### No-sandbox provider

> **Dev:** "I want to use `interactive()` without Docker -- I'm sitting right here, I can approve permissions myself."

> **Domain expert:** "Use the **no-sandbox provider**: `noSandbox()`. The **agent** runs directly on the **host** with no container. sanddune won't pass `--dangerously-skip-permissions` to the **agent provider**, so Claude Code's normal permission prompts stay active."

> **Dev:** "Can I still use a worktree with `noSandbox()`?"

> **Domain expert:** "Yes. All three **branch strategies** work. If you want the agent to work on a temp branch and merge back, pass `branchStrategy: { type: 'merge-to-head' }`. The worktree lifecycle is the same -- it's just not mounted into a container."

> **Dev:** "What about using `noSandbox()` with `run()` for an AFK job?"

> **Domain expert:** "That's not allowed -- `run()` doesn't accept a **no-sandbox provider**. This is enforced at the type level. AFK means unsupervised, so you need a real **sandbox** for isolation."

### Prompt system

> **Dev:** "I want to reuse the same **prompt** file for multiple issues in parallel. How do I pass the issue number in?"

> **Domain expert:** "Use **prompt arguments**. Put `{{ISSUE_NUMBER}}` in the **prompt** file, then pass `promptArgs: { ISSUE_NUMBER: 42 }` to `run()`. **Prompt argument substitution** replaces it before anything else runs."

> **Dev:** "What if I also have a **shell expression** that uses the issue number -- like `` !`gh issue view {{ISSUE_NUMBER}}` ``?"

> **Domain expert:** "That works. **Prompt argument substitution** runs first on the **host**, so `{{ISSUE_NUMBER}}` becomes `42` everywhere -- including inside **shell expressions**. Then **prompt expansion** evaluates the **shell expression** inside the **sandbox**."

> **Dev:** "What happens if I typo the key -- like `{{ISSUE_NUBMER}}`?"

> **Domain expert:** "**Prompt argument substitution** fails with an error. Every `{{KEY}}` in the **prompt** must have a matching **prompt argument**. The reverse is just a warning -- unused **prompt arguments** don't block execution."

> **Dev:** "My prompt has `{{ISSUE_NUMBER}}` but I forgot to pass it in `promptArgs`. What happens in interactive mode?"

> **Domain expert:** "sanddune scans the **prompt**, finds the missing `{{ISSUE_NUMBER}}`, and prompts you at the terminal to type it in. In `run()` it would just error -- there's nobody to ask."

### Agent providers & environment

> **Dev:** "What if I want to add support for OpenCode instead of Claude Code?"

> **Domain expert:** "Create a new **agent provider**. It declares which env vars it needs -- maybe `OPEN_CODE_API_KEY` instead of `ANTHROPIC_API_KEY`. And it provides its own Dockerfile template that installs the right binary."

> **Dev:** "How does sanddune know which **agent provider** to use?"

> **Domain expert:** "The `agent` option passed to `run()`, or the `--agent` CLI flag. sanddune loads env vars and passes them straight through to the **sandbox** -- the **agent** handles missing credentials on its own."

### Built-in prompt arguments

> **Dev:** "My reviewer agent diffs against `main`, but I'm working from a feature branch. The diff is huge."

> **Domain expert:** "Use the **built-in prompt argument** `{{TARGET_BRANCH}}` in your **prompt**. It resolves to the **host**'s active branch at `run()` time -- so if you kick off sanddune from `feature/auth`, the reviewer diffs against `feature/auth`, not `main`."

> **Dev:** "Can I override `{{TARGET_BRANCH}}` in `promptArgs`?"

> **Domain expert:** "No -- **built-in prompt arguments** can't be overridden. If you pass `TARGET_BRANCH` in `promptArgs`, **prompt argument substitution** fails with an error. Use a different key name if you need a custom value."

## Flagged ambiguities

- **"Worktree mode"** -- The old name for **branch strategy**. Use **branch strategy** -- it describes where changes land, not the mechanism.
- **"Provider"** -- Overloaded: both **agent provider** and **sandbox provider** exist. Always qualify -- never say just "provider" in isolation.
- **"Docker sandbox"** -- In this project, **sandbox** is our isolation concept, not Claude Code's built-in `docker sandbox` CLI feature.
- **"Container"** vs **"Sandbox"** -- "Container" is a Docker/Podman primitive; **sandbox** is our abstraction. Use **sandbox** for the concept, "container" only for provider implementation details.
- **"Local"** vs **"Host"** -- Use **host** for the developer's machine. "Local" is ambiguous (the **worktree** is also on a local filesystem).
- **"Run"** -- Can mean the JS `run()` function or a single **iteration**. Use **iteration** for one agent invocation; "run session" for a call to `run()`.
- **"Token"** vs **"Env var"** -- sanddune handles all environment variables generically. Use "env var" for the general concept; "token" only for auth credential values.
- **"Command"** -- Overloaded: hook commands, shell commands, CLI commands, **shell expressions**. Use **shell expression** for `` !`...` `` syntax; "hook" for lifecycle hooks; "CLI command" for `sanddune init`, etc.
- **"Variable"** vs **"Argument"** -- **Prompt arguments** are host-side values substituted into `{{KEY}}` placeholders. Env vars are passed into the **sandbox** environment. Don't call prompt arguments "variables".
- **"File mode"** vs **"Log-to-file mode"** -- Use **log-to-file mode**. "File mode" is ambiguous. Similarly, avoid "stdout mode" for **terminal mode**.
- **"Base branch"** vs **"Target branch"** -- Use **target branch**. "Base branch" is ambiguous in sanddune's context.
- **"Built-in"** vs **"Default"** prompt arguments -- "Default" implies overridable. **Built-in prompt arguments** cannot be overridden. Use "built-in".
- **"No sandbox"** vs **"local"** vs **"none"** -- The provider type is `NoSandboxProvider`, the factory is `noSandbox()`, the tag is `"none"`. Say **no-sandbox provider** in prose.
- **"Workspace"** -- Retired term. Use **worktree** for the git worktree on the **host**, and **sandbox** for the isolation boundary. Don't say "workspace" in this project.
- **"Interactive mode"** -- Could mean `interactive()` (sanddune's function) or Claude Code's TUI. In this project, it means sanddune's `interactive()`. Don't confuse with **terminal mode**.
