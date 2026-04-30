# sanddune

A TypeScript library for orchestrating AI coding agents in isolated sandboxes.

You write a prompt, call `sanddune.run()`, and get a commit on a branch. The agent runs in a throwaway environment — Docker, Podman, Vercel Firecracker microVMs, or your own provider — and your working tree stays clean.

**Use it for:**

- Parallelizing AFK agents across many issues at once
- Building review pipelines: implement → review → revise on isolated branches
- Wrapping agents in your own CI, cron, or dashboard tooling
- Running untrusted prompts without trashing your working tree

sanddune is provider-agnostic. Built-in sandbox providers cover Docker, Podman, and Vercel; built-in agent providers cover Claude Code, Codex, opencode, and pi. Custom providers are a single interface.

## Prerequisites

- [Git](https://git-scm.com/)
- A sandbox provider:
  - [Docker Desktop](https://www.docker.com/) — most common for local development
  - [Podman](https://podman.io/) — rootless alternative to Docker
  - [Vercel](https://vercel.com/) — cloud Firecracker microVMs via `@vercel/sandbox`
  - Or your own (see [Custom sandbox providers](#custom-sandbox-providers))

## Quick start

```bash
npm install --save-dev @missingstudio/sanddune
npx sanddune init                              # scaffold .sanddune/, build image
cp .sanddune/.env.example .sanddune/.env       # fill in ANTHROPIC_API_KEY
npx tsx .sanddune/main.ts                      # run
```

`.sanddune/main.ts`:

```typescript
import { run, claudeCode } from "@missingstudio/sanddune";
import { docker } from "@missingstudio/sanddune/sandboxes/docker";

await run({
  agent: claudeCode("claude-opus-4-7"),
  sandbox: docker(), // or podman(), vercel(), or your own provider
  promptFile: ".sanddune/prompt.md",
});
```

The agent runs in Docker, commits to your repo, and the container is destroyed when done.

## How it works

A run goes through three phases:

1. **Setup** — create a worktree (or write directly to HEAD), bind-mount or copy it into a sandbox, run setup hooks.
2. **Agent loop** — invoke the agent provider with your prompt, stream its output, repeat up to `maxIterations` or until a completion signal fires.
3. **Teardown** — capture commits and session state to the host, tear down the sandbox.

Two axes shape every run:

### Sandbox type

| Type           | How code moves                                       | Examples                |
| -------------- | ---------------------------------------------------- | ----------------------- |
| **Bind-mount** | Host directory mounted into the sandbox — no sync    | `docker()`, `podman()`  |
| **Isolated**   | Sandbox has its own filesystem; sanddune syncs in/out | `vercel()`, custom VMs  |

### Branch strategy

Controls where the agent's commits land. Configured per-run via `branchStrategy`:

| Strategy        | Behavior                                                           | Bind-mount | Isolated  |
| --------------- | ------------------------------------------------------------------ | ---------- | --------- |
| `head`          | Agent writes directly to host working tree. No worktree, no merge. | Default    | N/A       |
| `merge-to-head` | Temp branch in a worktree, merged back to HEAD when done.          | Supported  | Default   |
| `branch`        | Commits land on an explicit named branch (e.g. for a PR).          | Supported  | Supported |

```typescript
await run({
  agent: claudeCode("claude-opus-4-7"),
  sandbox: docker(),
  prompt: "Fix issue #42",
});
```

**When to use which:**

- **`head`** — fast iteration during development. No indirection, no merge step.
- **`merge-to-head`** — safe default for automation. Throwaway branch; HEAD untouched on failure.
- **`branch`** — when you want commits on a specific branch, e.g. for a PR.

Bind-mount + `head` is the fastest path. Isolated providers can never use `head` — they have no host filesystem to write to.

## Sandbox providers

The `sandbox` option on `run()`, `createSandbox()`, `wt.run()`, and `wt.createSandbox()` accepts any provider.

| Provider      | Import path                                       | Type       | Used by                                                |
| ------------- | ------------------------------------------------- | ---------- | ------------------------------------------------------ |
| Docker        | `@missingstudio/sanddune/sandboxes/docker`        | Bind-mount | `run()`, `createSandbox()`, `wt.*`, `interactive()`    |
| Podman        | `@missingstudio/sanddune/sandboxes/podman`        | Bind-mount | `run()`, `createSandbox()`, `wt.*`, `interactive()`    |
| Vercel        | `@missingstudio/sanddune/sandboxes/vercel`        | Isolated   | `run()`, `createSandbox()`, `wt.*`, `interactive()`    |
| No-sandbox    | `@missingstudio/sanddune/sandboxes/no-sandbox`    | None       | `interactive()`, `wt.interactive()` (default)          |

```typescript
import { docker } from "@missingstudio/sanddune/sandboxes/docker";
import { podman } from "@missingstudio/sanddune/sandboxes/podman";
import { vercel } from "@missingstudio/sanddune/sandboxes/vercel";
import { noSandbox } from "@missingstudio/sanddune/sandboxes/no-sandbox";
```

`noSandbox()` runs the agent directly on the host — accepted only by `interactive()` and `wt.interactive()`. AFK runs (`run()`, `wt.run()`) require a real sandbox.

## API

sanddune exposes four programmatic entry points:

| Function           | Purpose                                                              |
| ------------------ | -------------------------------------------------------------------- |
| `run()`            | One-shot: spin up sandbox, run agent, tear down. Most common.        |
| `createSandbox()`  | Reusable sandbox — call `sandbox.run()` multiple times on one branch.|
| `createWorktree()` | Worktree as an independent lifecycle, separate from any sandbox.     |
| `interactive()`    | Launch an interactive agent session (TUI). Sync, not AFK.            |

### `run()` — one-shot

```typescript
import { run, claudeCode } from "@missingstudio/sanddune";
import { docker } from "@missingstudio/sanddune/sandboxes/docker";

const result = await run({
  agent: claudeCode("claude-opus-4-7"),
  sandbox: docker(),
  promptFile: ".sanddune/prompt.md",
});

console.log(result.iterations.length); // iterations executed
console.log(result.commits);           // [{ sha }]
console.log(result.branch);            // target branch
```

See [`RunOptions`](#runoptions) and [`RunResult`](#runresult) for the full surface.

### `createSandbox()` — reusable sandbox

Use when you need to run multiple agents (or multiple rounds of one agent) inside the same sandbox. Avoids repeated container startup; keeps all runs on one branch.

```typescript
import { createSandbox, claudeCode } from "@missingstudio/sanddune";
import { docker } from "@missingstudio/sanddune/sandboxes/docker";

await using sandbox = await createSandbox({
  branch: "agent/fix-42",
  sandbox: docker(),
  hooks: { sandbox: { onSandboxReady: [{ command: "npm install" }] } },
});

// Step 1: implement
await sandbox.run({
  agent: claudeCode("claude-opus-4-7"),
  promptFile: ".sanddune/implement.md",
  maxIterations: 5,
});

// Step 2: review on the same branch, same container
await sandbox.run({
  agent: claudeCode("claude-sonnet-4-6"),
  prompt: "Review the changes and fix any issues.",
});
```

Commits from all `run()` calls accumulate on the same branch. Installed dependencies and build artifacts persist between calls.

**`await using`** calls `sandbox.close()` automatically when the block exits. If the sandbox has uncommitted changes, the worktree is preserved on disk; if clean, both container and worktree are removed.

For manual control:

```typescript
const sandbox = await createSandbox({ branch: "agent/fix-42", sandbox: docker() });
// ...
const result = await sandbox.close();
if (result.preservedWorktreePath) {
  console.log(`Worktree preserved at ${result.preservedWorktreePath}`);
}
```

See [`CreateSandboxOptions`](#createsandboxoptions), [`SandboxRunOptions`](#sandboxrunoptions), [`Sandbox`](#sandbox), and [`CloseResult`](#closeresult).

### `createWorktree()` — independent worktree lifecycle

Use when you need a worktree as a first-class concept, separate from any sandbox. Useful when you want to run an interactive session first and then hand the same worktree to a sandboxed AFK agent.

Only `branch` and `merge-to-head` strategies are accepted. `head` is a compile-time error since it implies no worktree.

```typescript
import { createWorktree, claudeCode } from "@missingstudio/sanddune";
import { docker } from "@missingstudio/sanddune/sandboxes/docker";

await using wt = await createWorktree({
  branchStrategy: { type: "branch", branch: "agent/fix-42" },
  copyToWorktree: ["node_modules"],
});

// Interactive exploration first (defaults to noSandbox)
await wt.interactive({
  agent: claudeCode("claude-opus-4-7"),
  prompt: "Explore the codebase and understand the bug.",
});

// Then hand the same worktree to an AFK agent (sandbox required)
const result = await wt.run({
  agent: claudeCode("claude-opus-4-7"),
  sandbox: docker(),
  prompt: "Fix issue #42.",
  maxIterations: 3,
});

// Or create a long-lived sandbox from the worktree
await using sandbox = await wt.createSandbox({
  sandbox: docker(),
  hooks: { sandbox: { onSandboxReady: [{ command: "npm install" }] } },
});
```

`wt.close()` checks for uncommitted changes: dirty → preserved on disk; clean → removed.

**Split ownership:** when a sandbox is created via `wt.createSandbox()`, `sandbox.close()` tears down the container only — the worktree stays. `wt.close()` owns worktree cleanup. This differs from top-level `createSandbox()`, where `sandbox.close()` owns both.

See [`CreateWorktreeOptions`](#createworktreeoptions), [`Worktree`](#worktree), [`WorktreeRunOptions`](#worktreerunoptions), and [`WorktreeInteractiveOptions`](#worktreeinteractiveoptions).

### `interactive()` — TUI session

Launch the agent's interactive UI (e.g. Claude Code TUI) inside a sandbox or directly on the host. Synchronous from your perspective — control returns when the user exits.

```typescript
import { interactive, claudeCode } from "@missingstudio/sanddune";
import { noSandbox } from "@missingstudio/sanddune/sandboxes/no-sandbox";

await interactive({
  agent: claudeCode("claude-opus-4-7"),
  sandbox: noSandbox(),                  // or docker(), podman(), vercel()
  prompt: "...",                          // optional — omit for empty TUI
  cwd: "/path/to/other-repo",             // optional — defaults to process.cwd()
});
```

`noSandbox()` is the only no-isolation option and is accepted only here and in `wt.interactive()`.

## Prompts

sanddune is unopinionated about workflow — you write the prompt, the engine executes it.

### Prompt resolution

Provide exactly one of:

- `prompt: "..."` — inline string, passed to the agent literally
- `promptFile: "./path.md"` — file path, with substitution and shell expansion

Inline prompts get **no** processing. No `{{KEY}}` substitution, no `` !`command` `` expansion, no built-in variables. If you need interpolation in an inline prompt, build the string yourself (`` `Work on ${branch}…` ``). Passing `promptArgs` alongside `prompt` is an error.

`sanddune init` scaffolds `.sanddune/prompt.md`. This is a convention — sanddune doesn't read it unless you pass `promptFile: ".sanddune/prompt.md"`.

### Dynamic context with `` !`command` ``

`` !`command` `` expressions in `promptFile` are replaced with stdout before the prompt reaches the agent. All expressions in a prompt run in **parallel**.

Commands run **inside the sandbox** after `sandbox.onSandboxReady` hooks complete, so they see the same repo state the agent sees.

```markdown
# Open issues

!`gh issue list --state open --label sanddune --json number,title,body --limit 20`

# Recent commits

!`git log --oneline -10`
```

Non-zero exit → run fails immediately.

### Prompt arguments with `{{KEY}}`

Inject values from the `promptArgs` option:

```typescript
await run({
  promptFile: "./my-prompt.md",
  promptArgs: { ISSUE_NUMBER: "42", PRIORITY: "high" },
});
```

```markdown
Work on issue #{{ISSUE_NUMBER}} (priority: {{PRIORITY}}).
```

Substitution runs on the host **before** `` !`command` `` expansion, so placeholders inside shell expressions are resolved first:

```markdown
!`gh issue view {{ISSUE_NUMBER}} --json body -q .body`
```

- Missing key → error.
- Unused key → warning.
- `` !`…` `` patterns inside `promptArgs` *values* are inert text — not executed. Safe to pass user-authored content (issue titles, PR descriptions).

### Built-in prompt arguments

Two are injected automatically into every prompt:

| Placeholder         | Value                                                |
| ------------------- | ---------------------------------------------------- |
| `{{SOURCE_BRANCH}}` | Branch the agent works on (per the branch strategy) |
| `{{TARGET_BRANCH}}` | Host's active branch at `run()` time                |

Passing either via `promptArgs` is an error.

### Early termination with `completionSignal`

When the agent emits a known string, sanddune stops the iteration loop early. This is a **convention you write into your prompt** — sanddune never injects it for you.

The default signal is `<promise>COMPLETE</promise>`. Override via `completionSignal`:

```typescript
// Single signal
await run({
  // ...
  completionSignal: "DONE",
});

// Multiple signals — first match wins
await run({
  // ...
  completionSignal: ["TASK_COMPLETE", "TASK_ABORTED"],
});
```

The matched signal is returned as `result.completionSignal` (or `undefined` if `maxIterations` was reached without a match).

**Pattern:** instruct the agent in your prompt to emit one of the signals when it's done. For task-based workflows where the agent should stop as soon as it finishes, this avoids burning iterations.

```markdown
When you have completed the task, output `<promise>COMPLETE</promise>`.
If you cannot complete it, output `<promise>BLOCKED</promise>` with a reason.
```

```typescript
const result = await run({
  // ...
  completionSignal: ["<promise>COMPLETE</promise>", "<promise>BLOCKED</promise>"],
  maxIterations: 5,
});

if (result.completionSignal === "<promise>BLOCKED</promise>") {
  // handle blocked case
}
```

Detection is substring-based against the agent's output stream, so unique sentinel-style strings are safer than common words.

### Templates

`sanddune init` lets you pick a sandbox provider, a backlog manager (GitHub Issues or Beads), and a template. The template scaffolds `prompt.md` and `main.mts` (or `main.ts` if `package.json` has `"type": "module"`).

| Template                       | Description                                                              |
| ------------------------------ | ------------------------------------------------------------------------ |
| `blank`                        | Bare scaffold — write your own prompt and orchestration                 |
| `simple-loop`                  | Picks GitHub issues one by one and closes them                          |
| `sequential-reviewer`          | Implements issues one by one, with a code-review step after each        |
| `parallel-planner`             | Plans parallelizable issues, executes on separate branches, then merges |
| `parallel-planner-with-review` | Same, with per-branch review before merge                               |

## Configuration

### Config directory

All per-repo sandbox config lives in `.sanddune/`:

```
.sanddune/
├── Dockerfile      # Sandbox environment (customize as needed)
├── prompt.md       # Agent instructions
├── .env.example    # Token placeholders
└── .gitignore      # Ignores .env, logs/
```

`sanddune init` creates this and errors if it already exists, to prevent overwriting customizations.

### Custom Dockerfile

The default `.sanddune/Dockerfile` installs Node.js 22, `git`, `curl`, `jq`, GitHub CLI, Claude Code CLI, and a non-root `agent` user.

When customizing, **keep:**

- A non-root user (Claude refuses to run as root)
- `git` (commits and branch ops)
- `gh` (issue fetching)
- Claude Code CLI on PATH

Add language runtimes, build tools, etc. as needed.

### Environment variables

Both **agent providers** and **sandbox providers** accept an optional `env: Record<string, string>`. These merge with `.sanddune/.env` and `process.env` at launch:

```typescript
await run({
  agent: claudeCode("claude-opus-4-7", {
    env: { ANTHROPIC_API_KEY: "sk-ant-..." },
  }),
  sandbox: docker({
    env: { DOCKER_SPECIFIC_VAR: "value" },
  }),
  prompt: "Fix issue #42",
});
```

**Merge rules:**

- Provider env (agent + sandbox) overrides `.sanddune/.env` for shared keys.
- Agent provider env and sandbox provider env **must not overlap** — shared key throws.
- Default for `env` is `{}`.

You don't need to pass anything — `.sanddune/.env` and `process.env` are resolved automatically. Required variables depend on the agent provider (see `sanddune init` output).

### Hooks

Hooks are grouped by **where** they run — `host` (developer's machine) or `sandbox` (inside the container):

```typescript
hooks: {
  host: {
    onWorktreeReady: [{ command: "cp .env.example .env" }],
    onSandboxReady:  [{ command: "echo sandbox is up" }],
  },
  sandbox: {
    onSandboxReady: [
      { command: "npm install", timeoutMs: 300_000 },
      { command: "apt-get install -y ffmpeg", sudo: true },
    ],
  },
}
```

| Hook                     | Runs on | When                                         | Working directory                        |
| ------------------------ | ------- | -------------------------------------------- | ---------------------------------------- |
| `host.onWorktreeReady`   | Host    | After `copyToWorktree`, before sandbox start | Worktree (host repo root under `head`)   |
| `host.onSandboxReady`    | Host    | After sandbox is up                          | Worktree (host repo root under `head`)   |
| `sandbox.onSandboxReady` | Sandbox | After sandbox is up                          | Sandbox repo directory                   |

**Ordering:** `copyToWorktree` → `host.onWorktreeReady` (sequential) → sandbox created → `host.onSandboxReady` ∥ `sandbox.onSandboxReady` (parallel).

- **Host hooks:** `{ command: string; timeoutMs?: number }`. No `sudo`, no `cwd` — use `cd` or inline env in the command.
- **Sandbox hooks:** `{ command: string; sudo?: boolean; timeoutMs?: number }`.
- `timeoutMs` defaults to 60s. Long installs (e.g. `npm install`) typically need `300_000`.
- Non-zero exit → setup fails fast.
- A `signal` passed to `run()` is threaded to all hooks; aborting cancels in-flight commands.

## CLI commands

### `sanddune init`

Scaffolds `.sanddune/` and builds the container image. First command in a new repo. Picking Podman writes a `Containerfile` instead of `Dockerfile` and uses `sanddune podman build-image`.

| Option         | Default                       | Description                                                  |
| -------------- | ----------------------------- | ------------------------------------------------------------ |
| `--image-name` | `sanddune:<repo-dir-name>`    | Image name                                                   |
| `--agent`      | Interactive prompt            | Agent (`claude-code`, `pi`, `codex`, `opencode`)             |
| `--model`      | Agent's default               | Model (e.g. `claude-sonnet-4-6`)                             |
| `--template`   | Interactive prompt            | Template (e.g. `blank`, `simple-loop`)                       |

### `sanddune docker build-image` / `sanddune podman build-image`

Rebuilds the image from an existing `.sanddune/`. Run after editing the Dockerfile / Containerfile.

| Option            | Default                       | Description                                                |
| ----------------- | ----------------------------- | ---------------------------------------------------------- |
| `--image-name`    | `sanddune:<repo-dir-name>`    | Image name                                                 |
| `--dockerfile`    | —                             | Custom Dockerfile (Docker only; build context = cwd)       |
| `--containerfile` | —                             | Custom Containerfile (Podman only; build context = cwd)    |

### `sanddune docker remove-image` / `sanddune podman remove-image`

Removes the image.

| Option         | Default                    | Description |
| -------------- | -------------------------- | ----------- |
| `--image-name` | `sanddune:<repo-dir-name>` | Image name  |

## Session capture and resume

After each Claude Code iteration, sanddune captures the session JSONL from the sandbox to the host at `~/.claude/projects/<encoded-path>/sessions/<session-id>.jsonl`. The `cwd` fields inside each entry are rewritten to match the host repo root, so `claude --resume` works natively.

- Enabled by default for `claudeCode()`. Opt out via `captureSessions: false`.
- Non-Claude providers never capture.
- Capture failure fails the run.

To continue a prior session in a new sandbox:

```typescript
await run({
  agent: claudeCode("claude-opus-4-7"),
  sandbox: docker(),
  prompt: "Continue where you left off",
  resumeSession: "abc-123-def",
});
```

Before the sandbox starts, sanddune validates the session file exists and transfers it in with `cwd` fields rewritten to the sandbox-side path. Iteration 1 receives `--resume <id>`.

**Constraints:**

- Incompatible with `maxIterations > 1` — throws before sandbox creation.
- Session file must exist at `~/.claude/projects/<encoded-path>/sessions/<id>.jsonl`.
- Only iteration 1 receives the resume flag; subsequent iterations start fresh.
- Non-Claude providers ignore `resumeSession`.

## Custom sandbox providers

A sandbox provider tells sanddune how to execute commands in an isolated environment. Two flavors:

- **Bind-mount** — the sandbox can mount a host directory. sanddune creates a worktree on the host and the provider mounts it. No file sync. Use for Docker, Podman, any local container runtime.
- **Isolated** — the sandbox has its own filesystem (e.g. cloud VM). The provider handles sync via `copyIn` and `copyFileOut`. Use when the sandbox cannot access the host filesystem.

### The sandbox handle contract

Both provider types return a **sandbox handle** from their `create()` function:

| Method         | Required   | Description                                                                  |
| -------------- | ---------- | ---------------------------------------------------------------------------- |
| `exec`         | Both       | Run a command, optionally streaming stdout line-by-line via `options.onLine` |
| `close`        | Both       | Tear down the sandbox                                                        |
| `worktreePath` | Both       | Absolute path to the repo directory inside the sandbox                       |
| `copyFileIn`   | Bind-mount | Copy a single file from host into sandbox                                    |
| `copyFileOut`  | Both       | Copy a single file from sandbox to host                                      |
| `copyIn`       | Isolated   | Copy a file or directory from host into sandbox                              |

Every `exec` returns:

```typescript
interface ExecResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}
```

### Bind-mount provider example

A minimal provider that shells out to local processes (no container):

```typescript
import {
  createBindMountSandboxProvider,
  type BindMountCreateOptions,
  type BindMountSandboxHandle,
  type ExecResult,
} from "@missingstudio/sanddune";
import { execFile, spawn } from "node:child_process";
import { copyFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { createInterface } from "node:readline";

const localProcess = () =>
  createBindMountSandboxProvider({
    name: "local-process",
    create: async (options: BindMountCreateOptions): Promise<BindMountSandboxHandle> => {
      const worktreePath = options.worktreePath;

      return {
        worktreePath,

        exec: (command, opts) => {
          if (opts?.onLine) {
            const onLine = opts.onLine;
            return new Promise<ExecResult>((resolve, reject) => {
              const proc = spawn("sh", ["-c", command], {
                cwd: opts?.cwd ?? worktreePath,
                stdio: ["ignore", "pipe", "pipe"],
              });
              const stdoutChunks: string[] = [];
              const stderrChunks: string[] = [];
              const rl = createInterface({ input: proc.stdout! });
              rl.on("line", (line) => {
                stdoutChunks.push(line);
                onLine(line);
              });
              proc.stderr!.on("data", (c: Buffer) => stderrChunks.push(c.toString()));
              proc.on("error", reject);
              proc.on("close", (code) =>
                resolve({
                  stdout: stdoutChunks.join("\n"),
                  stderr: stderrChunks.join(""),
                  exitCode: code ?? 0,
                }),
              );
            });
          }

          return new Promise<ExecResult>((resolve, reject) => {
            execFile(
              "sh",
              ["-c", command],
              { cwd: opts?.cwd ?? worktreePath, maxBuffer: 10 * 1024 * 1024 },
              (error, stdout, stderr) => {
                if (error && error.code === undefined) reject(error);
                else
                  resolve({
                    stdout: stdout.toString(),
                    stderr: stderr.toString(),
                    exitCode: typeof error?.code === "number" ? error.code : 0,
                  });
              },
            );
          });
        },

        copyFileIn: async (hostPath, sandboxPath) => {
          await mkdir(dirname(sandboxPath), { recursive: true });
          await copyFile(hostPath, sandboxPath);
        },
        copyFileOut: async (sandboxPath, hostPath) => {
          await mkdir(dirname(hostPath), { recursive: true });
          await copyFile(sandboxPath, hostPath);
        },
        close: async () => {},
      };
    },
  });
```

Pass it to `run()` like any built-in provider:

```typescript
await run({
  agent: claudeCode("claude-opus-4-7"),
  sandbox: localProcess(),
  prompt: "Fix issue #42 in this repo.",
});
```

Isolated providers follow the same shape using `createIsolatedSandboxProvider` and `IsolatedSandboxHandle`. The only difference: replace `copyFileIn` with `copyIn` (which handles directories too).

### Reference implementations

- [`src/sandboxes/docker.ts`](src/sandboxes/docker.ts) — bind-mount, Docker
- [`src/sandboxes/podman.ts`](src/sandboxes/podman.ts) — bind-mount, Podman (with SELinux label support)
- [`src/sandboxes/vercel.ts`](src/sandboxes/vercel.ts) — isolated, Vercel Firecracker microVMs
- [`src/sandboxes/test-isolated.ts`](src/sandboxes/test-isolated.ts) — isolated, temp directories (used in tests)

## Reference

### `RunOptions`

| Option               | Type               | Default                       | Description                                                                                                                            |
| -------------------- | ------------------ | ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `agent`              | AgentProvider      | —                             | **Required.** e.g. `claudeCode("claude-opus-4-7")`, `codex("gpt-5-mini")`, `opencode("opencode/big-pickle")`                           |
| `sandbox`            | SandboxProvider    | —                             | **Required.** e.g. `docker()`, `podman()`, `vercel()`, or custom                                                                       |
| `cwd`                | string             | `process.cwd()`               | Host repo directory — anchor for `.sanddune/` artifacts and git ops. Relative paths resolve against `process.cwd()`.                   |
| `prompt`             | string             | —                             | Inline prompt (mutually exclusive with `promptFile`)                                                                                   |
| `promptFile`         | string             | —                             | Prompt file path (mutually exclusive with `prompt`). Resolves against `process.cwd()`, **not** `cwd`.                                  |
| `promptArgs`         | PromptArgs         | —                             | Map for `{{KEY}}` substitution. Error if used with `prompt`.                                                                           |
| `branchStrategy`     | BranchStrategy     | per-provider default          | `{ type: "head" }`, `{ type: "merge-to-head" }`, or `{ type: "branch", branch }`                                                       |
| `copyToWorktree`     | string[]           | —                             | Host-relative paths copied into the sandbox before start. Not supported with `branchStrategy: { type: "head" }`.                       |
| `maxIterations`      | number             | `1`                           | Max agent iterations                                                                                                                   |
| `completionSignal`   | string \| string[] | `<promise>COMPLETE</promise>` | String(s) the agent emits to stop the loop early. First match wins. Substring match against the output stream.                         |
| `idleTimeoutSeconds` | number             | `600`                         | Idle timeout in seconds — resets on each agent output event                                                                            |
| `name`               | string             | —                             | Display name for the run, prefixed in log output                                                                                       |
| `hooks`              | SandboxHooks       | —                             | Lifecycle hooks (`host.*`, `sandbox.*`)                                                                                                |
| `logging`            | LoggingOption      | file (auto-generated)         | `{ type: "file", path }`, `{ type: "stdout" }`, with optional `onAgentStreamEvent` callback                                            |
| `resumeSession`      | string             | —                             | Resume a Claude Code session by ID. Incompatible with `maxIterations > 1`. Session file must exist on host.                            |
| `signal`             | AbortSignal        | —                             | Cancel the run. Kills agent subprocess and hooks; worktree preserved on disk; rejects with `signal.reason`.                            |
| `timeouts`           | Timeouts           | —                             | Override defaults for built-in lifecycle steps. Currently `{ copyToWorktreeMs?: number }` (default 60_000).                            |

`logging` example with stream forwarding:

```typescript
logging: {
  type: "file",
  path: ".sanddune/logs/my-run.log",
  onAgentStreamEvent: (event) => {
    // event = { type: "text" | "toolCall", iteration, timestamp, ... }
    myLogger.info(event); // errors are swallowed — a broken forwarder cannot kill the run
  },
}
```

### `RunResult`

| Field              | Type                | Description                                                        |
| ------------------ | ------------------- | ------------------------------------------------------------------ |
| `iterations`       | `IterationResult[]` | Per-iteration results (use `.length` for the count)                |
| `completionSignal` | string?             | The matched completion signal string, or `undefined` if none fired |
| `stdout`           | string              | Combined agent output                                              |
| `commits`          | `{ sha }[]`         | Commits created during the run                                     |
| `branch`           | string              | Target branch name                                                 |
| `logFilePath`      | string?             | Path to the log file (only when logging to a file)                 |

### `IterationResult`

| Field             | Type              | Description                                                                                                                         |
| ----------------- | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `sessionId`       | string?           | Claude Code session ID from the init line; `undefined` for non-Claude agents                                                        |
| `sessionFilePath` | string?           | Absolute host path to the captured session JSONL; `undefined` when capture is off                                                   |
| `usage`           | `IterationUsage`? | Token usage from the last assistant message; `undefined` when capture is off or the provider does not parse usage                   |

### `IterationUsage`

| Field                      | Type   | Description                                |
| -------------------------- | ------ | ------------------------------------------ |
| `inputTokens`              | number | Input tokens consumed                      |
| `cacheCreationInputTokens` | number | Tokens used to create prompt cache entries |
| `cacheReadInputTokens`     | number | Tokens read from prompt cache              |
| `outputTokens`             | number | Output tokens generated                    |

### `CreateSandboxOptions`

| Option           | Type            | Default         | Description                                                          |
| ---------------- | --------------- | --------------- | -------------------------------------------------------------------- |
| `branch`         | string          | —               | **Required.** Explicit branch for the sandbox                        |
| `sandbox`        | SandboxProvider | —               | **Required.** Sandbox provider                                       |
| `cwd`            | string          | `process.cwd()` | Host repo directory — relative paths resolve against `process.cwd()` |
| `hooks`          | SandboxHooks    | —               | Lifecycle hooks — run once at creation time                          |
| `copyToWorktree` | string[]        | —               | Host-relative paths copied into the sandbox at creation time         |
| `timeouts`       | Timeouts        | —               | Override default timeouts                                            |

### `Sandbox`

| Property / Method       | Type                                                               | Description                                  |
| ----------------------- | ------------------------------------------------------------------ | -------------------------------------------- |
| `branch`                | string                                                             | The branch the sandbox is on                 |
| `worktreePath`          | string                                                             | Host path to the worktree                    |
| `run(options)`          | `(SandboxRunOptions) => Promise<SandboxRunResult>`                 | Invoke an agent in the existing sandbox      |
| `interactive(options)`  | `(SandboxInteractiveOptions) => Promise<SandboxInteractiveResult>` | Launch an interactive session in the sandbox |
| `close()`               | `() => Promise<CloseResult>`                                       | Tear down the container and sandbox          |
| `[Symbol.asyncDispose]` | `() => Promise<void>`                                              | Auto teardown via `await using`              |

### `SandboxRunOptions`

`agent` is required. `sandbox`, `cwd`, `branchStrategy`, `copyToWorktree`, `hooks`, and `timeouts` are inherited from `createSandbox()` and **cannot be overridden** per-run. `resumeSession` is not accepted — Claude **agent session** resume is a fresh-sandbox concern and only available on top-level `run()`. All other fields (`prompt`, `promptFile`, `promptArgs`, `maxIterations`, `completionSignal`, `idleTimeoutSeconds`, `name`, `logging`, `signal`) behave exactly as in `RunOptions`.

### `SandboxRunResult`

Same shape as `RunResult`.

### `CloseResult`

| Field                   | Type    | Description                                                              |
| ----------------------- | ------- | ------------------------------------------------------------------------ |
| `preservedWorktreePath` | string? | Host path to the preserved worktree, set when it had uncommitted changes |

### `CreateWorktreeOptions`

| Option           | Type                   | Default         | Description                                                                |
| ---------------- | ---------------------- | --------------- | -------------------------------------------------------------------------- |
| `branchStrategy` | WorktreeBranchStrategy | —               | **Required.** `{ type: "branch", branch }` or `{ type: "merge-to-head" }`  |
| `cwd`            | string                 | `process.cwd()` | Host repo directory                                                        |
| `copyToWorktree` | string[]               | —               | Host-relative paths copied into the worktree at creation time              |
| `timeouts`       | Timeouts               | —               | Override default timeouts                                                  |

### `Worktree`

| Property / Method        | Type                                                                  | Description                                         |
| ------------------------ | --------------------------------------------------------------------- | --------------------------------------------------- |
| `branch`                 | string                                                                | The branch the worktree is on                       |
| `worktreePath`           | string                                                                | Host path to the worktree                           |
| `run(options)`           | `(WorktreeRunOptions) => Promise<WorktreeRunResult>`                  | Run an AFK agent in the worktree (sandbox required) |
| `interactive(options)`   | `(WorktreeInteractiveOptions) => Promise<InteractiveResult>`          | Run an interactive agent session in the worktree    |
| `createSandbox(options)` | `(WorktreeCreateSandboxOptions) => Promise<Sandbox>`                  | Create a long-lived sandbox backed by this worktree |
| `close()`                | `() => Promise<CloseResult>`                                          | Clean up the worktree (preserves if dirty)          |
| `[Symbol.asyncDispose]`  | `() => Promise<void>`                                                 | Auto cleanup via `await using`                      |

### `WorktreeRunOptions`

`RunOptions` minus `branchStrategy` and `cwd` (inherited from the worktree). `sandbox` is **required** (AFK agents must be sandboxed). Adds `env: Record<string, string>` for per-run env injection.

### `WorktreeInteractiveOptions`

`agent` (required), plus `sandbox` (defaults to `noSandbox()`), `prompt` / `promptFile`, `promptArgs`, `name`, `hooks`, `env`, `signal`. No `maxIterations` or `completionSignal` — interactive sessions are user-driven.

### `WorktreeCreateSandboxOptions`

| Option           | Type            | Default | Description                                                  |
| ---------------- | --------------- | ------- | ------------------------------------------------------------ |
| `sandbox`        | SandboxProvider | —       | **Required.**                                                |
| `hooks`          | SandboxHooks    | —       | Lifecycle hooks                                              |
| `copyToWorktree` | string[]        | —       | Host-relative paths copied into the worktree at creation     |
| `timeouts`       | Timeouts        | —       | Override default timeouts                                    |

### Provider options

#### `claudeCode(model, options?)`

| Option            | Type                                         | Default | Description                                               |
| ----------------- | -------------------------------------------- | ------- | --------------------------------------------------------- |
| `effort`          | `"low"` \| `"medium"` \| `"high"` \| `"max"` | —       | Reasoning effort (`max` is Opus only)                     |
| `env`             | `Record<string, string>`                     | `{}`    | Env vars injected by this agent provider                  |
| `captureSessions` | `boolean`                                    | `true`  | Capture session JSONL to host for `claude --resume`       |

#### `codex(model, options?)`

| Option   | Type                                           | Default | Description                                                 |
| -------- | ---------------------------------------------- | ------- | ----------------------------------------------------------- |
| `effort` | `"low"` \| `"medium"` \| `"high"` \| `"xhigh"` | —       | Reasoning effort via `model_reasoning_effort`               |
| `env`    | `Record<string, string>`                       | `{}`    | Env vars injected by this agent provider                    |

#### `docker(options?)` / `podman(options?)`

| Option      | Type                     | Default                    | Description                                                                                       |
| ----------- | ------------------------ | -------------------------- | ------------------------------------------------------------------------------------------------- |
| `imageName` | string                   | `sanddune:<repo-dir-name>` | Container image                                                                                   |
| `mounts`    | `Mount[]`                | —                          | Bind-mount host directories. `hostPath` supports absolute, `~`, and relative (resolved from cwd). |
| `env`       | `Record<string, string>` | `{}`                       | Provider-level env vars merged at launch                                                          |
| `network`   | `string \| string[]`     | —                          | Attach container to Docker network(s)                                                             |

```typescript
sandbox: docker({
  imageName: "sanddune:local",
  mounts: [
    { hostPath: "~/.npm", sandboxPath: "/home/agent/.npm", readonly: true },
    { hostPath: "data", sandboxPath: "data" },
  ],
  env: { DOCKER_SPECIFIC: "value" },
  network: "my-network",
}),
```

## Development

```bash
npm install
npm run build      # tsgo
npm test           # vitest
npm run typecheck  # type-check
```
