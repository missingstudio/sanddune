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
| JSONL run log                        | ✅ shipped | Streamed to `.sanddune/logs/<run-id>.jsonl`                                      |
| Custom bind-mount provider           | ✅ shipped | Build your own by constructing a `BindMountSandboxProvider` |

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

The iteration loop honors `maxIterations` (default `1`), `completionSignal` (default `<promise>COMPLETE</promise>`, substring-matched against the agent's text events; first match across iterations wins), `idleTimeoutSeconds` (default `600`; resets on every agent stream event — on expiry the agent subprocess is killed and the run rejects with `AgentIdleTimeoutError`), and `signal` (checked between iterations — mid-iteration kill of a caller-supplied signal is a follow-up). For **prompt templates**, **prompt expansion** evaluates `` !`shell expressions` `` once per iteration before the agent is invoked. **Agent session** capture is not yet wired.

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

| Option           | Type                            | Behavior                                                      |
| ---------------- | ------------------------------- | ------------------------------------------------------------- |
| `agent`          | `AgentProvider`                 | **Required.** Today: `claudeCode(model, { env? })`             |
| `sandbox`        | `BindMountSandboxProvider`      | **Required.** Today: `docker()` or your own bind-mount provider |
| `prompt`         | `string`                        | Inline prompt; passed to the agent verbatim (ADR-0008)         |
| `promptFile`     | `string`                        | Path to a prompt template file; relative paths resolve from `process.cwd()` |
| `cwd`            | `string`                        | Host repo dir; relative paths resolve from `process.cwd()`     |
| `branchStrategy` | `BranchStrategy`                | `head` (default) / `merge-to-head` / `branch`                  |
| `env`            | `Record<string, string>`        | Call-site env override; highest precedence (ADR-0012)          |

Exactly one of `prompt` / `promptFile` is required. On the template path, sanddune now performs host-side `{{KEY}}` substitution before the agent runs: every `{{KEY}}` placeholder is replaced with its value from `promptArgs`, plus the built-in arguments `{{SOURCE_BRANCH}}` and `{{TARGET_BRANCH}}` (resolved from the active branch strategy). Passing `SOURCE_BRANCH` or `TARGET_BRANCH` in `promptArgs` throws — built-ins cannot be overridden. A `{{KEY}}` with no matching arg throws naming the key; unused `promptArgs` keys log a warning. Inline `prompt` skips substitution entirely (per ADR-0008), and combining `prompt` with `promptArgs` throws. The `expandPrompt()` module that evaluates `` !`command` `` shell expressions in parallel against a sandbox-side `exec` is implemented and exported from `@missingstudio/sanddune`, but is not yet wired into `run()` — that ships with the hook-ordering slice.

#### Accepted by the type but not yet wired

`hooks`, `timeouts`, `logging`, `resumeSession`, `copyToWorktree`. Silently ignored. Don't depend on them.

### `RunResult`

```typescript
interface RunResult {
  branch: string;                  // result branch — host's active branch (head/merge-to-head) or named branch
  worktreePath?: string;           // set when the worktree was preserved on disk after a dirty close
  iterations: IterationResult[];   // one entry per iteration that ran
  commits: string[];               // SHAs reachable from worktree HEAD past the pre-run tip, ordered by iteration
  completionSignal?: string;       // the matched completion-signal string, if the loop terminated by signal
  stdout: string;                  // concatenated text events from the agent stream
  logFilePath: string;             // path to the JSONL run log
}

interface IterationResult {
  iteration: number;
  commitSha?: string;              // last commit produced on this iteration, if any
  sessionFilePath?: string;        // not set today (capture not implemented)
  usage?: IterationUsage;          // not set today
  completionSignal?: string;       // set on the iteration that matched the completion signal
}
```

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
})
```

Today's `ClaudeCodeOptions` is `{ env? }`. The `effort` and `captureSessions` options shown in the brief don't exist yet.

### Custom bind-mount providers

If you want to wrap something other than Docker (a different container runtime, an SSH host, a local subprocess), construct a `BindMountSandboxProvider` directly:

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

## Run log

Every run streams JSONL events to `.sanddune/logs/<run-id>.jsonl` and prints a `tail -f` hint at start. Today the log is the only output channel — `logging: { type: "stdout" }` is accepted by the type but ignored. Follow it from another terminal:

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
