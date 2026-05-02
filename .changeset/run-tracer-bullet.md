---
"@missingstudio/sanddune": patch
"@missingstudio/sanddune-core": patch
---

First end-to-end implementation of `run()`. `run({ agent: claudeCode(model), sandbox: docker(), prompt: "..." })` now spins up a Docker container with the host repo bind-mounted, runs Claude Code for one iteration on the host's working tree under the **head branch strategy**, captures any resulting commits, and tears the container down on success or failure.

This release fills in:

- **`docker()` bind-mount provider**, built on the new `createBindMountSandboxProvider` factory in `@missingstudio/sanddune-core`. Default image is `sanddune:<repo-dir-name>`; if the image is missing, `run()` rejects with an actionable error rather than rebuilding implicitly (image building lives in a later slice).
- **`claudeCode()` agent provider**: builds the per-iteration `claude --print --output-format stream-json --verbose` command and parses streamed JSONL into `text` / `toolCall` agent stream events. Exposed as a top-level export from `@missingstudio/sanddune`.
- **Production wiring for the `AgentInvoker` Effect `Context.Tag`** that shells out to the agent provider through the sandbox handle.
- **Env resolver**: `process.env` ∪ agent-provider `env` ∪ sandbox-provider `env`, passed verbatim into the container. Overlapping keys between agent and sandbox provider env throw at launch.
- **Log-to-file mode** writes a structured JSONL run log to `.sanddune/logs/<run-id>.jsonl` and prints a `tail -f` hint when the run starts.

Out of scope for this slice (each lands in a later one): the `merge-to-head` and `branch` strategies, `promptFile` / `{{KEY}}` substitution / shell expansion, lifecycle hooks, multi-iteration loops, completion-signal matching, idle / abort threading, terminal logging mode, `onAgentStreamEvent`, agent session capture, the Podman / Vercel / no-sandbox providers, and the CLI.

Public types extended in `@missingstudio/sanddune-core`:

- `BindMountSandboxProvider` now carries `name` and a `create(BindMountCreateOptions)` function.
- `BindMountSandboxHandle` now carries `worktreePath` and accepts `cwd` / `onLine` on `exec`.
- `AgentProvider` now declares `buildCommand` and `parseLine`.
- New factories `createBindMountSandboxProvider` and `createAgentProvider`, plus `BindMountCreateOptions`, `ExecOptions`, and `AgentBuildCommandInput` types.
