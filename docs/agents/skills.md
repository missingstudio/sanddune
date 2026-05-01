# Agent skills: when to run what

How the project's installed skills compose around an issue. Read this once; reach for the table when you're not sure which skill earns its keep at a given step.

## Per-issue flow

The default loop, from filed issue to merged PR:

```
[issue lands in tracker]
        │
        ▼
   /triage              ── evaluate; mark needs-info / ready-for-agent /
        │                  ready-for-human / wontfix. See triage-labels.md.
        ▼
[issue is ready, you grab it]
        │
        ▼
   /grill-with-docs     ── (optional) if the spec uses fuzzy or new
        │                  vocabulary; sharpens CONTEXT.md / ADRs inline
        ▼
   implementation       ── /tdd for strict red-green-refactor
        │                  /diagnose for hard bugs or perf regressions
        │                  /claude-api when touching @anthropic-ai/sdk code
        ▼
   /simplify            ── self-review the diff for reuse + quality
        │                  before exposing it to a fresh reader
        ▼
   /requesting-code-review
        │                  dispatch a code-reviewer subagent against the
        │                  working tree or branch; fix Critical + Important
        ▼
   /security-review     ── (optional) if the slice touches subprocess
        │                  invocation, env-var passthrough, prompt-template
        │                  loading, hook execution, or file copy in/out
        ▼
   commit + open PR     ── reference the issue ("Closes #N")
        │
        ▼
   /review              ── used by the reviewer (or you, on a peer's PR)
                          on the open PR
```

Most slices touch every step except `/grill-with-docs` and `/security-review` — those have specific triggers below.

## Cadence

| Skill                              | Cadence                              | Trigger                                                                                              |
| ---------------------------------- | ------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| `/triage`                          | Per issue (entry)                    | Issue is `needs-triage` or stale `needs-info`; or you're picking it up and it's not in a ready state |
| `/grill-with-docs`                 | Per issue (rare)                     | Spec uses new vocabulary; you'd have to invent terms not in CONTEXT.md                               |
| `/tdd`                             | Per issue (rare)                     | You want strict red-green-refactor for this slice                                                    |
| `/diagnose`                        | Per bug                              | Repro is unclear, perf regression, "it broke and I don't know why"                                   |
| `/claude-api`                      | Per slice (when applicable)          | Code imports `@anthropic-ai/sdk` or you're tuning caching / thinking / tool use                      |
| `/simplify`                        | Per slice (default)                  | After implementation, before review                                                                  |
| `/requesting-code-review`          | Per slice (default)                  | After `/simplify`, before commit                                                                     |
| `/security-review`                 | Per slice (when applicable)          | Slice touches subprocess, env vars, untrusted input, hooks, file copy                                |
| `/review`                          | Per PR                               | When reviewing a PR (yours after CI, or someone else's)                                              |
| `/improve-codebase-architecture`   | Periodic — not per issue             | After several merged slices in an area; when friction is felt; before a major refactor              |
| `/to-prd`                          | Per initiative                       | Conversation produced an idea worth a PRD                                                            |
| `/to-issues`                       | Per initiative (after PRD)           | PRD is ready and needs to become individually-grabbable issues                                       |
| `/loop`                            | Per chore                            | Polling status, recurring task that doesn't yet warrant `/schedule`                                  |
| `/schedule`                        | Per follow-up                        | Feature flag / staged rollout / "remove once X" TODO that should be revisited on a date              |
| `/init`                            | Once per repo                        | Bootstrapping CLAUDE.md                                                                              |

## Default loop for sanddune

If you remember nothing else, run these five steps for every slice:

1. `/triage` (entry)
2. implementation
3. `/simplify`
4. `/requesting-code-review`
5. commit + open PR

`/simplify` is cheap and catches issues before the reviewer does, which makes review feedback sharper. Skipping it is a false economy.

## When to reach for `/improve-codebase-architecture`

Not after every issue. The signal is **friction**: duplicated option types, dispatch logic spreading across modules, a shallow module that keeps growing, tests that have to mock four things to verify one thing.

Run it:

- After **several** merged slices in an area, when you can compare against the original architecture
- **Before** starting a new initiative in an existing area
- **After** a refactor lands, to see if the refactor opened up further deepening

Don't run it on a green codebase or on a single freshly-merged slice — there's no friction yet.

## Composing skills

Real flows from this repo:

- **Issue #3 (types + stubs)** — `/triage` → implement → `/requesting-code-review` → fix Important items → `/improve-codebase-architecture` (surfaced future opportunities, none folded into this PR) → commit + PR.
- **A new initiative (hypothetical)** — conversation → `/to-prd` → publish PRD → `/to-issues` → individual issues enter the per-issue loop above.
- **A flag-gated slice (hypothetical)** — issue loop → commit + PR → after merge: `/schedule` for a one-time agent in 2 weeks to open a cleanup PR.
- **A bug report (hypothetical)** — `/triage` (likely → `needs-info` or `ready-for-agent`) → `/diagnose` to nail repro → fix → `/simplify` → `/requesting-code-review` → commit + PR.

## Skills not yet relevant for sanddune

- `/init` — already done; CLAUDE.md exists.
- `/loop`, `/schedule` — no recurring chores or staged rollouts yet.
- `/security-review` — implementations are still stubs; reach for this once real subprocess / env / prompt-template work lands.
- `/claude-api` — sanddune wraps **agent providers**, not the Anthropic SDK directly; this triggers in agent-provider slices that import `@anthropic-ai/sdk`.

When those triggers fire, fold the skill into the loop above.
