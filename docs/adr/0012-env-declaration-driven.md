# Env reaches the sandbox by declaration, not by passthrough

## Context

Until now, sanddune's env model was a **broad funnel**: `process.env` was passed verbatim into the **sandbox**, with a small set of overrides on top from `.sanddune/.env`, **agent provider** and **sandbox provider** `env` fields, and `RunOptions.env`. Everything in the host shell propagated unless explicitly blocked.

When merge-to-head landed and we exercised it against real Docker, the broad-funnel model surfaced two problems and obscured a third:

1. **Host-shell variables shadowed sandbox state.** `HOME=/Users/missingstudio` from the host shell overrode the container's `HOME=/home/node`, hiding the Dockerfile's global `~/.gitconfig`. `git commit` failed with "Author identity unknown." The same class of failure applies to `PATH` (host-only paths inside the container), `PWD`, `OLDPWD`, `SHLVL`, `_`, `TERM_PROGRAM`, terminal-emulator ids, and (on macOS) `__CFBundleIdentifier`, `XPC_*`, `COMMAND_MODE`. We patched this with a `HOST_ONLY_ENV_KEYS` blocklist that strips a hand-curated set of host-shell keys.

2. **The blocklist is platform- and shell-specific knowledge baked into core sanddune.** It's correct on macOS + zsh today, will need keys added for Linux + bash, more for fish, more for Windows containers, more again for shells we haven't met. Maintaining "what's bad" forever is an open-ended commitment.

3. **The `.sanddune/.env` file from CONTEXT.md was effectively unused.** It was documented as layer 2 of a 4-layer precedence stack, but `resolveEnv` never read it. Users sourced it manually from their shell (`set -a && source .sanddune/.env`), at which point its contents joined `process.env` and entered the sandbox via the broad funnel — same as any other shell variable. The file had no runtime role; it was a habit, not a contract.

A separate motivating force is the **no-sandbox provider** (#18, in flight). Under the broad-funnel model the blocklist is *wrong* for no-sandbox: the agent runs directly on the host, so `HOME=/Users/me` is exactly the value that should reach it. Special-casing the blocklist per provider type is more knobs in the wrong place.

## Decision

Invert the env model. **A key reaches the sandbox iff it has been declared.** The four CONTEXT.md layers stay, but each layer's role shifts from "value override" to "declaration site + value source":

- **Layer 1 — `process.env`**: value source only. Never declares. A host shell variable that nobody declared is invisible to the sandbox.
- **Layer 2 — `.sanddune/.env`**: declaration site and value source. Keys present in this file (whether assigned or empty) are declared. Sanddune now reads this file at launch — no more manual `source`.
- **Layer 3 — Provider env**: declaration site and value source. The typed `env` field on **agent providers** and **sandbox providers** declares required keys at compile time; values may be set there or filled from later layers. The disjointness rule (`agent.env ∩ sandbox.env = ∅`) carries over unchanged.
- **Layer 4 — `RunOptions.env`**: declaration site, value source, and override. Highest precedence; allowed to overlap with provider env.

For each declared key, the value resolves in precedence order: `RunOptions.env > agentEnv > sandboxEnv > .sanddune/.env > process.env`. A declared key with no value in any layer is dropped from the resolved env (rather than surfaced as the empty string).

The `HOST_ONLY_ENV_KEYS` blocklist is **deleted**. It is no longer needed: host-shell keys aren't declared, so they don't propagate.

## Considered Options

1. **Status quo: broad funnel + blocklist** (rejected). Patches the symptom but commits to an open-ended catalogue of host-shell keys to ban, per platform and per shell. Doesn't address the no-sandbox provider's inverse needs.

2. **Per-provider env policy**: each **sandbox provider** declares its own filter (bind-mount strips host vars; no-sandbox keeps them). Rejected — moves a global blocklist into N provider-specific blocklists, multiplying the maintenance burden. Also leaks platform knowledge into the public provider interface.

3. **Allowlist instead of blocklist** in the broad-funnel model: declare which keys propagate at the env-resolver level. Rejected as conceptually identical to declaration-driven but losing the property that `.sanddune/.env`, agent provider `env`, and `RunOptions.env` *are* the declaration sites — there'd be a separate, redundant allowlist to keep in sync with what callers actually want.

4. **Split the layers: `process.env` is broad-funnel; `.sanddune/.env` plus provider env plus `RunOptions.env` declarations override** (a hybrid). Rejected because it preserves the original problem (host shell vars leak through layer 1) while adding complexity.

## Consequences

- **Host-shell pollution stops being a class of bug.** No `HOME`, `PATH`, `PWD`, `TERM_PROGRAM`, `XPC_*` reach the sandbox unless declared. The blocklist deletion removes ~20 lines of macOS-specific knowledge from `env-resolver.ts`.

- **`.sanddune/.env` becomes load-bearing at runtime.** Sanddune reads it at launch via a new `parseEnvFile` helper — the simple `KEY=value` format with `#` comments, surrounding-quote stripping, and blank-line tolerance that the user sketched. The README's manual `set -a && source .sanddune/.env` workaround is no longer required and should be removed.

- **`.sanddune/.env.example` becomes the canonical declaration of "what env vars an agent in this repo needs."** It documents required keys with empty values. `sanddune init` (#21) scaffolds this file from agent-provider declarations + backlog-manager declarations.

- **`RunOptions.env` is wired** through `runProgram` to `resolveEnv`. The type already existed; this slice activates it.

- **No-sandbox provider (#18) needs no special env handling.** Under the inversion, the same `resolveEnv` that serves bind-mount and isolated providers serves no-sandbox correctly: the user declares `HOME` (or whatever) in `.sanddune/.env` if their no-sandbox flow needs it; otherwise the host's `HOME` doesn't leak in.

- **Migration friction**: existing users of `bun .sanddune/main.ts`-style scripts must add `ANTHROPIC_API_KEY=` to `.sanddune/.env` (or rely on the agent provider's typed declaration via `claudeCode()`, which already declares it). Pre-1.0; shipped as a `patch` changeset with a note in the PR.

- **Less forgiving by design.** A user whose agent secretly relies on a host shell variable will see the sandbox run without it. This is the trade-off: explicitness over leak-by-default. The fix for any such case is a one-line `KEY=` addition to `.sanddune/.env`.

- **CONTEXT.md lines 227-228 are rewritten** to describe the inversion. The phrase "passes the full env map into the **sandbox**" is replaced; the four-layer precedence list keeps its order but each entry's role description changes from "override" to "declaration site + value source."
