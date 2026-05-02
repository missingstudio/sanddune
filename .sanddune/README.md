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

```bash
bun .sanddune/main.ts
```

The script:

- spins up a container from `sanddune:sanddune` with the repo bind-mounted at `/workspace`
- streams the run log to `.sanddune/logs/<run-id>.jsonl` and prints a `tail -f` hint
- runs Claude Code for one iteration writing directly to your working tree (head branch strategy)
- tears the container down on exit
- prints the resulting branches, iteration count, and commit SHAs

In another terminal you can follow the JSONL stream:

```bash
tail -f .sanddune/logs/*.jsonl
```

## 5. Inspect the result

```bash
git log -1
ls HELLO.md
```

If you want to roll the change back:

```bash
git reset --hard HEAD~1
rm -f HELLO.md
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
