---
"@missingstudio/sanddune": patch
---

Invert the env model: a key reaches the **sandbox** iff it has been declared. See ADR-0012.

`process.env` is no longer a broad funnel — it's a value source consulted only for keys declared at one of the four declaration sites: `.sanddune/.env` (read by sanddune at launch), **agent provider** `env`, **sandbox provider** `env`, and `RunOptions.env`. Host shell variables (`HOME`, `PATH`, `PWD`, `TERM_PROGRAM`, `XPC_*`, etc.) no longer leak into the sandbox by default — they are simply absent unless declared.

For each declared key, the value resolves in precedence order: `RunOptions.env > agentEnv > sandboxEnv > .sanddune/.env > process.env`. A declared key with no value in any layer is dropped from the resolved env (rather than surfaced as the empty string). The disjointness rule between agent and sandbox provider env (overlap throws) is unchanged. `RunOptions.env` is now actually wired through `run()` (the type was declared earlier but unwired).

`.sanddune/.env` is now read by sanddune at launch — the README's manual `set -a && source .sanddune/.env` step is no longer required and has been removed. The file format supports `KEY=value`, `#` comments, surrounding-quote stripping, and blank lines. A `KEY=` line declares the key without supplying a value, falling through to `process.env` for the value (useful for CI patterns).

Migration: any env var the agent or sandbox setup needs must now be declared somewhere — either in `.sanddune/.env`, in the agent provider's typed `env` field (e.g. `claudeCode()` already declares `ANTHROPIC_API_KEY`), in the sandbox provider's `env` field, or in `RunOptions.env`. Existing users whose flows relied on shell-exported variables should add those keys to `.sanddune/.env` (with `KEY=` for "use my shell value" or `KEY=value` for a literal). Pre-1.0; ships as `patch`.

The `HOST_ONLY_ENV_KEYS` blocklist that shipped earlier is deleted — under the inversion, host-shell pollution stops being a class of bug, so the platform-specific blocklist is no longer needed.
