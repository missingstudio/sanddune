# Parallelizing Claude work

How to run multiple Claude Code sessions in parallel against this repo's issues. Two approaches today (manual), one approach later (sanddune itself, once it ships).

## Before parallelizing — check the dep graph

Most v1 issues have a `Blocked by` section. You cannot parallelize past a blocker. Before fanning out, run:

```bash
gh issue list --label ready-for-agent --state open \
  --json number,title,body \
  --jq '.[] | select(.body | test("Blocked by\\s*\\n\\s*-\\s*None"; "i")) | "#\(.number) \(.title)"'
```

That lists issues with no remaining blockers — your actually-parallelizable set. Anything else has to wait for its blocker to ship.

## Approach 1 — git worktrees + multiple Claude Code sessions (manual)

This is what sanddune will automate. Until then, do it by hand. Each parallel stream gets its own **worktree** on its own **source branch**, so two sessions can never stomp each other's commits.

### Setup

```bash
# One-time: a place to keep parallel worktrees
mkdir -p .worktrees
echo ".worktrees/" >> .gitignore
```

### Per issue

```bash
# Pick an issue
ISSUE=5

# Create a worktree on a fresh branch
git worktree add ".worktrees/issue-${ISSUE}" -b "agent/issue-${ISSUE}" main

# Drop into it and launch Claude Code
cd ".worktrees/issue-${ISSUE}"
claude
```

In Claude, prompt with the issue body:

```
Implement GitHub issue #5 in this repo.

`gh issue view 5` for the full body and acceptance criteria.
Work on the current branch (agent/issue-5). When done, push and open a PR.
```

Run as many of these as your machine can handle, each in its own terminal pane (tmux, iTerm splits, VS Code terminals, separate windows — whatever).

### When done

```bash
# From inside the worktree
gh pr create --title "..." --body "Closes #${ISSUE}"

# Once merged, clean up from the repo root
git worktree remove ".worktrees/issue-${ISSUE}"
git branch -d "agent/issue-${ISSUE}"
```

### What this gives you

- True isolation — each session has its own working tree
- No **branch strategy** mistakes — every session is on its own branch by construction
- PRs land cleanly because each branch only contains one issue's work

### What this does *not* give you

- No **sandbox** — Claude has full access to your machine in each pane
- No **iteration loop** — you supervise; if Claude stalls, you notice
- No **completion signal** — you decide when each session is done
- No prompt reuse — you re-paste the launch prompt per pane

## Approach 2 — Claude Code GitHub integration (cloud)

If you've enabled the Claude Code GitHub App, you can `@claude` on an issue and it spawns a remote run. The agent opens a PR back to the repo. No local terminals.

```
# In an issue or PR comment
@claude implement this issue. Acceptance criteria are above.
```

Tradeoffs vs. Approach 1:

- **Pro**: No local resource contention. Fan out 10+ at once if billing allows.
- **Pro**: Runs continue even if you close your laptop.
- **Con**: You give up direct control of the loop and the prompt.
- **Con**: Debugging a stuck remote agent is slower than alt-tabbing to a pane.

Use this for low-risk slices (small AFK issues, isolated bugs). Use Approach 1 for slices where you want to watch the agent's reasoning live.

## Approach 3 — sanddune (later, once #4 ships)

The reason this project exists. Once the **tracer bullet** lands (issue #4), you can use sanddune to drive the rest of its own development. Each approach below replaces a chunk of the manual flow above.

### One-shot per issue — `run()`

Replaces Approach 1's per-pane prompting. Spawn N processes, each calling `run()` with a different issue number; let them work in parallel **sandboxes**.

```typescript
import { run, claudeCode } from "@missingstudio/sanddune";
import { docker } from "@missingstudio/sanddune/sandboxes/docker";

await Promise.all(
  [5, 7, 19].map((issueNumber) =>
    run({
      agent: claudeCode("claude-opus-4-7"),
      sandbox: docker(),
      promptFile: ".sanddune/prompts/implement-issue.md",
      promptArgs: { ISSUE_NUMBER: String(issueNumber) },
      branchStrategy: { type: "branch", branch: `agent/issue-${issueNumber}` },
      maxIterations: 10,
      completionSignal: ["<promise>COMPLETE</promise>", "<promise>BLOCKED</promise>"],
    }),
  ),
);
```

Each `run()` gets its own Docker container, its own **worktree**, and its own branch. They cannot interfere.

### Multi-step pipeline per issue — `createSandbox()`

Use when an issue benefits from a multi-step flow (implement → review → revise) on the same branch in the same container. Avoids container startup cost between steps.

```typescript
await using sandbox = await createSandbox({
  branch: `agent/issue-${issueNumber}`,
  sandbox: docker(),
  hooks: { sandbox: { onSandboxReady: [{ command: "npm install", timeoutMs: 300_000 }] } },
});

await sandbox.run({ agent: claudeCode("claude-opus-4-7"), promptFile: "implement.md" });
await sandbox.run({ agent: claudeCode("claude-sonnet-4-6"), prompt: "Review and fix issues." });
```

### Drain a queue — `simple-loop` template

Scaffolded by `sanddune init`. Picks issues one at a time off the **backlog manager** (GitHub Issues here) and works them sequentially. Run two or three of these in parallel against disjoint label filters (e.g. one drains `area:prompt`, another drains `area:sandbox`) and you have a triaged work queue.

### Fan-out across one issue — `parallel-planner` template

Scaffolded by `sanddune init`. The first **agent** plans an issue into parallelizable subtasks; sanddune executes each subtask in a separate **worktree** + **sandbox**; results merge back. Useful when an issue is naturally decomposable.

## Choosing an approach

| Situation                                                              | Use            |
| ---------------------------------------------------------------------- | -------------- |
| sanddune isn't built yet (tracer bullet #4 not merged)                 | Approach 1     |
| HITL slice — you want to watch the agent's reasoning                   | Approach 1     |
| Many small AFK issues, you want them done overnight                    | Approach 2     |
| Many AFK issues, you want isolation + reproducibility                  | Approach 3 (`run()`) |
| One issue with a natural implement → review → revise flow              | Approach 3 (`createSandbox()`) |
| Ongoing triage queue you want drained continuously                     | Approach 3 (`simple-loop` template) |
| One large issue with parallel subtasks                                 | Approach 3 (`parallel-planner` template) |

## Phase-by-phase recipe for the v1 push

1. **#2 → #3 → #4** sequential, single Claude session each. Don't parallelize — these set the architectural shape every later slice inherits.
2. **After #4 lands**: switch to Approach 1, two or three worktrees in parallel. Don't try to run six streams on day one — review queue overflow is real.
3. **After #16 (`SandboxLifecycle`) lands**: dogfood. Use sanddune to drive its own remaining slices via Approach 3.
4. **After #22 (`init` extras) lands**: scaffold a `simple-loop` template against this repo's `ready-for-agent` issues and let it drain.

## Hygiene

- **Don't parallelize HITL slices** (`ready-for-human` label). They're flagged HITL because they need maintainer judgment.
- **One issue per branch.** Never let two parallel sessions touch the same branch — one will lose work.
- **Clean up worktrees.** `git worktree list` shows what's outstanding. Stale worktrees confuse future sessions.
- **Watch the PR queue.** Parallelism only helps if you can review the resulting PRs. If review is the bottleneck, throttle the agent fan-out, not the other way around.
