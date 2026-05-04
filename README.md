<div align="center">
  <img alt="sanddune" src="./images/sanddune.png" height="200" style="margin-bottom: 20px;">
</div>

## What is sanddune?

A TypeScript library for orchestrating AI coding agents in isolated sandboxes.

- You call `sanddune.run()`.
- An agent runs in a Docker container against a git worktree.
- You get commits on a branch.
- Your host working tree stays clean (or doesn't, depending on the branch strategy you pick).


> **Note:**  sanddune is heavily inspired by [Matt Pocock's sandcastle](https://github.com/mattpocock/sandcastle). The core orchestration model — branch strategies, bind-mount providers, the `run()` API shape — is based on his work.

## Prerequisites

- [Git](https://git-scm.com/)
- [Docker Desktop](https://www.docker.com/) (or any Docker-compatible runtime)
- [Bun](https://bun.sh/) ≥ 1.3 if you're working in this repo
- An `ANTHROPIC_API_KEY`

## What's implemented today

| Surface                             | Status     | Notes                                                                            |
| ----------------------------------- | ---------- | -------------------------------------------------------------------------------- |
| `run()`                             | ✅ shipped | Bind-mount only; inline `prompt` and `promptFile`; multi-iteration via `maxIterations` + `completionSignal` + `idleTimeoutSeconds` |
| `docker()` sandbox provider         | ✅ shipped | Bind-mount, auto image-exists check, parent `.git` re-mount for worktrees        |
| `claudeCode()` agent provider       | ✅ shipped | `--print --output-format stream-json --verbose --dangerously-skip-permissions`   |
| `branchStrategy: { type: "head" }`         | ✅ shipped | Default. Agent writes directly to host working tree.                             |
| `branchStrategy: { type: "merge-to-head" }` | ✅ shipped | Worktree under `.sanddune/worktrees/<id>/`, fast-forward back to HEAD on success |
| `branchStrategy: { type: "branch", branch }` | ✅ shipped | Named branch in a worktree; reused on re-run            |
| Env resolution                       | ✅ shipped | `.sanddune/.env` + agent/sandbox `env` + `RunOptions.env`         |
| JSONL run log                        | ✅ shipped | Streamed to `.sanddune/logs/<run-id>.jsonl` (or `logging.path`)                  |
| Terminal mode (`logging: { type: "stdout" }`) | ✅ shipped | Spinners + styled status lines + run summary                                 |
| `onAgentStreamEvent` callback        | ✅ shipped | Sync, fire-and-forget; errors swallowed (file mode only)                         |
| `IterationResult.usage`              | ✅ shipped | Raw token counts parsed from captured Claude session JSONL (per ADR-0005b)       |
| Custom bind-mount provider           | ✅ shipped | Build your own by constructing a `SandboxProvider` with `kind: "bind-mount"` |
| `createSandbox()`                   | ✅ shipped | Long-lived reusable sandbox on a single branch; multiple `sandbox.run()` calls reuse the container; `await using` auto-disposes |
| `createWorktree()`                  | ✅ shipped | Long-lived worktree as an independent lifecycle; `wt.run()` / `wt.createSandbox()` / `wt.interactive()` layer on top with split-close ownership (ADR-0010) |
| `interactive()`                     | ✅ shipped | Launches the agent's TUI inside a sandbox or directly on the host; accepts `bind-mount`, `isolated`, or `no-sandbox` providers; uses the provider's default branch strategy |
| `noSandbox()` sandbox provider      | ✅ shipped | Runs the agent on the host with no container; accepted only by `interactive()` / `wt.interactive()`; the agent's normal permission prompts stay active |

## Quick start

There is no `sanddune init` yet — set up by hand. The repo's `.sanddune/` directory shows the layout.

1. Install:

```bash
npm install --save-dev @missingstudio/sanddune
```

2. Create a `.sanddune/Dockerfile` that includes `git`, `gh`, the Claude Code CLI, and a non-root user (use [./.sanddune/Dockerfile](./.sanddune/Dockerfile) as a starting point).

3. Build the image. The default tag is `sanddune:<repo-dir-name>`:

```bash
docker build -t sanddune:my-repo -f .sanddune/Dockerfile .sanddune
```

4. Create `.sanddune/.env` with your `ANTHROPIC_API_KEY`:

```
ANTHROPIC_API_KEY=sk-ant-...
```

5. Write a script and run it with `bun` (or `tsx`):

```typescript
import { run, claudeCode } from "@missingstudio/sanddune";
import { docker } from "@missingstudio/sanddune/sandboxes/docker";

const result = await run({
  agent: claudeCode("claude-opus-4-7"),
  sandbox: docker(),
  prompt: "Add a HELLO.md file with the text 'hi'. Commit it.",
});

console.log(result.branch);          // host's active branch
console.log(result.commits);         // ["<sha>"]
console.log(result.logFilePath);     // .sanddune/logs/<run-id>.jsonl
```

The agent runs once in Docker, makes a commit (or doesn't), and the container is destroyed.

## How it works

A run goes through three phases:

1. **Setup** — resolve env vars, determine the host's current branch, plan the branch strategy, create a worktree if needed, start the container with the worktree bind-mounted at `/workspace`.
2. **Agent invocation** — invoke the agent with the (inline) prompt, stream JSON events into the run log, capture stdout text events.
3. **Teardown** — read commits off the worktree HEAD, fast-forward back to the host branch (`merge-to-head` only), tear down the container, and clean up the worktree (preserving it on disk if dirty).

The iteration loop honors `maxIterations` (default `1`), `completionSignal` (default `<promise>COMPLETE</promise>`, substring-matched against the agent's text events; first match across iterations wins), `idleTimeoutSeconds` (default `600`; resets on every agent stream event — on expiry the agent subprocess is killed and the run rejects with `AgentIdleTimeoutError`), and `signal` (caller-supplied `AbortSignal` — when it fires mid-iteration, the agent subprocess is killed and `run()` rejects with `signal.reason` verbatim; the worktree is left as-is per ADR-0011). For **prompt templates**, **prompt expansion** evaluates `` !`shell expressions` `` once per iteration before the agent is invoked. With `claudeCode()` (default `captureSessions: true`), each iteration's session JSONL is captured from the sandbox to `~/.claude/projects/<encoded-cwd>/sessions/<id>.jsonl` on the host with `cwd` fields rewritten so `claude --resume` works natively; capture is best-effort (failure logs a warning and the run still resolves successfully).

## Branch strategies

Configure where the agent's commits land via the `branchStrategy` option on `run()`. When omitted, defaults to `{ type: "head" }` for bind-mount providers (the only kind that can run today).

| Strategy                                       | Where commits land                                  | Host HEAD touched? |
| ---------------------------------------------- | --------------------------------------------------- | ------------------ |
| `{ type: "head" }`                             | Host working tree directly. No worktree.            | Yes                |
| `{ type: "merge-to-head" }`                    | Temp branch in a worktree, fast-forwarded into HEAD | Yes (on success)   |
| `{ type: "branch", branch: "agent/fix-42" }`   | Named branch in a worktree                          | No                 |

```typescript
// head — fast iteration during development
await run({
  agent: claudeCode("claude-opus-4-7"),
  sandbox: docker(),
  prompt: "...",
});

// merge-to-head — safer; HEAD untouched if anything goes wrong mid-run
await run({
  agent: claudeCode("claude-opus-4-7"),
  sandbox: docker(),
  branchStrategy: { type: "merge-to-head" },
  prompt: "...",
});

// branch — commits on a named branch you can pick up later (e.g. for a PR)
await run({
  agent: claudeCode("claude-opus-4-7"),
  sandbox: docker(),
  branchStrategy: { type: "branch", branch: "agent/fix-42" },
  prompt: "...",
});
```

For `merge-to-head` and `branch`, sanddune creates the worktree under `.sanddune/worktrees/<id>/` with a lock under `.sanddune/locks/<id>.lock`. If the agent leaves the worktree dirty, it's preserved on disk and surfaced as `result.worktreePath`. For `branch`, re-running with the same branch name reuses the worktree (per [ADR-0003](docs/adr/0003-reuse-worktree-by-default.md)).

## API

### `run(options)`

```typescript
import { run, claudeCode } from "@missingstudio/sanddune";
import { docker } from "@missingstudio/sanddune/sandboxes/docker";

const result = await run({
  agent: claudeCode("claude-opus-4-7"),
  sandbox: docker(),
  prompt: "Fix the typo in README.md and commit.",

  // Optional:
  cwd: "../other-repo",                                  // host repo root, defaults to process.cwd()
  branchStrategy: { type: "branch", branch: "agent/x" }, // see Branch strategies
  env: { MY_VAR: "value" },                              // call-site env override (ADR-0012)
});
```

#### Currently accepted

| Option               | Type                                | Behavior                                                                                                                                |
| -------------------- | ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `agent`              | `AgentProvider`                     | **Required.** Today: `claudeCode(model, { env?, captureSessions? })`                                                                    |
| `sandbox`            | `SandboxProvider`                   | **Required.** Today: `docker()` or your own bind-mount provider                                                                         |
| `prompt`             | `string`                            | Inline prompt; passed to the agent verbatim (ADR-0008)                                                                                  |
| `promptFile`         | `string`                            | Path to a prompt template file; relative paths resolve from `process.cwd()`                                                             |
| `promptArgs`         | `Record<string, string \| number>`  | Values for `{{KEY}}` placeholders in `promptFile`; rejected when combined with inline `prompt`                                          |
| `cwd`                | `string`                            | Host repo dir; relative paths resolve from `process.cwd()`. Defaults to `process.cwd()`                                                 |
| `branchStrategy`     | `BranchStrategy`                    | `head` (default) / `merge-to-head` / `branch`                                                                                           |
| `env`                | `Record<string, string>`            | Call-site env override; highest precedence (ADR-0012)                                                                                   |
| `name`               | `string`                            | Display name prefixed in log output and terminal-mode rendering; cosmetic only                                                          |
| `maxIterations`      | `number`                            | Default `1`. The iteration loop runs at most this many times                                                                            |
| `completionSignal`   | `string \| string[]`                | Default `<promise>COMPLETE</promise>`. First match wins; surfaced as `RunResult.completionSignal`                                       |
| `idleTimeoutSeconds` | `number`                            | Default `600`. Resets on every agent stream event; on expiry the run rejects with `AgentIdleTimeoutError` (ADR-0011)                    |
| `signal`             | `AbortSignal`                       | When fired mid-iteration, the agent subprocess is killed and `run()` rejects with `signal.reason` verbatim (ADR-0011)                   |
| `resumeSession`      | `string`                            | Continue a prior Claude Code session by id. Validated **before** sandbox creation; rejected when combined with `maxIterations > 1`      |
| `hooks`              | `SandboxHooks`                      | Lifecycle hooks; see below                                                                                                              |
| `copyToWorktree`     | `string[]`                          | Host items copied into the worktree before hooks fire; rejected with `branchStrategy: { type: "head" }`                                 |
| `timeouts`           | `Timeouts`                          | Currently only `copyToWorktreeMs` (default `60_000`) is wired                                                                           |
| `logging`            | `LoggingOption`                     | `{ type: "file", path?, onAgentStreamEvent? }` (default) or `{ type: "stdout" }` for terminal mode                                      |

Exactly one of `prompt` / `promptFile` is required. On the template path, sanddune performs host-side `{{KEY}}` substitution before the agent runs: every `{{KEY}}` placeholder is replaced with its value from `promptArgs`, plus the built-in arguments `{{SOURCE_BRANCH}}` and `{{TARGET_BRANCH}}` (resolved from the active branch strategy). Passing `SOURCE_BRANCH` or `TARGET_BRANCH` in `promptArgs` throws — built-ins cannot be overridden. A `{{KEY}}` with no matching arg throws naming the key; unused `promptArgs` keys log a warning. Inline `prompt` skips substitution entirely (per ADR-0008), and combining `prompt` with `promptArgs` throws. Templates can also embed `` !`command` `` shell expressions, evaluated in parallel inside the sandbox before each iteration; substitution runs first, so `{{KEY}}` placeholders inside shell expressions are valid (e.g. `` !`gh issue view {{ISSUE}}` ``). All of this is owned by the `preparePromptPipeline()` module, exported from `@missingstudio/sanddune` for callers who want to reuse the host-side validation outside `run()`.

#### Lifecycle hooks and `copyToWorktree`

`copyToWorktree` accepts a list of host paths (relative paths resolve against `cwd`, the target-repo perspective; absolute paths are used as-is) that are copied into the worktree before any hook fires. Rejected at runtime with `branchStrategy: { type: "head" }` — there is no separate worktree to copy into.

`hooks` runs in this order: `host.onWorktreeReady` (sequential) → sandbox created → `host.onSandboxReady ∥ sandbox.onSandboxReady` (parallel; the two sides are not coordinated, so setup that needs ordering across host/sandbox must live entirely on one side). Host hooks are `{ command, timeoutMs? }`; sandbox hooks add `{ sudo? }`. Per-hook timeout defaults to `60_000ms` and is caller-overridable via `timeoutMs`. The `copyToWorktree` step has its own timeout (`timeouts.copyToWorktreeMs`, default `60_000ms`). Non-zero exit fails the run with the offending command and exit code; the caller `signal` is threaded into every hook so abort kills in-flight commands.

```typescript
await run({
  agent: claudeCode("claude-opus-4-7"),
  sandbox: docker(),
  branchStrategy: { type: "merge-to-head" },
  prompt: "...",
  copyToWorktree: [".env.example", "fixtures/"],
  hooks: {
    host: {
      onWorktreeReady: [{ command: "cp .env.example .env" }],
    },
    sandbox: {
      onSandboxReady: [{ command: "bun install", timeoutMs: 120_000 }],
    },
  },
  timeouts: { copyToWorktreeMs: 30_000 },
});
```

`resumeSession: "<id>"` continues a prior Claude Code session in a fresh sandbox. Validated **before** sandbox creation: the host session file must exist (at the path written by a previous capture), and the option is rejected when combined with `maxIterations > 1`. The file is transferred into the sandbox with `cwd` rewritten, and `--resume <id>` is passed to Claude Code on iteration 1 only — subsequent iterations start fresh. Non-Claude agent providers ignore `resumeSession`.

#### Accepted by the type but not yet wired

`timeouts.idleSeconds` and `timeouts.totalSeconds` (the nested fields on the `Timeouts` interface) are silently ignored. The live idle knob is `idleTimeoutSeconds` at the top level of `RunOptions` — see the table above. There is no top-level total-run timeout; if you need one, wrap the call with an `AbortController`.

#### `logging`

```typescript
logging: { type: "file" }                                // default
logging: { type: "file", path: "/abs/or/relative.jsonl" } // override location
logging: { type: "file", onAgentStreamEvent: (event) => { /* forward */ } }
logging: { type: "stdout" }                              // terminal mode
```

In **log-to-file mode** (default), sanddune writes a **run log** to `.sanddune/logs/<run-id>.jsonl` (or `path` when supplied) and prints a `tail -f` hint. `RunResult.logFilePath` is the absolute path of the file. The optional `onAgentStreamEvent` callback fires synchronously for every parsed **agent stream event** carrying `{ iteration, timestamp, type: "text" | "toolCall", ... }` — intended for forwarding to an observability system. The callback is fire-and-forget; thrown errors are swallowed onto stderr so a broken forwarder cannot kill the run.

In **terminal mode** (`{ type: "stdout" }`), sanddune renders an interactive UI directly: spinners while iterations run, a status line per iteration, and a final summary. `RunResult.logFilePath` is `undefined`; `onAgentStreamEvent` is **not** surfaced in this mode (the rendered UI is the channel).

#### `name`

```typescript
name: "issue-42"
```

Optional display name prefixed in log output (`[issue-42] tail -f …`) and **terminal mode** rendering for parallel-run readability. Cosmetic only — not persisted in the **run log** records.

### `RunResult`

```typescript
interface RunResult {
  branch: string;                  // result branch — host's active branch (head/merge-to-head) or named branch
  worktreePath?: string;           // set when the worktree was preserved on disk after a dirty close
  iterations: IterationResult[];   // one entry per iteration that ran
  commits: string[];               // SHAs reachable from worktree HEAD past the pre-run tip, ordered by iteration
  completionSignal?: string;       // the matched completion-signal string, if the loop terminated by signal
  stdout: string;                  // concatenated text events from the agent stream
  logFilePath?: string;            // path to the JSONL run log; undefined in terminal mode
}

interface IterationResult {
  iteration: number;
  commitSha?: string;              // last commit produced on this iteration, if any
  sessionId?: string;              // agent session id (Claude Code system/init), when sessionCapture is configured
  sessionFilePath?: string;        // host path to captured JSONL, when capture succeeded
  usage?: IterationUsage;          // raw token counts parsed from the captured session JSONL (per ADR-0005b)
  completionSignal?: string;       // set on the iteration that matched the completion signal
}

interface IterationUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
}
```

### `createSandbox(options)` — long-lived reusable sandbox

Use `createSandbox()` when you need to run multiple agents (or multiple rounds of the same agent) inside one container on the same branch. The container starts once; each `sandbox.run()` reuses it. Hooks fire **once** at creation, not per call.

```typescript
import { createSandbox, claudeCode } from "@missingstudio/sanddune";
import { docker } from "@missingstudio/sanddune/sandboxes/docker";

await using sandbox = await createSandbox({
  agent: claudeCode("claude-opus-4-7"),
  sandbox: docker(),
  branch: "agent/fix-42",
  hooks: { sandbox: { onSandboxReady: [{ command: "bun install" }] } },
});

// Implement
await sandbox.run({ prompt: "Fix issue #42.", maxIterations: 5 });

// Review on the same branch and same container — `bun install` doesn't re-run.
await sandbox.run({ prompt: "Review the changes and fix anything off." });
```

`await using` calls `close()` automatically on block exit; if the worktree is dirty it's preserved on disk and surfaced as `CloseResult.preservedWorktreePath`. Per [ADR-0010](docs/adr/0010-layered-sandbox-creation.md), ownership-follows-creation: a `Sandbox` returned by top-level `createSandbox()` owns its worktree, so `close()` tears down both container and worktree.

`createSandbox()` is single-branch by construction — it accepts `branch: string`, not the full `BranchStrategy` (per [ADR-0009](docs/adr/0009-branch-strategy-per-call.md)). `merge-to-head` would conflict with cross-call reuse, and `head` would conflict with having a stable worktree.

#### `CreateSandboxOptions`

| Option           | Type                       | Behavior                                                                                |
| ---------------- | -------------------------- | --------------------------------------------------------------------------------------- |
| `agent`          | `AgentProvider`            | **Required.** Used by every `sandbox.run()` call                                        |
| `sandbox`        | `SandboxProvider`          | **Required.** Today: `docker()` or your own bind-mount provider                         |
| `branch`         | `string`                   | **Required.** Explicit branch the worktree checks out                                   |
| `cwd`            | `string`                   | Host repo dir; relative paths resolve from `process.cwd()`. Defaults to `process.cwd()` |
| `env`            | `Record<string, string>`   | Call-site env override (ADR-0012)                                                       |
| `hooks`          | `SandboxHooks`             | Run **once** at creation — not per `sandbox.run()` call                                 |
| `copyToWorktree` | `string[]`                 | Host items copied into the worktree at creation time                                    |
| `timeouts`       | `Timeouts`                 | Currently only `copyToWorktreeMs` is wired                                              |
| `logging`        | `LoggingOption`            | Default for `sandbox.run()` calls; per-call `logging` overrides                         |

#### `Sandbox`

| Member                  | Type                                              | Notes                                                                            |
| ----------------------- | ------------------------------------------------- | -------------------------------------------------------------------------------- |
| `branch`                | `string`                                          | The branch the sandbox is on                                                     |
| `worktreePath`          | `string`                                          | Host path to the worktree                                                        |
| `run(options)`          | `(SandboxRunOptions) => Promise<RunResult>`       | Invoke an agent inside the existing sandbox                                      |
| `interactive(options)`  | `(SandboxInteractiveOptions) => Promise<void>`    | Throws `NotImplementedError` today                                               |
| `close()`               | `() => Promise<CloseResult>`                      | Tears down the container; tears down the worktree iff the `Sandbox` owns it (ADR-0010) |
| `[Symbol.asyncDispose]` | `() => Promise<void>`                             | Auto teardown via `await using`                                                  |

#### `SandboxRunOptions`

Equals top-level `RunOptions` minus the fields fixed at creation time (`agent`, `sandbox`, `cwd`, `branchStrategy`, `hooks`, `copyToWorktree`, `timeouts`, `name`) and minus `resumeSession` (rejected at the type level — Claude session resume is a fresh-sandbox concern only).

| Option               | Type                               | Behavior                                                                              |
| -------------------- | ---------------------------------- | ------------------------------------------------------------------------------------- |
| `prompt`             | `string`                           | Inline prompt (mutually exclusive with `promptFile`)                                  |
| `promptFile`         | `string`                           | Path to a prompt template                                                             |
| `promptArgs`         | `Record<string, string \| number>` | Values for `{{KEY}}` placeholders                                                     |
| `maxIterations`      | `number`                           | Default `1`. Each call has its own independent iteration loop (ADR-0011)              |
| `completionSignal`   | `string \| string[]`               | Default `<promise>COMPLETE</promise>`                                                 |
| `idleTimeoutSeconds` | `number`                           | Default `600`                                                                         |
| `env`                | `Record<string, string>`           | Per-call env override; merged with the creation-time env                              |
| `logging`            | `LoggingOption`                    | Overrides the creation-time default                                                   |
| `signal`             | `AbortSignal`                      | Aborting kills the in-flight agent; the sandbox stays usable for a re-run (ADR-0011)  |

#### `CloseResult`

| Field                   | Type      | Notes                                                                                                                                              |
| ----------------------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `worktreePreserved`     | `boolean` | `true` when the worktree was dirty at close                                                                                                        |
| `preservedWorktreePath` | `string`  | Host path to the preserved worktree; set only when `worktreePreserved` is `true`. Always `undefined` for a `Sandbox` returned by `wt.createSandbox()` (worktree ownership lives with the parent `Worktree`, ADR-0010) |

### `createWorktree(options)` — independent worktree lifecycle

Use `createWorktree()` when the worktree should outlive any single sandbox or interactive session — e.g. start an interactive session to explore, then hand the same worktree to an AFK agent. Only `branch` and `merge-to-head` strategies are accepted; `head` is a compile-time error (no worktree to create).

```typescript
import { createWorktree, claudeCode } from "@missingstudio/sanddune";
import { docker } from "@missingstudio/sanddune/sandboxes/docker";

await using wt = await createWorktree({
  branchStrategy: { type: "branch", branch: "agent/explore" },
  copyToWorktree: ["node_modules"],
});

// Interactive on the host (defaults to noSandbox()) — same worktree.
await wt.interactive({ agent: claudeCode("claude-opus-4-7") });

// AFK in Docker — same worktree, fresh container.
const result = await wt.run({
  agent: claudeCode("claude-opus-4-7"),
  sandbox: docker(),
  prompt: "Implement what we discussed.",
  maxIterations: 3,
});

// Or layer a long-lived sandbox on top — same worktree.
await using sandbox = await wt.createSandbox({
  agent: claudeCode("claude-opus-4-7"),
  sandbox: docker(),
});
await sandbox.run({ prompt: "..." });
```

**Split ownership (ADR-0010).** A `Sandbox` returned by `wt.createSandbox()` does not own the worktree — `sandbox.close()` tears down the container only; `wt.close()` is responsible for the worktree. Top-level `createSandbox()` owns both. Same `Sandbox` type either way; the `close()` semantics differ by provenance.

#### `CreateWorktreeOptions`

| Option           | Type                    | Behavior                                                                                                     |
| ---------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------ |
| `branchStrategy` | `NonHeadBranchStrategy` | **Required.** `{ type: "branch", branch }` or `{ type: "merge-to-head" }`. `head` rejected at the type level |
| `cwd`            | `string`                | Host repo dir; relative paths resolve from `process.cwd()`                                                   |
| `copyToWorktree` | `string[]`              | Host items copied into the worktree at creation time                                                         |
| `timeouts`       | `Timeouts`              | Currently only `copyToWorktreeMs` is wired                                                                   |

`hooks` are **not** accepted on `CreateWorktreeOptions` — they are passed per-method to `wt.run()` / `wt.interactive()` / `wt.createSandbox()`.

#### `Worktree`

| Member                   | Type                                                          | Notes                                                  |
| ------------------------ | ------------------------------------------------------------- | ------------------------------------------------------ |
| `worktreePath`           | `string`                                                      | Host path to the worktree                              |
| `branch`                 | `string`                                                      | The branch the worktree is on                          |
| `branchStrategy`         | `NonHeadBranchStrategy`                                       | The strategy passed at creation                        |
| `run(options)`           | `(WorktreeRunOptions) => Promise<RunResult>`                  | One-shot AFK agent on this worktree (sandbox required) |
| `interactive(options)`   | `(WorktreeInteractiveOptions) => Promise<void>`               | TUI on this worktree; sandbox defaults to `noSandbox()` |
| `createSandbox(options)` | `(WorktreeCreateSandboxOptions) => Promise<Sandbox>`          | Long-lived sandbox over this worktree                  |
| `close()`                | `() => Promise<CloseResult>`                                  | Tears down only the worktree (ADR-0010)                |
| `[Symbol.asyncDispose]`  | `() => Promise<void>`                                         | Auto cleanup via `await using`                         |

`copyToWorktree` set at `createWorktree()` time is the fallback when a method call omits it; passing it on a `wt.*` method overrides for that call. `wt.run()` does **not** accept `resumeSession` — session resume is a top-level `run()` concern only.

#### `WorktreeRunOptions`

Same shape as top-level `RunOptions` minus `cwd` (inherited from the worktree), `branchStrategy` (the worktree determines), `name`, and `resumeSession`. `agent` and `sandbox` are required per call.

#### `WorktreeInteractiveOptions`

Same shape as top-level `interactive()` minus `cwd` and `name`. `sandbox` is **optional** — defaults to `noSandbox()` so the agent runs directly on the host inside the worktree.

#### `WorktreeCreateSandboxOptions`

Same shape as top-level `createSandbox()` minus `branch` (the worktree determines) and `cwd`. `agent` and `sandbox` are required.

### Environment resolution

Per [ADR-0012](docs/adr/0012-env-declaration-driven.md), env vars are *declaration-driven*: a key reaches the sandbox iff it's declared in one of these layers. `process.env` only supplies values for already-declared keys.

Layers, lowest → highest precedence:

1. `process.env` — value source only, never declares
2. `.sanddune/.env` — declaration site and value source
3. Agent provider `env` and sandbox provider `env` — declaration sites; must not overlap
4. `RunOptions.env` — call-site escape hatch; declares, sets, and overrides

```typescript
await run({
  agent: claudeCode("claude-opus-4-7", {
    env: { ANTHROPIC_API_KEY: "sk-ant-..." },
  }),
  sandbox: docker({
    env: { SOME_DOCKER_VAR: "x" },
  }),
  env: { OVERRIDE: "y" },
  prompt: "...",
});
```

If an agent provider's `env` and a sandbox provider's `env` share a key, `run()` throws.

### `docker(options?)`

```typescript
docker({
  image: "sanddune:my-repo",                  // optional; defaults to sanddune:<repo-dir-name>
  env: { SOMETHING: "value" },                // optional; merged per ADR-0012
})
```

Today's `DockerOptions` is `{ image?, env? }`. The image must already exist locally; sanddune does **not** build it for you (no `sanddune init` / `build-image` yet). Build manually:

```bash
docker build -t sanddune:my-repo -f .sanddune/Dockerfile .sanddune
```

The container is started with `-w /workspace` and the worktree bind-mounted there. If the worktree's `.git` is a pointer file (true for git worktrees), sanddune also bind-mounts the parent `.git` directory at its host path inside the container so the pointer resolves (per [ADR-0006](docs/adr/0006-git-worktree-mounts-on-windows.md)).

### `claudeCode(model, options?)`

```typescript
claudeCode("claude-opus-4-7", {
  env: { ANTHROPIC_API_KEY: "sk-ant-..." },   // optional; merged per ADR-0012
  captureSessions: true,                       // optional; default true. Set false to skip session capture
})
```

`captureSessions` controls whether each iteration's **agent session** JSONL is captured from the sandbox to the host (`~/.claude/projects/<encoded-cwd>/sessions/<id>.jsonl`, with `cwd` rewritten so `claude --resume` works natively). Capture is best-effort — failure logs a warning and the run still resolves successfully. The `effort` option shown in the brief doesn't exist yet.

### `interactive(options)` and `wt.interactive(options)`

`interactive()` launches the **agent**'s interactive UI (e.g. Claude Code's TUI) and resolves when the user exits. It accepts all three sandbox provider kinds — **bind-mount**, **isolated**, and **no-sandbox** — and always uses the provider's default **branch strategy**. There is no `branchStrategy` option on top-level `interactive()`; for a non-default strategy with a TUI, route through `createWorktree() + wt.interactive()` (per [ADR-0009](docs/adr/0009-branch-strategy-per-call.md)).

```typescript
import { createWorktree, interactive, claudeCode } from "@missingstudio/sanddune";
import { docker } from "@missingstudio/sanddune/sandboxes/docker";
import { noSandbox } from "@missingstudio/sanddune/sandboxes/no-sandbox";

// TUI inside Docker — same flow as run(), but you drive it.
await interactive({
  agent: claudeCode("claude-opus-4-7"),
  sandbox: docker(),
  prompt: "Help me refactor the prompt pipeline.",  // optional seed prompt
});

// TUI directly on the host — no container, agent's permission prompts stay on.
await interactive({
  agent: claudeCode("claude-opus-4-7"),
  sandbox: noSandbox(),
  cwd: "../other-repo",   // optional; relative paths resolve against process.cwd()
});

// TUI on a worktree branch (non-default strategy needs the wt.* path).
await using wt = await createWorktree({
  branchStrategy: { type: "branch", branch: "agent/explore" },
});
await wt.interactive({ agent: claudeCode("claude-opus-4-7") });
// `sandbox` defaults to noSandbox() on wt.interactive(); pass docker() etc. to override.
```

| Option            | Type                            | Behavior                                                            |
| ----------------- | ------------------------------- | ------------------------------------------------------------------- |
| `agent`           | `AgentProvider`                 | **Required.** Must declare `buildInteractiveCommand` (claudeCode does) |
| `sandbox`         | `SandboxProvider`               | **Required** on `interactive()`; defaults to `noSandbox()` on `wt.interactive()` |
| `prompt`          | `string`                        | Optional seed prompt; passed as a positional arg to the agent       |
| `promptFile`      | `string`                        | Optional template file; `{{KEY}}` substitution + shell expressions  |
| `promptArgs`      | `Record<string, string\|number>`  | Values for `{{KEY}}` placeholders; only valid with `promptFile`     |
| `cwd`             | `string`                        | Host repo dir; relative paths resolve from `process.cwd()`          |
| `env`             | `Record<string, string>`        | Call-site env override (per ADR-0012)                               |
| `hooks`           | `SandboxHooks`                  | Same shape as `run()`; sandbox-side hooks are skipped under `noSandbox()` |
| `signal`          | `AbortSignal`                   | Abort cancels the launch handshake; once the TUI is live, exit semantics depend on the underlying agent process |
| `copyToWorktree`  | `string[]`                      | Copies host items into the worktree before hooks fire (rejected with branch strategy `head`) |

`maxIterations`, `completionSignal`, `idleTimeoutSeconds`, and `logging` are **not** part of `InteractiveOptions` — interactive sessions are user-driven, not iteration-bounded.

#### `noSandbox()` and the `--dangerously-skip-permissions` policy

Under bind-mount and isolated providers, sanddune passes `--dangerously-skip-permissions` to Claude Code so the agent can act freely inside the container. Under `noSandbox()`, the agent runs directly on the host and the flag is **not** passed — Claude Code's normal permission prompts stay active. This is enforced via the agent provider's `buildInteractiveCommand({ skipPermissions })` callback; the orchestrator decides `skipPermissions` based on the sandbox kind.

`noSandbox()` is accepted only by `interactive()` / `wt.interactive()`. The type system rejects it for `run()` and `createSandbox()` — AFK runs require a real sandbox.

### Custom bind-mount providers

If you want to wrap something other than Docker (a different container runtime, an SSH host, a local subprocess), construct a `BindMountSandboxProvider` directly. `BindMountSandboxProvider` is one arm of the `SandboxProvider` discriminated union — call sites accept any `SandboxProvider`, but constructing one means picking a specific kind and supplying its contract (here: `create()`):

```typescript
import type {
  BindMountCreateOptions,
  BindMountSandboxHandle,
  BindMountSandboxProvider,
} from "@missingstudio/sanddune";

const myProvider = (): BindMountSandboxProvider => ({
  kind: "bind-mount",
  name: "my-provider",
  create: async (opts: BindMountCreateOptions): Promise<BindMountSandboxHandle> => {
    // opts.worktreePath  — host path to mount into your sandbox
    // opts.hostRepoPath  — caller's `cwd`, e.g. for default image-name derivation
    // opts.env           — resolved env vars to inject

    return {
      worktreePath: "/workspace",                // sandbox-side path
      exec: async (command, execOpts) => ({
        stdout: "...",
        stderr: "...",
        exitCode: 0,
      }),
      close: async () => { /* tear down */ },
    };
  },
});
```

Reference implementation: [`packages/sanddune/src/sandboxes/docker.ts`](packages/sanddune/src/sandboxes/docker.ts).

The isolated-provider factory is declared in the type system but not yet usable from `run()`.

### Errors

All errors are exported from `@missingstudio/sanddune`. They carry a stable `_tag` discriminant for matching alongside `instanceof`.

| Error                        | Thrown when                                                                                                                      | Extra fields                                |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| `AgentIdleTimeoutError`      | The agent produces no stream event for `idleTimeoutSeconds`. Synthesized as the abort reason; surfaces from `run()` / `Sandbox.run()` / `Worktree.run()` (ADR-0011) | `idleTimeoutSeconds`, `iteration`          |
| `HookTimeoutError`           | A lifecycle hook exceeds its `timeoutMs` (default `60_000`)                                                                      | `command`, `timeoutMs`                      |
| `CopyToWorktreeTimeoutError` | A `copyToWorktree` entry exceeds `timeouts.copyToWorktreeMs` (default `60_000`)                                                  | `currentItem`, `timeoutMs`                  |
| `NotImplementedError`        | A surface declared in the type system has no implementation yet — e.g. `podman()`, `vercel()`, `Sandbox.interactive()`           | —                                           |

Lifecycle failures that don't have a dedicated error class (a hook exiting non-zero, a missing prompt arg, an `agent.env ∩ sandbox.env` overlap, etc.) are thrown as plain `Error` with a descriptive message.

## Run log

Every `run()` in **log-to-file mode** (the default) streams JSONL events to `.sanddune/logs/<run-id>.jsonl` (or the path supplied via `logging.path`) and prints a `tail -f` hint at start. Pass `logging: { type: "stdout" }` to switch to **terminal mode** — sanddune then renders the run inline (spinners + status lines + summary) and `RunResult.logFilePath` is `undefined`. Follow the file from another terminal:

```bash
tail -f .sanddune/logs/*.jsonl
```

## Trying it in this repo

[`./.sanddune/`](./.sanddune/) contains three runnable demos, one per branch strategy. After `bun install && bun run build`, build the image and run any of:

```bash
bun .sanddune/docker-head-claude-code.ts
bun .sanddune/docker-merge-to-head-claude-code.ts
bun .sanddune/docker-branch-claude-code.ts
```

See [.sanddune/README.md](./.sanddune/README.md) for the full walkthrough.

## Design docs

- [`CONTEXT.md`](./CONTEXT.md) — domain language and relationships
- [`docs/adr/`](./docs/adr/) — architecture decision records

## Development

```bash
bun install
bun run build      # tsc -p tsconfig.build.json + bun build, orchestrated by turbo
bun test           # bun test
bun run typecheck  # tsgo --noEmit
```

## Acknowledgments

sanddune is heavily inspired by [**sandcastle**](https://github.com/mattpocock/sandcastle) by [Matt Pocock](https://github.com/mattpocock). If you're evaluating agent orchestration libraries, go check out the original.

## License

MIT
