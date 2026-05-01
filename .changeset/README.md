# Changesets

This directory holds [changesets](https://github.com/changesets/changesets) — one Markdown file per pending version bump. The repo is pre-1.0, so all changesets are `patch`.

## Adding a changeset

```bash
bun run changeset
```

Pick the affected packages, choose `patch`, and write a one-sentence summary aimed at consumers.

## Releasing

`bun run version-packages` consumes the pending changesets, bumps versions, and updates `CHANGELOG.md`. `bun run release` builds and publishes via `changeset publish`.
