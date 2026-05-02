---
"@missingstudio/sanddune": patch
"@missingstudio/sanddune-core": patch
---

Fix the Docker provider's default image lookup under non-`head` branch strategies. The default tag is now derived from the **host** repo's directory name rather than from `worktreePath`, which under `merge-to-head` is a timestamped subdirectory like `.sanddune/worktrees/<id>/` and produced an image name that didn't exist (`sanddune:<id>` instead of `sanddune:<repo-dir>`).

Public-type addition: `BindMountCreateOptions` now carries `hostRepoPath: string` alongside `worktreePath`. `run()` populates it with the resolved host repo path and the Docker provider uses it for default-image derivation. Custom **bind-mount sandbox providers** that implement their own `create` will see the new field on the input but are not required to consume it.

A new exported helper, `defaultImageName(hostRepoPath)`, encapsulates the tag derivation: it takes the trailing path segment, lowercases it, and replaces characters outside `[a-z0-9_.-]` with `-`. Falls back to `sanddune:local` when the path has no usable basename.
