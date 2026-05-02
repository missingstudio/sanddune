---
"@missingstudio/sanddune": patch
"@missingstudio/sanddune-core": patch
---

Fix the Docker provider's default image lookup under non-`head` branch strategies. The default tag is now derived from the **host** repo's directory name rather than from `worktreePath`, which under `merge-to-head` is a timestamped subdirectory like `.sanddune/worktrees/<id>/` and produced an image name that didn't exist (`sanddune:<id>` instead of `sanddune:<repo-dir>`).

Public-type addition: `BindMountCreateOptions` now carries `hostRepoPath: string` alongside `worktreePath`. `run()` populates it with the resolved host repo path and the Docker provider uses it for default-image derivation. Custom **bind-mount sandbox providers** that implement their own `create` will see the new field on the input but are not required to consume it.

A new exported helper, `defaultImageName(hostRepoPath)`, encapsulates the tag derivation: it takes the trailing path segment, lowercases it, and replaces characters outside `[a-z0-9_.-]` with `-`. Falls back to `sanddune:local` when the path has no usable basename.

The Docker provider now also bind-mounts the parent `.git` directory at its host path inside the container when the worktree is itself a git worktree (i.e. its `.git` is a pointer file rather than a directory). Without this, the worktree's `.git` pointer references a path that doesn't exist inside the container and `git status` / `git commit` fail with "not a git repository". Per ADR-0006, which previously scoped this to Windows hosts; the same fix is now cross-platform. A new exported helper `resolveParentGitMount(worktreePath)` parses the pointer, walks up to the parent `.git`, and returns the mount entry — or `null` for regular checkouts (no extra mount needed).

Separately, `resolveEnv` now strips host-only shell environment variables (`HOME`, `USER`, `LOGNAME`, `SHELL`, `PATH`, `PWD`, `OLDPWD`, `TMPDIR`, `SHLVL`, `_`, `TERM_PROGRAM`, `COLORTERM`, terminal-emulator-specific keys) from the env that flows into the sandbox. Previously, `HOME=/Users/...` from the host shadowed the container's `~/.gitconfig`, breaking `git commit` because `user.email` / `user.name` couldn't be found. Provider env (`agentEnv`, `sandboxEnv`) bypasses the filter — callers explicitly opt into those keys.
