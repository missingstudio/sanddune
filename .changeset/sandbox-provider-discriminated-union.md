---
"@missingstudio/sanddune": patch
---

`SandboxProvider` is now a discriminated union of `BindMountSandboxProvider | IsolatedSandboxProvider | NoSandboxProvider` rather than a generic base interface. Each variant inlines its `kind` / `name` / `env` fields plus its specific contract (`create()` lives on the bind-mount arm). Reading `SandboxProvider` now describes every shape a provider can have, not a metadata base that omits the contract.

The variant interfaces (`BindMountSandboxProvider`, `IsolatedSandboxProvider`, `NoSandboxProvider`) stay exported — adapter authors who want to name the specific shape they return still can. The sub-unions used as type-level access guards (`RunSandboxProvider`, `CreateSandboxProvider`, `InteractiveSandboxProvider`) are unchanged. The `SandboxProvider<K>` generic syntax is gone — use `Extract<SandboxProvider, { kind: K }>` if you need a kind-narrowed view.

No runtime behaviour changes. README option tables now reference `SandboxProvider` (the umbrella) instead of the variant subtypes.
