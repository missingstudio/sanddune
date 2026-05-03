---
"@missingstudio/sanddune": patch
---

Removed the `createBindMountSandboxProvider` and `createAgentProvider` factories. They were pass-throughs that only set the `kind` literal — provider authors now construct objects against the exported `BindMountSandboxProvider` / `AgentProvider` types directly. The discriminated `kind` union still type-checks, so typo safety is preserved without the extra layer.

Migration:

```ts
// Before
docker = () => createBindMountSandboxProvider({
  name: "docker",
  create: async (opts) => ({ ... }),
});

// After
docker = (): BindMountSandboxProvider => ({
  kind: "bind-mount",
  name: "docker",
  create: async (opts) => ({ ... }),
});
```

```ts
// Before
const agent = createAgentProvider({ name, buildCommand, parseLine });

// After
const agent: AgentProvider = { name, buildCommand, parseLine };
```
