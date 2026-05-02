# Dogfooding sanddune in this repo

This directory holds the sandbox image and a runnable example for invoking `run()` against this repo. Steps below assume Docker Desktop is running.

## 1. Build the workspace packages

`@missingstudio/sanddune` resolves to `packages/sanddune/dist/`, so build once before running:

```bash
bun install
bun run build
```

## 2. Build the sandbox image

The default image name is `sanddune:<repo-dir-name>` — for this repo that's `sanddune:sanddune`. From the repo root:

```bash
docker build -t sanddune:sanddune -f .sanddune/Dockerfile .sanddune
```

Verify:

```bash
docker image inspect sanddune:sanddune >/dev/null && echo ok
```

## 3. Set your API key

```bash
cp .sanddune/.env.example .sanddune/.env
set -a && source .sanddune/.env && set +a
```

`.sanddune/.env` is gitignored.

## 4. Run sanddune

There are two runnable demos, one per shipped **branch strategy**. Demo files
follow `<sandbox>-<strategy>-<agent>.ts` so a glance at the filename tells you
which combination it exercises.

### Head (default)

```bash
bun .sanddune/docker-head-claude-code.ts
```

The script:

- spins up a container from `sanddune:sanddune` with the repo bind-mounted at `/workspace`
- streams the run log to `.sanddune/logs/<run-id>.jsonl` and prints a `tail -f` hint
- runs Claude Code for one iteration writing directly to your working tree (**head** branch strategy)
- tears the container down on exit
- prints the resulting branches, iteration count, and commit SHAs

### Merge-to-head

```bash
bun .sanddune/docker-merge-to-head-claude-code.ts
```

The script:

- creates a git **worktree** under `.sanddune/worktrees/<id>/` and a lock under `.sanddune/locks/<id>.lock`
- bind-mounts that worktree (not the host repo) into the container, so the host working tree stays untouched mid-run — try `git status` from another terminal during the run to see this
- runs Claude Code for one iteration on a temporary `sanddune/merge-to-head/<id>` source branch
- fast-forwards the source branch back to the host's active branch on success, so the agent's commits land in your host HEAD
- removes the worktree and deletes the temp branch on a clean close; preserves both on disk if the agent left uncommitted work and surfaces the path on `RunResult.worktreePath`
- prints `host HEAD before` / `host HEAD after` so you can see the merge happened

In another terminal you can follow the JSONL stream:

```bash
tail -f .sanddune/logs/*.jsonl
```

## 5. Inspect the result

```bash
git log -1
ls HELLO.md                  # after docker-head-claude-code.ts
ls MERGE-TO-HEAD-HELLO.md    # after docker-merge-to-head-claude-code.ts
```

If you want to roll either change back:

```bash
git reset --hard HEAD~1
rm -f HELLO.md MERGE-TO-HEAD-HELLO.md
```

## Custom image name

Pass `image:` to `docker()` to use a different tag:

```ts
sandbox: docker({ image: "sanddune:dev" })
```

## Troubleshooting

- **`Docker image "sanddune:sanddune" not found.`** — re-run step 1.
- **`fatal: detected dubious ownership in repository at '/workspace'`** — the Dockerfile already adds `/workspace` to `safe.directory`. If you customized the image, add `RUN git config --global --add safe.directory /workspace`.
- **Linux host: file ownership** — files written from the container land as `root:root` on Linux bind mounts. macOS Docker Desktop translates UIDs automatically. On Linux, build the image with `--build-arg UID=$(id -u) --build-arg GID=$(id -g)` and add a matching `USER` step (not included by default since this repo is developed on macOS).
